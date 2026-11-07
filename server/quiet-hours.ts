// One notification policy for chat, tools, calendar, host services and Web Push.
import type { Deps } from './types.js';
import type { QuietHours } from '../shared/contract.js';
import { instantOf, wallAt } from './extensions/recurrence.js';
import { minuteIn, zoneOrHome } from '../shared/zone.js';

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
export const validQuietHours = (value: unknown): value is QuietHours => {
  const q = value as QuietHours | null;
  return !!q && typeof q.enabled === 'boolean' && typeof q.start === 'string' && HHMM.test(q.start)
    && typeof q.end === 'string' && HHMM.test(q.end) && q.start !== q.end;
};
export async function quietHoursStatus(deps: Deps, personId: string) {
  const [hours, storedZone] = await Promise.all([deps.store.quietHours(personId), deps.store.notificationZoneOf(personId)]);
  const timeZone = zoneOrHome(storedZone), minute = minuteIn(deps.now(), timeZone);
  const at = (value: string) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
  const start = at(hours.start), end = at(hours.end);
  const active = hours.enabled && (start < end ? minute >= start && minute < end : minute >= start || minute < end);
  return { ...hours, timeZone, active };
}

/** Expire queued ordinary Web Push at the next quiet-hours boundary, including DST changes. */
export function nextQuietStart(now: number, hours: QuietHours & { timeZone: string }): number {
  const wall = wallAt(now, hours.timeZone);
  const start = { ...wall, hour: Number(hours.start.slice(0, 2)), minute: Number(hours.start.slice(3)), second: 0 };
  let at = instantOf(start, hours.timeZone);
  if (at <= now) {
    const next = new Date(Date.UTC(wall.year, wall.month - 1, wall.day + 1));
    at = instantOf({ ...start, year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() }, hours.timeZone);
  }
  return at;
}
