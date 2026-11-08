// Demo data for the Organized layout (?demo=1, for development and tests): a full, made-up set of to-dos,
// projects, topics, events and activity, held in memory only. Nothing here is ever sent to the server.
import type { Trip } from './screens.js';
import { todayIn } from '../../../shared/zone.js';
import type { Activity, AgentInfo, Bootstrap, ChatGroup, ConversationSummary, Person, Todo, TodoLevel } from '../../../shared/contract.js';

export interface DemoEvent { id: string; title: string; start: string; end: string; allDay?: boolean; color?: string | null; location?: string; notes?: string; seriesId?: string; deleted: boolean }
export interface DemoFile { id: string; name: string; mime: string }
export interface DemoMessage { id: string; mine: boolean; text: string; at: number }
export interface DemoData {
  conversations: ConversationSummary[]; agents: AgentInfo[]; people: Person[]; activity: Record<string, Activity>;
  groups: ChatGroup[]; todos: Todo[]; events: DemoEvent[]; files: Record<string, DemoFile[]>; messages: Record<string, DemoMessage[]>; trip: Trip;
}

// Fictional public demo: a community garden and a reading list.
export function demoData(me: Person, now: number): DemoData {
  const manager = 'demo-manager';
  const conversation: ConversationSummary = {
    id: 'demo-main', title: 'Kenaznia', emoji: '🌀', ownerId: me.id, memberIds: [me.id, manager], agentId: manager,
    archived: false, color: null, memberColors: {}, pinnedAt: null, keyDate: null, keyLabel: null, titleLocked: false,
    project: false, statusLine: null, projectId: null, groupId: null, lastSeq: 1, readThrough: 0,
    lastMessage: { authorId: manager, preview: 'The garden plan is ready.', at: now, seq: 1 }, updatedAt: now,
  };
  const agent: AgentInfo = { originConversationId: null, speed: 'normal', id: manager, name: 'Kenaznia', kind: 'agent',
    ownerId: me.id, parentAgentId: null, archived: false, role: 'manager', conversationId: 'demo-main', goalId: null,
    state: 'idle', model: 'demo', createdAt: now, updatedAt: now, lastReport: null, wakes: [] };
  const garden: ConversationSummary = { ...conversation, id: 'demo-garden', title: 'Community garden', emoji: '🌱',
    agentId: null, project: true, statusLine: 'Choose seedlings on Saturday.', pinnedAt: now,
    lastMessage: { authorId: manager, preview: 'Tomatoes and herbs fit the available space.', at: now, seq: 1 } };
  const todo: Todo = { id: 'demo-todo', text: 'Choose tomato seedlings', details: 'Bring the garden plan.', level: 'today',
    tag: 'Garden', dueAt: null, onDate: null, remind: false, onHome: false, position: 1, conversationId: garden.id,
    ownRoom: false, doneAt: null, deletedAt: null, options: null, answer: null, dismissedAt: null, createdAt: now, updatedAt: now };
  return { conversations: [conversation, garden], agents: [agent], people: [me, agent], activity: {}, groups: [],
    todos: [todo], events: [], files: {}, messages: { 'demo-main': [
      { id: 'demo-message', mine: false, text: 'The community garden plan is ready. Shall I add a reading list too?', at: now }
    ] }, trip: { at: now + 7 * 86_400_000, place: 'Example City' } };
}

/** The demo's Bootstrap: the real one's identity and channel, every list replaced by demo data. */
export function demoBoot(real: Bootstrap, data: DemoData): Bootstrap {
  return {
    ...real, people: data.people, agents: data.agents, goals: [], conversations: data.conversations, activity: data.activity,
    manager: { kind: 'here', conversationId: 'demo-main' }, layout: 'organized',
    extensions: [...real.extensions.filter(e => e.id !== 'calendar'), { id: 'calendar', name: 'Calendar' }],
  };
}
