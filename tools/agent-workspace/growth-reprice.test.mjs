import {test} from 'node:test';
import assert from 'node:assert/strict';
import {repriceGrowthReservation as rp, MIB, HOUR_MS} from './growth-reprice.mjs';
const GiB = 1024 * MIB, T0 = Date.UTC(2026, 9, 25, 0, 0, 0), now = T0 + 3 * HOUR_MS;
const s = (minAgo, bytes) => ({at: now - minAgo * 60000, bytes});
const base = {now, createdAt: T0, originalGrowthBytes: 6 * GiB};

test('old idle 6GiB reservation reprices to 512MiB from real samples', () => {
  const r = rp({...base, samples: [s(90, 5 * GiB), s(60, 5 * GiB), s(30, 5 * GiB + 10 * MIB), s(5, 5 * GiB + 12 * MIB)]});
  assert.equal(r.effectiveRemainingBytes, 512 * MIB); assert.equal(r.reason, 'repriced-samples'); assert.equal(r.fullReservation, false);
});
test('old workspace growing 2GiB/hour in sub-tolerance steps keeps 4GiB under a 6GiB original', () => {
  const samples = []; for (let m = 60; m >= 0; m -= 1) samples.push(s(m, 10 * GiB + (60 - m) * (2 * GiB / 60)));
  const r = rp({...base, samples});
  assert.equal(r.reason, 'repriced-samples'); assert.ok(Math.abs(r.observedGrowthBytes - 2 * GiB) < 1);
  assert.ok(Math.abs(r.effectiveRemainingBytes - 4 * GiB) < 2);
  assert.equal(rp({...base, originalGrowthBytes: 3 * GiB, samples}).effectiveRemainingBytes, 3 * GiB);
});
test('growth in steps larger than tolerance is a fresh burst and gives the full amount', () => {
  const samples = []; for (let m = 70; m >= 0; m -= 10) samples.push(s(m, 10 * GiB + (70 - m) * (2 * GiB / 60)));
  assert.equal(rp({...base, samples}).reason, 'fresh-burst');
});
test('cap by original: heavy sub-tolerance growth never exceeds original', () => {
  const samples = []; for (let m = 70; m >= 0; m -= 1) samples.push(s(m, (70 - m) * 60 * MIB));
  const r = rp({...base, originalGrowthBytes: 2 * GiB, samples});
  assert.equal(r.effectiveRemainingBytes, 2 * GiB); assert.equal(r.fullReservation, true);
});
test('fresh burst restores full amount and holds for one hour, then repricing resumes', () => {
  const samples = [s(120, 5 * GiB), s(40, 5 * GiB), s(35, 5 * GiB + 200 * MIB), s(5, 5 * GiB + 200 * MIB)];
  const r = rp({...base, samples});
  assert.equal(r.reason, 'fresh-burst'); assert.equal(r.effectiveRemainingBytes, 6 * GiB); assert.equal(r.holdUntilMs, now - 35 * 60000 + HOUR_MS);
  const later = now + 26 * 60000; // burst now 61 minutes old
  const l = rp({...base, now: later, samples: [...samples, {at: later - 1000, bytes: 5 * GiB + 200 * MIB}]});
  assert.equal(l.reason, 'repriced-samples'); assert.equal(l.effectiveRemainingBytes, 512 * MIB);
  const again = rp({...base, now: later, samples: [...samples, {at: later - 1000, bytes: 5 * GiB + 400 * MIB}]});
  assert.equal(again.reason, 'fresh-burst');
});
test('tiny sample variance never causes a permanent full-budget loop', () => {
  const samples = []; for (let m = 120; m >= 0; m -= 5) samples.push(s(m, 5 * GiB + (m % 10 ? 30 : 0) * MIB));
  const r = rp({...base, samples});
  assert.equal(r.reason, 'repriced-samples'); assert.equal(r.effectiveRemainingBytes, 512 * MIB);
});
test('explicit restore inside the hour gives full; expires after one hour', () => {
  const samples = [s(90, GiB), s(5, GiB)];
  const r = rp({...base, samples, restoreAt: now - 10 * 60000});
  assert.equal(r.reason, 'explicit-restore'); assert.equal(r.effectiveRemainingBytes, 6 * GiB);
  const e = rp({...base, samples, restoreAt: now - HOUR_MS - 1});
  assert.equal(e.reason, 'repriced-samples'); assert.equal(e.effectiveRemainingBytes, 512 * MIB);
  assert.equal(rp({...base, samples, restoreAt: now + 1}).reason, 'invalid-input');
});
test('workspace younger than one hour keeps the full amount', () => {
  const r = rp({...base, now: T0 + HOUR_MS - 1, samples: [{at: T0 + HOUR_MS - 1000, bytes: GiB}]});
  assert.equal(r.reason, 'fresh-workspace'); assert.equal(r.effectiveRemainingBytes, 6 * GiB);
});
test('deletion followed by regrowth counts positive growth, not net', () => {
  const samples = [s(90, 8 * GiB), s(50, 8 * GiB), s(40, 2 * GiB), s(30, 2 * GiB), s(20, 2 * GiB + 50 * MIB), s(5, 2 * GiB + 50 * MIB)];
  const r = rp({...base, originalGrowthBytes: 6 * GiB, samples});
  assert.equal(r.observedGrowthBytes, 50 * MIB); assert.equal(r.effectiveRemainingBytes, 512 * MIB);
  const regrow = [s(90, 8 * GiB), s(50, 2 * GiB), s(30, 2 * GiB + 100 * MIB), s(5, 2 * GiB + 100 * MIB)];
  const q = rp({...base, samples: regrow});
  assert.equal(q.reason, 'fresh-burst'); assert.equal(q.observedGrowthBytes, 100 * MIB);
  const net = [s(90, 5 * GiB), s(50, 5 * GiB), s(40, 3 * GiB), s(25, 3 * GiB + 80 * MIB), s(5, 3 * GiB + 80 * MIB)];
  assert.equal(rp({...base, samples: net}).reason, 'fresh-burst');
});
test('initial deployment bootstraps from completed baseline with only a current sample', () => {
  const idle = rp({...base, currentAllocationBytes: 5 * GiB + 3 * MIB, completedBaselineBytes: 5 * GiB});
  assert.equal(idle.reason, 'repriced-bootstrap'); assert.equal(idle.effectiveRemainingBytes, 512 * MIB); assert.equal(idle.basis, 'bootstrap-baseline');
  const grown = rp({...base, currentAllocationBytes: 5 * GiB + 1 * GiB, completedBaselineBytes: 5 * GiB});
  assert.equal(grown.effectiveRemainingBytes, 2 * GiB); assert.equal(grown.reason, 'repriced-bootstrap');
  const huge = rp({...base, currentAllocationBytes: 20 * GiB, completedBaselineBytes: 5 * GiB});
  assert.equal(huge.effectiveRemainingBytes, 6 * GiB);
  const shrunk = rp({...base, currentAllocationBytes: 4 * GiB, completedBaselineBytes: 5 * GiB});
  assert.equal(shrunk.effectiveRemainingBytes, 512 * MIB);
  const none = rp({...base, currentAllocationBytes: 5 * GiB});
  assert.equal(none.reason, 'history-incomplete'); assert.equal(none.effectiveRemainingBytes, 6 * GiB); assert.ok(none.historyNeeded);
  assert.equal(rp({...base, completedBaselineBytes: 5 * GiB}).reason, 'history-incomplete');
  // real samples inside the window take over from bootstrap; a later burst is detected
  const burst = rp({...base, completedBaselineBytes: 5 * GiB, samples: [s(20, 5 * GiB), s(5, 5 * GiB + 100 * MIB)]});
  assert.equal(burst.reason, 'fresh-burst');
});
test('original budgets below 512MiB cap the floor', () => {
  const r = rp({...base, originalGrowthBytes: 100 * MIB, samples: [s(90, GiB), s(5, GiB)]});
  assert.equal(r.effectiveRemainingBytes, 100 * MIB);
  assert.equal(rp({...base, originalGrowthBytes: 0, samples: [s(90, GiB), s(5, GiB)]}).effectiveRemainingBytes, 0);
});
test('malformed, corrupt or stale input fails closed to the full reservation', () => {
  const ok = [s(90, GiB), s(5, GiB)];
  for (const bad of [
    [s(90, -1), s(5, GiB)], [s(90, NaN), s(5, GiB)], [s(90, Infinity), s(5, GiB)], [{at: 'x', bytes: 1}], [null],
    [s(5, GiB), s(90, GiB)], [s(5, GiB), {at: now - 5 * 60000, bytes: 2 * GiB}], [{at: now + 1000, bytes: GiB}], [{at: T0 - 1, bytes: GiB}],
  ]) { const r = rp({...base, samples: bad}); assert.equal(r.reason, 'invalid-input', JSON.stringify(bad)); assert.equal(r.effectiveRemainingBytes, 6 * GiB); }
  assert.equal(rp({...base, samples: 'x'}).reason, 'invalid-input');
  assert.equal(rp({...base, now: NaN, samples: ok}).reason, 'invalid-input');
  assert.equal(rp({...base, createdAt: now + 1, samples: ok}).reason, 'invalid-input');
  assert.equal(rp({...base, samples: ok, currentAllocationBytes: -5}).reason, 'invalid-input');
  assert.equal(rp({...base, samples: ok, completedBaselineBytes: NaN}).reason, 'invalid-input');
  assert.equal(rp({...base, samples: [s(90, GiB), s(50, GiB)]}).reason, 'stale-samples');
  for (const o of [-1, NaN, Infinity, undefined]) { const r = rp({...base, originalGrowthBytes: o, samples: ok}); assert.equal(r.reason, 'invalid-original'); assert.equal(r.effectiveRemainingBytes, null); assert.equal(r.fullReservation, true); }
});
test('ISO timestamps and duplicate identical samples are accepted', () => {
  const iso = (m) => new Date(now - m * 60000).toISOString();
  const r = rp({...base, now: new Date(now).toISOString(), createdAt: new Date(T0).toISOString(), samples: [{at: iso(90), bytes: GiB}, {at: iso(5), bytes: GiB}, {at: iso(5), bytes: GiB}]});
  assert.equal(r.effectiveRemainingBytes, 512 * MIB);
});
