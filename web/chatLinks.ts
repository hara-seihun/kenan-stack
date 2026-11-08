// Chat links in messages: an agent writes [🎨 App Redesign](chat:<conversation id>) and she taps it to open that chat.
// Following one remembers where she was, so Back returns there; navigating any other way forgets the trail.
import { createContext } from 'react';
import type { Page } from './screens.js';
import type { History } from './history.js';
import type { UpdateScroll } from './updateResume.js';

const CHAT_HREF = /^chat:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:#([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[1-9][0-9]*))?$/i;
export interface ChatTarget { conversationId: string; message?: string }
export function parseChatLink(href: string): ChatTarget | null {
  const match = CHAT_HREF.exec(href.trim());
  return match ? { conversationId: match[1]!.toLowerCase(), ...(match[2] ? { message: match[2].toLowerCase() } : {}) } : null;
}
export const chatLinkTarget = (href: string): string | null => parseChatLink(href)?.conversationId ?? null;
/** A normal app URL for opening or copying a message link outside the running app. */
export const chatLinkHref = ({ conversationId, message }: ChatTarget): string => `?conversationId=${encodeURIComponent(conversationId)}${message ? `&messageId=${encodeURIComponent(message)}` : ''}`;

/** What message rendering needs: whether she can open a conversation, and opening it. Absent: chat links show as plain text. */
export interface ChatLinks { back?: (() => void) | null; canOpen(id: string): boolean; open(id: string, message?: string): void }
export const ChatLinkContext = createContext<ChatLinks | null>(null);

export interface Place { page: Page; active: string | null; message?: string; scroll?: UpdateScroll | null; history?: History }
/** The places Back returns to (newest last) and where the last link or Back took her. */
export interface Trail { back: Place[]; at: Place | null }
export const NO_TRAIL: Trail = { back: [], at: null };
const same = (a: Place, b: Place) => a.page === b.page && a.active === b.active;

export const follow = (trail: Trail, from: Place, to: Place): Trail => ({ back: [...trail.back, from], at: to });
/** Back along the trail: the place to return to and the shorter trail, or null when the trail is empty. */
export function retrace(trail: Trail): { to: Place; trail: Trail } | null {
  const to = trail.back.at(-1);
  return to ? { to, trail: { back: trail.back.slice(0, -1), at: to } } : null;
}
/** She is now `here`: the trail survives only if a link or Back brought her here. */
export const arrive = (trail: Trail, here: Place): Trail => trail.at && same(trail.at, here) ? trail : trail.back.length ? NO_TRAIL : trail;
