import { createServer } from 'node:http';
import { expect, it } from 'vitest';
import type { Deps } from '../types.js';
import type { UsageSample } from '../types.js';
import { accountFromSamples, parseBrokerUsage, planFromSamples, poolExhaustion, usageReport } from './usage.js';

const at = Date.parse('2026-10-17T12:00:00Z');

const H = 3600_000;
const sample = (account: string, hoursAgo: number, percentLeft: number | null, resetAt: number | null, windowHours: number | null = 5): UsageSample =>
  ({ provider: 'anthropic', metric: 'five-hour', account, percentLeft, resetAt, windowHours, readingAt: at - hoursAgo * H, at: at - hoursAgo * H });

it('parses one sample per broker account, dated by the broker reading', () => {
  const usage = { plans: { plans: {
    anthropic: { metrics: { weekly: { percentLeft: 50, accounts: [
      { accountId: 'anthropic', percentLeft: 14, resetAt: '2026-10-23T09:00:00.000Z', windowHours: 168, readingAt: '2026-10-17T11:00:00Z' },
      { accountId: 'anthropic-5', percentLeft: 100, resetAt: null, windowHours: 168 },
      { percentLeft: 3 },
    ] } } },
    other: { metrics: { x: { accounts: [{ accountId: 'x', percentLeft: 1 }] } } },
  } } };
  expect(parseBrokerUsage(usage, at)).toEqual([
    { provider: 'anthropic', metric: 'weekly', account: 'anthropic', percentLeft: 14, resetAt: Date.parse('2026-10-23T09:00:00Z'), windowHours: 168, readingAt: at - H, at },
    { provider: 'anthropic', metric: 'weekly', account: 'anthropic-5', percentLeft: 100, resetAt: null, windowHours: 168, readingAt: at, at },
  ]);
  expect(parseBrokerUsage({}, at)).toEqual([]);
});

it('measures an account\'s drain from decreases only; a reset is not negative drain', () => {
  const reset = at + 2 * H;
  // 60 → 30 over an hour, a reset to 100 (new window), then 100 → 90 over half an hour: 40 used in 1.5 h.
  const account = accountFromSamples([sample('a', 2.5, 60, at - 0.5 * H), sample('a', 1.5, 30, at - 0.5 * H), sample('a', 0.5, 100, reset), sample('a', 0, 90, reset)], at);
  expect(account.drain).toMatchObject({ state: 'measured' });
  expect(account.drain.state === 'measured' && account.drain.percentPerHour).toBeCloseTo(40 / 1.5);
  expect(account).toMatchObject({ accountId: 'a', percentLeft: 90, resetAt: reset });
  expect(account.projectedExhaustionAt).toBeNull(); // 90% at ~26.7%/h lasts past its reset in 2 h
  expect(accountFromSamples([sample('a', 1, 50, at + 10 * H), sample('a', 0, 40, at + 10 * H)], at).projectedExhaustionAt).toBe(at + 4 * H);
  // A reading from before its window reset is a full account now, resetting one window later.
  expect(accountFromSamples([sample('a', 9, 11, at - 4 * H)], at)).toMatchObject({ percentLeft: 100, resetAt: at + H, drain: { state: 'stale', readingAt: at - 9 * H }, projectedExhaustionAt: null });
});

it('projects the pool from each account\'s own share and reset, not an average and the earliest reset', () => {
  const a = sample('a', 0, 50, at + H), b = sample('b', 0, 0, at + 10 * H, 168);
  const plan = planFromSamples([a, b], at);
  expect(plan.percentLeft).toBe(25);
  expect(plan.projection).toEqual({ state: 'unmeasured' });
  // 30 %/h of the pool's drain: a runs 50 → 20 by its reset at 1 h, refills to 100 and runs out 100/30 h later; b stays empty until 10 h.
  const out = poolExhaustion(plan.accounts, new Map([['a', 5], ['b', 168]]), 30, at)!;
  expect(Math.abs(out - (at + H + 100 / 30 * H))).toBeLessThan(6 * 60_000);
  expect(poolExhaustion(plan.accounts, new Map([['a', 5], ['b', 168]]), 10, at)).toBeNull(); // a refills every 5 h before it empties
});

it('a stale reading has no drain figure: it neither projects the pool nor repeats an old rate across metrics', () => {
  // 2026-10-18: anthropic-2's broker reading stopped at 13:51Z; by 15:11Z only its last 7 minutes of 1% steps were in the
  // 3 h window, read as −8.58%/h on both its five-hour and weekly meters, and the pool was projected out the next day.
  const now = Date.parse('2026-10-18T15:11:00Z'), poll = (t: string) => Date.parse(`2026-10-18T${t}Z`);
  const reading = (metric: string, account: string, readingAt: string, left: number, polledAt = readingAt): UsageSample =>
    ({ provider: 'anthropic', metric, account, percentLeft: left, resetAt: metric === 'weekly' ? now + 100 * H : now + H, windowHours: metric === 'weekly' ? 168 : 5, readingAt: poll(readingAt), at: poll(polledAt) });
  for (const [metric, high] of [['five-hour', 97], ['weekly', 69]] as const) {
    const series = [
      reading(metric, 'anthropic-2', '12:09:01', high), reading(metric, 'anthropic-2', '13:44:53', high),
      reading(metric, 'anthropic-2', '13:49:29', high - 1), reading(metric, 'anthropic-2', '13:51:53', high - 1),
      ...['14:00:00', '14:30:00', '15:10:00'].map(t => reading(metric, 'anthropic-2', '13:51:53', high - 1, t)),
      reading(metric, 'anthropic', '14:10:00', 50, '14:10:00'), reading(metric, 'anthropic', '15:09:00', 45, '15:10:00'),
    ].sort((x, y) => x.at - y.at);
    const plan = planFromSamples(series, now);
    expect(plan.accounts.find(a => a.accountId === 'anthropic-2')).toMatchObject({ drain: { state: 'stale', readingAt: poll('13:51:53') }, projectedExhaustionAt: null });
    expect(plan.projection).toMatchObject({ state: 'projected', unknownDrain: ['anthropic-2'] });
    expect(plan.projection.state === 'projected' && plan.projection.drainPercentPerHour).toBeCloseTo(5 / (59 / 60) / 2);
  }
  // A failed poll leaves only old readings: the pool shows stale, not a drain.
  const old = [sample('a', 2, 80, null), sample('a', 1, 60, null), sample('b', 1, 90, null)];
  expect(planFromSamples(old, at).projection).toEqual({ state: 'stale', latestReadingAt: at - H });
  expect(planFromSamples(old, at).accounts.map(a => a.drain.state)).toEqual(['stale', 'stale']);
  // Fresh but only minutes of readings: not yet a rate.
  expect(accountFromSamples([sample('a', 0.1, 97, null), sample('a', 0, 96, null)], at).drain).toEqual({ state: 'unmeasured' });
});

it('usageReport polls a stale broker, reports each account and the person\'s agent spend', async () => {
  const broker = createServer((_req, res) => res.end(JSON.stringify({ plans: { plans: { anthropic: { metrics: { weekly: { accounts: [
    { accountId: 'anthropic', percentLeft: 42, resetAt: null, windowHours: 168, readingAt: new Date(at).toISOString() },
    { accountId: 'anthropic-2', percentLeft: 90, resetAt: null, windowHours: 168, readingAt: new Date(at).toISOString() },
  ] } } } } } })));
  await new Promise<void>(r => broker.listen(0, '127.0.0.1', r));
  const port = (broker.address() as { port: number }).port;
  const rows: (UsageSample & { source: string })[] = [{ ...sample('anthropic', 1, 50, null, 168), metric: 'weekly', source: `broker:${port}` }];
  const store = {
    recordUsageSamples: async (source: string, samples: UsageSample[]) => { rows.push(...samples.map(s => ({ ...s, source }))); },
    usageSamples: async (source: string, since: number) => rows.filter(r => r.at >= since && r.source === source),
    listAgents: async () => [{ id: 'mine' }],
    spend: async (since: number) => since > at - 7200_000
      ? { totalUsd: 3, byAgent: [{ agentId: 'mine', usd: 1 }, { agentId: 'other', usd: 2 }] }
      : { totalUsd: 9, byAgent: [{ agentId: 'mine', usd: 4 }, { agentId: 'other', usd: 5 }] },
    logError: async () => {},
  };
  const deps = { store, now: () => at, person: () => ({ brokerPort: port }) } as unknown as Deps;
  const report = await usageReport(deps, 'alice');
  broker.close();
  expect(report.observedAt).toBe(at);
  expect(report.plans).toHaveLength(1);
  expect(report.plans[0]).toMatchObject({ provider: 'anthropic', metric: 'weekly', percentLeft: 66, projection: { state: 'projected', drainPercentPerHour: 4, unknownDrain: ['anthropic-2'] } });
  expect(report.plans[0]!.accounts.map(a => [a.accountId, a.percentLeft, a.drain])).toEqual([['anthropic', 42, { state: 'measured', percentPerHour: 8 }], ['anthropic-2', 90, { state: 'unmeasured' }]]);
  expect(report.spend).toEqual({ lastHourUsd: 1, lastDayUsd: 4, byAgent: [{ agentId: 'mine', lastDayUsd: 4 }] });
});

it('coalesces concurrent usage reads and serializes requests to different brokers', async () => {
  let active = 0, maximum = 0, requests = 0;
  const brokers = [0, 1].map(() => createServer((_req, res) => {
    requests++; maximum = Math.max(maximum, ++active);
    setTimeout(() => { active--; res.end(JSON.stringify({ plans: { plans: { anthropic: { metrics: { weekly: { accounts: [{ accountId: 'anthropic', percentLeft: 42 }] } } } } } })); }, 25);
  }));
  await Promise.all(brokers.map(broker => new Promise<void>(resolve => broker.listen(0, '127.0.0.1', resolve))));
  const ports = brokers.map(broker => (broker.address() as { port: number }).port);
  const rows: (UsageSample & { source: string })[] = [];
  const deps = {
    now: () => at,
    person: (id: string) => ({ brokerPort: ports[id === 'a' ? 0 : 1] }),
    store: {
      usageSamples: async (source: string) => rows.filter(row => row.source === source),
      recordUsageSamples: async (source: string, samples: UsageSample[]) => { rows.push(...samples.map(s => ({ ...s, source }))); },
      listAgents: async () => [], spend: async () => ({ byAgent: [] }), logError: async () => {},
    },
  } as unknown as Deps;
  try {
    const reports = await Promise.all([usageReport(deps, 'a'), usageReport(deps, 'a'), usageReport(deps, 'b'), usageReport(deps, 'a')]);
    expect(requests).toBe(2);
    expect(maximum).toBe(1);
    expect(reports.every(report => report.plans[0]?.percentLeft === 42)).toBe(true);
  } finally { await Promise.all(brokers.map(broker => new Promise<void>(resolve => broker.close(() => resolve())))); }
});
