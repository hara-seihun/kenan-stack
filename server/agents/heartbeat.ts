import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentInfo, Goal, LatencyReport, PoolProjection, UsageAccount, UsageReport } from '../../shared/contract.js';
import type { Deps, HeartbeatState, LoggedError, Wake } from '../types.js';
import { describeTrigger, waitingLine } from './wakes.js';
import type { PersonConfig } from '../config.js';
import { usageReport } from '../metrics/usage.js';

const DEFAULT_INSTRUCTIONS = 'Review your goals, workers, usage and recent errors; act where needed.';
/** With nothing moved, a manager keeping a checklist or work in flight still hears from its heartbeat this often. */
export const HEARTBEAT_FLOOR_MS = 4 * 3600_000;
const TITLE_CHARS = 90;
const ERROR_CHARS = 300;
export const HEARTBEAT_ERROR_LIMIT = 10;

const clip = (text: string, limit: number) => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
};
const short = (id: string) => id.length > 8 && /^[0-9a-f-]{36}$/.test(id) ? id.slice(0, 8) : id;
const ago = (ms: number) => {
  const minutes = Math.max(0, Math.round(ms / 60000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 6) / 10;
  return hours < 48 ? `${hours}h` : `${Math.round(hours / 24)}d`;
};
const clock = (at: number) => new Date(at).toISOString().slice(0, 16) + 'Z';
const seconds = (ms: number | null) => ms == null ? '–' : `${(ms / 1000).toFixed(1)}s`;

const percent = (value: number) => `${Math.round(value)}%`;
const rate = (perHour: number) => perHour ? ` −${perHour.toFixed(1)}%/h` : '';
const accountDrain = (drain: UsageAccount['drain']) => drain.state === 'measured' ? rate(drain.percentPerHour) : drain.state === 'stale' ? ` stale since ${clock(drain.readingAt)}` : '';
const poolProjection = (projection: PoolProjection) => projection.state === 'stale' ? `, drain unknown: no fresh reading since ${clock(projection.latestReadingAt)}`
  : projection.state === 'unmeasured' ? ', drain not measured yet'
  : `${rate(projection.drainPercentPerHour)}${projection.exhaustionAt ? `, out ${clock(projection.exhaustionAt)}` : ''}${projection.unknownDrain.length ? ` (uncertain: no current drain for ${projection.unknownDrain.join(', ')})` : ''}`;

/** One line per pool (metrics reading the same account meters share a line): the pool, then each account's own share and reset. */
export function usageLines(plans: UsageReport['plans']): string[] {
  const groups = new Map<string, UsageReport['plans']>();
  for (const plan of plans.filter(plan => plan.percentLeft !== null)) {
    const key = `${plan.provider} ${JSON.stringify(plan.accounts)}`;
    groups.set(key, [...groups.get(key) ?? [], plan]);
  }
  if (!groups.size) return ['Usage: no plan readings.'];
  return ['Usage (pool share left, drain, when every account is out; then each account: left, drain, own reset):', ...[...groups.values()].map(([plan, ...same]) => {
    const name = `${plan!.provider} ${[plan!.metric, ...same.map(other => other.metric)].join('/')}`;
    const pool = `${percent(plan!.percentLeft!)}${poolProjection(plan!.projection)}`;
    const accounts = plan!.accounts.map(account => `${account.accountId} ${account.percentLeft === null ? '?' : percent(account.percentLeft)}${accountDrain(account.drain)}${account.projectedExhaustionAt ? ` out ${clock(account.projectedExhaustionAt)}` : ''}${account.resetAt ? ` ↻${clock(account.resetAt)}` : ''}`);
    return `- ${name}: pool ${pool} | ${accounts.join('; ')}`;
  })];
}

export interface HostAlert { name: string; title: string; changedAt: number }
/** Host conditions: producers write one *.md file per open condition and delete it once resolved. */
export type HostAlerts =
  | { kind: 'unconfigured' }
  | { kind: 'read'; dir: string; alerts: HostAlert[] }
  | { kind: 'unreadable'; dir: string; message: string };

export async function readHostAlerts(dir: string | null): Promise<HostAlerts> {
  if (dir === null) return { kind: 'unconfigured' };
  try {
    const names = (await readdir(dir)).filter(name => name.endsWith('.md')).sort();
    const alerts = await Promise.all(names.map(async name => {
      const path = join(dir, name);
      const [text, info] = await Promise.all([readFile(path, 'utf8'), stat(path)]);
      const first = text.split('\n').map(line => line.replace(/^#+\s*/, '').trim()).find(Boolean);
      return { name, title: first ?? '(empty file)', changedAt: info.mtimeMs };
    }));
    return { kind: 'read', dir, alerts };
  } catch (error) {
    return { kind: 'unreadable', dir, message: error instanceof Error ? error.message : String(error) };
  }
}

function alertLines(host: HostAlerts, now: number): string[] {
  switch (host.kind) {
    case 'unconfigured': return [];
    case 'unreadable': return [`Host alerts unreadable (${host.dir}): ${clip(host.message, ERROR_CHARS)}`];
    case 'read':
      if (!host.alerts.length) return [`No open host alerts (${host.dir}).`];
      return [`Open host alerts (${host.alerts.length}) in ${host.dir}; read the file, fix the cause, and the producer removes it:`,
        ...host.alerts.map(alert => `- ${alert.name} (${ago(now - alert.changedAt)} old): ${clip(alert.title, TITLE_CHARS)}`)];
  }
}

export interface StatusInput {
  goals: Goal[];
  agents: AgentInfo[];
  usage: UsageReport;
  latency: LatencyReport;
  errors: LoggedError[];
  hostAlerts: HostAlerts;
  /** Pending wakes, and wakes dropped since the previous heartbeat. */
  wakes: Wake[];
  droppedWakes: Wake[];
  previous: HeartbeatState | null;
  /** Why this heartbeat was delivered (decideHeartbeat). */
  reasons: string[];
  checklist: string | null;
  now: number;
}

/** A compact, line-oriented status. Full detail stays one goals/workers tool call away. */
export function renderStatus(input: StatusInput): { text: string; state: HeartbeatState } {
  const { goals, agents, usage, latency, errors, hostAlerts, wakes, droppedWakes, previous, reasons, checklist, now } = input;
  const open = goals.filter(goal => goal.status === 'open').sort((a, b) => a.priority - b.priority || b.updatedAt - a.updatedAt);
  const workers = openWorkers(agents);
  const workerLabel = (worker: AgentInfo) => {
    const changed = previous && previous.workers[worker.id] !== worker.state ? '*' : '';
    const waiting = waitingLine(worker, wakes, now);
    const own = waiting ? ` ⚠ ${waiting}` : wakes.filter(wake => wake.agentId === worker.id).map(wake => ` wake ${describeTrigger(wake)}`).join('');
    return `${short(worker.id)} ${worker.state}${changed}${worker.lastReport ? ` report:${worker.lastReport.status}` : ''}${own}`;
  };
  const heldFor = (goalId: string) => wakes.filter(wake => wake.held?.goalId === goalId).sort((a, b) => (a.at ?? Infinity) - (b.at ?? Infinity));
  const heldLabel = (held: Wake[]) => `held ${held.length === 1 ? 'trigger' : `triggers (${held.length})`}: ${clip(describeTrigger(held[0]!), 120)}${held.length > 1 ? ' …' : ''}`;
  const lines = [`<status at="${clock(now)}" previous="${previous ? clock(previous.at) : 'none'}">`, `Why now: ${reasons.join('; ')}.`];
  lines.push(`Open goals (${open.length}; * = moved since previous heartbeat). Use the goals tool for detail and notes.`);
  const orphans: Goal[] = [], heldGoals: Goal[] = [];
  for (const goal of open) {
    const moved = previous && previous.goals[goal.id] !== goal.updatedAt ? '*' : ' ';
    const assigned = workers.filter(worker => worker.goalId === goal.id), held = heldFor(goal.id);
    if (!assigned.length && !held.length) orphans.push(goal);
    if (held.length) heldGoals.push(goal);
    const parts = [...(assigned.length ? [`workers: ${assigned.map(workerLabel).join(', ')}`] : []), ...(held.length ? [heldLabel(held)] : []), ...(!assigned.length && !held.length ? ['⚠ no worker and no held trigger'] : [])];
    lines.push(`${moved}${short(goal.id)} P${goal.priority} moved ${ago(now - goal.updatedAt)} ago — ${clip(goal.title, TITLE_CHARS)} | ${parts.join(' | ')}`);
  }
  if (heldGoals.length) lines.push(`Goals waiting on a trigger you hold (${heldGoals.length}; wake list has each handoff): ${heldGoals.map(goal => short(goal.id)).join(', ')}.`);
  if (orphans.length) lines.push(`⚠ Goals with no worker and no held trigger (${orphans.length}): nothing will move them. Launch a worker, hold a trigger with its handoff, or close them: ${orphans.map(goal => `${short(goal.id)} ${clip(goal.title, 50)}`).join('; ')}.`);
  const waitingWorkers = workers.filter(worker => waitingLine(worker, wakes, now));
  if (waitingWorkers.length) lines.push(`⚠ Workers still waiting (${waitingWorkers.length}): a long wait should be a held trigger; peek them, then message or archive.`);
  const goalIds = new Set(open.map(goal => goal.id));
  const loose = workers.filter(worker => !worker.goalId || !goalIds.has(worker.goalId));
  if (loose.length) lines.push(`Unarchived workers outside open goals: ${loose.map(worker => `${clip(worker.name, 40)} (${workerLabel(worker)})`).join('; ')}`);
  const top = usage.spend.byAgent.slice(0, 3).map(entry => `${short(entry.agentId)} $${entry.lastDayUsd.toFixed(0)}`).join(', ');
  lines.push(`Spend: last hour $${usage.spend.lastHourUsd.toFixed(1)}, last day $${usage.spend.lastDayUsd.toFixed(1)}${top ? ` (top: ${top})` : ''}.`);
  lines.push(...usageLines(usage.plans));
  const first = latency.intervals.admitToFirstToken;
  lines.push(`Latency (${latency.count} human messages, 24h): admit→first token p50 ${seconds(first.p50)}, p90 ${seconds(first.p90)}, max ${seconds(first.max)}.`);
  const fresh = errors.slice(0, HEARTBEAT_ERROR_LIMIT);
  if (fresh.length) {
    lines.push(`New errors since previous heartbeat (${errors.length >= HEARTBEAT_ERROR_LIMIT ? `${HEARTBEAT_ERROR_LIMIT}+` : errors.length}):`);
    for (const error of fresh) lines.push(`- ${clock(error.at)} ${error.scope}: ${clip(error.message, ERROR_CHARS)}`);
  } else lines.push('No new errors since previous heartbeat.');
  if (droppedWakes.length) lines.push(`Wakes dropped since previous heartbeat: ${droppedWakes.map(wake => `${short(wake.id)} of ${short(wake.agentId)} (${wake.status === 'dropped' ? wake.reason : wake.status}): ${clip(wake.message, 80)}`).join('; ')}`);
  lines.push(...alertLines(hostAlerts, now));
  lines.push('</status>');
  return { text: lines.join('\n'), state: heartbeatState({ goals, agents, errors, hostAlerts, checklist }, previous, now) };
}

/** What a heartbeat compares: the cheap reads, without usage or latency. */
export interface HeartbeatSnapshot { goals: Goal[]; agents: AgentInfo[]; errors: LoggedError[]; hostAlerts: HostAlerts; checklist: string | null }

const openWorkers = (agents: AgentInfo[]) => agents.filter(agent => agent.role === 'worker' && !agent.archived);
const alertKeys = (host: HostAlerts): string[] => host.kind === 'unconfigured' ? []
  : host.kind === 'unreadable' ? [`unreadable: ${host.message}`]
  : host.alerts.map(alert => `${alert.name}: ${alert.title}`);

export function heartbeatState(snapshot: HeartbeatSnapshot, previous: HeartbeatState | null, now: number): HeartbeatState {
  return {
    at: now,
    checkedAt: now,
    errorId: Math.max(previous?.errorId ?? 0, ...snapshot.errors.map(error => error.id)),
    goals: Object.fromEntries(snapshot.goals.filter(goal => goal.status === 'open').map(goal => [goal.id, goal.updatedAt])),
    workers: Object.fromEntries(openWorkers(snapshot.agents).map(worker => [worker.id, worker.state])),
    alerts: alertKeys(snapshot.hostAlerts),
    checklist: snapshot.checklist,
  };
}

const sameMap = (a: Record<string, unknown>, b: Record<string, unknown>) => {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && a[key] === b[key]);
};
const NOTHING: Pick<HeartbeatState, 'goals' | 'workers' | 'alerts' | 'checklist'> = { goals: {}, workers: {}, alerts: [], checklist: null };

/** Reasons to wake the manager, compared with the last delivered heartbeat; none means skip. Pending wakes are no reason: each fires itself. */
export function decideHeartbeat(snapshot: HeartbeatSnapshot & { droppedWakes: Wake[] }, previous: HeartbeatState | null, now: number): string[] {
  const current = heartbeatState(snapshot, previous, now);
  const base = previous ?? NOTHING;
  const reasons: string[] = [];
  if (!sameMap(current.goals, base.goals)) reasons.push('goals moved');
  if (!sameMap(current.workers, base.workers)) reasons.push('workers changed');
  if (snapshot.errors.length) reasons.push('new errors');
  if (snapshot.droppedWakes.length) reasons.push('wakes dropped');
  if (current.alerts.join('\n') !== base.alerts.join('\n')) reasons.push('host alerts changed');
  if (current.checklist !== base.checklist) reasons.push(current.checklist === null ? 'HEARTBEAT.md removed' : 'HEARTBEAT.md changed');
  const kept = current.checklist !== null || Object.keys(current.goals).length > 0 || Object.keys(current.workers).length > 0;
  if (!reasons.length && previous && kept && now - previous.at >= HEARTBEAT_FLOOR_MS) reasons.push(`nothing moved for ${ago(now - previous.at)}; checklist and in-flight review`);
  return reasons;
}

/** `quiet`: nothing moved since the last delivered heartbeat and no floor is due, so only the check time is recorded. */
export type Heartbeat = { kind: 'due'; text: string; state: HeartbeatState } | { kind: 'quiet'; state: HeartbeatState };
export async function heartbeatText(deps: Deps, person: PersonConfig, managerId: string): Promise<Heartbeat> {
  const kept = person.heartbeatFile ? await readFile(person.heartbeatFile, 'utf8').then(text => text.trim() ? text : null, () => null) : null;
  const checklist = kept === null ? null : createHash('sha256').update(kept).digest('hex');
  const previous = await deps.store.getHeartbeat(managerId);
  const [goals, agents, errors, hostAlerts, settled] = await Promise.all([
    deps.store.listGoals(person.id, 'open'), deps.store.listAgents(person.id),
    deps.store.errorsAfter(person.id, previous?.errorId ?? 0, HEARTBEAT_ERROR_LIMIT),
    readHostAlerts(person.alertDir), deps.store.settledWakes(person.id, previous?.at ?? 0, 50),
  ]);
  const droppedWakes = settled.filter(wake => wake.status === 'dropped');
  const now = deps.now();
  const snapshot = { goals, agents, errors, hostAlerts, checklist };
  const reasons = decideHeartbeat({ ...snapshot, droppedWakes }, previous, now);
  if (!reasons.length) return { kind: 'quiet', state: previous ? { ...previous, checkedAt: now } : heartbeatState(snapshot, null, now) };
  const [usage, latency, wakes] = await Promise.all([usageReport(deps, person.id), deps.store.latencyReport(86400000), deps.store.pendingWakes(person.id)]);
  const status = renderStatus({ goals, agents, usage, latency, errors, hostAlerts, wakes, droppedWakes, previous, reasons, checklist, now });
  return { kind: 'due', text: `${kept ?? DEFAULT_INSTRUCTIONS}\n\n${status.text}`, state: status.state };
}
