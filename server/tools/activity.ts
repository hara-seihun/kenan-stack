import { execFile, spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { open, readdir, readFile, stat, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentInfo } from '../../shared/contract.js';
import type { Deps } from '../types.js';
import { GPURUN_JOBS_ROOT } from '../agents/pending-work.js';

/**
 * `workers activity`: per worker of a person, what it produced in the last few hours: commits it pushed, GPU jobs it
 * submitted (with their dollars) and its last report. Built from what the host already records; nothing is written.
 *
 * Commits. Every worker's bash tool output lands in its session file (agent.session_path, one JSON line per message). A
 * commit's short hash shows up there as soon as the worker makes it (git commit prints `[branch hash] subject`) or pushes it
 * (git push prints the hash range), so the worker that first mentions a hash in a tool result or its own reply is the one
 * that made the commit. Author names don't help: every agent commits as "Kenan". The commits themselves come from the bare
 * remotes on this host (work/repos and the research remotes), so a commit is "pushed" when a remote has it. `time` is the
 * commit's committer date, which is when it was made; a commit made before the window and pushed inside it is not listed.
 * Each git call reads one remote's history since the window start, and each worker's session is grepped only when its file changed in
 * the window, so the whole report costs a few tenths of a second for a normal six hours.
 *
 * GPU jobs. gpurun keeps one folder per job (jobs/NAME, or ended/NAME an hour after it ended): spec.json names the
 * submitting agent as `owner`, state.json has `phase`, `gpu_type`, `ran_s`, `cost` (dollars so far) and `updated`. A job
 * counts for the window when it was submitted or updated in it. Candidate names come from the jobs folder plus the
 * box events in gpurun's ledger (ended jobs that left the jobs folder), so a job that held a box in the window is found
 * even after it moved to ended/. A job that never got a box and has left jobs/ isn't found.
 */

export const ACTIVITY_HOURS = { default: 6, max: 72 } as const;
/** Bare git repositories whose history the report reads: the shared remotes and the research remotes. */
export const ACTIVITY_REPO_ROOTS = ['/home/kenan/work/repos', '/home/kenan/data/research-remotes'] as const;
const GPURUN_ROOT = GPURUN_JOBS_ROOT.replace(/\/jobs$/, '');
/** git abbreviates hashes to at least 7 hex digits (more in big repositories); a session quotes whichever length git printed. */
const MIN_ABBREV = 7;

/** Names and goal titles can run to a paragraph; a report lists many workers, so each is cut to one line of this many characters. */
const TEXT_MAX = 160;
const clip = (text: string) => text.length > TEXT_MAX ? `${text.slice(0, TEXT_MAX - 1)}…` : text;

export interface CommitActivity { repo: string; branch: string; sha: string; subject: string; at: string }
export interface GpuJobActivity { name: string; state: string; gpu: string; hours: number; usd: number }
export interface WorkerActivity {
  id: string; name: string; goal?: string; state: AgentInfo['state']; archived?: true;
  lastReport?: { status: string; at: string };
  commits?: CommitActivity[];
  gpuJobs?: GpuJobActivity[];
}
export interface ActivityReport { hours: number; since: string; now: string; workers: WorkerActivity[]; unreadableRepos?: string[] }

/** The hours argument: a number above 0 and at most 72, default 6. Anything else is a typed error. */
export function activityHours(value: unknown): number {
  if (value === undefined || value === null) return ACTIVITY_HOURS.default;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > ACTIVITY_HOURS.max) throw new Error(`hours_invalid: hours is a number above 0 and at most ${ACTIVITY_HOURS.max} (got ${JSON.stringify(value)})`);
  return value;
}

/** Calls `fn` for every item, at most `limit` at a time. */
async function mapLimit<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => { while (next < items.length) await fn(items[next++]!); }));
}

interface Run { stdout: string; code: number }
/** Runs a program and returns its stdout; exit code 1 is a normal "no match" for grep, and anything else throws. */
function run(file: string, args: readonly string[], maxBuffer: number, okCodes: number[] = [0]): Promise<Run> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { maxBuffer, timeout: 20_000, encoding: 'utf8' }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === 'number' ? error.code : -1) : 0;
      if (code === 0 || okCodes.includes(code)) resolve({ stdout, code });
      else reject(new Error(`${file} ${args[0] ?? ''} failed (${code}): ${stderr.trim() || error?.message}`));
    });
  });
}

interface Remote { repo: string; sha: string; branch: string; subject: string; ms: number }
/** Commits made since `since` in one bare repository, on any of its refs (each commit once). `-c safe.directory` because the
 * server runs as root and the remotes belong to the operator account. */
async function remoteCommits(path: string, since: number): Promise<Remote[]> {
  const repo = path.replace(/^.*\//, '').replace(/\.git$/, '');
  const { stdout } = await run('git', ['-c', 'safe.directory=*', '-C', path, 'log', '--all', `--since=${new Date(since).toISOString()}`, '--format=%H%x1f%ct%x1f%S%x1f%s'], 512 << 20);
  return stdout.split('\n').filter(Boolean).map(line => {
    const [sha = '', ct = '', ref = '', ...subject] = line.split('\x1f');
    return { repo, sha, branch: ref.replace(/^refs\/heads\//, ''), subject: subject.join('\x1f'), ms: Number(ct) * 1000 };
  });
}

/** Byte offset of the first line of a session file whose timestamp is at or after `since` (ms), found by bisection: the
 * lines are in time order and a session only grows at its end, so a worker's six-hour tail is most of a file's bytes only
 * when it was busy the whole time. The offset returned may be a little before that line, never after it. */
export async function sinceOffset(file: string, since: number): Promise<number> {
  const handle = await open(file, 'r');
  try {
    const size = (await handle.stat()).size;
    let lo = 0, hi = size;
    for (let probes = 0; probes < 64 && hi - lo > 1 << 20; probes++) {
      const mid = Math.floor((lo + hi) / 2);
      const next = await lineAt(handle, mid, size);
      if (next.start >= hi) break;
      if (next.at === null) break;
      if (next.at < since) lo = next.start; else hi = next.start;
    }
    return lo;
  } finally {
    await handle.close();
  }
}
/** The line that starts at or after `pos`: where it starts and its message timestamp (null when it has none or is the end). */
async function lineAt(handle: FileHandle, pos: number, size: number): Promise<{ start: number; at: number | null }> {
  // The line containing `pos` ends at the first newline at or after it; the next line starts right after that newline.
  let cursor = pos;
  const chunk = Buffer.alloc(64 << 10);
  for (;;) {
    if (cursor >= size) return { start: size, at: null };
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, cursor);
    if (bytesRead === 0) return { start: size, at: null };
    const nl = chunk.subarray(0, bytesRead).indexOf(10);
    if (nl >= 0) { cursor += nl + 1; break; }
    cursor += bytesRead;
  }
  if (cursor >= size) return { start: size, at: null };
  // Read the line that starts at `cursor` (it may be longer than a chunk).
  const parts: Buffer[] = [];
  let read = cursor;
  for (;;) {
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, read);
    if (bytesRead === 0) break;
    const nl = chunk.subarray(0, bytesRead).indexOf(10);
    parts.push(Buffer.from(chunk.subarray(0, nl >= 0 ? nl : bytesRead)));
    if (nl >= 0) break;
    read += bytesRead;
  }
  let at: number | null = null;
  try { at = Date.parse((JSON.parse(Buffer.concat(parts).toString('utf8')) as { timestamp?: string }).timestamp ?? ''); } catch { at = null; }
  return { start: cursor, at: Number.isFinite(at) ? at : null };
}

/** Byte offsets, from `from` on, of every match of the patterns in a session file (`grep -o -b`: only the matched text and
 * its offset come back, so a file full of hashes costs no more output than its matches). */
function matchOffsets(file: string, from: number, patterns: readonly string[]): Promise<number[]> {
  return new Promise((resolve, reject) => {
    const child = spawn('grep', ['-o', '-b', '-F', ...patterns.flatMap(p => ['-e', p])], { stdio: ['pipe', 'pipe', 'pipe'] });
    const out: Buffer[] = [], err: Buffer[] = [];
    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.stderr.on('data', (d: Buffer) => err.push(d));
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0 && code !== 1) return reject(new Error(`grep ${file} failed (${code}): ${Buffer.concat(err).toString().trim()}`));
      const offsets = new Set<number>();
      for (const line of Buffer.concat(out).toString('utf8').split('\n')) {
        const colon = line.indexOf(':');
        if (colon > 0) offsets.add(from + Number(line.slice(0, colon)));
      }
      resolve([...offsets].sort((x, y) => x - y));
    });
    const input = createReadStream(file, { start: from });
    input.on('error', error => { child.kill(); reject(error); });
    input.pipe(child.stdin);
  });
}

/** Where the line holding byte `offset` starts. */
async function lineStart(handle: FileHandle, offset: number): Promise<number> {
  const chunk = Buffer.alloc(64 << 10);
  let end = offset;
  while (end > 0) {
    const from = Math.max(0, end - chunk.length);
    const { bytesRead } = await handle.read(chunk, 0, end - from, from);
    const nl = chunk.subarray(0, bytesRead).lastIndexOf(10);
    if (nl >= 0) return from + nl + 1;
    end = from;
  }
  return 0;
}

const HEAD = /"timestamp":"([^"]+)"/, ROLE = /^\{"type":"message"[^]*?"message":\{"role":"(\w+)"/;
/** For one session: the first line (in time order) that mentions each commit, from a tool result or its own reply.
 * A session line is one JSON message; only its first KB is read (type, timestamp and role come first), and a hash counts
 * only as the whole hex run around the match, so a long tool result costs nothing more than its matches. */
async function firstMentions(file: string, since: number, patterns: readonly string[], byPrefix: ReadonlyMap<string, Remote[]>): Promise<Map<string, number>> {
  const found = new Map<string, number>();   // full sha -> ms
  const from = await sinceOffset(file, since);
  const offsets = await matchOffsets(file, from, patterns);
  if (offsets.length === 0) return found;
  const handle = await open(file, 'r');
  try {
    const head = Buffer.alloc(1024), around = Buffer.alloc(96);
    const seenLines = new Set<number>();
    for (const offset of offsets) {
      const start = await lineStart(handle, offset);
      if (seenLines.has(start)) continue;
      seenLines.add(start);
      const { bytesRead } = await handle.read(head, 0, head.length, start);
      const top = head.subarray(0, bytesRead).toString('utf8');
      const role = ROLE.exec(top)?.[1], stamp = HEAD.exec(top)?.[1];
      // The brief a parent wrote is not something the worker did, so only its own replies and tool results count.
      if (role !== 'toolResult' && role !== 'assistant') continue;
      const at = Date.parse(stamp ?? '');
      if (!Number.isFinite(at)) continue;
      const window = await handle.read(around, 0, around.length, Math.max(start, offset - 48));
      const text = around.subarray(0, window.bytesRead).toString('latin1');
      const at0 = offset - Math.max(start, offset - 48);
      for (const run of text.matchAll(/[0-9a-f]+/g)) {
        const i = run.index ?? 0, token = run[0];
        if (i > at0 || i + token.length <= at0 || token.length < MIN_ABBREV) continue;
        for (const commit of byPrefix.get(token.slice(0, MIN_ABBREV)) ?? []) {
          if (commit.sha.startsWith(token) && !found.has(commit.sha)) found.set(commit.sha, at);
        }
      }
    }
  } finally {
    await handle.close();
  }
  return found;
}

/** Attributes each commit to the worker whose session mentions its hash first. Sessions are read in parallel, eight at a time. */
async function attributeCommits(commits: Remote[], sessions: { workerId: string; file: string }[], since: number): Promise<Map<string, { workerId: string; at: number }>> {
  const owner = new Map<string, { workerId: string; at: number }>();
  if (commits.length === 0) return owner;
  const byPrefix = new Map<string, Remote[]>();
  for (const c of commits) byPrefix.set(c.sha.slice(0, MIN_ABBREV), [...(byPrefix.get(c.sha.slice(0, MIN_ABBREV)) ?? []), c]);
  const patterns = [...byPrefix.keys()];
  await mapLimit(sessions, 8, async ({ workerId, file }) => {
    for (const [sha, at] of await firstMentions(file, since, patterns, byPrefix)) {
      const seen = owner.get(sha);
      if (!seen || at < seen.at) owner.set(sha, { workerId, at });
    }
  });
  return owner;
}

/** A JSON file of a gpurun job, or null while it isn't there (or is still being written). */
async function readJson<T>(path: string): Promise<T | null> {
  const text = await readFile(path, 'utf8').catch(error => { if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null; throw error; });
  if (text === null) return null;
  try { return JSON.parse(text) as T; } catch { return null; }
}

/** GPU jobs submitted or updated since `since` (seconds), grouped by the agent that submitted them. */
async function gpuJobsByOwner(gpurunRoot: string, since: number, owners: ReadonlySet<string>): Promise<Map<string, GpuJobActivity[]>> {
  const names = new Set(await readdir(join(gpurunRoot, 'jobs')).catch(error => { if (error?.code === 'ENOENT') return []; throw error; }));
  // Box events in the ledger name jobs that held a box in the window, including ones that have moved to ended/.
  const ledger = await readFile(join(gpurunRoot, 'ledger.jsonl'), 'utf8').catch(error => { if (error?.code === 'ENOENT') return ''; throw error; });
  for (const line of ledger.split('\n')) {
    // The last line may be half written while gpurun appends to it.
    let event: { t?: number; job?: string };
    try { event = JSON.parse(line); } catch { continue; }
    if (typeof event.t === 'number' && event.t >= since && typeof event.job === 'string') names.add(event.job);
  }
  const byOwner = new Map<string, GpuJobActivity[]>();
  const readJob = async (name: string): Promise<void> => {
    // A job folder is in jobs/ until an hour after it ended, then in ended/. A half-written spec or state is read next time.
    let folder = join(gpurunRoot, 'jobs', name);
    let spec = await readJson<{ owner?: string; name?: string; submitted?: number }>(join(folder, 'spec.json'));
    if (!spec) { folder = join(gpurunRoot, 'ended', name); spec = await readJson(join(folder, 'spec.json')); }
    if (!spec?.owner || !owners.has(spec.owner)) return;
    const state = await readJson<{ phase?: string; gpu_type?: string | null; ran_s?: number; cost?: number; updated?: number }>(join(folder, 'state.json'));
    if (!state || Math.max(state.updated ?? 0, Number(spec.submitted ?? 0)) < since) return;
    const job: GpuJobActivity = {
      name: spec.name ?? name, state: state.phase ?? 'unknown', gpu: state.gpu_type ?? 'cpu',
      hours: Math.round(((state.ran_s ?? 0) / 3600) * 100) / 100, usd: Math.round((state.cost ?? 0) * 1000) / 1000,
    };
    byOwner.set(spec.owner, [...(byOwner.get(spec.owner) ?? []), job]);
  };
  await Promise.all([...names].map(readJob));
  return byOwner;
}

export interface ActivitySources {
  now: number;
  hours: number;
  /** The workers to report on (the caller has already picked them). */
  workers: AgentInfo[];
  sessionPath(id: string): Promise<string | null>;
  goalTitle(goalId: string): Promise<string | null>;
  /** Bare repositories to read; each is a path ending in .git. */
  repos: string[];
  gpurunRoot: string;
}

/** Builds the report from explicit sources; `activityOf` supplies them from the host. */
export async function buildActivity(src: ActivitySources): Promise<ActivityReport> {
  const since = src.now - src.hours * 3_600_000;
  const unreadable: string[] = [];
  const commitLists = await Promise.all(src.repos.map(async path => {
    try { return await remoteCommits(path, since); }
    catch { unreadable.push(path); return []; }
  }));
  const commits = commitLists.flat();
  const sessions = (await Promise.all(src.workers.map(async w => {
    const file = await src.sessionPath(w.id);
    if (!file) return null;
    const info = await stat(file).catch(() => null);
    return info && info.mtimeMs >= since ? { workerId: w.id, file } : null;
  }))).filter((s): s is { workerId: string; file: string } => s !== null);
  const owners = await attributeCommits(commits, sessions, since);
  const jobs = await gpuJobsByOwner(src.gpurunRoot, since / 1000, new Set(src.workers.map(w => w.id)));

  const goals = new Map<string, string | null>();
  for (const w of src.workers) if (w.goalId && !goals.has(w.goalId)) goals.set(w.goalId, await src.goalTitle(w.goalId));

  const iso = (ms: number) => new Date(ms).toISOString();
  const lastActive = (w: AgentInfo) => Math.max(w.updatedAt, w.lastReport?.at ?? 0);
  const out: WorkerActivity[] = [...src.workers].sort((a, b) => lastActive(b) - lastActive(a)).map(w => {
    const mine = commits.filter(c => owners.get(c.sha)?.workerId === w.id).sort((a, b) => b.ms - a.ms)
      .map(c => ({ repo: c.repo, branch: c.branch, sha: c.sha.slice(0, 10), subject: c.subject, at: iso(c.ms) }));
    const goal = w.goalId ? goals.get(w.goalId) : null;
    return {
      id: w.id, name: clip(w.name), state: w.state,
      ...(w.archived ? { archived: true as const } : {}),
      ...(goal ? { goal: clip(goal) } : {}),
      ...(w.lastReport ? { lastReport: { status: w.lastReport.status, at: iso(w.lastReport.at) } } : {}),
      ...(mine.length ? { commits: mine } : {}),
      ...(jobs.get(w.id)?.length ? { gpuJobs: jobs.get(w.id)! } : {}),
    };
  });
  return {
    hours: src.hours, since: iso(since), now: iso(src.now), workers: out,
    ...(unreadable.length ? { unreadableRepos: unreadable.sort() } : {}),
  };
}

/** The workers `workers activity` reports on: a person's workers active in the window (archived ones only if they reported in
 * it), or the one worker `id` names, active or not. Activity is an update to the run or a report in the window, or a run
 * that is running now. */
export function activeWorkers(all: AgentInfo[], since: number): AgentInfo[] {
  return all.filter(w => {
    if (w.role !== 'worker') return false;
    const reported = (w.lastReport?.at ?? 0) >= since;
    const touched = w.updatedAt >= since || w.state === 'running' || reported;
    return touched && (!w.archived || w.updatedAt >= since || reported);
  });
}

/** The `workers` tool's `activity` action. */
export async function activityOf(deps: Pick<Deps, 'store' | 'now'>, ownerId: string, args: { hours?: unknown; id?: unknown }): Promise<ActivityReport> {
  const hours = activityHours(args.hours);
  const now = deps.now(), since = now - hours * 3_600_000;
  let workers: AgentInfo[];
  if (typeof args.id === 'string' && args.id.trim()) {
    const found = (await deps.store.agentsMatching(ownerId, args.id.trim())).filter(w => w.role === 'worker');
    if (found.length !== 1) throw new Error(`worker_not_found: ${args.id} matches ${found.length} of your workers`);
    workers = found;
  } else {
    workers = activeWorkers(await deps.store.listAgents(ownerId, { includeArchived: true }), since);
  }
  const repos = (await Promise.all(ACTIVITY_REPO_ROOTS.map(async root => {
    const names = await readdir(root).catch(error => { if (error?.code === 'ENOENT') return []; throw error; });
    return names.filter(n => n.endsWith('.git')).map(n => join(root, n));
  }))).flat();
  const report = await buildActivity({
    now, hours, workers, repos, gpurunRoot: GPURUN_ROOT,
    sessionPath: id => deps.store.agentSessionPath(id),
    goalTitle: async goalId => (await deps.store.getGoal(ownerId, goalId))?.title ?? null,
  });
  return typeof args.id === 'string' && args.id.trim() ? report : summarized(report);
}

/** Hundreds of runs touch six hours (284 on 2026-11-01, mostly finished sub-agents), so the overview lists in full only
 * the workers that produced commits or GPU jobs, gives each other still-active worker one line, and counts the rest. */
export function summarized(report: ActivityReport): ActivityReport & { quiet?: string[]; finishedWithNothing?: number } {
  const produced = report.workers.filter(w => w.commits || w.gpuJobs);
  const rest = report.workers.filter(w => !w.commits && !w.gpuJobs);
  const quiet = rest.filter(w => !w.archived).map(w => `${w.name} (${w.id.slice(0, 8)}) · ${w.state}${w.lastReport ? ` · reported ${w.lastReport.status}` : ''}`);
  const finished = rest.length - quiet.length;
  return { ...report, workers: produced, ...(quiet.length ? { quiet } : {}), ...(finished ? { finishedWithNothing: finished } : {}) };
}
