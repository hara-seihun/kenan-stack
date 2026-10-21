import { execFile, spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createBashToolDefinition, createReadToolDefinition, createWriteToolDefinition, createEditToolDefinition, detectSupportedImageMimeTypeFromFile } from '@earendil-works/pi-coding-agent';
import { randomUUID } from 'node:crypto';
import type { PersonConfig, ServerConfig } from '../config.js';
import type { FileAccess, KenanTool } from '../types.js';

/** Pi's built-in definitions are typed for its terminal renderers, which Kenan never calls. */
const owned = (definition: object, files: FileAccess): KenanTool => ({ ...(definition as KenanTool), files });

/** Ubuntu's /etc/environment PATH. */
const systemPath = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/games:/usr/local/games:/snap/bin';

/** The owner's login-shell PATH: their ~/.local/bin first, as Ubuntu's ~/.profile arranges, then the system PATH. The service's own PATH never leaks in. */
export const ownerPath = (person: PersonConfig) => `${person.home}/.local/bin:${systemPath}`;

/** The owner's lingering systemd user manager is reachable, so user units (e.g. agent-browser's daemon) can be admitted. */
export function ownerEnvironment(person: PersonConfig): NodeJS.ProcessEnv {
  const runtime = `/run/user/${person.uid}`;
  return { PATH: ownerPath(person), HOME: person.home, USER: person.unixUser, LOGNAME: person.unixUser, LANG: 'C.UTF-8', XDG_RUNTIME_DIR: runtime, DBUS_SESSION_BUS_ADDRESS: `unix:path=${runtime}/bus` };
}

/**
 * Where an owner process runs. `channelScope`: the server is root in kenan@CHANNEL.service, so each call gets its own
 * transient scope in the owner's user-UID.slice (low CPU/IO weight and one memory budget for all heavy work, see
 * deploy/host/user.slice.d), bound to the channel's service so a restart still ends it, and drops to the owner with
 * the owner's own supplementary groups (e.g. docker), never the server's. `callerCgroup`: stays in the caller's cgroup; only for tests run as the owner outside systemd.
 */
export type ProcessPlacement = { kind: 'channelScope'; channel: ServerConfig['channel'] } | { kind: 'callerCgroup' };
export const channelPlacement = (config: Pick<ServerConfig, 'channel'>): ProcessPlacement => ({ kind: 'channelScope', channel: config.channel });

/** Self-stop would kill this tool before its following start. Use the independent system manager transaction. */
export function assertIndependentRuntimeControl(placement:ProcessPlacement, executable:string,args:string[]):void {
  if(placement.kind!=='channelScope')return;
  const command=[executable,...args].join(' '),unit=`kenan@${placement.channel}`;
  const destructive=new RegExp(`\\bsystemctl\\b[^;\\n&|]*\\b(?:stop|restart|try-restart|reload-or-restart|kill)\\b[^;\\n&|]*\\b${unit}(?![\\w@-])`);
  if(destructive.test(command))throw new Error(`SELF_RUNTIME_INTERRUPTION_REQUIRES_DETACHED_TRANSACTION: inline control of ${unit}.service ends this tool before recovery. Run sudo -n /usr/local/sbin/kenan-runtime-restart ${placement.channel}; its independent system-manager unit has unconditional ExecStopPost=start. For deployment use deploy/deploy.sh ${placement.channel}.`);
}

type PlacedCommand = { executable: string; args: string[]; identity: { uid: number; gid: number } | null; scope: { unit: string; slice: string } | null };
export function placedCommand(placement: ProcessPlacement, person: PersonConfig, executable: string, args: string[], scopeUnit?: string): PlacedCommand {
  assertIndependentRuntimeControl(placement,executable,args);
  switch (placement.kind) {
    case 'callerCgroup': return { executable, args, identity: { uid: person.uid, gid: person.gid }, scope: null };
    case 'channelScope': {
      const service = `kenan@${placement.channel}.service`;
      const scope = { unit: scopeUnit ?? `agent-tool-${placement.channel}-${randomUUID()}.scope`, slice: `user-${person.uid}.slice` };
      // OOMPolicy=continue: only the process the kernel picks dies, so the shell survives to report it.
      // BindsTo without After: a restart stops the service and its tool scopes concurrently, so a process stuck in the kernel
      // (an unkillable D-state read) never holds the service stop; TimeoutStopSec bounds how long such a scope lingers.
      // --expand-environment=no (systemd ≥ 254, a host requirement checked by deploy/host-requirements.sh): systemd-run otherwise rewrites ${VAR} in the command's own arguments, even text bash would keep literal.
      return { executable: '/usr/bin/systemd-run', identity: null, scope, args: ['--scope', '--quiet', '--collect', '--expand-environment=no', `--unit=${scope.unit}`, `--slice=${scope.slice}`, `--property=BindsTo=${service}`, '--property=TimeoutStopSec=10s', '--property=CPUWeight=10', '--property=IOWeight=10', '--property=OOMPolicy=continue', '--', '/usr/bin/setpriv', `--reuid=${person.uid}`, `--regid=${person.gid}`, '--init-groups', '--', executable, ...args] };
    }
  }
}

/** OOM kills anywhere under user.slice (a person's slice can vanish with its last scope): the hierarchical counter is cheap, so the kernel log is read only when it moved. */
async function userSliceOomKills(): Promise<number | null> {
  const events = await readFile('/sys/fs/cgroup/user.slice/memory.events', 'utf8').catch(() => null);
  const match = events && /^oom_kill (\d+)$/m.exec(events);
  return match ? Number(match[1]) : null;
}
const kernelLog = (sinceSeconds: number, unit: string) => new Promise<string>((resolve, reject) =>
  execFile('/usr/bin/journalctl', ['-k', '-o', 'cat', '--no-pager', '--since', `@${sinceSeconds}`, '-g', unit.replace(/\./g, '\\.')], { timeout: 5000 }, (error, stdout) =>
    error && (error as { code?: unknown }).code !== 1 ? reject(error) : resolve(stdout)));
/** What the agent reads after an OOM kill in its own scope, so a killed job is never a silent death. */
export async function oomNotice(scope: { unit: string; slice: string }, startedSeconds: number, killsBefore: number | null): Promise<string | null> {
  const killsAfter = await userSliceOomKills();
  if (killsBefore === null || killsAfter === null || killsAfter === killsBefore) return null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const log = await kernelLog(startedSeconds - 1, scope.unit).catch((error: unknown) => `journal_unreadable: ${String(error)}`);
    const victims = [...log.matchAll(/oom-kill:constraint=(\w+).*?oom_memcg=([^,]*).*?task_memcg=[^,]*,task=([^,]*),pid=(\d+)/g)];
    if (victims.length) return `\n[kenan] The kernel OOM killer killed ${victims.map(v => `${v[3]} (pid ${v[4]})`).join(', ')} in this command: ${victims[0]![1] === 'CONSTRAINT_MEMCG' ? `the memory budget of ${victims[0]![2]} was exhausted` : 'the host ran out of memory'}. Agent tools, user services and builds share user.slice (MemoryHigh 40G, MemoryMax 44G, 4G swap); use less memory or wait for other heavy jobs to finish.\n`;
    if (log.startsWith('journal_unreadable')) return `\n[kenan] ${killsAfter - killsBefore} process(es) in ${scope.slice} were OOM-killed while this command ran; ${log}\n`;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  return null;
}

/** Every filesystem mutation and shell command executes with the owner's real identity. */
export function ownerProcess(placement: ProcessPlacement, person: PersonConfig, executable: string, args: string[], input?: string, signal?: AbortSignal, onData?: (data: Buffer) => void, timeout?: number, scopeUnit?: string): Promise<{ output: Buffer; exitCode: number; signal: NodeJS.Signals | null; termination: 'exit' | 'signal' | 'timeout' | 'cancelled' }> {
  return new Promise((resolve, reject) => {
    const placed = placedCommand(placement, person, executable, args, scopeUnit);
    const startedSeconds = Math.floor(Date.now() / 1000);
    const killsBefore = placed.scope ? userSliceOomKills() : Promise.resolve(null);
    const child = spawn(placed.executable, placed.args, { ...placed.identity, cwd: person.home, env: ownerEnvironment(person), stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    const chunks: Buffer[] = [];
    const collect = (data: Buffer) => { chunks.push(data); onData?.(data); };
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let requested: 'timeout' | 'cancelled' | undefined;
    const abort = () => { requested ??= 'cancelled'; if (child.pid) { try { process.kill(-child.pid, 'SIGTERM'); } catch {}
      killTimer = setTimeout(() => { try { process.kill(-child.pid!, 'SIGKILL'); } catch {} }, 1000);
    } };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const timer = timeout ? setTimeout(() => { requested ??= 'timeout'; abort(); }, timeout * 1000) : undefined;
    child.on('error', reject);
    child.on('close', async (code, childSignal) => {
      clearTimeout(timer); clearTimeout(killTimer); signal?.removeEventListener('abort', abort);
      const notice = placed.scope ? await oomNotice(placed.scope, startedSeconds, await killsBefore) : null;
      if (notice) collect(Buffer.from(notice));
      resolve({ output: Buffer.concat(chunks), exitCode: code ?? 130, signal: childSignal, termination: requested ?? (childSignal ? 'signal' : 'exit') });
    });
    child.stdin.on('error', () => {}); child.stdin.end(input);
  });
}
/** A failed process always says so in its text, even when it printed nothing. */
const processText = (exitCode: number, text: string) => exitCode && !text.trim() ? `Exited with code ${exitCode} and printed nothing.` : text;
export function processResult(result: { output: Buffer; exitCode: number }, text = result.output.toString()) {
  return { content: [{ type: 'text' as const, text: processText(result.exitCode, text) }], details: { exitCode: result.exitCode }, isError: result.exitCode !== 0 };
}
/** Pi's bash tool recognises a deadline or cancellation only as these errors; without them a killed command read as a bare "exit 130" (acme-host 2026-10-20 00:29–00:45Z: 10 s timeouts on a thrashing host looked like a broken tool). */
export function bashOutcome(result: { exitCode: number; termination: 'exit' | 'signal' | 'timeout' | 'cancelled' }, timeout: number | undefined): { exitCode: number } {
  switch (result.termination) {
    case 'timeout': throw new Error(`timeout:${timeout}`);
    case 'cancelled': throw new Error('aborted');
    case 'exit': case 'signal': return { exitCode: result.exitCode };
  }
}
export function ownerTools(placement: ProcessPlacement, person: PersonConfig) {
  const node = async (code: string, args: string[], input?: string) => {
    const result = await ownerProcess(placement, person, process.execPath, ['--input-type=module', '-e', code, ...args], input);
    if (result.exitCode) throw new Error(processText(result.exitCode, result.output.toString()));
    return result.output;
  };
  const readFile = (path: string) => node('import fs from "node:fs/promises"; process.stdout.write(await fs.readFile(process.argv[1]));', [path]);
  const access = async (path: string) => { await node('import fs from "node:fs/promises"; await fs.access(process.argv[1]);', [path]); };
  const writeFile = async (path: string, content: string) => { await node('import fs from "node:fs/promises"; let data=""; for await (const c of process.stdin) data+=c; await fs.writeFile(process.argv[1],data);', [path], content); };
  return [
    owned(createBashToolDefinition(person.home, { exposeSessionEnvironment: false, operations: { exec: async (command, _cwd, options) => bashOutcome(await ownerProcess(placement, person, '/bin/bash', ['-c', command], undefined, options.signal, options.onData, options.timeout), options.timeout) } }), 'writes'),
    // Read checks the owner's access before sniffing, so the service only inspects image headers of files the owner can read.
    owned(createReadToolDefinition(person.home, { operations: { readFile, access, detectImageMimeType: detectSupportedImageMimeTypeFromFile } }), 'reads'),
    owned(createWriteToolDefinition(person.home, { operations: { writeFile, mkdir: async path => { await node('import fs from "node:fs/promises"; await fs.mkdir(process.argv[1],{recursive:true});', [path]); } } }), 'writes'),
    owned(createEditToolDefinition(person.home, { operations: { readFile, writeFile, access } }), 'writes'),
  ];
}
