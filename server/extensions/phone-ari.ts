// Asterisk's REST interface (ARI): the phone leg of every call. Asterisk holds the SIP side with the line's carrier
// (deploy/asterisk/configure.py) on the host where the call bridges run, so a bridge exchanges µ-law RTP with it on
// 127.0.0.1. ARI's url is the same for the server and the bridge: 127.0.0.1 on assistant-host, the mesh address on the edge.
import { readFileSync } from 'node:fs';
import WebSocket from 'ws';

export type AriConfig = { url: string; user: string; password: string };
export type AriChannel = { id: string; name: string; state: string; caller?: { number?: string }; dialplan?: { exten?: string }; channelvars?: Record<string, string> };
export type AriEvent = { type: string; application?: string; channel?: AriChannel; args?: string[]; cause?: number; cause_txt?: string; digit?: string; [key: string]: unknown };

export function ariConfig(path: string): AriConfig {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  if ((['url', 'user', 'password'] as const).some(k => typeof raw[k] !== 'string' || !raw[k])) throw new Error(`${path} must hold {url, user, password}`);
  return { url: raw.url as string, user: raw.user as string, password: raw.password as string };
}

export class AriError extends Error {
  constructor(message: string, readonly status: number | null) { super(message); }
}

export async function ari<T>(config: AriConfig, method: 'GET' | 'POST' | 'DELETE' | 'PUT', path: string, query: Record<string, string | number | undefined> = {}, body?: unknown): Promise<T> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) if (value !== undefined) params.set(key, String(value));
  const url = `${config.url}/ari${path}${params.size ? `?${params}` : ''}`;
  let response: Response;
  try {
    response = await fetch(url, { method, headers: { authorization: `Basic ${Buffer.from(`${config.user}:${config.password}`).toString('base64')}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
  } catch (e) {
    throw new AriError(`Asterisk ${method} ${path}: ${String((e as Error).cause ?? e)}`, null);
  }
  const text = await response.text();
  if (!response.ok) throw new AriError(`Asterisk ${method} ${path} HTTP ${response.status}: ${text.slice(0, 300)}`, response.status);
  return (text ? JSON.parse(text) : undefined) as T;
}

/** A Stasis application's event stream. `opened` settles once Asterisk has registered the application. */
export function ariEvents(config: AriConfig, app: string, onEvent: (event: AriEvent) => void, onClose: (why: string) => void): { opened: Promise<void>; close: () => void } {
  const url = `${config.url.replace(/^http/, 'ws')}/ari/events?app=${encodeURIComponent(app)}&subscribeAll=false&api_key=${encodeURIComponent(`${config.user}:${config.password}`)}`;
  const socket = new WebSocket(url);
  let closing = false;
  const opened = new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', e => reject(new AriError(`Asterisk events for ${app}: ${String(e)}`, null)));
  });
  socket.on('message', data => {
    let event: AriEvent;
    try { event = JSON.parse(String(data)) as AriEvent; } catch { return; }
    onEvent(event);
  });
  socket.on('close', (code, reason) => { if (!closing) onClose(`closed ${code} ${String(reason)}`); });
  socket.on('error', () => {});
  return { opened, close: () => { closing = true; socket.close(); } };
}

/** The dial string for an E.164 number through a line's trunk: NANP as 1NXXNXXXXXX, elsewhere 011 + digits. */
export function dialString(e164: string, endpoint: string): string {
  const digits = e164.replace(/^\+/, '');
  return `PJSIP/${e164.startsWith('+1') ? digits : `011${digits}`}@${endpoint}`;
}
/** The Asterisk endpoint of the line whose DID is `fromNumber`. */
export const lineEndpoint = (fromNumber: string) => `line-${fromNumber.replace(/^\+/, '')}`;
/** The caller id a carrier gives an inbound call (+E.164, 10 or 11 NANP digits, or 011…) as E.164; null when withheld or unparseable. */
export function callerE164(raw: string | undefined): string | null {
  const digits = (raw ?? '').replace(/[^\d]/g, '');
  if (/^1[2-9]\d{9}$/.test(digits)) return `+${digits}`;
  if (/^[2-9]\d{9}$/.test(digits)) return `+1${digits}`;
  if (/^011[1-9]\d{6,14}$/.test(digits)) return `+${digits.slice(3)}`;
  return null;
}

// G.711 µ-law, the line codec. Encode/decode tables per ITU-T G.711.
const BIAS = 0x84, CLIP = 32635;
const DECODE = new Int16Array(256);
for (let i = 0; i < 256; i++) {
  const u = ~i & 0xff, sign = u & 0x80, exponent = (u >> 4) & 0x07, mantissa = u & 0x0f;
  const magnitude = (((mantissa << 3) + BIAS) << exponent) - BIAS;
  DECODE[i] = sign ? -magnitude : magnitude;
}
export function ulawDecode(bytes: Uint8Array): Int16Array {
  const out = new Int16Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) out[i] = DECODE[bytes[i]!]!;
  return out;
}
export function ulawEncode(samples: Int16Array): Buffer {
  const out = Buffer.alloc(samples.length);
  for (let i = 0; i < samples.length; i++) {
    let sample = samples[i]!;
    const sign = sample < 0 ? 0x80 : 0;
    if (sign) sample = -sample;
    if (sample > CLIP) sample = CLIP;
    sample += BIAS;
    let exponent = 7;
    for (let mask = 0x4000; (sample & mask) === 0 && exponent > 0; mask >>= 1) exponent--;
    const mantissa = (sample >> (exponent + 3)) & 0x0f;
    out[i] = ~(sign | (exponent << 4) | mantissa) & 0xff;
  }
  return out;
}
