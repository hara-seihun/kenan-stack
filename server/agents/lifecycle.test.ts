import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import { createStore, type PgStore } from '../db/store.js';
import { freshSchema, testDatabaseUrl } from '../db/test-db.js';
import { AgentRuntime, ManagerPlacementFixed, RESTART_NOTICE } from './runtime.js';
import type { AgentInfo } from '../../shared/contract.js';
import type { Deps } from '../types.js';
import { controlTools } from '../tools/control.js';
import { dropReason } from './wakes.js';

const tick = () => new Promise(resolve => setImmediate(resolve));

describe.skipIf(!testDatabaseUrl)('agent lineage and archive persistence', () => {
  let store: PgStore, db: pg.Client;
  beforeAll(async () => {
    const url = await freshSchema('t_lifecycle');
    store = createStore(url); await store.migrate();
    db = new pg.Client({ connectionString: url }); await db.connect();
    await store.upsertPerson({ id: 'owner', name: 'Owner', kind: 'human' });
    await store.upsertPerson({ id: 'other', name: 'Other', kind: 'human' });
  });
  afterAll(async () => { await store?.close(); await db?.end(); });
  async function create(id: string, ownerId = 'owner', parentAgentId: string | null = null, role: 'manager'|'worker' = 'worker') {
    return store.createAgent({ id, ownerId, parentAgentId, role, name: id, goalId: null, model: 'fixture', sessionPath: `/tmp/${id}`, conversationTitle: id });
  }
  it('retains exact three-generation lineage and rejects cross-owner parents atomically', async () => {
    await create('manager', 'owner', null, 'manager');
    await create('worker', 'owner', 'manager');
    expect(await create('child', 'owner', 'worker')).toMatchObject({ parentAgentId: 'worker', archived: false });
    await expect(create('wrong', 'other', 'manager')).rejects.toMatchObject({ code: 'invalid_input' });
    expect(await store.getPerson('wrong')).toBeNull();
  });
  it('places managers from configuration at start: a hosted one is restored and renamed, one hosted elsewhere is archived', async () => {
    await store.upsertPerson({ id: 'away', name: 'Away', kind: 'human' });
    const hosted = await create('manager:other', 'other', null, 'manager');
    await store.updateAgent(hosted.id, { state: 'stopped', archived: true });
    const away = await create('manager:away', 'away', null, 'manager');
    const profile = { name: 'Kenaznia', provider: 'anthropic', model: 'fixture', thinking: 'medium', systemPrompt: '', contextFiles: [], refusalFallbackModels: [] };
    const people = [{ id: 'other', name: 'Other', manager: profile }, { id: 'away', name: 'Away', manager: { elsewhere: 'https://elsewhere.test' } }];
    const runtime = new AgentRuntime({ store, config: { people, dataDir: '/tmp', modelsPath: '/nonexistent' }, person: (id: string) => people.find(p => p.id === id), bus: { toPerson() {} }, now: Date.now } as unknown as Deps);
    await runtime.start();
    expect(await store.getAgent(hosted.id)).toMatchObject({ archived: false, state: 'idle', name: 'Kenaznia' });
    expect(await store.getConversation(hosted.conversationId, 'other')).toMatchObject({ archived: false });
    expect(runtime.managerFor('other')).toBe(hosted.id);
    expect(await store.getAgent(away.id)).toMatchObject({ archived: true, state: 'stopped' });
    expect(runtime.managerFor('away')).toBeNull();
    await runtime.shutdown();
  });
  it('synchronizes direct conversation archival and keeps history visible by explicit request', async () => {
    const worker = (await store.getAgent('child'))!;
    await store.updateConversation(worker.conversationId, 'owner', { archived: true });
    expect(await store.getAgent(worker.id)).toMatchObject({ archived: true });
    expect((await store.listConversations('owner')).some(c => c.id === worker.conversationId)).toBe(false);
    expect((await store.listConversations('owner', { includeArchived: true })).some(c => c.id === worker.conversationId)).toBe(true);
  });
});

function harness(role: AgentInfo['role'], report: AgentInfo['lastReport']) {
  let agent = { id: 'worker', name: 'Worker', kind: 'agent', ownerId: 'owner', parentAgentId: 'parent', conversationId: 'conversation', role, state: 'idle', archived: false, goalId: 'goal', model: 'fixture', createdAt: 1, updatedAt: 1, lastReport: report } as AgentInfo;
  const events: unknown[] = [], errors: string[] = [];
  let release: () => void = () => {};
  const session = { abort: vi.fn(async () => release()), dispose: vi.fn() };
  const deps = {
    store: {
      getAgent: vi.fn(async () => agent),
      listAgents: vi.fn(async () => [agent]),
      updateAgent: vi.fn(async (_id, patch) => agent = { ...agent, ...patch }),
      awaitingReply: vi.fn(async () => false),
      getConversation: vi.fn(async () => ({ id: 'conversation', archived: agent.archived })),
      logError: vi.fn(async (_source: string, error: string) => { errors.push(error); }),
      savePendingInputs: vi.fn(async () => {}),
      pendingWakes: vi.fn(async () => []),
    },
    bus: { toPerson: vi.fn((_id, event) => events.push(event)) },
    now: () => 1,
  } as unknown as Deps;
  const runtime = new AgentRuntime(deps);
  const internal = runtime as any;
  internal.lane(agent.id).session = session;
  internal.runTurn = (_agent: unknown, lane: { prompted: boolean }) => { lane.prompted = true; return new Promise<void>(resolve => { release = resolve; }); };
  return { runtime, deps, agent: () => agent, finish: () => release(), events, errors, session };
}
it('a restart marks the cut-off turn interrupted, keeps unstarted input, and the next start resumes both once', async () => {
  const h = harness('worker', null);
  h.runtime.deliver({ agentId: 'worker', fromId: 'parent', conversationId: 'conversation', kind: 'agent', text: 'work' });
  await tick();
  h.runtime.deliver({ agentId: 'worker', fromId: 'parent', conversationId: 'conversation', kind: 'external', text: 'queued follow-up' });
  await h.runtime.shutdown();
  expect(h.agent().state).toBe('interrupted');
  const saved = (h.deps.store.savePendingInputs as ReturnType<typeof vi.fn>).mock.calls[0]![0];
  expect(saved.map((input: { text: string }) => input.text)).toEqual(['queued follow-up']);
  const delivered: { kind: string; text: string }[] = [];
  const next = new AgentRuntime({ ...h.deps, config: { people: [] }, store: { ...h.deps.store, markRunningInterrupted: vi.fn(async () => []), listInterrupted: vi.fn(async () => ['worker']), takePendingInputs: vi.fn(async () => saved) } } as unknown as Deps);
  const redelivered: { kind: string; text: string }[] = [];
  (next as any).deliver = (input: { kind: string; text: string }) => delivered.push(input);
  (next as any).enqueue = (input: { kind: string; text: string }) => redelivered.push(input);
  await next.start();
  // The retained input is queued again without a second notice; the restart notice is new input.
  expect([delivered.map(input => input.kind), redelivered.map(input => input.text)]).toEqual([['restart'], ['queued follow-up']]);
  expect(delivered[0]!.text).toBe(RESTART_NOTICE);
});
it('archives completed workers only when their turn settles, preserving the report and goal', async () => {
  const h = harness('worker', { status: 'done', text: 'Delivered', at: 3 });
  h.runtime.deliver({ agentId: 'worker', fromId: 'parent', conversationId: 'conversation', kind: 'agent', text: 'work' });
  await tick(); expect(h.agent().archived).toBe(false);
  h.finish(); await tick();
  expect(h.agent()).toMatchObject({ state: 'stopped', archived: true, goalId: 'goal', lastReport: { text: 'Delivered' } });
  expect(h.events).toContainEqual(expect.objectContaining({ type: 'conversation', conversation: expect.objectContaining({ archived: true }) }));
  await h.runtime.shutdown();
});
it('keeps blocked workers and managers available; a worker\'s self-archive never waits on its own tool; a manager is never archived', async () => {
  for (const role of ['manager', 'worker'] as const) {
    const h = harness(role, { status: role === 'manager' ? 'done' : 'blocked', text: 'report', at: 3 });
    h.runtime.deliver({ agentId: 'worker', fromId: 'parent', conversationId: 'conversation', kind: 'agent', text: 'work' });
    await tick(); h.finish(); await tick(); expect(h.agent().archived).toBe(false);
    if (role === 'manager') {
      await expect(h.runtime.archiveAgent('worker', true)).rejects.toBeInstanceOf(ManagerPlacementFixed);
      await expect(h.runtime.stopAgent('worker')).rejects.toBeInstanceOf(ManagerPlacementFixed);
      expect(h.agent()).toMatchObject({ archived: false });
    } else {
      await h.runtime.archiveAgent('worker', true);
      expect(h.agent()).toMatchObject({ archived: true, state: 'stopped' });
      await h.runtime.archiveAgent('worker', false);
      expect(h.agent()).toMatchObject({ archived: false, state: 'idle' });
    }
    await h.runtime.shutdown();
  }
});
it('Stop in a conversation ends the manager\'s turn without archiving it, so its wakes stay pending', async () => {
  const h = harness('manager', null);
  Object.assign(h.deps.store, { conversationMembers: vi.fn(async () => ['owner', 'worker']) });
  h.runtime.deliver({ agentId: 'worker', fromId: 'owner', conversationId: 'conversation', kind: 'human', text: 'work' });
  await tick(); expect(h.agent().state).toBe('running');
  await h.runtime.stop('conversation');
  expect(h.session.abort).toHaveBeenCalled();
  await tick(); await tick();
  expect(h.agent()).toMatchObject({ archived: false, state: 'idle' });
  expect(dropReason(h.agent())).toBeNull();
  await h.runtime.shutdown();
});
it('a message to an archived worker is refused and the run stays archived until an explicit restore', async () => {
  const h = harness('worker', { status: 'done', text: 'Delivered', at: 3 });
  const prompted = vi.spyOn(h.runtime, 'deliver');
  await h.runtime.archiveAgent('worker', true);
  expect(await h.runtime.messageWorker('worker', 'one more thing', 'other-worker')).toMatchObject({ delivered: false, error: 'recipient_archived' });
  expect(h.agent()).toMatchObject({ archived: true, state: 'stopped', lastReport: { text: 'Delivered' } });
  expect(prompted).not.toHaveBeenCalled();
  const ctx: any = { person: { id: 'owner' }, agent: { id: 'other-worker', role: 'worker', parentAgentId: 'parent' }, deps: { ...h.deps, runtime: { managerFor: () => 'parent' } } };
  const workers = controlTools(ctx, h.runtime).find(t => t.name === 'workers')!;
  await expect(workers.execute('m', { action: 'message', id: 'worker', text: 'again' }, undefined, undefined, {} as any)).rejects.toThrow('recipient_archived');
  expect(h.agent().archived).toBe(true);
  await h.runtime.archiveAgent('worker', false);
  expect(await h.runtime.messageWorker('worker', 'resume', 'parent')).toEqual({ delivered: true });
  expect(h.agent()).toMatchObject({ archived: false, lastReport: null });
  expect(prompted).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'worker', text: 'resume' }));
  await tick(); h.finish(); await tick();
});
it('workers delegate with their own lineage and route reports to their parent', async () => {
  const spawnWorker = vi.fn(async () => ({} as AgentInfo)), deliver = vi.fn();
  const agent = { id: 'child', name: 'Child', role: 'worker', parentAgentId: 'parent' };
  const ctx: any = { person: { id: 'owner' }, agent, deps: { now: () => 3, store: { updateAgent: vi.fn(async () => agent), getAgent: vi.fn(async () => ({ conversationId: 'parent-conversation' })) }, bus: { toPerson: vi.fn() }, runtime: { managerFor: () => 'root', deliver } } };
  const tools = controlTools(ctx, { spawnWorker, messageWorker: vi.fn(), stopAgent: vi.fn(), archiveAgent: vi.fn() });
  await tools.find(t => t.name === 'workers')!.execute('spawn', { action: 'spawn', goalId: 'goal', text: 'Do it', name: 'Grandchild' }, undefined, undefined, {} as any);
  expect(spawnWorker).toHaveBeenCalledWith('owner', 'goal', 'Grandchild', 'Do it', 'child');
  await tools.find(t=>t.name==='workers')!.execute('exact',{action:'spawn',goalId:'goal',name:'Exact',text:'Same profile',model:'gpt-6-astra',thinking:'high'},undefined,undefined,{} as any);
  expect(spawnWorker).toHaveBeenLastCalledWith('owner','goal','Exact','Same profile','child',{model:'gpt-6-astra',thinking:'high'});
  await expect(tools.find(t=>t.name==='workers')!.execute('partial',{action:'spawn',goalId:'goal',text:'No silent default',model:'gpt-6-astra'},undefined,undefined,{} as any)).rejects.toThrow('both model and thinking');
  await tools.find(t => t.name === 'report')!.execute('report', { status: 'done', text: 'Finished' }, undefined, undefined, {} as any);
  expect(deliver).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'parent', conversationId: 'parent-conversation', fromId: 'child' }));
});
it('a worker messages its parent mid-task as a labelled note without ending its own run', async () => {
  const deliver = vi.fn(), appendMessage = vi.fn(async (m: object) => ({ id: 'note', ...m })), updateAgent = vi.fn();
  const agent = { id: 'child', name: 'Child', role: 'worker', parentAgentId: 'manager:owner', goalId: 'goal' };
  const parent = { id: 'manager:owner', ownerId: 'owner', role: 'manager', conversationId: 'manager-conversation' };
  const ctx: any = { person: { id: 'owner' }, agent, deps: { store: { getAgent: vi.fn(async (id: string) => id === parent.id ? parent : null), appendMessage, updateAgent }, bus: { toConversation: vi.fn(), toPerson: vi.fn() }, runtime: { managerFor: () => parent.id, deliver } } };
  const messageWorker = vi.fn();
  const workers = controlTools(ctx, { spawnWorker: vi.fn(), messageWorker, stopAgent: vi.fn(), archiveAgent: vi.fn() }).find(t => t.name === 'workers')!;
  await workers.execute('m', { action: 'message', id: 'manager:owner', text: 'Repo is public: https://example.test' }, undefined, undefined, {} as any);
  expect(appendMessage).toHaveBeenCalledWith(expect.objectContaining({ conversationId: 'manager-conversation', authorId: 'child', role: 'notice' }));
  expect(deliver).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'manager:owner', kind: 'note', fromId: 'child', conversationId: 'manager-conversation', text: expect.stringContaining('Repo is public: https://example.test') }));
  expect(messageWorker).not.toHaveBeenCalled(); expect(updateAgent).not.toHaveBeenCalled();
  await expect(workers.execute('m', { action: 'message', id: 'owner', text: 'x' }, undefined, undefined, {} as any)).rejects.toThrow('use id manager:owner');
});
describe('agent messages reach a running agent', () => {
  function running(report: AgentInfo['lastReport'] = null) {
    const h = harness('worker', report);
    const steering: string[] = [];
    const prompts: { text: string; finish: () => void }[] = [];
    const session = {
      prompt: vi.fn((text: string) => new Promise<void>(resolve => prompts.push({ text, finish: resolve }))),
      steer: vi.fn(async (text: string) => { steering.push(text); }),
      getSteeringMessages: () => steering,
      clearQueue: vi.fn(() => { steering.length = 0; }),
      subscribe: () => () => {}, abort: vi.fn(async () => prompts.at(-1)?.finish()), dispose: vi.fn(),
    };
    const internal = h.runtime as any;
    delete internal.runTurn;
    internal.lane('worker').session = session;
    Object.assign(h.deps, { now: () => 5, bus: { ...h.deps.bus, toConversation: vi.fn(), activity: () => null } });
    Object.assign(h.deps.store, { appendMessage: vi.fn(async () => ({ id: 'error-notice' })) });
    return { ...h, session, steering, prompts, lane: internal.lane('worker') };
  }
  const message = (text: string) => ({ agentId: 'worker', fromId: 'parent', conversationId: 'conversation', kind: 'agent' as const, text });
  it('joins the current turn before its next model call', async () => {
    const r = running();
    r.runtime.deliver(message('work')); await tick(); await tick();
    r.runtime.deliver(message('stop and sanitise')); await r.lane.steering;
    expect(r.session.steer).toHaveBeenCalledWith('[agent from parent]\nstop and sanitise', []);
    expect(r.runtime.turnOf('worker')).toEqual({ startedAt: 5, queued: 0, inputs: [{ kind: 'agent', fromId: 'parent', text: 'work' }, { kind: 'agent', fromId: 'parent', text: 'stop and sanitise' }] });
    r.steering.length = 0; r.prompts[0]!.finish(); await r.lane.task;
    expect(r.runtime.turnOf('worker')).toBeNull();
    expect(r.session.prompt).toHaveBeenCalledTimes(1);
    expect(r.errors).toEqual([]);
  });
  it('a message the turn ended before reading starts the next turn, and a done worker stays available for it', async () => {
    const r = running({ status: 'done', text: 'Finished', at: 3 });
    r.runtime.deliver(message('work')); await tick(); await tick();
    r.runtime.deliver(message('one more thing')); await r.lane.steering;
    r.prompts[0]!.finish(); await vi.waitFor(() => expect(r.session.prompt).toHaveBeenCalledTimes(2));
    expect(r.session.clearQueue).toHaveBeenCalled();
    expect(r.prompts[1]!.text).toBe('[agent from parent]\none more thing');
    expect(r.agent().archived).toBe(false);
    r.prompts[1]!.finish(); await r.lane.task;
    expect(r.agent()).toMatchObject({ archived: true, state: 'stopped' });
    expect(r.errors).toEqual([]);
  });
  it('a restart retains a message the cut-off turn never read', async () => {
    const r = running();
    r.runtime.deliver(message('work')); await tick(); await tick();
    r.runtime.deliver(message('unread')); await r.lane.steering;
    await r.runtime.shutdown();
    const saved = (r.deps.store.savePendingInputs as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(saved.map((input: { text: string }) => input.text)).toEqual(['unread']);
  });
});
