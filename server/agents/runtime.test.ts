import { describe, expect, it, vi } from 'vitest';
import { AgentRuntime, PREEMPT_NOTICE, describeSilentErrors } from './runtime.js';
import type { AgentInput, Deps } from '../types.js';
import { ownerProcess } from '../tools/owner.js';
const tick = () => new Promise(resolve => setImmediate(resolve));
function harness() {
  const prompts: string[] = [];
  let finish: (() => void) | undefined;
  const session = {
    prompt: vi.fn(async (text: string) => { prompts.push(text); await new Promise<void>(resolve => { finish = resolve; }); }),
    abort: vi.fn(async () => { finish?.(); }), steer: vi.fn(async () => {}), getSteeringMessages: () => [], clearQueue: vi.fn(), dispose: vi.fn(), subscribe: vi.fn(() => () => {}),
  };
  const deps = { store: { getAgent: vi.fn(async () => ({ id: 'a', ownerId: 'p' })), getConversation: vi.fn(async () => null), updateAgent: vi.fn(async () => ({ id: 'a', ownerId: 'p' })), markLatency: vi.fn(async () => {}), logError: vi.fn(async () => {}), savePendingInputs: vi.fn(async () => {}), pendingWakes: vi.fn(async () => []) }, bus: { toPerson: vi.fn(), toConversation: vi.fn(), activity: () => null }, now: () => 1 } as unknown as Deps;
  const runtime = new AgentRuntime(deps);
  (runtime as any).lane('a').session = session;
  const send = (kind: AgentInput['kind'], text: string) => runtime.deliver({ agentId: 'a', kind, text, fromId: 'p', conversationId: 'c' });
  return { runtime, deps, prompts, session, send, finish: () => finish?.() };
}
describe('agent scheduling', () => {
  it('preempts started background work for human input and resumes it with a notice instead of sending it again', async () => {
    const h = harness(); h.send('report', 'background'); await tick();
    h.send('human', 'urgent'); await tick();
    expect(h.session.abort).toHaveBeenCalledOnce();
    expect(h.prompts).toEqual(['[report from p]\nbackground', `[notice from system]\n${PREEMPT_NOTICE}\n\nurgent`]);
    h.finish(); await tick();
    expect(h.prompts).toHaveLength(2);
    h.send('human', 'later'); await tick();
    expect(h.prompts[2]).toBe('later');
    await h.runtime.shutdown();
    expect((h.deps.store.savePendingInputs as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toEqual([]);
  });
  it('requeues background input preempted before its turn started', async () => {
    const h = harness();
    let ready!: () => void;
    const gate = new Promise<void>(resolve => { ready = resolve; });
    (h.runtime as any).lane('a').session = undefined;
    (h.runtime as any).session = () => gate.then(() => h.session);
    h.send('report', 'background'); await tick();
    h.send('human', 'urgent'); ready(); await tick(); await tick();
    expect(h.prompts).toEqual(['urgent']);
    h.finish(); await tick(); await tick();
    expect(h.prompts).toEqual(['urgent', '[report from p]\nbackground']);
    h.finish(); await tick(); await h.runtime.shutdown();
  });
  it('steers human input into a human turn without aborting it', async () => {
    const h = harness(); h.send('human', 'first'); await tick(); h.send('human', 'clarification'); await tick();
    expect(h.session.steer).toHaveBeenCalledWith('clarification', []); expect(h.session.abort).not.toHaveBeenCalled();
    h.finish(); await tick(); await h.runtime.shutdown();
  });
  it('joins agent messages and wakes to the running turn and batches other background inputs FIFO behind it', async () => {
    const h = harness(); h.send('human', 'first'); await tick();
    h.send('wake', 'one'); h.send('agent', 'two'); h.send('heartbeat', 'three'); h.send('restart', 'four'); await tick(); await tick();
    expect(h.session.steer).toHaveBeenCalledWith('[wake from p]\none', []);
    expect(h.session.steer).toHaveBeenCalledWith('[agent from p]\ntwo', []);
    h.finish(); await tick(); await tick();
    expect(h.prompts[1]).toBe('[heartbeat from p]\nthree\n\n[restart from p]\nfour');
    h.finish(); await tick(); await h.runtime.shutdown();
  });
});
it('runs shell operations with the owning uid, home and cwd', async () => {
  const person = { uid: process.getuid!(), gid: process.getgid!(), home: '/tmp', unixUser: 'owner' } as any;
  const result = await ownerProcess({ kind: 'callerCgroup' }, person, process.execPath, ['-e', 'console.log(JSON.stringify({uid:process.getuid(),cwd:process.cwd(),home:process.env.HOME}))']);
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.output.toString())).toEqual({ uid: person.uid, cwd: '/tmp', home: '/tmp' });
});
it('manager worker controls reject a worker outside the owner list', async () => {
  const { controlTools } = await import('../tools/control.js');
  const controls = { spawnWorker: vi.fn(), messageWorker: vi.fn(), stopAgent: vi.fn(), archiveAgent: vi.fn() };
  const ctx: any = { person: { id: 'owner' }, agent: { role: 'manager' }, deps: { store: { getAgent: vi.fn(async () => ({ id: 'other-worker', role: 'worker', ownerId: 'other-owner' })) } } };
  const workerTool = controlTools(ctx, controls).find(tool => tool.name === 'workers')!;
  await expect(workerTool.execute('call', { action: 'message', id: 'other-worker', text: 'go' }, undefined, undefined, {} as any)).rejects.toThrow('Worker other-worker not found');
  expect(controls.messageWorker).not.toHaveBeenCalled();
});
describe('provider messages', () => {
  it('describes an error tool result that has no output, as in the stored a5c784fa history', () => {
    const silent = { role: 'toolResult' as const, toolCallId: 't', toolName: 'mail', content: [{ type: 'text' as const, text: '' }], isError: true, timestamp: 1 };
    const [described] = describeSilentErrors([silent]);
    expect(described).toMatchObject({ role: 'toolResult', isError: true, content: [{ type: 'text', text: expect.stringMatching(/mail.*failed/) }] });
    const kept = [{ ...silent, content: [{ type: 'text' as const, text: 'exit 1' }] }, { ...silent, isError: false }];
    expect(describeSilentErrors(kept)).toEqual(kept);
  });
});
describe('turn outcomes', () => {
  function streaming(role: 'worker' | 'manager' = 'worker', input: { kind: AgentInput['kind']; text: string } = { kind: 'agent', text: 'work' }, world: { awaitingReply?: boolean; wakes?: boolean } = {}) {
    let listener: (event: unknown) => void = () => {};
    let end: (() => void) | undefined;
    const messages = new Map<string, { id: string; state: string; text: string; role?: string; notice?: string; display?: string }>();
    const errors: string[] = [];
    const failMidTurn = (errorMessage: string) => { listener({ type: 'message_start', message: { role: 'assistant' } }); listener({ type: 'message_end', message: { role: 'assistant', content: [], model: 'm', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } }, stopReason: 'error', errorMessage } }); end?.(); };
    const session = {
      prompt: vi.fn(() => new Promise<void>(resolve => { end = resolve; })),
      abort: vi.fn(async () => failMidTurn('This operation was aborted')),
      subscribe: (fn: (event: unknown) => void) => { listener = fn; return () => {}; },
      steer: vi.fn(), getSteeringMessages: () => [], clearQueue: vi.fn(), dispose: vi.fn(),
    };
    let n = 0;
    const agent = { id: 'w', ownerId: 'p', role, conversationId: 'c', archived: false };
    const deps = {
      store: {
        getAgent: vi.fn(async () => agent), awaitingReply: vi.fn(async () => world.awaitingReply === true), listAgents: vi.fn(async () => [agent]), getConversation: vi.fn(async () => null), updateAgent: vi.fn(async (_id: string, patch: object) => Object.assign(agent, patch)),
        markLatency: vi.fn(async () => {}), savePendingInputs: vi.fn(async () => {}), recordModelCall: vi.fn(async () => {}), conversationMembers: vi.fn(async () => []), pendingWakes: vi.fn(async () => []),
        logError: vi.fn(async (_scope: string, message: string) => { errors.push(message); }),
        appendMessage: vi.fn(async (m: { text: string; state: string }) => { const message = { ...m, id: `m${++n}` }; messages.set(message.id, message); return message; }),
        updateMessage: vi.fn(async (id: string, patch: object) => Object.assign(messages.get(id)!, patch)),
      },
      bus: { toPerson: vi.fn(), toConversation: vi.fn(), activity: () => null }, now: () => 1,
    } as unknown as Deps;
    const runtime = new AgentRuntime(deps);
    (runtime as any).lane('w').session = session;
    runtime.deliver({ agentId: 'w', ...input, fromId: 'p', conversationId: 'c' });
    const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } };
    /** One model response: streamed text, then its tool calls run. */
    const respond = (deltas: string[], tools: string[] = []) => {
      listener({ type: 'message_start', message: { role: 'assistant' } });
      for (const delta of deltas) listener({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta } });
      listener({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: deltas.join('') }, ...tools.map(name => ({ type: 'toolCall', id: name, name, arguments: {} }))], model: 'm', usage, stopReason: tools.length ? 'toolUse' : 'stop' } });
      for (const name of tools) { listener({ type: 'tool_execution_start', toolCallId: name, toolName: name, args: {} }); listener({ type: 'tool_execution_end', toolCallId: name, result: {}, isError: false }); }
    };
    const broadcast = () => (deps.bus.toConversation as ReturnType<typeof vi.fn>).mock.calls.map(call => call[1]);
    return { runtime, session, agent, errors, messages: () => [...messages.values()], failMidTurn, respond, broadcast, end: () => end?.(), settled: () => (runtime as any).lane('w').task as Promise<void> };
  }
  it('archiving a running worker ends its turn as stopped, not as an error', async () => {
    const s = streaming(); await tick(); await tick();
    await s.runtime.archiveAgent('w', true); await s.settled();
    expect(s.errors).toEqual([]);
    expect(s.messages()).toEqual([expect.objectContaining({ state: 'stopped', text: '' })]);
  });
  it('a provider stream that dies on its own is still an error', async () => {
    const s = streaming(); await tick(); await tick();
    s.failMidTurn('This operation was aborted'); await s.settled();
    expect(s.errors).toEqual(['This operation was aborted']);
    expect(s.messages()).toEqual([expect.objectContaining({ state: 'error' })]);
  });
  it('a manager answering background input with NO_REPLY streams nothing and folds its work away; a real reply shows', async () => {
    const s = streaming('manager', { kind: 'report', text: 'Worker W reports done' }); await tick(); await tick();
    s.respond(['', 'NO', '_REP'], ['workers']);
    s.respond(['NO_', 'REPLY']); s.end(); await s.settled();
    expect(s.messages().map(m => [m.role, m.notice ?? m.text, m.display])).toEqual([
      ['notice', 'worker_report', undefined], ['assistant', 'NO_REP', 'background'], ['tool', 'workers', 'background'], ['assistant', 'NO_REPLY', 'silent'],
    ]);
    expect(s.broadcast().filter(event => event.type === 'delta')).toEqual([]);

    const r = streaming('manager', { kind: 'wake', text: 'Signal from Dave' }); await tick(); await tick();
    r.respond([], ['wake']); r.respond(['NO', ' — Dave replied']); r.end(); await r.settled();
    expect(r.messages().map(m => [m.role, m.display])).toEqual([['notice', undefined], ['assistant', 'background'], ['tool', 'background'], ['assistant', 'shown']]);
    expect(r.broadcast().filter(event => event.type === 'delta')).toEqual([]);
    expect(r.messages()[3]).toMatchObject({ text: 'NO — Dave replied' });
  });
  // Beta 2026-10-21 07:04–07:05Z: Alice's message joined Kenaznia's turn, Kenaznia answered it, then a peer note steered in and
  // the turn ended NO_REPLY, which folded the answer to her into the background.
  it('a turn answering a person keeps its words shown when it ends NO_REPLY; only its wordless work folds', async () => {
    const s = streaming('manager', { kind: 'human', text: 'can we push the app?' }); await tick(); await tick();
    s.respond([], ['goals']); s.respond(["Yes, I've put an agent on it."]);
    s.runtime.deliver({ agentId: 'w', kind: 'note', text: 'peer news', fromId: 'peer:acme', conversationId: 'c' }); await tick();
    s.respond([], ['peer']); s.respond(['NO_REPLY']); s.end(); await s.settled();
    expect(s.messages().filter(m => m.role !== 'notice').map(m => [m.text, m.display])).toEqual([
      ['', 'background'], ['goals', 'background'], ["Yes, I've put an agent on it.", 'shown'], ['', 'background'], ['peer', 'background'], ['NO_REPLY', 'silent'],
    ]);
  });
  it('a restart continuing an unanswered person turn shows its answer even when it ends NO_REPLY', async () => {
    const s = streaming('manager', { kind: 'restart', text: 'continue' }, { awaitingReply: true }); await tick(); await tick();
    s.respond(['Here is the answer you asked for.'], ['bash']); s.respond(['NO_REPLY']); s.end(); await s.settled();
    expect(s.messages().filter(m => m.role !== 'notice').map(m => [m.text, m.display])).toEqual([['Here is the answer you asked for.', 'shown'], ['bash', 'background'], ['NO_REPLY', 'silent']]);
    const r = streaming('manager', { kind: 'restart', text: 'continue' }, { awaitingReply: false }); await tick(); await tick();
    r.respond([], ['bash']); r.respond(['NO_REPLY']); r.end(); await r.settled();
    expect(r.messages().filter(m => m.role !== 'notice').map(m => m.display)).toEqual(['background', 'background', 'silent']);
  });
  it('a worker that handed off its wait ends archived; a worker keeping a short wake stays idle with its session', async () => {
    const s = streaming('worker', { kind: 'agent', text: 'wait for the release' }); await tick(); await tick();
    Object.assign(s.agent, { lastReport: { status: 'handed_off', text: 'Handed off to manager:p', at: 1 } });
    s.respond(['Handed off.'], ['wake']); s.end(); await s.settled();
    expect(s.agent).toMatchObject({ state: 'stopped', archived: true });
    const r = streaming('worker', { kind: 'agent', text: 'wait ten minutes for the build' }); await tick(); await tick();
    r.respond(['Waiting on the build.'], ['wake']); r.end(); await r.settled();
    expect(r.agent).toMatchObject({ state: 'idle', archived: false });
    expect(r.session.dispose).not.toHaveBeenCalled();
  });
});
