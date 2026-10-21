import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Type } from 'typebox';
import { fauxAssistantMessage, fauxProvider, fauxText, fauxThinking, fauxToolCall, type FauxResponseFactory } from '@earendil-works/pi-ai';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { AgentRuntime, TRANSIENT_RETRY } from './runtime.js';
import type { AgentInput, Deps } from '../types.js';

// 2026-10-19: Anthropic's streaming cyber classifier stopped ordinary worker turns mid-response (thinking and a
// partial tool call, then stop_reason "refusal") for ff75f831 at 19:08Z and 19:35Z and 21624d87 at 17:53Z, leaving
// both idle until Kenaznia nudged them. A provider that refuses the same way drives the real runtime and Pi session.
const REFUSAL = "This request triggered restrictions on violative cyber content and was blocked under Anthropic's Usage Policy.";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

type Reply = (model: string) => ReturnType<typeof fauxAssistantMessage>;
const refuse: Reply = () => fauxAssistantMessage([fauxThinking('decode the probe dump'), fauxToolCall('effect', { step: 'partial' }, { id: 'refused-call' })], { stopReason: 'error', errorMessage: REFUSAL });
const step = (models: string[], reply: Reply): FauxResponseFactory => (_context, _options, _state, model) => { models.push(model.id); return reply(model.id); };

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'kenan-refusal-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const faux = fauxProvider({ models: [{ id: 'opus-5-5', reasoning: true }, { id: 'fable-5-1', reasoning: true }, { id: 'haiku-5-5', reasoning: true }] });
  const modelRuntime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, refreshOnCreate: false });
  modelRuntime.registerNativeProvider(faux.provider);
  const effect = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'effect committed' }], details: {} }));
  const agent = { id: 'w', name: 'kernel worker', ownerId: 'p', role: 'worker', parentAgentId: 'manager:p', goalId: 'g', model: 'opus-5-5', conversationId: 'c', archived: false, state: 'idle' };
  const parent = { id: 'manager:p', ownerId: 'p', role: 'manager', conversationId: 'pc', archived: false, state: 'idle' };
  let n = 0;
  const messages = new Map<string, any>();
  const errors: string[] = [];
  const store = {
    getAgent: vi.fn(async (id: string) => id === parent.id ? parent : agent), getConversation: vi.fn(async () => null),
    updateAgent: vi.fn(async (id: string, patch: object) => Object.assign(id === parent.id ? parent : agent, patch)),
    awaitingReply: vi.fn(async () => false),
    markLatency: vi.fn(async () => {}), recordModelCall: vi.fn(async () => {}), logError: vi.fn(async (_scope: string, message: string) => { errors.push(message); }),
    conversationMembers: vi.fn(async () => []), pendingWakes: vi.fn(async () => []),
    appendMessage: vi.fn(async (m: object) => { const row = { ...m, id: `m${++n}` }; messages.set(row.id, row); return row; }),
    updateMessage: vi.fn(async (id: string, patch: object) => Object.assign(messages.get(id), patch)),
    savePendingInputs: vi.fn(async () => {}), takePendingInputs: vi.fn(async () => []),
    markRunningInterrupted: vi.fn(async () => {}), listInterrupted: vi.fn(async () => []),
  };
  const deps = { config: { people: [] }, store, bus: { toPerson: vi.fn(), toConversation: vi.fn(), activity: () => null }, now: () => 1 } as unknown as Deps;
  const settingsManager = SettingsManager.inMemory({ retry: { ...TRANSIENT_RETRY, baseDelayMs: 1, maxAgentDelayMs: 1 }, compaction: { enabled: false } });
  const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, systemPrompt: 'test' });
  await loader.reload();
  const { session } = await createAgentSession({ cwd: dir, agentDir: dir, modelRuntime, model: faux.getModel('opus-5-5')!, settingsManager, resourceLoader: loader, sessionManager: SessionManager.open(join(dir, 'session.jsonl'), dir, dir), noTools: 'builtin', customTools: [{ name: 'effect', label: 'effect', description: 'fixture effect', parameters: Type.Object({ step: Type.String() }), execute: effect }], tools: ['effect'] });
  const runtime = new AgentRuntime(deps);
  const lane = (runtime as any).lane('w');
  lane.session = session;
  (runtime as any).lane('manager:p').pumping = true; // the launcher's own turns are outside this fixture; its inputs stay queued for inspection
  (runtime as any).recoverRefusals('w', lane, session, faux.getModel('opus-5-5'), [faux.getModel('fable-5-1')!, faux.getModel('haiku-5-5')!]);
  cleanups.push(() => runtime.shutdown());
  const send = (text: string) => runtime.deliver({ agentId: 'w', kind: 'agent', text, fromId: 'manager:p', conversationId: 'c' });
  const settled = async () => { while (lane.task) { const task = lane.task; await task; if (lane.task === task) break; } };
  const parentInputs = () => ((runtime as any).lane('manager:p').queue as AgentInput[]).concat((runtime as any).lane('manager:p').active ?? []);
  return { faux, session, effect, store, errors, messages, send, settled, parentInputs, runtime };
}

describe('a provider refusal on an ordinary agent turn', () => {
  it('sends the same request to the next fallback within the turn, keeps only its response, and moves the refusing model last for the rest of the turn', async () => {
    const h = await fixture(); const models: string[] = [];
    h.faux.setResponses([
      step(models, refuse),
      step(models, () => fauxAssistantMessage([fauxThinking('run the step'), fauxToolCall('effect', { step: 'one' }, { id: 'kept-call' })], { stopReason: 'toolUse' })),
      step(models, () => fauxAssistantMessage(fauxText('step one done'))),
    ]);
    h.send('run step one'); await h.settled();
    expect(models).toEqual(['opus-5-5', 'fable-5-1', 'fable-5-1']);
    expect(h.effect).toHaveBeenCalledOnce();
    expect((h.effect.mock.calls[0] as unknown[])[1]).toEqual({ step: 'one' });
    const assistants = h.session.messages.filter(m => m.role === 'assistant');
    expect(assistants.map(m => [m.model, m.stopReason])).toEqual([['fable-5-1', 'toolUse'], ['fable-5-1', 'stop']]);
    expect(JSON.stringify(h.session.messages)).not.toContain('refused-call');
    expect(h.session.messages.filter(m => m.role === 'user')).toHaveLength(1);
    expect(h.errors).toEqual([expect.stringMatching(/^model_refusal_recovered: opus-5-5 refused \(This request triggered restrictions on violative cyber content.*\); the same request went to fable-5-1$/)]);
    expect(h.store.recordModelCall.mock.calls.map(([call]: any) => call.model)).toEqual(['opus-5-5', 'fable-5-1', 'fable-5-1']);
    expect([...h.messages.values()].filter(m => m.role === 'assistant').map(m => [m.state, m.text])).toEqual([['done', ''], ['done', 'step one done']]);

    models.length = 0;
    h.faux.setResponses([step(models, () => fauxAssistantMessage(fauxText('next turn')))]);
    h.send('next'); await h.settled();
    expect(models).toEqual(['opus-5-5']);
  });

  it('when every model refuses, continues the agent once with a refusal notice instead of ending idle', async () => {
    const h = await fixture(); const models: string[] = [];
    h.faux.setResponses([step(models, refuse), step(models, refuse), step(models, refuse), step(models, () => fauxAssistantMessage(fauxText('took a different route')))]);
    h.send('decode the dump'); await h.settled();
    expect(models).toEqual(['opus-5-5', 'fable-5-1', 'haiku-5-5', 'opus-5-5']);
    const users = h.session.messages.filter(m => m.role === 'user').map(m => JSON.stringify(m.content));
    expect(users).toHaveLength(2);
    expect(users[1]).toContain('[refusal from system]');
    expect(users[1]).toContain('refused by the provider\'s content filter on every configured model (opus-5-5, fable-5-1, haiku-5-5)');
    expect(h.session.messages.at(-1)).toMatchObject({ role: 'assistant', stopReason: 'stop' });
    expect(h.effect).not.toHaveBeenCalled();
    expect(h.errors.filter(e => e.startsWith('model_refusal_recovered'))).toHaveLength(2);
    expect(h.errors.filter(e => e.startsWith('model_refusal_continued'))).toHaveLength(1);
    expect(h.parentInputs()).toEqual([]);
  });

  it('never loops: a refused continuation tells the launcher and leaves the run idle', async () => {
    const h = await fixture(); const models: string[] = [];
    h.faux.setResponses(Array.from({ length: 6 }, () => step(models, refuse)));
    h.send('decode the dump'); await h.settled();
    expect(models).toHaveLength(6);
    expect(h.faux.getPendingResponseCount()).toBe(0);
    expect(h.session.messages.filter(m => m.role === 'user')).toHaveLength(2);
    expect(h.errors.filter(e => e.startsWith('model_refusal_unrecovered'))).toHaveLength(1);
    const notes = h.parentInputs();
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ agentId: 'manager:p', kind: 'note', fromId: 'w' });
    expect(notes[0]!.text).toContain('refused its requests twice in a row');
    expect([...h.messages.values()].some(m => m.notice === 'worker_note' && m.conversationId === 'pc')).toBe(true);
  });
});
