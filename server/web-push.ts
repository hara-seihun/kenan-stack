// Web Push (RFC 8030 delivery, RFC 8291 aes128gcm payload encryption, RFC 8292 VAPID) for installed web apps, chiefly
// iPhone home-screen apps (iOS 16.4+), whose notifications go through Apple's push service. One VAPID key pair lives
// next to the shared session key, so both channels sign for every subscription; each browser subscribes against it.
import { createCipheriv, createECDH, createPrivateKey, generateKeyPairSync, hkdfSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { closeSync, openSync, readFileSync, writeSync } from 'node:fs';
import type { NotificationLevel, WebPushSubscription } from '../shared/contract.js';

export type PushOutcome =
  | { kind: 'delivered'; status: number }
  | { kind: 'gone'; status: number }                       // 404/410: the subscription no longer exists; drop it
  | { kind: 'rejected'; status: number; reason: string }   // the push service refused this message
  | { kind: 'unreachable'; reason: string };               // no HTTP answer
export interface WebPushSender { kind: 'ready'; publicKey: string; send(subscription: WebPushSubscription, payload: string, options: { ttlSeconds: number; urgency: 'normal' | 'high' }): Promise<PushOutcome> }
export type WebPush = WebPushSender | { kind: 'unavailable'; reason: string };

type Fetch = (url: string, init: { method: 'POST'; headers: Record<string, string>; body: Buffer; signal: AbortSignal }) => Promise<{ status: number; text(): Promise<string> }>;
interface VapidKeys { publicKey: Buffer; privateKey: KeyObject }

const b64url = (bytes: Buffer | Uint8Array) => Buffer.from(bytes).toString('base64url');
const SEND_TIMEOUT_MS = 10_000;
const RECORD_SIZE = 4096;

/** Reads the VAPID key pair at path, creating it once (exclusively, so channels starting together agree on one pair). */
export function loadVapidKeys(path: string): VapidKeys {
  let raw: string;
  try { raw = readFileSync(path, 'utf8'); } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const jwk = pair.publicKey.export({ format: 'jwk' });
    const file = JSON.stringify({ publicKey: b64url(Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x!, 'base64url'), Buffer.from(jwk.y!, 'base64url')])), privateKey: pair.privateKey.export({ format: 'pem', type: 'pkcs8' }) });
    try { const fd = openSync(path, 'wx', 0o600); try { writeSync(fd, file); } finally { closeSync(fd); } } catch (w) { if ((w as NodeJS.ErrnoException).code !== 'EEXIST') throw w; }
    raw = readFileSync(path, 'utf8');
  }
  const parsed = JSON.parse(raw) as { publicKey: string; privateKey: string };
  const publicKey = Buffer.from(parsed.publicKey, 'base64url');
  if (publicKey.length !== 65 || publicKey[0] !== 4) throw new Error(`web_push_key_invalid: ${path} publicKey is not an uncompressed P-256 point`);
  return { publicKey, privateKey: createPrivateKey(parsed.privateKey) };
}

/** RFC 8291 aes128gcm body for one subscriber. salt and ephemeral are fixed only by tests. */
export function encryptPayload(payload: Buffer, subscriber: { p256dh: string; auth: string }, fixed?: { salt: Buffer; ephemeralPrivate: Buffer }): Buffer {
  const uaPublic = Buffer.from(subscriber.p256dh, 'base64url'), authSecret = Buffer.from(subscriber.auth, 'base64url');
  const ephemeral = createECDH('prime256v1');
  if (fixed) ephemeral.setPrivateKey(fixed.ephemeralPrivate); else ephemeral.generateKeys();
  const asPublic = ephemeral.getPublicKey();
  const salt = fixed?.salt ?? randomBytes(16);
  const ikm = Buffer.from(hkdfSync('sha256', ephemeral.computeSecret(uaPublic), authSecret, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]), 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const sealed = Buffer.concat([cipher.update(Buffer.concat([payload, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21); salt.copy(header, 0); header.writeUInt32BE(RECORD_SIZE, 16); header[20] = asPublic.length;
  return Buffer.concat([header, asPublic, sealed]);
}

function vapidAuthorization(keys: VapidKeys, endpoint: string, subject: string, nowMs: number): string {
  const head = b64url(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64url(Buffer.from(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(nowMs / 1000) + 12 * 3600, sub: subject })));
  const signature = sign('sha256', Buffer.from(`${head}.${claims}`), { key: keys.privateKey, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${head}.${claims}.${b64url(signature)}, k=${b64url(keys.publicKey)}`;
}

/** The sender for this host: subject is the contact URL push services see (Apple requires https: or mailto:). */
export function createWebPush(keys: VapidKeys, subject: string, fetchImpl: Fetch = fetch as unknown as Fetch, now: () => number = Date.now): WebPushSender {
  return {
    kind: 'ready', publicKey: b64url(keys.publicKey),
    async send(subscription, payload, { ttlSeconds, urgency }) {
      const body = encryptPayload(Buffer.from(payload), subscription.keys);
      let response: { status: number; text(): Promise<string> };
      try {
        response = await fetchImpl(subscription.endpoint, {
          method: 'POST', body, signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
          headers: { authorization: vapidAuthorization(keys, subscription.endpoint, subject, now()), 'content-encoding': 'aes128gcm', 'content-type': 'application/octet-stream', ttl: String(ttlSeconds), urgency },
        });
      } catch (e) { return { kind: 'unreachable', reason: String((e as Error)?.message ?? e) }; }
      if (response.status >= 200 && response.status < 300) return { kind: 'delivered', status: response.status };
      if (response.status === 404 || response.status === 410) return { kind: 'gone', status: response.status };
      return { kind: 'rejected', status: response.status, reason: (await response.text().catch(() => '')).slice(0, 500) };
    },
  };
}

/** The host's Web Push route: unavailable (typed, with the reason) when no https origin can serve as the VAPID subject. */
export function webPushFor(keyPath: string, origins: readonly string[]): WebPush {
  const subject = origins.find(origin => origin.startsWith('https://'));
  if (!subject) return { kind: 'unavailable', reason: 'no https origin configured to name as the VAPID subject' };
  return createWebPush(loadVapidKeys(keyPath), subject);
}

/** What the service worker receives: what to show and the conversation to open (null: the app's start). id null: not a stored notification. */
export interface PushMessage { id: number | null; title: string; body: string; level: NotificationLevel; conversationId: string | null }
export const pushPayload = (m: PushMessage): string => JSON.stringify({ id: m.id, title: m.title, body: m.body, level: m.level, conversationId: m.conversationId });
export const pushOptions = (level: NotificationLevel) => ({ ttlSeconds: 24 * 3600, urgency: level === 'urgent' ? 'high' as const : 'normal' as const });

/** Parses a browser PushSubscription.toJSON() body; endpoint must be https and keys a P-256 point plus a 16-byte secret. */
export function parseSubscription(raw: unknown): { ok: true; value: WebPushSubscription } | { ok: false; error: string } {
  const r = raw as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } } | null;
  if (!r || typeof r !== 'object') return { ok: false, error: 'subscription must be a JSON object' };
  if (typeof r.endpoint !== 'string' || r.endpoint.length > 2048 || !/^https:\/\/[^\s/]+\//.test(r.endpoint)) return { ok: false, error: 'endpoint must be an https URL' };
  const keys = r.keys;
  if (!keys || typeof keys.p256dh !== 'string' || typeof keys.auth !== 'string') return { ok: false, error: 'keys.p256dh and keys.auth are required' };
  const point = Buffer.from(keys.p256dh, 'base64url'), auth = Buffer.from(keys.auth, 'base64url');
  if (point.length !== 65 || point[0] !== 4) return { ok: false, error: 'keys.p256dh must be an uncompressed P-256 point' };
  if (auth.length !== 16) return { ok: false, error: 'keys.auth must be 16 bytes' };
  return { ok: true, value: { endpoint: r.endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } } };
}
