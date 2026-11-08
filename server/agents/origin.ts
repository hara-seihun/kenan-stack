// Origin chats: a person whose module works in topic chats rather than one main Kenaznia chat (modules/organized) has background
// answers about work (a worker's report or note, a wake, a peer's reply) go back to the chat where the work was asked.
// The chat is recorded for everyone (agent, wake and peer_message origin_conversation_id); only routing is opt-in.
import type { AgentInfo } from '../../shared/contract.js';
import type { PersonConfig } from '../config.js';
import type { ConversationSummary } from '../../shared/contract.js';
import { withModule } from '../modules.js';
import type { AgentInput, AgentTurn, Deps, TurnChat } from '../types.js';

/** Where an agent is answering right now: between turns, in its own chat (answering a person or background input), or in another chat. */
export type TurnPlace = { kind: 'between' } | { kind: 'own'; answersPerson: boolean } | { kind: 'chat'; conversationId: string };
export function placeOf(agent: AgentInfo, turn: AgentTurn | null): TurnPlace {
  if (!turn) return { kind: 'between' };
  if (turn.conversationId !== agent.conversationId) return { kind: 'chat', conversationId: turn.conversationId };
  return { kind: 'own', answersPerson: turn.inputs.some(input => input.kind === 'human' || input.kind === 'room' || input.kind === 'channel') };
}
/** The origin recorded for work started from this place: a spawned worker, a scheduled wake, a peer message. */
export const originOf = (place: TurnPlace): string | null => place.kind === 'chat' ? place.conversationId : null;
/** A launcher's message re-points a worker at the chat it is answering; a background turn in the launcher's own chat (a
 * heartbeat, say) leaves the worker's origin as it was. */
export function retargeted(place: TurnPlace, current: string | null): string | null {
  switch (place.kind) {
    case 'chat': return place.conversationId;
    case 'own': return place.answersPerson ? null : current;
    case 'between': return current;
  }
}

/** The chat an agent's turn answers when that turn is bound to its chat; otherwise the agent's own chat (as for Classic). notify and attach point there. */
export const answeringChat = (agent: AgentInfo, turn: AgentTurn | null): string => turn?.chatBound ? turn.conversationId : agent.conversationId;

/** Whether this person's background answers are routed to the chat their work was asked from: only a module they have can turn it on (modules/organized). */
export async function routesByChat(deps: Pick<Deps, 'store'>, person: PersonConfig): Promise<boolean> {
  for (const m of withModule(person)) if (m.routesByChat && await m.routesByChat(deps, person)) return true;
  return false;
}
/** Whether this person can send work's answers to chosen chats at all (the chatId option of goals, workers and wakes). */
export const canChooseChat = (person: PersonConfig): boolean => withModule(person).some(m => m.routesByChat !== undefined);

/** Where a background input about work from `origin` goes, and what the recipient is told about it. */
export type Route = Pick<AgentInput, 'conversationId' | 'chatBound' | 'where'>;
export async function routeBackground(deps: Pick<Deps, 'store' | 'person'>, recipient: AgentInfo, origin: string | null): Promise<Route> {
  const own: Route = { conversationId: recipient.conversationId };
  const person = deps.person(recipient.ownerId);
  if (!person || !(await routesByChat(deps, person))) return own;
  if (origin === null || origin === recipient.conversationId) return { ...own, chatBound: true };
  const chat = await deps.store.getConversation(origin, recipient.ownerId);
  const why = unreachable(chat, person, recipient);
  const title = chat ? `“${chat.title}”` : 'a chat';
  if (!why) return { conversationId: origin, chatBound: true, where: `This is about work asked for in the chat ${title}; your answer appears there.` };
  return { ...own, chatBound: true, where: `This is about work asked for in the chat ${title}, ${why}, so your answer appears in your own chat; say which chat it came from.` };
}

/** Why an agent's answer can no longer appear in a chat, or null when it can. */
function unreachable(chat: ConversationSummary | null, person: PersonConfig | null, agent: AgentInfo): string | null {
  return !chat ? 'which no longer exists'
    : chat.archived ? 'which is closed'
    : person && !chat.memberIds.includes(person.id) ? `which ${person.name} is no longer in`
    : !chat.memberIds.includes(agent.id) ? 'which you are no longer in'
    : null;
}

/** Where a turn cut off by a restart continues: the chat it was answering, while the agent's answer can still appear there;
 * otherwise its own chat, told why. A turn from before turns recorded their chat continues as background input would. */
export async function resumeRoute(deps: Pick<Deps, 'store' | 'person'>, agent: AgentInfo, turn: TurnChat | null): Promise<Route> {
  if (!turn) return routeBackground(deps, agent, null);
  const bound = turn.chatBound ? { chatBound: true as const } : {};
  if (turn.conversationId === agent.conversationId) return { conversationId: turn.conversationId, ...bound };
  const chat = await deps.store.getConversation(turn.conversationId, agent.ownerId);
  const why = unreachable(chat, deps.person(agent.ownerId) ?? null, agent);
  if (!why) return { conversationId: turn.conversationId, ...bound };
  return { conversationId: agent.conversationId, ...bound, where: `The cut-off turn was answering the chat ${chat ? `“${chat.title}”` : 'a chat'}, ${why}, so your answer appears in your own chat; say which chat it was about.` };
}

/** An origin chosen on purpose ("do this, send it to Business"): a spawn, workers message or wake given chatId sets its origin to that chat. */
export type Origin = { origin: string | null };
/** Validates a manager's chatId. Without routing the origin is recorded but the answer stays in the manager's own chat. */
export async function chatTarget(deps: Pick<Deps, 'store' | 'person'>, manager: AgentInfo, chatId: string): Promise<Origin> {
  if (manager.role !== 'manager') throw new Error('chat_target_manager_only: only Kenaznia sends a piece of work\'s answers to another chat');
  const person = deps.person(manager.ownerId);
  if (!person) throw new Error(`person_not_found: ${manager.ownerId}`);
  return topicChat(deps, person, manager, chatId);
}

/** Validates a goal's chatId: one of the owner's open topic chats that her manager is in, (ignored until routing is on). The manager's own chat is no goal chat (null). */
export async function goalChat(deps: Pick<Deps, 'store' | 'person'>, manager: AgentInfo, chatId: string | null): Promise<Origin> {
  const person = deps.person(manager.ownerId);
  if (!person) throw new Error(`person_not_found: ${manager.ownerId}`);
  return chatId === null ? { origin: null } : topicChat(deps, person, manager, chatId);
}

async function topicChat(deps: Pick<Deps, 'store'>, person: PersonConfig, manager: AgentInfo, chatId: string): Promise<Origin> {
  if (chatId === manager.conversationId) return { origin: null };
  const chat = await deps.store.getConversation(chatId, person.id);
  if (!chat || !chat.memberIds.includes(person.id)) throw new Error(`chat_not_found: no chat ${chatId} of hers; ids come from rooms list`);
  if (chat.agentId) throw new Error('chat_target_agent: that is an agent\'s own chat; pick one of her topic chats');
  if (chat.archived) throw new Error(`chat_closed: “${chat.title}” is closed; reopen it with rooms reopen only if she asks, or pick an open chat`);
  if (!chat.memberIds.includes(manager.id)) throw new Error(`chat_target_not_member: you are not in “${chat.title}”, so your answers cannot appear there`);
  return { origin: chat.id };
}

/** The origin of work a manager starts for a goal: an explicit chatId wins, then the goal's chat, then where the manager is answering. */
export const goalOrigin = (target: Origin | undefined, goalChatId: string | null, current: () => string | null): string | null =>
  target ? target.origin : goalChatId ?? current();
