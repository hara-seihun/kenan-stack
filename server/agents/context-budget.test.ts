import { readFile, rm, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const { summarize } = vi.hoisted(() => ({ summarize: vi.fn() }));
vi.mock('@earendil-works/pi-coding-agent', async original => ({ ...await original<object>(), generateSummaryWithUsage: summarize }));
import { SessionManager, type AgentSession, type ModelRuntime } from '@earendil-works/pi-coding-agent';
import { boundRequestContext, inputLimit, chooseCut, contextBudget, foldSummary, installContextBudget, summarizeWithHeadroom, textChunks, type CompactionOutcome } from './context-budget.js';

describe('pre-request context budget', () => {
  it('counts system prompts, tool schema/results and incoming messages in tokens, not bytes', () => {
    const context = { systemPrompt: 's'.repeat(200_000), tools: [{ description: 't'.repeat(150_000) }], messages: [{ role: 'toolResult', content: 'r'.repeat(350_000) }, { role: 'user', content: 'u'.repeat(120_000) }] };
    expect(contextBudget(context, 1_000_000, 128_000, 'request').ok).toBe(true);
    expect(contextBudget({}, 0, 32768, 'request').ok).toBe(false);
  });
  it('starts compaction at 600,000 tokens, long before the model limit, and respects a smaller window', () => {
    const request = (tokens: number) => ({ messages: [{ role: 'user', content: 'x'.repeat(tokens * 4) }] });
    expect(contextBudget(request(599_999), 1_000_000, 128_000, 'compaction').ok).toBe(true);
    expect(contextBudget(request(600_000), 1_000_000, 128_000, 'compaction').ok).toBe(false);
    expect(contextBudget(request(600_000), 1_000_000, 128_000, 'request').ok).toBe(true);
    expect(contextBudget(request(872_000), 1_000_000, 128_000, 'request').ok).toBe(false);
    expect(contextBudget(request(9_000), 10_000, 1_024, 'compaction').ok).toBe(false);
  });
  it('replays replacement system sections instead of counting both snapshots', () => {
    const section = 's'.repeat(332_000);
    const context = { messages: [
      { role: 'system', content: '', sections: { standing: section }, timestamp: 1 },
      { role: 'user', content: 'hello' },
      { role: 'system', content: '', sections: { standing: section }, timestamp: 1 },
    ] };
    expect(contextBudget(context, 1_000_000, 128_000, 'request')).toMatchObject({ ok: true, value: { inputTokens: 83_002 } });
  });
  it('uses provider usage when available instead of a character estimate', () => {
    expect(contextBudget({ messages: [] }, 1_000_000, 128_000, 'compaction', 600_000).ok).toBe(false);
    expect(contextBudget({ messages: [] }, 1_000_000, 128_000, 'compaction', 599_999).ok).toBe(true);
  });
  it('preserves every character while splitting an already oversized transcript', () => {
    const input = 'hello🌍日本語\n'.repeat(1000);
    const chunks = textChunks(input, 300);
    expect(chunks.join('')).toBe(input);
    expect(chunks.every(chunk => Buffer.byteLength(chunk) <= 300)).toBe(true);
  });
  it('summarizes oversized history in bounded chronological chunks', async () => {
    const calls: string[] = [];
    const summary = await foldSummary('a'.repeat(150), 'existing decisions', 64, async (chunk, previous) => {
      calls.push(chunk); return `${previous};${chunk.length}`;
    });
    expect(calls.map(x => x.length)).toEqual([64,64,22]);
    expect(summary).toBe('existing decisions;64;64;22');
  });
  it('does not turn a failed compaction into an empty successful summary', async () => {
    await expect(foldSummary('history', undefined, 64, async () => '')).rejects.toThrow('no summary');
  });
});

describe('Pi request-boundary compaction', () => {
  beforeEach(() => { summarize.mockReset().mockResolvedValue({ text: 'Preserved decisions and outstanding work.', usage: {} }); });
  function fixture(system = 'system', window = { contextWindow: 10000, maxTokens: 1024 }) {
    const manager = SessionManager.inMemory('/tmp');
    manager.appendMessage({ role: 'system', content: system, timestamp: 1 });
    const model = { ...window, api: 'anthropic-messages', compat: { supportsMidConvoEffort: true } };
    const agent = { state: { messages: [] }, prepareRequest: undefined, convertToLlm: async (messages: unknown[]) => messages, streamFunction: undefined };
    const session = { agent, sessionManager: manager } as unknown as AgentSession;
    const runtime = { getAuth: async () => ({ auth: { apiKey: 'test-subscription-marker' } }) } as unknown as ModelRuntime;
    const outcomes: CompactionOutcome[] = [];
    installContextBudget(session, runtime, { started() {}, recovered: outcome => { outcomes.push(outcome); } }, { pinning: 'none', refusalFallbacks: [], stream: undefined as never });
    const request = () => session.agent.prepareRequest!({ context: { messages: manager.buildSessionProjection().messages, tools: [] }, model: model as never, thinkingLevel: 'off' });
    return { manager, request, outcomes };
  }
  it('compacts already oversized history before a provider sees it and preserves the journal', async () => {
    const { manager, request } = fixture();
    manager.appendMessage({ role: 'user', content: 'older context '.repeat(6000), timestamp: 2 });
    manager.appendMessage({ role: 'user', content: 'Keep this exact current request.', timestamp: 3 });
    const count = manager.getEntries().length;
    const prepared = await request();
    expect(summarize.mock.calls.length).toBeGreaterThan(1);
    expect(summarize.mock.calls[0]![1].compat.supportsMidConvoEffort).toBe(false);
    expect(summarize.mock.calls[0]![8]).toBe('low');
    expect(manager.getEntries().length).toBeGreaterThan(count);
    expect(manager.getEntries().some(entry => entry.type === 'message' && entry.message.role === 'user' && entry.message.content === 'older context '.repeat(6000))).toBe(true);
    expect(JSON.stringify(prepared?.context)).toContain('Keep this exact current request.');
    expect(contextBudget(prepared?.context, 10000, 1024, 'request').ok).toBe(true);
  });
  it('rejects an irreducible system prompt without calling any model', async () => {
    const { manager, request } = fixture('fixed'.repeat(12000));
    manager.appendMessage({ role: 'user', content: 'hello', timestamp: 2 });
    await expect(request()).rejects.toThrow('system prompt and tools');
    expect(summarize).not.toHaveBeenCalled();
  });
  it('retains an oversized current instruction verbatim in the journal and owner-readable artifact', async () => {
    const { manager, request } = fixture();
    manager.appendMessage({ role: 'user', content: 'prior request', timestamp: 2 });
    manager.appendMessage({ role: 'user', content: 'verbatim current instruction '.repeat(2000), timestamp: 3 });
    const count = manager.getEntries().length;
    const prepared = await request();
    const text = JSON.stringify(prepared?.context);
    expect(text).toContain('FULL ORIGINAL:');
    expect(contextBudget(prepared?.context, 10000, 1024, 'request').ok).toBe(true);
    const original = manager.getEntries().findLast(e => e.type === 'message' && e.message.role === 'user');
    expect(JSON.stringify(original)).toContain('verbatim current instruction '.repeat(2000));
    const path = text.match(/FULL ORIGINAL: ([^ ]+) /)![1]!;
    const bytes = await readFile(path, 'utf8');
    expect(JSON.parse(bytes).content).toBe('verbatim current instruction '.repeat(2000));
    expect(text).toContain(createHash('sha256').update(bytes).digest('hex'));
    await rm(path);
    // Only the prior turn is summarized; the current ask is retained byte-for-byte.
    expect(JSON.stringify(summarize.mock.calls)).not.toContain('verbatim current instruction');
    expect(manager.getEntries().length).toBeGreaterThanOrEqual(count);
  });
  it('checks the actual SDK summary envelope before its provider call', async () => {
    const fixtureState = fixture();
    const { manager, request } = fixtureState;
    manager.appendMessage({ role: 'user', content: 'history '.repeat(6400), timestamp: 2 });
    manager.appendMessage({ role: 'user', content: 'latest', timestamp: 3 });
    summarize.mockImplementation(async (...args: unknown[]) => {
      const stream = args[9] as (...args: unknown[]) => unknown;
      stream({ contextWindow: 10000, maxTokens: 1024 }, { messages: [{ role: 'user', content: 'SDK wrapper '.repeat(8000) }] }, { maxTokens: 1024 });
      return { text: 'must not reach', usage: {} };
    });
    const { outcomes } = fixtureState;
    const prepared = await request();
    expect(outcomes[0]).toMatchObject({ route: 'structured', failures: [{ kind: 'failed' }, { kind: 'failed' }] });
    expect(outcomes[0]!.failures[0]!.message).toContain('request input budget');
    // No summary: the journal keeps everything, the context carries a mechanical checkpoint instead of older history.
    expect(manager.getEntries().some(entry => entry.type === 'message' && entry.message.role === 'user' && entry.message.content === 'history '.repeat(6400))).toBe(true);
    expect(JSON.stringify(prepared?.context)).toContain('Checkpoint assembled without a model summary');
    expect(JSON.stringify(prepared?.context)).toContain('latest');
    expect(contextBudget(prepared?.context, 10000, 1024, 'request').ok).toBe(true);
  });
  it('compacts with a mechanical checkpoint when the summary fails below the model limit, so the next request does not summarize again', async () => {
    const { manager, request, outcomes } = fixture('system', { contextWindow: 1_000_000, maxTokens: 1024 });
    manager.appendMessage({ role: 'user', content: 'history '.repeat(330_000), timestamp: 2 });
    manager.appendMessage({ role: 'user', content: 'latest', timestamp: 3 });
    summarize.mockRejectedValue(new Error('Summarization failed: The model refused to complete the request'));
    const count = manager.getEntries().length;
    const prepared = await request();
    const refused = (transcript: string) => expect.objectContaining({ kind: 'refused', transcript, message: expect.stringContaining('refused') });
    expect(outcomes).toEqual([{ route: 'structured', failures: [refused('full'), refused('reduced')] }]);
    expect(summarize).toHaveBeenCalledTimes(2);
    expect(manager.getEntries()).toHaveLength(count + 1);
    expect(JSON.stringify(prepared?.context).length).toBeLessThan(20_000);
    await request();
    expect(summarize).toHaveBeenCalledTimes(2);
  });
  it('compacts a single long worker turn at an assistant boundary and keeps recent tool work verbatim', async () => {
    const { manager, request } = fixture();
    manager.appendMessage({ role: 'user', content: 'Worker task: fix the build', timestamp: 2 });
    for (let i = 0; i < 12; i++) {
      manager.appendMessage({ role: 'assistant', content: [{ type: 'toolCall', id: `c${i}`, name: 'bash', arguments: { command: `step ${i}` } }], api: 'anthropic-messages', provider: 'anthropic', model: 'm', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'toolUse', timestamp: 3 + i } as never);
      manager.appendMessage({ role: 'toolResult', toolCallId: `c${i}`, toolName: 'bash', content: [{ type: 'text', text: `output ${i} `.repeat(400) }], isError: false, timestamp: 3 + i });
    }
    const prepared = await request();
    expect(summarize).toHaveBeenCalled();
    const text = JSON.stringify(prepared?.context);
    expect(text).toContain('step 11');
    expect(text).toContain('output 11');
    expect(text).not.toContain('step 0"');
    expect(contextBudget(prepared?.context, 10000, 1024, 'compaction').ok).toBe(true);
  });
  it('checks again after a large tool result, covering continuation and steering growth', async () => {
    const { manager, request } = fixture();
    manager.appendMessage({ role: 'user', content: 'Inspect the file', timestamp: 2 });
    await request();
    expect(summarize).not.toHaveBeenCalled();
    manager.appendMessage({ role: 'toolResult', toolCallId: 'read1', toolName: 'read', content: [{ type: 'text', text: 'large result '.repeat(4800) }], isError: false, timestamp: 3 });
    manager.appendMessage({ role: 'user', content: 'New steering instruction', timestamp: 4 });
    const prepared = await request();
    expect(summarize).toHaveBeenCalled();
    expect(contextBudget(prepared?.context, 10000, 1024, 'request').ok).toBe(true);
    expect(JSON.stringify(prepared?.context)).toContain('New steering instruction');
  });
});


describe('compaction boundary', () => {
  const entry = (id: string, role: string, type = 'message') => ({ messages: [{ role }], sourceEntry: { id, type } });
  it('keeps the earliest boundary whose tail fits, never splits a tool result from its call, and cannot loop on a bare checkpoint', () => {
    const entries = [entry('u1', 'user'), entry('a1', 'assistant'), entry('t1', 'toolResult'), entry('a2', 'assistant'), entry('t2', 'toolResult')];
    expect(chooseCut(entries, () => 10, 25)).toBe(3);
    expect(chooseCut(entries, () => 10, 5)).toBe(3);
    expect(chooseCut(entries, () => 10, 1000)).toBe(1);
    expect(chooseCut([entry('c', 'compactionSummary', 'compaction'), entry('a', 'assistant'), entry('t', 'toolResult')], () => 10, 5)).toBeNull();
  });
});

describe('summary output headroom', () => {
  it('retries a truncated summary once with more output room', async () => {
    const generate = vi.fn().mockRejectedValueOnce(new Error('Summarization failed: generation hit the token cap')).mockResolvedValue('complete checkpoint');
    await expect(summarizeWithHeadroom(128_000, generate)).resolves.toBe('complete checkpoint');
    expect(generate.mock.calls).toEqual([[20_480], [40_960]]);
  });
  it('does not loop if the larger summary is still truncated', async () => {
    const generate = vi.fn().mockRejectedValue(new Error('generation hit the token cap'));
    await expect(summarizeWithHeadroom(128_000, generate)).rejects.toThrow('token cap');
    expect(generate).toHaveBeenCalledTimes(2);
  });
  it('does not retry other failures or a model whose own limit cannot increase', async () => {
    const network = vi.fn().mockRejectedValue(new Error('subscription unavailable'));
    await expect(summarizeWithHeadroom(128_000, network)).rejects.toThrow('subscription unavailable');
    expect(network).toHaveBeenCalledTimes(1);
    const capped = vi.fn().mockRejectedValue(new Error('generation hit the token cap'));
    await expect(summarizeWithHeadroom(8_192, capped)).rejects.toThrow('token cap');
    expect(capped).toHaveBeenCalledTimes(1);
  });
});


describe('restored lossless request projection', () => {
  it('reserves tokenizer/SDK headroom without changing the 600k compaction preference', () => {
    expect(inputLimit(1000000, 128000, 'request')).toEqual({ ok: true, value: 863808 });
    expect(inputLimit(1000000, 128000, 'compaction')).toEqual({ ok: true, value: 600000 });
  });
  it('preserves exact tool result bytes and original operation identity, never executes anything', async () => {
    const root = await mkdtemp(join(tmpdir(), 'context-lossless-'));
    try {
      const original = { role: 'toolResult', toolCallId: 'original-operation', toolName: 'read', content: [{ type: 'text', text: '🌍data'.repeat(30000) }], isError: false };
      const copy = JSON.stringify(original);
      const context = await boundRequestContext({ messages: [original] }, root);
      expect(JSON.stringify(original)).toBe(copy);
      expect(context.messages[0]!.toolCallId).toBe('original-operation');
      const digest = createHash('sha256').update(copy).digest('hex');
      expect(await readFile(join(root, digest + '.json'), 'utf8')).toBe(copy);
      expect(JSON.stringify(context)).toContain(digest);
      expect(JSON.stringify(context).length).toBeLessThan(20000);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
