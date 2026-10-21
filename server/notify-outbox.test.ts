import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createStore } from './db/store.js';
import { freshSchema, testDatabaseUrl } from './db/test-db.js';
import { startNotifyOutboxes } from './notify-outbox.js';
import type { Deps } from './types.js';

const until = async (check: () => boolean | Promise<boolean>) => {
  for (let i = 0; i < 100; i++) { if (await check()) return; await new Promise(r => setTimeout(r, 50)); }
  throw new Error('condition not reached in 5 s');
};

describe.skipIf(!testDatabaseUrl)('notify outbox', () => {
  const root = mkdtempSync(join(tmpdir(), 'notify-outbox-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('delivers alerts queued while no channel ran, then new ones live, and sets invalid ones aside', async () => {
    const store = createStore(await freshSchema('t_notify_outbox')); await store.migrate();
    await store.upsertPerson({ id: 'alice', name: 'Alice', kind: 'human' });
    await store.createAgent({ id: 'manager:alice', ownerId: 'alice', parentAgentId: null, role: 'manager', name: 'Kenaznia', goalId: null, model: 'fixture', sessionPath: '/tmp/x', conversationTitle: 'Kenaznia' });
    const self = userInfo();
    const person = { id: 'alice', name: 'Alice', uid: self.uid, gid: self.gid, manager: { provider: 'anthropic' } };
    const deps = { config: { people: [person], channel: 'beta' }, store, bus: { toPerson() {}, toConversation() {} } } as unknown as Deps;
    const dir = join(root, 'alice');
    const delivered = async () => (await store.notificationsAfter('alice', 0, 0, 10)).map(n => n.title);

    mkdirSync(dir);
    writeFileSync(join(dir, '1-deploy.json'), JSON.stringify({ title: 'Kenan beta deploy failed', body: 'exit 1', level: 'normal' }));
    writeFileSync(join(dir, '2-bad.json'), '{"title": ""}');
    writeFileSync(join(dir, '.partial'), '{');

    const stop = await startNotifyOutboxes(deps, root);
    try {
      await until(async () => (await delivered()).length === 1);
      writeFileSync(join(dir, '3-live.json'), JSON.stringify({ title: 'Disk full', body: 'root at 95 %', level: 'urgent' }));
      await until(async () => (await delivered()).length === 2);
      expect(await delivered()).toEqual(['Kenan beta deploy failed', 'Disk full']);
      await until(() => !existsSync(join(dir, '3-live.json')));
      expect(readdirSync(dir).sort()).toEqual(['.partial', '2-bad.invalid']);
    } finally { stop(); await store.close(); }
  });
});
