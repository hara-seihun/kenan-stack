// Files live under <dataDir>/files/<random id>; metadata in the `file` table. People see the files they own and the
// files shown in conversations they are members of (`conversation_file`).
import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { getMimeType, mimes } from 'hono/utils/mime';
import type { FileInfo, MessagePart } from '../../shared/contract.js';
import { textMime } from '../../shared/textFile.js';
import type { PersonConfig } from '../config.js';
import type { Deps, StoredFile } from '../types.js';
import { fail } from '../db/errors.js';
import type { ProcessPlacement } from '../tools/owner.js';
import { FileOperationError, ownerFiles } from '../tools/file-helper.js';

export const fileUrl = (id: string) => `/api/files/${id}`;

/** Types every browser and the Android WebView draw in an <img>; other images are files to download. */
const INLINE_IMAGES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml', 'image/avif', 'image/bmp']);
const baseMime = (mime: string) => mime.split(';', 1)[0]!.trim().toLowerCase();
export const inlineImage = (mime: string) => INLINE_IMAGES.has(baseMime(mime));
/** Hono's table lacks these common audio and video extensions; without them an attached recording would be an untyped download. */
const MIMES: Record<string, string> = { ...mimes, wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', flac: 'audio/flac', mov: 'video/quicktime', m4v: 'video/mp4' };
/** Text files by name first (Markdown as text/markdown, code as text/plain rather than Hono's video/mp2t for .ts). */
export const mimeOf = (name: string): string | undefined => textMime(name) ?? getMimeType(name, MIMES);
/** Documents that could run script if opened at the app's origin are served sandboxed. */
const ACTIVE = new Set(['image/svg+xml', 'text/html', 'application/xhtml+xml', 'application/xml', 'text/xml']);
const HTML = new Set(['text/html', 'application/xhtml+xml']);
export const htmlFile = (mime: string) => HTML.has(baseMime(mime));
/** An active document opened as itself: no scripts, nothing fetched but inline images. */
const INERT = "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:";
/** An HTML file in the app's viewer (Dave 2026-10-23, like Claude's artifacts): its scripts run, but in an opaque origin
 * (no allow-same-origin), so it never reaches the app's cookies, storage or API; no top navigation; links may open new
 * tabs; it may load scripts, styles, fonts and media from https CDNs but connects nowhere. */
const VIEWER = "sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox allow-forms allow-modals; default-src 'none'; "
  + "script-src 'unsafe-inline' 'unsafe-eval' https: data: blob:; style-src 'unsafe-inline' https: data:; img-src https: data: blob:; "
  + "font-src https: data:; media-src https: data: blob:; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'";

/** How a file is served: `inline` opens it as itself, `download` saves it, `view` is an HTML file for the app's viewer. */
export type FileMode = 'inline' | 'download' | 'view';

/** Appended to an HTML page in the viewer: a link to another page opens a new browsing context (a browser tab, or the
 * default browser from a home-screen or Dock app) instead of loading inside the frame, where most sites refuse to be
 * framed (Dave 2026-10-23: shop links in a report did nothing). Links within the page (#section) stay in it. It
 * runs at window capture, before the page's own handlers, and only sets the target, so those still decide. Appended
 * rather than prepended, so the page's doctype and its <meta charset> within the first 1024 bytes are untouched. */
const LINKS = '<script>addEventListener("click",function(e){var a=e.target instanceof Element&&e.target.closest("a[href]");'
  + 'if(!a||a.hasAttribute("download"))return;var u=new URL(a.getAttribute("href"),document.baseURI),h=location.href.split("#")[0];'
  + 'if(!/^https?:$/.test(u.protocol)||u.href.split("#")[0]===h)return;var t=a.getAttribute("target");'
  + 'if(!t||/^_(self|top|parent)$/i.test(t)){a.setAttribute("target","_blank");a.setAttribute("rel","noopener noreferrer")}},true)</script>';

/** The viewer's bytes for an HTML file: the page with LINKS appended. XHTML would stop being well-formed XML and UTF-16
 * would garble, so those are served as they are, with the frame's own behaviour for links. */
export const viewerPage = (mime: string, bytes: Buffer): Buffer =>
  baseMime(mime) !== 'text/html' || (bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff)
    ? bytes : Buffer.concat([bytes, Buffer.from(LINKS)]);

export async function saveFile(deps: Deps, ownerId: string, name: string, mime: string, bytes: Buffer): Promise<FileInfo> {
  const dir = join(deps.config.dataDir, 'files');
  await mkdir(dir, { recursive: true });
  const path = join(dir, randomUUID());
  await writeFile(path, bytes);
  const { id } = await deps.store.createFile({ ownerId, name, mime, size: bytes.length, path });
  return { id, name, mime, size: bytes.length, url: fileUrl(id) };
}

export const saveUpload = async (deps: Deps, ownerId: string, file: File): Promise<FileInfo> =>
  saveFile(deps, ownerId, file.name || 'file', uploadMime(file.name, file.type), Buffer.from(await file.arrayBuffer()));

/** A browser's type for an upload, except where the name says it is text (browsers send .md as '' or
 * application/octet-stream and .ts as video/mp2t). */
export const uploadMime = (name: string, type: string): string =>
  textMime(name) ?? (type && type !== 'application/octet-stream' ? type : mimeOf(name) ?? 'application/octet-stream');

/** The byte span a `Range` header asks for. A single range is served partially (audio and video seek with these);
 * anything else (none, several ranges, another unit) is served whole, as RFC 9110 lets a server ignore Range. */
export type ByteRange = { kind: 'whole' } | { kind: 'part'; start: number; end: number } | { kind: 'unsatisfiable' };

export function byteRange(header: string | undefined, size: number): ByteRange {
  const match = header?.match(/^bytes=(\d*)-(\d*)$/);
  if (!match || (match[1] === '' && match[2] === '')) return { kind: 'whole' };
  const [, from, to] = match as unknown as [string, string, string];
  if (from === '') {
    const suffix = Number(to);
    return suffix === 0 || size === 0 ? { kind: 'unsatisfiable' } : { kind: 'part', start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(from);
  if (start >= size) return { kind: 'unsatisfiable' };
  const end = to === '' ? size - 1 : Math.min(Number(to), size - 1);
  return end < start ? { kind: 'unsatisfiable' } : { kind: 'part', start, end };
}

/** Serves a file the person may see, in part when asked with `Range` (the viewer's page is always whole); `download` asks the browser (or the Android app) to save it instead of opening it. */
export async function fileResponse(deps: Deps, personId: string, id: string, mode: FileMode, range: string | undefined): Promise<Response> {
  const f = await deps.store.visibleFile(personId, id) ?? fail('not_found', 'File not found');
  if (mode === 'view' && !htmlFile(f.mime)) fail('invalid_input', `view is for HTML files; this one is ${f.mime}`);
  if (mode === 'view') {
    const page = viewerPage(f.mime, await readFile(f.path).catch(() => fail('not_found', 'File content missing')));
    return new Response(new Uint8Array(page), { headers: {
      'content-type': f.mime, 'content-length': String(page.length), 'cache-control': 'private, no-cache',
      'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(f.name)}`, 'x-content-type-options': 'nosniff',
      'content-security-policy': VIEWER, 'referrer-policy': 'no-referrer',
    } });
  }
  const size = await stat(f.path).then(s => s.size, () => fail('not_found', 'File content missing'));
  const headers: Record<string, string> = {
    'content-type': f.mime, 'accept-ranges': 'bytes', 'cache-control': 'private, max-age=31536000, immutable',
    'content-disposition': `${mode === 'download' ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(f.name)}`,
    'x-content-type-options': 'nosniff',
    ...(ACTIVE.has(baseMime(f.mime)) ? { 'content-security-policy': INERT } : {}),
  };
  const span = byteRange(range, size);
  switch (span.kind) {
    case 'unsatisfiable': return new Response(null, { status: 416, headers: { ...headers, 'content-range': `bytes */${size}` } });
    case 'whole': return new Response(Readable.toWeb(createReadStream(f.path)) as ReadableStream, { headers: { ...headers, 'content-length': String(size) } });
    case 'part': return new Response(Readable.toWeb(createReadStream(f.path, { start: span.start, end: span.end })) as ReadableStream, { status: 206, headers: {
      ...headers, 'content-length': String(span.end - span.start + 1), 'content-range': `bytes ${span.start}-${span.end}/${size}`,
    } });
  }
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

type Read = { ok: true; path: string; bytes: Buffer } | { ok: false; failure: Extract<AttachError, { code: 'attach_unreadable' }>['failures'][number] };

/** Reads as the person, refusing anything that is not a regular file or exceeds the limit. */
async function readAsOwner(placement: ProcessPlacement, person: PersonConfig, path: string): Promise<Read> {
  try { return { ok: true, path, bytes: await ownerFiles(placement, person).read(path, ATTACH_LIMITS.fileBytes) }; }
  catch (error) {
    if (!(error instanceof FileOperationError)) return { ok: false, failure: { path, reason: 'read_failed', detail: error instanceof Error ? error.message : String(error) } };
    const reason = error.code === 'ENOENT' ? 'not_found' : error.code === 'EACCES' || error.code === 'EPERM' ? 'permission_denied' : error.code === 'not_a_file' || error.code === 'too_large' ? error.code : 'read_failed';
    return { ok: false, failure: { path, reason, detail: error.message } };
  }
}

/**
 * Copies files the person's account can read into the file store, owned by the person. All or nothing: any unreadable
 * path stores none. Relative paths and ~ resolve against the person's home.
 */
export async function storeOwnerFiles(deps: Deps, placement: ProcessPlacement, person: PersonConfig, paths: string[]): Promise<{ ok: true; files: FileInfo[] } | { ok: false; error: AttachError }> {
  const read = await readOwnerFiles(placement, person, paths);
  if (!read.ok) return read;
  return { ok: true, files: await Promise.all(read.files.map(f => saveFile(deps, person.id, f.name, f.mime, f.bytes))) };
}

/** Reads files the person's account can read, within the attach limits; all or nothing. */
export async function readOwnerFiles(placement: ProcessPlacement, person: PersonConfig, paths: string[]): Promise<{ ok: true; files: { name: string; mime: string; bytes: Buffer }[] } | { ok: false; error: AttachError }> {
  if (!paths.length) return { ok: false, error: { code: 'attach_no_files' } };
  if (paths.length > ATTACH_LIMITS.files) return { ok: false, error: { code: 'attach_too_many', count: paths.length } };
  const absolute = paths.map(p => resolve(person.home, p.replace(/^~(?=\/|$)/, person.home)));
  const reads = await Promise.all(absolute.map(p => readAsOwner(placement, person, p)));
  const failures = reads.flatMap(r => r.ok ? [] : [r.failure]);
  if (failures.length) return { ok: false, error: { code: 'attach_unreadable', failures } };
  const ok = reads as Extract<Read, { ok: true }>[];
  const total = ok.reduce((n, r) => n + r.bytes.length, 0);
  if (total > ATTACH_LIMITS.totalBytes) return { ok: false, error: { code: 'attach_too_large_total', bytes: total } };
  return { ok: true, files: ok.map(r => ({ name: basename(r.path), mime: mimeOf(r.path) ?? 'application/octet-stream', bytes: r.bytes })) };
}
