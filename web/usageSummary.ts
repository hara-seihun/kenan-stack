import type { UsagePlan } from '../shared/contract.js';
import { formatDate } from './dates.js';

/** The two meters the Usage tab shows, in order. */
export const METERS = [{ metric: 'weekly', label: 'Weekly' }, { metric: 'five-hour', label: '5-hour' }] as const;
export type Meter = { metric: string; label: string };

/**
 * none: no plan reports this meter. unknown: a plan, but no account's share is known.
 * known: the pool's share left from fresh readings. stale: no account has a fresh reading; percentLeft is as of latestReadingAt.
 */
export type MeterReading =
  | { state: 'none' }
  | { state: 'unknown' }
  | { state: 'known'; percentLeft: number }
  | { state: 'stale'; percentLeft: number; latestReadingAt: number };

/** full: every known account is at 100%. unknown: some account has room but no future reset is known. at: the soonest reset that refills the pool, and the pool points it brings back. */
export type NextReset = { state: 'full' } | { state: 'unknown' } | { state: 'at'; at: number; gain: number };

export interface MeterRow { meter: Meter; provider: UsagePlan['provider'] | null; reading: MeterReading; reset: NextReset; runsOutAt: number | null }

/**
 * The pool share is capacity-weighted: a refill adds its account's points in proportion to its plan capacity. Accounts already full add nothing and are skipped; accounts resetting at the same moment add together.
 */
export function nextReset(plan: UsagePlan, now: number): NextReset {
  const known = plan.accounts.filter(a => a.percentLeft !== null);
  const capacity = known.reduce((sum, a) => sum + (a.capacityMultiplier ?? 1), 0);
  const refills = known.flatMap(a => a.resetAt !== null && a.resetAt > now && a.percentLeft! < 100 ? [{ at: a.resetAt, gain: (100 - a.percentLeft!) * (a.capacityMultiplier ?? 1) / capacity }] : []);
  if (!refills.length) return known.length > 0 && known.length === plan.accounts.length && known.every(a => a.percentLeft! >= 100) ? { state: 'full' } : { state: 'unknown' };
  const at = Math.min(...refills.map(r => r.at));
  return { state: 'at', at, gain: refills.filter(r => r.at === at).reduce((t, r) => t + r.gain, 0) };
}

export function meterRow(meter: Meter, plan: UsagePlan | null, now: number): MeterRow {
  if (!plan) return { meter, provider: null, reading: { state: 'none' }, reset: { state: 'unknown' }, runsOutAt: null };
  const reset = nextReset(plan, now);
  const reading: MeterReading = plan.percentLeft === null ? { state: 'unknown' }
    : plan.projection.state === 'stale' ? { state: 'stale', percentLeft: plan.percentLeft, latestReadingAt: plan.projection.latestReadingAt }
    : { state: 'known', percentLeft: plan.percentLeft };
  const out = plan.projection.state === 'projected' ? plan.projection.exhaustionAt : null;
  const runsOutAt = out !== null && (reset.state !== 'at' || out < reset.at) ? out : null;
  return { meter, provider: plan.provider, reading, reset, runsOutAt };
}

/** One row per meter and provider reporting it; a meter no provider reports still gets its row, saying so. */
export function meterRows(plans: UsagePlan[], now: number): MeterRow[] {
  const extra = [...new Set(plans.map(p => p.metric))].filter(metric => !METERS.some(m => m.metric === metric));
  return [...METERS, ...extra.map(metric => ({ metric, label: metric === 'subscription' ? 'Subscription' : metric.replace(/-/g, ' ') }))].flatMap(meter => {
    const matching = plans.filter(p => p.metric === meter.metric);
    return matching.length ? matching.map(plan => meterRow(meter, plan, now)) : [meterRow(meter, null, now)];
  });
}

/** "45m", "3h 40m", "2d 5h" between two times; null under a minute. */
export function span(from: number, to: number): string | null {
  const minutes = Math.round((to - from) / 60_000);
  if (minutes < 1) return null;
  const d = Math.floor(minutes / 1440), h = Math.floor(minutes % 1440 / 60), m = minutes % 60;
  return d ? `${d}d${h ? ` ${h}h` : ''}` : h ? `${h}h${m ? ` ${m}m` : ''}` : `${m}m`;
}
export const relative = (at: number, now: number) => { const s = span(now, at); return s === null ? 'now' : `in ${s}`; };
export const ago = (at: number, now: number) => { const s = span(at, now); return s === null ? 'just now' : `${s} ago`; };

/** A local clock time, with the weekday when it isn't today: "11:59 PM", "Thu 4:00 AM". */
export function clock(at: number, now: number): string {
  const time = formatDate(new Date(at), { hour: 'numeric', minute: '2-digit' });
  return new Date(at).toDateString() === new Date(now).toDateString() ? time : `${formatDate(new Date(at), { weekday: 'short' })} ${time}`;
}

/** Pool points as a whole percent, never rounding a real refill down to nothing. */
export const points = (value: number) => `${value > 0 && value < 1 ? '<1' : Math.round(value)}%`;
