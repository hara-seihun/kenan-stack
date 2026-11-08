// A person's time zone: an IANA name their app reports from the device (PUT /api/zone), so their day and clock follow
// their phone when they travel. HOME_ZONE is the household's zone, used for a person whose app has not reported one yet.
export const HOME_ZONE = 'America/Los_Angeles';

/** A zone stored for a person (null: their app has not reported one), and the zone their day is read in. */
export const zoneOrHome = (stored: string | null): string => stored ?? HOME_ZONE;

/** The kind of device that last reported the zone (web/device.ts decides it from several signals); unknown when they
 *  don't agree or don't say, so an agent is never told a wrong one. */
export const DEVICES = ['phone', 'tablet', 'computer', 'unknown'] as const;
export type Device = typeof DEVICES[number];
export const validDevice = (device: unknown): device is Device => DEVICES.some(d => d === device);

/** The zone a person's app last reported and the kind of device it came from. */
export interface ZoneReport { zone: string; device: Device }

export function validZone(zone: unknown): zone is string {
  if (typeof zone !== 'string' || !/^[A-Za-z][A-Za-z0-9_+\-/]{0,63}$/.test(zone)) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: zone }); return true; } catch { return false; }
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function partsIn(now: number, zone: string): Record<string, string> {
  let f = formatters.get(zone);
  if (!f) formatters.set(zone, f = new Intl.DateTimeFormat('en-GB', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'long', timeZoneName: 'longOffset' }));
  return Object.fromEntries(f.formatToParts(now).map(p => [p.type, p.value]));
}

/** The date (YYYY-MM-DD) it is at `now` in `zone`. */
export function todayIn(now: number, zone: string): string {
  const p = partsIn(now, zone);
  return `${p.year}-${p.month}-${p.day}`;
}

/** Minutes after midnight at `now` in `zone`. */
export function minuteIn(now: number, zone: string): number {
  const p = partsIn(now, zone);
  return Number(p.hour) * 60 + Number(p.minute);
}

/** "Thursday 2026-10-22 14:05, America/Los_Angeles (GMT-07:00)": the local clock an agent is told with each prompt. */
export function clockIn(now: number, zone: string): string {
  const p = partsIn(now, zone);
  return `${p.weekday} ${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}, ${zone} (${p.timeZoneName})`;
}
