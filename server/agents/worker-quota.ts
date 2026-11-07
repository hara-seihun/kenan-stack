// One quota policy for every worker launch and Claude model switch, using the usage tool's shared pool readings.
import type { UsagePlan } from '../../shared/contract.js';
import type { Deps } from '../types.js';
import { usagePlans } from '../metrics/usage.js';

export class ClaudeReservedForKenaznia extends Error {
  readonly code = 'claude_reserved_for_kenaznia';
  constructor(readonly metric: string, readonly percentLeft: number, readonly reservePercent: number) {
    super(`claude_reserved_for_kenaznia: the shared Claude pool's ${metric} meter has ${percentLeft}% left, below ${reservePercent}%; only Kenaznias may launch on Claude. Choose GPT explicitly; nothing was launched or changed.`);
  }
}

export class ClaudeNotEnabledForPerson extends Error {
  readonly code = 'claude_not_enabled_for_person';
  constructor() { super('claude_not_enabled_for_person: Claude is not enabled for this person. Choose an OpenAI model.'); }
}
export function assertPersonModel(person: { budget?: { claude: boolean } } | undefined, model: string): void {
  if (person?.budget?.claude === false && model.startsWith('claude-')) throw new ClaudeNotEnabledForPerson();
}

/** Generalised from the swarm check: a model draws the general meters, plus its own family meter. Unknown readings do not establish low quota. */
export function workerQuota(plans: UsagePlan[], model: string, reservePercent: number): ClaudeReservedForKenaznia | null {
  if (reservePercent === 0 || !model.startsWith('claude-')) return null;
  const low = plans.filter(p => p.provider === 'anthropic' && (p.metric !== 'fable' || model.startsWith('claude-fable-')) && p.percentLeft !== null && p.percentLeft < reservePercent)
    .sort((a, b) => a.percentLeft! - b.percentLeft!)[0];
  return low ? new ClaudeReservedForKenaznia(low.metric, low.percentLeft!, reservePercent) : null;
}

export async function assertWorkerQuota(deps: Deps, ownerId: string, model: string): Promise<void> {
  assertPersonModel(deps.config?.people?.find(p => p.id === ownerId), model);
  // A disabled reserve and GPT launches never need a quota read.
  if (!model.startsWith('claude-')) return;
  const reserve = deps.config.claudeWorkerReservePercent ?? 12;
  if (reserve === 0) return;
  const refusal = workerQuota((await usagePlans(deps, ownerId)).plans, model, reserve);
  if (refusal) throw refusal;
}
