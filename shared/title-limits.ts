import { CARD_LINE_MAX } from './contract.js';

/** Limits apply to new names and titles, not stored records being read. */
export const WORKER_TITLE_MAX = CARD_LINE_MAX;
export const GOAL_TITLE_MAX = CARD_LINE_MAX;

export function titleRefusal(what: 'title' | 'name', value: string): string | null {
  const max = what === 'title' ? GOAL_TITLE_MAX : WORKER_TITLE_MAX;
  return value.length > max ? `${what}_too_long: "${value}" is ${value.length} characters; worker names and goal titles are at most ${max}. Write a shorter one (put the detail in text); nothing was changed.` : null;
}
