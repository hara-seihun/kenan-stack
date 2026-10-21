import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { configurePool, anthropicBrokerTransportMarker, brokerTransportMarker } from './pool.js';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { PersonConfig, AgentProfile } from './config.js';

describe('subscription pool transport', () => {
  for (const provider of ['anthropic', 'openai-codex'] as const) it(`routes ${provider} only through the owning existing broker`, async () => {
    const api = provider === 'anthropic' ? 'anthropic-messages' : 'openai-codex-responses';
    const path = join(mkdtempSync(join(tmpdir(), 'pool-test-')), 'models.json');
    writeFileSync(path, JSON.stringify({ catalog: { providers: { [provider]: { models: [{ id: 'test', provider, api }] } } } }));
    let model: any;
    const runtime: any = { registerProvider(id: string, config: any) { model = { ...config.models[0], provider: id }; }, getModel: () => model, async setRuntimeApiKey() {} };
    await configurePool(runtime as ModelRuntime, { brokerPort: 2465 } as PersonConfig, { provider, model: 'test' } as AgentProfile, path, [provider], 'agent-1');
    const auth = await runtime.getAuth(model);
    expect(auth.auth.baseUrl).toBe(`http://127.0.0.1:2465${provider === 'anthropic' ? '' : '/backend-api'}`);
    expect(auth.auth.apiKey).toBe(provider === 'anthropic' ? anthropicBrokerTransportMarker : brokerTransportMarker);
    expect(auth.auth.headers).toEqual(provider === 'anthropic' ? { 'x-claude-code-session-id': 'agent-1' } : undefined);
    await expect(runtime.getAuth({ ...model, baseUrl: 'https://api.openai.com' })).rejects.toThrow('outside');
    await expect(runtime.getAuth(model, { apiKey: 'real-key' })).rejects.toThrow('overrides');
    expect(runtime.hasConfiguredAuth('metered-provider')).toBe(false);
  });
});

it('rejects a forbidden provider before registering models or installing auth', async () => {
  const { vi } = await import('vitest');
  const runtime: any = { registerProvider: vi.fn(), setRuntimeApiKey: vi.fn() };
  await expect(configurePool(runtime, { brokerPort: 2465 } as PersonConfig, { provider: 'openai-codex', model: 'gpt-6.1-sol' } as AgentProfile, '/does-not-need-to-exist', ['anthropic'], 'agent-1')).rejects.toThrow('not allowed');
  expect(runtime.registerProvider).not.toHaveBeenCalled();
  expect(runtime.setRuntimeApiKey).not.toHaveBeenCalled();
});

it('rejects a persisted wrong-provider agent model before creating its session', async () => {
  const { AgentRuntime } = await import('./agents/runtime.js');
  const path = join(mkdtempSync(join(tmpdir(), 'provider-agent-')), 'models.json');
  writeFileSync(path, JSON.stringify({ catalog: { providers: { 'openai-codex': { models: [{ id: 'gpt-6.1-sol' }] } } } }));
  const runtime = new AgentRuntime({
    config: { modelsPath: path, allowedProviders: ['anthropic'] },
    store: { getAgent: async () => ({ id: 'old-worker', ownerId: 'alice', role: 'worker', model: 'gpt-6.1-sol' }) },
    person: () => ({ id: 'alice', worker: { provider: 'anthropic', model: 'claude-opus-5-5' } }),
  } as any);
  await expect((runtime as any).session('old-worker')).rejects.toThrow('Provider openai-codex is not allowed on this host');
});

it('requires explicit host policy and rejects disallowed configured profiles', async () => {
  const { loadConfig } = await import('./config.js');
  const path = join(mkdtempSync(join(tmpdir(), 'provider-config-')), 'config.json');
  const config = { channel: 'beta', listen: '/tmp/test.sock', databaseUrl: 'postgresql:///test', people: [{ id: 'p', alertDir: null, signalStore: null, pronouns: null, peers: [], worker: { name: 'Kenan', provider: 'openai-codex', model: 'gpt-6.1-sol', thinking: 'medium', systemPrompt: '', contextFiles: [], refusalFallbackModels: [] }, manager: null }] };
  writeFileSync(path, JSON.stringify(config));
  expect(() => loadConfig(path)).toThrow('allowedProviders');
  writeFileSync(path, JSON.stringify({ ...config, allowedProviders: ['anthropic'] }));
  expect(() => loadConfig(path)).toThrow('not allowed');
  writeFileSync(path, JSON.stringify({ ...config, allowedProviders: ['openai-codex'] }));
  expect(loadConfig(path).allowedProviders).toEqual(['openai-codex']);
});
