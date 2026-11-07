import type { Store } from "../store.js";
import { catalogMeter, modelDrainsMeter } from "../catalog.js";

const METER_MAX_AGE_MS = 90 * 60_000;
const WEEKLY_WINDOW_MIN_HOURS = 24;

type MeterRow = { meter_id: string; observed_at: number; used_percent: number; reset_at: number | null };

export type ClaudePool =
  | { state: "known"; leftPercent: number; accounts: number }
  | { state: "unknown" };

/** Weekly share left across the listed Claude accounts: the mean over accounts of each account's binding weekly meter. Stale readings are not counted; none fresh is unknown. */
export function claudeWeeklyPool(store: Store, accountIds: readonly string[], model: string, now = Date.now()): ClaudePool {
  const lefts: number[] = [];
  for (const id of accountIds) {
    const meters = (store.latestMeters(id) as MeterRow[]).filter(meter => modelDrainsMeter("anthropic", model, meter.meter_id)
      && (catalogMeter(meter.meter_id)?.windowHours ?? 0) >= WEEKLY_WINDOW_MIN_HOURS);
    if (!meters.length) continue;
    const lefts_ = meters.map(meter => {
      if (meter.reset_at !== null && Number(meter.reset_at) <= now) return 100;
      if (now - Number(meter.observed_at) > METER_MAX_AGE_MS) return undefined;
      return Math.max(0, 100 - Number(meter.used_percent));
    });
    if (lefts_.some(left => left === undefined)) continue;
    lefts.push(Math.min(...(lefts_ as number[])));
  }
  return lefts.length ? { state: "known", leftPercent: lefts.reduce((a, b) => a + b, 0) / lefts.length, accounts: lefts.length } : { state: "unknown" };
}

export type ClaudeCooldownRefusal = { status: 429 | 503; code: "claude_cooldown" | "claude_pool_unknown"; message: string };

/** Refuses a Claude request while the weekly pool is under the floor, or when its level can't be read. */
export function claudeCooldownRefusal(pool: ClaudePool, floorPercent: number): ClaudeCooldownRefusal | null {
  if (pool.state === "unknown") return { status: 503, code: "claude_pool_unknown", message: "The Claude weekly pool level is unknown (no fresh meter readings), so this principal's Claude call is refused. Use a GPT model or retry later." };
  if (pool.leftPercent < floorPercent) return { status: 429, code: "claude_cooldown", message: `Claude cool-down: the weekly pool has ${pool.leftPercent.toFixed(1)}% left, under the ${floorPercent}% floor for this principal. Use a GPT model; Claude returns after the weekly reset.` };
  return null;
}
