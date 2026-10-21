import { useEffect, useState } from 'react';
import { AlertCircle, AlertTriangle, ChevronRight, Circle, Clock } from 'lucide-react';
import { isSubAgent } from '../shared/swarm.js';
import { unread, type Activity, type AgentInfo, type AgentState, type ConversationSummary, type GoalSummary, type WakeSource } from '../shared/contract.js';

/** `context`: an archived ancestor shown only so an active descendant keeps its real place in the tree. */
export interface AgentNode { agent: AgentInfo; context: boolean; children: AgentNode[] }

/** What a row says about an agent: active means unarchived, whether it is running, waiting on a wake or idle. A waiting
 * worker is a warning: long waits belong to the manager as held triggers (`holding`), so a worker still waiting stands out. */
export type AgentStatus =
  | { kind: 'archived' }
  | { kind: 'running' }
  | { kind: 'waiting'; since: number; at: number | null; on: WakeSource[] }
  | { kind: 'holding'; count: number }
  | { kind: 'idle' }
  | { kind: 'stopped' | 'interrupted' | 'error' };

export function agentStatus(agent: AgentInfo): AgentStatus {
  if (agent.archived) return { kind: 'archived' };
  if (agent.state === 'running') return { kind: 'running' };
  if (agent.state === 'idle' && agent.wakes.length && agent.role === 'manager') return { kind: 'holding', count: agent.wakes.length };
  if (agent.state === 'idle' && agent.wakes.length) {
    const deadlines = agent.wakes.flatMap(wake => wake.at === null ? [] : [wake.at]);
    return { kind: 'waiting', since: Math.min(...agent.wakes.map(wake => wake.since)), at: deadlines.length ? Math.min(...deadlines) : null, on: [...new Set(agent.wakes.flatMap(wake => wake.on === null ? [] : [wake.on]))] };
  }
  const states: Record<Exclude<AgentState, 'running'>, AgentStatus> = { idle: { kind: 'idle' }, stopped: { kind: 'stopped' }, interrupted: { kind: 'interrupted' }, error: { kind: 'error' } };
  return states[agent.state];
}

const rank: Record<AgentStatus['kind'], number> = { running: 0, waiting: 1, holding: 2, idle: 2, interrupted: 3, error: 3, stopped: 4, archived: 5 };

export function agentTree(agents: AgentInfo[], includeArchived: boolean): AgentNode[] {
  const byId = new Map(agents.map(agent => [agent.id, agent]));
  const visible = new Set<string>();
  for (const agent of agents) {
    if (!includeArchived && agent.archived) continue;
    let current: AgentInfo | undefined = agent;
    const path = new Set<string>();
    while (current && !path.has(current.id)) {
      path.add(current.id); visible.add(current.id);
      current = current.parentAgentId ? byId.get(current.parentAgentId) : undefined;
    }
  }
  const children = new Map<string, AgentInfo[]>();
  const roots: AgentInfo[] = [];
  for (const agent of agents.filter(agent => visible.has(agent.id))) {
    if (agent.parentAgentId && agent.parentAgentId !== agent.id && visible.has(agent.parentAgentId)) {
      children.set(agent.parentAgentId, [...children.get(agent.parentAgentId) ?? [], agent]);
    } else roots.push(agent);
  }
  const visited = new Set<string>();
  const order = (a: AgentInfo, b: AgentInfo) => Number(b.role === 'manager') - Number(a.role === 'manager') || rank[agentStatus(a).kind] - rank[agentStatus(b).kind] || b.createdAt - a.createdAt || a.id.localeCompare(b.id);
  function node(agent: AgentInfo): AgentNode | null {
    if (visited.has(agent.id)) return null;
    visited.add(agent.id);
    return { agent, context: !includeArchived && agent.archived, children: (children.get(agent.id) ?? []).sort(order).map(node).filter((value): value is AgentNode => value !== null) };
  }
  const result = roots.sort(order).map(node).filter((value): value is AgentNode => value !== null);
  for (const agent of agents.filter(agent => visible.has(agent.id)).sort(order)) { const remaining = node(agent); if (remaining) result.push(remaining); }
  return result;
}

export function agentTreeContains(nodes: AgentNode[], conversationId: string | null): boolean {
  return nodes.some(node => node.agent.conversationId === conversationId || agentTreeContains(node.children, conversationId));
}

const ARCHIVED_PAGE = 20;
/** A goal title often repeats the agent's name as its prefix ("Android GPU engines: Vulkan…"); show only what the name doesn't say. */
export function goalLine(name: string, title: string): string {
  if (!title.toLowerCase().startsWith(name.toLowerCase())) return title;
  const rest = title.slice(name.length).replace(/^[\s:·—–-]+/, '');
  return rest || title;
}

const activeCount = (nodes: AgentNode[]): number => nodes.reduce((sum, node) => sum + Number(!node.agent.archived) + activeCount(node.children), 0);
/** Workers waiting on their own wakes: the sidebar counts them as a warning. */
export const waitingCount = (agents: AgentInfo[]) => agents.filter(agent => agentStatus(agent).kind === 'waiting').length;

function clock(at: number, now: number): string {
  const when = new Date(at), today = new Date(now);
  const time = when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return when.toDateString() === today.toDateString() ? time : `${when.toLocaleDateString([], { weekday: 'short' })} ${time}`;
}

const waited = (ms: number) => { const m = Math.max(0, Math.round(ms / 60_000)); return m < 1 ? '' : m < 60 ? `${m}m` : m < 2880 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`; };
const sourceName: Record<WakeSource, string> = { mail: 'mail', signal: 'Signal', text: 'a text', event: 'an event', any: 'news' };

export function statusText(status: AgentStatus, activity: Activity | undefined, now: number): string {
  switch (status.kind) {
    case 'archived': return 'Archived';
    case 'running': return activity?.label ? `Running · ${activity.label}` : 'Running';
    case 'waiting': {
      const event = status.on.length ? `for ${status.on.map(source => sourceName[source]).join(' or ')}` : '';
      const deadline = status.at === null ? '' : `until ${clock(status.at, now)}`;
      return ['Waiting', waited(now - status.since), event, deadline].filter(Boolean).join(' ');
    }
    case 'holding': return `Holding ${status.count} ${status.count === 1 ? 'trigger' : 'triggers'}`;
    case 'idle': return 'Idle';
    case 'stopped': return 'Stopped';
    case 'interrupted': return 'Interrupted';
    case 'error': return 'Error';
  }
}

function StatusIcon({ status }: { status: AgentStatus }) {
  if (status.kind === 'waiting') return <AlertTriangle size={11} className="waiting-dot" aria-label="Waiting: a warning sign"/>;
  if (status.kind === 'holding') return <Clock size={11} className="quiet-dot" aria-hidden="true"/>;
  if (status.kind === 'error' || status.kind === 'interrupted') return <AlertCircle size={11} className="error-dot" aria-hidden="true"/>;
  return <Circle size={7} fill={status.kind === 'idle' ? 'none' : 'currentColor'} className={status.kind === 'running' ? 'running-dot' : 'quiet-dot'} aria-hidden="true"/>;
}

export function AgentTree({ agents, nodes, goals, conversations, activity, active, choose }: { agents: AgentInfo[]; nodes: AgentNode[]; goals: GoalSummary[]; conversations: ConversationSummary[]; activity: Record<string, Activity>; active: string | null; choose: (id: string) => void }) {
  const [toggled, setToggled] = useState<Map<string, boolean>>(new Map());
  const [archivedShown, setArchivedShown] = useState<Map<string, number>>(new Map());
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 60_000); return () => clearInterval(timer); }, []);
  useEffect(() => {
    const byId = new Map(agents.map(agent => [agent.id, agent]));
    let parent = agents.find(agent => agent.conversationId === active)?.parentAgentId;
    const path = new Set<string>();
    while (parent && !path.has(parent)) { path.add(parent); parent = byId.get(parent)?.parentAgentId; }
    if (path.size) setToggled(current => new Map([...current, ...[...path].map(id => [id, true] as const)]));
  }, [active, agents]);
  const goalTitle = new Map(goals.map(goal => [goal.id, goal.title]));
  function archivedGroup(key: string, archived: AgentNode[], label: string) {
    if (!archived.length) return null;
    const shown = archivedShown.get(key) ?? (agentTreeContains(archived, active) ? ARCHIVED_PAGE : 0);
    return <li className="archived-group">
      <button type="button" className="archived-toggle" aria-expanded={shown > 0} onClick={() => setArchivedShown(all => new Map(all).set(key, shown ? 0 : ARCHIVED_PAGE))}><ChevronRight size={13} className={shown ? 'rotated' : ''}/>{label}</button>
      {shown > 0 && <ul>{archived.slice(0, shown).map(render)}</ul>}
      {shown > 0 && shown < archived.length && <button type="button" className="archived-more" onClick={() => setArchivedShown(all => new Map(all).set(key, shown + ARCHIVED_PAGE))}>Show {Math.min(ARCHIVED_PAGE, archived.length - shown)} more of {archived.length - shown}</button>}
    </li>;
  }
  function render(node: AgentNode) {
    const { agent, children, context } = node, conversation = conversations.find(c => c.id === agent.conversationId);
    // A swarm folds under its coordinator until opened: one row however many sub-agents run.
    const swarm = children.some(child => isSubAgent(child.agent, agent));
    const status = agentStatus(agent), open = toggled.get(agent.id) ?? (agent.role === 'manager' || !swarm && activeCount(children) > 0), selected = agent.conversationId === active;
    const goalFull = agent.goalId ? goalTitle.get(agent.goalId) : undefined, goal = goalFull && goalLine(agent.name, goalFull);
    const current = children.filter(child => !child.agent.archived || child.context), archived = children.filter(child => child.agent.archived && !child.context);
    const label = context ? 'Archived launcher' : statusText(status, activity[agent.conversationId], now);
    return <li key={agent.id}>
      <div className={`agent-row${context || agent.archived ? ' lineage-context' : ''}`}>
        {children.length ? <button className="tree-disclosure" type="button" aria-label={`${open ? 'Collapse' : 'Expand'} ${agent.name}'s agents`} aria-expanded={open} onClick={() => setToggled(current => new Map(current).set(agent.id, !open))}><ChevronRight size={15} className={open ? 'rotated' : ''}/></button> : <span className="tree-spacer"/>}
        <button className={`agent-link${selected ? ' selected' : ''}`} type="button" aria-current={selected ? 'page' : undefined} onClick={() => choose(agent.conversationId)} title={[agent.name, goalFull, label].filter(Boolean).join(' · ')}>
          <span className="agent-name"><StatusIcon status={status}/><span className="agent-title">{agent.name}</span>{conversation && unread(conversation) && !selected && <b aria-label="Unread">●</b>}</span>
          <small className={`agent-status ${status.kind}`}>{label}{current.length ? ` · ${current.length} ${swarm ? (current.length === 1 ? 'sub-agent' : 'sub-agents') : current.length === 1 ? 'branch' : 'branches'}` : ''}</small>
          {goal && <small className="agent-goal">{goal}</small>}
        </button>
      </div>
      {children.length > 0 && open && <ul>
        {current.map(render)}
        {archivedGroup(agent.id, archived, `${archived.length} archived`)}
      </ul>}
    </li>;
  }
  const roots = nodes.filter(node => !node.agent.archived || node.context), archivedRoots = nodes.filter(node => node.agent.archived && !node.context);
  return nodes.length ? <ul className="agent-tree">{roots.map(render)}{archivedGroup('', archivedRoots, `${archivedRoots.length} archived without a launcher`)}</ul> : <p className="sidebar-empty">No active agents. Open your conversation to start one.</p>;
}
