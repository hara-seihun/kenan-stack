import { CARD_LINE_MAX } from './contract.js';

/** Limits apply to new names and titles, not stored records being read. */
export const WORKER_TITLE_MAX = CARD_LINE_MAX;
export const GOAL_TITLE_MAX = CARD_LINE_MAX;

export function titleRefusal(what: 'title' | 'name', value: string): string | null {
  const max = what === 'title' ? GOAL_TITLE_MAX : WORKER_TITLE_MAX;
  return value.length > max ? `${what}_too_long: "${value}" is ${value.length} characters; worker names and goal titles are at most ${max}. Write a shorter one (put the detail in text); nothing was changed.` : null;
}

/** A title or name cut to `max` characters at a word boundary (no ellipsis), with dangling punctuation trimmed. A single word longer than `max` is cut mid-word. */
export function fitTitle(value: string, max = WORKER_TITLE_MAX): string {
  const text = value.trim().replace(/\s+/g, ' ');
  if (text.length <= max) return text;
  const head = text.slice(0, max + 1);
  const space = head.lastIndexOf(' ');
  const cut = space > 0 ? head.slice(0, space) : text.slice(0, max);
  // A dangling joining word ("fixes for") reads as cut off; drop it with any trailing punctuation.
  const tidy = cut.replace(/[\s:;,.\-–—(/&+]+$/u, '').replace(/\s+(?:a|an|and|as|at|by|for|from|in|into|of|on|or|the|to|with|via)$/iu, '').replace(/[\s:;,.\-–—(/&+]+$/u, '');
  return tidy || text.slice(0, max);
}
