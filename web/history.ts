// The client keeps a bounded, contiguous window of each conversation's messages and pages it
// toward older or newer history as the transcript scrolls.
import type { Message, MessagePage } from '../shared/contract.js';

export const PAGE_SIZE = 50;
/** Maximum messages kept per conversation; paging further drops the far end of the window. */
export const WINDOW_SIZE = 250;

export type History = MessagePage;

/** Server versions order by the server's updatedAt; a settled message always replaces its streaming copy. */
const newer = (candidate: Message, existing: Message) =>
  (existing.state === 'streaming' && candidate.state !== 'streaming') ||
  candidate.updatedAt > existing.updatedAt || (candidate.updatedAt === existing.updatedAt && existing.clipped && !candidate.clipped);

function combine(current: Message[], incoming: Message[]): Message[] {
  const byId = new Map(current.map(m => [m.id, m]));
  for (const m of incoming) {
    const existing = byId.get(m.id);
    if (!existing || newer(m, existing)) byId.set(m.id, m);
  }
  return [...byId.values()].sort((a, b) => a.seq - b.seq);
}

/** A live message event: replace it inside the window, or append it when the window reaches the newest message. */
export function upsert(history: History, message: Message): History {
  const { messages } = history;
  const last = messages.at(-1);
  if (!last || message.seq > last.seq) return history.hasNewer ? history : { ...history, messages: [...messages, message] };
  if (message.seq < messages[0]!.seq) return history.hasOlder ? history : { ...history, messages: [message, ...messages] };
  const index = messages.findIndex(m => m.id === message.id);
  if (index < 0) return { ...history, messages: combine(messages, [message]) };
  if (!newer(message, messages[index]!)) return history;
  const next = messages.slice(); next[index] = message;
  return { ...history, messages: next };
}

/** Deltas grow the text only: updatedAt stays the server's, so the settled message still counts as newer. */
export function appendDelta(history: History, messageId: string, text: string): History {
  const index = history.messages.findIndex(m => m.id === messageId);
  if (index < 0) return history;
  const next = history.messages.slice(), m = next[index]!;
  if (m.state !== 'streaming') return history;
  next[index] = { ...m, text: m.text + text };
  return { ...history, messages: next };
}

/** The newest page, from first open or a reconnect. Merges when it touches the window; otherwise it becomes the window. */
export function acceptLatest(history: History | undefined, page: MessagePage): History {
  if (!history || !history.messages.length) return page;
  if (history.hasNewer) return history;
  const last = history.messages.at(-1)!, first = page.messages[0];
  if (!first || first.seq > last.seq + 1) return page;
  return { messages: combine(history.messages, page.messages), hasOlder: history.hasOlder || page.hasOlder, hasNewer: false };
}

/** A page fetched with `before = first seq`; drops the newest messages beyond the window. */
export function prependOlder(history: History, page: MessagePage): History {
  const messages = combine(history.messages, page.messages);
  const excess = messages.length - WINDOW_SIZE;
  return excess > 0
    ? { messages: messages.slice(0, WINDOW_SIZE), hasOlder: page.hasOlder, hasNewer: true }
    : { messages, hasOlder: page.hasOlder, hasNewer: history.hasNewer };
}

/** A page fetched with `after = last seq`; drops the oldest messages beyond the window. */
export function appendNewer(history: History, page: MessagePage): History {
  const messages = combine(history.messages, page.messages);
  const excess = messages.length - WINDOW_SIZE;
  return excess > 0
    ? { messages: messages.slice(excess), hasOlder: true, hasNewer: page.hasNewer }
    : { messages, hasOlder: history.hasOlder, hasNewer: page.hasNewer };
}

/** While following the newest messages, live growth beyond the window drops the oldest page. */
export function trimForFollowing(history: History): History {
  if (history.hasNewer || history.messages.length <= WINDOW_SIZE + PAGE_SIZE) return history;
  return { ...history, messages: history.messages.slice(-WINDOW_SIZE), hasOlder: true };
}
