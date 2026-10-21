import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { scryptSync } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createAuth, SESSION_RENEW_MS, SESSION_TTL_MS } from './auth.js';
import type { Session } from '../db/store.js';

it('keeps a session in use alive: renewed to a full term at most once a day, ended only after a month unused', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kenan-auth-'));
  const salt = 'a'.repeat(64), secret = 'correct horse battery staple';
  writeFileSync(join(dir, 'alice.json'), JSON.stringify({ version: 1, salt, digest: scryptSync(secret, salt, 32).toString('hex') }));
  const rows = new Map<string, Session>();
  const sessions = {
    createSession: async (s: Session) => { rows.set(s.id, s); },
    getSession: async (id: string) => rows.get(id) ?? null,
    deleteSession: async (id: string) => { rows.delete(id); },
    extendSession: async (id: string, expiresAt: number) => { rows.set(id, { ...rows.get(id)!, expiresAt }); },
  };
  let now = 1_000_000;
  const auth = createAuth({ config: { verifierDir: dir, sessionKeyPath: '', people: [{ id: 'alice' }] } as never, sessions, now: () => now, key: Buffer.alloc(32, 7) });
  const { token } = await auth.login('alice', secret);
  expect(await auth.authenticate(token)).toMatchObject({ personId: 'alice', renewed: false });
  now += SESSION_RENEW_MS + 1;
  expect(await auth.authenticate(token)).toEqual({ personId: 'alice', renewed: true, expiresAt: now + SESSION_TTL_MS });
  expect([...rows.values()][0]!.expiresAt).toBe(now + SESSION_TTL_MS);
  expect(await auth.authenticate(token)).toMatchObject({ renewed: false });
  now += SESSION_TTL_MS;
  expect(await auth.authenticate(token)).toBeNull();
  rmSync(dir, { recursive: true, force: true });
});
