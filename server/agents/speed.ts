// How fast a worker's model calls run: the speed tiers the subscription routes really offer (measured 2026-10-30).
import type { AgentSession } from '@earendil-works/pi-coding-agent';
import type { AgentInfo } from '../../shared/contract.js';
import type { ModelProvider } from '../config.js';

export type Speed = AgentInfo['speed'];
export const SPEEDS = ['normal', 'fast', 'ultrafast'] as const satisfies readonly Speed[];
export const isSpeed = (value: unknown): value is Speed => SPEEDS.some(speed => speed === value);

/**
 * The Codex service_tier each speed sends on the ChatGPT route. "priority" is Codex's Fast (its /fast, `service_tier =
 * "fast"` in config.toml); "ultrafast" is Ultrafast (GPT-6 Astra and GPT-6.1 Sol, Pro $500 plans only). Each account's
 * Codex models list names the tiers it offers per model, and the broker lists them as `tiers`.
 */
const CODEX_TIER = { fast: 'priority', ultrafast: 'ultrafast' } as const satisfies Record<Exclude<Speed, 'normal'>, string>;

/**
 * How many times faster than normal each speed uses the subscription's included usage, as OpenAI states it for Codex
 * (learn.chatgpt.com/docs/agent-configuration/speed, read 2026-10-30): Fast 2.5x, Ultrafast 8x. Claude only runs normal.
 */
export const QUOTA_RATE: Record<Speed, number> = { normal: 1, fast: 2.5, ultrafast: 8 };

/** The speeds a model offers, from the service tiers its route lists. */
export function speedsOf(provider: ModelProvider, tiers: readonly string[]): Speed[] {
  if (provider !== 'openai-codex') return ['normal'];
  return ['normal', ...(['fast', 'ultrafast'] as const).filter(speed => tiers.includes(CODEX_TIER[speed]))];
}

/** Why Claude has no faster speed here: its fast mode exists but is billed outside the subscription. */
const CLAUDE_FAST = `Claude's fast mode (Opus 5.5, up to 2.5x output speed) is billed per token from usage credits outside the subscription plan, and usage credits are off on every account in the pool, so Claude workers run at normal speed only`;

/** A typed refusal naming what the model offers; undefined when the speed is offered. */
export function speedRefusal(provider: ModelProvider, model: string, speeds: readonly Speed[], speed: string, inherited: boolean): string | undefined {
  if (!isSpeed(speed)) return `speed_unavailable: ${speed} is not a speed (${SPEEDS.join(', ')}); nothing was launched or changed`;
  if (speeds.includes(speed)) return undefined;
  const why = provider === 'anthropic' ? `${CLAUDE_FAST}.`
    : speed === 'ultrafast' ? `Ultrafast is offered only for GPT-6 Astra and GPT-6.1 Sol on Pro $500 plans, and no account in the pool offers it for ${model} right now.`
    : `no account in the pool offers Fast for ${model} right now.`;
  return `speed_unavailable: ${model} does not run at ${speed} on this host's subscription route; it offers ${speeds.join(', ')}. ${why}${inherited ? ` The speed was inherited from your own run; give speed explicitly (for example speed "normal").` : ''} Nothing was launched or changed, and there is no fallback.`;
}

/** The service_tier a worker's Codex requests carry, or undefined for normal speed (and every Claude request). */
export function serviceTierOf(provider: ModelProvider, speed: Speed): string | undefined {
  return provider === 'openai-codex' && speed !== 'normal' ? CODEX_TIER[speed] : undefined;
}

/** Every model request of the session carries the run's current tier, read at each call so a switch applies at the next one. */
export function applySpeed(session: AgentSession, tier: () => string | undefined): void {
  const stream = session.agent.streamFunction;
  session.agent.streamFunction = (model, context, options) => stream(model, context, {
    ...options,
    onPayload: async (payload, requestModel) => {
      const built = await options?.onPayload?.(payload, requestModel) ?? payload;
      const serviceTier = tier();
      return serviceTier === undefined || !built || typeof built !== 'object' ? built : { ...built as object, service_tier: serviceTier };
    },
  });
}
