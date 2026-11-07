// Blank chats (server/agents/blank.ts): the small part the app needs at startup; the start form is web/BlankChat.tsx, loaded on demand.
import type { AgentInfo, ConversationSummary } from '../shared/contract.js';
import type { CSSProperties } from 'react';
import { api } from './client.js';

/** Closing a blank chat archives its run; it then leaves every list. */
export const closeBlankChat = (agentId: string) => api<AgentInfo>(`/agents/${encodeURIComponent(agentId)}`, 'PATCH', { archived: true });
export const blankAgentOf = (conversation: ConversationSummary | null | undefined, agents: AgentInfo[]): AgentInfo | null =>
  conversation?.agentId ? agents.find(a => a.id === conversation.agentId && a.role === 'blank') ?? null : null;
export const openBlankChats = (agents: AgentInfo[]) => agents.filter(a => a.role === 'blank' && !a.archived).sort((a, b) => b.createdAt - a.createdAt);
export type BlankStarted = { agent: AgentInfo; conversation: ConversationSummary };

/** Where the popover sits: under the button, right edges aligned, kept inside the screen. */
export function popoverPlace(button: { left: number; right: number; bottom: number }, screen: { width: number; height: number }): CSSProperties {
  const width = Math.min(300, screen.width - 16), top = button.bottom + 6;
  const left = Math.max(8, Math.min(button.right - width, screen.width - 8 - width));
  return { position: 'fixed', top, left, width, maxHeight: screen.height - top - 12 };
}
