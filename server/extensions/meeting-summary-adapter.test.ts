import { test, expect, vi } from 'vitest';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PersonConfig, AgentProfile } from '../config.js';
const { configure, complete, runtimeCreate } = vi.hoisted(() => ({ configure: vi.fn(), complete: vi.fn(), runtimeCreate: vi.fn() }));
vi.mock('../pool.js', () => ({ configurePool: configure }));
vi.mock('@earendil-works/pi-coding-agent', () => ({ ModelRuntime: { create: runtimeCreate } }));
import { subscriptionMeetingSummary } from './meeting-summary-adapter.js';

test('uses existing configured subscription identity/thinking with transcript only and reconciles retained output', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'meeting-summary-adapter-'));
  try {
    const model = { id: 'original-model' };
    runtimeCreate.mockResolvedValue({ getModel: () => model, completeSimple: complete });
    complete.mockResolvedValue({ stopReason: 'stop', content: [{ type: 'text', text: '{"summary":"Saved"}' }] });
    const profile = { model: 'original-model', provider: 'openai-codex', thinking: 'high' } as AgentProfile;
    const person = { id: 'acme', brokerPort: 1234 } as PersonConfig;
    const adapter = subscriptionMeetingSummary({ person, profile, allowedProviders: ['openai-codex'], modelsPath: '/models.json', operationDirectory: directory });
    const id = `meeting-summary:${'a'.repeat(64)}`;
    expect(await adapter.recover(id)).toBeNull();
    expect(await adapter.generate(id, 'TRANSCRIPT\nOnly quoted speech')).toBe('{"summary":"Saved"}');
    expect(configure).toHaveBeenCalledWith(expect.anything(), person, profile, '/models.json', ['openai-codex'], id);
    const [selected, context, options] = complete.mock.calls[0]!;
    expect(selected).toBe(model);
    expect(context.messages).toHaveLength(1);
    expect(context.tools).toBeUndefined();
    expect(options.reasoning).toBe('high');
    expect(options.apiKey).toBeUndefined();
    const restarted = subscriptionMeetingSummary({ person, profile, allowedProviders: ['openai-codex'], modelsPath: '/models.json', operationDirectory: directory });
    expect(await restarted.generate(id, 'Same input')).toBe('{"summary":"Saved"}');
    expect(complete).toHaveBeenCalledTimes(1);
    expect((await stat(directory)).mode & 0o077).toBe(0);
    await expect(adapter.generate('foreign-path', 'text')).rejects.toThrow('operation');
  } finally { await rm(directory, { recursive: true, force: true }); vi.clearAllMocks(); }
});

test('configured broker failure never falls back or stores fake output', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'meeting-summary-adapter-'));
  try {
    runtimeCreate.mockResolvedValue({ getModel: () => ({}), completeSimple: complete });
    configure.mockRejectedValueOnce(new Error('Subscription unavailable'));
    const adapter = subscriptionMeetingSummary({ person: {} as PersonConfig, profile: { model: 'original-model' } as AgentProfile, allowedProviders: ['openai-codex'], modelsPath: '/models.json', operationDirectory: directory });
    const id = `meeting-summary:${'b'.repeat(64)}`;
    await expect(adapter.generate(id, 'TRANSCRIPT')).rejects.toThrow('Subscription unavailable');
    expect(complete).not.toHaveBeenCalled();
    expect(await adapter.recover(id)).toBeNull();
  } finally { await rm(directory, { recursive: true, force: true }); vi.clearAllMocks(); }
});
