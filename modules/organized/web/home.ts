// The person's Kenaznia chat in the Organized layout: the manager's main conversation (Classic's main chat), shown
// as one row near the bottom of Home and never as an ordinary topic (Carol 2026-10-21).
import type { Bootstrap, ConversationSummary } from '../../../shared/contract.js';

export const MAIN_EMOJI = '🌀';
export interface MainChat { conversation: ConversationSummary; name: string; emoji: string }

/** Her Kenaznia chat when it answers here; null when the manager is elsewhere or absent. Named after the manager. */
export function mainChat(boot: Bootstrap): MainChat | null {
  if (boot.manager.kind !== 'here') return null;
  const id = boot.manager.conversationId, conversation = boot.conversations.find(c => c.id === id);
  if (!conversation) return null;
  const agent = boot.agents.find(a => a.conversationId === id && a.role === 'manager');
  return { conversation, name: agent?.name ?? conversation.title, emoji: conversation.emoji ?? MAIN_EMOJI };
}
export const isMainChat = (boot: Bootstrap, c: ConversationSummary): boolean => boot.manager.kind === 'here' && boot.manager.conversationId === c.id;
