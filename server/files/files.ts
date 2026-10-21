// Files live under <dataDir>/files/<random id>; metadata in the `file` table. People see the files they own and the
// files shown in conversations they are members of (`conversation_file`).
import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { getMimeType } from 'hono/utils/mime';
import type { FileInfo, MessagePart } from '../../shared/contract.js';
import type { PersonConfig } from '../config.js';
import type { Deps, StoredFile } from '../types.js';
import { fail } from '../db/errors.js';
import { ownerProcess, type ProcessPlacement } from '../tools/owner.js';

export const fileUrl = (id: string) => `/api/files/${id}`;

/** Types every browser and the Android WebView draw in an <img>; other images are files to download. */
const INLINE_IMAGES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml', 'image/avif', 'image/bmp']);
const baseMime = (mime: string) => mime.split(';', 1)[0]!.trim().toLowerCase();
export const inlineImage = (mime: string) => INLINE_IMAGES.has(baseMime(mime));
/** Documents that could run script if opened at the app's origin are served sandboxed. */
const ACTIVE = new Set(['image/svg+xml', 'text/html', 'application/xhtml+xml', 'application/xml', 'text/xml']);

export async function saveFile(deps: Deps, ownerId: string, name: string, mime: string, bytes: Buffer): Promise<FileInfo> {
  const dir = join(deps.config.dataDir, 'files');
  await mkdir(dir, { recursive: true });
  const path = join(dir, randomUUID());
  await writeFile(path, bytes);
  const { id } = await deps.store.createFile({ ownerId, name, mime, size: bytes.length, path });
  return { id, name, mime, size: bytes.length, url: fileUrl(id) };
}

export const saveUpload = async (deps: Deps, ownerId: string, file: File): Promise<FileInfo> =>
  saveFile(deps, ownerId, file.name || 'file', file.type || 'application/octet-stream', Buffer.from(await file.arrayBuffer()));

/** Serves a file the person may see; `download` asks the browser (or the Android app) to save it instead of opening it. */
export async function fileResponse(deps: Deps, personId: string, id: string, download: boolean): Promise<Response> {
  const f = await deps.store.visibleFile(personId, id) ?? fail('not_found', 'File not found');
  const size = await stat(f.path).then(s => s.size, () => fail('not_found', 'File content missing'));
  const body = Readable.toWeb(createReadStream(f.path)) as ReadableStream;
  return new Response(body, { headers: {
    'content-type': f.mime, 'content-length': String(size), 'cache-control': 'private, max-age=31536000, immutable',
    'content-disposition': `${download ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(f.name)}`,
    'x-content-type-options': 'nosniff',
    ...(ACTIVE.has(baseMime(f.mime)) ? { 'content-security-policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:" } : {}),
  } });
}

export const filePart = (f: Pick<StoredFile, 'id' | 'name' | 'mime' | 'size'>): MessagePart =>
  inlineImage(f.mime) ? { type: 'image', fileId: f.id, mime: f.mime } : { type: 'file', fileId: f.id, name: f.name, mime: f.mime, size: f.size };

/** Message parts for files the sender uploaded (images drawn inline, everything else as a file part). */
export async function fileParts(deps: Deps, ownerId: string, fileIds: string[]): Promise<MessagePart[]> {
  const files = await Promise.all(fileIds.map(id => deps.store.getFile(id)));
  return files.map((f, i) => !f || f.ownerId !== ownerId ? fail('invalid_input', `Unknown file ${fileIds[i]}`) : filePart(f));
}

export const ATTACH_LIMITS = { files: 10, fileBytes: 50 * 1024 * 1024, totalBytes: 100 * 1024 * 1024 } as const;

export type AttachError =
  | { code: 'attach_no_files' }
  | { code: 'attach_too_many'; count: number }
  | { code: 'attach_too_large_total'; bytes: number }
  | { code: 'attach_unreadable'; failures: { path: string; reason: 'not_found' | 'permission_denied' | 'not_a_file' | 'too_large' | 'read_failed'; detail: string }[] };

export const attachErrorText = (e: AttachError): string => {
  switch (e.code) {
    case 'attach_no_files': return 'attach_no_files: give at least one path';
    case 'attach_too_many': return `attach_too_many: ${e.count} paths; at most ${ATTACH_LIMITS.files} files per message`;
    case 'attach_too_large_total': return `attach_too_large_total: ${e.bytes} bytes; at most ${ATTACH_LIMITS.totalBytes} bytes per message`;
    case 'attach_unreadable': return `attach_unreadable: nothing was sent.\n${e.failures.map(f => `${f.path}: ${f.reason} (${f.detail})`).join('\n')}`;
  }
};

// Runs as the person: stat, then read, refusing anything that is not a regular file or exceeds the limit.
const READ_AS_OWNER = `import fs from "node:fs/promises";
const [path, max] = [process.argv[1], Number(process.argv[2])];
const out = (code, detail) => { process.stdout.write(code + " " + detail); process.exit(3); };
try {
  const s = await fs.stat(path);
  if (!s.isFile()) out("not_a_file", s.isDirectory() ? "directory" : "not a regular file");
  if (s.size > max) out("too_large", s.size + " bytes, limit " + max);
  const bytes = await fs.readFile(path);
  if (bytes.length > max) out("too_large", bytes.length + " bytes, limit " + max);
  process.stdout.write(bytes);
} catch (e) { out(e.code === "ENOENT" ? "not_found" : e.code === "EACCES" || e.code === "EPERM" ? "permission_denied" : "read_failed", String(e.message)); }`;

type Read = { ok: true; path: string; bytes: Buffer } | { ok: false; failure: Extract<AttachError, { code: 'attach_unreadable' }>['failures'][number] };

async function readAsOwner(placement: ProcessPlacement, person: PersonConfig, path: string): Promise<Read> {
  const result = await ownerProcess(placement, person, process.execPath, ['--no-warnings', '--input-type=module', '-e', READ_AS_OWNER, path, String(ATTACH_LIMITS.fileBytes)]);
  if (result.exitCode === 0) return { ok: true, path, bytes: result.output };
  const text = result.output.toString();
  const match = /^(not_found|permission_denied|not_a_file|too_large|read_failed) ([\s\S]*)$/.exec(text);
  return { ok: false, failure: match ? { path, reason: match[1] as 'not_found', detail: match[2]! } : { path, reason: 'read_failed', detail: text.trim() || `exit ${result.exitCode}` } };
}

/**
 * Copies files the person's account can read into the file store, owned by the person. All or nothing: any unreadable
 * path stores none. Relative paths and ~ resolve against the person's home.
 */
export async function storeOwnerFiles(deps: Deps, placement: ProcessPlacement, person: PersonConfig, paths: string[]): Promise<{ ok: true; files: FileInfo[] } | { ok: false; error: AttachError }> {
  if (!paths.length) return { ok: false, error: { code: 'attach_no_files' } };
  if (paths.length > ATTACH_LIMITS.files) return { ok: false, error: { code: 'attach_too_many', count: paths.length } };
  const absolute = paths.map(p => resolve(person.home, p.replace(/^~(?=\/|$)/, person.home)));
  const reads = await Promise.all(absolute.map(p => readAsOwner(placement, person, p)));
  const failures = reads.flatMap(r => r.ok ? [] : [r.failure]);
  if (failures.length) return { ok: false, error: { code: 'attach_unreadable', failures } };
  const ok = reads as Extract<Read, { ok: true }>[];
  const total = ok.reduce((n, r) => n + r.bytes.length, 0);
  if (total > ATTACH_LIMITS.totalBytes) return { ok: false, error: { code: 'attach_too_large_total', bytes: total } };
  const files = await Promise.all(ok.map(r => saveFile(deps, person.id, basename(r.path), getMimeType(r.path) ?? 'application/octet-stream', r.bytes)));
  return { ok: true, files };
}
