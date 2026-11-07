import { readFile, realpath, unlink, open } from 'node:fs/promises';
import { accessSync, constants, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { constants as osConstants, hostname, tmpdir, userInfo } from 'node:os';
import { createBashToolDefinition, createReadToolDefinition, createWriteToolDefinition, createEditToolDefinition, detectSupportedImageMimeTypeFromFile } from '@earendil-works/pi-coding-agent';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { Type } from 'typebox';
import type { PersonConfig, ServerConfig } from '../config.js';
import type { Access, KenanTool } from '../types.js';
import { execFileText, spawnChild, SpawnerGone } from '../spawner.js';
import { FileHelperGone, FileOperationError, ownerFiles, type OwnerFiles } from './file-helper.js';
import { foregroundProcess, foregroundRoot, foregroundLaunchEnded, FOREGROUND_RUNNER, FOREGROUND_START_SECONDS } from './foreground.js';
import { BASH_SLEEP_MAX_SECONDS, foregroundSleep, type ShellLocation } from './bash-sleep.js';
import { controlsLocalRuntime } from './runtime-control.js';
import { recoveryArgs, RECOVERY_RUNNER } from './recovery.js';
import { outputPreview } from './output-preview.js';

/** Pi's built-in definitions are typed for its terminal renderers, which Kenan never calls. */
const owned = (definition: object, files: Access): KenanTool => ({ ...(definition as KenanTool), files, records: 'none' });

/** Ubuntu's /etc/environment PATH. */
const systemPath = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/games:/usr/local/games:/snap/bin';

// One queue per canonical path for all agents in this server, including missing files under symlinked directories.
const mutationQueues = new Map<string, Promise<void>>();
let registrations = Promise.resolve();
async function canonicalPath(path: string): Promise<string> {
  const absolute = resolve(path);
  try { return await realpath(absolute); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const parent = dirname(absolute);
    if (parent === absolute) throw error;
    return join(await canonicalPath(parent), basename(absolute));
  }
}
async function serializeMutation<T>(path: string, action: () => Promise<T>): Promise<T> {
  const registration = registrations.then(async () => {
    const key = await canonicalPath(path);
    const previous = mutationQueues.get(key) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>(resolve => { release = resolve; });
    const chain = previous.then(() => next);
    mutationQueues.set(key, chain);
    return { key, previous, chain, release };
  });
  registrations = registration.then(() => {}, () => {});
  const { key, previous, chain, release } = await registration;
  await previous;
  try { return await action(); }
  finally { release(); if (mutationQueues.get(key) === chain) mutationQueues.delete(key); }
}

/** The owner's login-shell PATH: their ~/.local/bin first, as Ubuntu's ~/.profile arranges, then the system PATH. The service's own PATH never leaks in. */
export const ownerPath = (person: PersonConfig) => `${person.home}/.local/bin:${systemPath}`;

/**
 * The owner's lingering systemd user manager is reachable, so user units (e.g. agent-browser's daemon) can be admitted.
 * KENAN_AGENT names the agent whose tool started the process; every child inherits it, so the host's pkill/killall guard
 * (machine/kill-all-guard) can tell an agent's own processes from other agents' across its tool calls.
 */
const toolCall = new AsyncLocalStorage<string>();
const editBaseline = new AsyncLocalStorage<{ hash?: string }>();

export function ownerEnvironment(person: PersonConfig, agentId: string | null): NodeJS.ProcessEnv {
  const runtime = `/run/user/${person.uid}`;
  // Host browser policy must reach direct Node installers too, not just login shells.
  const browserEnv: NodeJS.ProcessEnv = {};
  for (const key of ['PLAYWRIGHT_HOST_PLATFORM_OVERRIDE', 'PLAYWRIGHT_SKIP_BROWSER_GC']) {
    if (process.env[key] !== undefined) browserEnv[key] = process.env[key];
  }
  return { ...browserEnv, PATH: ownerPath(person), HOME: person.home, USER: person.unixUser, LOGNAME: person.unixUser, LANG: 'C.UTF-8', TMPDIR: '/var/tmp', XDG_RUNTIME_DIR: runtime, DBUS_SESSION_BUS_ADDRESS: `unix:path=${runtime}/bus`, ...(agentId === null ? {} : { KENAN_AGENT: agentId }), ...(toolCall.getStore() === undefined ? {} : { KENAN_TOOL_CALL_ID: toolCall.getStore()! }) };
}

/**
 * Where an owner process runs. `channelScope`: the server is root in kenan@CHANNEL.service, so each call gets its own
 * transient scope in user-agents.slice, which every person's agent commands share (inside
 * user.slice's one memory budget; see deploy/priority/user-agents.slice.d), bound to the channel's service unless it is a persistent Bash command, and drops to the owner with
 * the owner's own supplementary groups (e.g. docker), never the server's. `callerCgroup`: stays in the caller's cgroup; only for tests run as the owner outside systemd.
 */
export type ProcessPlacement = { kind: 'channelScope'; channel: ServerConfig['channel'] } | { kind: 'callerCgroup' };
export const channelPlacement = (config: Pick<ServerConfig, 'channel'>): ProcessPlacement => ({ kind: 'channelScope', channel: config.channel });

/** Self-stop would kill this tool before its following start. Use the independent system manager transaction. */
export function assertIndependentRuntimeControl(placement:ProcessPlacement, executable:string,args:string[]):void {
  if(placement.kind!=='channelScope')return;
  const unit=`kenan@${placement.channel}`;
  if(controlsLocalRuntime(executable,args,unit))throw new Error(`SELF_RUNTIME_INTERRUPTION_REQUIRES_DETACHED_TRANSACTION: inline control of ${unit}.service ends this tool before recovery. Run sudo -n /usr/local/sbin/kenan-runtime-restart ${placement.channel}; its independent system-manager unit has unconditional ExecStopPost=start. For deployment use deploy/deploy.sh ${placement.channel}.`);
}

type PlacedCommand = { executable: string; args: string[]; identity: { uid: number; gid: number } | null; scope: { unit: string; slice: string } | null };
export function placedCommand(placement: ProcessPlacement, person: PersonConfig, executable: string, args: string[], scopeUnit?: string, identity?: { callId: string; agentId: string }, persistentSeconds?: number, recovery = false): PlacedCommand {
  assertIndependentRuntimeControl(placement,executable,args);
  switch (placement.kind) {
    case 'callerCgroup': return { executable, args, identity: { uid: person.uid, gid: person.gid }, scope: null };
    case 'channelScope': {
      const service = `kenan@${placement.channel}.service`;
      const descriptionText = identity === undefined ? undefined : `kenan-tool-call:${JSON.stringify({version:1,channel:placement.channel,...identity})}`;
      const description = descriptionText === undefined ? [] : [`--description=${descriptionText}`];
      const scope = { unit: scopeUnit ?? `agent-${recovery ? 'recovery' : 'tool'}-${placement.channel}-${randomUUID()}.scope`, slice: recovery ? 'system.slice' : 'user-agents.slice' };
      const controls: Array<[string, 's' | 't', string | number]> = [
        ['TimeoutStopUSec', 't', 10_000_000], ['CPUWeight', 't', 100], ['IOWeight', 't', 100],
        ['MemoryLow', 't', 64 * 1024 * 1024], ['OOMPolicy', 's', 'continue'],
        ...(persistentSeconds === undefined ? [] : [['RuntimeMaxUSec', 't', (persistentSeconds + FOREGROUND_START_SECONDS + 5) * 1_000_000] as [string, 't', number]]),
      ];
      const controlArgs = controls.map(([name, , value]) => `--property=${name.endsWith('USec') ? `${name.slice(0, -4)}Sec=${value}us` : `${name}=${value}`}`);
      // Foreground calls compete equally with the background-job slice, not at one tenth its weight.
      // Keep a small tool's working set resident when bulk jobs fill the shared slice.
      // MemoryLow is reclaim protection, not another allocation or a larger hard budget.
      // OOMPolicy=continue: only the process the kernel picks dies, so the shell survives to report it.
      // Non-persistent tools use BindsTo without After, so a process stuck in the kernel
      // (an unkillable D-state read) never holds the service stop; TimeoutStopSec bounds how long such a scope lingers.
      // --expand-environment=no (systemd ≥ 254, a host requirement checked by deploy/host-requirements.sh): systemd-run otherwise rewrites ${VAR} in the command's own arguments, even text bash would keep literal.
      if (executable === FOREGROUND_RUNNER && persistentSeconds !== undefined && !recovery) {
        const properties = [
          ['Slice', 's', scope.slice], ['CollectMode', 's', 'inactive-or-failed'],
          ...controls, ...(descriptionText === undefined ? [] : [['Description', 's', descriptionText]]),
        ];
        return { executable, identity: null, scope, args: ['--scope', JSON.stringify({ unit: scope.unit, uid: person.uid, gid: person.gid, properties, oomScore: hostname() === 'ResearchCo' ? 500 : null }), ...args] };
      }
      return { executable: '/usr/bin/systemd-run', identity: null, scope, args: ['--scope', '--quiet', '--collect', ...description, '--expand-environment=no', `--unit=${scope.unit}`, `--slice=${scope.slice}`, ...(persistentSeconds === undefined ? [`--property=BindsTo=${service}`] : []), ...controlArgs, ...(recovery ? ['--property=MemoryMax=128M', '--property=MemoryHigh=infinity', '--property=TasksMax=16', '--property=CPUQuota=100%', '--property=RuntimeMaxSec=15s'] : []), '--', '/usr/bin/setpriv', `--reuid=${person.uid}`, `--regid=${person.gid}`, '--init-groups', '--', ...(hostname() === 'ResearchCo' ? ['/bin/sh', '-c', 'echo 500 > /proc/self/oom_score_adj; exec "$@"', 'kenan-agent'] : []), executable, ...args] };
    }
  }
}

/** OOM kills anywhere under user.slice (a person's slice can vanish with its last scope): the hierarchical counter is cheap, so the kernel log is read only when it moved. */
async function userSliceOomKills(): Promise<number | null> {
  const events = await readFile('/sys/fs/cgroup/user.slice/memory.events', 'utf8').catch(() => null);
  const match = events && /^oom_kill (\d+)$/m.exec(events);
  return match ? Number(match[1]) : null;
}
const kernelLog = (sinceSeconds: number, unit: string) =>
  execFileText('/usr/bin/journalctl', ['-k', '-o', 'cat', '--no-pager', '--since', `@${sinceSeconds}`, '-g', unit.replace(/\./g, '\\.')], { timeout: 5000 })
    .then(({ stdout }) => stdout, (error: { code?: unknown; stdout?: string }) => { if (error.code === 1) return error.stdout ?? ''; throw error; });
/** What the agent reads after an OOM kill in its own scope, so a killed job is never a silent death. */
export async function oomNotice(scope: { unit: string; slice: string }, startedSeconds: number, killsBefore: number | null, route: HeavyRoute): Promise<string | null> {
  const killsAfter = await userSliceOomKills();
  if (killsBefore === null || killsAfter === null || killsAfter === killsBefore) return null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const log = await kernelLog(startedSeconds - 1, scope.unit).catch((error: unknown) => `journal_unreadable: ${String(error)}`);
    const victims = [...log.matchAll(/oom-kill:constraint=(\w+).*?oom_memcg=([^,]*).*?task_memcg=[^,]*,task=([^,]*),pid=(\d+)/g)];
    if (victims.length) {
      const [, constraint, memcg] = victims[0]!;
      const cause = constraint !== 'CONSTRAINT_MEMCG' ? 'the host ran out of memory'
        : memcg!.endsWith(`/${scope.unit}`) ? "this command's memory cap was reached"
        : `the memory budget of ${memcg} was exhausted`;
      return `\n[kenan] The kernel OOM killer killed ${victims.map(v => `${v[3]} (pid ${v[4]})`).join(', ')} in this command: ${cause}. ${heavyAdvice(route)}\n`;
    }
    if (log.startsWith('journal_unreadable')) return `\n[kenan] ${killsAfter - killsBefore} process(es) in ${scope.slice} were OOM-killed while this command ran; ${log}\n`;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  return null;
}

/** Whether the channel's service is stopping or restarting right now. Read from systemd, not from the server's own SIGTERM
 * handler: a service stop signals every process in its cgroup at once, so a child's death can reach us before our own SIGTERM. */
const channelStopping = (channel: ServerConfig['channel']) =>
  execFileText('/usr/bin/systemctl', ['show', '--property=ActiveState', '--value', `kenan@${channel}.service`], { timeout: 5000 })
    .then(({ stdout }) => stdout.trim() === 'deactivating', () => false);
/**
 * What the agent reads when a command died from a signal this tool didn't send: a restart of the channel (a deploy, or
 * kenan-runtime-restart) stops every running tool call with SIGTERM, and before 2026-10-31 that read as a bare
 * "Exited with code 130 and printed nothing" (worker 62c8f1a3's edit, cut by Beta's 10:12:28Z deploy restart).
 */
export async function signalNotice(placement: ProcessPlacement, signal: NodeJS.Signals): Promise<string> {
  const restarting = placement.kind === 'channelScope' && await channelStopping(placement.channel);
  const cause = restarting
    ? `Kenan ${placement.channel === 'beta' ? 'Beta' : 'production'} is restarting (a deploy or restart stops every running tool call); this turn continues once it is back`
    : 'something outside this tool call sent it (Kenan itself is still running)';
  return `\n[kenan] interrupted_by_signal: this command was killed by ${signal} before it finished: ${cause}.\n`;
}

/** Every filesystem mutation and shell command executes with the owner's real identity. */
export function ownerProcess(placement: ProcessPlacement, person: PersonConfig, executable: string, args: string[], input?: string, signal?: AbortSignal, onData?: (data: Buffer) => void, timeout?: number, scopeUnit?: string, agentId: string | null = null, recovery = false): Promise<{ output: Buffer; exitCode: number; signal: NodeJS.Signals | null; termination: 'exit' | 'signal' | 'timeout' | 'cancelled' }> {
  return new Promise((resolve, reject) => {
    const callId = toolCall.getStore();
    const placed = placedCommand(placement, person, executable, args, scopeUnit, callId === undefined || agentId === null ? undefined : {callId, agentId}, undefined, recovery);
    const deadline = timeout ? Date.now() + timeout * 1000 : undefined;
    const startedSeconds = Math.floor(Date.now() / 1000);
    const killsBefore = placed.scope ? userSliceOomKills() : Promise.resolve(null);
    const child = spawnChild(placed.executable, placed.args, { ...placed.identity, cwd: person.home, env: { ...ownerEnvironment(person, agentId), ...(deadline === undefined ? {} : { KENAN_BASH_DEADLINE_UNIX_MS: String(deadline) }) }, detached: true });
    const chunks: Buffer[] = [];
    const collect = (data: Buffer) => { chunks.push(data); onData?.(data); };
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let settleTimer: ReturnType<typeof setTimeout> | undefined;
    let requested: 'timeout' | 'cancelled' | undefined;
    let settled = false;
    const killAll = () => {
      child.killGroup('SIGKILL');
      // A descendant in its own session or process group (an ssh control master, a setsid daemon) survives the group kill and keeps the output pipes open; the scope holds all of them.
      if (placed.scope) execFileText('/usr/bin/systemctl', ['kill', '--signal=SIGKILL', placed.scope.unit]).catch(() => {});
    };
    const abort = () => { requested ??= 'cancelled'; child.killGroup('SIGTERM'); killTimer = setTimeout(killAll, 1000); };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const timer = timeout ? setTimeout(() => { requested ??= 'timeout'; abort(); }, Math.max(1, deadline! - Date.now())) : undefined;
    child.on('error', reject);
    const finish = async (code: number | null, childSignal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); clearTimeout(killTimer); clearTimeout(settleTimer); signal?.removeEventListener('abort', abort);
      if (requested) killAll();
      child.stdout.destroy(); child.stderr.destroy();
      const notice = placed.scope ? await oomNotice(placed.scope, startedSeconds, await killsBefore, heavyRoute(ownerPath(person))) : null;
      if (notice) collect(Buffer.from(notice));
      else if (childSignal && !requested) collect(Buffer.from(await signalNotice(placement, childSignal)));
      resolve({ output: Buffer.concat(chunks), exitCode: code ?? 128 + (osConstants.signals[childSignal ?? 'SIGTERM'] ?? 0), signal: childSignal, termination: requested ?? (childSignal ? 'signal' : 'exit') });
    };
    child.on('close', finish);
    // After a requested stop, a surviving descendant holding the pipes must not hold the result: 'close' waits for them, 'exit' does not.
    child.on('exit', (code, childSignal) => { if (requested) settleTimer = setTimeout(() => void finish(code, childSignal), 2000); });
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
/** Input for an agent joins its turn only before its next model call, so a foreground command holds every queued message for as long as it runs (worker 6eed7829, 2026-10-23: six messages waited 38 minutes behind 620 s commands). */
export const BASH_MAX_SECONDS = 300;
/** Acme uses its own heavy-work admission; other hosts run directly. */
export type HeavyRoute = { kind: 'acme-heavy-slot' } | { kind: 'none' };
const executableOn = (path: string, name: string) => path.split(':').some(dir => {
  try { const file = `${dir}/${name}`; accessSync(file, constants.X_OK); return statSync(file).isFile(); } catch { return false; }
});
export function heavyRoute(path: string): HeavyRoute {
  if (executableOn(path, 'acme-heavy-slot')) return { kind: 'acme-heavy-slot' };
  return { kind: 'none' };
}
function heavyBackground(route: HeavyRoute): string {
  switch (route.kind) {
    case 'acme-heavy-slot': return 'light bounded commands only; heavy work goes through `acme-heavy-slot reserve/launch` with its exact candidate, unit, CPU and memory, layered on acme-host-slot';
    case 'none': return 'run CPU work directly';
  }
}
function heavyAdvice(route: HeavyRoute): string {
  switch (route.kind) {
    case 'acme-heavy-slot': return 'Run memory-heavy work (model loads, conversions, big builds) through `acme-heavy-slot reserve/launch` with its exact memory and CPU, layered on acme-host-slot.';
    case 'none': return 'Reduce memory use and retry.';
  }
}
/** Host tools every agent may use, named in the bash tool text only when installed on PATH (deploy/install-image-gen.sh installs kenan-image). */
export function hostToolsText(path: string): string {
  return executableOn(path, 'kenan-image') ? ' Pictures (cartoons, sketches, game assets, dress-up clothes, comics) are free here: `kenan-image`; read /usr/local/share/kenan/skills/image/SKILL.md first.' : '';
}
const background = (route: HeavyRoute) => `Longer work runs in the background: \`kenan-bg NAME -- CMD\` (${heavyBackground(route)}) returns at once, logs to the printed file and raises host event \`job:<your agent id>:NAME\` with the exit code and log tail when it ends; schedule \`wake\` on that topic, or \`on: "any"\`, and end your turn (it fires no other wake; with none waiting, it reaches you anyway). Unwatched jobs stop within a minute after their worker is archived or stopped; pending job wakes and handed-off triggers keep jobs running. Use \`kenan-bg --keep NAME -- CMD\` only for work intended to outlive its owner. Basic process settings and exports added or changed by your shell (including inline \`VAR=1 kenan-bg ...\`) are inherited. To select an unchanged custom export from the tool environment, use its name: \`export PYTHONPATH=... SASS_LIB=...; kenan-bg NAME --env PYTHONPATH --env SASS_LIB -- CMD\`. Repeat \`--env VARIABLE\` for each unchanged custom export; missing or unexported names fail with \`bg_invalid_env\`. Values stay out of launch arguments and logs; do not put secrets in CMD arguments or output.`;
export type BashTimeoutError = { kind: 'bash_timeout_missing' } | { kind: 'bash_timeout_invalid'; timeout: unknown } | { kind: 'bash_timeout_over_cap'; timeout: number }
  | { kind: 'bash_sleep_over_cap'; seconds: number; evidence: string[] };
/** The call's timeout, checked; given the command, also refuses a command that could sleep or poll longer than BASH_SLEEP_MAX_SECONDS (bash-sleep.ts). */
export function bashTimeout(timeout: unknown, command?: string, location?: ShellLocation): { ok: true; seconds: number } | { ok: false; error: BashTimeoutError } {
  if (timeout === undefined) return { ok: false, error: { kind: 'bash_timeout_missing' } };
  if (typeof timeout !== 'number' || !Number.isFinite(timeout) || timeout <= 0) return { ok: false, error: { kind: 'bash_timeout_invalid', timeout } };
  if (timeout > BASH_MAX_SECONDS) return { ok: false, error: { kind: 'bash_timeout_over_cap', timeout } };
  if (command !== undefined) {
    const slept = foregroundSleep(command, timeout, location);
    if (slept.seconds > BASH_SLEEP_MAX_SECONDS) return { ok: false, error: { kind: 'bash_sleep_over_cap', ...slept } };
  }
  return { ok: true, seconds: timeout };
}
const bashTimeoutText = (error: BashTimeoutError, BACKGROUND: string) => {
  switch (error.kind) {
    case 'bash_timeout_missing': return `bash_timeout_missing: give timeout, in seconds, at most ${BASH_MAX_SECONDS}. ${BACKGROUND}`;
    case 'bash_timeout_invalid': return `bash_timeout_invalid: timeout must be a positive number of seconds, at most ${BASH_MAX_SECONDS}; got ${JSON.stringify(error.timeout)}.`;
    case 'bash_timeout_over_cap': return `bash_timeout_over_cap: a foreground command may run at most ${BASH_MAX_SECONDS} s (asked ${error.timeout} s), because messages to you wait until it ends. Nothing was run. ${BACKGROUND}`;
    case 'bash_sleep_over_cap': return `bash_sleep_over_cap: this command could spend up to ${Math.round(error.seconds)} s sleeping or polling (${error.evidence.join(', ')}); a command may sleep at most ${BASH_SLEEP_MAX_SECONDS} s in all, because messages to you wait until it ends. Nothing was run. Don't wait in a tool call: schedule \`wake\` on the event you are waiting for (a kenan-bg job's \`job:<your agent id>:NAME\`, a gpurun job's \`gpurun:<your agent id>:NAME\`, mail, a message, or \`on: "any"\`) with a deadline, and end your turn. For something that raises no event, run the polling loop itself in the background, e.g. \`kenan-bg NAME -- bash -c 'until CHECK; do sleep 30; done'\`, and wake on \`job:<your agent id>:NAME\`. A short wait (a server coming up) fits in the foreground under \`timeout ${BASH_SLEEP_MAX_SECONDS}\`.`;
  }
};
/** What the bash tool says about longer work: the host's own routes, or (a blank chat, server/agents/blank.ts) nothing about the host. */
export type BashText = 'host' | 'plain';
const PLAIN_BACKGROUND = 'Run longer work in the background (for example with nohup, writing to a log file) and check on it later.';
/** Only host agents have wakes, so only they are held to the sleep cap; a blank chat has nothing else to wait with. */
const SLEEP_TEXT = ` Never sleep or poll to wait: a command whose sleeps could add up to more than ${BASH_SLEEP_MAX_SECONDS} s (\`sleep N\`, a loop around sleep, \`gpurun wait\`) is refused with bash_sleep_over_cap; schedule \`wake\` on the event instead.`;
function bashTexts(text: BashText, person: PersonConfig): [background: string, hostTools: string, longer: string, sleeps: string | null] {
  return text === 'host' ? [background(heavyRoute(ownerPath(person))), hostToolsText(ownerPath(person)), 'Longer work goes in the background with kenan-bg.', SLEEP_TEXT] : [PLAIN_BACKGROUND, '', 'Run longer work in the background.', null];
}
/** Pi's bash tool with a required, capped timeout: the command never starts without one the cap allows. */
function cappedBash(definition: KenanTool, BACKGROUND: string, hostTools: string, longer: string, sleeps: string | null, person: PersonConfig): KenanTool {
  const parameters = Type.Object({
    command: Type.String({ description: 'Shell command to execute' }),
    timeout: Type.Number({ description: `Timeout in seconds, required, at most ${BASH_MAX_SECONDS}. ${longer}` }),
    outputLimit: Type.Optional(Type.Integer({ minimum: 1024, maximum: 51200, description: 'Success-output preview bytes (head and tail), default 16384; up to 51200 for deliberate large reads. Complete output is saved when shortened.' })),
  });
  return {
    ...definition,
    description: `Execute a bash command in the current working directory. Returns stdout and stderr. Successful output above outputLimit (default 16 KiB; up to 50 KiB) is shown as a head-and-tail preview with omitted bytes/lines and a readable full-output path. Failures retain their error output. Every call needs a timeout of at most ${BASH_MAX_SECONDS} seconds: messages to you are read only between tool calls, so a long foreground command makes them wait. ${BACKGROUND}${sleeps ?? ''}${hostTools} If shared job memory prevents shell startup, use exactly \`kenan-recover status\` to list this owner's largest job processes, or \`kenan-recover kill PID\` to stop one selected process. These fixed operations use a separate 128 MiB recovery scope; arbitrary shell commands remain in the shared job budget.`,
    parameters,
    execute: (toolCallId, params, ...rest) => {
      const { timeout, command, outputLimit } = params as { timeout?: unknown; command?: unknown; outputLimit?: number };
      if (outputLimit !== undefined && (!Number.isInteger(outputLimit) || outputLimit < 1024 || outputLimit > 51200)) throw new Error('bash_output_limit_invalid: outputLimit must be an integer from 1024 to 51200');
      const checked = bashTimeout(timeout, sleeps !== null && typeof command === 'string' ? command : undefined, { home: person.home, cwd: person.home, path: ownerPath(person) });
      if (!checked.ok) return Promise.reject(new Error(bashTimeoutText(checked.error, BACKGROUND)));
      return definition.execute(toolCallId, params, ...rest);
    },
  } as KenanTool;
}
/**
 * Pi's bash tool writes a truncated command's full output into the server's temp directory (/tmp, a tmpfs held in RAM), as the
 * server's user with mode 0600, and names that path in the result. The caller can't read it there and nothing would ever delete
 * it, so the caller's copy is written by the caller into its own scratch (/var/tmp/USER/bash-output, aged out by tmpfiles), the
 * server's copy is removed, and the result names the copy.
 */
async function moveFullOutput(source: string, scratch: string, files: Pick<OwnerFiles, 'mkdir' | 'write'>): Promise<string> {
  const target = join(scratch, 'bash-output', basename(source));
  const bytes = await readFile(source);
  await files.mkdir(dirname(target));
  await files.write(target, bytes);
  await unlink(source);
  return target;
}
export async function ownedFullOutput<R extends { content: Array<{ type: string; text?: string }>; details?: unknown }>(result: R, owner: { uid: number }, serverUid: number, scratch: string, files: Pick<OwnerFiles, 'mkdir' | 'write'>): Promise<R> {
  const source = (result.details as { fullOutputPath?: unknown } | undefined)?.fullOutputPath;
  if (typeof source !== 'string' || owner.uid === serverUid) return result;
  const target = await moveFullOutput(source, scratch, files);
  const content = result.content.map(part => part.type === 'text' && typeof part.text === 'string' ? { ...part, text: part.text.split(source).join(target) } : part);
  return { ...result, content, details: { ...(result.details as object), fullOutputPath: target } } as R;
}
/** Keep ordinary shell results small without discarding their original output or clipping errors. */
export async function boundedBashOutput<R extends { content: Array<{ type: string; text?: string }>; details?: unknown; isError?: boolean }>(result: R, limit: number, scratch: string, files: Pick<OwnerFiles, 'mkdir' | 'write'>): Promise<R> {
  if (result.isError) return result;
  const text = result.content.filter(p => p.type === 'text').map(p => p.text ?? '').join('\n');
  const details = result.details as { fullOutputPath?: string; truncation?: { totalLines?: number } } | undefined;
  if (Buffer.byteLength(text) <= limit && !details?.fullOutputPath) return result;
  let path = details?.fullOutputPath, head: Buffer, tail: Buffer, bytes: number, lines: number | undefined;
  const half = Math.floor((limit - 256) / 2);
  if (path) {
    const file = await open(path, 'r');
    try {
      bytes = (await file.stat()).size;
      if (bytes <= limit) return { ...result, content: [{ type: 'text', text: await file.readFile('utf8') }] };
      head = Buffer.alloc(Math.min(half, bytes)); tail = Buffer.alloc(Math.min(half, Math.max(0, bytes - head.length)));
      await file.read(head, 0, head.length, 0); await file.read(tail, 0, tail.length, bytes - tail.length);
      lines = details?.truncation?.totalLines;
    } finally { await file.close(); }
  } else {
    const full = Buffer.from(text); bytes = full.length;
    path = join(scratch, 'bash-output', `output-${randomUUID()}.log`);
    await files.mkdir(dirname(path)); await files.write(path, full);
    head = full.subarray(0, half); tail = full.subarray(-half);
    lines = text.split('\n').length;
  }
  return { ...result, content: [{ type: 'text', text: outputPreview(head, tail, bytes, path, lines) }], details: { ...(result.details as object), fullOutputPath: path } };
}
/** A command that timed out or was aborted throws instead of returning, and its message alone names the full output
 * ("Full output: /tmp/pi-bash-….log]"); that file is moved the same way and the message names the copy. */
export async function ownedErrorOutput(error: Error, owner: { uid: number }, serverUid: number, scratch: string, files: Pick<OwnerFiles, 'mkdir' | 'write'>, tempDir = tmpdir()): Promise<Error> {
  if (owner.uid === serverUid) return error;
  for (const [, source] of error.message.matchAll(/Full output: ([^\]\s]+)\]/g)) {
    if (source === undefined || dirname(source) !== tempDir) continue;
    error.message = error.message.split(source).join(await moveFullOutput(source, scratch, files));
  }
  return error;
}
/** Whether a write landed when the owner's file process ended before answering (it ignores the SIGTERM of a channel restart,
 * so only a kill it can't ignore gets here). The service reads the file itself to say which, so the agent knows whether to retry. */
export async function writeOutcome(path: string, content: Buffer): Promise<string> {
  const now = await readFile(path).catch(() => null);
  return now !== null && now.equals(content) ? `The write completed: ${path} holds the new content.`
    : `${path} does not hold the new content and may be partly written; read it before retrying.`;
}
/** The fs error as the agent reads it, and as Pi's edit tool expects it (an Error with the errno `code`). */
function fileError(error: unknown, path: string): Error {
  if (!(error instanceof FileOperationError)) return error instanceof Error ? error : new Error(String(error));
  const intact = error.intact === undefined ? '' : error.intact ? `\nThe original ${path} is unchanged.` : `\n${path} may be partly written.`;
  return Object.assign(new Error(`${error.message}${intact}`), { code: error.code });
}
/** Optional writeGuard is checked before the write and edit tools change a path. */
export function ownerTools(placement: ProcessPlacement, person: PersonConfig, agentId: string, writeGuard: (path: string) => Promise<void> = async () => {}, bashText: BashText = 'host', shuttingDown: () => boolean = () => false) {
  const files = ownerFiles(placement, person);
  const readFile = async (path: string) => {
    const data = await files.read(path).catch(error => { throw fileError(error, path); });
    const baseline = editBaseline.getStore();
    if (baseline) baseline.hash = createHash('sha256').update(data).digest('hex');
    return data;
  };
  const access = (path: string) => files.access(path).catch(error => { throw fileError(error, path); });
  const mkdir = async (path: string) => { await writeGuard(path); await files.mkdir(path).catch(error => { throw fileError(error, path); }); };
  const writeFile = async (path: string, content: string) => {
    await writeGuard(path);
    const bytes = Buffer.from(content);
    try { await files.write(path, bytes, editBaseline.getStore()?.hash); } catch (error) {
      if (error instanceof FileHelperGone) throw new Error(`${error.message} ${await writeOutcome(path, bytes)}`);
      throw fileError(error, path);
    }
  };
  const definitions = [
    cappedBash(owned(createBashToolDefinition(person.home, { exposeSessionEnvironment: false, operations: { exec: async (command, _cwd, options) => {
      const recovery = recoveryArgs(command);
      if (recovery) return bashOutcome(await ownerProcess(placement, person, '/usr/bin/python3', ['-c', RECOVERY_RUNNER, ...recovery], undefined, options.signal, options.onData, Math.min(options.timeout!, 10), undefined, agentId, true), options.timeout);
      if (placement.kind === 'callerCgroup') return bashOutcome(await ownerProcess(placement, person, '/bin/bash', ['-c', command], undefined, options.signal, options.onData, options.timeout, undefined, agentId), options.timeout);
      assertIndependentRuntimeControl(placement, '/bin/bash', ['-c', command]);
      const unit = `agent-tool-${placement.channel}-${randomUUID()}.scope`;
      const startedSeconds = Math.floor(Date.now() / 1000), killsBefore = await userSliceOomKills();
      const result = await foregroundProcess({ unit, outputRoot: `/var/tmp/${person.unixUser}/bash-output`, root: foregroundRoot(person.home, placement.channel, agentId), callId: toolCall.getStore()!, command, timeout: options.timeout!, home: person.home, env: ownerEnvironment(person, agentId), uid: person.uid, gid: person.gid, signal: options.signal, onData: options.onData, shuttingDown,
        launch: async path => {
          const placed = placedCommand(placement, person, FOREGROUND_RUNNER, [path], unit, { callId: toolCall.getStore()!, agentId }, options.timeout!);
          // systemd-run --scope stays until the command ends. Its pipes carry no command output.
          const child = spawnChild(placed.executable, placed.args, { cwd: person.home, env: ownerEnvironment(person, agentId), detached: true });
          let errors = '';
          child.stderr.on('data', data => { errors = (errors + data.toString()).slice(-2000); });
          child.stdout.resume(); child.stdin.end();
          child.on('error', error => {
            // Losing the launch helper's pipes does not end an independent command it already
            // accepted. Its runner still owns the result; the bounded file monitor follows it.
            if (!shuttingDown() && !(error instanceof SpawnerGone && error.began)) void foregroundLaunchEnded(path, null, null, error.message).catch(() => {});
          });
          child.on('close', (code, signal) => { if (!shuttingDown()) void foregroundLaunchEnded(path, code, signal, errors).catch(() => {}); });
        },
      });
      const notice = await oomNotice({ unit, slice: 'user-agents.slice' }, startedSeconds, killsBefore, heavyRoute(ownerPath(person)));
      if (notice) options.onData(Buffer.from(notice));
      else if (result.signal && result.termination === 'signal') options.onData(Buffer.from(await signalNotice(placement, result.signal)));
      return bashOutcome(result, options.timeout);
    } } }), 'writes'), ...bashTexts(bashText, person), person),
    // Read checks the owner's access before sniffing, so the service only inspects image headers of files the owner can read.
    owned(createReadToolDefinition(person.home, { operations: { readFile, access, detectImageMimeType: detectSupportedImageMimeTypeFromFile } }), 'reads'),
    owned(createWriteToolDefinition(person.home, { operations: { writeFile, mkdir } }), 'writes'),
    owned(createEditToolDefinition(person.home, { operations: { readFile, writeFile, access } }), 'writes'),
  ];
  const serverUid = userInfo().uid;
  const withQuotaRemedy = (text: string) => withDiskRemedy(text, quotaRemedy(ownerPath(person)));
  return definitions.map(definition => ({ ...definition, execute: async (...args: Parameters<KenanTool['execute']>) => {
    let result: Awaited<ReturnType<KenanTool['execute']>>;
    try {
      const execute = () => toolCall.run(args[0], () => definition.execute(...args));
      if (definition.name === 'edit' || definition.name === 'write') {
        const path = (args[1] as { path: string }).path;
        result = await serializeMutation(resolve(person.home, path), async () => {
          if (definition.name === 'write') return execute();
          for (;;) {
            try { return await editBaseline.run({}, execute); }
            catch (error) { if (!(error instanceof Error) || !('code' in error) || error.code !== 'EDIT_CONFLICT') throw error; }
          }
        });
      } else result = await execute();
    } catch (error) {
      if (error instanceof Error) {
        error.message = withQuotaRemedy(error.message);
        throw await ownedErrorOutput(error, person, serverUid, `/var/tmp/${person.unixUser}`, files);
      }
      throw error;
    }
    const content = (result as { isError?: boolean }).isError ? result.content.map(part => part.type === 'text' && typeof part.text === 'string' ? { ...part, text: withQuotaRemedy(part.text) } : part) : result.content;
    const ownedResult = await ownedFullOutput({ ...result, content }, person, serverUid, `/var/tmp/${person.unixUser}`, files);
    return definition.name === 'bash' ? boundedBashOutput(ownedResult, (args[1] as { outputLimit?: number }).outputLimit ?? 16384, `/var/tmp/${person.unixUser}`, files) : ownedResult;
  } }));
}
/** The kernel says only "Disk quota exceeded" (EDQUOT). On assistant-host root is a working cache with per-account quotas and bulk
 * data belongs on the Storage Box (machine/storage.md, 2026-10-30), so a tool call that fails with an actual quota error (a failed
 * command or write, never a successful read or output that merely contains the words) also says how to free it at once. */
export const QUOTA_REMEDY = 'disk_quota_exceeded: this account is over its disk quota (`quota -s` shows it). Free it now with `kenan-cold move PATH` on finished run folders and old captures: they move to the 20 TB Storage Box and stay readable at the same path (`kenan-cold restore PATH` to write in one again).';
/** A host without kenan-cold (acme-host) has no per-account quota or Storage Box; the remedy names only tools that exist there (worker e2e12937, 2026-10-30). */
export const LOCAL_DISK_REMEDY = 'disk_quota_exceeded: a write was refused with EDQUOT. Check free space with `df -h PATH` and the host\'s configured quotas. Free only your own unused, regenerable scratch files; preserve source and unique results.';
export const quotaRemedy = (path: string) => executableOn(path, 'kenan-cold') ? QUOTA_REMEDY : LOCAL_DISK_REMEDY;
/** Only an actual error names the quota: strerror after a colon or at a line start, or the EDQUOT code followed by a colon. Output
 * that merely mentions the words (grep of this source, a log of the remedy) is not a quota error (worker e2e12937, 2026-10-30). */
export const QUOTA_ERROR = /(?:^|:[ \t]*)Disk quota exceeded\b|\bEDQUOT:/m;
export const withDiskRemedy = (text: string, remedy: string) => QUOTA_ERROR.test(text) && !text.includes(remedy) ? `${text}\n\n${remedy}` : text;
