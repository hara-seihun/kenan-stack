import { describe, expect, it } from 'vitest';
import { SessionManager, type AgentSession, type ModelRuntime } from '@earendil-works/pi-coding-agent';
import { installContextBudget, contextBudget, type CompactionOutcome } from './context-budget.js';

// 2026-10-19 20:53Z: worker 36e1d1e0's summaries were refused ("violative cyber content") on kernel/benchmark
// history; every later request retried the whole summary and the run had to be replaced. This drives the real
// Pi summary call against a provider that refuses the way Anthropic does (stop_reason "refusal" → error).
const REFUSAL = "This request triggered restrictions on violative cyber content and was blocked under Anthropic's Usage Policy.";
const TASK = 'Worker task: ship the Android build and keep every engine token-exact.';

function fakeProvider(refuses: (model: string, prompt: string) => boolean) {
  const prompts: { model: string; prompt: string }[] = [];
  const stream = (model: { id: string }, context: { messages: { content: unknown }[] }) => {
    const prompt = JSON.stringify(context.messages);
    prompts.push({ model: model.id, prompt });
    const base = { role: 'assistant', api: 'anthropic-messages', provider: 'anthropic', model: model.id, timestamp: Date.now(),
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    const message = refuses(model.id, prompt)
      ? { ...base, content: [], stopReason: 'error', errorMessage: REFUSAL }
      : { ...base, content: [{ type: 'text', text: `Checkpoint ${prompts.length} by ${model.id}: continue the APK work.` }], stopReason: 'stop' };
    return { result: async () => message };
  };
  return { prompts, stream };
}

function worker(refuses: (model: string, prompt: string) => boolean, fallbacks: string[] = []) {
  const manager = SessionManager.inMemory('/tmp');
  manager.appendMessage({ role: 'system', content: 'system', timestamp: 1 });
  manager.appendMessage({ role: 'user', content: TASK, timestamp: 2 });
  const provider = fakeProvider(refuses);
  const model = { id: 'claude', contextWindow: 10000, maxTokens: 1024, api: 'anthropic-messages', reasoning: true, compat: {} };
  const agent = { state: { messages: [] }, prepareRequest: undefined, convertToLlm: async (messages: unknown[]) => messages, streamFunction: provider.stream };
  const session = { agent, sessionManager: manager } as unknown as AgentSession;
  const runtime = { getAuth: async () => ({ auth: { apiKey: 'subscription-marker' } }) } as unknown as ModelRuntime;
  const outcomes: CompactionOutcome[] = [];
  const refusalFallbacks = fallbacks.map(id => ({ ...model, id })) as never[];
  installContextBudget(session, runtime, { started() {}, recovered: outcome => { outcomes.push(outcome); } }, { pinning: 'pin-first-task', refusalFallbacks, stream: provider.stream as never });
  const request = () => session.agent.prepareRequest!({ context: { messages: manager.buildSessionProjection().messages, tools: [] }, model: model as never, thinkingLevel: 'off' });
  const work = (from: number, steps: number) => {
    for (let i = from; i < from + steps; i++) {
      manager.appendMessage({ role: 'assistant', content: [{ type: 'thinking', thinking: `probe kernel KERNEL_PROBE step ${i}` }, { type: 'toolCall', id: `c${i}`, name: 'bash', arguments: { command: `cat /home/kenan/work/lab/step${i}.log` } }],
        api: 'anthropic-messages', provider: 'anthropic', model: 'claude', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'toolUse', timestamp: 3 + i } as never);
      manager.appendMessage({ role: 'toolResult', toolCallId: `c${i}`, toolName: 'bash', content: [{ type: 'text', text: `KERNEL_PROBE ${'de ad be ef '.repeat(250)}` }], isError: false, timestamp: 3 + i });
    }
  };
  const checkpoints = () => manager.getEntries().flatMap(entry => entry.type === 'compaction' ? [entry] : []);
  return { manager, provider, outcomes, request, work, checkpoints };
}

describe('compaction when the provider refuses to summarize', () => {
  it('summarizes the reduced transcript when only raw tool output and thinking are refused, and pins the task once', async () => {
    const run = worker((_, prompt) => prompt.includes('KERNEL_PROBE'));
    run.work(0, 12);
    run.manager.appendMessage({ role: 'user', content: 'Latest: publish the phone build.', timestamp: 100 });
    const prepared = await run.request();
    expect(run.outcomes).toHaveLength(1);
    expect(run.outcomes[0]!.route).toBe('reduced');
    expect(run.outcomes[0]!.failures.every(failure => failure.kind === 'refused')).toBe(true);
    const [checkpoint] = run.checkpoints();
    expect(checkpoint!.summary).toContain(`<original-task>\n${TASK}\n</original-task>`);
    expect(checkpoint!.summary).toMatch(/Checkpoint \d+ by claude/);
    expect(checkpoint!.details).toMatchObject({ route: 'reduced' });
    expect(JSON.stringify(prepared?.context)).toContain('Latest: publish the phone build.');
    expect(contextBudget(prepared?.context, 10000, 1024, 'request').ok).toBe(true);

    const calls = run.provider.prompts.length;
    await run.request();
    expect(run.provider.prompts).toHaveLength(calls);

    run.work(20, 12);
    await run.request();
    expect(run.checkpoints()).toHaveLength(2);
    expect(run.checkpoints()[1]!.summary.match(/<original-task>/g)).toHaveLength(1);
  });

  it('retries a refused summary on the configured fallback model, which then goes first for later segments', async () => {
    const run = worker(model => model === 'claude', ['claude-fable-5-1']);
    run.work(0, 12);
    run.manager.appendMessage({ role: 'user', content: 'Latest: publish the phone build.', timestamp: 100 });
    await run.request();
    expect(run.outcomes).toEqual([{ route: 'model', failures: [{ kind: 'refused', model: 'claude', transcript: 'full', message: expect.stringContaining('violative') }] }]);
    expect(run.provider.prompts.filter(call => call.model === 'claude')).toHaveLength(1);
    expect(run.provider.prompts.length).toBeGreaterThan(2);
    const summary = run.checkpoints()[0]!.summary;
    expect(summary).toMatch(/Checkpoint \d+ by claude-fable-5-1/);
    expect(summary).toContain(`<original-task>\n${TASK}\n</original-task>`);
  });

  it('falls back to a mechanical checkpoint when every summary is refused, without retrying on later requests', async () => {
    const run = worker(() => true, ['claude-fable-5-1']);
    run.work(0, 12);
    run.manager.appendMessage({ role: 'user', content: 'Latest: publish the phone build.', timestamp: 100 });
    const entries = run.manager.getEntries().length;
    const prepared = await run.request();
    const refused = (model: string, transcript: string) => ({ kind: 'refused', model, transcript, message: expect.stringContaining('violative') });
    expect(run.outcomes).toEqual([{ route: 'structured', failures: [refused('claude', 'full'), refused('claude-fable-5-1', 'full'), refused('claude', 'reduced'), refused('claude-fable-5-1', 'reduced')] }]);
    expect(run.provider.prompts).toHaveLength(4);
    const summary = run.checkpoints()[0]!.summary;
    expect(summary).toContain(`<original-task>\n${TASK}\n</original-task>`);
    expect(summary).toContain('Checkpoint assembled without a model summary');
    expect(summary).toContain('/home/kenan/work/lab/step0.log');
    expect(summary).not.toContain('de ad be ef');
    expect(run.manager.getEntries()).toHaveLength(entries + 1);
    expect(JSON.stringify(prepared?.context)).toContain('Latest: publish the phone build.');
    expect(contextBudget(prepared?.context, 10000, 1024, 'request').ok).toBe(true);

    await run.request();
    await run.request();
    expect(run.provider.prompts).toHaveLength(4);
    expect(run.checkpoints()).toHaveLength(1);
  });
});
