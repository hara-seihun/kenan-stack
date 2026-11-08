import { creditFunded } from "../codex-resets.js";
import type { Store } from "../store.js";
import { catalogMeter, modelDrainsMeter } from "../catalog.js";
import type { SharedOAuthAuth } from "./shared-oauth.js";
import { eligibleInteractiveAccounts, weeklyOutlook } from "./account-selection.js";

/**
 * Use-it-or-lose-it routing for background work (workers, swarm sub-agents, wakes, heartbeats).
 *
 * Rule, in order:
 *  1. Reserve guard: background work only goes to an account whose five-hour window is known to have at least
 *     `fiveHourReservePercent` left, so human-facing turns keep that headroom on every account.
 *  2. Waste: for each guarded account, the weekly allowance that would expire unused at the drain of the last day is
 *     `percentLeft - drainPerHour * hoursToReset` (the binding weekly meter, i.e. the smallest across the model's weekly meters).
 *  3. A conversation stays on its account while that account is guarded and still has projected waste (no prompt-cache churn).
 *  4. Otherwise the account whose weekly window resets soonest among those with at least MIN_WASTE_PERCENT projected waste
 *     takes it: the allowance that expires first is spent first.
 *  5. When no guarded account would waste anything, background work spreads by the existing pace rule, restricted to guarded accounts.
 *  6. When every account's five-hour window is known to be below the reserve, background work is held until the soonest five-hour reset.
 *  7. Unknown five-hour readings (stale or missing) keep the existing behaviour, minus accounts known to be below the reserve.
 */

export const MIN_WASTE_PERCENT = 5;
const METER_MAX_AGE_MS = 90 * 60_000;
const WEEKLY_WINDOW_MIN_HOURS = 24;
const HOUR_MS = 3_600_000;

export type FiveHourState =
  | { state: "fresh"; leftPercent: number; resetAt: number }
  | { state: "reset" }
  | { state: "unknown" };

export type WeeklyState =
  | { state: "fresh"; leftPercent: number; resetAt: number; drainPerHour: number }
  | { state: "unknown" };

export type BackgroundCandidate = { id: string; fiveHour: FiveHourState; weekly: WeeklyState; creditFunded?: boolean };

export type BackgroundDecision =
  | { kind: "account"; accountId: string; reason: "retained_waste" | "soonest_waste"; wastePercent: number; weeklyResetAt: number; fiveHourLeftPercent: number }
  | { kind: "pace"; among: string[]; reason: "no_projected_waste" }
  | { kind: "current"; exclude: string[]; reason: "meters_stale" | "none_eligible" }
  | { kind: "held"; retryAt: number; reason: "reserve" };

export function projectedWastePercent(weekly: Extract<WeeklyState, { state: "fresh" }>, now: number): number {
  const hours = Math.max(0, (weekly.resetAt - now) / HOUR_MS);
  return Math.max(0, weekly.leftPercent - weekly.drainPerHour * hours);
}

const fiveHourLeft = (state: FiveHourState): number | undefined =>
  state.state === "fresh" ? state.leftPercent : state.state === "reset" ? 100 : undefined;

export function chooseBackground(candidates: readonly BackgroundCandidate[], retainedId: string | undefined, reservePercent: number, now: number): BackgroundDecision {
  if (!candidates.length) return { kind: "current", exclude: [], reason: "none_eligible" };
  const known = candidates.filter(candidate => fiveHourLeft(candidate.fiveHour) !== undefined);
  const guarded = known.filter(candidate => fiveHourLeft(candidate.fiveHour)! >= reservePercent);
  const below = known.filter(candidate => fiveHourLeft(candidate.fiveHour)! < reservePercent);
  if (!guarded.length) {
    const funded = candidates.filter(c => c.creditFunded).map(c => c.id);
    if (funded.length) return { kind: "pace", among: funded, reason: "no_projected_waste" };
    if (known.length === candidates.length) {
      const resets = below.flatMap(candidate => candidate.fiveHour.state === "fresh" ? [candidate.fiveHour.resetAt] : []);
      return { kind: "held", retryAt: Math.min(...resets), reason: "reserve" };
    }
    return { kind: "current", exclude: below.map(candidate => candidate.id), reason: "meters_stale" };
  }
  const wasting = guarded.flatMap(candidate => candidate.weekly.state === "fresh"
    ? [{ candidate, weekly: candidate.weekly, waste: projectedWastePercent(candidate.weekly, now) }] : []);
  const pick = (entry: (typeof wasting)[number], reason: "retained_waste" | "soonest_waste"): BackgroundDecision => ({
    kind: "account", accountId: entry.candidate.id, reason, wastePercent: entry.waste,
    weeklyResetAt: entry.weekly.resetAt, fiveHourLeftPercent: fiveHourLeft(entry.candidate.fiveHour)!,
  });
  const retained = wasting.find(entry => entry.candidate.id === retainedId && entry.waste > 0);
  if (retained) return pick(retained, "retained_waste");
  const ranked = wasting.filter(entry => entry.waste >= MIN_WASTE_PERCENT)
    .sort((a, b) => a.weekly.resetAt - b.weekly.resetAt || b.waste - a.waste || a.candidate.id.localeCompare(b.candidate.id));
  if (ranked.length) return pick(ranked[0]!, "soonest_waste");
  return { kind: "pace", among: guarded.map(candidate => candidate.id).sort(), reason: "no_projected_waste" };
}

type MeterRow = { meter_id: string; observed_at: number; used_percent: number; reset_at: number | null };

const fresh = (meter: MeterRow, now: number) => Number(meter.observed_at) <= now + 60_000 && now - Number(meter.observed_at) <= METER_MAX_AGE_MS;

/** Reads one account's five-hour and binding weekly state from the ledger. */
export function backgroundCandidate(store: Store, id: string, family: string, model: string | undefined, now: number): BackgroundCandidate {
  const meters = (store.latestMeters(id) as MeterRow[]).filter(meter => !model || modelDrainsMeter(family, model, meter.meter_id));
  const windowHours = (meter: MeterRow) => catalogMeter(meter.meter_id)?.windowHours;
  const short = meters.filter(meter => { const hours = windowHours(meter); return hours !== undefined && hours > 0 && hours < WEEKLY_WINDOW_MIN_HOURS; });
  const states: FiveHourState[] = short.map(meter => {
    const reset = meter.reset_at === null ? undefined : Number(meter.reset_at);
    if (reset !== undefined && reset <= now) return { state: "reset" };
    if (reset === undefined || !fresh(meter, now)) return { state: "unknown" };
    return { state: "fresh", leftPercent: Math.max(0, 100 - Number(meter.used_percent)), resetAt: reset };
  });
  const fiveHour: FiveHourState = !states.length || states.some(state => state.state === "unknown") ? { state: "unknown" }
    : states.reduce((a, b) => (fiveHourLeft(b) ?? 0) < (fiveHourLeft(a) ?? 0) ? b : a);
  const weeklyMeters = meters.filter(meter => { const hours = windowHours(meter); return hours !== undefined && hours >= WEEKLY_WINDOW_MIN_HOURS; });
  const outlooks = weeklyMeters.map(meter => fresh(meter, now) && meter.reset_at !== null && Number(meter.reset_at) > now
    ? weeklyOutlook(store, id, meter, Number(meter.reset_at), windowHours(meter)!, now) : undefined);
  const weekly: WeeklyState = !outlooks.length || outlooks.some(outlook => outlook === undefined) ? { state: "unknown" }
    : outlooks.map(outlook => ({ state: "fresh" as const, ...outlook! }))
      .reduce((a, b) => projectedWastePercent(b, now) < projectedWastePercent(a, now) ? b : a);
  return { id, fiveHour, weekly, creditFunded: family === "openai-codex" && creditFunded(store, id, now) };
}

type Account = ReturnType<Store["accounts"]>[number];
export type BackgroundRoute =
  | { kind: "account"; account: Account; decision: Extract<BackgroundDecision, { kind: "account" }>; candidates: BackgroundCandidate[] }
  | { kind: "held"; decision: Extract<BackgroundDecision, { kind: "held" }>; candidates: BackgroundCandidate[] }
  | { kind: "spread"; exclude: Set<string>; decision: Extract<BackgroundDecision, { kind: "pace" | "current" }>; candidates: BackgroundCandidate[] };

/** One compact line per candidate for the routing log: id, five-hour percent left, projected weekly waste, hours to the weekly reset. */
export function candidateSummary(candidates: readonly BackgroundCandidate[], now: number): Record<string, string> {
  return Object.fromEntries(candidates.map(candidate => [candidate.id, [
    candidate.fiveHour.state === "fresh" ? `5h ${Math.round(candidate.fiveHour.leftPercent)}` : `5h ${candidate.fiveHour.state}`,
    candidate.weekly.state === "fresh" ? `waste ${projectedWastePercent(candidate.weekly, now).toFixed(1)} left ${Math.round(candidate.weekly.leftPercent)} drain ${candidate.weekly.drainPerHour.toFixed(2)}/h reset ${Math.round((candidate.weekly.resetAt - now) / HOUR_MS)}h` : "weekly unknown",
  ].join(" ")]));
}

/** Applies chooseBackground to the broker's eligible accounts. Pace and current decisions return the exclusion set under which
 * the broker's ordinary path (conversation affinity, pace shedding, the pace chooser) picks, so background keeps its prompt cache there too. */
export function routeBackground(store: Store, auth: SharedOAuthAuth | undefined, family: string, exclude: Set<string>, model: string, retainedId: string | undefined, reservePercent: number, now = Date.now()): BackgroundRoute {
  const eligible = eligibleInteractiveAccounts(store, auth, family, exclude, model);
  const candidates = eligible.map(account => backgroundCandidate(store, account.id, family, model, now));
  const decision = chooseBackground(candidates, retainedId, reservePercent, now);
  if (decision.kind === "held") return { kind: "held", decision, candidates };
  if (decision.kind === "account") return { kind: "account", account: eligible.find(candidate => candidate.id === decision.accountId)!, decision, candidates };
  const excluded = decision.kind === "pace" ? eligible.filter(candidate => !decision.among.includes(candidate.id)).map(candidate => candidate.id) : decision.exclude;
  return { kind: "spread", exclude: new Set([...exclude, ...excluded]), decision, candidates };
}
