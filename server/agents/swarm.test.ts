import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore, type PgStore } from '../db/store.js';
import { freshSchema, testDatabaseUrl } from '../db/test-db.js';
import { AgentRuntime } from './runtime.js';
import type { Deps } from '../types.js';
import { SWARM_MAX_ACTIVE } from '../../shared/swarm.js';

const haiku = { model: 'claude-haiku-5-5', thinking: 'low' };

describe.skipIf(!testDatabaseUrl)('swarms', () => {
  let store: PgStore, runtime: AgentRuntime, goal: string;
  const dir = mkdtempSync(join(tmpdir(), 'kenan-swarm-test-'));
  const catalog = join(dir, 'models.json');
  const person = { id: 'owner', name: 'Owner', brokerPort: 1, worker: { model: 'claude-opus-5-5' } };
  beforeAll(async () => {
    writeFileSync(catalog, JSON.stringify({ catalog: { providers: { anthropic: { models: [{ id: 'claude-opus-5-5' }, { id: 'claude-haiku-5-5' }] } } } }));
    store = createStore(await freshSchema('t_swarm')); await store.migrate();
    await store.upsertPerson({ id: 'owner', name: 'Owner', kind: 'human' });
    await store.createAgent({ id: 'manager:owner', ownerId: 'owner', parentAgentId: null, role: 'manager', name: 'Kenaznia', goalId: null, model: 'claude-opus-5-5', sessionPath: '/tmp/m', conversationTitle: 'Kenaznia' });
    goal = (await store.createGoal({ ownerId: 'owner', title: 'Prove lemmas' })).id;
    runtime = new AgentRuntime({ store, config: { people: [person], dataDir: '/tmp', modelsPath: catalog, allowedProviders: ['anthropic'] }, person: () => person, bus: { toPerson() {}, toConversation() {} }, now: Date.now } as unknown as Deps);
    (runtime as any).managers.set('owner', 'manager:owner');
    (runtime as any).deliver = vi.fn();
  });
  afterAll(async () => { await store?.close(); rmSync(dir, { recursive: true, force: true }); });

  it('a coordinator fans out its own goal to capped, explicit sub-agents that its manager does not see', async () => {
    const coordinator = await runtime.spawnWorker('owner', goal, 'Coordinator', 'run a swarm', 'manager:owner', { model: 'claude-opus-5-5', thinking: 'high' });
    await expect(runtime.spawnWorker('owner', goal, 'Second', 'x', 'manager:owner')).rejects.toThrow('already has an active worker');
    await expect(runtime.spawnWorker('owner', goal, 'Bare', 'x', coordinator.id)).rejects.toThrow('swarm_profile_required');
    const results = await Promise.allSettled(Array.from({ length: SWARM_MAX_ACTIVE + 2 }, (_, i) => runtime.spawnWorker('owner', goal, `Lemma ${i}`, `prove ${i}`, coordinator.id, haiku)));
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(SWARM_MAX_ACTIVE);
    expect(results.filter(r => r.status === 'rejected').map(r => String((r as PromiseRejectedResult).reason))).toEqual([expect.stringContaining('swarm_full'), expect.stringContaining('swarm_full')]);
    const child = (results[0] as PromiseFulfilledResult<any>).value;
    expect(child).toMatchObject({ parentAgentId: coordinator.id, goalId: goal, model: 'claude-haiku-5-5', thinking: 'low' });
    await expect(runtime.spawnWorker('owner', goal, 'Nested', 'x', child.id, haiku)).rejects.toThrow('swarm_depth');
    expect((await store.listWorkersPage('owner', { state: 'all' })).items.map(w => w.id)).toEqual([coordinator.id]);
    expect((await store.listWorkersPage('owner', { state: 'all', parent: coordinator.id, limit: 50 })).items).toHaveLength(SWARM_MAX_ACTIVE);
    await store.updateAgent(child.id, { lastReport: { status: 'done', text: 'proved', at: 1 } });
    await expect(runtime.spawnWorker('owner', goal, 'Next', 'x', coordinator.id, haiku)).resolves.toMatchObject({ parentAgentId: coordinator.id });
    await runtime.stopAgent(coordinator.id);
    expect((await store.listAgents('owner')).filter(a => a.role === 'worker')).toEqual([]);
  });

  it('a sub-agent that settles without reporting is asked once, then its coordinator is told', async () => {
    const coordinator = await runtime.spawnWorker('owner', goal, 'Coordinator 3', 'run a swarm', 'manager:owner');
    const child = await runtime.spawnWorker('owner', goal, 'Silent', 'x', coordinator.id, haiku);
    const deliver = (runtime as any).deliver as ReturnType<typeof vi.fn>; deliver.mockClear();
    const lane = {} as any;
    for (let i = 0; i < 3; i++) await (runtime as any).chaseSubAgentReport(child, lane);
    expect(deliver.mock.calls.map(([input]) => [input.agentId, input.kind])).toEqual([[child.id, 'agent'], [coordinator.id, 'note']]);
    await (runtime as any).chaseSubAgentReport(coordinator, {});
    expect(deliver).toHaveBeenCalledTimes(2);
    await runtime.stopAgent(coordinator.id);
  });
  it('new sub-agents wait while the pool is in the reserve kept for human-facing work', async () => {
    const coordinator = await runtime.spawnWorker('owner', goal, 'Coordinator 2', 'run a swarm', 'manager:owner');
    const now = Date.now();
    const reading = (percentLeft: number, at: number) => store.recordUsageSamples('broker:1', [{ provider: 'anthropic', metric: 'weekly', account: 'a', percentLeft, resetAt: now + 86400000, windowHours: 168, readingAt: at, at }], now - 86400000);
    await reading(10, now - 1000);
    await expect(runtime.spawnWorker('owner', goal, 'Above reserve', 'x', coordinator.id, haiku)).resolves.toMatchObject({ parentAgentId: coordinator.id });
    await reading(7, now);
    await expect(runtime.spawnWorker('owner', goal, 'Lemma', 'x', coordinator.id, haiku)).rejects.toThrow('swarm_quota_low: the subscription pool\'s weekly meter has 7% left, under the 8% kept');
    await runtime.stopAgent(coordinator.id);
  });
});
