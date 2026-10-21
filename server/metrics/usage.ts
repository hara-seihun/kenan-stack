// Subscription usage: poll each broker's /v1/usage, keep per-account samples, and model each pool from its accounts.
import type { AccountDrain, PoolProjection, UsageAccount, UsagePlan, UsageReport } from '../../shared/contract.js';
import type { Deps, UsageSample } from '../types.js';
import { swarmCounts, swarmsOf } from '../../shared/swarm.js';

export const USAGE_POLL_MS = 5 * 60_000;
const HOUR = 3600_000;
const DRAIN_WINDOW_MS = 3 * HOUR;
const KEEP_MS = 24 * HOUR;
const STALE_MS = 10 * 60_000;
const STALE_READING_MS = 15 * 60_000;
const MIN_DRAIN_HOURS = 0.5;
const SIMULATION_STEP_MS = 5 * 60_000;
const SIMULATION_HORIZON_MS = 8 * 24 * HOUR;
const PROVIDERS: Record<string, UsagePlan['provider']> = { anthropic: 'anthropic', openai: 'openai' };
const sourceOf = (port: number) => `broker:${port}`;

const num = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) ? v : null;
const time = (v: unknown): number | null => typeof v === 'number' ? num(v) : typeof v === 'string' && Number.isFinite(Date.parse(v)) ? Date.parse(v) : null;

/**
 * Broker shape: {plans:{plans:{<planId>:{metrics:{<metricId>:{accounts:[{accountId, percentLeft, resetAt, windowHours, readingAt}]}}}}}}.
 * One sample per account; a reading without readingAt is dated by the poll that saw it.
 */
export function parseBrokerUsage(json: unknown, at: number): UsageSample[] {
  const plans = (json as any)?.plans?.plans;
  if (!plans || typeof plans !== 'object') return [];
  const out: UsageSample[] = [];
  for (const [planId, plan] of Object.entries<any>(plans)) {
    const provider = PROVIDERS[planId];
    if (!provider || !plan?.metrics || typeof plan.metrics !== 'object') continue;
    for (const [metric, m] of Object.entries<any>(plan.metrics)) {
      for (const a of Array.isArray(m?.accounts) ? m.accounts : []) {
        if (typeof a?.accountId !== 'string' || !a.accountId) continue;
        out.push({ provider, metric, account: a.accountId, percentLeft: num(a.percentLeft), resetAt: time(a.resetAt), windowHours: num(a.windowHours), readingAt: time(a.readingAt) ?? at, at });
      }
    }
  }
  return out;
}

async function fetchPort(deps: Deps, port: number): Promise<void> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/usage`, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const at = deps.now();
    await deps.store.recordUsageSamples(sourceOf(port), parseBrokerUsage(await res.json(), at), at - KEEP_MS);
  } catch (e) {
    await deps.store.logError('usage', `broker :${port} usage poll failed: ${String((e as Error)?.message ?? e)}`).catch(() => {});
  }
}

// One request per broker at a time, and one broker request at a time per server.
// The background poller, heartbeat and HTTP usage reads share the same work.
const polling = new WeakMap<Deps, { tail: Promise<void>; ports: Map<number, Promise<void>> }>();
function pollPort(deps: Deps, port: number): Promise<void> {
  let state = polling.get(deps);
  if (!state) { state = { tail: Promise.resolve(), ports: new Map() }; polling.set(deps, state); }
  const pending = state.ports.get(port);
  if (pending) return pending;
  const work = state.tail.catch(() => {}).then(() => fetchPort(deps, port));
  const finished = work.finally(() => { state.ports.delete(port); });
  state.ports.set(port, finished);
  state.tail = finished;
  return finished;
}

/** Poll every configured broker now and then every 5 minutes. Returns a stop function. */
export function startUsagePolling(deps: Deps): () => void {
  let stopped = false;
  let running = false;
  const poll = async () => {
    if (running || stopped) return;
    running = true;
    try {
      for (const port of new Set(deps.config.people.map(p => p.brokerPort))) {
        if (stopped) break;
        await pollPort(deps, port);
      }
    } finally { running = false; }
  };
  void poll();
  const timer = setInterval(() => { void poll(); }, USAGE_POLL_MS);
  timer.unref();
  return () => { stopped = true; clearInterval(timer); };
}

const nextReset = (resetAt: number | null, windowHours: number | null, after: number): number | null => {
  if (resetAt === null || resetAt > after) return resetAt;
  if (windowHours === null || windowHours <= 0) return null;
  const window = windowHours * HOUR;
  return resetAt + Math.ceil((after - resetAt + 1) / window) * window;
};

/** One account from its own readings (oldest first). Only decreases within one reset window count as drain, and only while its latest reading is fresh. */
export function accountFromSamples(series: UsageSample[], now: number): UsageAccount {
  const last = series[series.length - 1]!;
  let used = 0, hours = 0;
  for (let i = 1; i < series.length; i++) {
    const prev = series[i - 1]!, cur = series[i]!;
    if (prev.percentLeft === null || cur.percentLeft === null || cur.readingAt <= prev.readingAt || now - prev.readingAt > DRAIN_WINDOW_MS) continue;
    if (cur.percentLeft > prev.percentLeft || cur.resetAt !== prev.resetAt) continue;
    used += prev.percentLeft - cur.percentLeft;
    hours += (cur.readingAt - prev.readingAt) / HOUR;
  }
  const drain: AccountDrain = now - last.readingAt > STALE_READING_MS ? { state: 'stale', readingAt: last.readingAt }
    : hours >= MIN_DRAIN_HOURS ? { state: 'measured', percentPerHour: used / hours } : { state: 'unmeasured' };
  const reset = nextReset(last.resetAt, last.windowHours, now);
  const refilled = last.resetAt !== null && last.resetAt <= now;
  const percentLeft = last.percentLeft === null ? null : refilled ? 100 : last.percentLeft;
  const since = refilled ? last.resetAt! : last.readingAt;
  const runsOut = percentLeft !== null && drain.state === 'measured' && drain.percentPerHour > 0 ? Math.round(since + percentLeft / drain.percentPerHour * HOUR) : null;
  return {
    accountId: last.account, percentLeft, readingAt: last.readingAt, resetAt: reset, drain,
    projectedExhaustionAt: runsOut !== null && (reset === null || runsOut < reset) ? runsOut : null,
  };
}

/**
 * The pool's total drain spread over the accounts that still have quota (as the broker places new threads on the least-spent
 * account), each account refilling at its own reset. Returns when none has quota left, or null within the horizon.
 */
export function poolExhaustion(accounts: UsageAccount[], windows: Map<string, number | null>, drainPerHour: number, now: number): number | null {
  if (!(drainPerHour > 0)) return null;
  const state = accounts.filter(a => a.percentLeft !== null).map(a => ({ left: a.percentLeft!, reset: a.resetAt, window: windows.get(a.accountId) ?? null }));
  if (!state.length) return null;
  const perStep = drainPerHour * SIMULATION_STEP_MS / HOUR;
  for (let t = now; t < now + SIMULATION_HORIZON_MS; t += SIMULATION_STEP_MS) {
    let remaining = perStep;
    for (let live = state.filter(a => a.left > 0); remaining > 1e-9 && live.length; live = live.filter(a => a.left > 0)) {
      const share = remaining / live.length;
      for (const a of live) { const take = Math.min(a.left, share); a.left -= take; remaining -= take; }
    }
    if (remaining > 1e-9) return Math.round(t + SIMULATION_STEP_MS * (1 - remaining / perStep));
    const end = t + SIMULATION_STEP_MS;
    for (const a of state) if (a.reset !== null && a.reset <= end) { a.left = 100; a.reset = nextReset(a.reset, a.window, end); }
  }
  return null;
}

/** A pool from its accounts' latest readings; only measured drains project it. */
export function planFromSamples(series: UsageSample[], now: number): UsagePlan {
  const latestPoll = series[series.length - 1]!.at;
  const byAccount = new Map<string, UsageSample[]>();
  for (const sample of series) byAccount.set(sample.account, [...byAccount.get(sample.account) ?? [], sample]);
  const current = [...byAccount.values()].filter(s => s[s.length - 1]!.at === latestPoll).sort((x, y) => x[0]!.account.localeCompare(y[0]!.account));
  const accounts = current.map(s => accountFromSamples(s, now));
  const windows = new Map(current.map(s => [s[0]!.account, s[s.length - 1]!.windowHours]));
  const known = accounts.filter(a => a.percentLeft !== null);
  const measured = known.flatMap(a => a.drain.state === 'measured' ? [a.drain.percentPerHour] : []);
  const unknownDrain = known.filter(a => a.drain.state !== 'measured' && a.percentLeft! > 0).map(a => a.accountId);
  const totalDrain = measured.reduce((t, d) => t + d, 0);
  const projection: PoolProjection = measured.length
    ? { state: 'projected', drainPercentPerHour: totalDrain / known.length, exhaustionAt: poolExhaustion(accounts, windows, totalDrain, now), unknownDrain }
    : accounts.every(a => a.drain.state === 'stale') ? { state: 'stale', latestReadingAt: Math.max(...accounts.map(a => a.readingAt)) }
    : { state: 'unmeasured' };
  return {
    provider: series[0]!.provider as UsagePlan['provider'], metric: series[0]!.metric,
    percentLeft: known.length ? known.reduce((t, a) => t + a.percentLeft!, 0) / known.length : null,
    projection, accounts,
  };
}

/** The day's biggest spenders listed by agent; the totals cover every agent. */
export const SPEND_TOP = 12;

export async function usageReport(deps: Deps, personId: string): Promise<UsageReport> {
  const now = deps.now();
  const port = deps.person(personId)?.brokerPort;
  const read = () => port === undefined ? Promise.resolve([]) : deps.store.usageSamples(sourceOf(port), now - DRAIN_WINDOW_MS);
  let rows = await read();
  if (port !== undefined && !rows.some(r => r.at > now - STALE_MS)) {
    await pollPort(deps, port);
    rows = await read();
  }
  const series = new Map<string, UsageSample[]>();
  for (const r of rows) series.set(`${r.provider}/${r.metric}`, [...series.get(`${r.provider}/${r.metric}`) ?? [], r]);
  const plans = [...series.values()].map(s => planFromSamples(s, now));

  const everyAgent = await deps.store.listAgents(personId, { includeArchived: true });
  // Finished (archived) runs spent too: on Beta 2026-10-21 counting only live agents showed $668 of a $2,081 day.
  const agentIds = new Set(everyAgent.map(a => a.id));
  const [hour, day] = await Promise.all([deps.store.spend(now - HOUR), deps.store.spend(now - 24 * HOUR)]);
  const mine = (s: typeof hour) => s.byAgent.filter(a => agentIds.has(a.agentId));
  const sum = (xs: { usd: number }[]) => xs.reduce((t, a) => t + a.usd, 0);
  const dayUsd = new Map(day.byAgent.map(a => [a.agentId, a.usd]));
  const byId = new Map(everyAgent.map(a => [a.id, a]));
  const swarms = [...swarmsOf(everyAgent)].map(([id, children]) => ({
    coordinatorId: id, name: byId.get(id)!.name, subAgents: swarmCounts(children),
    lastDayUsd: { coordinator: dayUsd.get(id) ?? 0, subAgents: children.reduce((t, c) => t + (dayUsd.get(c.id) ?? 0), 0) },
  })).filter(s => s.lastDayUsd.coordinator + s.lastDayUsd.subAgents > 0 || s.subAgents.active > 0);
  return {
    observedAt: rows.length ? rows[rows.length - 1]!.at : now,
    plans,
    spend: { lastHourUsd: sum(mine(hour)), lastDayUsd: sum(mine(day)), byAgent: mine(day).slice(0, SPEND_TOP).map(a => ({ agentId: a.agentId, archived: byId.get(a.agentId)!.archived, lastDayUsd: a.usd })) },
    swarms,
  };
}
