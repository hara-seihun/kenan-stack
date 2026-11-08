import type { Store } from "./store.js";

/** A 402 is observed exhaustion; a successful call alone cannot tell us a balance percentage. */
interface Balance {
  prepaidUsd?: number;
  onDemandRemainingUsd?: number;
  observedAt: number;
  exhausted: boolean;
  percentLeft: number | null;
  resetAt: number | null;
  nextProbeAt: number;
}
export interface XaiAvailability {
  prepaidUsd?: number;
  onDemandRemainingUsd?: number;
  available: boolean;
  exhausted: boolean;
  percentLeft: number | null;
  reason: string | null;
  resetAt: string | null;
  nextProbeAt: string | null;
  observedAt: string | null;
}
const KEY = "xai-balance:";
const PROBE_INTERVAL_MS = 5 * 60_000;
export const xaiBalanceExhausted = (text: string): boolean => /(?:Grok Build )?usage balance exhausted/i.test(text);
const iso = (at: number | null | undefined) => at == null ? null : new Date(at).toISOString();

export class XaiBalance {
  constructor(private readonly store: Store) {}

  reading(accountId: string): Balance | null {
    const value = this.store.control(KEY + accountId);
    return value ? JSON.parse(value) as Balance | null : null;
  }
  exhausted(accountId: string): boolean { return this.reading(accountId)?.exhausted === true; }

  recordExhausted(accountId: string, headers?: Headers, now = Date.now()): void {
    const previous = this.reading(accountId);
    // Retry-After says when to probe; it does not establish a balance reset.
    const retry = headers?.get("retry-after");
    const retryAt = retry ? (/^\d+(?:\.\d+)?$/.test(retry) ? now + Number(retry) * 1000 : Date.parse(retry)) : NaN;
    this.store.setControl(KEY + accountId, JSON.stringify({ observedAt: now, exhausted: true, percentLeft: 0,
      resetAt: previous?.resetAt ?? null,
      nextProbeAt: Number.isFinite(retryAt) && retryAt > now ? retryAt : now + PROBE_INTERVAL_MS } satisfies Balance));
  }

  recordBilling(accountId: string, percentLeft: number | null, resetAt: number | null, exhausted: boolean, startedAt: number, prepaidUsd?: number, onDemandRemainingUsd?: number): void {
    const state = this.reading(accountId);
    if (state && state.observedAt > startedAt) return;
    this.store.setControl(KEY + accountId, JSON.stringify({ observedAt: startedAt, exhausted, prepaidUsd, onDemandRemainingUsd,
      percentLeft, resetAt, nextProbeAt: Math.min(Date.now() + PROBE_INTERVAL_MS, resetAt !== null && resetAt > Date.now() ? resetAt : Infinity) } satisfies Balance));
  }

  recordSuccess(accountId: string, startedAt: number): void {
    const state = this.reading(accountId);
    // An older concurrent success cannot clear a newer refusal.
    if (state?.exhausted && startedAt >= state.observedAt) this.store.setControl(KEY + accountId, JSON.stringify({
      ...state, observedAt: startedAt, exhausted: false, percentLeft: null, nextProbeAt: Date.now() + PROBE_INTERVAL_MS } satisfies Balance));
  }

  status(accountIds: readonly string[]): XaiAvailability {
    if (!accountIds.length) return { available: false, exhausted: false, percentLeft: null,
      reason: "No eligible Grok subscription account is available.", resetAt: null, nextProbeAt: null, observedAt: null };
    const states = accountIds.map(id => this.reading(id));
    const exhausted = states.every(state => state?.exhausted);
    const readings = states.filter((state): state is Balance => state !== null);
    const resets = readings.flatMap(state => state.resetAt === null ? [] : [state.resetAt]);
    const resetAt = resets.length ? Math.min(...resets) : null;
    const percentLeft = exhausted ? 0 : states.every(state => state?.percentLeft != null)
      ? states.reduce((sum, state) => sum + state!.percentLeft!, 0) / states.length : null;
    return { available: !exhausted, exhausted, percentLeft,
      ...(readings.length && readings.every(s=>s.prepaidUsd!==undefined) ? { prepaidUsd: readings.reduce((sum,s)=>sum+s.prepaidUsd!,0), onDemandRemainingUsd: readings.reduce((sum,s)=>sum+(s.onDemandRemainingUsd??0),0) } : {}),
      reason: exhausted ? `Grok Build usage balance exhausted${resetAt === null ? "; xAI did not provide a reset time" : ""}` : null,
      resetAt: iso(resetAt), nextProbeAt: readings.length ? iso(Math.min(...readings.map(state => state.nextProbeAt))) : null,
      observedAt: readings.length ? iso(Math.max(...readings.map(state => state.observedAt)) || null) : null };
  }

  /** Reserve the next probe in the shared ledger so draining generations do not duplicate it. */
  claimProbe(accountId: string, now = Date.now()): boolean {
    return this.store.transaction(() => {
      const state = this.reading(accountId);
      if (state && state.nextProbeAt > now) return false;
      this.store.setControl(KEY + accountId, JSON.stringify({ ...(state ?? { observedAt: 0, exhausted: false, percentLeft: null, resetAt: null }), nextProbeAt: now + PROBE_INTERVAL_MS } satisfies Balance));
      return true;
    });
  }
}
