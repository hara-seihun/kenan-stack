// Admission forecast, not a filesystem quota. Never turn a partial walk into credit.
export const STALE_FLOOR_BYTES = 512 * 1024 ** 2;
const HOUR_MS = 3_600_000;
const valid = value => Number.isSafeInteger(value) && value >= 0;
export function staleAllocationForecast(sample, plan, state, now, history) {
  if (state === 'creating' || !['source-only', 'budgeted'].includes(plan.intent) || plan.growthLifecycle ||
      !valid(plan.growthBytes) || !valid(plan.completedAllocationBytes) || !valid(now) ||
      sample?.ok !== true || sample.partial || !valid(sample.bytes) || !valid(sample.allocatedBytes) ||
      sample.bytes > sample.allocatedBytes || !valid(sample.startedAt) || !valid(sample.completedAt) ||
      sample.completedAt < sample.startedAt || sample.completedAt > now || !Array.isArray(history) || !history.length || history.length > 512) return null;
  let positive = 0, previous = null;
  for (const point of history) {
    if (!point || !valid(point.at) || !valid(point.bytes) || point.at > sample.completedAt ||
        previous && (point.at <= previous.at)) return null;
    if (previous) positive += Math.max(0, point.bytes - previous.bytes);
    if (!Number.isSafeInteger(positive)) return null;
    previous = point;
  }
  // Historical non-atomic writers could publish a complete bound cache before
  // its rate journal. Reconcile that actual observation in memory, never invent
  // a current sample or repair malformed/conflicting authority into credit.
  if (previous.at < sample.completedAt) {
    if (history.length === 512) return null;
    history = [...history, {at:sample.completedAt, bytes:sample.bytes}];
    positive += Math.max(0, sample.bytes - previous.bytes);
    if (!Number.isSafeInteger(positive)) return null;
    previous = history.at(-1);
  }
  if (previous.at !== sample.completedAt || previous.bytes !== sample.bytes) return null;
  // One sample uses the source baseline as a conservative one-hour bootstrap;
  // otherwise sum positive deltas, so deletions cannot cancel observed regrowth.
  const hourlyGrowthBytes = history.length === 1
    ? Math.max(0, sample.bytes - plan.completedAllocationBytes)
    : Math.ceil(positive * HOUR_MS / Math.max(1, sample.completedAt - history[0].at));
  if (!Number.isSafeInteger(hourlyGrowthBytes)) return null;
  const ageMs = now - sample.startedAt;
  const uncertaintyBytes = Math.min(plan.growthBytes,
    STALE_FLOOR_BYTES + Math.ceil(2 * hourlyGrowthBytes * ageMs / HOUR_MS));
  const marginBytes = Math.max(64 * 1024 ** 2, Math.ceil(sample.bytes / 100));
  const observedConsumedBytes = Math.min(plan.growthBytes,
    Math.max(0, sample.bytes - marginBytes - plan.completedAllocationBytes));
  const creditBytes = Math.max(0, observedConsumedBytes - uncertaintyBytes);
  if (!Number.isSafeInteger(plan.completedAllocationBytes + creditBytes)) return null;
  return {bytes: plan.completedAllocationBytes + creditBytes, creditBytes, observedConsumedBytes,
    uncertaintyBytes, marginBytes, ageMs, hourlyGrowthBytes,
    forecastAllocationBytes: Math.min(Number.MAX_SAFE_INTEGER, sample.bytes + uncertaintyBytes)};
}
