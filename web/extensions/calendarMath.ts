// Pure calendar arithmetic for the Organized calendar views (Monday weeks, ranges, overlap lanes, zoom, drag snapping).
export type View = 'day' | 'week' | 'month';
export const MIN_HOUR_PX = 20, MAX_HOUR_PX = 120;
export const clampZoom = (px: number) => Math.min(MAX_HOUR_PX, Math.max(MIN_HOUR_PX, px));
export const startOfDay = (t: Date) => new Date(t.getFullYear(), t.getMonth(), t.getDate());
export const addDays = (t: Date, n: number) => new Date(t.getFullYear(), t.getMonth(), t.getDate() + n);
/** Weeks always start on Monday, whatever the locale (Carol, 2026-10-21). */
export const startOfWeek = (t: Date) => addDays(startOfDay(t), -((t.getDay() + 6) % 7));
/** Whether an event is over at `now` (Alice, 2026-11-01: the calendar shows only what hasn't happened yet): its end has
 *  passed; an all-day one (dates, end exclusive) at local midnight after its last day. */
export function isOver(e: { start: string | number; end: string | number; allDay?: boolean }, now: number): boolean {
  const at = (v: string | number) => typeof v === 'number' ? v : Date.parse(e.allDay && v.length <= 10 ? `${v}T00:00:00` : v);
  const end = at(e.end);
  return (e.allDay ? Math.max(end, addDays(new Date(at(e.start)), 1).getTime()) : end) <= now;
}
/** The days a view shows, first to last (month: whole weeks around the month). */
export function rangeOf(view: View, anchor: Date): { from: Date; to: Date } {
  if (view === 'day') return { from: startOfDay(anchor), to: addDays(startOfDay(anchor), 1) };
  if (view === 'week') return { from: startOfWeek(anchor), to: addDays(startOfWeek(anchor), 7) };
  const start = new Date(anchor.getFullYear(), anchor.getMonth(), 1), last = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 1);
  return { from: startOfWeek(start), to: addDays(startOfWeek(addDays(last, -1)), 7) };
}
/** Side-by-side columns for overlapping events: each gets its column and the column count of its overlap group. */
export function lanes(items: { id: string; start: number; end: number }[]): Map<string, { col: number; cols: number }> {
  const out = new Map<string, { col: number; cols: number }>(), sorted = [...items].sort((a, b) => a.start - b.start || b.end - a.end);
  let group: string[] = [], ends: number[] = [], groupEnd = -Infinity;
  const close = () => { for (const id of group) out.get(id)!.cols = ends.length; group = []; ends = []; };
  for (const e of sorted) {
    if (e.start >= groupEnd) close();
    let col = ends.findIndex(end => end <= e.start);
    if (col < 0) { col = ends.length; ends.push(e.end); } else ends[col] = e.end;
    out.set(e.id, { col, cols: 0 }); group.push(e.id); groupEnd = Math.max(groupEnd, e.end);
  }
  close();
  return out;
}

export const SNAP_MINUTES = 15;
const snap = (minutes: number) => Math.round(minutes / SNAP_MINUTES) * SNAP_MINUTES;
const minutesOf = (t: Date) => t.getHours() * 60 + t.getMinutes();
const at = (day: Date, minutes: number) => new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, minutes);
/** A dragged event's new times: its start moves by dy px (at hourPx px/hour) and `days` days, snapped to 15 minutes
 *  within its day; the length stays the same. */
export function moved(start: Date, end: Date, dy: number, days: number, hourPx: number): { start: Date; end: Date } {
  const minutes = Math.min(24 * 60 - SNAP_MINUTES, Math.max(0, snap(minutesOf(start) + dy / hourPx * 60)));
  const next = at(addDays(startOfDay(start), days), minutes);
  return { start: next, end: new Date(next.getTime() + (end.getTime() - start.getTime())) };
}
/** A resized event's new end: moved by dy px, snapped to 15 minutes, at least 15 minutes after the start and no later
 *  than the end of the start's day (an overnight event keeps its reach). */
export function resized(start: Date, end: Date, dy: number, hourPx: number): { start: Date; end: Date } {
  const day = startOfDay(start), from = Math.round((end.getTime() - day.getTime()) / 60_000);
  const minutes = Math.min(Math.max(24 * 60, from), Math.max(minutesOf(start) + SNAP_MINUTES, snap(from + dy / hourPx * 60)));
  return { start, end: at(day, minutes) };
}

/** Week view's event text: 11px on a 13px line inside 2px padding (Carol, 2026-10-22: Google Calendar's phone week). */
export const WEEK_LINE_PX = 13, WEEK_PAD_PX = 2;
/** How a week-view block of `heightPx` for an event of `minutes` shows its text: a short event (under 45 minutes) gets
 *  one line; otherwise the title takes the lines that fit, and the start time a line of its own once three fit. */
export function weekText(minutes: number, heightPx: number): { lines: number; time: boolean } {
  if (minutes < 45) return { lines: 1, time: false };
  const fit = Math.max(1, Math.floor((heightPx - 2 * WEEK_PAD_PX) / WEEK_LINE_PX));
  return fit >= 3 ? { lines: fit - 1, time: true } : { lines: fit, time: false };
}
/** Where lane `col` of `cols` overlapping events sits in its day column, as fractions of the column: each is at least
 *  40% wide and they overlap a little, Google-style, instead of splitting the column into slivers. */
export function overlapPlace(col: number, cols: number): { left: number; width: number } {
  if (cols <= 1) return { left: 0, width: 1 };
  const width = Math.max(0.4, Math.min(1, 1.2 / cols));
  return { left: col * (1 - width) / (cols - 1), width };
}
/** The 24 hour-column labels in `format`'s locale, compact so each stays on one line in the 48 px gutter: the day
 *  period loses its dots ("12 p.m." → "12 pm", Carol 2026-10-25: en-CA's "p.m." wrapped onto the next hour). */
export const hourLabels = (format: Intl.DateTimeFormat) => Array.from({ length: 24 }, (_, h) =>
  format.formatToParts(new Date(2000, 0, 1, h)).map(p => p.type === 'dayPeriod' ? p.value.replace(/\./g, '') : p.value).join('').replace(/\s+/g, ' ').trim());
