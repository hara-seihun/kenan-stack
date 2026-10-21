// Content-encoding for API JSON and the event stream. Static assets are precompressed at build time;
// everything else the app downloads is JSON, which shrinks 5–10× and is what a phone on a slow link waits for.
import { promisify } from 'node:util';
import { brotliCompress, constants, createBrotliCompress, createGzip, gzip, type BrotliCompress, type Gzip } from 'node:zlib';
import type { MiddlewareHandler } from 'hono';

export type Encoding = 'br' | 'gzip' | 'identity';
const MIN_BYTES = 1024;
const brotli = promisify(brotliCompress), gz = promisify(gzip);

/** The client's best supported encoding; a `;q=0` entry refuses that encoding. */
export function chooseEncoding(accept: string | undefined): Encoding {
  const offered = new Set((accept ?? '').split(',').map(entry => entry.trim().toLowerCase())
    .filter(entry => !/;\s*q=0(?:\.0*)?$/.test(entry)).map(entry => entry.split(';')[0]!.trim()));
  return offered.has('br') ? 'br' : offered.has('gzip') ? 'gzip' : 'identity';
}

/** Compresses JSON responses of at least 1 KiB. Streams (SSE) and precompressed static files pass untouched. */
export function compressJson(): MiddlewareHandler {
  return async (c, next) => {
    await next();
    const res = c.res;
    if (!res.body || res.headers.has('content-encoding') || !res.headers.get('content-type')?.startsWith('application/json')) return;
    const encoding = chooseEncoding(c.req.header('accept-encoding'));
    if (encoding === 'identity') return;
    const body = Buffer.from(await res.arrayBuffer());
    const headers = new Headers(res.headers);
    headers.append('vary', 'Accept-Encoding');
    // Assigning over an existing response merges its headers; clear it so the encoded length stands alone.
    c.res = undefined;
    if (body.length < MIN_BYTES) { c.res = new Response(body, { status: res.status, headers }); return; }
    const encoded = encoding === 'br'
      ? await brotli(body, { params: { [constants.BROTLI_PARAM_QUALITY]: 5, [constants.BROTLI_PARAM_SIZE_HINT]: body.length } })
      : await gz(body, { level: 6 });
    headers.set('content-encoding', encoding);
    headers.set('content-length', String(encoded.length));
    c.res = new Response(encoded, { status: res.status, headers });
  };
}

/** A compressor for a long-lived stream: every write is flushed at once so events are never held back. */
export interface StreamEncoder { write(text: string): void; end(): void; readable: ReadableStream<Uint8Array> }

/** `cancelled` runs when the reader goes away (the client disconnected). */
export function streamEncoder(encoding: Encoding, cancelled: () => void): StreamEncoder {
  if (encoding === 'identity') {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const encoder = new TextEncoder();
    let open = true;
    const readable = new ReadableStream<Uint8Array>({ start(c) { controller = c; }, cancel() { open = false; cancelled(); } });
    return {
      readable,
      write(text) { if (open) controller.enqueue(encoder.encode(text)); },
      end() { if (open) { open = false; controller.close(); } },
    };
  }
  const zip: BrotliCompress | Gzip = encoding === 'br'
    ? createBrotliCompress({ params: { [constants.BROTLI_PARAM_QUALITY]: 5, [constants.BROTLI_PARAM_LGWIN]: 18 } })
    : createGzip({ level: 6 });
  const flushKind = encoding === 'br' ? constants.BROTLI_OPERATION_FLUSH : constants.Z_SYNC_FLUSH;
  let open = true;
  const readable = new ReadableStream<Uint8Array>({
    start(controller) {
      zip.on('data', (chunk: Buffer) => { try { controller.enqueue(new Uint8Array(chunk)); } catch { /* reader gone */ } });
      zip.on('end', () => { try { controller.close(); } catch { /* already closed */ } });
      zip.on('error', error => { try { controller.error(error); } catch { /* already closed */ } });
    },
    cancel() { open = false; zip.destroy(); cancelled(); },
  });
  return {
    readable,
    write(text) { if (!open) return; zip.write(text); zip.flush(flushKind); },
    end() { if (open) { open = false; zip.end(); } },
  };
}
