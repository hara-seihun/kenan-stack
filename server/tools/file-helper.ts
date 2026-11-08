import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { PersonConfig } from '../config.js';
import { REPLACE_FILE_FUNCTION } from './replace-file.js';
import type { ProcessPlacement } from './owner.js';

/**
 * The read, write and edit tools (and attach) touch files as their owner through one long-lived process per owner, instead of
 * one `systemd-run --scope` + setpriv + node per operation. On 2026-10-31 at host load 50 each such spawn cost 0.4-0.5 s (systemd
 * itself was at 90 % CPU starting ~2 scopes a second and reloading 74 times an hour) at the agents' low CPU weight, and an edit
 * paid it three times: edits took 5-45 s. A request to the helper is a pipe round trip.
 *
 * The helper runs in the channel's own service cgroup (file operations are I/O, not the agents' heavy work), with the owner's
 * uid, gid and supplementary groups (setpriv --init-groups) and the owner's umask. It ignores the SIGTERM a channel restart
 * sends, so a write that started finishes, and exits when the server's end of its stdin closes. A helper with a request
 * outstanding longer than STUCK_MS (a read stuck on a dead network mount) takes no new requests: the next one starts a fresh
 * helper and the old one finishes or dies on its own.
 *
 * Frames, both ways: u32 header length, u32 body length (big-endian), the JSON header, then the body bytes. A request's body is
 * the content to write; a response's body is the bytes read. A frame cut short (the server died mid-pipe) is never acted on.
 */
const FILE_HELPER = String.raw`
import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes, createHash } from "node:crypto";
${REPLACE_FILE_FUNCTION}
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, () => {});
process.umask(Number(process.argv[1]));
const send = (header, body) => {
  const json = Buffer.from(JSON.stringify(header));
  const head = Buffer.alloc(8);
  head.writeUInt32BE(json.length, 0); head.writeUInt32BE(body ? body.length : 0, 4);
  process.stdout.write(Buffer.concat([head, json]));
  if (body && body.length) process.stdout.write(body);
};
const refuse = (code, message) => Object.assign(new Error(message), { code });
const run = async (request, body) => {
  switch (request.op) {
    case "read": {
      if (request.max !== undefined) {
        const stat = await fs.stat(request.path);
        if (!stat.isFile()) throw refuse("not_a_file", stat.isDirectory() ? "directory" : "not a regular file");
        if (stat.size > request.max) throw refuse("too_large", stat.size + " bytes, limit " + request.max);
      }
      const bytes = await fs.readFile(request.path);
      if (request.max !== undefined && bytes.length > request.max) throw refuse("too_large", bytes.length + " bytes, limit " + request.max);
      return bytes;
    }
    case "access": await fs.access(request.path); return null;
    case "mkdir": await fs.mkdir(request.path, { recursive: true }); return null;
    case "write": await replaceFile(request.path, body, request.expected); return null;
    default: throw refuse("unknown_op", String(request.op));
  }
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
    run(request, body).then(
      bytes => send({ id: request.id, ok: true }, bytes),
      error => send({ id: request.id, ok: false, code: String(error.code ?? "Error"), message: String(error.message), intact: error.intact }));
  }
});
`;

export type FileRequest = { op: 'read'; path: string; max?: number } | { op: 'access'; path: string } | { op: 'mkdir'; path: string } | { op: 'write'; path: string; expected?: string };

/** The operation failed as the owner (`code` is the errno code such as ENOENT, or not_a_file / too_large for a bounded read). */
export class FileOperationError extends Error {
  constructor(readonly code: string, message: string, readonly intact: boolean | undefined) { super(message); }
}
/** The helper ended before answering (killed, out of memory, or never started). */
export class FileHelperGone extends Error {
  constructor(readonly signal: NodeJS.Signals | null, detail: string) { super(`file_helper_gone: the owner's file process ended before answering (${detail}).`); }
}

export const STUCK_MS = 10_000;
const IDLE_MS = 5 * 60_000;

type Pending = { resolve: (bytes: Buffer) => void; reject: (error: Error) => void; started: number };
export class FileHelper {
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private received: Buffer = Buffer.alloc(0);
  private stderr = '';
  private idle: ReturnType<typeof setTimeout> | undefined;
  ended = false;
  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.on('data', (chunk: Buffer) => this.receive(chunk));
    child.stderr.on('data', (chunk: Buffer) => { this.stderr = (this.stderr + chunk.toString()).slice(-2000); });
    child.stdin.on('error', () => {});
    child.on('error', error => this.gone(null, error.message));
    child.on('close', (code, signal) => this.gone(signal, signal ? `killed by ${signal}` : `exited with code ${code}${this.stderr.trim() ? `: ${this.stderr.trim()}` : ''}`));
    this.idleTimer();
  }
  /** Whether a request has waited so long that new ones should go to a fresh helper. */
  stuck(now = Date.now()): boolean {
    for (const p of this.pending.values()) if (now - p.started > STUCK_MS) return true;
    return false;
  }
  request(request: FileRequest, body: Buffer = Buffer.alloc(0)): Promise<Buffer> {
    if (this.ended) return Promise.reject(new FileHelperGone(null, 'it was retired'));
    clearTimeout(this.idle);
    const id = this.nextId++;
    const header = Buffer.from(JSON.stringify({ ...request, id }));
    const head = Buffer.alloc(8);
    head.writeUInt32BE(header.length, 0); head.writeUInt32BE(body.length, 4);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, started: Date.now() });
      this.child.stdin.write(Buffer.concat([head, header]));
      if (body.length) this.child.stdin.write(body);
    });
  }
  /** No new requests; the helper exits once the ones it holds are answered. */
  retire(): void {
    if (this.ended) return;
    this.ended = true;
    clearTimeout(this.idle);
    this.child.stdin.end();
  }
  private idleTimer() { this.idle = setTimeout(() => this.retire(), IDLE_MS); this.idle.unref(); }
  private receive(chunk: Buffer) {
    this.received = this.received.length ? Buffer.concat([this.received, chunk]) : chunk;
    for (;;) {
      if (this.received.length < 8) return;
      const headerLength = this.received.readUInt32BE(0), bodyLength = this.received.readUInt32BE(4);
      if (this.received.length < 8 + headerLength + bodyLength) return;
      const header = JSON.parse(this.received.subarray(8, 8 + headerLength).toString()) as { id: number; ok: boolean; code?: string; message?: string; intact?: boolean };
      const body = Buffer.from(this.received.subarray(8 + headerLength, 8 + headerLength + bodyLength));
      this.received = this.received.subarray(8 + headerLength + bodyLength);
      const waiter = this.pending.get(header.id);
      this.pending.delete(header.id);
      if (header.ok) waiter?.resolve(body);
      else waiter?.reject(new FileOperationError(header.code!, header.message!, header.intact));
      if (!this.pending.size && !this.ended) this.idleTimer();
    }
  }
  private gone(signal: NodeJS.Signals | null, detail: string) {
    this.ended = true;
    clearTimeout(this.idle);
    for (const p of this.pending.values()) p.reject(new FileHelperGone(signal, detail));
    this.pending.clear();
  }
}

/** Starts a helper from an explicit command line; `ownerFiles` is the way in, this is for tests that run it under limits. */
export function startFileHelper(executable: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; uid?: number; gid?: number }): FileHelper {
  return new FileHelper(spawn(executable, args, { ...options, stdio: ['pipe', 'pipe', 'pipe'] }));
}
/** The node command line of a helper with this umask; `startFileHelper(process.execPath, helperArgs(…))` runs one. */
export const helperArgs = (umask: number) => ['--input-type=module', '-e', FILE_HELPER, String(umask)];

export type OwnerFiles = {
  read: (path: string, max?: number) => Promise<Buffer>;
  access: (path: string) => Promise<void>;
  mkdir: (path: string) => Promise<void>;
  write: (path: string, content: Buffer, expected?: string) => Promise<void>;
};

const helpers = new Map<string, FileHelper>();
function launch(placement: ProcessPlacement, person: PersonConfig): FileHelper {
  const args = helperArgs(0o022);
  const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: person.home, USER: person.unixUser, LOGNAME: person.unixUser, LANG: 'C.UTF-8', UV_THREADPOOL_SIZE: '16' };
  switch (placement.kind) {
    case 'channelScope': return startFileHelper('/usr/bin/setpriv', [`--reuid=${person.uid}`, `--regid=${person.gid}`, '--init-groups', '--', process.execPath, ...args], { cwd: person.home, env });
    case 'callerCgroup': return startFileHelper(process.execPath, args, { cwd: person.home, env, uid: person.uid, gid: person.gid });
  }
}
/** File operations as `person`, through their shared helper. */
export function ownerFiles(placement: ProcessPlacement, person: PersonConfig): OwnerFiles {
  const key = `${placement.kind === 'channelScope' ? placement.channel : 'caller'}:${person.uid}:${person.gid}`;
  const helper = () => {
    let current = helpers.get(key);
    if (current && !current.ended && !current.stuck()) return current;
    current?.retire();
    current = launch(placement, person);
    helpers.set(key, current);
    return current;
  };
  return {
    read: (path, max) => helper().request(max === undefined ? { op: 'read', path } : { op: 'read', path, max }),
    access: async path => { await helper().request({ op: 'access', path }); },
    mkdir: async path => { await helper().request({ op: 'mkdir', path }); },
    write: async (path, content, expected) => { await helper().request({ op: 'write', path, expected }, content); },
  };
}
