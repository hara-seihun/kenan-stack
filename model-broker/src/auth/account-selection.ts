import { creditFunded } from "../codex-resets.js";
import type { Store } from "../store.js";
import { allowsAccountUse } from "../domain.js";
import { catalogMeter, modelDrainsMeter } from "../catalog.js";
import type { SharedOAuthAuth } from "./shared-oauth.js";
import { accountModelExcluded } from "./model-entitlement.js";

const METER_MAX_AGE_MS = 90 * 60_000;

function bindingMeters(store: Store, id: string, family: string, model?: string, now = Date.now()) {
  return store.latestMeters(id).filter(meter => (!model || modelDrainsMeter(family, model, meter.meter_id))
    && meter.observed_at <= now + 60_000 && now - meter.observed_at <= METER_MAX_AGE_MS
    && (!meter.reset_at || meter.reset_at > now));
}

/** A fresh exhausted binding window is evidence, unlike an inferred account-wide cooldown. */
export function interactiveQuotaExhausted(store: Store, id: string, family: string, model?: string, now = Date.now()): boolean {
  return bindingMeters(store, id, family, model, now).some(meter => meter.used_percent >= 100) && !creditFunded(store, id, now);
}

function usableInteractiveAccounts(store: Store, auth: SharedOAuthAuth | undefined, family: string, exclude: Set<string>, model?: string) {
  return store.accounts().filter(account => account.provider === family
    && allowsAccountUse(account, "interactive") && !exclude.has(account.id) && auth?.has(account.id)
    && !accountModelExcluded(store, account.id, model)
    && !interactiveQuotaExhausted(store, account.id, family, model));
}

export function eligibleInteractiveAccounts(store: Store, auth: SharedOAuthAuth | undefined, family: string, exclude = new Set<string>(), model?: string) {
  return usableInteractiveAccounts(store, auth, family, exclude, model)
    .filter(account => !account.cooldownUntil || account.cooldownUntil <= Date.now());
}

export function coolingInteractiveAccounts(store: Store, auth: SharedOAuthAuth | undefined, family: string, exclude = new Set<string>(), model?: string) {
  return usableInteractiveAccounts(store, auth, family, exclude, model)
    .filter(account => account.cooldownUntil && account.cooldownUntil > Date.now())
    .sort((a, b) => a.cooldownUntil! - b.cooldownUntil! || a.id.localeCompare(b.id));
}

const HOUR_MS = 3_600_000;
/** Readings are whole percents, so drain is read over six hours: one point is then 0.17%/h, against targets of 0.4–0.8%/h. */
const DRAIN_WINDOW_MS = 6 * HOUR_MS;
/** Projecting leftover allowance days ahead reads drain over a whole day (the ledger keeps 24 h): a six-hour window
 * swings with the time of day, and one whole-percent step in it moves a 100-hour projection by 17 points. */
const OUTLOOK_DRAIN_WINDOW_MS = 23 * HOUR_MS;
/** Header and usage-poll readings state the same reset a few hundred milliseconds apart. */
export const SAME_RESET_TOLERANCE_MS = 60_000;
/** The usage poll reads every account about every eleven minutes; a quarter hour of readings always includes one. */
export const HIGH_WATER_SPAN_MS = 15 * 60_000;
const MIN_HOURS_TO_RESET = 0.25;
const WEEKLY_WINDOW_MIN_HOURS = 24;
const BURST_FULL_PERCENT = 95;
const BURST_FREE_PERCENT = 50;
const REBALANCE_RATIO = 1.25;
const TARGET_SHARE = 0.25;

/**
 * How an account's weekly quota is being spent against the rate that would use it up exactly at its reset.
 * target: percent left divided by hours to reset. drain: the measured percent per hour over the last six hours of the current window.
 * slack: target minus drain (positive means the account is behind and should take more work).
 * burstRoom: 1 while the five-hour window is at most half used, falling to 0 as it reaches 95%.
 */
export type AccountPace = {
  accountId: string;
  targetPerHour: number;
  drainPerHour: number;
  slackPerHour: number;
  burstRoom: number;
};

type MeterRow = { meter_id: string; observed_at: number; used_percent: number; reset_at: number | null };

/**
 * Usage is the highest reading of the last quarter hour in the current window, and the baseline the highest in the
 * quarter hour before the drain window, so both sides compare the same source: response headers and the usage poll
 * round the same usage a point apart, and comparing one source's latest against the other's baseline read that point as
 * drain or as none. Until six hours of readings exist in the window (just after a reset, or when readings began recently),
 * the missing part counts as spent exactly at the target pace, so an account with little evidence reads as on pace.
 */
function weeklyPace(store: Store, id: string, meter: MeterRow, windowHours: number, now: number): { target: number; drain: number } {
  const reset = meter.reset_at === null ? undefined : Number(meter.reset_at);
  const windowMs = windowHours * HOUR_MS;
  if (reset !== undefined && reset <= now) {
    const next = reset + Math.ceil((now - reset + 1) / windowMs) * windowMs;
    const target = 100 / Math.max((next - now) / HOUR_MS, MIN_HOURS_TO_RESET);
    return { target, drain: target };
  }
  return windowPace(store, id, meter, reset, windowHours, now, DRAIN_WINDOW_MS);
}

/** A weekly meter whose reset is ahead (or unstated): percent left, the pace that spends it at the reset, and the measured drain. */
function windowPace(store: Store, id: string, meter: MeterRow, reset: number | undefined, windowHours: number, now: number, drainWindowMs: number): { target: number; drain: number; left: number } {
  const windowMs = windowHours * HOUR_MS;
  const resetKey = reset ?? null;
  const windowStart = reset === undefined ? now - drainWindowMs : Math.max(now - drainWindowMs, reset - windowMs);
  const latestAt = Number(meter.observed_at);
  const current = store.meterHighWater(id, meter.meter_id, resetKey, Math.max(windowStart, latestAt - HIGH_WATER_SPAN_MS), latestAt, SAME_RESET_TOLERANCE_MS);
  const used = Math.max(Number(meter.used_percent), current?.used_percent ?? 0);
  const hoursToReset = reset === undefined ? windowHours : Math.max((reset - now) / HOUR_MS, MIN_HOURS_TO_RESET);
  const left = Math.max(0, 100 - used);
  const target = left / hoursToReset;
  const cutoff = now - drainWindowMs;
  const sameWindow = (row: MeterRow | undefined) => row && (resetKey === null ? row.reset_at === null
    : row.reset_at !== null && Math.abs(Number(row.reset_at) - resetKey) <= SAME_RESET_TOLERANCE_MS) ? row : undefined;
  const highWaterFrom = (row: MeterRow | undefined, from: number, to: number) => row
    ? store.meterHighWater(id, meter.meter_id, resetKey, from, to, SAME_RESET_TOLERANCE_MS) : undefined;
  const older = sameWindow(store.meterReadingAtOrBefore(id, meter.meter_id, cutoff));
  const before = older && highWaterFrom(older, Number(older.observed_at) - HIGH_WATER_SPAN_MS, Number(older.observed_at));
  const firstInWindow = before ? undefined : sameWindow(store.meterReadingAfter(id, meter.meter_id, windowStart - 1));
  const first = firstInWindow && highWaterFrom(firstInWindow, Number(firstInWindow.observed_at), Number(firstInWindow.observed_at) + HIGH_WATER_SPAN_MS);
  const baseline = before ?? first;
  if (!baseline) return { target, drain: target, left };
  const spanMs = Math.max(0, now - baseline.observed_at);
  const spent = Math.max(0, used - baseline.used_percent);
  const drain = spanMs >= drainWindowMs
    ? spent / (spanMs / HOUR_MS)
    : (spent + target * (drainWindowMs - spanMs) / HOUR_MS) / (drainWindowMs / HOUR_MS);
  return { target, drain, left };
}

/** Background routing reads a weekly meter whose reset is ahead as percent left, its reset, and the drain measured over the last day. */
export function weeklyOutlook(store: Store, id: string, meter: MeterRow, resetAt: number, windowHours: number, now: number): { leftPercent: number; resetAt: number; drainPerHour: number } {
  const pace = windowPace(store, id, meter, resetAt, windowHours, now, OUTLOOK_DRAIN_WINDOW_MS);
  return { leftPercent: pace.left, resetAt, drainPerHour: pace.drain };
}

export function accountPace(store: Store, id: string, family: string, model?: string, now = Date.now()): AccountPace {
  const meters = (store.latestMeters(id) as MeterRow[]).filter(meter => !model || modelDrainsMeter(family, model, meter.meter_id));
  const weekly = meters.flatMap(meter => {
    const hours = catalogMeter(meter.meter_id)?.windowHours;
    return hours !== undefined && hours >= WEEKLY_WINDOW_MIN_HOURS ? [weeklyPace(store, id, meter, hours, now)] : [];
  });
  const binding = weekly.length ? weekly.reduce((a, b) => b.target - b.drain < a.target - a.drain ? b : a) : { target: 100 / 168, drain: 0 };
  const shortUsed = Math.max(0, ...meters.filter(meter => {
    const hours = catalogMeter(meter.meter_id)?.windowHours;
    return hours !== undefined && hours > 0 && hours < WEEKLY_WINDOW_MIN_HOURS && (meter.reset_at === null || Number(meter.reset_at) > now);
  }).map(meter => Number(meter.used_percent)));
  const burstRoom = Math.min(1, Math.max(0, (BURST_FULL_PERCENT - shortUsed) / (BURST_FULL_PERCENT - BURST_FREE_PERCENT)));
  return { accountId: id, targetPerHour: binding.target, drainPerHour: binding.drain, slackPerHour: binding.target - binding.drain, burstRoom };
}

/**
 * New work goes to accounts in proportion to how far each is behind the pace that spends it exactly at its own reset,
 * plus a quarter of that pace so no account is starved or flooded at once, so every account runs out at about its reset.
 */
function chooseByPace<T extends { id: string }>(store: Store, candidates: T[], family: string, model: string | undefined, random: () => number, now: number): T | undefined {
  if (!candidates.length) return undefined;
  const paced = [...candidates].sort((a, b) => a.id.localeCompare(b.id)).map(account => ({ account, pace: accountPace(store, account.id, family, model, now) }));
  const weights = paced.map(({ pace }) => (Math.max(0, pace.slackPerHour) + TARGET_SHARE * pace.targetPerHour) * pace.burstRoom);
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  if (!(total > 0)) return paced.reduce((a, b) => b.pace.burstRoom > a.pace.burstRoom || (b.pace.burstRoom === a.pace.burstRoom && b.pace.targetPerHour > a.pace.targetPerHour) ? b : a).account;
  let point = random() * total;
  for (let i = 0; i < paced.length; i++) {
    point -= weights[i]!;
    if (point < 0) return paced[i]!.account;
  }
  return paced[paced.length - 1]!.account;
}

/**
 * Whether a conversation should leave the account it has been using. Moving costs one prompt-cache rebuild, so only an
 * account spending at least 25% faster than its pace sheds conversations, each with probability equal to its excess share,
 * and only toward an account that is behind; an account whose five-hour window is nearly full sheds them outright.
 */
export function shouldLeaveRetained(store: Store, auth: SharedOAuthAuth | undefined, family: string, retainedId: string, exclude: Set<string>, model: string | undefined, random: () => number, now = Date.now()): boolean {
  const alternatives = eligibleInteractiveAccounts(store, auth, family, new Set([...exclude, retainedId]), model)
    .map(account => accountPace(store, account.id, family, model, now));
  const retained = accountPace(store, retainedId, family, model, now);
  if (retained.burstRoom === 0) return alternatives.some(pace => pace.burstRoom > 0);
  if (!alternatives.some(pace => pace.slackPerHour > 0 && pace.burstRoom > 0)) return false;
  if (!(retained.targetPerHour > 0)) return true;
  const ratio = retained.drainPerHour / retained.targetPerHour;
  return ratio > REBALANCE_RATIO && random() < 1 - 1 / ratio;
}

/** Admission can probe inferred cooldowns, but never fresh exhausted model quota.
 * Failover callers exclude the entire refused round, not just its latest account. */
export function chooseInteractiveAccount(store: Store, auth: SharedOAuthAuth | undefined, family: string, exclude = new Set<string>(), { includeCooling = false, model, live = false, random = Math.random }: { includeCooling?: boolean; model?: string; live?: boolean; random?: () => number } = {}) {
  const spent = (id: string) => Math.max(0, ...bindingMeters(store, id, family, model).map(meter => Number(meter.used_percent)));
  const load = (id: string) => store.activeLeases(id).length;
  const candidates = eligibleInteractiveAccounts(store, auth, family, exclude, model);
  const eligible = live
    ? candidates.sort((a, b) => load(a.id) - load(b.id) || spent(a.id) - spent(b.id) || a.id.localeCompare(b.id))[0]
    : chooseByPace(store, candidates, family, model, random, Date.now());
  if (eligible || !includeCooling) return eligible;
  return coolingInteractiveAccounts(store, auth, family, exclude, model)[0];
}

/** Reconciliation reads evidence, never submits a model request to test capacity. */
export function interactiveRetryAvailability(store: Store, auth: SharedOAuthAuth | undefined, family: string, model: string, now = Date.now()): { available: boolean; retryAt: number } {
  const accounts = store.accounts().filter(account => account.provider === family && allowsAccountUse(account, "interactive") && auth?.has(account.id)
    && !accountModelExcluded(store, account.id, model, now));
  const times = accounts.map(account => Math.max(now, account.cooldownUntil ?? now,
    ...bindingMeters(store, account.id, family, model, now).filter(meter => meter.used_percent >= 100)
      .map(meter => meter.reset_at ?? now + METER_MAX_AGE_MS)));
  return { available: times.some(time => time <= now), retryAt: times.length ? Math.min(...times) : now + 60_000 };
}
