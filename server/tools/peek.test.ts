import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createStore, type PgStore } from '../db/store.js';
import { freshSchema, testDatabaseUrl } from '../db/test-db.js';
import { controlTools } from './control.js';
import { redact } from './peek.js';

const SECRET = 'sk-ant-oat01-abcdefghijklmnopqrstuvwxyz0123456789';

it('redacts credential-looking text and keeps ordinary hashes', () => {
  const text = `key ${SECRET} ghp_0123456789abcdefghijABCDEFGHIJ password=hunter22 "api_key": "q9w8e7r6t5y4" Authorization: Bearer abcdefghijklmnopqrstuvwx https://user:pa55word@host/x commit 4bf747adc04cf3f8ca7f73b9a6d3948d9c43e2c2`;
  const out = redact(text);
  for (const leaked of ['abcdefghijklmnopqrstuvwxyz0123', 'ghp_0123', 'hunter22', 'q9w8e7r6t5y4', 'abcdefghijklmnopqrstuvwx', 'pa55word']) expect(out).not.toContain(leaked);
  expect(out).toContain('4bf747adc04cf3f8ca7f73b9a6d3948d9c43e2c2');
});

describe.skipIf(!testDatabaseUrl)('workers peek', () => {
  let store: PgStore;
  const now = 1_800_000_000_000;
  beforeAll(async () => {
    store = createStore(await freshSchema('t_peek')); await store.migrate();
    await store.upsertPerson({ id: 'owner', name: 'Owner', kind: 'human' });
    await store.createAgent({ id: 'manager:owner', ownerId: 'owner', parentAgentId: null, role: 'manager', name: 'Kenaznia', goalId: null, model: 'fixture', sessionPath: '/tmp/m', conversationTitle: 'm' });
    for (const id of ['aaaaaaaa-1111', 'aaaaaaaa-2222', 'bbbbbbbb-0000']) await store.createAgent({ id, ownerId: 'owner', parentAgentId: 'manager:owner', role: 'worker', name: id, goalId: null, model: 'fixture', sessionPath: `/tmp/${id}`, conversationTitle: id });
    await store.updateAgent('bbbbbbbb-0000', { state: 'stopped', archived: true, lastReport: { status: 'done', text: 'Shipped', at: now } });
    const worker = (await store.getAgent('aaaaaaaa-1111'))!;
    const say = (text: string, display: 'shown' | 'silent' = 'shown') => store.appendMessage({ conversationId: worker.conversationId, authorId: worker.id, role: 'assistant', display, text });
    const tool = (name: string, args: unknown, out: string | null) => store.appendMessage({ conversationId: worker.conversationId, authorId: worker.id, role: 'tool', display: 'shown', text: name, state: out === null ? 'streaming' : 'done',
      parts: [{ type: 'tool', callId: name, name, args, isError: false, result: out === null ? null : JSON.stringify({ content: [{ type: 'text', text: out }], details: {} }) }] });
    for (let i = 0; i < 8; i++) await tool('bash', { command: `step ${i}` }, `out ${i}`);
    await say('Looking at the deploy log');
    await tool('read', { path: '/tmp/log' }, `START ${'x'.repeat(20000)} token=${SECRET.slice(7)} END`);
    await say('NO_REPLY', 'silent');
    await tool('bash', { command: 'deploy/deploy.sh beta' }, null);
  });
  afterAll(async () => { await store?.close(); });
  const workers = () => {
    const runtime: any = { managerFor: () => 'manager:owner', turnOf: (id: string) => id === 'aaaaaaaa-1111' ? { startedAt: now - 90_000, inputs: [{ kind: 'agent', fromId: 'manager:owner', text: `Ship it ${SECRET}` }], queued: 1 } : null };
    const deps: any = { store, runtime, now: () => now, bus: { activity: () => null } };
    return controlTools({ person: { id: 'owner' }, agent: { id: 'manager:owner', role: 'manager' }, deps } as any, {} as any).find(t => t.name === 'workers')!;
  };
  const peek = async (args: object) => JSON.parse(((await workers().execute('p', { action: 'peek', ...args }, undefined, undefined, {} as any)).content[0] as { text: string }).text);

  it('shows every active worker compactly from its stored conversation, newest work last, bounded and redacted', async () => {
    const all = await peek({});
    expect(all.workers.map((w: any) => w.id)).toEqual(expect.arrayContaining(['aaaaaaaa-1111', 'aaaaaaaa-2222']));
    expect(all.workers).toHaveLength(2);
    const busy = all.workers.find((w: any) => w.id === 'aaaaaaaa-1111');
    expect(busy.turn).toMatchObject({ ageS: 90, queued: 1, inputs: [{ kind: 'agent' }] });
    expect(busy.said.map((m: any) => m.text)).toEqual(['Looking at the deploy log']);
    expect(busy.did.map((c: any) => c.tool)).toEqual(['bash', 'bash', 'bash', 'read', 'bash']);
    expect(busy.did.at(-1)).toMatchObject({ args: "command=deploy/deploy.sh beta", runningS: expect.any(Number) });
    expect(busy.did.at(-2).result).toMatch(/^START x+ … x+ token=\[redacted\] END \[\d+ chars\]$/);
    const text = JSON.stringify(all);
    expect(text).not.toContain(SECRET.slice(10));
    expect(text.length).toBeLessThan(6000);
  });
  it('shows one worker in detail by id prefix and refuses unknown, ambiguous and archived ids with typed errors', async () => {
    expect((await peek({ id: 'aaaaaaaa-1111' })).worker.did).toHaveLength(10);
    await expect(peek({ id: 'aaaaaaaa' })).rejects.toThrow('worker_id_ambiguous');
    await expect(peek({ id: 'cccccccc' })).rejects.toThrow('worker_not_found');
    await expect(peek({ id: 'bbbbbbbb' })).rejects.toThrow(/worker_archived.*Shipped/);
  });
});
