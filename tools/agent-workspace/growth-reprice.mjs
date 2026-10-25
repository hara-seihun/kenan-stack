// Pure repricing of a workspace's remaining future-growth reservation from observed behavior.
// Rule: a workspace older than one hour keeps max(512 MiB, 2 x growth observed in the last hour),
// capped at its original requested growth. A fresh positive-growth burst (> 64 MiB between two
// consecutive samples) or an explicit growth restore inside the last hour gives the full original
// amount back. Anything missing, malformed or out of order fails closed to the full amount.
export const MIB = 1024 * 1024;
export const HOUR_MS = 60 * 60 * 1000;
export const FLOOR_BYTES = 512 * MIB;
export const TOLERANCE_BYTES = 64 * MIB;
export const MULTIPLIER = 2;
export const DEFAULT_MAX_SAMPLE_AGE_MS = 30 * 60 * 1000;

function toMs(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
  if (typeof v === 'string' && v !== '') return Date.parse(v);
  if (v instanceof Date) return v.getTime();
  return NaN;
}
const goodBytes = (b) => typeof b === 'number' && Number.isFinite(b) && b >= 0;

// Returns {effectiveRemainingBytes, fullReservation, reason, observedGrowthBytes, holdUntilMs,
// windowStartMs, basis, historyNeeded}. reason is one of: invalid-original (effectiveRemainingBytes null),
// invalid-input, fresh-workspace, explicit-restore, fresh-burst, repriced-stale-rate, history-incomplete,
// repriced-samples, repriced-bootstrap.
export function repriceGrowthReservation(input = {}) {
  const {originalGrowthBytes, samples = [], restoreAt, currentAllocationBytes, completedBaselineBytes} = input;
  const toleranceBytes = input.toleranceBytes ?? TOLERANCE_BYTES;
  const maxSampleAgeMs = input.maxSampleAgeMs ?? DEFAULT_MAX_SAMPLE_AGE_MS;
  if (!goodBytes(originalGrowthBytes)) {
    return {effectiveRemainingBytes: null, fullReservation: true, reason: 'invalid-original', observedGrowthBytes: null, holdUntilMs: null, windowStartMs: null, basis: null, historyNeeded: {sinceMs: null, reason: 'invalid-original'}};
  }
  const full = (reason, extra = {}) => ({effectiveRemainingBytes: originalGrowthBytes, fullReservation: true, reason, observedGrowthBytes: null, holdUntilMs: null, windowStartMs: null, basis: null, historyNeeded: null, ...extra});
  const now = toMs(input.now), createdAt = toMs(input.createdAt);
  if (!Number.isFinite(now) || !Number.isFinite(createdAt) || createdAt > now || !Array.isArray(samples)) return full('invalid-input');
  const windowStartMs = now - HOUR_MS;
  if (restoreAt !== undefined && restoreAt !== null) {
    const r = toMs(restoreAt);
    if (!Number.isFinite(r) || r < createdAt || r > now) return full('invalid-input');
    if (r > windowStartMs) return full('explicit-restore', {holdUntilMs: r + HOUR_MS, windowStartMs});
  }
  if (now - createdAt < HOUR_MS) return full('fresh-workspace', {holdUntilMs: createdAt + HOUR_MS, windowStartMs});
  if (currentAllocationBytes !== undefined && currentAllocationBytes !== null && !goodBytes(currentAllocationBytes)) return full('invalid-input');
  if (completedBaselineBytes !== undefined && completedBaselineBytes !== null && !goodBytes(completedBaselineBytes)) return full('invalid-input');

  const pts = [];
  for (const s of samples) {
    if (!s || typeof s !== 'object') return full('invalid-input');
    const at = toMs(s.at);
    if (!Number.isFinite(at) || !goodBytes(s.bytes) || at > now || at < createdAt) return full('invalid-input');
    const prev = pts[pts.length - 1];
    if (prev) {
      if (at < prev.at || (at === prev.at && s.bytes !== prev.bytes)) return full('invalid-input');
      if (at === prev.at) continue;
    }
    pts.push({at, bytes: s.bytes});
  }
  if (currentAllocationBytes !== undefined && currentAllocationBytes !== null) {
    const last = pts[pts.length - 1];
    if (!last || last.at < now) pts.push({at: now, bytes: currentAllocationBytes});
    else if (last.bytes !== currentAllocationBytes) return full('invalid-input');
  }
  if (!pts.length) return full('history-incomplete', {historyNeeded: {sinceMs: windowStartMs, reason: 'no-current-sample'}});
  const latestAt = pts[pts.length - 1].at;
  const stale = now - latestAt > maxSampleAgeMs;
  // Staleness is not new growth. Project the last observed hourly rate, without
  // granting stale allocation bytes as physical credit or inventing a current sample.
  const observationStartMs = (stale ? latestAt : now) - HOUR_MS;

  // Anchor: the last sample at or before the window start; otherwise the completed baseline is a
  // bootstrap upper bound, attributing every byte of growth since baseline to the last hour.
  let anchorIdx = -1;
  for (let i = 0; i < pts.length; i++) if (pts[i].at <= observationStartMs) anchorIdx = i;
  let series, basis, bootstrapFrom = null;
  if (anchorIdx >= 0) {
    series = pts.slice(anchorIdx); basis = 'samples';
  } else if (goodBytes(completedBaselineBytes)) {
    series = [{at: observationStartMs, bytes: completedBaselineBytes}, ...pts]; basis = 'bootstrap-baseline'; bootstrapFrom = 0;
  } else if (stale && pts.length >= 2) {
    series = pts; basis = 'samples';
  } else {
    return full('history-incomplete', {historyNeeded: {sinceMs: windowStartMs, reason: 'no-sample-at-or-before-window-start-and-no-baseline'}});
  }
  let observed = 0, lastBurstAt = null;
  for (let i = 1; i < series.length; i++) {
    const d = series[i].bytes - series[i - 1].bytes;
    if (d > 0) observed += d;
    // The synthetic baseline interval counts toward the bound but is not an observed burst.
    if (d > toleranceBytes && series[i].at > windowStartMs && !(bootstrapFrom === 0 && i === 1)) lastBurstAt = series[i].at;
  }
  const common = {observedGrowthBytes: observed, windowStartMs, basis, historyNeeded: null};
  if (lastBurstAt !== null) return {effectiveRemainingBytes: originalGrowthBytes, fullReservation: true, reason: 'fresh-burst', holdUntilMs: lastBurstAt + HOUR_MS, ...common};
  const span = Math.max(1, latestAt - series[0].at);
  const hourlyGrowth = stale ? Math.ceil(observed * HOUR_MS / span) : observed;
  const effective = Math.min(originalGrowthBytes, Math.max(FLOOR_BYTES, MULTIPLIER * hourlyGrowth));
  return {effectiveRemainingBytes: effective, fullReservation: effective === originalGrowthBytes, reason: stale ? 'repriced-stale-rate' : basis === 'samples' ? 'repriced-samples' : 'repriced-bootstrap', holdUntilMs: null, ...common};
}
