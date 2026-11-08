// What the server and the app (demo mode) agree on about a to-do: its own chat's emoji, and the section it shows in.
import { TODO_LEVELS, type Todo, type TodoLevel } from './contract.js';
const EMOJI_WORDS: [RegExp, string][] = [
  [/\b(call|phone|ring)\b/i, '📞'], [/\b(e-?mail|mail|reply|write to)\b/i, '✉️'], [/\b(bank|pay|invoice|tax|transfer|bill)\b/i, '🏦'],
  [/\b(sign|contract|nda|form|apply|application)\b/i, '🖊️'], [/\b(flight|trip|travel|visa|book)\b/i, '✈️'], [/\b(buy|order|shop)\b/i, '🛒'],
  [/\b(doctor|dentist|health|pharmacy)\b/i, '🩺'], [/\b(violin|music|practice)\b/i, '🎻'], [/\b(read|review|check)\b/i, '📖'],
  [/\b(install|app|set ?up|sign in|login|password)\b/i, '📱'], [/\b(cv|resume|job|interview)\b/i, '💼'],
];
const TAG_EMOJI: Record<string, string> = { Business: '💼', career: '💼', Exampletown: '🎓', phone: '📱', personal: '🌱', 'kenan app': '🎨' };
/** The emoji for a to-do's own chat: from what the task says, else from its list (tag); a plain task gets ✅. */
export function todoEmoji(text: string, tag: string | null): string {
  return EMOJI_WORDS.find(([words]) => words.test(text))?.[1] ?? (tag ? TAG_EMOJI[tag.toLowerCase()] : undefined) ?? '✅';
}

/** Where an item shows: its level, except that from its day on (onDate ≤ today) it is in Today. Computed when read; levels are never rewritten by the clock. */
export function todoSection(t: Pick<Todo, 'level' | 'onDate'>, today: string): TodoLevel {
  return t.onDate !== null && t.onDate <= today ? 'today' : t.level;
}

/** ❗ at the start of its text marks an item urgent (Carol 2026-10-25): it shows above the rest of any list that holds it. */
export const isUrgent = (t: Pick<Todo, 'text'>): boolean => t.text.trimStart().startsWith('❗');
/** A list as it shows: the urgent items first, then the rest, each group in the order it came. */
export const urgentFirst = <T extends Pick<Todo, 'text'>>(rows: readonly T[]): T[] => [...rows.filter(isUrgent), ...rows.filter(t => !isUrgent(t))];
/** Open items by the section they show in, each in order: urgent (❗) items first, and within each group the section's own
 *  items, then items whose day has brought them in. */
export function todoSections(items: readonly Todo[], today: string): Record<TodoLevel, Todo[]> {
  const open = items.filter(t => !t.doneAt && !t.deletedAt).sort((a, b) => TODO_LEVELS.indexOf(a.level) - TODO_LEVELS.indexOf(b.level) || a.position - b.position);
  return Object.fromEntries(TODO_LEVELS.map(l => [l, urgentFirst(open.filter(t => todoSection(t, today) === l))])) as Record<TodoLevel, Todo[]>;
}
/** Home's "Waiting on you" (Carol 2026-10-21): Today's items, then the open items she asked to have on Home; ❗ ones first. */
export function homeTodos(items: readonly Todo[], today: string): { today: Todo[]; pinned: Todo[] } {
  const by = todoSections(items, today);
  return { today: by.today, pinned: TODO_LEVELS.filter(l => l !== 'today').flatMap(l => by[l].filter(t => t.onHome)) };
}
export const homeWaiting = (items: readonly Todo[], today: string): Todo[] => (h => urgentFirst([...h.today, ...h.pinned]))(homeTodos(items, today));
/** The one order a to-do's colour comes from, wherever it shows (Carol 2026-10-27): where it is placed, the By urgency
 *  order (Today, Soon, Later, Someday, ❗ items first in each). Being on Home doesn't move it: Home reuses this colour. */
export const colourOrder = (items: readonly Todo[], today: string): Todo[] => (by => TODO_LEVELS.flatMap(l => by[l]))(todoSections(items, today));
