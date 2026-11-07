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
const FUNDED_MAX_AGE_MS = 5 * 60_000;
export function setCreditFunded(store: Store, accountId: string, funded: boolean, at: number, balance?: number): void {
  store.setControl(fundedKey(accountId), JSON.stringify({ funded, at, balance }));
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
