// Who supervises whom (Alice, 2026-10-28: "rework the dispatch hierarchy so you aren't stormed with so many messages;
// managers should be Opus"). Kenaznia launches a few Claude workers that manage an area; each launches research and
// product workers for the goals in its area. A worker's reports and notes go to its parent; what goes "to the manager"
// (long-wait handoffs, triggers of a run that ended) goes to its supervisor: the nearest live ancestor
// that is not research, so a Claude area manager when there is one, else the person's manager.
import type { AgentInfo } from '../../shared/contract.js';
import { isSubAgent } from '../../shared/swarm.js';
import type { Deps } from '../types.js';
import { researchModels } from './research.js';

type Lineage = Pick<AgentInfo, 'id' | 'role' | 'model' | 'parentAgentId' | 'archived' | 'state' | 'goalId'>;

/** A research agent: a worker on a research-only model, or a sub-agent of one (the rule session() applies). */
export function researchIn(agent: Lineage, agents: ReadonlyMap<string, Lineage>, models: ReadonlySet<string>): boolean {
  if (agent.role !== 'worker') return false;
  if (models.has(agent.model)) return true;
  const parent = agent.parentAgentId ? agents.get(agent.parentAgentId) : undefined;
  return parent !== undefined && parent.role === 'worker' && models.has(parent.model);
}

const live = (agent: Lineage) => !agent.archived && agent.state !== 'stopped';

/** The nearest live ancestor that can act for the person on lifecycle matters, or the person's manager. */
export function supervisorIn<A extends Lineage>(agent: Lineage, agents: ReadonlyMap<string, A>, models: ReadonlySet<string>, managerId: string | null): A | null {
  const seen = new Set([agent.id]);
  for (let id = agent.parentAgentId; id && !seen.has(id); id = agents.get(id)?.parentAgentId ?? null) {
    seen.add(id);
    const ancestor = agents.get(id);
    if (!ancestor) break;
    if (ancestor.role === 'manager') return ancestor;
    if (live(ancestor) && !researchIn(ancestor, agents, models)) return ancestor;
  }
  return managerId ? agents.get(managerId) ?? null : null;
}

export async function supervisorOf(deps: Pick<Deps, 'config' | 'store' | 'runtime'>, agent: AgentInfo): Promise<AgentInfo | null> {
  const [all, models] = await Promise.all([deps.store.agentAncestors(agent.ownerId, [agent.id, deps.runtime.managerFor(agent.ownerId)].filter((id): id is string => !!id)), researchModels(deps.config)]);
  const byId = new Map(all.map(a => [a.id, a]));
  return supervisorIn(byId.get(agent.id) ?? agent, byId, models, deps.runtime.managerFor(agent.ownerId));
}

export type ReparentRefusal =
  | 'worker_archived' | 'reparent_sub_agent' | 'reparent_parent_not_found' | 'reparent_parent_inactive'
  | 'reparent_research_parent' | 'reparent_cycle' | 'reparent_same_goal';
export class ReparentRefused extends Error {
  constructor(readonly code: ReparentRefusal, detail: string) { super(`${code}: ${detail}; nothing was moved`); }
}

/**
 * Whether `worker` may move under `parent`. Kenaznia and Claude workers move any worker (research workers can't: the
 * workers tool refuses them before this). A swarm sub-agent stays with its coordinator, and a worker can't go under a research agent (which can't supervise),
 * under itself or its own descendants, or under a worker on its own goal (that would make it a sub-agent).
 */
export function checkReparent<A extends Lineage>(worker: A, parent: A | undefined, agents: ReadonlyMap<string, A>, models: ReadonlySet<string>): A {
  if (worker.archived) throw new ReparentRefused('worker_archived', `${worker.id} is archived`);
  const current = worker.parentAgentId ? agents.get(worker.parentAgentId) : undefined;
  if (isSubAgent(worker, current)) throw new ReparentRefused('reparent_sub_agent', `${worker.id} is a swarm sub-agent of ${current!.id} on the same goal and stays with it`);
  const ancestors = (from: Lineage) => { const out: string[] = []; for (let id = from.parentAgentId; id && !out.includes(id); id = agents.get(id)?.parentAgentId ?? null) out.push(id); return out; };
  if (!parent) throw new ReparentRefused('reparent_parent_not_found', 'the new parent is not one of this person\'s agents');
  if (parent.role !== 'manager' && !live(parent)) throw new ReparentRefused('reparent_parent_inactive', `${parent.id} is archived or stopped`);
  if (researchIn(parent, agents, models)) throw new ReparentRefused('reparent_research_parent', `${parent.id} is a research agent, which can't supervise other goals; pick a Claude worker or the manager`);
  if (parent.id === worker.id || ancestors(parent).includes(worker.id)) throw new ReparentRefused('reparent_cycle', `${parent.id} is ${worker.id} or below it`);
  if (parent.role === 'worker' && parent.goalId !== null && parent.goalId === worker.goalId) throw new ReparentRefused('reparent_same_goal', `${parent.id} works on the same goal, so ${worker.id} would become its sub-agent`);
  return parent;
}
