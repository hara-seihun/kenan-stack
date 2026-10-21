// Subscription transport to the model broker, which owns account selection, quota rotation and refresh.
import { readFileSync } from 'node:fs';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { assertAllowedProvider, type AgentProfile, type PersonConfig, type ModelProvider } from './config.js';

export const brokerTransportMarker = `pi-stack-next.${Buffer.from(JSON.stringify({'https://api.openai.com/auth':{chatgpt_account_id:'local-shared-broker'}})).toString('base64url')}.local`;
export const anthropicBrokerTransportMarker = 'sk-ant-oat01-pi-model-broker';
export const sharedBrokerTransportMarker = (api: string): string => api === 'anthropic-messages' ? anthropicBrokerTransportMarker : brokerTransportMarker;

/** The broker pins each affinity key to one subscription account until that account is exhausted.
 * Without a key every thread of a person shares one account and all go cold together. */
export const affinityHeaders = (api: string, threadKey: string): Record<string, string> | undefined =>
  api === 'anthropic-messages' ? { 'x-claude-code-session-id': threadKey } : undefined;

export async function configurePool(runtime: ModelRuntime, person: PersonConfig, profile: AgentProfile, modelsPath: string, allowedProviders: readonly ModelProvider[], threadKey: string): Promise<void> {
  if (!threadKey) throw new Error('Subscription broker requires a thread affinity key');
  assertAllowedProvider(allowedProviders, profile.provider);
  if (!Number.isInteger(person.brokerPort) || person.brokerPort < 1 || person.brokerPort > 65535) throw new Error('Invalid subscription broker port');
  const origin = `http://127.0.0.1:${person.brokerPort}`;
  const source = JSON.parse(readFileSync(modelsPath, 'utf8'));
  const providers = source.catalog?.providers ?? source.providers;
  for (const provider of allowedProviders) {
    const catalog = providers?.[provider];
    if (!catalog?.models) continue;
    const baseUrl = provider === 'anthropic' ? origin : `${origin}/backend-api`;
    runtime.registerProvider(provider, { baseUrl, models: catalog.models.map((model: any) => ({ ...model, baseUrl, headers: undefined })) });
  }
  const check = (model: NonNullable<ReturnType<ModelRuntime['getModel']>>) => {
    assertAllowedProvider(allowedProviders, model.provider);
    const expected = model.api === 'anthropic-messages' ? origin : model.api === 'openai-codex-responses' ? `${origin}/backend-api` : null;
    if (!['anthropic', 'openai-codex'].includes(model.provider) || expected === null || model.baseUrl !== expected || model.headers && Object.keys(model.headers).some(k => ['authorization', 'x-api-key', 'api-key', 'cf-aig-authorization'].includes(k.toLowerCase()))) throw new Error('Model is outside the owning subscription broker');
  };
  const selected = runtime.getModel(profile.provider, profile.model);
  if (!selected) throw new Error(`Subscription model unavailable: ${profile.provider}/${profile.model}`);
  check(selected);
  await runtime.setRuntimeApiKey(profile.provider, sharedBrokerTransportMarker(selected.api));
  runtime.hasConfiguredAuth = provider => provider === profile.provider;
  runtime.checkAuth = async provider => provider === profile.provider ? { type: 'oauth', source: 'same-account local subscription broker' } : undefined;
  runtime.getAuth = async (providerOrModel, overrides) => {
    overrides?.signal?.throwIfAborted();
    const model = typeof providerOrModel === 'string' ? runtime.getModel(providerOrModel, profile.model) : providerOrModel;
    if (!model || model.type !== undefined && model.type !== 'chat') throw new Error('Subscription broker requires a configured chat model');
    check(model);
    const marker = sharedBrokerTransportMarker(model.api);
    if (overrides?.apiKey !== undefined && overrides.apiKey !== marker) throw new Error('Subscription broker does not accept credential overrides');
    return { auth: { apiKey: marker, baseUrl: model.baseUrl, headers: affinityHeaders(model.api, threadKey) }, source: 'same-account local broker' };
  };
}
