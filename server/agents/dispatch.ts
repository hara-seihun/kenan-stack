// workers dispatch (Alice, 2026-10-30: "if there's a bugginess with the system it should simply just dispatch a worker
// from Kenaznia to fix it. Also all workers should be able to dispatch workers not as subagents but from Kenaznia if
// they want."). Any agent (Kenaznia, workers and swarm sub-agents) opens a new goal and
// launches a top-level worker for it whose parent is the person's Kenaznia: it reports to Kenaznia like any worker
// Kenaznia launched, its goal notes and brief name the dispatcher, and the dispatcher messages it directly. Kenaznia gets no
// note for it (Kenaznia, 2026-11-02: dozens a day, none needing anything): the goal shows as new in its next heartbeat's
// Moved list, and the dispatcher's own report lists what it dispatched. It lets any worker start an independently owned fix.
// Search before launch: a dispatch never starts a second worker on something an active worker already owns. An open goal
// with the same title, a component's standing owner (COMPONENTS below) or a likely duplicate from the last six hours
// gets the brief instead, as a message and on its goal's notes, and the caller gets that worker's id. force: true with a
// forceReason launches anyway for genuinely different work. Also cheap: a per-agent rate limit (in memory), dispatches
// of one title or one component are admitted one at a time, and spawnWorker keeps one active worker per goal.
import type { AgentInfo, Goal, GoalCategory } from '../../shared/contract.js';
import type { PersonConfig } from '../config.js';
import type { Deps } from '../types.js';
import type { Controls } from '../tools/control.js';
import { isSubAgent } from '../../shared/swarm.js';
import { deliverHere, senderOf } from './messaging.js';

export { WORKER_TITLE_MAX, titleRefusal } from '../../shared/title-limits.js';
import { fitTitle, GOAL_TITLE_MAX, WORKER_TITLE_MAX } from '../../shared/title-limits.js';
/** Titles compare by their words, ignoring case, spacing and a trailing full stop. */
export const sameTitle = (a: string, b: string) => normal(a) === normal(b);
const normal = (title: string) => title.trim().replace(/\s+/g, ' ').replace(/[.!]+$/, '').toLowerCase();

/** Open goals this recent are compared for near-duplicates (the same bug was dispatched 3-4 times in an hour under different titles). */
export const DUPLICATE_WINDOW_MS = 6 * 60 * 60_000;
/** A goal whose worker reported done this recently answers a dispatch about the same problem with that report (seven "cpu-slot builds starve" fixers were launched one after another, 2026-11-02, each right after the previous owner finished). */
export const RESOLVED_WINDOW_MS = 12 * 60 * 60_000;
export { COMPONENTS, componentOf } from './components.js';
import { componentOf, canonical, componentsOf } from './components.js';
import { classifyGoalCategory, publishGoalCategory } from './goal-category.js';
/** Problem words by family: a queue, a wait, a stall and a hang are one kind of problem however the title puts it. */
const PROBLEMS: RegExp[] = [/\b(queu|wait|delay|stall|hang|hung|block|stuck|slow|timeout|timed)/, /\b(fail|crash|error|reject|refus|broke|abort)/];
const problemsOf = (title: string) => new Set(PROBLEMS.flatMap((p, i) => p.test(title.toLowerCase()) ? [i] : []));
const STOP = new Set('the a an of to in on for and or is are was be with from by at as it its this that not no does doesn do missing lacks fix bug broken error when after before into than then via has have'.split(' '));
/** The words of a text, split on anything that is not a letter or digit (cpu-slot gives cpu and slot). */
const words = (text: string) => new Set(`${text.toLowerCase()} ${canonical(text)}`.split(/[^a-z0-9]+/).filter(w => w.length > 2 && !STOP.has(w)));
const shared = <T>(a: Set<T>, b: Set<T>) => [...a].filter(w => b.has(w)).length;
/** Two dispatches overlap strongly when their titles share most of the shorter title's words, name the same component and the same kind of problem, or their whole briefs share a large part of their words. */
export function likelyDuplicate(a: { title: string; text: string }, b: { title: string; text: string }): boolean {
  const ta = words(a.title), tb = words(b.title);
  const t = shared(ta, tb);
  if (t >= 3 && t / Math.min(ta.size, tb.size) >= 0.5) return true;
  const pa = problemsOf(a.title), pb = problemsOf(b.title);
  if (shared(componentsOf(a.title), componentsOf(b.title)) > 0 && shared(pa, pb) > 0) return true;
  const fa = words(`${a.title} ${a.text}`), fb = words(`${b.title} ${b.text}`);
  const f = shared(fa, fb);
  return f >= 8 && f / (fa.size + fb.size - f) >= 0.3;
}

export interface DispatchRequest { title: string; text: string; name?: string; category?: GoalCategory; work?: unknown; model?: string; thinking?: string; tools?: string[]; force?: boolean; forceReason?: string }
type Routed = { goalId: string; activeWorker: { id: string; name: string }; delivered: boolean; hint: string };
export type DispatchOutcome =
  | { dispatched: true; category: GoalCategory; goalId: string; workerId: string; name: string; reusedGoal: boolean; owns?: string }
  | ({ dispatched: false; reason: 'same_title' } & Routed)
  | ({ dispatched: false; reason: 'component_owner'; component: string; title: string } & Routed)
  | ({ dispatched: false; reason: 'likely_duplicate'; title: string } & Routed)
  | { dispatched: false; reason: 'recently_resolved'; goalId: string; title: string; report: { status: 'done'; text: string; at: number }; hint: string };

const inFlight = new Map<string, Promise<unknown>>();

/** An open goal's top-level worker that is still working (not archived, stopped or reported), if any. */
function activeWorkerOf(goalId: string, agents: readonly AgentInfo[]): AgentInfo | undefined {
  const byId = new Map(agents.map(a => [a.id, a]));
  return agents.find(w => w.role === 'worker' && w.goalId === goalId && !w.archived && !w.lastReport && w.state !== 'stopped' && !isSubAgent(w, w.parentAgentId ? byId.get(w.parentAgentId) : undefined));
}

/** The standing owner of a component: the active worker of the oldest open goal whose title names it. */
export function componentOwner(component: string, goals: readonly Goal[], agents: readonly AgentInfo[]): { goal: Goal; worker: AgentInfo } | undefined {
  for (const goal of [...goals].filter(g => g.status === 'open' && componentOf(g.title) === component).sort((x, y) => x.createdAt - y.createdAt)) {
    const worker = activeWorkerOf(goal.id, agents);
    if (worker) return { goal, worker };
  }
  return undefined;
}

export async function dispatchWorker(deps: Pick<Deps, 'store' | 'bus' | 'runtime' | 'person' | 'now'>, controls: Pick<Controls, 'spawnWorker' | 'messageWorker'>, person: PersonConfig, dispatcher: AgentInfo, request: DispatchRequest): Promise<DispatchOutcome & { titleShortened?: { from: string; to: string }; nameShortened?: { from: string; to: string } }> {
  const asked = request.title?.trim().replace(/\s+/g, ' ');
  if (!asked) throw new Error('title is required: one line naming the work, e.g. "gpurun: --sync drops empty folders"; an open goal with the same title is reused');
  // Over-long titles and names are shortened at a word boundary rather than refused (Kenaznia resent whole briefs over a few characters).
  const title = fitTitle(asked, GOAL_TITLE_MAX), askedName = request.name?.trim().replace(/\s+/g, ' ') || undefined;
  const name = askedName === undefined ? undefined : fitTitle(askedName, WORKER_TITLE_MAX);
  const shortened = { ...(title !== asked ? { titleShortened: { from: asked, to: title } } : {}), ...(askedName !== undefined && name !== askedName ? { nameShortened: { from: askedName, to: name! } } : {}) };
  if (!request.text?.trim()) throw new Error('text is required: the brief for the new worker (what is wrong, the evidence, the end state, and the change you propose when you know it)');
  if (request.force && !request.forceReason?.trim()) throw new Error('force_reason_required: force: true launches a second worker beside one already on this; say in forceReason why this is different work. Usually the right move is to message the worker dispatch named instead.');
  const managerId = deps.runtime.managerFor(person.id);
  const manager = managerId ? await deps.store.getAgent(managerId) : null;
  if (!manager) throw new Error(`dispatch_no_manager: ${person.name} has no Kenaznia on this channel to launch the worker under; nothing was launched. Message your parent instead.`);
  const component = componentOf(title);
  const key = `${person.id}\u0000${component && !request.force ? `component:${component}` : normal(title)}`;
  while (inFlight.has(key)) await inFlight.get(key)!.catch(() => {});
  const work = dispatchOnce(deps, controls, person, dispatcher, manager, { ...request, title, name });
  inFlight.set(key, work);
  try { return { ...await work, ...shortened }; } finally { if (inFlight.get(key) === work) inFlight.delete(key); }
}

async function dispatchOnce(deps: Pick<Deps, 'store' | 'bus' | 'runtime' | 'person' | 'now'>, controls: Pick<Controls, 'spawnWorker' | 'messageWorker'>, person: PersonConfig, dispatcher: AgentInfo, manager: AgentInfo, request: DispatchRequest & { title: string }): Promise<DispatchOutcome> {
  const by = dispatcher.role === 'manager' ? `${person.name}'s Kenaznia (${dispatcher.id})` : `worker ${dispatcher.name} (${dispatcher.id})${dispatcher.goalId ? `, goal ${dispatcher.goalId}` : ''}`;
  const goals = await deps.store.listGoals(person.id, 'open');
  const agents = await deps.store.listAgents(person.id, { includeAncestors: true });
  const existing = goals.find(g => sameTitle(g.title, request.title));
  const publish = (goal: Goal) => deps.bus.toPerson(person.id, { type: 'goal', goal });
  const reclassify = async (goal: Goal) => {
    if (request.category === undefined || request.category === goal.category) return goal;
    const updated = await deps.store.updateGoal(goal.id, { category: request.category });
    await publishGoalCategory(deps, updated);
    return updated;
  };
  const origin = (await deps.store.getAgent(dispatcher.id))?.originConversationId ?? null;
  /** Hands the brief to the worker already on it: on its goal's notes, and as a message that joins its current or next turn. */
  const handTo = async (goal: Goal, worker: AgentInfo, why: string, note: string): Promise<Routed> => {
    await reclassify(goal);
    publish(await deps.store.updateGoal(goal.id, { notes: { kind: 'prepend', entry: `${note}\n${request.text}` } }));
    let undelivered: string | undefined;
    try {
      await deliverHere(deps, (id, text, fromId) => controls.messageWorker(id, text, fromId), senderOf(dispatcher, person.name), worker, `${why} Title: "${request.title}". Add it to what you are fixing (several fixes per install is fine), and tell me in one line when it lands.\n\n${request.text}`, origin);
    } catch (error) { undelivered = error instanceof Error ? error.message : String(error); }
    return { goalId: goal.id, activeWorker: { id: worker.id, name: worker.name }, delivered: !undelivered, hint: `Nothing was launched: ${worker.name} (${worker.id}) already owns this and ${undelivered ? `has your brief on its goal notes only (the message failed: ${undelivered}; send it with workers message)` : 'has your brief as a message'}. Carry on with your own work; message ${worker.id} for anything more. force: true with forceReason launches a separate worker only for genuinely different work.` };
  };
  if (existing) {
    const active = activeWorkerOf(existing.id, agents);
    if (active && active.id !== dispatcher.id) return { dispatched: false, reason: 'same_title', ...await handTo(existing, active, `${by} dispatched the same title again; it came to you instead of a new worker.`, `Dispatched again by ${by}; it went to ${active.name} (${active.id}):`) };
    if (!active) publish(await deps.store.updateGoal(existing.id, { notes: { kind: 'prepend', entry: `Dispatched again by ${by}:\n${request.text}` } }));
  }
  const component = componentOf(request.title);
  if (!existing && component && !request.force) {
    const owner = componentOwner(component, goals, agents);
    if (owner && owner.worker.id === dispatcher.id) throw new Error(`you_own_component: you are the standing owner of ${component}, so nothing was launched. Fix it yourself, or spawn a sub-agent on your own goal for it.`);
    if (owner) return { dispatched: false, reason: 'component_owner', component, title: owner.goal.title, ...await handTo(owner.goal, owner.worker, `${by} dispatched a ${component} problem; you are ${component}'s standing owner, so it came to you instead of a new worker.`, `${component} dispatch "${request.title}" by ${by} came to the owner, ${owner.worker.name} (${owner.worker.id}):`) };
  }
  if (!existing && !request.force) {
    const since = deps.now() - DUPLICATE_WINDOW_MS;
    for (const goal of goals) {
      if (goal.createdAt < since || !likelyDuplicate({ title: goal.title, text: goal.detail }, request)) continue;
      const active = activeWorkerOf(goal.id, agents);
      if (!active || active.id === dispatcher.id) continue;
      return { dispatched: false, reason: 'likely_duplicate', title: goal.title, ...await handTo(goal, active, `${by} dispatched what looks like the problem you are on; it came to you instead of a new worker.`, `A similar dispatch "${request.title}" by ${by} was not launched; it went to ${active.name} (${active.id}):`) };
    }
  }
  if (!existing && !request.force) {
    const since = deps.now() - RESOLVED_WINDOW_MS;
    const byId = new Map(agents.map(a => [a.id, a]));
    let best: { goal: Goal; report: { status: 'done'; text: string; at: number } } | undefined;
    for (const goal of await deps.store.goalsWithRecentReport(person.id, since)) {
      if (goal.status === 'dropped' || goal.id === dispatcher.goalId || !likelyDuplicate({ title: goal.title, text: goal.detail }, request)) continue;
      if (activeWorkerOf(goal.id, agents)) continue;
      for (const w of agents) {
        const r = w.lastReport;
        if (w.archived || w.goalId !== goal.id || w.role !== 'worker' || r?.status !== 'done' || r.at < since || isSubAgent(w, w.parentAgentId ? byId.get(w.parentAgentId) : undefined)) continue;
        if (!best || r.at > best.report.at) best = { goal, report: { status: 'done', text: r.text, at: r.at } };
      }
    }
    if (best) return { dispatched: false, reason: 'recently_resolved', goalId: best.goal.id, title: best.goal.title, report: best.report, hint: `Nothing was launched: "${best.goal.title}" was finished and reported done ${Math.round((deps.now() - best.report.at) / 60_000)} minutes ago, and your dispatch overlaps it strongly. Read its report below; if the problem is still there after that fix, dispatch again with force: true and a forceReason saying what is still broken.` };
  }
  const goal = existing ? await reclassify(existing) : await deps.store.createGoal({ ownerId: person.id, title: request.title, detail: request.text, category: classifyGoalCategory({ title: request.title, text: request.text, category: request.category }) });
  if (!existing) publish(await deps.store.updateGoal(goal.id, { notes: { kind: 'prepend', entry: `Dispatched by ${by}.${request.force ? ` Launched with force beside the worker already on similar work: ${request.forceReason!.trim()}` : ''}` } }));
  const owns = component && !request.force && !componentOwner(component, goals.filter(g => g.id !== goal.id), agents) ? component : undefined;
  const standing = owns ? `\n\nYou are the standing owner of ${owns}: while you are active, every dispatch naming ${owns} comes to you as a message instead of launching another worker. Work through them as they arrive, landing several fixes per install, tell each dispatcher in one line when its fix lands, and report only when your queue is empty.` : '';
  const replyTo = dispatcher.role === 'manager' ? '' : ` When you report, also send ${dispatcher.name} one line with workers message id ${dispatcher.id} saying what changed (it carried on with its own work and may be waiting on the fix).`;
  const task = `You were dispatched by ${by}: a new goal "${request.title}" (goal id ${goal.id}) and you are its worker. You report to ${person.name}'s Kenaznia (${manager.id}) like any worker it launched; message the dispatcher directly for anything you need from it.${replyTo}${standing}\n\n${request.text}`;
  const name = request.name?.trim() || request.title;
  let worker: AgentInfo;
  try {
    worker = await controls.spawnWorker(person.id, goal.id, name, task, manager.id, request.model || request.thinking ? { model: request.model, thinking: request.thinking } : undefined, { origin }, undefined, request.tools);
  } catch (error) {
    // A goal this call opened and could not staff is dropped, so a refused dispatch leaves nothing behind.
    if (!existing) publish(await deps.store.updateGoal(goal.id, { status: 'dropped', notes: { kind: 'prepend', entry: `Dropped: the worker could not be launched (${error instanceof Error ? error.message : String(error)}).` } }));
    throw error;
  }
  return { dispatched: true, category: goal.category, goalId: goal.id, workerId: worker.id, name: worker.name, reusedGoal: !!existing, ...(owns ? { owns } : {}) };
}

/** The goal note dispatch writes for a worker's dispatch: `Dispatched by worker NAME (ID), goal G.` */
const DISPATCHED_BY = /Dispatched by (?:worker (.+?) \(([^,)]+)[,)]|(.+?'s Kenaznia) \()/;
/** Who dispatched a goal, from its notes: the dispatching worker's name and id, Kenaznia's name, or null when it was not dispatched. */
export function dispatcherOf(goal: Pick<Goal, 'notes'>): { name: string; id: string | null } | null {
  const match = DISPATCHED_BY.exec(goal.notes);
  return !match ? null : match[1] ? { name: match[1], id: match[2]! } : { name: match[3]!, id: null };
}
/** Goals a worker dispatched since it started, for its report (Kenaznia hears of them there instead of one note each). */
export function dispatchedBy(goals: readonly Goal[], agent: Pick<AgentInfo, 'id' | 'createdAt'>): Goal[] {
  return goals.filter(goal => goal.createdAt >= agent.createdAt && dispatcherOf(goal)?.id === agent.id);
}
