/**
 * How long a shell command could spend sleeping in the foreground, read from its text before it runs (Alice, 2026-11-01:
 * no foreground tool call waits more than about 10 s; a quarter of all agent tool time was `sleep 240; check` inside the
 * bash tool, while messages to the agent waited). Plain `sleep N` adds up; a loop multiplies the sleeps inside it by its
 * rounds (a `while`/`until` loop, or a `for` loop whose rounds can't be counted, runs until its bound); `timeout N` bounds
 * what it wraps and the call's own timeout bounds everything. Background work (`&`, `kenan-bg`) doesn't count. Shell
 * scripts nested in `bash -c`, `ssh`, `cpu-slot -- …`, command substitutions and heredocs fed to a shell are read too.
 * It never throws: text it can't make sense of counts only the sleeps it can see.
 */
import { accessSync, constants, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { tokenize, type Word } from './bash-syntax.js';

export const BASH_SLEEP_MAX_SECONDS = 10;

export type ForegroundSleep = { seconds: number; evidence: string[] };
export type ShellLocation = { home: string; cwd: string; path: string };

/** Resolve paths without running shell text. Only the system watch program is an unbounded poll. */
function expandPath(word: string, vars: Map<string, string>): string {
  return word.replace(/^~(?=\/|$)/, vars.get('HOME') ?? '~')
    .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
      (whole, braced: string | undefined, plain: string | undefined) => vars.get((braced ?? plain)!) ?? whole);
}
function systemWatch(word: string, vars: Map<string, string>): boolean {
  const expanded = expandPath(word, vars);
  const cwd = vars.get('PWD')!;
  const paths = expanded.includes('/') ? [resolve(cwd, expanded)]
    : (vars.get('PATH') ?? '').split(':').map(dir => resolve(cwd, dir, expanded));
  for (const path of paths) {
    try {
      accessSync(path, constants.X_OK);
      return realpathSync(path) === '/usr/bin/watch';
    } catch { /* Shell PATH lookup continues past missing or non-executable files. */ }
  }
  return false;
}


const UNIT: Record<string, number> = { '': 1, s: 1, m: 60, h: 3600, d: 86400 };

/** Seconds of one `sleep`/`timeout` duration, or null when it isn't a literal. */
function duration(text: string, vars: Map<string, string>): number | null {
  const resolved = text.replace(/^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/, (whole, name: string) => vars.get(name) ?? whole);
  if (resolved === 'infinity') return Infinity;
  const plain = /^(\d+(?:\.\d*)?|\.\d+)([smhd]?)$/.exec(resolved);
  if (plain) return Number(plain[1]) * UNIT[plain[2]!]!;
  const arithmetic = /^\$\(\(([\d\s+*/().-]+)\)\)$/.exec(resolved);
  if (arithmetic) {
    const value = arithmeticValue(arithmetic[1]!);
    if (value !== null) return value;
  }
  return null;
}

/** + - * / and parentheses over integers, as `$(( ))` reads them; null for anything else. */
function arithmeticValue(text: string): number | null {
  const tokens = text.match(/\d+|[-+*/()]/g) ?? [];
  let at = 0;
  const primary = (): number | null => {
    const token = tokens[at++];
    if (token === '(') { const value = sum(); return tokens[at++] === ')' ? value : null; }
    if (token === '-') { const value = primary(); return value === null ? null : -value; }
    return token !== undefined && /^\d+$/.test(token) ? Number(token) : null;
  };
  const product = (): number | null => {
    let value = primary();
    while (value !== null && (tokens[at] === '*' || tokens[at] === '/')) {
      const op = tokens[at++]; const right = primary();
      value = right === null || (op === '/' && right === 0) ? null : op === '*' ? value * right : Math.trunc(value / right);
    }
    return value;
  };
  const sum = (): number | null => {
    let value = product();
    while (value !== null && (tokens[at] === '+' || tokens[at] === '-')) {
      const op = tokens[at++]; const right = product();
      value = right === null ? null : op === '+' ? value + right : value - right;
    }
    return value;
  };
  const value = sum();
  return value !== null && at === tokens.length ? value : null;
}


const SHELLS = new Set(['bash', 'sh', 'dash', 'zsh']);
/** Commands that run the command after their options in the foreground; the options that take a separate argument. */
const WRAPPERS: Record<string, Set<string>> = {
  nice: new Set(['-n']), ionice: new Set(['-c', '-n', '-p']), time: new Set(), command: new Set(), exec: new Set(['-a']),
  env: new Set(['-u', '-C', '-S']), sudo: new Set(['-u', '-g', '-C', '-h', '-p', '-U']), stdbuf: new Set(), nohup: new Set(),
  setsid: new Set(), flock: new Set(['-w', '-E']), chrt: new Set(), taskset: new Set(), runuser: new Set(['-u', '-g']),
  'cpu-slot': new Set(['--cpus', '--memory', '--time', '--needs', '--gpus']), 'lean-slot': new Set(['--cpus', '--memory', '--time']),
};
const SSH_ARGUMENT_OPTIONS = new Set('BbcDEeFIiJLlmOoPpQRSWw'.split('').map(o => `-${o}`));
const TIMEOUT_ARGUMENT_OPTIONS = new Set(['-s', '-k', '--signal', '--kill-after']);
/** Commands that hand what they run to the background and return at once. */
const BACKGROUND = new Set(['kenan-bg']);

/** A list being read: what it has slept so far, and what the and-or list being read adds (a `&` sends that to the background). */
type Frame = { kind: 'root' | 'subshell' | 'loop' | 'case'; sleep: number; evidence: string[]; pending: number; pendingEvidence: string[]; rounds: number; loop: string };
const frame = (kind: Frame['kind'], loop = ''): Frame => ({ kind, sleep: 0, evidence: [], pending: 0, pendingEvidence: [], rounds: kind === 'loop' ? Infinity : 1, loop });

function analyze(text: string, bound: number, vars: Map<string, string>, depth: number): ForegroundSleep {
  if (depth > 8 || !/sleep|watch|wait/.test(text)) return { seconds: 0, evidence: [] };
  const tokens = tokenize(text);
  const root = frame('root');
  const stack: Frame[] = [root];
  const top = () => stack[stack.length - 1]!;
  let words: Word[] = []; let heredocs: string[] = [];
  let forHeader: Word[] | null = null;

  const add = (found: ForegroundSleep) => { if (found.seconds > 0) { top().pending += found.seconds; top().pendingEvidence.push(...found.evidence); } };
  const nested = (script: string) => analyze(script, Infinity, vars, depth + 1);
  const commit = () => { const list = top(); list.sleep += list.pending; list.evidence.push(...list.pendingEvidence); list.pending = 0; list.pendingEvidence = []; };
  const close = () => {
    commit();
    const list = stack.pop()!;
    if (list.sleep <= 0) return;
    const rounds = list.rounds === Infinity ? '' : ` of ${list.rounds} rounds`;
    add({ seconds: list.kind === 'loop' ? list.sleep * list.rounds : list.sleep, evidence: list.kind === 'loop' ? [`a ${list.loop} loop${rounds} around ${list.evidence.join(' and ')}`] : list.evidence });
  };

  const simple = (command: Word[], docs: string[]): ForegroundSleep => {
    let at = 0;
    const found: ForegroundSleep = { seconds: 0, evidence: [] };
    const take = (result: ForegroundSleep) => { found.seconds += result.seconds; found.evidence.push(...result.evidence); };
    for (const word of command) for (const sub of word.subs) take(nested(sub));
    while (at < command.length && command[at]!.assignment) {
      const [name, ...rest] = command[at]!.value.split('='); vars.set(name!, expandPath(rest.join('='), vars)); at++;
    }
    const nameWord = command[at];
    if (nameWord === undefined) return found;
    const name = expandPath(nameWord.value, vars).replace(/^.*\//, '');
    const args = command.slice(at + 1);
    if (name === 'export' || name === 'local' || name === 'declare' || name === 'readonly') {
      for (const arg of args) { const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(arg.value); if (match) vars.set(match[1]!, expandPath(match[2]!, vars)); }
      return found;
    }
    if (name === 'cd') {
      const target = args[0]?.value ?? vars.get('HOME')!;
      vars.set('PWD', resolve(vars.get('PWD')!, expandPath(target, vars)));
      return found;
    }
    if (BACKGROUND.has(name) || (name === 'setsid' && args.some(a => a.value === '-f' || a.value === '--fork'))) return { seconds: 0, evidence: [] };
    if (name === 'sleep') {
      let seconds = 0;
      for (const arg of args) if (!arg.value.startsWith('-')) seconds += duration(arg.value, vars) ?? 1;
      if (seconds > 0) take({ seconds, evidence: [`\`sleep ${args.map(a => a.value).join(' ')}\``] });
      return found;
    }
    if (name === 'watch' && systemWatch(nameWord.value, vars)) { take({ seconds: Infinity, evidence: ['`watch`'] }); return found; }
    if ((name === 'gpurun' || name === 'demorun') && args[0]?.value === 'wait') { take({ seconds: Infinity, evidence: [`\`${name} wait\``] }); return found; }
    if (name === 'gpurun' && args[0]?.value === 'exec') {
      const separator = args.findIndex(a => a.value === '--');
      if (separator >= 0) take(nested(args.slice(separator + 1).map(a => a.value).join(' ')));
      return found;
    }
    if (name === 'timeout') {
      let i = 0;
      while (i < args.length && args[i]!.value.startsWith('-')) { i += TIMEOUT_ARGUMENT_OPTIONS.has(args[i]!.value) ? 2 : 1; }
      const limit = args[i] === undefined ? null : duration(args[i]!.value, vars);
      const inner = simple(args.slice(i + 1), docs);
      take({ seconds: Math.min(inner.seconds, limit ?? Infinity), evidence: inner.evidence });
      return found;
    }
    if (name === 'systemd-run') {
      const waits = args.some(a => ['--wait', '--scope', '--pty', '--pipe', '-P', '-t'].includes(a.value));
      if (!waits) return found;
    }
    if (SHELLS.has(name)) {
      const flag = args.findIndex(a => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(a.value));
      if (flag >= 0 && args[flag + 1] !== undefined) take(nested(args[flag + 1]!.value));
      else for (const doc of docs) take(nested(doc));
      return found;
    }
    if (name === 'ssh') {
      let i = 0;
      while (i < args.length && args[i]!.value.startsWith('-')) i += SSH_ARGUMENT_OPTIONS.has(args[i]!.value) ? 2 : 1;
      const remote = args.slice(i + 1).map(a => a.value).join(' ');
      if (remote !== '') take(nested(remote)); else for (const doc of docs) take(nested(doc));
      return found;
    }
    const wrapper = WRAPPERS[name] ?? (name === 'systemd-run' ? new Set(['-u', '-p', '--unit', '--property', '--slice', '-E']) : undefined);
    if (wrapper !== undefined) {
      const separator = args.findIndex(a => a.value === '--');
      let i = 0;
      if (separator >= 0 && (name === 'cpu-slot' || name === 'lean-slot' || name === 'systemd-run')) i = separator + 1;
      else {
        while (i < args.length && (args[i]!.value.startsWith('-') || (name === 'env' && args[i]!.assignment))) {
          if (args[i]!.value === '--') { i++; break; }
          i += wrapper.has(args[i]!.value) ? 2 : 1;
        }
        if (name === 'flock' && i < args.length) i++; // flock's lock file
        if ((name === 'chrt' || name === 'taskset') && i < args.length) i++; // their priority or CPU mask
      }
      take(simple(args.slice(i).map(a => ({ ...a, assignment: false })), docs));
    }
    return found;
  };

  const runCommand = () => {
    const command = words; const docs = heredocs; words = []; heredocs = [];
    if (command.length > 0) add(simple(command, docs));
  };

  for (const token of tokens) {
    if (forHeader !== null) {
      if (token.kind === 'word' && token.word.value !== 'do') { forHeader.push(token.word); continue; }
      if (token.kind === 'op' && token.op === ';') continue;
      top().rounds = forRounds(forHeader, vars); forHeader = null;
      if (token.kind === 'word') continue; // `do`
    }
    if (token.kind === 'redir') { if (token.heredoc !== null) heredocs.push(token.heredoc); else words.push({ value: '', subs: [], assignment: false, redirect: true }); continue; }
    if (token.kind === 'word') {
      // a redirection's target, not an argument
      if (words[words.length - 1]?.redirect) { words.pop(); for (const sub of token.word.subs) add(nested(sub)); continue; }
      if (words.length === 0) {
        const keyword = token.word.value;
        if (keyword === 'while' || keyword === 'until') { stack.push(frame('loop', `\`${keyword}\``)); continue; }
        if (keyword === 'for' || keyword === 'select') { stack.push(frame('loop', '`for`')); forHeader = []; continue; }
        if (keyword === 'done') { if (top().kind === 'loop') close(); else commit(); continue; }
        if (keyword === 'case') { stack.push(frame('case')); words.push(token.word); continue; }
        if (keyword === 'esac') { if (top().kind === 'case') close(); else commit(); continue; }
        if (['do', 'then', 'else', 'elif', 'if', 'fi', '{', '}', '!', 'function', 'in', 'time'].includes(keyword)) continue;
      } else if (top().kind === 'case' && words[0]!.value === 'case') { words.push(token.word); continue; }
      words.push(token.word); continue;
    }
    switch (token.op) {
      case '(': runCommand(); stack.push(frame('subshell')); break;
      case ')':
        if (top().kind === 'case') { words = []; break; } // a case pattern
        runCommand(); if (top().kind === 'subshell') close(); else commit(); break;
      case '|': case '&&': case '||': runCommand(); break;
      case '&': runCommand(); top().pending = 0; top().pendingEvidence = []; break;
      default: runCommand(); commit(); break; // ; ;; and newlines
    }
  }
  runCommand();
  while (stack.length > 1) close();
  commit();
  return { seconds: Math.min(root.sleep, bound), evidence: root.evidence };
}

/** Rounds of a `for` loop from its header (`i in a b c`, `{1..30}`, `$(seq 40)`, `((i=0; i<20; i++))`), Infinity when unknown. */
function forRounds(header: Word[], vars: Map<string, string>): number {
  const first = header[0]?.value ?? '';
  const arithmetic = /^\(\(.*?=\s*(\d+)\s*;[^;]*<(=?)\s*(\d+)\s*;/.exec(first);
  if (arithmetic) return Math.max(0, Number(arithmetic[3]) - Number(arithmetic[1]) + (arithmetic[2] === '=' ? 1 : 0));
  if (header[1]?.value !== 'in') return Infinity;
  let rounds = 0;
  for (const word of header.slice(2)) {
    const range = /^\{(-?\d+)\.\.(-?\d+)(?:\.\.(\d+))?\}$/.exec(word.value);
    if (range) { rounds += Math.floor(Math.abs(Number(range[2]) - Number(range[1])) / Number(range[3] ?? 1)) + 1; continue; }
    const seq = /^(?:\$\(|`)\s*seq\s+([^)`]*)(?:\)|`)$/.exec(word.value);
    if (seq) {
      const numbers = seq[1]!.trim().split(/\s+/).map(n => duration(n, vars));
      if (numbers.some(n => n === null || !Number.isFinite(n))) return Infinity;
      const [a, b, c] = numbers as number[];
      const [from, step, to] = numbers.length === 1 ? [1, 1, a!] : numbers.length === 2 ? [a!, 1, b!] : [a!, b!, c!];
      rounds += step === 0 ? 0 : Math.max(0, Math.floor((to - from) / step) + 1);
      continue;
    }
    if (/[$`*?[]/.test(word.value)) return Infinity;
    rounds += 1;
  }
  return rounds;
}

/** The most a command could sleep in the foreground, bounded by the call's own timeout. */
export function foregroundSleep(command: string, callTimeout: number, location: ShellLocation = {
  home: process.env.HOME ?? process.cwd(), cwd: process.cwd(), path: process.env.PATH ?? '',
}): ForegroundSleep {
  return analyze(command, callTimeout, new Map([['HOME', location.home], ['PWD', location.cwd], ['PATH', location.path]]), 0);
}
