import { watch as fsWatch, type FSWatcher } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import type { AgentInfo } from '../../shared/contract.js';
import type { Deps, Wake } from '../types.js';
import { describeTrigger } from './wakes.js';
import { execFileText as run } from '../spawner.js';

/** A job an agent started that has not ended: its completion event is `topic`. */
export type RunningJob = { kind: 'kenan-bg' | 'gpurun'; name: string; topic: string };
export type JobCensus = (agentId: string) => Promise<RunningJob[]>;

const GPURUN_ENDED = new Set(['done', 'failed', 'cancelled']);

/** The agent's unfinished kenan-bg units (system units kenan-bg-AGENT-NAME) and gpurun jobs (spec owner, state phase). */
/** The servers run as root, so the jobs directory is the operator account's, named outright (a home-relative path made every census empty). */
export const GPURUN_JOBS_ROOT = '/home/kenan/data/gpurun/jobs';
/** Where systemd keeps the definition of each loaded transient unit; kenan-bg units are collected (and this file removed) when they end. */
export const TRANSIENT_UNITS_ROOT = '/run/systemd/transient';
type Exec = (file: string, args: string[], options: { timeout: number }) => Promise<{ stdout: string }>;
/** Why a systemctl call failed, with what it printed: `Command failed` alone (2026-11-06) hid a 10 s kill behind an empty message. */
const describeFailure = (e: unknown): string => {
  const error = e as { code?: unknown; signal?: unknown; killed?: unknown; stderr?: unknown; message?: unknown };
  const stderr = typeof error.stderr === 'string' ? error.stderr.trim().slice(0, 300) : '';
  return [error.killed ? 'timed out (killed after 10 s)' : error.signal ? `signal ${String(error.signal)}` : `exit ${String(error.code ?? 'unknown')}`, stderr || (error.killed ? '' : String(error.message ?? '').split('\n')[0])].filter(Boolean).join(': ');
};
/**
 * This host's kenan-bg units for one agent, as `systemctl list-units --plain --no-legend` lines. Bounded, so a slow systemd
 * can't hold a report or turn end. On 2026-11-06 a daemon-reload storm (each reload ~4 s, serialized) kept PID 1 from
 * answering for over 10 s; the kill failed four implicit reports. So a failed call is tried once more, and if systemd still
 * doesn't answer, the loaded kenan-bg units are read from systemd's transient-unit directory (a unit there is loaded, so not
 * yet collected: counted as running, which errs toward keeping the run). Only if both fail does it throw.
 */
export async function listBgUnits(agentId: string, exec: Exec = run, transientRoot = TRANSIENT_UNITS_ROOT): Promise<string> {
  const args = ['--system', 'list-units', `kenan-bg-${agentId}-*`, '--all', '--plain', '--no-legend'];
  const failures: string[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    try { return (await exec('/usr/bin/systemctl', args, { timeout: 10_000 })).stdout; }
    catch (e) { failures.push(describeFailure(e)); }
  }
  const prefix = `kenan-bg-${agentId}-`;
  try {
    const names = await readdir(transientRoot);
    console.error(JSON.stringify({ type: 'kenan_bg_census_fallback', agentId, systemctl: failures }));
    return names.filter(name => name.startsWith(prefix) && name.endsWith('.service')).map(name => `${name} loaded active running (transient unit file; systemctl unavailable)`).join('\n');
  } catch (e) {
    throw new Error(`census_unavailable: systemctl list-units failed twice (${failures.join('; ')}) and ${transientRoot} could not be read (${(e as NodeJS.ErrnoException).code ?? String(e)})`);
  }
}
export function hostJobCensus(gpurunJobs: string, listUnits: (agentId: string) => Promise<string> = agentId => listBgUnits(agentId)): JobCensus {
  // Each spec.json is read once per job folder. Reading all 11,000 of them on every report and turn end (2026-10-30) held
  // report calls for minutes once ~200 agents shared the file-system thread pool. A name is not a job, though: resubmitting
  // NAME deletes the folder and writes a new one with a new owner (2026-10-30: cosmos-text-mixed ended for one agent, another
  // reused the name, and the first was refused its done report for the second's job). So the cache forgets a name whenever
  // its entry in the jobs directory is removed or created, and a job is only counted after its spec is read again.
  const owners = new Map<string, string | null>();
  // Bumped on every change to a name (or to everything), so a spec read that started before the change isn't cached after it.
  const changes = new Map<string, number>();
  let epoch = 0;
  const stamp = (name: string) => `${epoch}:${changes.get(name) ?? 0}`;
  const forget = (name?: string) => { if (name === undefined) { epoch++; owners.clear(); } else { changes.set(name, (changes.get(name) ?? 0) + 1); owners.delete(name); } };
  let watcher: FSWatcher | null = null;
  const watch = () => {
    if (watcher) return;
    try {
      watcher = fsWatch(gpurunJobs, { persistent: false }, (_kind, name) => forget(name ? name.toString() : undefined));
      watcher.on('error', () => { watcher?.close(); watcher = null; forget(); });
      forget();   // anything learned before the watch began may be stale
    } catch { /* no watch (inotify limit): every census reads the specs again */ }
  };
  // The spec's owner; null for an entry that is no job (a file beside the folders, a spec without one), undefined while the spec isn't written.
  // A spec being written can be half there: that is "not written yet" too.
  const readOwner = (name: string): Promise<string | null | undefined> => readFile(`${gpurunJobs}/${name}/spec.json`, 'utf8')
    .then(text => { const owner = (JSON.parse(text) as { owner?: unknown }).owner; return typeof owner === 'string' ? owner : null; })
    .catch((e: NodeJS.ErrnoException) => e.code === 'ENOTDIR' ? null : undefined);
  const learn = async (name: string): Promise<string | null | undefined> => {
    const before = stamp(name);
    const owner = await readOwner(name);
    if (owner !== undefined && stamp(name) === before) owners.set(name, owner);
    return owner;
  };
  let learning: Promise<void> = Promise.resolve();
  // One reader at a time, 64 files at once; a job directory whose spec isn't written yet is read again next time.
  const learnOwners = (names: string[]) => learning = learning.then(async () => {
    const unknown = names.filter(name => !owners.has(name));
    for (let i = 0; i < unknown.length; i += 64) await Promise.all(unknown.slice(i, i + 64).map(async name => {
      await learn(name);
    }));
  });
  return async agentId => {
    const jobs = runningBgJobs(await listUnits(agentId), agentId);
    // A host that has never run a gpurun job has no jobs directory: that is no gpurun jobs, not a failure.
    const names = await readdir(gpurunJobs).catch((e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT') return [] as string[]; throw new Error(`gpurun_jobs_unreadable: ${gpurunJobs}: ${e.code ?? e.message}`); });
    if (names.length) watch();
    if (!watcher) forget();   // without a watch nothing cached can be trusted
    await learnOwners(names);
    for (const name of names) {
      if (owners.get(name) !== agentId) continue;
      const state = await readFile(`${gpurunJobs}/${name}/state.json`, 'utf8').then(JSON.parse, () => null) as { phase?: string } | null;
      if (state?.phase === undefined || GPURUN_ENDED.has(state.phase)) continue;
      // An unfinished job is checked against its spec as it is now, so a missed directory event can't pin another agent's job here.
      if (await learn(name) === agentId) jobs.push({ kind: 'gpurun', name, topic: `gpurun:${agentId}:${name}` });
    }
    return jobs;
  };
}

/** States in which a kenan-bg job's wrapper still runs. Once it exits the job has ended and raised its job:AGENT:NAME event
 * (or ExecStopPost raises it now); the unit then sits in deactivating while systemd stops leftover processes, which took
 * 28 s on 2026-10-31, and a worker that had the success event was refused its done report for that job meanwhile. */
const BG_RUNNING = new Set(['active', 'activating', 'reloading']);
/** The agent's running kenan-bg jobs from `systemctl list-units --plain --no-legend` (UNIT LOAD ACTIVE SUB DESCRIPTION). */
export function runningBgJobs(listing: string, agentId: string): RunningJob[] {
  const prefix = `kenan-bg-${agentId}-`;
  return listing.split('\n').flatMap(line => {
    const [unit = '', , active = ''] = line.trim().split(/\s+/);
    if (!unit.startsWith(prefix) || !unit.endsWith('.service') || !BG_RUNNING.has(active)) return [];
    const name = unit.slice(prefix.length, -'.service'.length);
    return [{ kind: 'kenan-bg' as const, name, topic: `job:${agentId}:${name}` }];
  });
}

/** The events that end a job: a gpurun job also raises `gpurun-done:OWNER:NAME` when it ends. */
const terminalTopics = (job: RunningJob): string[] => job.kind === 'gpurun' ? [job.topic, job.topic.replace(/^gpurun:/, 'gpurun-done:')] : [job.topic];
const listensTo = (wake: Wake, topic: string): boolean => wake.event?.source === 'event' && (wake.event.prefix ? topic.startsWith(wake.event.topic) : wake.event.topic === topic);
/** Another live agent (the manager holding a trigger, or the coordinator) waits on the job's end, so it keeps its identity there. */
const handsOff = (wakes: Wake[], agent: AgentInfo, job: RunningJob): boolean =>
  wakes.some(w => (w.held?.workerId === agent.id || (w.agentId !== agent.id && !w.held)) && terminalTopics(job).some(t => listensTo(w, t)));

/** What a worker still owns that a done report would drop: its own pending wakes, and unfinished jobs nobody holds a trigger for (each as a line), with what it can do about them. Null when nothing. */
export type PendingWork = { owned: string[]; how: string };
export async function pendingWork(deps: Deps, agent: AgentInfo, subAgent: boolean, retainJobs = false): Promise<PendingWork | null> {
  const wakes = await deps.store.pendingWakes(agent.ownerId);
  const all = await deps.jobs(agent.id);
  if (retainJobs) await retainJobWakes(deps, agent, wakes, all);
  const handed = all.filter(job => handsOff(wakes, agent, job));
  // Only an explicit held handoff transfers an own wake. A parent's ordinary watch is not a transfer: dropping
  // the worker's own wake here archived e6ae while its production controller was still running (2026-11-02).
  const transferred = all.filter(job => wakes.some(w => w.held?.workerId === agent.id && terminalTopics(job).some(t => listensTo(w, t))));
  const own = wakes.filter(w => w.agentId === agent.id && !w.held && !transferred.some(job => terminalTopics(job).some(t => listensTo(w, t))));
  const jobs = all.filter(job => !handed.includes(job));
  if (!own.length && !jobs.length) return null;
  const lines = [...own.map(w => `wake ${w.id} ${describeTrigger(w)}`), ...jobs.map(job => `${job.kind} job ${job.name} (completion event ${job.topic})`)];
  const how = subAgent
    ? 'If it is a sub-agent job you cannot wait for, hand it to your coordinator: wake schedule on: "event" with topic gpurun-done:YOUR_ID:JOB (for kenan-bg: job:YOUR_ID:NAME), handoff saying what to do when it ends; that wake goes to your coordinator and fires only on that event, after which you may report done. A short wake (up to 30 minutes) keeps you: end your turn without reporting. If the work is no longer needed, cancel it (wake cancel; kenan-bg stop NAME; gpurun cancel NAME) and then report done.'
    : 'If a short wake is the right next step (a wait of up to 30 minutes on a healthy job), do not report: end your turn without reporting and the wake resumes you. For a long wait, hand it to your manager as a held trigger (wake schedule with handoff, which ends this run itself). If the work is no longer needed, cancel it (wake cancel; kenan-bg stop NAME; gpurun cancel NAME) and then report done.';
  return { owned: lines, how: `${how} Report blocked only when you truly cannot proceed.` };
}
/**
 * The same dependencies with a census that cannot fail: a census error becomes no jobs, and `unavailable` holds why. Used where
 * the runtime itself files or confirms a report at the end of a turn, so a busy systemd records "census unavailable" instead
 * of leaving a finished worker unreported (implicit_report_failed, four times on 2026-11-06).
 */
export function tolerantCensus(deps: Deps, agentId: string): { deps: Deps; unavailable: () => string | null } {
  let unavailable: string | null = null;
  const jobs = (id: string) => deps.jobs(id).catch((e: unknown) => {
    unavailable = e instanceof Error ? e.message : String(e);
    console.error(JSON.stringify({ type: 'job_census_unavailable', agentId, error: unavailable }));
    return [] as RunningJob[];
  });
  return { deps: { ...deps, jobs }, unavailable: () => unavailable };
}
export const ownedText = (work: PendingWork): string => `${work.owned.length} thing(s) a done report would drop: ${work.owned.join('; ')}`;
/** The typed refusal of a done report. */
export const pendingWorkError = (work: PendingWork): string => `pending_work: you still own ${ownedText(work)}. ${work.how}`;

/** An empty turn must not lose a background job's successful completion. Automatic watches listen only for
 * job events, not peer messages. One prefix watch per job type carries a burst together instead of creating one
 * wake input per job. Explicit wakes and held handoffs keep their existing behavior. */
export async function retainJobWakes(deps: Deps, agent: AgentInfo, wakes: Wake[], jobs: RunningJob[]): Promise<void> {
  const uncovered = jobs.filter(job => !wakes.some(w => (w.agentId === agent.id || w.held?.workerId === agent.id) && terminalTopics(job).some(t => listensTo(w, t))));
  for (const kind of new Set(uncovered.map(job => job.kind))) {
    const topic = `${kind === 'gpurun' ? 'gpurun' : 'job'}:${agent.id}:`;
    const wake = await deps.store.createWake({ agentId: agent.id, ownerId: agent.ownerId,
      message: `Background ${kind} job events arrived. Read the events to see which jobs ended; other jobs may still be running. Reconcile original results without replaying jobs.`,
      trigger: { at: null, event: { source: 'event', topic, prefix: true }, listen: { kind: 'own' } },
      originConversationId: agent.originConversationId });
    wakes.push(wake);
  }
}

/** Add live job observations to agent reads, not to stored state. All public reads and agent events then agree.
 * Only idle workers with an own-job event wake need a host lookup; ordinary chats never pay for a job census. */
export function observeAgentJobs(census: JobCensus): (agent: AgentInfo) => Promise<AgentInfo> {
  const recent = new Map<string, { at: number; jobs: Promise<RunningJob[]> }>();
  let gpuUnits: { at: number; names: Promise<Set<string>> } | undefined;
  const liveGpuNames = (now: number) => {
    if (!gpuUnits || now - gpuUnits.at >= 2000) gpuUnits = { at: now, names: run('/usr/bin/systemctl', [
      ...(process.getuid?.() === 0 ? ['--machine=kenan@.host'] : []), '--user', 'list-units', 'gpurun@*.service', 'gpurun-submit-*.service', '--all', '--plain', '--no-legend',
    ], { timeout: 10_000 }).then(({ stdout }) => new Set(stdout.split('\n').flatMap(line => {
      const [unit = '', , active = ''] = line.trim().split(/\s+/);
      if (!BG_RUNNING.has(active)) return [];
      const match = /^(?:gpurun@|gpurun-submit-)(.+)\.service$/.exec(unit);
      return match ? [match[1]!] : [];
    }))) };
    return gpuUnits.names;
  };
  return async agent => {
    if (agent.archived || agent.role !== 'worker' || agent.state !== 'idle' || !agent.wakes.some(wake =>
      wake.on === 'event' && wake.event && ['job:', 'gpurun:', 'gpurun-done:'].some(prefix => wake.event!.topic.startsWith(`${prefix}${agent.id}:`)))) return agent;
    const now = Date.now();
    let entry = recent.get(agent.id);
    if (!entry || now - entry.at >= 2000) {
      // Expire old worker identities as well as old observations on this long-lived server.
      for (const [id, value] of recent) if (now - value.at >= 2000) recent.delete(id);
      entry = { at: now, jobs: census(agent.id).then(async jobs => {
        if (!jobs.some(job => job.kind === 'gpurun')) return jobs;
        const live = await liveGpuNames(now);
        return jobs.filter(job => job.kind !== 'gpurun' || live.has(job.name));
      }) };
      recent.set(agent.id, entry);
    }
    try { return { ...agent, runningJobs: await entry.jobs }; }
    catch (error) {
      // A failed observation cannot turn a wait into healthy work. Keep the warning and log the failed lookup.
      recent.delete(agent.id);
      console.error(JSON.stringify({ type: 'agent_job_observation_error', agentId: agent.id, error: String(error) }));
      return { ...agent, runningJobs: [] };
    }
  };
}
