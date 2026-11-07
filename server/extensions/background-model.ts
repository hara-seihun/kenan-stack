// One cheap model call for background judges (the channel watcher, the ask tracker): a single prompt in, text out,
// through the person's subscription pool on the background lane. The runtime is made on first use and kept.
import { join } from 'node:path';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { AgentProfile, PersonConfig } from '../config.js';
import { isRefusalMessage } from '../agents/refusal.js';
import { configurePool } from '../pool.js';
import type { Deps } from '../types.js';
import { ownedDir, textsDir } from './texts.js';

/** The model declined to read the prompt (a usage-policy stop). The same text gets the same answer, so it is not retried. */
export class ModelRefused extends Error {
  constructor(readonly reason: string) { super(`model refused: ${reason}`); this.name = 'ModelRefused'; }
}

/** One prompt in, the reply text out; with onText, the reply streams and each text delta arrives as it is written. */
export type ModelCall = (prompt: string, onText?: (delta: string) => void) => Promise<string>;
export interface Purpose {
  name: string; runtimeDir: string; poolLabel: string; systemPrompt: string; maxTokens: number; timeoutMs: number;
  /** Thinking for the call; null sends none (the fastest reply). Default low. */
  reasoning?: 'minimal' | 'low' | 'medium' | 'high' | null;
  /** The pool lane; a person waiting on the answer (a meeting question) is interactive. Default background. */
  lane?: 'background' | 'interactive';
}
/** The pool provider of a model id: OpenAI's gpt models through Codex, everything else Anthropic. */
export const providerOf = (model: string): 'openai-codex' | 'anthropic' => model.startsWith('gpt') ? 'openai-codex' : 'anthropic';

export function backgroundModel(deps: Deps, person: PersonConfig, model: string, purpose: Purpose): ModelCall {
  const profile: AgentProfile = { name: purpose.name, provider: providerOf(model), model, thinking: purpose.reasoning ?? 'low', systemPrompt: '', contextFiles: [], refusalFallbackModels: [] };
  let runtime: Promise<ModelRuntime> | null = null;
  return async (prompt, onText) => {
    runtime ??= (async () => {
      const dir = await ownedDir(person, join(textsDir(person), purpose.runtimeDir));
      const r = await ModelRuntime.create({ authPath: join(dir, 'unused-auth.json'), modelsPath: null, refreshOnCreate: false });
      await configurePool(r, person, profile, deps.config.modelsPath, deps.config.allowedProviders, `${purpose.poolLabel}:${person.id}`, () => purpose.lane ?? 'background');
      return r;
    })().catch(e => { runtime = null; throw e; });
    const r = await runtime;
    const m = r.getModel(profile.provider, profile.model);
    if (!m) throw new Error(`${purpose.name} model ${model} is not in the catalog`);
    const context = { systemPrompt: purpose.systemPrompt, messages: [{ role: 'user' as const, content: prompt, timestamp: Date.now() }] };
    const options = { ...(purpose.reasoning === null ? {} : { reasoning: purpose.reasoning ?? 'low' as const }), maxTokens: purpose.maxTokens, signal: AbortSignal.timeout(purpose.timeoutMs) };
    let result;
    if (onText) {
      // Streamed: a caller deciding from the first line (meeting-router.ts) acts before the rest is written.
      const stream = r.streamSimple(m, context, options);
      for await (const event of stream) if (event.type === 'text_delta') onText(event.delta);
      result = await stream.result();
    } else result = await r.completeSimple(m, context, options);
    if (result.stopReason === 'error' && result.errorMessage && isRefusalMessage(result.errorMessage)) throw new ModelRefused(result.errorMessage);
    if (result.stopReason === 'error' || result.stopReason === 'aborted') throw new Error(`${purpose.name} model call ${result.stopReason}: ${result.errorMessage ?? ''}`);
    return result.content.filter(part => part.type === 'text').map(part => part.text).join('');
  };
}
