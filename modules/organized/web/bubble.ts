import { formatDate } from '../../../web/dates.js';
// The floating 🌀 bubble and quick panel (web/organized/Bubble.tsx): where the bubble rests, how the panel settles after
// a drag, and the words around them. Pure, so the gestures' decisions are tested without a browser. Only the bubble's
// own chunk imports it.

export type Side = 'left' | 'right';
/** Where the bubble rests: against one side edge, `y` from the top (0) to the bottom (1) of the room it has. */
export interface BubblePlace { side: Side; y: number }
/** Per device: a place for phones and one for wide screens (each null until she first drags it), and whether she hid it. */
export interface BubbleSaved { phone: BubblePlace | null; wide: BubblePlace | null; hidden: boolean }
export const BUBBLE_KEY = 'kenan.bubble';
export const BUBBLE_SIZE = 40;
/** Before she has placed it, the bubble sits at the bottom right (mockup A3). */
export const FIRST_PLACE: BubblePlace = { side: 'right', y: 1 };
const NOTHING_SAVED: BubbleSaved = { phone: null, wide: null, hidden: false };

const placeOf = (v: unknown): BubblePlace | null | 'invalid' => {
  if (v === null) return null;
  const p = v as Partial<BubblePlace> | undefined;
  return p && (p.side === 'left' || p.side === 'right') && typeof p.y === 'number' && p.y >= 0 && p.y <= 1 ? { side: p.side, y: p.y } : 'invalid';
};
/** What this device saved; nothing saved, or something unreadable, is the first-use state. */
export function readBubble(raw: string | null): BubbleSaved {
  if (raw === null) return NOTHING_SAVED;
  let v: Partial<Record<keyof BubbleSaved, unknown>>;
  try { v = JSON.parse(raw) as typeof v; } catch { return NOTHING_SAVED; }
  const phone = placeOf(v?.phone ?? null), wide = placeOf(v?.wide ?? null);
  return phone === 'invalid' || wide === 'invalid' || typeof v.hidden !== 'boolean' ? NOTHING_SAVED : { phone, wide, hidden: v.hidden };
}

/** The rectangle the bubble's top-left corner may rest in. */
export interface Room { left: number; top: number; right: number; bottom: number }
export const pointOf = (room: Room, place: BubblePlace) => ({ x: place.side === 'left' ? room.left : room.right, y: room.top + place.y * Math.max(0, room.bottom - room.top) });
/** Let go anywhere: it goes to the nearer side edge, at that height (kept inside its room). */
export function snap(room: Room, x: number, y: number): BubblePlace {
  const span = room.bottom - room.top;
  return { side: x + BUBBLE_SIZE / 2 < (room.left + room.right + BUBBLE_SIZE) / 2 ? 'left' : 'right', y: span <= 0 ? 1 : Math.min(1, Math.max(0, (y - room.top) / span)) };
}
/** Whether a point (the finger) is over the round ✕ target. */
export const over = (x: number, y: number, target: { x: number; y: number; r: number }) => Math.hypot(x - target.x, y - target.y) <= target.r;

export type PanelSize = 'quarter' | 'tall';
/** ¼ of the screen (two or three lines and the field, never less than that) and ⅔ (mockups C2, D2). */
export function panelHeights(screen: number): Record<PanelSize, number> {
  return { quarter: Math.max(200, Math.round(screen / 4)), tall: Math.max(260, Math.round(screen * 2 / 3)) };
}
/**
 * Where the panel goes when the finger lets go of its handle (velocity in px/ms, positive while it grows): pulled below
 * ¾ of the quarter, or flicked down from the quarter, it closes; otherwise ⅔ or ¼, whichever its height plus the
 * flick's momentum is nearer. A flick down from ⅔ stops at ¼.
 */
export function settlePanel(height: number, velocity: number, heights: Record<PanelSize, number>): PanelSize | 'closed' {
  if (height < heights.quarter * 0.75 || (height <= heights.quarter * 1.05 && velocity < -0.8)) return 'closed';
  const headed = height + velocity * 150;
  return Math.abs(headed - heights.tall) < Math.abs(headed - heights.quarter) ? 'tall' : 'quarter';
}

/** The recording chip's clock: 0:04, 1:12. */
export const clock = (ms: number) => { const s = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

/** A small time line in the panel before a message that starts a new stretch (the first, or after an hour's quiet). */
export function stretchLabel(previous: number | null, at: number, now: number): string | null {
  if (previous !== null && at - previous < 3_600_000) return null;
  const d = new Date(at), today = new Date(now), time = formatDate(d, { hour: 'numeric', minute: '2-digit' });
  if (d.toDateString() === today.toDateString()) return previous === null || new Date(previous).toDateString() === d.toDateString() ? time : `Today ${time}`;
  const yesterday = new Date(now - 86_400_000);
  return `${d.toDateString() === yesterday.toDateString() ? 'Yesterday' : formatDate(d, { weekday: 'short', month: 'short', day: 'numeric' })} ${time}`;
}

/** `words` after what is in the field, one space between. */
export const joined = (field: string, words: string) => [field.trimEnd(), words.trim()].filter(Boolean).join(' ');
/** Words put in the field before their final text: what the field was, and what it became. */
export interface Placed { base: string; shown: string }
export const placeWords = (field: string, soFar: string): Placed => ({ base: field, shown: joined(field, soFar) });
/** The final text replaces the words placed earlier while the field is as they left it; once she has edited it, the
 *  field is hers and stays as she made it. */
export const settleWords = (field: string, placed: Placed, final: string) => field === placed.shown ? joined(placed.base, final) : field;

/** Her words on their way (Carol 2026-10-27: a dictation sat at "Finishing…" for a minute, she closed the panel and
 *  thought her words were lost), kept on this device until the chat has them or the field shows them, so a reload, an
 *  app update or the app being killed in between loses nothing. `clientId` makes sending them again land once. `text`
 *  is null while finishing with no words heard yet. */
export interface OnWay { key: string; clientId: string; text: string | null; phase: 'finishing' | 'sending'; at: number }
export const ON_WAY_KEY = 'kenan.bubble.onway';
/** How long "Finishing…" may last after she stops before her words go in the field to send herself (the rest joins them
 *  when it is written down). A healthy engine takes a second or two; a failing one was a minute (2026-10-27). */
export const FINISH_MS = 15_000;
const DAY = 86_400_000;
const onWayOf = (v: unknown): OnWay | null => {
  const o = v as Partial<OnWay> | null;
  return o && typeof o.key === 'string' && typeof o.clientId === 'string' && (o.text === null || typeof o.text === 'string')
    && (o.phase === 'finishing' || o.phase === 'sending') && typeof o.at === 'number'
    ? { key: o.key, clientId: o.clientId, text: o.text, phase: o.phase, at: o.at } : null;
};
/** What this device kept, newer than a day; an unreadable entry is dropped, as is a sending one with no text. */
export function readOnWay(raw: string | null, now: number): OnWay[] {
  if (raw === null) return [];
  let v: unknown;
  try { v = JSON.parse(raw); } catch { return []; }
  return Array.isArray(v) ? v.map(onWayOf).filter((o): o is OnWay => !!o && now - o.at < DAY && !(o.phase === 'sending' && o.text === null)) : [];
}
export const putOnWay = (all: OnWay[], item: OnWay) => all.some(o => o.key === item.key) ? all.map(o => o.key === item.key ? item : o) : [...all, item];
export const dropOnWay = (all: OnWay[], key: string) => all.filter(o => o.key !== key);
/** After a reload, what to do with each kept item: send it again (it was being sent: the same clientId lands it once),
 *  put its words in the field (it was still being finished), or say it was lost before any words came. */
export type Recovery = { kind: 'send'; item: OnWay & { text: string } } | { kind: 'field'; item: OnWay & { text: string } } | { kind: 'unheard'; item: OnWay };
export const recover = (item: OnWay): Recovery => item.text === null || !item.text.trim() ? { kind: 'unheard', item }
  : item.phase === 'sending' ? { kind: 'send', item: { ...item, text: item.text } } : { kind: 'field', item: { ...item, text: item.text } };
