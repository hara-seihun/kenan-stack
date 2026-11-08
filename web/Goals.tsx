// Her goals and workers, with environment repairs folded away separately.
import type { AgentInfo, Goal, Person } from '../shared/contract.js';
import { MessageMarkdown } from './MessageMarkdown.js';
import { SystemSection } from './SystemSection.js';

export default function Goals({ goals, agents, people, includeArchived, showArchived, choose }: {
  goals: Goal[] | null; agents: AgentInfo[]; people: Person[]; includeArchived: boolean; showArchived(include: boolean): void; choose(conversationId: string): void;
}) {
  const personName = (id: string) => people.find(p => p.id === id)?.name ?? id;
  const visible = agents.filter(agent => agent.role !== 'blank' && (includeArchived || !agent.archived));
  const ordered = [...goals ?? []].sort((a, b) => a.priority - b.priority);
  const goalRows = (items: Goal[]) => items.map(g => <section key={g.id}><h3>{g.title} <small>{g.status}</small></h3><MessageMarkdown source="agent" text={g.detail}/>{g.notes && <MessageMarkdown source="agent" text={g.notes}/>}<small>{g.workerIds.map(personName).join(', ')}</small></section>);
  const agentRows = (items: AgentInfo[]) => items.map(agent => <section key={agent.id}><button onClick={() => choose(agent.conversationId)}>{agent.name}</button><p>{agent.role} · {agent.state} · {agent.model}</p>{agent.lastReport && <MessageMarkdown source="agent" text={agent.lastReport.text}/>}</section>);
  const systemGoals = ordered.filter(g => g.category === 'upkeep'), systemAgents = visible.filter(a => a.category === 'upkeep');
  return <div className="panel"><h2>Goals</h2>
    {!goals && <p>Loading…</p>}{goals && !goals.length && <p>No goals yet. Ask Kenaznia to create one.</p>}
    {goalRows(ordered.filter(g => g.category !== 'upkeep'))}
    <h2>{includeArchived ? 'All agents' : 'Active agents'}</h2>
    <label className="archive-filter"><input type="checkbox" checked={includeArchived} onChange={e => showArchived(e.target.checked)}/>Include archived</label>
    {agentRows(visible.filter(a => a.category !== 'upkeep'))}
    <SystemSection count={systemAgents.length || systemGoals.length}>
      <h2>System goals</h2>{goalRows(systemGoals)}
      <h2>System workers</h2>{agentRows(systemAgents)}
    </SystemSection>
  </div>;
}
