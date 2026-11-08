import { randomUUID } from "node:crypto";
import type { Store } from "./store.js";

export interface ResetAttempt {
  readonly creditId: string;
  readonly requestId: string;
  readonly at: number;
  readonly beforeResetAt?: number;
  /** Weekly used percent when the credit was claimed; a later reading below it is the provider's confirmation. Absent on attempts made before 2026-11-02, which only redeemed at 100%. */
  readonly beforeUsedPercent?: number;
  readonly status: "pending" | "accepted" | "confirmed" | "failed";
  readonly detail?: string;
}
const key = (accountId: string) => `codex-reset-attempt:${accountId}`;
export function codexResetAttempt(store: Store, accountId: string): ResetAttempt | undefined {
  const value = store.control(key(accountId));
  return value ? JSON.parse(value) as ResetAttempt : undefined;
}

/** Persist before POST: an interrupted or ambiguous redemption never spends a second credit. */
export function claimCodexReset(store: Store, accountId: string, creditId: string, resetAt?: number, usedPercent = 100): ResetAttempt | undefined {
  return store.transaction(() => {
    const previous = codexResetAttempt(store, accountId);
    if (previous && (previous.status !== "confirmed" || previous.creditId === creditId || resetAt === undefined || previous.beforeResetAt === resetAt)) return undefined;
    const attempt: ResetAttempt = { creditId, requestId: randomUUID(), at: Date.now(), beforeResetAt: resetAt, beforeUsedPercent: usedPercent, status: "pending" };
    store.setControl(key(accountId), JSON.stringify(attempt));
    return attempt;
  });
}
export function recordCodexResetResult(store: Store, accountId: string, attempt: ResetAttempt, accepted: boolean, detail: string): void {
  store.transaction(() => {
    const current = codexResetAttempt(store, accountId);
    if (current?.requestId !== attempt.requestId || current.status === "confirmed") return;
    store.setControl(key(accountId), JSON.stringify({ ...current, status: accepted ? "accepted" : "failed", detail }));
  });
}

/** A fresh provider drop below the claimed reading is the evidence that releases capacity, not a POST acknowledgement. */
export function confirmCodexReset(store: Store, accountId: string, usedPercent: number, observedAt: number): void {
  store.transaction(() => {
    const current = codexResetAttempt(store, accountId);
    if (!current || current.status === "confirmed" || observedAt <= current.at || usedPercent >= (current.beforeUsedPercent ?? 100)) return;
    store.setControl(key(accountId), JSON.stringify({ ...current, status: "confirmed" }));
    store.setCooldown(accountId);
  });
}

const fundedKey = (accountId: string) => `codex-credit-funded:${accountId}`;
const historyKey = (accountId: string) => `codex-credit-history:${accountId}`;
const FUNDED_MAX_AGE_MS = 5 * 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
interface CreditSample { at: number; balance: number }

/** Credit observations share the existing durable control store and survive graceful reloads. */
export function setCreditFunded(store: Store, accountId: string, funded: boolean, at: number, balance?: number, spendable = funded): void {
  store.transaction(() => {
    const previousRaw = store.control(fundedKey(accountId));
    const previous = previousRaw ? JSON.parse(previousRaw) : undefined;
    if (previous && previous.at > at) return;
    const readable = typeof balance === "number" && Number.isFinite(balance);
    store.setControl(fundedKey(accountId), JSON.stringify({
      funded, at, balance: readable ? balance : previous?.balance,
      balanceAt: readable ? at : previous?.balanceAt ?? previous?.at,
      spendable: readable && spendable,
    }));
    if (!readable) return;
    const raw = store.control(historyKey(accountId));
    const samples: CreditSample[] = raw ? JSON.parse(raw) : [];
    // The existing last reading is real history, even when written by an older release.
    if (samples.length === 0 && Number.isFinite(previous?.balance) && Number.isFinite(previous?.balanceAt ?? previous?.at)) {
      samples.push({ at: previous.balanceAt ?? previous.at, balance: previous.balance });
    }
    const last = samples.at(-1);
    if (last && last.at > at) return;
    if (last?.at === at) last.balance = balance;
    else samples.push({ at, balance });
    // Keep the boundary's predecessor so a rolling day can be interpolated exactly.
    const cutoff = at - DAY_MS;
    while (samples.length > 2 && samples[1]!.at <= cutoff) samples.shift();
    store.setControl(historyKey(accountId), JSON.stringify(samples));
  });
}

/** Each falling interval contributes its observed decrease; top-ups never cancel drain. */
function creditBurn(samples: readonly CreditSample[], since: number, now: number, periodMs: number): { rate: number | null; observedMs: number } {
  let decrease = 0;
  let observedMs = 0;
  for (let i = 1; i < samples.length; i++) {
    const before = samples[i - 1]!;
    const after = samples[i]!;
    const duration = after.at - before.at;
    const overlap = Math.min(after.at, now) - Math.max(before.at, since);
    if (duration <= 0 || overlap <= 0) continue;
    observedMs += overlap;
    decrease += Math.max(0, before.balance - after.balance) * overlap / duration;
  }
  return { rate: observedMs > 0 ? decrease * periodMs / observedMs : null, observedMs };
}

export interface CodexCredits {
  balance: number | null;
  /** Spendable now, independently of whether there is a last known balance. */
  available: boolean;
  funded: boolean;
  fresh: boolean;
  at: number | null;
  burnPerHour: number | null;
  burnPerDay: number | null;
  runsOutAt: number | null;
  historyHours: number | null;
  sampleCount: number;
  historyFrom: number | null;
  historyTo: number | null;
  hourObservedMs: number;
  dayObservedMs: number;
}
export function codexCredits(store: Store, accountId: string, now = Date.now()): CodexCredits {
  const raw = store.control(fundedKey(accountId));
  const value = raw ? JSON.parse(raw) : undefined;
  const balance = Number.isFinite(value?.balance) ? value.balance as number : null;
  const at = balance !== null ? value?.balanceAt ?? value?.at ?? null : null;
  const fresh = at !== null && now >= at && now - at <= FUNDED_MAX_AGE_MS;
  const history = store.control(historyKey(accountId));
  const samples: CreditSample[] = history ? JSON.parse(history) : [];
  const hour = creditBurn(samples, now - HOUR_MS, now, HOUR_MS);
  const day = creditBurn(samples, now - DAY_MS, now, DAY_MS);
  const available = fresh && (value?.spendable ?? value?.funded) === true;
  return {
    balance, available, funded: fresh && value?.funded === true, fresh, at,
    burnPerHour: hour.rate, burnPerDay: day.rate,
    runsOutAt: fresh && at !== null && balance !== null && hour.rate !== null && hour.rate > 0
      ? at + Math.max(0, balance) / hour.rate * HOUR_MS : null,
    historyHours: day.observedMs > 0 ? day.observedMs / HOUR_MS : null,
    sampleCount: samples.length, historyFrom: samples[0]?.at ?? null, historyTo: samples.at(-1)?.at ?? null,
    hourObservedMs: hour.observedMs, dayObservedMs: day.observedMs,
  };
}
/** A fresh reading says a subscription window is full but the account's prepaid provider credits still pay for requests. */
export function creditFunded(store: Store, accountId: string, now = Date.now()): boolean {
  const value = store.control(fundedKey(accountId));
  if (!value) return false;
  const parsed = JSON.parse(value) as { funded: boolean; at: number };
  return parsed.funded && now - parsed.at <= FUNDED_MAX_AGE_MS;
}

/**
 * When a banked reset should be spent on its own, or undefined to keep it.
 *
 * A reset returns the weekly window to zero and discards what was left of it, so it is spent when the window is
 * (nearly) used up. A credit that would expire before the account's own weekly reset is otherwise lost, so in its last
 * hours it is spent whatever the reading: any unused remainder is worth less than a whole fresh week.
 */
export const AUTO_RESET_MIN_USED_PERCENT = 98;
export const EXPIRING_CREDIT_MARGIN_MS = 2 * 3_600_000;
export function resetReason(weekly: { usedPercent: number; resetAt: number | undefined }, creditExpiresAt: number | undefined, now: number, minUsedPercent = AUTO_RESET_MIN_USED_PERCENT): string | undefined {
  if (weekly.usedPercent >= minUsedPercent) return `weekly ${weekly.usedPercent}% used (at or above ${minUsedPercent}%)`;
  if (creditExpiresAt !== undefined && creditExpiresAt - now <= EXPIRING_CREDIT_MARGIN_MS && (weekly.resetAt === undefined || creditExpiresAt < weekly.resetAt)) {
    return `credit expires ${new Date(creditExpiresAt).toISOString()}, before the weekly window resets`;
  }
  return undefined;
}
