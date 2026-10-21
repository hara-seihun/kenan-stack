// Swarms: a worker (the coordinator) fans its own goal out to sub-agents, its children on the same goal.
import type { AgentInfo, UsagePlan } from './contract.js';

/** Sub-agents of one coordinator that may be active at once. */
export const SWARM_MAX_ACTIVE = 20;
/** New sub-agents wait while any subscription meter's pool share is below this, so a swarm never takes the last of the quota from human-facing work. */
export const SWARM_QUOTA_RESERVE_PERCENT = 8;

type Lineage = Pick<AgentInfo, 'id' | 'role' | 'goalId' | 'parentAgentId'>;

/** A sub-agent is a worker launched by a worker for that worker's own goal. */
export function isSubAgent(agent: Lineage, parent: Lineage | undefined): boolean {
  return agent.role === 'worker' && !!parent && parent.id === agent.parentAgentId && parent.role === 'worker' && parent.goalId !== null && parent.goalId === agent.goalId;
}

export const subAgentActive = (agent: Pick<AgentInfo, 'archived' | 'lastReport' | 'state'>): boolean => !agent.archived && !agent.lastReport && agent.state !== 'stopped';

export interface SwarmCounts { total: number; active: number; running: number; done: number; blocked: number }
export function swarmCounts(children: Pick<AgentInfo, 'archived' | 'lastReport' | 'state'>[]): SwarmCounts {
  return {
    total: children.length,
    active: children.filter(subAgentActive).length,
    running: children.filter(c => c.state === 'running').length,
    done: children.filter(c => c.lastReport?.status === 'done').length,
    blocked: children.filter(c => c.lastReport?.status === 'blocked').length,
  };
}

/** Sub-agents of every coordinator among `agents`, keyed by coordinator id. */
export function swarmsOf<A extends Lineage>(agents: A[]): Map<string, A[]> {
  const byId = new Map(agents.map(a => [a.id, a]));
  const out = new Map<string, A[]>();
  for (const agent of agents) {
    const parent = agent.parentAgentId ? byId.get(agent.parentAgentId) : undefined;
    if (parent && isSubAgent(agent, parent)) out.set(parent.id, [...out.get(parent.id) ?? [], agent]);
  }
  return out;
}

export type QuotaVerdict = { ok: true } | { ok: false; metric: string; percentLeft: number };
/** Meters only one model family draws (the broker's catalog): Anthropic's "fable" meter is Fable's own weekly quota. */
const FAMILY_METERS: Record<string, RegExp> = { fable: /^claude-fable-/ };
/** The lowest subscription meter the sub-agent's model draws decides; a meter without a reading is not evidence of quota. */
export function swarmQuota(plans: UsagePlan[], provider: UsagePlan['provider'], model: string): QuotaVerdict {
  const draws = (metric: string) => !FAMILY_METERS[metric] || FAMILY_METERS[metric]!.test(model);
  const low = plans.filter(p => p.provider === provider && draws(p.metric) && p.percentLeft !== null && p.percentLeft < SWARM_QUOTA_RESERVE_PERCENT)
    .sort((a, b) => a.percentLeft! - b.percentLeft!)[0];
  return low ? { ok: false, metric: low.metric, percentLeft: low.percentLeft! } : { ok: true };
}
