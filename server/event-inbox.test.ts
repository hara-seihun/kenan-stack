import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { createStore } from './db/store.js';
import { freshSchema, testDatabaseUrl } from './db/test-db.js';
import { startEventInboxes } from './event-inbox.js';
import { WakeScheduler, parseTopic } from './agents/wakes.js';
import type { AgentInput, Deps } from './types.js';

const until = async (check: () => boolean | Promise<boolean>) => {
  for (let i = 0; i < 100; i++) { if (await check()) return; await new Promise(r => setTimeout(r, 50)); }
  throw new Error('condition not reached in 5 s');
};

describe.skipIf(!testDatabaseUrl)('host event wakes', () => {
  const root = mkdtempSync(join(tmpdir(), 'event-inbox-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('fires the owning worker once per event, including events that arrived before it scheduled, and sets invalid files aside', async () => {
    const store = createStore(await freshSchema('t_event_inbox')); await store.migrate();
    await store.upsertPerson({ id: 'alice', name: 'Alice', kind: 'human' });
    for (const id of ['w1', 'w2'])
      await store.createAgent({ id, ownerId: 'alice', parentAgentId: null, role: 'worker', name: id, goalId: null, model: 'fixture', sessionPath: `/tmp/${id}`, conversationTitle: id });
    const self = userInfo();
    const person = { id: 'alice', name: 'Alice', uid: self.uid, gid: self.gid, extensions: [], signalStore: null, manager: { provider: 'anthropic' } };
    const delivered: AgentInput[] = [];
    const deps = { config: { people: [person], channel: 'beta' }, store, now: () => Date.now(), person: () => person,
      bus: { toPerson: vi.fn() }, runtime: { deliver: (input: AgentInput) => delivered.push(input) } } as unknown as Deps;
    const wakes = new WakeScheduler(deps);
    const dir = join(root, 'alice');
    const event = (name: string, topic: string, id: string, body: unknown) => writeFileSync(join(dir, name), JSON.stringify({ topic, id, body }));

    mkdirSync(dir);
    event('1.json', 'acme:w1', 'q1', { kind: 'qualify', owner: 'w1', verdict: 'qualified', merge: 'abc123' });
    event('2.json', 'acme:w1', 'q1', { kind: 'qualify', owner: 'w1', verdict: 'qualified', merge: 'abc123' });
    writeFileSync(join(dir, '3.json'), JSON.stringify({ topic: 'has space', id: 'x', body: {} }));
    const stop = await startEventInboxes(deps, root, () => void wakes.tick());
    try {
      await until(() => readdirSync(dir).every(n => !n.endsWith('.json')));
      expect(readdirSync(dir).sort()).toEqual(['3.invalid']);

      // Arrived before the wake: no wake has carried it, so scheduling fires at once.
      await store.createWake({ agentId: 'w1', ownerId: 'alice', message: 'merge it', trigger: { at: null, event: { source: 'event', topic: 'acme:w1', prefix: false }, listen: { kind: 'addressed' } } });
      await wakes.tick();
      expect(delivered).toHaveLength(1);
      expect(delivered[0]).toMatchObject({ agentId: 'w1', kind: 'wake' });
      expect(delivered[0]!.text).toContain('"verdict":"qualified"');
      expect(delivered[0]!.text).toContain('merge it');

      // Carried once: new wakes wait for the next event, which fires the owner's exact wake and a prefix wake alike.
      await store.createWake({ agentId: 'w1', ownerId: 'alice', message: 'deployed?', trigger: { at: null, event: { source: 'event', topic: 'acme:w1', prefix: false }, listen: { kind: 'addressed' } } });
      await store.createWake({ agentId: 'w2', ownerId: 'alice', message: 'any acme', trigger: { at: null, event: { source: 'event', topic: 'acme:', prefix: true }, listen: { kind: 'addressed' } } });
      await store.createWake({ agentId: 'w2', ownerId: 'alice', message: 'not mine', trigger: { at: null, event: { source: 'event', topic: 'acme:w2', prefix: false }, listen: { kind: 'addressed' } } });
      await wakes.tick();
      expect(delivered).toHaveLength(1);
      event('4.json', 'acme:w1', 'd1', { kind: 'deploy', owner: 'w1', outcome: 'live', commit: 'def456' });
      await until(() => delivered.length === 3);
      expect(delivered.slice(1).map(d => d.agentId).sort()).toEqual(['w1', 'w2']);
      expect(delivered.slice(1).every(d => d.text.includes('"outcome":"live"') && !d.text.includes('"verdict"'))).toBe(true);
      expect((await store.pendingWakes('alice')).map(w => w.message)).toEqual(['not mine']);
    } finally { stop(); await wakes.stop(); await store.close(); }
  });

  it('parses exact and prefix topics and rejects others', () => {
    expect(parseTopic('acme:abc')).toEqual({ ok: true, value: { topic: 'acme:abc', prefix: false } });
    expect(parseTopic(' acme:* ')).toEqual({ ok: true, value: { topic: 'acme:', prefix: true } });
    expect(parseTopic('*')).toMatchObject({ ok: false });
    expect(parseTopic('a b')).toMatchObject({ ok: false });
    expect(parseTopic(undefined)).toMatchObject({ ok: false });
  });
});
