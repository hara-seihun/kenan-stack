// The busy line (extension busyline): under a message of hers that waits while her Kenaznia answers another chat, where it is
// and that it will answer soon, in place of the Thinking line until her turn starts. Its own chunk, loaded only when it shows.
import { useContext, useLayoutEffect, useRef } from 'react';
import type { ConversationSummary, Waiting } from '../shared/contract.js';
import { ChatLinkContext } from './chatLinks.js';

/** Where her Kenaznia is while her message in this chat waits: one of her open chats, or other work (null chat). */
export interface WaitLine { chat: ConversationSummary | null; ahead: number }
/** The busy line for a chat: null unless a message of hers waits there behind a turn elsewhere. */
export function waitLine(waiting: Waiting | null, conversationId: string, conversations: ConversationSummary[]): WaitLine | null {
  const ahead = waiting?.queued[conversationId];
  if (!waiting || ahead === undefined) return null;
  const busy = waiting.busy.kind === 'chat' ? waiting.busy.conversationId : null;
  return { chat: conversations.find(c => c.id === busy && !c.archived) ?? null, ahead };
}

/** The line itself; the busy chat is a link when she can open it. */
export function BusyLine({ line, className, follow = () => false }: { line: WaitLine; className: string; follow?: () => boolean }) {
  const links = useContext(ChatLinkContext), chat = line.chat, own = useRef<HTMLParagraphElement>(null);
  // Arriving after the transcript scrolled (this chunk loads late), it keeps a transcript that follows the bottom there.
  useLayoutEffect(() => {
    const box = own.current?.parentElement;
    if (box && follow()) box.scrollTop = box.scrollHeight;
  }, []);
  const name = chat && `${chat.emoji ? `${chat.emoji} ` : ''}${chat.agentId ? `your ${chat.title} chat` : chat.title}`;
  return <p ref={own} className={className} role="status">Kenan is {chat ? <>busy in {links?.canOpen(chat.id) ? <a className="busy-chat" href={`?conversationId=${chat.id}`} onClick={event => { event.preventDefault(); links.open(chat.id); }}>{name}</a> : name}</> : 'finishing other work'} · will answer soon{line.ahead ? ` (${line.ahead} message${line.ahead === 1 ? '' : 's'} ahead)` : ''}</p>;
}

/** The transcript's busy line, from her Kenaznia's queue. */
export default function TranscriptBusyLine({ waiting, conversationId, conversations, follow }: { waiting: Waiting; conversationId: string; conversations: ConversationSummary[]; follow: () => boolean }) {
  const line = waitLine(waiting, conversationId, conversations);
  return line && <BusyLine line={line} className="activity" follow={follow}/>;
}
