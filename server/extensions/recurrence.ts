import ICAL from 'ical.js';

export interface Wall { year: number; month: number; day: number; hour: number; minute: number; second: number }
export type Series = { start: string; end: string; zone: string; allDay: boolean; rule: string; until: string | null; exceptions: readonly string[] };
export interface Occurrence { key: string; start: string; end: string; at: number }
export type RuleError = { code: 'invalid_rule' | 'unsupported_frequency' | 'invalid_zone' | 'invalid_time'; message: string };
export type Parsed<T> = { ok: true; value: T } | { ok: false; error: RuleError };

const SUPPORTED = new Set(['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY']);
const SCAN_LIMIT = 100_000;
const formatters = new Map<string, Intl.DateTimeFormat>();
const pad = (value: number, width = 2) => String(value).padStart(width, '0');

export function validZone(zone: string): boolean {
  try { new Intl.DateTimeFormat('en-US', { timeZone: zone }); return true; } catch { return false; }
}

export function parseRule(raw: string): Parsed<string> {
  const rule = raw.trim().replace(/^RRULE:/i, '');
  let recur: ICAL.Recur;
  try { recur = ICAL.Recur.fromString(rule); } catch (error) { return { ok: false, error: { code: 'invalid_rule', message: `Invalid RRULE: ${(error as Error).message}` } }; }
  if (!recur.freq || !SUPPORTED.has(recur.freq)) return { ok: false, error: { code: 'unsupported_frequency', message: 'Recurrence must be an RRULE with FREQ=DAILY, WEEKLY, MONTHLY or YEARLY' } };
  return { ok: true, value: rule };
}

function formatter(zone: string): Intl.DateTimeFormat {
  let value = formatters.get(zone);
  if (!value) {
    value = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
    formatters.set(zone, value);
  }
  return value;
}

export function wallAt(instant: number, zone: string): Wall {
  const parts = Object.fromEntries(formatter(zone).formatToParts(new Date(instant)).map(part => [part.type, part.value]));
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day), hour: Number(parts.hour), minute: Number(parts.minute), second: Number(parts.second) };
}

const wallUtc = (wall: Wall) => Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
const offsetAt = (instant: number, zone: string) => wallUtc(wallAt(instant, zone)) - Math.floor(instant / 1000) * 1000;

export function instantOf(wall: Wall, zone: string): number {
  const guess = wallUtc(wall);
  const first = guess - offsetAt(guess, zone);
  const second = guess - offsetAt(first, zone);
  return second === first ? first : Math.max(first, second);
}

export function offsetIso(instant: number, zone: string): string {
  const wall = wallAt(instant, zone), offset = Math.round(offsetAt(instant, zone) / 60_000), sign = offset < 0 ? '-' : '+', abs = Math.abs(offset);
  return `${wall.year}-${pad(wall.month)}-${pad(wall.day)}T${pad(wall.hour)}:${pad(wall.minute)}:${pad(wall.second)}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const LOCAL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

function startWall(value: string, zone: string, allDay: boolean): Parsed<Wall> {
  const date = DATE.exec(value.slice(0, 10));
  if (allDay) return date ? { ok: true, value: { year: +date[1]!, month: +date[2]!, day: +date[3]!, hour: 0, minute: 0, second: 0 } } : { ok: false, error: { code: 'invalid_time', message: `All-day start ${value} needs a YYYY-MM-DD date` } };
  const local = LOCAL.exec(value);
  if (local) return { ok: true, value: { year: +local[1]!, month: +local[2]!, day: +local[3]!, hour: +local[4]!, minute: +local[5]!, second: +(local[6] ?? 0) } };
  const instant = Date.parse(value);
  return Number.isFinite(instant) && !DATE.test(value) ? { ok: true, value: wallAt(instant, zone) } : { ok: false, error: { code: 'invalid_time', message: `Timed start ${value} needs a date and time` } };
}

export function pointInstant(value: string, zone: string | undefined): number {
  const local = LOCAL.exec(value);
  if (local && zone) return instantOf({ year: +local[1]!, month: +local[2]!, day: +local[3]!, hour: +local[4]!, minute: +local[5]!, second: +(local[6] ?? 0) }, zone);
  return Date.parse(value);
}

export const occurrenceKey = (wall: Wall, allDay: boolean) =>
  `${wall.year}-${pad(wall.month)}-${pad(wall.day)}` + (allDay ? '' : `T${pad(wall.hour)}:${pad(wall.minute)}:${pad(wall.second)}`);

function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`); value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

/** Occurrences whose start instant is in [from, to), after `after` when given, at most `max`, skipping cancelled keys. */
export function expand(series: Series, window: { from: number; to: number | null; after?: number; max: number }): Parsed<Occurrence[]> {
  if (!validZone(series.zone)) return { ok: false, error: { code: 'invalid_zone', message: `Unknown time zone ${series.zone}` } };
  const rule = parseRule(series.rule);
  if (!rule.ok) return rule;
  const first = startWall(series.start, series.zone, series.allDay);
  if (!first.ok) return first;
  const firstAt = series.allDay ? Date.UTC(first.value.year, first.value.month - 1, first.value.day) : instantOf(first.value, series.zone);
  const endAt = series.allDay ? Date.parse(`${series.end.slice(0, 10)}T00:00:00Z`) : pointInstant(series.end, series.zone);
  if (!Number.isFinite(endAt) || endAt < firstAt) return { ok: false, error: { code: 'invalid_time', message: 'Series end must be at or after its start' } };
  const days = Math.max(1, Math.round((endAt - firstAt) / 86_400_000)), duration = endAt - firstAt;
  const until = series.until === null ? null : pointInstant(series.until, series.zone);
  if (until !== null && !Number.isFinite(until)) return { ok: false, error: { code: 'invalid_time', message: `Invalid recurrence end ${series.until}` } };
  const skipped = new Set(series.exceptions), out: Occurrence[] = [];
  const iterator = ICAL.Recur.fromString(rule.value).iterator(ICAL.Time.fromData({ ...first.value, isDate: series.allDay }));
  for (let scanned = 0; out.length < window.max; scanned++) {
    if (scanned === SCAN_LIMIT) return { ok: false, error: { code: 'invalid_rule', message: 'Recurrence produced too many occurrences before the requested window' } };
    const next = iterator.next();
    if (!next) break;
    const wall: Wall = { year: next.year, month: next.month, day: next.day, hour: next.hour, minute: next.minute, second: next.second };
    const key = occurrenceKey(wall, series.allDay);
    const at = instantOf(wall, series.zone);
    if (until !== null && at > until) break;
    if (window.to !== null && at >= window.to) break;
    if (at < window.from || (window.after !== undefined && at <= window.after) || skipped.has(key)) continue;
    out.push(series.allDay
      ? { key, at, start: key, end: addDays(key, days) }
      : { key, at, start: offsetIso(at, series.zone), end: offsetIso(at + duration, series.zone) });
  }
  return { ok: true, value: out };
}

/** The occurrence identified by `key`, if the series produces it (ignoring cancellations). */
export function occurrenceExists(series: Series, key: string): boolean {
  const wall = startWall(key, series.zone, series.allDay);
  if (!wall.ok || occurrenceKey(wall.value, series.allDay) !== key) return false;
  const at = instantOf(wall.value, series.zone);
  const found = expand({ ...series, exceptions: [] }, { from: at, to: at + 1, max: 1 });
  return found.ok && found.value.some(occurrence => occurrence.key === key);
}
