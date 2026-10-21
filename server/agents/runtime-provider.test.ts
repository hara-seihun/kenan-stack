import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Type } from 'typebox';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { AgentRuntime, RESTART_NOTICE, TRANSIENT_RETRY } from './runtime.js';
import type { AgentInput, Deps } from '../types.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const failure = (errorMessage: string) => fauxAssistantMessage([], { stopReason: 'error', errorMessage });

/** Real Pi session and JSONL, scripted local provider, in-memory runtime store. No broker or network. */
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'kenan-runtime-provider-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const faux = fauxProvider();
  const modelRuntime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, refreshOnCreate: false });
  modelRuntime.registerNativeProvider(faux.provider);
  const effect = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'effect committed' }], details: {} }));
  const agent = { id: 'w', ownerId: 'p', role: 'worker', conversationId: 'c', archived: false, state: 'idle' };
  let pending: AgentInput[] = [];
  let n = 0;
  const messages = new Map<string, any>();
  const store = {
    getAgent: vi.fn(async () => agent), listAgents: vi.fn(async () => [agent]), getConversation: vi.fn(async () => null),
    updateAgent: vi.fn(async (_id: string, patch: object) => Object.assign(agent, patch)),
    awaitingReply: vi.fn(async () => false),
    markLatency: vi.fn(async () => {}), recordModelCall: vi.fn(async () => {}), logError: vi.fn(async () => {}),
    conversationMembers: vi.fn(async () => []),
    appendMessage: vi.fn(async (m: object) => { const row = { ...m, id: `m${++n}` }; messages.set(row.id, row); return row; }),
    updateMessage: vi.fn(async (id: string, patch: object) => Object.assign(messages.get(id), patch)),
    savePendingInputs: vi.fn(async (inputs: AgentInput[]) => { pending = structuredClone(inputs); }),
    takePendingInputs: vi.fn(async () => { const kept = pending; pending = []; return kept; }),
    markRunningInterrupted: vi.fn(async () => { if (agent.state === 'running') agent.state = 'interrupted'; }),
    listInterrupted: vi.fn(async () => agent.state === 'interrupted' ? ['w'] : []),
  };
  const deps = { config: { people: [] }, store, bus: { toPerson: vi.fn(), toConversation: vi.fn(), activity: () => null }, now: () => 1 } as unknown as Deps;
  async function open(delayMs = 1) {
    const settingsManager = SettingsManager.inMemory({ retry: { ...TRANSIENT_RETRY, baseDelayMs: delayMs, maxAgentDelayMs: delayMs }, compaction: { enabled: false } });
    const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, systemPrompt: 'test' });
    await loader.reload();
    const { session } = await createAgentSession({ cwd: dir, agentDir: dir, modelRuntime, model: faux.getModel(), settingsManager, resourceLoader: loader, sessionManager: SessionManager.open(join(dir, 'session.jsonl'), dir, dir), noTools: 'builtin', customTools: [{ name: 'effect', label: 'effect', description: 'fixture effect', parameters: Type.Object({}), execute: effect }], tools: ['effect'] });
    const runtime = new AgentRuntime(deps);
    (runtime as any).lane('w').session = session;
    const send = (kind: AgentInput['kind'], text: string) => runtime.deliver({ agentId: 'w', kind, text, fromId: 'p', conversationId: 'c' });
    const settled = () => (runtime as any).lane('w').task as Promise<void>;
    cleanups.push(() => runtime.shutdown());
    return { runtime, session, send, settled };
  }
  return { faux, effect, agent, store, open, pending: () => pending, messages };
}

describe('mainline runtime provider continuation (not the superseded bounded wrapper)', () => {
  it('survives repeated provider faults after an effect in the same turn without replaying input or tool', async () => {
    const h = await fixture(); const run = await h.open();
    const faults = ['Connection error.', '529 overloaded', '503 Service Unavailable', 'socket hang up', 'terminated', 'Connection error.', '529 overloaded'];
    h.faux.setResponses([fauxAssistantMessage(fauxToolCall('effect', {}, { id: 'original-effect' }), { stopReason: 'toolUse' }), ...faults.map(failure), fauxAssistantMessage('finished')]);
    run.send('agent', 'original full request'); await run.settled();
    expect(h.effect).toHaveBeenCalledOnce();
    expect(h.faux.state.callCount).toBe(faults.length + 2);
    expect(run.session.messages.filter(m => m.role === 'user')).toHaveLength(1);
    expect(run.session.messages.filter(m => m.role === 'toolResult')).toHaveLength(1);
    expect(run.session.messages.at(-1)).toMatchObject({ stopReason: 'stop' });
    expect(h.agent.state).toBe('idle');
  });

  it('shutdown during backoff retains unprompted input, then startup continues the persisted transcript with a notice, not original-input replay', async () => {
    const h = await fixture(); const run = await h.open(60_000);
    h.faux.setResponses([fauxAssistantMessage(fauxToolCall('effect', {}, { id: 'original-effect' }), { stopReason: 'toolUse' }), failure('503 Service Unavailable')]);
    run.send('agent', 'original full request');
    await vi.waitFor(() => expect(run.session.isRetrying).toBe(true));
    run.send('wake', 'not yet prompted');
    await run.runtime.shutdown();
    expect(h.agent.state).toBe('interrupted');
    expect(h.pending().map(i => i.text)).toEqual(['not yet prompted']);
    const resumed = await h.open();
    h.faux.setResponses([fauxAssistantMessage('continued from the saved effect'), fauxAssistantMessage('handled retained wake')]);
    await resumed.runtime.start(); await resumed.settled();
    const users = resumed.session.messages.filter(m => m.role === 'user');
    expect(users).toHaveLength(3);
    expect(JSON.stringify(users[0])).toContain('original full request');
    expect(JSON.stringify(users[1])).toContain(RESTART_NOTICE);
    expect(JSON.stringify(users[2])).toContain('not yet prompted');
    expect(JSON.stringify(users.slice(1))).not.toContain('original full request');
    expect(resumed.session.messages.filter(m => m.role === 'toolResult')).toHaveLength(1);
    expect(h.effect).toHaveBeenCalledOnce();
    expect(h.agent.state).toBe('idle');
    expect(h.store.takePendingInputs).toHaveBeenCalledOnce();
  });

  it('an explicit archive cancels backoff and startup does not restart that stopped work', async () => {
    const h = await fixture(); const run = await h.open(60_000);
    h.faux.setResponses([failure('Connection error.'), fauxAssistantMessage('must not run')]);
    run.send('agent', 'work');
    await vi.waitFor(() => expect(run.session.isRetrying).toBe(true));
    await run.runtime.archiveAgent('w', true); await run.settled();
    await run.runtime.shutdown();
    const resumed = await h.open(); await resumed.runtime.start();
    expect(h.faux.state.callCount).toBe(1);
    expect(h.faux.getPendingResponseCount()).toBe(1);
    expect(h.agent).toMatchObject({ archived: true, state: 'stopped' });
  });
});
