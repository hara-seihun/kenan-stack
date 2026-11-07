import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';

/**
 * Child processes for the server, started by one small long-lived helper process instead of by the server itself.
 *
 * Why: Node's spawn forks the calling process and waits for the child's exec, on the event loop. The channel server holds a
 * multi-GB heap (Beta 2026-10-31: 2 GB resident, 51 MB of page tables), so every fork copied those page tables: spawning
 * /bin/true took 30-60 ms, and the bash tool's ~3 spawns a second cost about a tenth of the whole event loop, the measure
 * that handles agent turns. Forking the helper's ~50 MB node process costs about a millisecond, and it
 * does that on its own event loop.
 *
 * The helper runs as the server's own user in the server's cgroup, so what it starts is exactly what `spawn` would have
 * started (callers pass uid/gid, cwd, env and detached as before; with no env a child gets the server's). Children's stdout
 * and stderr come back as frames.
 *
 * The helper ignores SIGTERM: a service stop (every deploy) signals the whole cgroup at once, and the server keeps running
 * tool calls for up to its stop timeout after that (Beta 2026-10-31 22:55Z: 22 s, in which every bash and report call ended
 * as spawner_gone instead of reading as cut off by the restart). It ends when the server closes its stdin, or exits.
 * When the helper dies anyway (SIGKILL, out of memory), a child it had not yet taken (no `accepted` frame, which it sends
 * before it starts the child) certainly never ran, so the shared spawner starts it on a fresh helper; a child it had taken
 * ends with `error` (SpawnerGone, began: true), since it may still be running and its output is lost.
 *
 * Frames, both ways: u32 header length, u32 body length (big-endian), the JSON header, then the body bytes.
 * Server → helper: {op:'spawn', id, file, args, options} | {op:'stdin', id} + body | {op:'end', id}
 * Helper → server: {ev:'accepted', id} | {ev:'spawn', id, pid} | {ev:'data', id, fd: 1|2} + body
 *                  | {ev:'error', id, code, message} | {ev:'exit', id, code, signal} | {ev:'close', id, code, signal}
 */
const SPAWNER = String.raw`
import { spawn } from "node:child_process";
const children = new Map();
// Pipe writes from node are synchronous on Linux, so a server that falls behind holds this process, and children's output waits in their own pipes.
const send = (header, body) => {
  const json = Buffer.from(JSON.stringify(header));
  const head = Buffer.alloc(8);
  head.writeUInt32BE(json.length, 0); head.writeUInt32BE(body ? body.length : 0, 4);
  process.stdout.write(body && body.length ? Buffer.concat([head, json, body]) : Buffer.concat([head, json]));
};
process.stdout.on("error", () => process.exit(0));
process.on("SIGTERM", () => {});
const start = (id, file, args, options) => {
  send({ ev: "accepted", id });
  let child;
  try { child = spawn(file, args, { ...options, stdio: ["pipe", "pipe", "pipe"] }); }
  catch (error) { send({ ev: "error", id, code: String(error.code ?? "Error"), message: String(error.message) }); return; }
  children.set(id, child);
  child.on("spawn", () => send({ ev: "spawn", id, pid: child.pid }));
  child.on("error", error => { children.delete(id); send({ ev: "error", id, code: String(error.code ?? "Error"), message: String(error.message) }); });
  child.stdout.on("data", chunk => send({ ev: "data", id, fd: 1 }, chunk));
  child.stderr.on("data", chunk => send({ ev: "data", id, fd: 2 }, chunk));
  child.stdin.on("error", () => {});
  child.on("exit", (code, signal) => send({ ev: "exit", id, code, signal }));
  child.on("close", (code, signal) => { children.delete(id); send({ ev: "close", id, code, signal }); });
};
let buffered = Buffer.alloc(0);
process.stdin.on("data", chunk => {
  buffered = buffered.length ? Buffer.concat([buffered, chunk]) : chunk;
  for (;;) {
    if (buffered.length < 8) return;
    const headerLength = buffered.readUInt32BE(0), bodyLength = buffered.readUInt32BE(4);
    if (buffered.length < 8 + headerLength + bodyLength) return;
    const request = JSON.parse(buffered.subarray(8, 8 + headerLength).toString());
    const body = Buffer.from(buffered.subarray(8 + headerLength, 8 + headerLength + bodyLength));
    buffered = buffered.subarray(8 + headerLength + bodyLength);
    const child = children.get(request.id);
    switch (request.op) {
      case "spawn": start(request.id, request.file, request.args, request.options); break;
      case "stdin": child?.stdin.write(body); break;
      case "end": child?.stdin.end(); break;
    }
  }
});
process.stdin.on("end", () => process.exit(0));
`;

export type SpawnOptions = { cwd?: string; env?: NodeJS.ProcessEnv; uid?: number; gid?: number; detached?: boolean };

/** The spawner ended (killed, out of memory) after it had taken this child (`began`), or, for a spawner of its own, before. */
export class SpawnerGone extends Error {
  readonly code = 'spawner_gone';
  constructor(detail: string, readonly began: boolean) {
    super(began
      ? `spawner_gone: the process that starts the server's child processes ended (${detail}) after this command had started: its output is lost and it may have finished or still be running, so check its effects before running it again.`
      : `spawner_gone: the process that starts the server's child processes ended (${detail}) before this command started, so it never ran; running it again is safe.`);
  }
}

let nextChildId = 1;
type Frame = { header: { op: string; id: number } & Record<string, unknown>; body?: Buffer };

/** The part of Node's ChildProcess the server uses, for a child the spawner started. `pid` is set once it has started. */
export class Child extends EventEmitter {
  pid: number | undefined;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin: Writable;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  private pendingSignals: NodeJS.Signals[] = [];
  private ended = false;
  /** Every frame sent until the helper took this child, to send again on a fresh helper; null once taken. */
  /** @internal */ unaccepted: Frame[] | null = [];
  /** @internal */ restarts = 0;
  readonly id = nextChildId++;
  constructor(/** @internal */ public spawner: Spawner) {
    super();
    this.stdin = new Writable({
      write: (chunk: Buffer, _encoding, done) => { this.send({ header: { op: 'stdin', id: this.id }, body: chunk }); done(); },
      final: done => { this.send({ header: { op: 'end', id: this.id } }); done(); },
    });
  }
  /** @internal */ send(frame: Frame): void {
    this.unaccepted?.push(frame);
    this.spawner.send(frame.header, frame.body);
  }
  /** Signals the child's process group (it was spawned detached), also after the leader exited (descendants may hold on); before it has started, once it starts. */
  killGroup(signal: NodeJS.Signals): void {
    if (this.pid === undefined) { this.pendingSignals.push(signal); return; }
    try { process.kill(-this.pid, signal); } catch {}
  }
  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    if (this.pid === undefined || this.ended) return false;
    try { process.kill(this.pid, signal); return true; } catch { return false; }
  }
  /** @internal */ started(pid: number): void {
    this.pid = pid;
    this.emit('spawn');
    for (const signal of this.pendingSignals.splice(0)) this.killGroup(signal);
  }
  /** @internal */ exited(event: 'exit' | 'close', code: number | null, signal: NodeJS.Signals | null): void {
    this.exitCode = code; this.signalCode = signal;
    if (event === 'close') { this.ended = true; this.endOutput(); }
    this.emit(event, code, signal);
  }
  /** @internal */ failed(error: Error): void {
    if (this.ended) return;
    this.ended = true;
    this.endOutput();
    this.emit('error', error);
  }
  private endOutput(): void { for (const stream of [this.stdout, this.stderr]) if (!stream.destroyed) stream.end(); }
}

export class Spawner {
  private readonly children = new Map<number, Child>();
  private received: Buffer = Buffer.alloc(0);
  private stderr = '';
  ended = false;
  /** `restart`: where children this helper never took go when it dies; without it they end with SpawnerGone (began: false). */
  constructor(private readonly helper: ChildProcessWithoutNullStreams, private readonly restart?: (child: Child) => void) {
    helper.stdout.on('data', (chunk: Buffer) => this.receive(chunk));
    helper.stderr.on('data', (chunk: Buffer) => { this.stderr = (this.stderr + chunk.toString()).slice(-2000); });
    helper.stdin.on('error', () => {});
    helper.on('error', error => this.gone(error.message));
    helper.on('close', (code, signal) => this.gone(signal ? `killed by ${signal}` : `exited with code ${code}${this.stderr.trim() ? `: ${this.stderr.trim()}` : ''}`));
    // The server's exit must not wait for the helper.
    helper.unref(); (helper.stdout as unknown as { unref?: () => void }).unref?.(); (helper.stderr as unknown as { unref?: () => void }).unref?.(); (helper.stdin as unknown as { unref?: () => void }).unref?.();
  }
  spawn(file: string, args: readonly string[], options: SpawnOptions = {}): Child {
    const child = new Child(this);
    child.unaccepted!.push({ header: { op: 'spawn', id: child.id, file, args, options } });
    this.adopt(child);
    return child;
  }
  /** Sends a child the helper has not taken yet, with everything written to it so far. */
  /** @internal */ adopt(child: Child): void {
    child.spawner = this;
    if (this.ended) { queueMicrotask(() => child.failed(new SpawnerGone('it had already ended', false))); return; }
    this.children.set(child.id, child);
    for (const frame of child.unaccepted!) this.send(frame.header, frame.body);
  }
  /** Ends the helper once its children's pipes close. */
  retire(): void { this.helper.stdin.end(); }
  /** @internal */ send(header: object, body?: Buffer): void {
    if (this.ended) return;
    const json = Buffer.from(JSON.stringify(header));
    const head = Buffer.alloc(8);
    head.writeUInt32BE(json.length, 0); head.writeUInt32BE(body?.length ?? 0, 4);
    this.helper.stdin.write(body?.length ? Buffer.concat([head, json, body]) : Buffer.concat([head, json]));
  }
  private receive(chunk: Buffer) {
    this.received = this.received.length ? Buffer.concat([this.received, chunk]) : chunk;
    for (;;) {
      if (this.received.length < 8) return;
      const headerLength = this.received.readUInt32BE(0), bodyLength = this.received.readUInt32BE(4);
      if (this.received.length < 8 + headerLength + bodyLength) return;
      const header = JSON.parse(this.received.subarray(8, 8 + headerLength).toString()) as
        { ev: 'accepted'; id: number } | { ev: 'spawn'; id: number; pid: number } | { ev: 'data'; id: number; fd: 1 | 2 } | { ev: 'error'; id: number; code: string; message: string }
        | { ev: 'exit' | 'close'; id: number; code: number | null; signal: NodeJS.Signals | null };
      const body = this.received.subarray(8 + headerLength, 8 + headerLength + bodyLength);
      this.received = this.received.subarray(8 + headerLength + bodyLength);
      const child = this.children.get(header.id);
      if (!child) continue;
      switch (header.ev) {
        case 'accepted': child.unaccepted = null; break;
        case 'spawn': child.started(header.pid); break;
        case 'data': { const stream = header.fd === 1 ? child.stdout : child.stderr; if (!stream.destroyed) stream.write(Buffer.from(body)); break; }
        case 'error': this.children.delete(header.id); child.failed(Object.assign(new Error(header.message), { code: header.code })); break;
        case 'exit': child.exited('exit', header.code, header.signal); break;
        case 'close': this.children.delete(header.id); child.exited('close', header.code, header.signal); break;
      }
    }
  }
  private gone(detail: string) {
    if (this.ended) return;
    this.ended = true;
    const children = [...this.children.values()];
    this.children.clear();
    for (const child of children) {
      // A helper that dies before taking anything (it cannot start at all) must not loop forever.
      if (child.unaccepted && this.restart && child.restarts++ < 3) this.restart(child);
      else child.failed(new SpawnerGone(detail, child.unaccepted === null));
    }
  }
}

/** A spawner helper from an explicit node binary; `spawnChild` is the way in, this is for tests. */
export function startSpawner(node = process.execPath, restart?: (child: Child) => void): Spawner {
  return new Spawner(nodeSpawn(node, ['--max-old-space-size=256', '--input-type=module', '-e', SPAWNER], { stdio: ['pipe', 'pipe', 'pipe'] }), restart);
}

let shared: Spawner | undefined;
const spawner = (): Spawner => {
  if (!shared || shared.ended) shared = startSpawner(process.execPath, child => spawner().adopt(child));
  return shared;
};

/** Like child_process.spawn with stdio pipes, without forking the server. */
export function spawnChild(file: string, args: readonly string[], options: SpawnOptions = {}): Child {
  return spawner().spawn(file, args, options);
}

export type ExecError = Error & { code?: number | string; signal?: NodeJS.Signals | null; killed?: boolean };
/** Like child_process.execFile (text output, a timeout that sends SIGTERM), without forking the server. */
export function execFileText(file: string, args: readonly string[], options: SpawnOptions & { timeout?: number } = {}): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawnChild(file, args, options);
    const out: Buffer[] = [], err: Buffer[] = [];
    let killed = false;
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
    const timer = options.timeout ? setTimeout(() => { killed = true; child.kill('SIGTERM'); }, options.timeout) : undefined;
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(out).toString(), stderr = Buffer.concat(err).toString();
      if (code === 0) return resolve({ stdout, stderr });
      reject(Object.assign(new Error(`Command failed: ${[file, ...args].join(' ')}\n${stderr}`), { code: code ?? undefined, signal, killed, stdout, stderr }) as ExecError);
    });
    child.stdin.end();
  });
}
