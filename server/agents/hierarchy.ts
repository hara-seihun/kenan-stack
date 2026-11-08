import type { AgentInfo } from '../../shared/contract.js';
import type { Deps } from '../types.js';

type Lineage = Pick<AgentInfo, 'id' | 'role' | 'model' | 'parentAgentId' | 'archived' | 'state' | 'goalId'>;

const live = (agent: Lineage) => !agent.archived && agent.state !== 'stopped';

/** The nearest live ancestor that can act for the person on lifecycle matters, or the person's manager. */
export function supervisorIn<A extends Lineage>(agent: Lineage, agents: ReadonlyMap<string, A>, managerId: string | null): A | null {
  const seen = new Set([agent.id]);
  for (let id = agent.parentAgentId; id && !seen.has(id); id = agents.get(id)?.parentAgentId ?? null) {
    seen.add(id);
    const ancestor = agents.get(id);
    if (!ancestor) break;
    if (ancestor.role === 'manager') return ancestor;
    if (live(ancestor)) return ancestor;
  }
  return managerId ? agents.get(managerId) ?? null : null;
}

export async function supervisorOf(deps: Pick<Deps, 'config' | 'store' | 'runtime'>, agent: AgentInfo): Promise<AgentInfo | null> {
  const all = await deps.store.agentAncestors(agent.ownerId, [agent.id, deps.runtime.managerFor(agent.ownerId)].filter((id): id is string => !!id));
  const byId = new Map(all.map(a => [a.id, a]));
  return supervisorIn(byId.get(agent.id) ?? agent, byId, deps.runtime.managerFor(agent.ownerId));
}

export type ReparentRefusal = 'reparent_parent_not_found' | 'reparent_cycle';
export class ReparentRefused extends Error {
  constructor(readonly code: ReparentRefusal, detail: string) { super(`${code}: ${detail}; nothing was moved`); }
}

/** Every worker may move, retaining its goal. Only existing parents and acyclic trees are valid. */
export function checkReparent<A extends Lineage>(worker: A, parent: A | undefined, agents: ReadonlyMap<string, A>): A {
  const ancestors = (from: Lineage) => { const out: string[] = []; for (let id = from.parentAgentId; id && !out.includes(id); id = agents.get(id)?.parentAgentId ?? null) out.push(id); return out; };
  if (!parent || (parent.role !== 'worker' && parent.role !== 'manager')) throw new ReparentRefused('reparent_parent_not_found', 'the new parent must be one of this person\'s workers or Kenaznia');
  if (parent.id === worker.id || ancestors(parent).includes(worker.id)) throw new ReparentRefused('reparent_cycle', `${parent.id} is ${worker.id} or below it`);
  return parent;
}
