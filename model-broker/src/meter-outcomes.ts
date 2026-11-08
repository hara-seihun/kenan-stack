import type { Store } from "./store.js";

const HEALTHY = new Set(["recorded", "stale-reading", "reset-credits-unreadable", "reset-pending"]);

/** Publishes each enabled account's latest meter-poll failures (empty once a poll succeeds) for status readers. */
export function recordMeterOutcomes(store: Store, samples: readonly { accountId: string; outcome: string }[]): void {
  for (const account of store.accounts()) {
    if (!account.enabled) { store.setControl(`meter-error:${account.id}`, ""); continue; }
    const observed = samples.filter(sample => sample.accountId === account.id && sample.outcome !== "not-due");
    if (!observed.length) continue;
    const failures = observed.filter(sample => !HEALTHY.has(sample.outcome));
    store.setControl(`meter-error:${account.id}`, failures.length ? JSON.stringify(failures) : "");
  }
}
