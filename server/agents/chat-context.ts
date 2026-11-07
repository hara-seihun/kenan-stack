// Which chat a person's message came from. A Kenaznia has one conversation history for all of a person's chats with it,
// so a bare "yes" typed in one of several chats reaches it with nothing saying which chat, or which question, it answers
// (Alex, 2026-11-01). Every human message therefore carries its chat, and a short one the agent's last words there.
import type { ConversationSummary, Message } from '../../shared/contract.js';
import type { AgentInfo } from '../../shared/contract.js';
import type { AgentInput, Deps } from '../types.js';

/** A message this short is a reply to the agent's last words in its chat ("yes", "do it", "the second one"). */
export const SHORT_REPLY_CHARS = 80;
/** How much of those last words the agent is shown: their end, where a question or offer usually sits. */
export const ANSWERED_CHARS = 400;
/** How far back to look for the agent's last shown words in the chat. */
const LOOKBACK = 40;

export type ChatContext = NonNullable<AgentInput['chat']>;

export async function chatContext(deps: Pick<Deps, 'store'>, agent: AgentInfo, message: Message, conversation: ConversationSummary): Promise<ChatContext> {
  const base: ChatContext = { id: conversation.id, title: conversation.title, own: conversation.id === agent.conversationId };
  if (message.text.trim().length > SHORT_REPLY_CHARS) return base;
  const { messages } = await deps.store.listMessages(conversation.id, { kind: 'latest' }, LOOKBACK);
  const last = messages.filter(m => m.seq < message.seq && m.role === 'assistant' && m.authorId === agent.id && m.display === 'shown' && m.text.trim()).at(-1);
  return last ? { ...base, answers: tail(last.text.trim(), ANSWERED_CHARS) } : base;
}

const tail = (text: string, chars: number): string => text.length <= chars ? text : `…${text.slice(-chars).trimStart()}`;

/** The lines the agent reads after the message's words. */
export function chatLines(chat: ChatContext): string[] {
  const where = `[in the chat “${chat.title}” (id ${chat.id})${chat.own ? ', your own chat' : ''}]`;
  return chat.answers === undefined ? [where] : [where, `[a short reply; your last message in that chat ended: “${chat.answers.replace(/\s*\n\s*/g, ' ⏎ ')}”]`];
}
