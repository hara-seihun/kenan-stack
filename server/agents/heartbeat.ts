import { workerProgress } from '../../shared/worker-progress.js';
import { liveMeetingAgentIds } from './live-meeting-agents.js';
import { describeLiveCall, liveCalls } from '../extensions/phone.js';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentInfo, Goal, LatencyReport, PoolProjection, UsageReport } from '../../shared/contract.js';
import type { AlertShown, Deps, HeartbeatState, LoggedError, Wake } from '../types.js';
import { dispatcherOf } from './dispatch.js';
import { describeTrigger } from './wakes.js';
import type { PersonConfig } from '../config.js';
import { usageReport } from '../metrics/usage.js';
import { workerDescendants } from '../../shared/swarm.js';

const DEFAULT_INSTRUCTIONS = 'Review your goals, workers, usage and recent errors; act where needed.';
/** With nothing moved, a manager keeping a checklist or work in flight still hears from its heartbeat this often. */
export const HEARTBEAT_FLOOR_MS = 4 * 3600_000;
const TITLE_CHARS = 90;
const ERROR_CHARS = 300;
export const HEARTBEAT_ERROR_LIMIT = 10;
/** The whole HEARTBEAT.md at least this often (and after a compaction); in between, only its changed lines. */
export const HEARTBEAT_FULL_MS = 12 * 3600_000;
/**
 * Unchanged HEARTBEAT.md was most of a heartbeat (~4.6k characters, ~15 times a day on Beta, 2026-10-23). With the previous
 * heartbeat still in context it carries nothing; after a compaction (shownFullAt null) or HEARTBEAT_FULL_MS it is resent.
 */
export const listsInFull = (previous: HeartbeatState | null, now: number) =>
  !previous || previous.shownFullAt === null || now - previous.shownFullAt >= HEARTBEAT_FULL_MS;

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
const poolProjection = (projection: PoolProjection) => projection.state === 'stale' ? `, drain unknown: no fresh reading since ${clock(projection.latestReadingAt)}`
  : projection.state === 'unmeasured' ? ', drain not measured yet'
  : `${rate(projection.drainPercentPerHour)}${projection.exhaustionAt ? `, out ${clock(projection.exhaustionAt)}` : ''}${projection.unknownDrain.length ? ` (uncertain: no current drain for ${projection.unknownDrain.join(', ')})` : ''}`;

/** One line per provider, read off its binding limit: pool share left, drain and when it runs out, its lowest account and the next reset. */
export function usageLines(plans: UsageReport['plans']): string[] {
  const providers = [...new Set(plans.filter(plan => plan.percentLeft !== null).map(plan => plan.provider))];
  if (!providers.length) return ['Usage: no plan readings.'];
  return providers.map(provider => {
    const own = plans.filter(plan => plan.provider === provider && plan.percentLeft !== null);
    const plan = own.find(each => each.binding) ?? own.reduce((low, each) => each.percentLeft! < low.percentLeft! ? each : low);
    const lowest = plan.accounts.filter(account => account.percentLeft !== null).sort((x, y) => x.percentLeft! - y.percentLeft!)[0];
    const resets = plan.accounts.flatMap(account => account.resetAt ? [account.resetAt] : []);
    return `Usage ${provider} ${plan.metric}: ${percent(plan.percentLeft!)} left${poolProjection(plan.projection)}${lowest ? `; lowest ${lowest.accountId} ${percent(lowest.percentLeft!)}` : ''}${resets.length ? `; next reset ${clock(Math.min(...resets))}` : ''}.`;
  });
}

/** `severity`: the rank of the file's "Severity low|medium|high|critical" line, 0 when it names none. */
export interface HostAlert { name: string; title: string; severity: number }
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
      const text = await readFile(path, 'utf8');
      const first = text.split('\n').map(line => line.replace(/^#+\s*/, '').trim()).find(Boolean);
      return { name, title: first ?? '(empty file)', severity: severityOf(text) };
    }));
    return { kind: 'read', dir, alerts };
  } catch (error) {
    return { kind: 'unreadable', dir, message: error instanceof Error ? error.message : String(error) };
  }
}

const SEVERITIES = ['low', 'medium', 'high', 'critical'];
const severityOf = (text: string) => { const m = /\bseverity:?\s+(low|medium|high|critical)\b/i.exec(text); return m ? SEVERITIES.indexOf(m[1]!.toLowerCase()) + 1 : 0; };
/** An alert listed in full is only counted afterwards until this long has passed, unless it gets worse (2026-11-02: the
 * same "root disk at 81.6%" was relisted every heartbeat). */
export const ALERT_REPEAT_MS = 4 * 3600_000;
const firstPercent = (title: string) => { const m = /(\d+(?:\.\d+)?)\s*%/.exec(title); return m ? Number(m[1]) : null; };
/** Worse than when last listed: a higher severity, or the title's first percentage up by a point or more. */
export function alertWorse(shown: AlertShown, alert: HostAlert): boolean {
  if (alert.severity > shown.severity) return true;
  const was = firstPercent(shown.title), is = firstPercent(alert.title);
  return was !== null && is !== null && is >= was + 1;
}

/** Alerts new since the last delivered heartbeat, worse, or last listed ALERT_REPEAT_MS ago are listed; the rest are one count line. */
export function alertLines(host: HostAlerts, shown: Readonly<Record<string, AlertShown>>, now: number): { lines: string[]; shown: Record<string, AlertShown> } {
  switch (host.kind) {
    case 'unconfigured': return { lines: [], shown: {} };
    case 'unreadable': return { lines: [`Host alerts unreadable (${host.dir}): ${clip(host.message, ERROR_CHARS)}`], shown: { ...shown } };
    case 'read': {
      if (!host.alerts.length) return { lines: [`No open host alerts (${host.dir}).`], shown: {} };
      const next: Record<string, AlertShown> = {}, listed: string[] = [], quiet: string[] = [];
      for (const alert of host.alerts) {
        const before = shown[alert.name];
        const why = !before ? 'new' : alertWorse(before, alert) ? `worse; was: ${clip(before.title, 60)}` : now - before.at >= ALERT_REPEAT_MS ? `open ${ago(now - before.at)}+` : null;
        if (why === null) { next[alert.name] = before!; quiet.push(alert.name.replace(/\.md$/, '')); continue; }
        next[alert.name] = { title: alert.title, severity: alert.severity, at: now };
        listed.push(`- ${alert.name} (${why}): ${clip(alert.title, TITLE_CHARS)}`);
      }
      const lines = listed.length ? [`Host alerts in ${host.dir} (${listed.length} new, worse or open ${ALERT_REPEAT_MS / 3600_000}h since listed); read the file, fix the cause, and the producer removes it:`, ...listed] : [];
      if (quiet.length) lines.push(`${listed.length ? 'Also open' : `Open host alerts in ${host.dir}`}, unchanged since listed (${quiet.length}): ${quiet.join(', ')}.`);
      return { lines, shown: next };
    }
  }
}

/** kenan-threads' view of outside threads (threads.json): who we wait on and who waits on us, one line each, oldest first. */
export type Threads =
  | { kind: 'unconfigured' }
  | { kind: 'read'; path: string; generatedAt: number; waitingOnThem: string[]; waitingOnUs: string[]; errors: string[] }
  | { kind: 'unreadable'; path: string; message: string };

const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string');

export async function readThreads(path: string | undefined): Promise<Threads> {
  if (path === undefined) return { kind: 'unconfigured' };
  try {
    const raw = JSON.parse(await readFile(path, 'utf8')) as { generatedAtMs?: unknown; errors?: unknown; heartbeat?: { waitingOnThem?: unknown; waitingOnUs?: unknown } };
    const them = raw.heartbeat?.waitingOnThem, us = raw.heartbeat?.waitingOnUs;
    if (typeof raw.generatedAtMs !== 'number' || !strings(them) || !strings(us) || !strings(raw.errors)) throw new Error('needs generatedAtMs, errors and heartbeat.waitingOnThem/waitingOnUs string lists');
    return { kind: 'read', path, generatedAt: raw.generatedAtMs, waitingOnThem: them, waitingOnUs: us, errors: raw.errors };
  } catch (error) {
    return { kind: 'unreadable', path, message: error instanceof Error ? error.message : String(error) };
  }
}

export const THREADS_LIMIT = 8;
/** kenan-threads refreshes every 10 minutes and after each send; older than this, its timer has stopped. */
export const THREADS_STALE_MS = 30 * 60_000;

/** "Waiting on others": threads where we wrote last more than two business days ago, and threads where they wrote last. */
export function threadLines(threads: Threads, now: number): string[] {
  switch (threads.kind) {
    case 'unconfigured': return [];
    case 'unreadable': return [`⚠ Outside threads unreadable (${threads.path}): ${clip(threads.message, ERROR_CHARS)}. Run kenan-threads refresh and fix what it reports.`];
    case 'read': {
      const view = threads.path.replace(/\.json$/, '.md');
      const lines = [`Waiting on others (${view}, generated ${ago(now - threads.generatedAt)} ago; kenan-threads show NAME for one):`];
      if (now - threads.generatedAt > THREADS_STALE_MS) lines.push(`⚠ The threads view is stale: check kenan-threads.timer and run kenan-threads refresh.`);
      if (threads.errors.length) lines.push(`⚠ Sources that failed in its last run: ${clip(threads.errors.join('; '), ERROR_CHARS)}`);
      const list = (title: string, items: string[]) => items.length ? [`${title} (${items.length}):`, ...listed(items, THREADS_LIMIT, item => clip(item, 200))] : [];
      lines.push(...list('We wrote last, no answer in over 2 business days; chase, set a wake or mark settled', threads.waitingOnThem));
      lines.push(...list('They wrote last; reply, act, or mark settled', threads.waitingOnUs));
      if (!threads.waitingOnThem.length && !threads.waitingOnUs.length) lines.push('- nothing overdue either way.');
      return lines;
    }
  }
}

export interface StatusInput {
  /** The manager this heartbeat is for: only its own workers are listed; deeper agents (swarm sub-agents, children of
   * area managers) report to their own parent and appear only as counts. */
  managerId: string;
  goals: Goal[];
  agents: AgentInfo[];
  usage: UsageReport;
  latency: LatencyReport;
  errors: LoggedError[];
  hostAlerts: HostAlerts;
  threads: Threads;
  /** Pending wakes, and wakes dropped since the previous heartbeat. */
  wakes: Wake[];
  droppedWakes: Wake[];
  previous: HeartbeatState | null;
  /** Why this heartbeat was delivered (decideHeartbeat). */
  reasons: string[];
  checklist: string | null;
  /** Live phone calls, one line each with the line's state and when it last had audio. */
  calls: string[];
  /** Agents answering in a meeting that is still live: idle with no report or wake by design, never stuck. */
  liveMeetingAgents?: readonly string[];
  /** HEARTBEAT.md was sent whole with this status (listsInFull). */
  full: boolean;
  now: number;
}

/** A worker idle on its own wakes longer than this should have handed off; shorter waits are normal and only counted. */
export const WAIT_WARN_MS = 30 * 60_000;
const MOVED_LIMIT = 15;
const ORPHAN_LIMIT = 10;
const STUCK_LIMIT = 10;

const live = (agent: AgentInfo) => !agent.archived && agent.state !== 'stopped';
const listed = <T>(items: T[], limit: number, line: (item: T) => string) =>
  [...items.slice(0, limit).map(item => `- ${line(item)}`), ...(items.length > limit ? [`- … and ${items.length - limit} more`] : [])];

/**
 * Only what needs a decision, sized for a manager with ~20 leads each running a swarm: why it fired, errors and alerts,
 * the manager's own workers that are stuck, goals with no next move, goals that moved (one line, worker counts), usage.
 * Everything else is a count; detail is one goals/workers tool call away.
 */
export function renderStatus(input: StatusInput): { text: string; state: HeartbeatState } {
  const { managerId, goals, agents, usage, latency, errors, hostAlerts, threads, wakes, droppedWakes, previous, reasons, checklist, calls, full, now } = input;
  const inMeeting = new Set(input.liveMeetingAgents ?? []);
  const open = goals.filter(goal => goal.status === 'open').sort((a, b) => a.priority - b.priority || b.updatedAt - a.updatedAt);
  const mine = ownWorkers(agents, managerId);
  const descendants = workerDescendants(agents);
  const below = (id: string): AgentInfo[] => (descendants.get(id) ?? []).filter(live);
  const pending = wakes.filter(wake => wake.status === 'pending');
  const ownWakes = (id: string) => pending.filter(wake => wake.agentId === id && !wake.held);
  const heldGoals = new Set(pending.flatMap(wake => wake.held ? [wake.held.goalId] : []));
  const working = agents.filter(agent => agent.role === 'worker' && live(agent));

  const lines = [`<status at="${clock(now)}" previous="${previous ? clock(previous.at) : 'none'}">`, `Why now: ${reasons.join('; ')}.`];

  const fresh = errors.slice(0, HEARTBEAT_ERROR_LIMIT);
  if (fresh.length) {
    lines.push(`New errors (${errors.length >= HEARTBEAT_ERROR_LIMIT ? `${HEARTBEAT_ERROR_LIMIT}+` : errors.length}):`);
    for (const error of fresh) lines.push(`- ${clock(error.at)} ${error.scope}: ${clip(error.message, ERROR_CHARS)}`);
  }
  if (droppedWakes.length) lines.push(`Wakes dropped (${droppedWakes.length}): ${droppedWakes.slice(0, 5).map(wake => `${short(wake.id)} of ${short(wake.agentId)} (${wake.status === 'dropped' ? wake.reason : wake.status})`).join('; ')}${droppedWakes.length > 5 ? ' …' : ''}`);
  const alerts = alertLines(hostAlerts, previous?.alertsShown ?? {}, now);
  lines.push(...alerts.lines);
  if (calls.length) lines.push(`Live phone calls (${calls.length}; on a menu or on hold is healthy while audio is recent):`, ...calls.map(call => `- ${call}`));

  const stuck = mine.flatMap(worker => {
    const own = ownWakes(worker.id);
    if (worker.state === 'error' || worker.state === 'interrupted') return [{ worker, why: worker.state }];
    if (worker.state !== 'idle' || worker.lastReport || inMeeting.has(worker.id) || workerProgress(worker, agents)) return [];
    if (!own.length) return [{ worker, why: 'idle, no report, no wake' }];
    const since = Math.min(...own.map(wake => wake.createdAt));
    return now - since >= WAIT_WARN_MS ? [{ worker, why: `waiting ${ago(now - since)} ${clip(describeTrigger(own[0]!), 80)}` }] : [];
  });
  const running = mine.filter(worker => worker.state === 'running').length;
  const progressing = mine.map(worker => workerProgress(worker, agents)).filter(value => value !== null);
  const coordinating = progressing.filter(value => value.kind === 'coordinating').length;
  const jobs = progressing.filter(value => value.kind === 'job').length;
  const swarm = mine.reduce((sum, worker) => sum + below(worker.id).length, 0);
  lines.push(`Your workers: ${mine.length} (${running} running, ${coordinating} coordinating, ${jobs} running jobs, ${mine.length - running - coordinating - jobs} idle or stopped)${swarm ? `; ${swarm} agent${swarm > 1 ? "s" : ""} under them` : ''}.${stuck.length ? ` ⚠ Stuck (${stuck.length}): peek, then message, hand off or archive:` : ''}`);
  lines.push(...listed(stuck, STUCK_LIMIT, ({ worker, why }) => `${short(worker.id)} ${clip(worker.name, 50)}: ${why}`));

  const orphans = open.filter(goal => !heldGoals.has(goal.id) && !working.some(worker => worker.goalId === goal.id));
  const moved = previous ? open.filter(goal => previous.goals[goal.id] !== goal.updatedAt) : [];
  const movedOnly = moved.filter(goal => !orphans.includes(goal));
  lines.push(`Open goals: ${open.length}; ${heldGoals.size} waiting on a trigger you hold; ${moved.length} moved since the previous heartbeat. Use goals list/get for the rest.`);
  if (orphans.length) lines.push(`⚠ No worker and no held trigger (${orphans.length}): launch, hold a trigger or close:`, ...listed(orphans, ORPHAN_LIMIT, goal => `${short(goal.id)} [${goal.category}] ${clip(goal.title, 70)}`));
  if (movedOnly.length) {
    lines.push('Moved:');
    lines.push(...listed(movedOnly, MOVED_LIMIT, goal => {
      const on = working.filter(worker => worker.goalId === goal.id);
      const by = previous && !(goal.id in previous.goals) ? dispatcherOf(goal) : null;
      const fresh = previous && !(goal.id in previous.goals) ? `new${by ? `, dispatched by ${clip(by.name, 40)}` : ''}; ` : '';
      return `${short(goal.id)} [${goal.category}] ${clip(goal.title, 70)} (${fresh}${on.length ? `${on.length} worker${on.length > 1 ? 's' : ''}` : heldGoals.has(goal.id) ? 'held trigger' : 'no worker'})`;
    }));
  }
  const goalIds = new Set(open.map(goal => goal.id));
  const loose = mine.filter(worker => !worker.goalId || !goalIds.has(worker.goalId));
  lines.push(...threadLines(threads, now));
  if (loose.length) lines.push(`Your workers outside open goals (${loose.length}): ${loose.slice(0, 5).map(worker => `${short(worker.id)} ${clip(worker.name, 40)}`).join('; ')}${loose.length > 5 ? ' …' : ''}`);

  lines.push(...usageLines(usage.plans));
  const first = latency.intervals.admitToFirstToken;
  lines.push(`${'unavailable' in usage.planCosts ? '' : `Plans cost $${usage.planCosts.dailyUsd.toFixed(0)}/day ($${usage.planCosts.monthlyUsd.toFixed(0)}/month). `}Calls at API list prices (not what we pay): $${usage.spend.lastHourUsd.toFixed(1)}/h, $${usage.spend.lastDayUsd.toFixed(0)}/day. Reply latency p50 ${seconds(first.p50)}, p90 ${seconds(first.p90)} (${latency.count} messages, 24h).`);
  lines.push('</status>');
  return { text: lines.join('\n'), state: { ...heartbeatState({ managerId, goals, agents, errors, hostAlerts, checklist, wakes }, previous, now), shownFullAt: full ? now : previous?.shownFullAt ?? null, alertsShown: alerts.shown } };
}

/** What a heartbeat compares: the cheap reads, without usage or latency. `wakes` are the person's pending wakes. */
export interface HeartbeatSnapshot { managerId: string; goals: Goal[]; agents: AgentInfo[]; errors: LoggedError[]; hostAlerts: HostAlerts; checklist: string | null; wakes: Wake[];
  /** Agents answering in a live meeting: idle with no report or wake by design (live-meeting-agents.ts). */
  liveMeetingAgents?: readonly string[] }

/** The manager's own workers; everything deeper reports to its own parent. */
const ownWorkers = (agents: AgentInfo[], managerId: string) => agents.filter(agent => agent.role === 'worker' && !agent.archived && agent.parentAgentId === managerId);
const alertKeys = (host: HostAlerts): string[] => host.kind === 'unconfigured' ? []
  : host.kind === 'unreadable' ? [`unreadable: ${host.message}`]
  : host.alerts.map(alert => alert.name);

export function heartbeatState(snapshot: HeartbeatSnapshot, previous: HeartbeatState | null, now: number): HeartbeatState {
  return {
    at: now,
    checkedAt: now,
    errorId: Math.max(previous?.errorId ?? 0, ...snapshot.errors.map(error => error.id)),
    goals: Object.fromEntries(snapshot.goals.filter(goal => goal.status === 'open').map(goal => [goal.id, goal.updatedAt])),
    workers: Object.fromEntries(ownWorkers(snapshot.agents, snapshot.managerId).map(worker => [worker.id, worker.state])),
    alerts: alertKeys(snapshot.hostAlerts),
    checklist: snapshot.checklist,
    shownFullAt: previous?.shownFullAt ?? null,
    alertsShown: previous?.alertsShown ?? {},
  };
}

const NOTHING: Pick<HeartbeatState, 'goals' | 'workers' | 'alerts' | 'checklist'> = { goals: {}, workers: {}, alerts: [], checklist: null };
const ATTENTION: ReadonlySet<AgentInfo['state']> = new Set(['error', 'interrupted', 'stopped']);

/** A worker nothing will move: idle with no report and no pending wake of its own. */
const stalled = (worker: AgentInfo, wakes: Wake[]) => worker.state === 'idle' && !worker.lastReport && !wakes.some(wake => wake.agentId === worker.id && wake.status === 'pending');

/**
 * Reasons to wake the manager, compared with the last delivered heartbeat; none means skip.
 * Only what reaches the manager no other way counts: the manager already hears every report, note, peer message and
 * fired wake, and moves goals and spawns workers itself, so goal edits and running/idle flips are no reason.
 * A worker counts when it newly errors, is interrupted or stopped, or stalls; an alert counts when a new file appears.
 */
export function decideHeartbeat(snapshot: HeartbeatSnapshot & { droppedWakes: Wake[] }, previous: HeartbeatState | null, now: number): string[] {
  const current = heartbeatState(snapshot, previous, now);
  const base = previous ?? NOTHING;
  const reasons: string[] = [];
  const workers = ownWorkers(snapshot.agents, snapshot.managerId);
  const troubled = workers.filter(worker => ATTENTION.has(worker.state) && base.workers[worker.id] !== worker.state);
  const inMeeting = new Set(snapshot.liveMeetingAgents ?? []);
  const newlyStalled = workers.filter(worker => !inMeeting.has(worker.id) && !workerProgress(worker, snapshot.agents) && stalled(worker, snapshot.wakes) && base.workers[worker.id] !== 'idle');
  if (troubled.length) reasons.push(`workers ${troubled.map(worker => `${short(worker.id)} ${worker.state}`).join(', ')}`);
  if (newlyStalled.length) reasons.push(`workers idle with no report and no wake: ${newlyStalled.map(worker => short(worker.id)).join(', ')}`);
  if (snapshot.errors.length) reasons.push('new errors');
  if (snapshot.droppedWakes.length) reasons.push('wakes dropped');
  const fresh = current.alerts.filter(alert => !base.alerts.includes(alert));
  if (fresh.length) reasons.push(`new host alerts: ${fresh.join(', ')}`);
  if (current.checklist !== base.checklist) reasons.push(current.checklist === null ? 'HEARTBEAT.md removed' : 'HEARTBEAT.md changed');
  const kept = current.checklist !== null || Object.keys(current.goals).length > 0 || Object.keys(current.workers).length > 0;
  if (!reasons.length && previous && kept && now - previous.at >= HEARTBEAT_FLOOR_MS) reasons.push(`nothing new for ${ago(now - previous.at)}; checklist and in-flight review`);
  return reasons;
}

/**
 * The person's HEARTBEAT.md as the manager needs it: whole on a full listing or when nothing earlier can be compared
 * (no previous text, or a digest stored by an older build); otherwise only its changed lines, or one line when unchanged.
 */
export function checklistText(path: string, kept: string | null, previous: HeartbeatState | null, full: boolean): string {
  if (kept === null) return DEFAULT_INSTRUCTIONS;
  const before = previous?.checklist;
  if (full || before == null || /^[0-9a-f]{64}$/.test(before) || previous?.shownFullAt == null) return kept;
  const since = clock(previous.shownFullAt);
  if (before === kept) return `${path} is unchanged since it was shown in full at ${since}; follow it as given there.`;
  const lines = (text: string) => text.split('\n').map(line => line.trimEnd()).filter(line => line.trim());
  const old = new Set(lines(before)), now = new Set(lines(kept));
  const added = [...now].filter(line => !old.has(line)), removed = [...old].filter(line => !now.has(line));
  return [`${path} changed since the previous heartbeat (shown in full at ${since}); everything else in it is as given there.`,
    ...(added.length ? ['Lines added or reworded:', ...added] : []), ...(removed.length ? ['Lines removed or replaced:', ...removed] : [])].join('\n');
}

/** `quiet`: nothing moved since the last delivered heartbeat and no floor is due, so only the check time is recorded. */
export type Heartbeat = { kind: 'due'; text: string; state: HeartbeatState } | { kind: 'quiet'; state: HeartbeatState };
export async function heartbeatText(deps: Deps, person: PersonConfig, managerId: string): Promise<Heartbeat> {
  const kept = person.heartbeatFile ? await readFile(person.heartbeatFile, 'utf8').then(text => text.trim() ? text : null, () => null) : null;
  const checklist = kept;
  const previous = await deps.store.getHeartbeat(managerId);
  const [goals, agents, errors, hostAlerts, settled, wakes, liveMeetingAgents] = await Promise.all([
    deps.store.listGoals(person.id, 'open'), deps.store.listAgents(person.id),
    deps.store.errorsAfter(person.id, previous?.errorId ?? 0, HEARTBEAT_ERROR_LIMIT),
    readHostAlerts(person.alertDir), deps.store.settledWakes(person.id, previous?.at ?? 0, 50), deps.store.pendingWakes(person.id), liveMeetingAgentIds(),
  ]);
  const droppedWakes = settled.filter(wake => wake.status === 'dropped');
  const now = deps.now();
  const snapshot = { managerId, goals, agents, errors, hostAlerts, checklist, wakes, liveMeetingAgents };
  const reasons = decideHeartbeat({ ...snapshot, droppedWakes }, previous, now);
  if (!reasons.length) return { kind: 'quiet', state: previous ? { ...previous, checkedAt: now } : heartbeatState(snapshot, null, now) };
  const [usage, latency, calls, threads] = await Promise.all([usageReport(deps, person.id), deps.store.latencyReport(86400000), liveCalls(person.id, now).then(live => live.map(describeLiveCall), (e: unknown) => [`(live calls unreadable: ${String(e)})`]), readThreads(person.threadsFile)]);
  const full = listsInFull(previous, now);
  const status = renderStatus({ managerId, goals, agents, usage, latency, errors, hostAlerts, threads, wakes, droppedWakes, previous, reasons, checklist, calls, liveMeetingAgents, full, now });
  const instructions = checklistText(person.heartbeatFile ?? 'HEARTBEAT.md', kept, previous, full);
  return { kind: 'due', text: `${instructions}\n\n${status.text}`, state: status.state };
}
