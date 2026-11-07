import { mkdir, writeFile, readFile, readdir, unlink, chown, open, link, stat, rename } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { createReadStream, watch, type FSWatcher } from 'node:fs';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { execFileText } from '../spawner.js';

export type ForegroundResult = { exitCode: number; signal: NodeJS.Signals | null; termination: 'exit' | 'signal' | 'timeout' | 'cancelled'; error?: string };
type Job = { version?: 2; unit?: string; callId: string; command: string; timeout: number; home: string; env: NodeJS.ProcessEnv; output: string; started: number };
const pause = () => new Promise(resolve => setTimeout(resolve, 100));
const json = async <T>(path: string): Promise<T | null> => {
  try { return JSON.parse(await readFile(path, 'utf8')) as T; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
};
export const foregroundRoot = (home: string, channel: string, agent: string) => join(home, '.local/state/kenan/foreground', channel, encodeURIComponent(agent));
export const FOREGROUND_START_SECONDS = 60;

/** Watch before reading: a change during a read must not be lost before the next wait.
 * The one-second watchdog covers lost inotify events and unavailable watches. */
function foregroundChanges(paths: string[], signal?: AbortSignal) {
  let revision = 0, waiting: (() => void) | undefined;
  const changed = () => { revision++; waiting?.(); };
  const directories = new Map<string, Set<string>>();
  for (const path of paths) {
    const names = directories.get(dirname(path)) ?? new Set<string>();
    names.add(basename(path)); directories.set(dirname(path), names);
  }
  const watchers: FSWatcher[] = [];
  for (const [directory, names] of directories) {
    try {
      const watcher = watch(directory, { persistent: false }, (_event, name) => {
        if (name === null || names.has(name.toString())) changed();
      });
      watcher.on('error', () => { watcher.close(); changed(); });
      watchers.push(watcher);
    } catch { /* The watchdog remains active when inotify is unavailable. */ }
  }
  signal?.addEventListener('abort', changed);
  return {
    revision: () => revision,
    ignore: (path: string) => { directories.get(dirname(path))?.delete(basename(path)); },
    wait: (previous: number) => new Promise<void>(resolve => {
      if (revision !== previous) { resolve(); return; }
      const done = () => { clearTimeout(timer); waiting = undefined; resolve(); };
      const timer = setTimeout(done, 1000);
      waiting = done;
    }),
    close: () => { watchers.forEach(watcher => watcher.close()); signal?.removeEventListener('abort', changed); waiting?.(); },
  };
}

/** The server writes as root; publish cancellation only after the runner can read it. */
async function cancelForeground(path: string, reason: 'cancel' | 'timeout'): Promise<void> {
  const { uid, gid } = await stat(path);
  const temporary = `${path}.${randomUUID()}.cancel.tmp`;
  const file = await open(temporary, 'wx', 0o600);
  try {
    try { await file.chown(uid, gid); await file.writeFile(reason); }
    finally { await file.close(); }
    await rename(temporary, `${path}.cancel`);
  } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}

/** Built beside this module; the source/dev route uses the same native build. */
export const FOREGROUND_RUNNER = fileURLToPath(new URL(import.meta.url.endsWith('.ts')
  ? '../../dist/server/tools/foreground-runner' : './foreground-runner', import.meta.url));

/** Files remain until the next turn sees the result in Pi's durable transcript. No command is ever replayed. */
export async function foregroundProcess(options: {
  root: string; outputRoot?: string; unit?: string; callId: string; command: string; timeout: number; home: string; env: NodeJS.ProcessEnv;
  uid: number; gid: number; signal?: AbortSignal; onData?: (data: Buffer) => void; shuttingDown: () => boolean;
  launch: (path: string) => Promise<void>;
}): Promise<ForegroundResult & { output: Buffer }> {
  await mkdir(options.root, { recursive: true });
  await chown(options.root, options.uid, options.gid);
  const id = randomUUID();
  const path = join(options.root, `${id}.json`);
  const outputRoot = options.outputRoot ?? options.root;
  await mkdir(outputRoot, { recursive: true });
  await chown(outputRoot, options.uid, options.gid);
  const job: Job = { version: 2, unit: options.unit, callId: options.callId, command: options.command, timeout: options.timeout, home: options.home, env: options.env, output: join(outputRoot, `foreground-${id}.log`), started: Date.now() };
  // The launcher can fail before Node opens the log. Reserve it as the owner before
  // publishing the job, so every error and restart notice names a readable file.
  const output = await open(job.output, 'wx', 0o600);
  try { await output.chown(options.uid, options.gid); }
  finally { await output.close(); }
  await writeFile(path, JSON.stringify(job), { mode: 0o600 });
  await chown(path, options.uid, options.gid);
  const changes = foregroundChanges([`${path}.started`, `${path}.result`, job.output], options.signal);
  try {
    try { await options.launch(path); }
    catch (error) { await unlink(path); throw error; }
    let offset = 0;
    // Pi only shows 50 KiB. Keep the complete log here rather than copying an unbounded
    // file through its output accumulator after the shell's deadline has passed.
    const displayBytes = 50 * 1024;
    const flush = async (final: boolean) => {
      const file = await open(job.output, 'r').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (!file) return;
      try {
        const size = (await file.stat()).size;
        const end = final ? size : Math.min(size, displayBytes);
        if (offset >= end) return;
        const start = final ? Math.max(offset, end - displayBytes) : offset;
        const omitted = start - offset;
        const buffer = Buffer.alloc(end - start);
        const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
        offset = start + bytesRead;
        options.onData?.(buffer.subarray(0, bytesRead));
        if (omitted) options.onData?.(Buffer.from(`\n[${omitted} output bytes omitted; complete original output: ${job.output}]\n`));
      } finally { await file.close(); }
    };
    for (;;) {
      const revision = changes.revision();
      if (options.signal?.aborted) {
        if (options.shuttingDown()) { await writeFile(`${path}.detached`, 'restart', { mode: 0o600 }); throw new Error(`foreground_continues: the command survives this restart; its result will be attached automatically. Full output: ${job.output}`); }
        await cancelForeground(path, 'cancel');
      }
      const result = await jobResult(path, job);
      await flush(!!result);
      if (offset >= displayBytes) changes.ignore(job.output);
      if (result) {
        await stopFinishedScope(job, result);
        if (result.error) options.onData?.(Buffer.from(`\n${result.error}\n`));
        return { ...result, output: Buffer.alloc(0) };
      } // Pi already collected the streamed bytes.
      await changes.wait(revision);
    }
  } finally { changes.close(); }
}

/** The launcher can die by signal (a null exit code), or exit without a runner receipt.
 * Neither means the command did not run. Publish that uncertainty immediately, never replay it.
 * A separate temporary file and exclusive link cannot replace the runner's authentic result. */
export async function foregroundLaunchEnded(path: string, code: number | null, signal: NodeJS.Signals | null, diagnostic = ''): Promise<void> {
  const job = await json<Job>(path);
  if (!job || await json<ForegroundResult>(`${path}.result`)) return;
  const started = !!await json(`${path}.started`);
  // systemctl stop in jobResult kills the launcher too. Its close callback can
  // win the race with the watchdog's final read; that is our timeout, not an
  // unexplained external SIGTERM. A user cancellation has the same ordering.
  const cancellation = await readFile(`${path}.cancel`, 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  const requested = cancellation === null ? null : cancellation === 'timeout' ? 'timeout' : 'cancelled';
  const temporary = `${path}.${randomUUID()}.result.tmp`;
  const ended = signal ? `was killed by ${signal}` : `exited with code ${code ?? 'unknown'}`;
  const result: ForegroundResult = requested
    ? { exitCode: requested === 'timeout' ? 124 : 130, signal, termination: requested, error: `${requested === 'timeout' ? started ? 'foreground_result_missing: the command deadline expired' : 'foreground_launch_timeout: the runner did not confirm startup within 60 seconds' : 'foreground_cancelled: this tool call was cancelled'}; Kenan stopped this call's launcher before it saved a command result. Check the log (${job.output}) and effects before retrying.${diagnostic ? ` Launcher diagnostic: ${diagnostic}` : ''}` }
    : { exitCode: 125, signal, termination: signal ? 'signal' : 'exit', error: `foreground_runner_ended_without_result: the launcher ${ended} without a saved command result. The command may have run (its runner ${started ? 'had' : 'had not'} confirmed startup); inspect its full output (${job.output}) and effects before retrying.${diagnostic ? ` Launcher diagnostic: ${diagnostic}` : ''}` };
  await writeFile(temporary, JSON.stringify(result), { mode: 0o600 });
  try { await link(temporary, `${path}.result`); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  finally { await unlink(temporary); }
}

async function jobResult(path: string, job: Job): Promise<ForegroundResult | null> {
  const result = await json<ForegroundResult>(`${path}.result`);
  if (result) return result;
  // The command's timeout starts in the runner, not while systemd is launching it.
  // Memory pressure can make that launch slower than a short command's entire budget.
  const running = await json<{ started: number; pid: number }>(`${path}.started`);
  const deadline = running ? running.started + job.timeout * 1000 + 5000
    : job.started + (job.version === 2 ? FOREGROUND_START_SECONDS * 1000 : job.timeout * 1000 + 5000);
  if (Date.now() <= deadline) return null;
  // Recheck after I/O: the runner may have finished while we read its start record.
  const finished = await json<ForegroundResult>(`${path}.result`);
  if (finished) return finished;
  await cancelForeground(path, 'timeout');
  // Stop only this call, then prefer its real result if it arrived during cancellation.
  if (job.unit) await execFileText('/usr/bin/systemctl', ['stop', job.unit], { timeout: 5000 }).catch(() => {});
  // This final, tiny receipt read must not yield: another asynchronous ENOENT callback
  // could itself be delayed past the runner's write in exactly the same way.
  try { return JSON.parse(readFileSync(`${path}.result`, 'utf8')) as ForegroundResult; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  return { exitCode: 125, signal: null, termination: 'timeout', error: running
    ? `foreground_result_missing: runner pid ${running.pid} did not save a result by the command deadline; cancellation was requested for this call. Check the log and effects before retrying.`
    : 'foreground_launch_timeout: the runner did not confirm startup within 60 seconds; its launch is cancelled and a late runner will not execute the command. Check its effects before retrying.' };
}

async function stopFinishedScope(job: Job, result: ForegroundResult): Promise<void> {
  if (job.unit && (result.termination === 'timeout' || result.termination === 'cancelled' || result.error)) {
    await execFileText('/usr/bin/systemctl', ['kill', '--signal=SIGKILL', job.unit], { timeout: 5000 }).catch(() => {});
  }
}

type TranscriptMessage = { role: string; toolCallId?: string; content?: unknown; isError?: boolean };
type Pending = { path: string; job: Job; detached: boolean };
async function pendingForeground(root: string): Promise<Pending[]> {
  const names = await readdir(root).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  const pending: Pending[] = [];
  for (const name of names.filter(name => name.endsWith('.json'))) {
    const path = join(root, name), job = await json<Job>(path);
    if (!job) continue;
    const detached = await readFile(`${path}.detached`).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
    pending.push({ path, job, detached });
  }
  return pending;
}
function delivered({ job, detached }: Pending, message: TranscriptMessage): boolean {
  const text = typeof message.content === 'string' ? message.content : Array.isArray(message.content) ? message.content.map(part => part?.type === 'text' ? part.text : '').join('') : '';
  // Shell output may quote our source code, including foreground_continues. Only an actual abort result
  // is synthetic; searching the whole output for that word repeated ordinary source-reading commands.
  const synthetic = message.isError !== false && (text === 'Operation aborted' || text.startsWith('foreground_continues:'));
  return !detached && !synthetic && message.role === 'toolResult' && message.toolCallId === job.callId
    || message.role === 'user' && JSON.stringify(message.content ?? '').includes(`Recovered foreground bash (${job.callId})`);
}
async function forgetForeground({ path }: Pending): Promise<void> {
  // Remove the pending description first: interruption during cleanup cannot offer it again.
  await unlink(path).catch(error => { if (error.code !== 'ENOENT') throw error; });
  await Promise.all([`${path}.result`, `${path}.cancel`, `${path}.detached`, `${path}.started`, `${path}.started.tmp`].map(file => unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error; })));
}
/** Call only after Pi has persisted these messages, not when the shell merely returns. */
export async function acknowledgeForeground(root: string, messages: Iterable<TranscriptMessage> | AsyncIterable<TranscriptMessage>): Promise<void> {
  const pending = await pendingForeground(root);
  if (!pending.length) return;
  for await (const message of messages) {
    for (let i = pending.length - 1; i >= 0; i--) {
      if (!delivered(pending[i]!, message)) continue;
      await forgetForeground(pending[i]!);
      pending.splice(i, 1);
    }
    if (!pending.length) break;
  }
}
/** Older builds left completed commands pending through compaction. Read the journal, not its compacted projection,
 * before trimming it. Older trimmed journals remain in transcripts; only this agent's files are considered. */
export async function acknowledgeForegroundJournal(root: string, sessionPath: string, dataDir: string): Promise<void> {
  async function* messages(): AsyncGenerator<TranscriptMessage> {
    const prefix = `${basename(sessionPath, '.jsonl')}.`;
    const directory = join(dataDir, 'transcripts');
    const older = await readdir(directory).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
    for (const path of [sessionPath, ...older.filter(name => name.startsWith(prefix) && name.endsWith('.jsonl')).sort().reverse().map(name => join(directory, name))]) {
      const stream = createReadStream(path, { encoding: 'utf8' });
      const lines = createInterface({ input: stream, crlfDelay: Infinity });
      try {
        for await (const line of lines) {
          let entry;
          try { entry = JSON.parse(line); } catch { continue; }
          if (entry.type === 'message' && entry.message) yield entry.message;
        }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      finally { lines.close(); stream.destroy(); }
    }
  }
  await acknowledgeForeground(root, messages());
}

/** Attach the output from the original command before asking the agent to continue. Waiting affects only this agent. */
export async function recoveredForeground(root: string, messages: readonly TranscriptMessage[], shuttingDown: () => boolean, cancelled: () => boolean = () => false): Promise<string> {
  await acknowledgeForeground(root, messages);
  const recovered: string[] = [];
  for (const { path, job } of await pendingForeground(root)) {
    const marker = `Recovered foreground bash (${job.callId})`;
    let result: ForegroundResult | null;
    while (!(result = await jobResult(path, job))) {
      if (shuttingDown()) return '';
      if (cancelled()) await cancelForeground(path, 'cancel');
      await pause();
    }
    await stopFinishedScope(job, result);
    // Bound the model input, keeping the original complete owner-readable log.
    const file = await open(job.output, 'r').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    let output = '';
    if (file) {
      try {
        const size = (await file.stat()).size, buffer = Buffer.alloc(Math.min(size, 50 * 1024));
        const { bytesRead } = await file.read(buffer, 0, buffer.length, Math.max(0, size - buffer.length));
        output = buffer.subarray(0, bytesRead).toString();
      } finally { await file.close(); }
    }
    recovered.push(`${marker}: ${result.termination}, exit ${result.exitCode}${result.signal ? ` (${result.signal})` : ''}. The original command was not repeated.\nCommand: ${job.command}\nFull output: ${job.output}\n${output}${result.error ? `\n${result.error}` : ''}`);
  }
  return recovered.join('\n\n');
}
