import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createStore, type PgStore } from './db/store.js';
import { freshSchema, testDatabaseUrl } from './db/test-db.js';
import { peerTool, servePeerSocket } from './peers.js';
import type { PersonConfig } from './config.js';
import type { AgentInput, Deps } from './types.js';
// @ts-expect-error plain ESM relay script without type declarations
import { channelOf, relayHealth, relayOnce, request, STALL_MS } from '../deploy/peer/peer-relay.mjs';

const self = userInfo();
type Host = { store: PgStore; deps: Deps; person: PersonConfig; delivered: AgentInput[]; socket: string; server?: Server };

async function host(name: string, personId: string, peer: { id: string; name: string }, dir: string): Promise<Host> {
  const store = createStore(await freshSchema(`t_peer_${name}`)); await store.migrate();
  await store.upsertPerson({ id: personId, name: personId, kind: 'human' });
  await store.createAgent({ id: `manager:${personId}`, ownerId: personId, parentAgentId: null, role: 'manager', name: 'Kenaznia', goalId: null, model: 'fixture', sessionPath: `/tmp/${name}`, conversationTitle: 'Kenaznia' });
  const person = { id: personId, name: personId, uid: self.uid, gid: self.gid, peers: [{ ...peer, about: 'fixture peer' }] } as unknown as PersonConfig;
  const delivered: AgentInput[] = [];
  const deps = { store, bus: { toConversation() {}, toPerson() {} }, runtime: { deliver: (input: AgentInput) => delivered.push(input) }, now: Date.now } as unknown as Deps;
  const socket = join(dir, `${name}.sock`);
  const h: Host = { store, deps, person, delivered, socket };
  h.server = await servePeerSocket(deps, person, socket);
  return h;
}
async function send(from: Host, peer: string, text: string, agentId = `manager:${from.person.id}`, to?: string) {
  const agent = await from.store.getAgent(agentId);
  const tool = peerTool({ deps: from.deps, person: from.person, agent: agent! })!;
  const part = (await tool.execute('call', { action: 'send', peer, text, ...(to ? { to } : {}) }, undefined, undefined, undefined as never)).content[0];
  return JSON.parse(part?.type === 'text' ? part.text : 'null');
}

describe.skipIf(!testDatabaseUrl)('peer Kenaznia channel', () => {
  let dir: string, a: Host, b: Host;
  const sideA = () => ({ socket: a.socket, peer: 'acme', via: [] });
  const sideB = () => ({ socket: b.socket, peer: 'alice-personal', via: [] });
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'peer-'));
    a = await host('a', 'alice', { id: 'acme', name: "Acme's Kenaznia" }, dir);
    b = await host('b', 'acme', { id: 'alice-personal', name: "Alice's personal Kenaznia" }, dir);
  });
  afterAll(async () => { for (const h of [a, b]) { h?.server?.close(); await h?.store.close(); } rmSync(dir, { recursive: true, force: true }); });

  it('delivers both ways into the recipient manager as a steered note, once, and acks the sender', async () => {
    const queued = await send(a, 'acme', 'Is Insight live?');
    expect(await relayOnce(sideA(), sideB(), 0)).toBe(1);
    expect(b.delivered).toEqual([expect.objectContaining({ agentId: 'manager:acme', kind: 'note', fromId: 'peer:alice-personal' })]);
    expect(b.delivered[0]!.text).toContain('Is Insight live?');
    expect((await a.store.peerHistory('alice', 'acme', 5))[0]).toMatchObject({ id: queued.queued, direction: 'out', relayedAt: expect.any(Number) });
    expect(await relayOnce(sideA(), sideB(), 0)).toBe(0);

    await send(b, 'alice-personal', 'Not yet; candidate 1234567 is in staging.', 'manager:acme');
    expect(await relayOnce(sideB(), sideA(), 0)).toBe(1);
    expect(a.delivered).toEqual([expect.objectContaining({ agentId: 'manager:alice', kind: 'note', fromId: 'peer:acme' })]);
    expect(a.delivered[0]!.text).toContain('candidate 1234567');
  });

  it('a reply addressed to a live worker goes straight to it; one addressed to an archived worker goes to the manager', async () => {
    const worker = (h: Host, id: string) => h.store.createAgent({ id, ownerId: h.person.id, parentAgentId: `manager:${h.person.id}`, role: 'worker', name: id, goalId: null, model: 'fixture', sessionPath: `/tmp/${id}`, conversationTitle: id });
    await worker(a, 'alice-worker-1'); await worker(b, 'acme-worker-1');
    a.delivered.length = 0; b.delivered.length = 0;
    await send(a, 'acme', 'Worker question', 'alice-worker-1');
    expect(await relayOnce(sideA(), sideB(), 0)).toBe(1);
    expect(b.delivered.at(-1)).toMatchObject({ agentId: 'manager:acme' });
    expect(b.delivered.at(-1)!.text).toContain('to alice-worker-1');
    await send(b, 'alice-personal', 'Worker answer', 'acme-worker-1', 'alice-worker-1');
    expect(await relayOnce(sideB(), sideA(), 0)).toBe(1);
    expect(a.delivered.at(-1)).toMatchObject({ agentId: 'alice-worker-1', kind: 'note', fromId: 'peer:acme' });
    await a.store.updateAgent('alice-worker-1', { archived: true });
    await send(b, 'alice-personal', 'Late answer', 'acme-worker-1', 'alice-worker-1');
    expect(await relayOnce(sideB(), sideA(), 0)).toBe(1);
    expect(a.delivered.at(-1)).toMatchObject({ agentId: 'manager:alice' });
    expect(a.delivered.at(-1)!.text).toContain('addressed to alice-worker-1, which is no longer running');
  });

  it('a redelivered message after a lost ack reaches the manager only once', async () => {
    const before = b.delivered.length;
    const item = { id: crypto.randomUUID(), peer: 'alice-personal', from: 'manager:alice', text: 'Exactly once', createdAt: Date.now() };
    expect(await request(sideB(), 'POST', '/inbox', item, 5)).toMatchObject({ duplicate: false });
    expect(await request(sideB(), 'POST', '/inbox', item, 5)).toMatchObject({ duplicate: true });
    expect(b.delivered.length).toBe(before + 1);
  });

  it('a long poll returns as soon as a message is queued', async () => {
    const started = Date.now();
    const polling = relayOnce(sideA(), sideB(), 20);
    setTimeout(() => void send(a, 'acme', 'wake the poll'), 300);
    expect(await polling).toBe(1);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('refuses unknown peers and malformed messages', async () => {
    await expect(request(sideB(), 'POST', '/inbox', { id: crypto.randomUUID(), peer: 'stranger', from: 'x', text: 'hi', createdAt: 1 }, 5)).rejects.toThrow(/peer: one of alice-personal/);
    await expect(request(sideB(), 'POST', '/inbox', { id: 'not-a-uuid', peer: 'alice-personal', from: 'x', text: 'hi', createdAt: 1 }, 5)).rejects.toThrow(/id:/);
    await expect(request({ ...sideB(), peer: 'stranger' }, 'GET', '/outbox?peer=stranger&wait=0', undefined, 5)).rejects.toThrow(/peer: one of/);
  });
});

describe('peer relay stall alert', () => {
  it('alerts once after a direction fails for STALL_MS, and once when every direction recovers', () => {
    let clock = 0;
    const health = relayHealth(() => clock);
    const pending = [{ id: 'm1', createdAt: '2026-10-19T21:42:45Z' }];
    expect(health.failed('local->remote', 'curl exited 7', pending)).toBeNull();
    clock = STALL_MS - 1;
    expect(health.failed('remote->local', 'curl exited 7', [])).toBeNull();
    clock = STALL_MS;
    const alert = health.failed('local->remote', 'curl exited 7', pending);
    expect(alert?.kind).toBe('stalled');
    expect(alert?.body).toContain('1 message(s) waiting, oldest from 2026-10-19T21:42:45Z');
    clock = 3 * STALL_MS;
    expect(health.failed('remote->local', 'curl exited 7', [])).toBeNull();
    expect(health.succeeded('local->remote')).toBeNull();
    expect(health.succeeded('remote->local')?.kind).toBe('recovered');
    expect(channelOf('/run/kenan/beta-peer/acme.sock')).toEqual({ ok: true, channel: 'beta' });
    expect(channelOf('/tmp/x.sock').ok).toBe(false);
    expect(health.succeeded('remote->local')).toBeNull();
  });
});
