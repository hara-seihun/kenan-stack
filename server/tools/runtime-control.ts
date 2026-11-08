import { hostname, networkInterfaces } from 'node:os';
import { tokenize, heredocSubstitutions, type Word } from './bash-syntax.js';

const shells = new Set(['bash', 'sh', 'dash', 'zsh']);
const wrappers: Record<string, Set<string>> = {
  sudo: new Set(['-u', '-g', '-C', '-h', '-p', '-U']), env: new Set(['-u', '-C']),
  command: new Set(), exec: new Set(['-a']), nohup: new Set(), setsid: new Set(),
  nice: new Set(['-n']), timeout: new Set(['-s', '-k', '--signal', '--kill-after']),
  'systemd-run': new Set(['-u', '-p', '-E', '--unit', '--property', '--slice', '--description']),
};
const sshArgumentOptions = new Set('BbcDEeFIiJLlmOoPpQRSWw'.split(''));
const localHosts = new Set(['localhost', 'localhost.localdomain', hostname().toLowerCase(), hostname().split('.')[0]!.toLowerCase(),
  ...Object.values(networkInterfaces()).flatMap(addresses => (addresses ?? []).map(address => address.address.toLowerCase()))]);

/** A literal other host is remote. Unknown shell expansions remain subject to the local check. */
function otherHost(destination: string): boolean {
  let host = destination.replace(/^ssh:\/\//, '').replace(/^.*@/, '').toLowerCase();
  if (host.startsWith('[')) host = host.slice(1, host.indexOf(']'));
  else host = host.replace(/:\d+\/?$/, '');
  host = host.replace(/\.$/, '');
  return host !== '' && !/[$`%]/.test(host) && !localHosts.has(host) && !/^127\./.test(host) && host !== '::1';
}

/** Look at commands where they execute, not an SSH argument as if it were a local shell script. */
export function controlsLocalRuntime(executable: string, args: string[], unit: string): boolean {
  const destructive = new RegExp(`\\bsystemctl\\b[^;\\n&|]*\\b(?:stop|restart|try-restart|reload-or-restart|kill)\\b[^;\\n&|]*\\b${unit}(?![\\w@-])`);
  const literal = (value: string): Word => ({ value, subs: [], assignment: false });
  const resolve = (word: Word, bindings: Map<string, string>): Word[] => {
    const ref = word.reference;
    const value = ref && bindings.get(ref.name);
    // Expansion results are fields, not shell syntax: quotes and operators inside them are ordinary characters.
    if (value === undefined || !ref || (ref.split && /[*?[]/.test(value))) return [word];
    return (ref.split ? value.split(/[ \t\n]+/).filter(Boolean) : [value]).map(literal);
  };
  const script = (text: string, depth: number, inherited = new Map<string, string>()): boolean => {
    if (depth > 16) return destructive.test(text);
    const tokens = tokenize(text);
    // Only carry definite assignments through straight-line shell statements with the default field separator.
    const linear = tokens.every(token => token.kind === 'op' ? token.op === ';' : token.kind !== 'word' ||
      !/^(?:(?:if|then|else|elif|fi|while|until|for|select|do|done|case|esac|function|\{|\})$|IFS=)/.test(token.word.value));
    const bindings = linear ? new Map(inherited) : new Map<string, string>();
    let words: Word[] = [], docs: string[] = [], redirect = false, hasRedirect = false, assigning = linear;
    const flush = (): boolean => {
      const result = command(words, docs, depth + 1, bindings);
      if (assigning && !hasRedirect && words.length > 0 && words.every(word => word.assignment)) {
        for (const word of words) {
          const at = word.value.indexOf('='); const name = word.value.slice(0, at);
          if (word.literal && !word.subs.length && !word.value.slice(at + 1).startsWith('~')) bindings.set(name, word.value.slice(at + 1));
          else bindings.delete(name);
        }
      } else if (words.length > 0 || hasRedirect) {
        // Later assignments might fail after a builtin made a variable readonly, or a redirection failed.
        bindings.clear(); assigning = false;
      }
      words = []; docs = []; redirect = false; hasRedirect = false;
      return result;
    };
    for (const token of tokens) {
      if (token.kind === 'op') { if (flush()) return true; continue; }
      if (token.kind === 'redir') {
        hasRedirect = true;
        if (token.heredoc !== null) {
          if (token.expands && heredocSubstitutions(token.heredoc).some(sub => script(sub, depth + 1, bindings))) return true;
          docs.push(token.heredoc);
        } else redirect = true;
        continue;
      }
      if (redirect) {
        redirect = false;
        if (token.word.subs.some(sub => script(sub, depth + 1, bindings))) return true;
      } else words.push(token.word);
    }
    return flush();
  };
  const command = (input: Word[], docs: string[], depth: number, bindings = new Map<string, string>()): boolean => {
    // Expansions of SSH arguments run on this host, even when the argument itself is remote.
    if (input.some(word => word.subs.some(sub => script(sub, depth + 1, bindings)))) return true;
    const words = input.flatMap(word => resolve(word, bindings));
    while (words[0]?.assignment || ['if', 'then', 'else', 'elif', 'while', 'until', 'do', '!', '{', '}'].includes(words[0]?.value ?? '')) words.shift();
    const name = words[0]?.value.replace(/^.*\//, '');
    if (name === undefined) return false;
    const rest = words.slice(1);
    if (shells.has(name)) {
      const flag = rest.findIndex(word => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(word.value));
      return flag >= 0 ? script(rest[flag + 1]?.value ?? '', depth + 1) : docs.some(doc => script(doc, depth + 1));
    }
    if (name === 'ssh') {
      let at = 0;
      while (rest[at]?.value.startsWith('-')) {
        const option = rest[at++]!.value;
        if (option === '--') break;
        // SSH can explicitly execute these two options on the client host.
        const value = option === '-o' ? rest[at]?.value : option.startsWith('-o') ? option.slice(2) : undefined;
        if (value && /^(?:LocalCommand|ProxyCommand)[=\s]/i.test(value) && script(value.replace(/^[^=\s]+[=\s]+/, ''), depth + 1)) return true;
        if (option.length === 2 && sshArgumentOptions.has(option[1]!)) at++;
      }
      const destination = rest[at++]?.value;
      if (destination && otherHost(destination)) return false;
      const remote = rest.slice(at).map(word => word.value).join(' ');
      return remote ? script(remote, depth + 1) : docs.some(doc => script(doc, depth + 1));
    }
    const wrapper = wrappers[name];
    if (wrapper) {
      let at = 0;
      while (rest[at]?.value.startsWith('-') || (name === 'env' && rest[at]?.assignment)) {
        const option = rest[at++]!.value;
        if (option === '--') break;
        if (wrapper.has(option)) at++;
      }
      if (name === 'timeout') at++; // Its duration is not a command.
      return command(rest.slice(at), docs, depth + 1, bindings);
    }
    if (name === 'systemctl') {
      const remote = rest.findIndex(word => word.value === '-H' || word.value === '--host');
      const destination = remote >= 0 ? rest[remote + 1]?.value : rest.find(word => /^(-H.|--host=)/.test(word.value))?.value.replace(/^(?:-H|--host=)/, '');
      if (destination && otherHost(destination)) return false;
    }
    return destructive.test(words.map(word => word.value).join(' '));
  };
  return command([executable, ...args].map(literal), [], 0);
}
