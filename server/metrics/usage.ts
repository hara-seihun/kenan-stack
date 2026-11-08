import { capacityOverview } from './capacity.js';
// Subscription usage: poll each broker's /v1/usage, keep per-account samples, and model each pool from its accounts.
import type { AccountDrain, PoolProjection, UsageAccount, UsagePlan, UsageReport } from '../../shared/contract.js';
import { QUOTA_RATE } from '../agents/speed.js';
import type { Deps, UsageSample } from '../types.js';
import { swarmCounts, workerDescendants } from '../../shared/swarm.js';
import { cacheReport, readCatalog } from './cache.js';
import { planCosts, planCapacityWeights } from './plan-costs.js';
import { mercuryReport } from './mercury.js';
import { googleUsage } from './google-usage.js';
import { xaiAvailability } from '../agents/model-route.js';

export const USAGE_POLL_MS = 5 * 60_000;
const HOUR = 3600_000;
/** Readings are whole percents; over six hours one point is 0.17%/h, against weekly paces of 0.4–0.8%/h. */
const DRAIN_WINDOW_MS = 6 * HOUR;
/** A pause inside the long window (an outage, an idle stretch) dilutes its average; the pace the pool runs at when it is working shows in this shorter one. */
const RECENT_DRAIN_WINDOW_MS = 2 * HOUR;
/** Header and usage-poll readings state the same reset up to a second apart. */
const SAME_RESET_MS = 60_000;
const KEEP_MS = 24 * HOUR;
const STALE_READING_MS = 15 * 60_000;
const MIN_DRAIN_HOURS = 0.5;
const SIMULATION_STEP_MS = 5 * 60_000;
const SIMULATION_HORIZON_MS = 8 * 24 * HOUR;
const PROVIDERS: Record<string, UsagePlan['provider']> = { anthropic: 'anthropic', openai: 'openai', 'openai-codex': 'openai', xai: 'xai', grok: 'xai' };
const sourceOf = (port: number) => `broker:${port}`;

const num = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) ? v : null;
const time = (v: unknown): number | null => typeof v === 'number' ? num(v) : typeof v === 'string' && Number.isFinite(Date.parse(v)) ? Date.parse(v) : null;

/**
 * Broker shape: {plans:{plans:{<planId>:{metrics:{<metricId>:{accounts:[{accountId, percentLeft, resetAt, windowHours, readingAt}]}}}}}}.
 * One sample per account; a reading without readingAt is dated by the poll that saw it.
 */
/** The broker's catalog calls Codex's weekly window "remaining"; it is the weekly window, named as Anthropic's is. */
const weeklyName = (provider: UsagePlan['provider'], metric: string) => provider === 'openai' && metric === 'remaining' ? 'weekly' : metric;

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
        out.push({ provider, metric: weeklyName(provider, metric), account: a.accountId, percentLeft: num(a.percentLeft), resetAt: time(a.resetAt), windowHours: num(a.windowHours), readingAt: time(a.readingAt) ?? at, at });
      }
    }
  }
  return out;
}

type BrokerSnapshot = { raw: unknown; grok: UsagePlan['availability'] | null; credits: NonNullable<UsagePlan['credits']> };
async function fetchPort(deps: Deps, port: number): Promise<BrokerSnapshot | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/usage`, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const at = deps.now();
    const body = await res.json();
    await deps.store.recordUsageSamples(sourceOf(port), parseBrokerUsage(body, at), at - KEEP_MS);
    const accounts = new Map<string, { accountId: string; balance: number; available: boolean }>();
    for (const plan of Object.values<any>((body as any).plans?.plans ?? {})) for (const metric of Object.values<any>(plan.metrics ?? {})) for (const a of metric.accounts ?? []) {
      if (a.credits && typeof a.credits.balance === 'number') accounts.set(a.accountId, { accountId: a.accountId, balance: a.credits.balance, available: a.credits.available === true });
    }
    return { raw: body, grok: xaiAvailability((body as any).availability), credits: { balance: [...accounts.values()].reduce((n,a)=>n+a.balance,0), available: [...accounts.values()].some(a=>a.available), accounts: [...accounts.values()] } };
  } catch (e) {
    await deps.store.logError('usage', `broker :${port} usage poll failed: ${String((e as Error)?.message ?? e)}`).catch(() => {});
    return null;
  }
}

// Background polls, heartbeat and HTTP reads share one request per broker. Different brokers run independently.
const polling = new WeakMap<Deps, Map<number, Promise<BrokerSnapshot | null>>>();
function pollPort(deps: Deps, port: number): Promise<BrokerSnapshot | null> {
  let ports = polling.get(deps);
  if (!ports) { ports = new Map(); polling.set(deps, ports); }
  const pending = ports.get(port);
  if (pending) return pending;
  const finished = fetchPort(deps, port).finally(() => { ports.delete(port); });
  ports.set(port, finished);
  return finished;
}

async function pollGoogle(deps: Deps): Promise<void> {
  const port = deps.person('alice')?.brokerPort;
  if (port === undefined || !(deps.config.allowedProviders as readonly string[] | undefined)?.includes('google-cli')) return;
  const now = deps.now();
  try {
    const samples = (await googleUsage(now, port)).map(sample => ({ ...sample, at: now }));
    await deps.store.recordUsageSamples(sourceOf(port), samples, now - KEEP_MS);
  } catch (error) {
    await deps.store.logError('usage', `Native Antigravity quota failed: ${String(error)}`).catch(() => {});
  }
}

/** Poll every configured broker now and then every 5 minutes. Returns a stop function. */
export function startUsagePolling(deps: Deps): () => void {
  let stopped = false;
  let running = false;
  const poll = async () => {
    if (running || stopped) return;
    running = true;
    try {
      await Promise.all([pollGoogle(deps), ...[...new Set(deps.config.people.map(p => p.brokerPort))].map(port => pollPort(deps, port))]);
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

/** Percent used and hours covered by consecutive readings of one reset window that fall within `windowMs` of now. */
function drainOver(series: UsageSample[], now: number, windowMs: number): { used: number; hours: number } {
  let used = 0, hours = 0;
  let low: { left: number; resetAt: number | null } | null = null;
  for (let i = 0; i < series.length; i++) {
    const prev = series[i - 1], cur = series[i]!;
    if (cur.percentLeft === null) continue;
    const sameWindow = low !== null && (low.resetAt === null ? cur.resetAt === null
      : cur.resetAt !== null && Math.abs(cur.resetAt - low.resetAt) <= SAME_RESET_MS);
    if (!sameWindow) { low = { left: cur.percentLeft, resetAt: cur.resetAt }; continue; }
    if (prev && prev.percentLeft !== null && cur.readingAt > prev.readingAt && now - prev.readingAt <= windowMs) {
      used += Math.max(0, low!.left - cur.percentLeft);
      hours += (cur.readingAt - prev.readingAt) / HOUR;
    }
    low!.left = Math.min(low!.left, cur.percentLeft);
  }
  return { used, hours };
}

/**
 * One account from its own readings (oldest first), only while its latest reading is fresh. Usage only falls within one
 * reset window, so drain is how far the lowest reading so far fell, over the time covered: a reading back up a point
 * (the broker's header and poll readings round a point apart) is rounding, and a reset starts a new window, not negative drain.
 * The pace is the faster of the six-hour and two-hour averages, so a pause does not hide how fast the pool runs when it works.
 */
export function accountFromSamples(series: UsageSample[], now: number): UsageAccount {
  const last = series[series.length - 1]!;
  const long = drainOver(series, now, DRAIN_WINDOW_MS), recent = drainOver(series, now, RECENT_DRAIN_WINDOW_MS);
  const paces = [long, recent].filter(pace => pace.hours >= MIN_DRAIN_HOURS).map(pace => pace.used / pace.hours);
  const drain: AccountDrain = now - last.readingAt > STALE_READING_MS ? { state: 'stale', readingAt: last.readingAt }
    : paces.length ? { state: 'measured', percentPerHour: Math.max(...paces) } : { state: 'unmeasured' };
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
export function poolExhaustion(accounts: UsageAccount[], windows: Map<string, number | null>, drainPerHour: number, now: number, weights: ReadonlyMap<string, number> = new Map()): number | null {
  if (!(drainPerHour > 0)) return null;
  const state = accounts.filter(a => a.percentLeft !== null).map(a => { const weight = weights.get(a.accountId) ?? 1; return { left: a.percentLeft! * weight, weight, reset: a.resetAt, window: windows.get(a.accountId) ?? null }; });
  if (!state.length) return null;
  const perStep = drainPerHour * SIMULATION_STEP_MS / HOUR;
  for (let t = now; t < now + SIMULATION_HORIZON_MS; t += SIMULATION_STEP_MS) {
    let remaining = perStep;
    for (let live = state.filter(a => a.left > 0); remaining > 1e-9 && live.length; live = live.filter(a => a.left > 0)) {
      const share = remaining / live.reduce((sum, a) => sum + a.weight, 0);
      for (const a of live) { const take = Math.min(a.left, share * a.weight); a.left -= take; remaining -= take; }
    }
    if (remaining > 1e-9) return Math.round(t + SIMULATION_STEP_MS * (1 - remaining / perStep));
    const end = t + SIMULATION_STEP_MS;
    for (const a of state) if (a.reset !== null && a.reset <= end) { a.left = 100 * a.weight; a.reset = nextReset(a.reset, a.window, end); }
  }
  return null;
}

/** A pool from its accounts' latest readings; only measured drains project it. */
export function planFromSamples(series: UsageSample[], now: number, weights: ReadonlyMap<string, number> = new Map()): UsagePlan {
  const latestPoll = series[series.length - 1]!.at;
  const byAccount = new Map<string, UsageSample[]>();
  for (const sample of series) byAccount.set(sample.account, [...byAccount.get(sample.account) ?? [], sample]);
  const current = [...byAccount.values()].filter(s => s[s.length - 1]!.at === latestPoll).sort((x, y) => x[0]!.account.localeCompare(y[0]!.account));
  const accounts = current.map(s => ({ ...accountFromSamples(s, now), capacityMultiplier: weights.get(s[0]!.account) ?? 1 }));
  const windows = new Map(current.map(s => [s[0]!.account, s[s.length - 1]!.windowHours]));
  const known = accounts.filter(a => a.percentLeft !== null);
  const measured = known.flatMap(a => a.drain.state === 'measured' ? [a.drain.percentPerHour * (weights.get(a.accountId) ?? 1)] : []);
  const capacity = known.reduce((sum, a) => sum + (weights.get(a.accountId) ?? 1), 0);
  const unknownDrain = known.filter(a => a.drain.state !== 'measured' && a.percentLeft! > 0).map(a => a.accountId);
  const totalDrain = measured.reduce((t, d) => t + d, 0);
  const projection: PoolProjection = measured.length
    ? { state: 'projected', drainPercentPerHour: totalDrain / capacity, exhaustionAt: poolExhaustion(accounts, windows, totalDrain, now, weights), unknownDrain }
    : accounts.every(a => a.drain.state === 'stale') ? { state: 'stale', latestReadingAt: Math.max(...accounts.map(a => a.readingAt)) }
    : { state: 'unmeasured' };
  return {
    provider: series[0]!.provider as UsagePlan['provider'], metric: series[0]!.metric,
    percentLeft: capacity ? known.reduce((t, a) => t + a.percentLeft! * (weights.get(a.accountId) ?? 1), 0) / capacity : null,
    projection, accounts, binding: false,
  };
}

/** A window the provider reports for none of a provider's accounts (Codex has no five-hour window) is not a limit: it is
 * dropped while another window of that provider is readable. When nothing of a provider is readable its rows stay, as outages. */
export function withoutUnreported(plans: UsagePlan[]): UsagePlan[] {
  const readable = (plan: UsagePlan) => plan.accounts.some(account => account.percentLeft !== null);
  return plans.filter(plan => readable(plan) || !plans.some(other => other.provider === plan.provider && readable(other)));
}

/** Per provider, the limit that runs out first is the binding one: the earliest projected exhaustion, else the least left. */
export function markBinding(plans: UsagePlan[]): UsagePlan[] {
  const binding = new Set<UsagePlan>();
  for (const provider of new Set(plans.map(plan => plan.provider))) {
    const own = plans.filter(plan => plan.provider === provider && plan.percentLeft !== null);
    const projected = own.filter(plan => plan.projection.state === 'projected' && plan.projection.exhaustionAt !== null);
    const first = projected.length
      ? projected.reduce((a, b) => (b.projection as { exhaustionAt: number }).exhaustionAt < (a.projection as { exhaustionAt: number }).exhaustionAt ? b : a)
      : own.reduce<UsagePlan | undefined>((a, b) => !a || b.percentLeft! < a.percentLeft! ? b : a, undefined);
    if (first) binding.add(first);
  }
  return plans.map(plan => ({ ...plan, binding: binding.has(plan) }));
}

/** The day's biggest spenders listed by agent; the totals cover every agent. */
export const SPEND_TOP = 12;

/** Current subscription plans only; admission needs the same fresh readings, not cost/cache or worker reports. */
export async function usagePlans(deps: Deps, personId: string): Promise<Pick<UsageReport, 'observedAt' | 'plans'> & { brokerSnapshot?: unknown }> {
  const port = deps.person(personId)?.brokerPort;
  // Explicit reads must see the broker's current accounts, not just a recent stored poll.
  const snapshot = port === undefined ? null : await pollPort(deps, port);
  const availability = snapshot?.grok;
  const now = deps.now();
  if (personId === 'alice') await pollGoogle(deps);
  const rows = port === undefined ? [] : await deps.store.usageSamples(sourceOf(port), now - DRAIN_WINDOW_MS);
  const series = new Map<string, UsageSample[]>();
  for (const r of rows) series.set(`${r.provider}/${r.metric}`, [...series.get(`${r.provider}/${r.metric}`) ?? [], r]);
  const weights = await planCapacityWeights(deps.config.plansPath);
  const plans = markBinding(withoutUnreported([...series.values()].filter(s => s[0]!.provider !== 'xai').map(s => planFromSamples(s, now, weights))));
  for (const plan of plans) if (plan.provider === 'openai' && snapshot?.credits) {
    plan.credits = snapshot.credits;
    if (snapshot.credits.available) {
      plan.binding = false;
      plan.availability = { available: true, exhausted: false, reason: 'Prepaid Codex credits available', resetAt: null, nextProbeAt: null };
      plan.projection = { state: 'unmeasured' };
    }
  }
  // Billing supplies included-credit quota; a successful inference alone never implies a full balance.
  const grokEnabled = personId === 'alice' && deps.config.allowedProviders?.includes('xai')
    && [...readCatalog(deps.config.modelsPath).values()].some(model => model.provider === 'xai');
  if (grokEnabled) {
    const percentLeft = availability?.exhausted ? 0 : availability?.percentLeft ?? null;
    plans.push({
      provider: 'xai', metric: 'subscription', percentLeft,
      projection: { state: 'unmeasured' }, accounts: [], binding: percentLeft !== null,
      ...(availability ? { availability } : {}),
      quotaUnavailableReason: availability?.available === false ? availability.reason ?? 'Grok is unavailable.'
        : percentLeft === null ? 'The current Grok subscription balance is unavailable; drain is unknown.' : 'Subscription drain is unknown.',
    });
  }

  return { observedAt: rows.length ? rows[rows.length - 1]!.at : now, plans, brokerSnapshot: snapshot?.raw };
}

export async function usageReport(deps: Deps, personId: string): Promise<UsageReport> {
  const { observedAt, plans, brokerSnapshot } = await usagePlans(deps, personId);
  const now = deps.now();
  const everyAgent = await deps.store.listAgents(personId, { includeArchived: true });
  // Finished (archived) runs spent too: on Beta 2026-10-21 counting only live agents showed $668 of a $2,081 day.
  const agentIds = new Set(everyAgent.map(a => a.id));
  const [hour, day, cache] = await Promise.all([deps.store.spend(now - HOUR), deps.store.spend(now - 24 * HOUR), cacheReport(deps, everyAgent)]);
  const providerSpend = new Map<string, { provider: string; lastHourUsd: number; lastDayUsd: number }>();
  const spendFor = (provider: string) => {
    const key = PROVIDERS[provider] ?? provider;
    let entry = providerSpend.get(key);
    if (!entry) { entry = { provider: key, lastHourUsd: 0, lastDayUsd: 0 }; providerSpend.set(key, entry); }
    return entry;
  };
  for (const plan of plans) spendFor(plan.provider);
  for (const group of cache.hour.byProvider) spendFor(group.provider).lastHourUsd += group.costUsd;
  for (const group of cache.day.byProvider) spendFor(group.provider).lastDayUsd += group.costUsd;
  const mine = (s: typeof hour) => s.byAgent.filter(a => agentIds.has(a.agentId));
  const sum = (xs: { usd: number }[]) => xs.reduce((t, a) => t + a.usd, 0);
  const dayUsd = new Map(day.byAgent.map(a => [a.agentId, a.usd]));
  const byId = new Map(everyAgent.map(a => [a.id, a]));
  const swarms = [...workerDescendants(everyAgent)].map(([id, children]) => ({
    coordinatorId: id, name: byId.get(id)!.name, subAgents: swarmCounts(children),
    lastDayUsd: { coordinator: dayUsd.get(id) ?? 0, subAgents: children.reduce((t, c) => t + (dayUsd.get(c.id) ?? 0), 0) },
  })).filter(s => s.lastDayUsd.coordinator + s.lastDayUsd.subAgents > 0 || s.subAgents.active > 0);
  const prices = personId === 'alice' ? await planCosts(deps.config.plansPath, plans, now) : { unavailable: 'Plan prices are shown to Alice only.' };
  return {
    observedAt,
    plans,
    capacity: capacityOverview(brokerSnapshot, plans, prices, deps.config.allowedProviders, now),
    providerSpend: [...providerSpend.values()],
    spend: { lastHourUsd: sum(mine(hour)), lastDayUsd: sum(mine(day)), byAgent: mine(day).slice(0, SPEND_TOP).map(a => ({ agentId: a.agentId, archived: byId.get(a.agentId)!.archived, lastDayUsd: a.usd })) },
    swarms,
    speeds: (['fast', 'ultrafast'] as const).map(speed => ({ speed, quotaRate: QUOTA_RATE[speed],
      workers: everyAgent.filter(a => a.speed === speed && !a.archived && a.state !== 'stopped').map(a => ({ id: a.id, name: a.name, model: a.model })) })),
    cache,
    mercury: await mercuryReport(deps, personId),
    planCosts: prices,
  };
}
