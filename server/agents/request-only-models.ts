import type { AgentInfo } from '../../shared/contract.js';
import type { PersonConfig } from '../config.js';

/**
 * Models Alice pays extra for (Alice, 2026-11-02: "Astra is 5x more expensive. Make it so Astra and fable must have me
 * explicitly ask for them"). Under her, no agent launches or switches to one unless her
 * Kenaznia passes herRequest: true on a spawn, respawn, dispatch or model switch she asked for.
 */
const REQUEST_ONLY = /^(gpt-6-astra|claude-fable-)/;

export function requestOnlyRefusal(person: Pick<PersonConfig, 'id' | 'name'>, caller: Pick<AgentInfo, 'role'>, model: string | undefined, herRequest: boolean | undefined): string | null {
  if (herRequest === true && caller.role !== 'manager') return `her_request_not_yours: herRequest is set only by ${person.name}'s Kenaznia, when ${person.name} has just asked for that model, thinking level or speed; nothing was launched or changed. Drop herRequest and use high thinking, normal speed and another model.`;
  if (person.id !== 'alice' || model === undefined || !REQUEST_ONLY.test(model) || herRequest === true) return null;
  return `request_only_model: ${model} runs only when ${person.name} explicitly asks for it. Nothing was launched or changed. Choose another served model that fits the task; if ${person.name} asked for ${model}, her Kenaznia passes herRequest: true.`;
}

/** Alice reserves levels above high for requests where she explicitly says "max". */
export function requestOnlyThinkingRefusal(person: Pick<PersonConfig, 'id' | 'name'>, caller: Pick<AgentInfo, 'role'>, model: string | undefined, thinking: string | undefined, herRequest: boolean | undefined): string | null {
  if (person.id !== 'alice') return null;
  const named = model && /-(xhigh|max)$/.exec(model)?.[1];
  const level = thinking === 'max' || thinking === 'xhigh' ? thinking : named;
  if (!level) return null;
  if (herRequest === true && caller.role === 'manager') return null;
  return `request_only_thinking: ${level} thinking requires Alice to explicitly say "max"; only her Kenaznia can pass herRequest: true for that request. Nothing was launched or changed. Allowed levels without that request: off, minimal, low, medium, high (where the model supports them). Retry with thinking: "high" and a model without a max/xhigh suffix.`;
}
