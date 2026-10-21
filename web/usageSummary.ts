import type { UsagePlan } from '../shared/contract.js';

/** "Weekly" for weekly, "5-hour" for five-hour; other metric names as they come. */
export function metricName(metric: string): string {
  if (metric === 'five-hour') return '5-hour';
  return metric.charAt(0).toUpperCase() + metric.slice(1);
}

/** The soonest future reset among a plan's accounts, or null when none is known. */
export function nextRefill(plan: UsagePlan, now: number): number | null {
  const resets = plan.accounts.map(a => a.resetAt).filter((t): t is number => typeof t === 'number' && t > now);
  return resets.length ? Math.min(...resets) : null;
}

/** One plain line for the top of a plan: "17% left · next account refills Tue 11:59 PM". */
export function planSummary(plan: UsagePlan, now: number, format: (t: number) => string): string {
  const left = plan.percentLeft === null ? 'Unknown' : `${Math.round(plan.percentLeft)}% left`;
  const refill = nextRefill(plan, now);
  return refill === null ? left : `${left} · next account refills ${format(refill)}`;
}
