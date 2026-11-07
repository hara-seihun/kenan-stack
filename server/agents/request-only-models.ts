import type { AgentInfo } from '../../shared/contract.js';
import type { PersonConfig } from '../config.js';

/**
 * Models Alice pays extra for (Alice, 2026-11-02: "Astra is 5x more expensive. Make it so Astra and fable must have me
 * explicitly ask for them"). Under her, no agent launches or switches to one unless her
 * Kenaznia passes herRequest: true on a spawn, respawn, dispatch or model switch she asked for.
 */
const REQUEST_ONLY = /^(gpt-6-astra|claude-fable-)/;

export function requestOnlyRefusal(person: Pick<PersonConfig, 'id' | 'name'>, caller: Pick<AgentInfo, 'role'>, model: string | undefined, herRequest: boolean | undefined): string | null {
  if (herRequest === true && caller.role !== 'manager') return `her_request_not_yours: herRequest is set only by ${person.name}'s Kenaznia, when ${person.name} has just asked for the model; nothing was launched. Drop herRequest and use another model.`;
  if (person.id !== 'alice' || model === undefined || !REQUEST_ONLY.test(model) || herRequest === true) return null;
  return `request_only_model: ${model} runs only when ${person.name} explicitly asks for it. Nothing was launched or changed. Choose another served model that fits the task; if ${person.name} asked for ${model}, her Kenaznia passes herRequest: true.`;
}
