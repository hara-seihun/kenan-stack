// Swarms: a worker (the coordinator) fans its own goal out to sub-agents, its children on the same goal.
import type { AgentInfo } from './contract.js';

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

/** All worker descendants, including nested coordinators and their children. Display only: launch limits still use direct swarms. */
export function workerDescendants<A extends Lineage>(agents: A[]): Map<string, A[]> {
  const byId = new Map(agents.map(agent => [agent.id, agent]));
  const out = new Map<string, A[]>();
  for (const agent of agents) {
    if (agent.role !== 'worker') continue;
    const seen = new Set([agent.id]);
    let parent = agent.parentAgentId ? byId.get(agent.parentAgentId) : undefined;
    while (parent?.role === 'worker' && !seen.has(parent.id)) {
      seen.add(parent.id);
      const descendants = out.get(parent.id) ?? [];
      descendants.push(agent);
      out.set(parent.id, descendants);
      parent = parent.parentAgentId ? byId.get(parent.parentAgentId) : undefined;
    }
  }
  return out;
}
