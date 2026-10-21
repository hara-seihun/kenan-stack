// Login against the existing per-account scrypt verifier files, DB-backed sessions,
// HMAC-signed `kenan_session` cookie, and the contract's CSRF rule.
import { createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ServerConfig } from '../config.js';
import type { Session } from '../db/store.js';
import { fail } from '../db/errors.js';

export const SESSION_COOKIE = 'kenan_session';
export const SESSION_TTL_MS = 30 * 24 * 3600_000;
/** A session in use is extended to a full SESSION_TTL_MS at most once per this interval, so only a month of disuse signs out. */
export const SESSION_RENEW_MS = 24 * 3600_000;

export interface SessionStore {
  createSession(s: Session): Promise<void>;
  getSession(id: string): Promise<Session | null>;
  deleteSession(id: string): Promise<void>;
  extendSession(id: string, expiresAt: number): Promise<void>;
}
export interface Auth {
  /** Verify the secret and create a session. Returns the cookie token. Throws `unauthenticated`. */
  login(accountId: string, secret: string): Promise<{ personId: string; token: string; expiresAt: number }>;
  /** The person for a cookie token, or null; `renewed` when this use extended the session (the cookie is set again). */
  authenticate(token: string | undefined): Promise<{ personId: string; renewed: boolean; expiresAt: number } | null>;
  logout(token: string | undefined): Promise<void>;
}

const ACCOUNT_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const HEX64 = /^[a-f0-9]{64}$/;

const scryptHex = (secret: string, salt: string) => new Promise<string>((resolve, reject) =>
  scrypt(secret, salt, 32, (e, key) => e ? reject(e) : resolve(key.toString('hex'))));
const equal = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** Verifier file `<verifierDir>/<accountId>.json` = {version:1, salt, digest}; digest = scrypt(secret, salt, 32) as hex. */
export async function verifySecret(verifierDir: string, accountId: string, secret: string): Promise<boolean> {
  if (!ACCOUNT_ID.test(accountId) || typeof secret !== 'string' || !secret.length || secret.length > 1024) return false;
  let v: { version?: unknown; salt?: unknown; digest?: unknown };
  try { v = JSON.parse(await readFile(join(verifierDir, `${accountId}.json`), 'utf8')); } catch { return false; }
  if (v.version !== 1 || typeof v.salt !== 'string' || !HEX64.test(v.salt) || typeof v.digest !== 'string' || !HEX64.test(v.digest)) return false;
  return equal(await scryptHex(secret, v.salt), v.digest);
}

/** Non-GET requests need an allowed Origin or `x-kenan-client: native`. */
export function csrfAllowed(method: string, origin: string | undefined, client: string | undefined, origins: string[]): boolean {
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return true;
  return client === 'native' || (origin !== undefined && origins.includes(origin));
}

export function createAuth(opts: { config: Pick<ServerConfig, 'verifierDir' | 'sessionKeyPath' | 'people'>; sessions: SessionStore; now: () => number; key?: Buffer }): Auth {
  const key = opts.key ?? readFileSync(opts.config.sessionKeyPath);
  if (key.length < 32) throw new Error(`Session key ${opts.config.sessionKeyPath} must be at least 32 bytes`);
  const sign = (id: string) => createHmac('sha256', key).update(id).digest('base64url');
  // Sessions are looked up on every request; one process per channel, so an in-memory cache is coherent.
  const cache = new Map<string, Session>();

  const idFromToken = (token: string | undefined): string | null => {
    if (!token || token.length > 256) return null;
    const dot = token.indexOf('.');
    if (dot <= 0) return null;
    const id = token.slice(0, dot);
    return equal(token.slice(dot + 1), sign(id)) ? id : null;
  };

  return {
    async login(accountId, secret) {
      const known = opts.config.people.some(p => p.id === accountId);
      if (!known || !(await verifySecret(opts.config.verifierDir, accountId, secret))) fail('unauthenticated', 'Login rejected');
      const session = { id: randomBytes(24).toString('base64url'), personId: accountId, expiresAt: opts.now() + SESSION_TTL_MS };
      await opts.sessions.createSession(session);
      cache.set(session.id, session);
      return { personId: accountId, token: `${session.id}.${sign(session.id)}`, expiresAt: session.expiresAt };
    },
    async authenticate(token) {
      const id = idFromToken(token);
      if (!id) return null;
      let s = cache.get(id) ?? null;
      if (!s) { s = await opts.sessions.getSession(id); if (s) cache.set(id, s); }
      if (!s) return null;
      const now = opts.now();
      if (s.expiresAt <= now) { cache.delete(id); return null; }
      if (s.expiresAt - now > SESSION_TTL_MS - SESSION_RENEW_MS) return { personId: s.personId, renewed: false, expiresAt: s.expiresAt };
      const renewed = { ...s, expiresAt: now + SESSION_TTL_MS };
      await opts.sessions.extendSession(id, renewed.expiresAt);
      cache.set(id, renewed);
      return { personId: s.personId, renewed: true, expiresAt: renewed.expiresAt };
    },
    async logout(token) {
      const id = idFromToken(token);
      if (!id) return;
      cache.delete(id);
      await opts.sessions.deleteSession(id);
    },
  };
}
