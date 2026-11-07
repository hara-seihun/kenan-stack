import { workerProgress, progressText } from '../../shared/worker-progress.js';
import { queueKenazniaNotification } from '../chat-notify.js';
import { ownersVisible } from '../agents/person-isolation.js';
import { sealGuessTool } from './seal-guess.js';
import { GOAL_TITLE_MAX, WORKER_TITLE_MAX, titleRefusal } from '../../shared/title-limits.js';
import { readFile } from 'node:fs/promises';
import { pageParameters } from './pagination.js';
import { searchWeb, webSearchDescription } from './web-search.js';
import { guardSelfArchive } from './self-archive-guard.js';
import { Type, type TSchema } from 'typebox';
import type { AgentInfo, Goal, GoalCategory } from '../../shared/contract.js';
import { requestOnlyRefusal } from '../agents/request-only-models.js';
import type { Deps, KenanTool, NotesChange, RecentWork, ToolContext, Wake } from '../types.js';

/** Goals whose workers must never see unscreened web results (blind compiler inputs): /etc/kenan/blind-goals.json, {"goals": {"<goal id>": "<why>"}}. No file means no blinded goals. */
export const BLIND_GOALS_PATH = '/etc/kenan/blind-goals.json';
/** The workers a run may peek at while its goal is blinded: its own sub-agents and their descendants (another worker's context can carry material the blind goal must not see). */
export const ownSubtree = subtreeOf;

export async function blindGoal(goalId: string | null | undefined, path = BLIND_GOALS_PATH): Promise<string | null> {
  if (!goalId) return null;
  let raw: string;
  try { raw = await readFile(path, 'utf8'); } catch (error: any) { if (error?.code === 'ENOENT') return null; throw new Error(`blind_goals_unreadable: ${path}: ${error?.message ?? error}`); }
  const goals: unknown = JSON.parse(raw)?.goals;
  if (!goals || typeof goals !== 'object') throw new Error(`blind_goals_invalid: ${path} has no "goals" object`);
  const why = (goals as Record<string, unknown>)[goalId];
  return typeof why === 'string' ? why : null;
}

const GOAL_FIELDS = ['category', 'title', 'detail', 'status', 'priority', 'workerIds', 'notes', 'chatId', 'createdAt', 'updatedAt', 'held', 'waiting'] as const satisfies readonly (keyof Goal | 'held' | 'waiting')[];
import { usageReport } from '../metrics/usage.js';
import { usageToolResult } from './usage-output.js';
import { isSubAgent, swarmCounts, swarmsOf, workerDescendants } from '../../shared/swarm.js';
import { notify } from '../notifications.js';
import { waitingLine, wakeSummary } from '../agents/wakes.js';
import { ownedText, pendingWork, pendingWorkError } from '../agents/pending-work.js';
import { PEEK_MAX_WORKERS, peekLine, peekWorkers, redact, resolveWorker } from './peek.js';
import { activityOf } from './activity.js';
import { handoffFor } from './respawn.js';
import { assertWorkerQuota } from '../agents/worker-quota.js';
import { agentConfigDir, readGrant } from '../agents/tool-scope.js';
import { goalOf, IdFailure, matchId, resolveId } from '../ids.js';
import { liveCallOf } from '../extensions/phone.js';
import { meetingAgentMessageRefusal } from '../agents/live-meeting-agents.js';
import { answeringChat, canChooseChat, chatTarget, goalChat, routeBackground, type Origin } from '../agents/origin.js';
import { researchModels, type SpawnRequest, type Work } from '../agents/research.js';
import { deliverHere, directoryOf, FIND_LIMIT, MESSAGE_TEXT_LIMIT, messageText, parseGroup, queueLinkedMessage, queueRemote, senderOf, subtreeOf, writeBroadcast, type BroadcastRef, type Located } from '../agents/messaging.js';
import { randomUUID } from 'node:crypto';
import { categoryGroups, categoryGuidance, publishGoalCategory } from '../agents/goal-category.js';
import { COMPONENTS, dispatchWorker, dispatchedBy } from '../agents/dispatch.js';
import { getMimeType } from 'hono/utils/mime';
import { attachErrorText, ATTACH_LIMITS, filePart, storeOwnerFiles } from '../files/files.js';

/** Pictures the Android notification can decode (no SVG). */
const PHONE_IMAGES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp']);

export interface Controls {
  spawnWorker(ownerId: string, goalId: string, name: string, task: string, parentAgentId?: string, profile?: SpawnRequest, target?: Origin, work?: Work, tools?: string[], speed?: string, category?: GoalCategory): Promise<AgentInfo>;
  setWorkerSpeed(id: string, speed: string): Promise<AgentInfo>;
  setWorkerProfile(id: string, change: { model?: string; thinking?: string }): Promise<AgentInfo>;
  messageWorker(id: string, text: string, fromId?: string, target?: Origin): Promise<MessageOutcome>;
  stopAgent(id: string): Promise<void>;
  archiveAgent(id: string, archived: boolean): Promise<AgentInfo>;
  reparentWorker(id: string, parentId: string, byId: string): Promise<{ worker: AgentInfo; previousParent: string | null; movedTriggers: string[] }>;
}
export type MessageOutcome = { delivered: true } | { delivered: false; error: 'recipient_archived'; agent: AgentInfo } | { delivered: false; error: 'input_not_stored'; detail: string };
/** The run's current parent, read fresh: a worker can be moved under another parent while its session lives. */
const parentOf = async ({ deps, person, agent }: ToolContext) => (await deps.store.getAgent(agent.id))?.parentAgentId ?? agent.parentAgentId ?? deps.runtime.managerFor(person.id);
/** A worker's report goes to the agent that launched it (else its person's manager) and stays on the run as its lastReport; anyone else's is shown in its own chat. */
export async function fileReport(deps: Deps, stale: AgentInfo, status: 'done' | 'blocked', text: string): Promise<AgentInfo> {
  const fresh = await deps.store.getAgent(stale.id);
  const agent = fresh && 'parentAgentId' in fresh ? { ...stale, parentAgentId: fresh.parentAgentId } : stale;
  // What it dispatched rides in its report (Kenaznia gets no separate note per dispatch).
  // A failed lookup only leaves the list out: it must never cost the report itself.
  const dispatched = agent.role !== 'worker' ? [] : await deps.store.listGoals(agent.ownerId, undefined, { createdSince: agent.createdAt, notesContaining: agent.id }).then(goals => dispatchedBy(goals, agent), async (e: unknown) => { await deps.store.logError(`agent:${agent.id}`, `report: listing its dispatches failed: ${e}`); return []; });
  if (dispatched.length) text = `${text}\n\nDispatched while working: ${dispatched.map(goal => `"${goal.title}" (goal ${goal.id}, ${goal.status})`).join('; ')}.`;
  const updated = await deps.store.updateAgent(agent.id, { lastReport: { status, text, at: deps.now() } });
  deps.bus.toPerson(agent.ownerId, { type: 'agent', agent: updated });
  const parent = agent.parentAgentId ?? deps.runtime.managerFor(agent.ownerId);
  if (agent.role === 'worker' && parent) {
    const info = await deps.store.getAgent(parent);
    const stored = info ? await deps.runtime.deliver({ agentId: parent, kind: 'report', fromId: agent.id, ...await routeBackground(deps, info, updated.originConversationId), text: `Worker ${agent.name} (${agent.id}), goal ${agent.goalId}, reports ${status}:\n${text}` }) : null;
    if (stored && !stored.ok) throw new Error(`input_not_stored: the report could not be stored, so it was not delivered (${stored.detail}). Report again.`);
  } else {
    const message = await deps.store.appendMessage({ conversationId: agent.conversationId, authorId: agent.id, role: 'notice', notice: 'report', text });
    deps.bus.toConversation(agent.conversationId, { type: 'message', message });
  }
  return updated;
}
const result = (value: unknown) => ({ content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value) }], details: {} });
/** Keep the task intact; old dated notes are available by explicit character pages or full:true. */
export function goalResult(goal: Goal, held: (ReturnType<typeof wakeSummary> & { handoff: string })[], waiting: unknown[], args: { fields?: string[]; full?: boolean; notesOffset?: number; notesLimit?: number }): Record<string, unknown> {
  const offset = args.notesOffset ?? 0, limit = args.notesLimit ?? 6000;
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 50000) throw new Error('goal_notes_range_invalid: notesOffset must be nonnegative and notesLimit from 1 to 50000');
  if (args.full && (args.notesOffset !== undefined || args.notesLimit !== undefined)) throw new Error('goal_notes_range_conflict: choose full:true or notesOffset/notesLimit');
  const notes = args.full ? goal.notes : goal.notes.slice(offset, offset + limit);
  const values: Record<string, unknown> = { ...goal, notes, held: args.full ? held : held.map(({ handoff, ...wake }) => ({ ...wake, handoff: handoff.length > 240 ? handoff.slice(0, 240) + '…' : handoff, ...(handoff.length > 240 ? { detail: `wake get id=${wake.id} returns the full handoff` } : {}) })), waiting };
  const selected = args.fields === undefined ? values : Object.fromEntries([['id', goal.id], ...args.fields.map(f => [f, values[f]])]);
  if (!args.full && (args.fields === undefined || args.fields.includes('notes')) && (offset > 0 || notes.length < goal.notes.length)) selected.notesRange = { offset, end: offset + notes.length, total: goal.notes.length, ...(offset + notes.length < goal.notes.length ? { nextOffset: offset + notes.length } : {}), more: 'Use notesOffset with nextOffset for the next page, or full:true for complete notes.' };
  return selected;
}
export function controlTools(ctx: ToolContext, controls: Controls): KenanTool[] { return guardSelfArchive(ctx, kenanControlTools(ctx, controls)); }
function kenanControlTools(ctx: ToolContext, controls: Controls): KenanTool[] {
  const { deps, person, agent } = ctx;
  const categoryParameter = { category: Type.Optional(Type.Union([Type.Literal('work'), Type.Literal('upkeep')], { description: categoryGuidance })) };
  const offersWork = person.research !== undefined;
  const workParameter: Record<string, TSchema> = offersWork ? { work: Type.Optional(Type.Union([Type.Literal('research'), Type.Literal('product')], { description: 'spawn and dispatch: what the worker is for (required when the manager launches one, and on every dispatch); a sub-agent takes its coordinator\'s' })) } : {};
  const workText = offersWork ? ` Every spawn or dispatch says what the worker is for with work: "research" for research, kernels, reverse engineering, theory, evals, measurements and experiments: it runs on ${person.research!.worker.model} (${person.research!.worker.thinking} thinking) unless you name another served model, with the same permissions as every other agent; "product" for anything ${person.name} sees or uses, Kenan Stack and other lifecycle software, deploys, operations, messages and purchases: it runs on ${person.worker.model} unless you name another model. Choose the model that fits the task; any host-served model and thinking may be selected for either category and for sub-agents. Research is the default choice for anything that is research. A research worker that needs a lifecycle fix dispatches a product worker for it.` : '';
  const guardRequestOnly = (model: string | undefined, herRequest: boolean | undefined) => {
    const refusal = requestOnlyRefusal(person, agent, model, herRequest);
    if (refusal) throw new Error(refusal);
    if (herRequest === true && model !== undefined) console.log(`her_request: ${agent.id} used herRequest for ${model}`);
  };
  const guardSpeed = (speed: string | undefined, herRequest: boolean | undefined) => {
    if (person.id === 'alice' && speed !== undefined && speed !== 'normal' && herRequest !== true) {
      throw new Error('request_only_speed: fast and ultrafast require Alice to explicitly ask; her Kenaznia passes herRequest: true.');
    }
    if (person.id === 'alice' && speed !== undefined && speed !== 'normal' && herRequest === true) console.log(`her_request: ${agent.id} used herRequest for ${speed} speed`);
  };
  /** Show productive background work separately from a wait that needs attention. */
  const warningOf = (worker: AgentInfo, wakes: Wake[], descendants: AgentInfo[] = []) => {
    const agents = [worker, ...descendants], progress = workerProgress(worker, agents);
    if (progress) return { progress: progressText(progress) };
    const line = waitingLine(worker, wakes, deps.now(), agents); return line ? { warning: line } : {};
  };
  /** A coordinator's entry carries its swarm's counts; its sub-agents are listed with workers list parent=<id>. */
  const swarmOf = (swarms: Map<string, AgentInfo[]>, id: string) => { const children = swarms.get(id); return children ? { swarm: swarmCounts(children) } : {}; };
  const tools: KenanTool[] = [{
    name: 'web_search', files: 'none', records: 'none', label: 'Web search', description: webSearchDescription(deps.config.webSearch, person),
    parameters: Type.Object({ query: Type.String() }),
    execute: async (_id, args: any, signal) => {
      const blind = await blindGoal(agent.goalId);
      if (blind) throw new Error(`web_search_blind_goal: goal ${agent.goalId} is blinded (${blind}), so web search is off for every worker on it: search results arrive unscreened and have carried excluded library material. Ask your manager for screened official extracts instead.`);
      return result(await searchWeb(deps.config.webSearch, person, args.query, signal));
    },
  }, {
    name: 'report', files: 'none', records: 'writes', label: 'Report', description: 'Report completion or a block once. Workers report to the agent that launched them. A completed worker is archived when its turn ends, unless by then it owns a pending wake or unfinished job, or a wake fired into that turn after the report: then the report is withdrawn and the run stays open. New work from the agent that launched it (or the manager) also withdraws a done report not yet archived: report that work once more. Blocked workers stay available. A worker that ends a turn without reporting while it owns no pending wake, unfinished job or active worker has its last message filed as its report. Managers remain available until explicitly archived.',
    parameters: Type.Object({ status: Type.Union([Type.Literal('done'), Type.Literal('blocked')]), text: Type.String() }),
    execute: async (_id, args: any) => {
      const call = liveCallOf(agent.id);
      if (call) throw new Error(`call_live: you are the call agent for call session ${call.id}, which is still live. Keep answering its requests and end your turn between them; report once the call has ended and you have its transcript.`);
      const current = agent.role === 'worker' ? await deps.store.getAgent(agent.id) : null;
      // New work can arrive while fileReport is writing done, after messageWorker checked an empty lastReport.
      // A late assignment withdraws that report just like a late wake; the follow-up replaces it once.
      const followsUp = current?.lastReport?.status === 'done' ? deps.runtime.lateReportWork(agent.id, [current.parentAgentId, deps.runtime.managerFor(person.id)].filter((id): id is string => !!id)) : [];
      if (current?.lastReport?.status === 'done' && !followsUp.length) {
        const parent = current.parentAgentId ? await deps.store.getAgent(current.parentAgentId) : null;
        const pending = await pendingWork(deps, current, isSubAgent(current, parent ?? undefined));
        return result(pending ? `already_reported: this run already reported done, and that report is withdrawn when this turn ends because you still own ${ownedText(pending)}; nothing was published now. End this turn; when that work has finished, report its outcome once more.` : 'already_reported: this run already reported done; nothing was published. Finish your turn without reporting again.');
      }
      if (args.status === 'done' && agent.role === 'worker') {
        const freshParent = current?.parentAgentId ?? agent.parentAgentId;
        const parent = freshParent ? await deps.store.getAgent(freshParent) : null;
        const pending = await pendingWork(deps, agent, isSubAgent(agent, parent ?? undefined)); if (pending) throw new Error(pendingWorkError(pending));
        const unread = deps.runtime.reportBasis(agent.id, [freshParent, deps.runtime.managerFor(person.id)].filter((id): id is string => !!id));
        if (unread.later.length) throw new Error(`unread_wake: wake ${unread.later.join(', ')} fired and its message starts your next turn, so a done report now would go out without it. End this turn without reporting; you will read it then and can report done if nothing is left.`);
        if (unread.next.length) throw new Error(`unread_wake: wake ${unread.next.join(', ')} fired and its message reaches you right after this call, so a done report now would go out without it. Read it first; then report done if nothing is left, or end your turn without reporting while you wait.`);
        if (unread.assigned.later.length) throw new Error(`unread_message: ${unread.assigned.later.join(', ')}, who assigns your work, sent you a message that starts your next turn, so a done report now would go out without it. End this turn without reporting; you will read it then and can report done if nothing is left.`);
        if (unread.assigned.next.length) throw new Error(`unread_message: ${unread.assigned.next.join(', ')}, who assigns your work, sent you a message that reaches you right after this call, so a done report now would go out without it. Read it first; then report the whole outcome.`);
      }
      await fileReport(deps, agent, args.status, followsUp.length ? `Follow-up, replacing its earlier done report (${followsUp.join(', ')} arrived after it):\n${args.text}` : args.text);
      return result(followsUp.length ? 'Report delivered; it replaces your earlier done report.' : 'Report delivered.');
    },
  }];
  /** A worker's mid-task note: shown in the parent's conversation and joined to its current turn; the worker keeps running. */
  const noteToParent = async (parentId: string, text: string) => {
    const parent = await deps.store.getAgent(parentId);
    if (!parent || parent.ownerId !== person.id) throw new Error(`Parent ${parentId} not found`);
    const route = await routeBackground(deps, parent, (await deps.store.getAgent(agent.id))?.originConversationId ?? null);
    const message = await deps.store.appendMessage({ conversationId: route.conversationId, authorId: agent.id, role: 'notice', notice: 'worker_note', text: `Note from worker ${agent.name}: ${text}` });
    deps.bus.toConversation(route.conversationId, { type: 'message', message });
    const stored = await deps.runtime.deliver({ agentId: parentId, kind: 'note', fromId: agent.id, ...route, text: `Worker ${agent.name} (${agent.id}), goal ${agent.goalId}, sends a note mid-task and is still running. Reply with workers message id ${agent.id}.\n${text}` });
    if (!stored.ok) throw new Error(`input_not_stored: the note could not be stored, so it was not delivered (${stored.detail}). Send it again.`);
  };
  /** workers message: any agent on the host, headed with who sent it and how to reply. A parent's message to its own worker (and Kenaznia's to any of its person's workers) is also the control path: speed, model, thinking, chatId. */
  const message = async (parent: string | null, args: any): Promise<string | Record<string, unknown>> => {
    if ([args.id, args.ids, args.to].filter(value => value !== undefined).length > 1) throw new Error('message_target_conflict: give id, ids or to, not more than one');
    if (args.ids !== undefined) {
      if (!Array.isArray(args.ids) || args.ids.length < 1 || args.ids.length > 50) throw new Error('message_ids_invalid: ids must contain 1–50 agent ids or unique 8+ character prefixes');
      return { results: await Promise.all(args.ids.map(async (id: unknown) => {
        try { return { id, delivered: true, result: await message(parent, { ...args, ids: undefined, id }) }; }
        catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          return { id, delivered: false, error: error instanceof IdFailure ? error.code : /^([a-z][a-z0-9_]+):/.exec(detail)?.[1] ?? 'message_failed', detail };
        }
      })) };
    }
    if (args.to !== undefined) return broadcast(args);
    if (typeof args.id !== 'string' || !args.id.trim()) throw new Error('id is required: the agent to message (workers find lists agents by goal, name, parent or person), ids: several agents, or to: a group to broadcast to');
    const ref = args.id.trim(), hint = parent ? `; to message your parent use id ${parent}` : '';
    const exact = await deps.store.getAgent(ref);
    if (exact && !ownersVisible(person, deps.person?.(exact.ownerId), exact.ownerId)) throw new IdFailure('agent_not_found', `agent_not_found: ${ref}`);
    // Your own person's agents first (the common case, one indexed query), then the whole host.
    const mine = parent !== null && ref === parent ? { ok: true as const, value: (await deps.store.getAgent(parent))! } : matchId(await deps.store.agentsMatching(person.id, ref), ref, 'agent', hint);
    if (!mine.ok && person.isolated) throw new IdFailure('agent_not_found', `agent_not_found: ${ref}`);
    if (!mine.ok && mine.code === 'agent_id_ambiguous') throw new IdFailure(mine.code, mine.message);
    const { agent: target, channel } = mine.ok ? { agent: mine.value, channel: null } : await directoryOf(deps).locate(ref, hint);
    if (!target || !ownersVisible(person, deps.person?.(target.ownerId), target.ownerId)) throw new Error(`agent_not_found: ${args.id}`);
    const control = target.ownerId === person.id && target.role === 'worker' && target.id !== parent && (agent.role === 'manager' || target.parentAgentId === agent.id);
    if (args.speed !== undefined && !control) throw new Error(target.id === parent ? 'speed_not_yours: speed sets a worker you launched; your own speed is set by your parent' : `speed_not_yours: speed sets a worker you launched, and ${target.id} isn't one`);
    const reprofile = args.model !== undefined || args.thinking !== undefined;
    if (args.model !== undefined || args.herRequest === true) guardRequestOnly(args.model, args.herRequest);
    guardSpeed(args.speed, args.herRequest);
    if (reprofile && !control) throw new Error(`profile_not_yours: model and thinking switch a worker you launched${target.id === parent ? '; yours are set by your parent' : `, and ${target.id} isn't one`}; nothing was sent`);
    if (args.chatId !== undefined && !control) throw new Error(`chat_not_yours: chatId sets where a worker you launched answers; ${target.id} isn't one, so nothing was sent`);
    if (!args.text && args.speed === undefined && !reprofile) throw new Error('text is required (or speed, thinking or model alone, to switch a worker you launched)');
    if (args.text !== undefined && args.text.length > MESSAGE_TEXT_LIMIT) throw new Error(`text: at most ${MESSAGE_TEXT_LIMIT} characters`);
    if (target.id === agent.id) throw new Error('message_to_self: that id is your own run');
    if (target.archived && target.id !== parent) {
      const store = channel?.store ?? deps.store;
      const active = target.goalId ? (await store.listAgents(target.ownerId, { goalId: target.goalId })).filter(w => w.role === 'worker' && !w.archived && w.state !== 'stopped' && w.id !== target.id) : [];
      const now = active.length ? ` Active now on its goal: ${active.map(w => `${w.name} (${w.id})${w.id === agent.id ? ' (you)' : ''}`).join(', ')}. Continue on this goal or message another listed worker.` : target.goalId ? ' No worker is active on its goal now.' : '';
      throw new Error(`recipient_archived: ${target.name} (${target.id}) is archived${target.lastReport ? ` after reporting ${target.lastReport.status}` : ''}; the message was not delivered and the run stays archived.${now}${control ? ` Restore it with workers restore id ${target.id} first only if current work needs that run back.` : ''}`);
    }
    if (control) {
      let switched = args.speed === undefined ? null : await controls.setWorkerSpeed(target.id, args.speed);
      if (reprofile) switched = await controls.setWorkerProfile(target.id, { model: args.model, thinking: args.thinking });
      if (!args.text) return { id: switched!.id, name: switched!.name, model: switched!.model, thinking: switched!.thinking ?? null, speed: switched!.speed };
      const where = args.chatId === undefined ? undefined : await chatTarget(deps, agent, args.chatId);
      const sent = await controls.messageWorker(target.id, messageText(senderOf(agent, person.name), target, args.text), agent.id, where);
      if (!sent.delivered && sent.error === 'input_not_stored') throw new Error(`input_not_stored: the message could not be stored, so it was not delivered (${sent.detail}). Send it again.`);
      if (!sent.delivered) throw new Error(`recipient_archived: ${target.name} (${target.id}) was archived as the message was sent; it was not delivered.`);
      return 'Done';
    }
    if (target.id === parent) { await noteToParent(parent, args.text); return `Note delivered to ${parent}; keep working.`; }
    await sendTo({ agent: target, channel }, args.text);
    const theirs = target.ownerId === person.id ? '' : ` It is ${deps.person(target.ownerId)?.name ?? target.ownerId}'s agent: never send it ${person.name}'s private context.`;
    return `${channel?.socket ? 'Queued durably for' : 'Delivered to'} ${target.role === 'manager' ? `${deps.person(target.ownerId)?.name ?? target.ownerId}'s Kenaznia` : `${target.name}`} (${target.id})${channel && !channel.here ? ` on the ${channel.channel} channel (within seconds)` : ''}; it joins its current or next turn, and its reply comes to you as a message.${theirs}`;
  };
  /** Delivers one message (headed for this recipient) to an agent here or on the other channel. */
  const sendTo = async ({ agent: target, channel }: Pick<Located, 'agent'> & { channel: Located['channel'] | null }, text: string, broadcastRef?: BroadcastRef) => {
    if (!ownersVisible(person, deps.person?.(target.ownerId), target.ownerId)) throw new Error(`agent_not_found: ${target.id}`);
    const from = senderOf(agent, person.name);
    if (channel === null || channel.here) return deliverHere(deps, (id, body, fromId) => controls.messageWorker(id, body, fromId), from, target, text, (await deps.store.getAgent(agent.id))?.originConversationId ?? null, broadcastRef);
    if (channel.socket) return queueLinkedMessage(deps, { agent: target, channel, personName: deps.person(target.ownerId)?.name ?? target.ownerId }, from, text, broadcastRef);
    const owner = deps.person(target.ownerId);
    if (!owner) throw new Error(`agent_not_found: ${target.id} belongs to ${target.ownerId}, who isn't a person in this channel's config`);
    await queueRemote(directoryOf(deps).inboxRoot, owner, from, target, text, deps.now(), broadcastRef);
  };
  /** workers message to a group: one message to each live agent in it, like a group chat; who it reached is kept for reply-all. */
  const broadcast = async (args: any): Promise<Record<string, unknown>> => {
    if (typeof args.to !== 'string') throw new Error('to: the group to broadcast to');
    if (args.id !== undefined) throw new Error('give id (one agent) or to (a group), not both');
    if (args.speed !== undefined || args.model !== undefined || args.thinking !== undefined || args.chatId !== undefined) throw new Error('speed, model, thinking and chatId set one worker you launched; a broadcast takes only to, text and person');
    if (!args.text) throw new Error('text is required');
    if (args.text.length > MESSAGE_TEXT_LIMIT) throw new Error(`text: at most ${MESSAGE_TEXT_LIMIT} characters`);
    const group = parseGroup(args.to);
    const persons = args.person === undefined ? [person.id] : args.person === 'everyone' ? null : [args.person];
    const directory = directoryOf(deps);
    const recipients = (await directory.group(group, person.isolated ? [person.id] : persons, agent.id)).filter(r => ownersVisible(person, deps.person?.(r.agent.ownerId), r.agent.ownerId));
    if (!recipients.length) throw new Error(`broadcast_empty: no running agent other than you is in ${args.to}${args.person === undefined && group.kind !== 'subtree' && group.kind !== 'broadcast' ? ` among ${person.name}'s agents (person: "everyone" or a person id reaches other people's)` : ''}; nothing was sent`);
    const ref: BroadcastRef = { id: randomUUID(), group: group.kind === 'all' ? `all of ${persons === null ? 'the host\'s' : `${persons.map(p => deps.person(p)?.name ?? p).join(', ')}'s`} running agents` : args.to.trim(), count: recipients.length };
    await writeBroadcast(directory.inboxRoot, { id: ref.id, from: senderOf(agent, person.name), group: ref.group, to: recipients.map(r => r.agent.id), at: deps.now() });
    const outcomes = await Promise.all(recipients.map(r => sendTo(r, args.text, ref).then(() => null, (e: Error) => ({ id: r.agent.id, name: r.agent.name, error: e.message }))));
    const failed = outcomes.filter(o => o !== null);
    const others = [...new Set(recipients.filter(r => r.agent.ownerId !== person.id).map(r => r.personName))];
    return {
      broadcast: ref.id, group: ref.group,
      delivered: recipients.filter(r => !r.channel.socket && !failed.some(f => f.id === r.agent.id)).map(r => `${r.agent.role === 'manager' ? `${r.personName}'s Kenaznia` : r.agent.name} (${r.agent.id})${r.agent.ownerId === person.id ? '' : `, ${r.personName}'s`}`),
      ...(recipients.some(r => r.channel.socket) ? { queued: recipients.filter(r => r.channel.socket && !failed.some(f => f.id === r.agent.id)).map(r => ({ id: r.agent.id, name: r.agent.name, person: r.personName })) } : {}),
      ...(failed.length ? { failed } : {}),
      replies: 'Replies come to you as messages; a reply-all (to broadcast:ID) reaches you too.',
      ...(others.length ? { otherPeople: `It reached ${others.join(', ')}'s agents: never send them ${person.name}'s private context.` } : {}),
    };
  };
  const goalByRef = (ref: unknown): Promise<Goal> => goalOf(deps, person.id, ref);
  /** archive closeGoal: the goal is marked done once the archived run was the last active top-level worker on it. */
  const closeGoalOf = async (run: AgentInfo): Promise<{ goalClosed: boolean; goalNotClosed?: string }> => {
    if (!run.goalId) return { goalClosed: false, goalNotClosed: 'the run has no goal' };
    const goal = await deps.store.getGoal(person.id, run.goalId);
    if (!goal || goal.status !== 'open') return { goalClosed: false, goalNotClosed: `the goal is ${goal?.status ?? 'missing'}` };
    const agents = await deps.store.listAgents(person.id, { goalId: goal.id, includeAncestors: true });
    const byId = new Map(agents.map(a => [a.id, a]));
    const others = agents.filter(w => w.role === 'worker' && w.goalId === goal.id && w.id !== run.id && w.id !== agent.id && !w.archived && w.state !== 'stopped' && !isSubAgent(w, w.parentAgentId ? byId.get(w.parentAgentId) : undefined));
    if (others.length) return { goalClosed: false, goalNotClosed: `still active on it: ${others.map(w => `${w.name} (${w.id})`).join(', ')}` };
    const done = await deps.store.updateGoal(goal.id, { status: 'done' });
    deps.bus.toPerson(person.id, { type: 'goal', goal: done });
    return { goalClosed: true };
  };
  /** The person's manager, whose membership decides whether a goal's chat can carry its answers. */
  const managerOf = async (): Promise<AgentInfo> => {
    if (agent.role === 'manager') return agent;
    const id = deps.runtime.managerFor(person.id);
    const manager = id ? await deps.store.getAgent(id) : null;
    if (!manager) throw new Error(`manager_not_found: ${person.name} has no manager to answer in a goal's chat`);
    return manager;
  };
  tools.push({
    name: 'goals', files: 'none', records: 'writes', label: 'Goals', description: 'List, get, create or update goals. Lists return {items,nextCursor}, 20 per page (max 50), open goals by priority first, with detail and notes cut to 500 characters (truncated: true); get returns one goal by id (or a unique 8+ character prefix), its full task detail, newest 6000 characters of notes, worker ids, held-trigger summaries and waiting workers. notesRange says exactly what was omitted: use notesOffset/notesLimit to page, or full:true for all notes and handoffs. A trigger full handoff is also available with wake get id. fields limits the result to the named fields (a blind task reads ["detail"] without the notes). Use status=all for history; repeat cursor with the same filters. Notes are a dated log, newest first: update with appendNote adds one entry at the top, stamped with the time (YYYY-MM-DD HH:MMZ — …) unless it starts with one; handoffs land there the same way. create and update return the goal\'s id, title, category, status, priority, chatId, updatedAt and the lengths of its detail and notes (get previews notes by default). notes replaces the whole notes field, history and handoffs included, and needs replaceNotes: true.' + (canChooseChat(person) ? ' chatId: one of the person\'s existing chats this goal belongs to (create/update; null clears). Workers and wakes inherit that origin; Organized answers there, Classic in your own chat. An explicit chatId on a spawn, message or wake still wins.' : '') + ' ' + categoryGuidance,
    parameters: Type.Object({ action: Type.Union([Type.Literal('list'), Type.Literal('get'), Type.Literal('create'), Type.Literal('update')]), id: Type.Optional(Type.String()), title: Type.Optional(Type.String({ maxLength: GOAL_TITLE_MAX, description: `create/update: at most ${GOAL_TITLE_MAX} characters` })), detail: Type.Optional(Type.String()), ...categoryParameter, priority: Type.Optional(Type.Number()), ...pageParameters, status: Type.Optional(Type.Union([Type.Literal('open'), Type.Literal('done'), Type.Literal('dropped'), Type.Literal('all')])), appendNote: Type.Optional(Type.String()), notes: Type.Optional(Type.String()), replaceNotes: Type.Optional(Type.Boolean()), ...(canChooseChat(person) ? { chatId: Type.Optional(Type.Union([Type.String(), Type.Null()], { description: 'create/update: one of the person\'s existing chats (an id from rooms list) this goal belongs to; null clears' })) } : {}), full: Type.Optional(Type.Boolean({ description: 'get: include complete notes and held handoffs instead of the default preview' })), notesOffset: Type.Optional(Type.Integer({ minimum: 0, description: 'get: character offset into notes, newest first; default 0' })), notesLimit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50000, description: 'get: note characters per page; default 6000, full:true returns all' })), fields: Type.Optional(Type.Array(Type.Union(GOAL_FIELDS.map(f => Type.Literal(f))), { description: 'get: return only these fields (with id), e.g. ["detail"] to read a goal without its notes' })) }),
    execute: async (_id, args: any) => {
      if (args.fields !== undefined && args.action !== 'get') throw new Error('fields is only valid for get');
      if (args.action === 'list') { const page = await deps.store.listGoalsPage(person.id, args); return result({ ...page, items: page.items.map(g => ({ ...g, detail: g.detail.slice(0,500), notes: g.notes.slice(0,500), truncated: g.detail.length > 500 || g.notes.length > 500 })) }); }
      if (args.status === 'all') throw new Error('status=all is only valid for list');
      if (args.action === 'get') {
        const goal = await goalByRef(args.id);
        const [agents, wakes] = await Promise.all([deps.store.listAgents(person.id), deps.store.pendingWakes(person.id)]);
        const held = wakes.filter(w => w.held?.goalId === goal.id).map(w => ({ ...wakeSummary(w), handoff: w.held!.handoff }));
        const waiting = agents.filter(a => a.goalId === goal.id).flatMap(a => { const line = waitingLine(a, wakes, deps.now(), agents); return line ? [{ id: a.id, name: a.name, warning: line }] : []; });
        return result(goalResult(goal, held, waiting, args));
      }
      let goal;
      const chat = args.chatId === undefined ? {} : { chatId: (await goalChat(deps, await managerOf(), args.chatId)).origin };
      if (args.action === 'create') {
        if (!args.title) throw new Error('title is required');
        goal = await deps.store.createGoal({ ownerId: person.id, title: args.title, detail: args.detail, priority: args.priority, category: args.category, ...chat });
      } else {
        const target = await goalByRef(args.id);
        if (args.notes !== undefined && args.appendNote !== undefined) throw new Error('notes_conflict: give appendNote (one new entry) or notes with replaceNotes: true (the whole field), not both');
        if (args.notes !== undefined && args.replaceNotes !== true) throw new Error('notes_replace_unconfirmed: notes replaces the goal\'s whole notes, its dated history and handoffs included, and nothing was changed. To log progress, use appendNote: it adds one dated entry at the top. To rewrite everything on purpose, pass the full new notes with replaceNotes: true.');
        const notes: NotesChange | undefined = args.appendNote !== undefined ? { kind: 'prepend', entry: args.appendNote } : args.notes !== undefined ? { kind: 'replace', text: args.notes } : undefined;
        const patch = Object.fromEntries(Object.entries(args).filter(([key, value]) => ['title', 'detail', 'priority', 'status', 'category'].includes(key) && value !== undefined));
        goal = await deps.store.updateGoal(target.id, { ...patch, ...chat, notes });
      }
      if (args.category !== undefined) await publishGoalCategory(deps, goal);
      else deps.bus.toPerson(person.id, { type: 'goal', goal });
      return result({ id: goal.id, title: goal.title, category: goal.category, status: goal.status, priority: goal.priority, chatId: goal.chatId, updatedAt: goal.updatedAt, detailChars: goal.detail.length, notesChars: goal.notes.length });
    },
  }, {
    name: 'workers', files: 'none', records: 'writes', parallelRecords: args => args?.action === 'spawn' ? 'spawn' : undefined, label: 'Workers', description: `List workers, peek at what they are doing, find and message any agent, spawn for an open goal, dispatch a worker under Kenaznia for new work, stop, archive or restore runs. activity (optional hours, id): per worker, commits pushed, GPU jobs and dollars, and report status over the last hours. Agents message each other like a group chat. find is the directory of every agent on the host (up to ${FIND_LIMIT}, active first): id, name, person, role, goalId, parent, model, state, idleS (seconds since its last activity) and, for ${person.name}'s own agents, goal (its title) and on (the end of what it last said); filter by goalId (id or prefix), name (part of it, any case), parent (id or prefix) and person (a person id such as carol); includeArchived=true adds archived runs. message (id, text) reaches any agent on the host by its id or a unique 8+ character prefix: your own workers and parent, other workers and their swarm sub-agents, research workers, Kenaznias, and other people\'s agents; it joins the recipient\'s current turn (before its next model call) or starts its next turn if it is idle (a Kenaznia reads it within about two minutes, after it finishes answering its person), and the sender keeps running. Every recipient sees who sent it and the id to reply to: reply with workers message id <sender>. message (ids, text) sends the same message to 1–50 ids or unique 8+ character prefixes in one call, with the same thinking, model and speed${canChooseChat(person) ? ', chatId' : ''} handling as id. It returns {results}: one {id, delivered, result} or {id, delivered: false, error, detail} per input, in order; one bad id does not block the others. Choose only one of id, ids or to. message (to, text) broadcasts: one message to each running agent in the group but you, delivered like any message: to "all", "goal:ID" (a goal's agents), "subtree:ID" (that agent and everyone below it), "name:TEXT" (names containing it) or "broadcast:ID" (reply-all: the sender and everyone a broadcast reached). all, goal and name reach ${person.name}'s agents unless person names another person or "everyone"; a broadcast's first line gives its id, so any recipient can answer the sender alone or reply-all. Being messaged too much? Say so (a reply-all works) and the others adjust. Another person\'s agent works for them, not for ${person.name}: never send it ${person.name}\'s private context. An archived recipient refuses the message (recipient_archived), naming the workers active on its goal now, and stays archived. A worker messages its parent, the id that launched it (for example manager:alice), to hand off something urgent mid-task: the note appears in the parent\'s conversation.${canChooseChat(person) ? ` A worker remembers the chat it was spawned or last messaged from by its launcher (a heartbeat or other background turn in your own chat leaves it unchanged), and its reports and notes are answered in that chat. When she asks for work to go to another chat ("do this, send it to Business"), give spawn or message chatId (that chat's id from rooms list; she and you must be in it and it must be open): the report and your answer then appear there, and you reply briefly where she asked ("On it: results will go to Business").` : ''} Lists return {items,nextCursor}, 20 per page (max 50), active workers (unarchived, not stopped) by default, running first; state narrows it. Idle workers with active helpers show progress ("coordinating N helpers"); those watching their own live job show "running job NAME". Other waits carry warning ("waiting 2h on …"); a long outside wait belongs to the manager as a held trigger (wake list shows those). Use includeArchived=true with state=all for history; repeat the same filters with the cursor. A child records you as its parent and reports to you. Archive finished runs, including your own run (omit id), when nothing remains to do; closeGoal: true also marks its goal done when no other worker is active on it (goalClosed says whether it did). Restore makes a run available without starting it; archive and restore return the run's id, name, state, archived, goalId and report status. Each listed worker shows its pending wakes. Helpers (swarm sub-agents) should usually be Terra (GPT) or Haiku (Claude), but choose what the task needs. spawn returns its id, name, goalId, state and selected model/thinking (not a copy of internal agent metadata). spawn may pin a worker's model and thinking (a model always with its thinking; thinking alone keeps the default model). message with thinking and/or model switches a worker you launched, keeping its conversation: thinking from its next model call, a model (same provider and kind of work) from its next turn. speed (spawn, or message to switch a running worker from its next model call): normal, fast or ultrafast. On GPT models fast is Codex's Fast tier (about 2x output speed on Astra, a smaller gain on Sol, none measured on Luna) and uses 2.5x the quota; ultrafast is Codex's Ultrafast (Astra and Sol only, up to 8x, 8x the quota) and needs a Pro $500 account in the pool. Claude runs normal only (its fast mode bills usage credits outside the subscription). A speed the model's route doesn't offer right now is refused with speed_unavailable, naming the speeds it offers; there is no fallback. Workers and sub-agents start at normal speed unless Alice explicitly asks for a faster speed and her Kenaznia passes herRequest: true. Astra and Fable are request-only under ${person.name}: a spawn, respawn, dispatch or model switch naming gpt-6-astra or claude-fable-* is refused with request_only_model unless ${person.name}'s Kenaznia passes herRequest: true because ${person.name} just asked for it (other agents cannot set it: her_request_not_yours). Sub-agents default to the model for their work category; choose any host-served model with its thinking when a different one fits the task. Below the configured shared Claude quota reserve, every non-Kenaznia Claude launch or model switch is refused with claude_reserved_for_kenaznia; choose GPT explicitly instead (no automatic fallback). Every spawn, pinned or not, is admitted only with a model and thinking this host's subscription route serves right now; otherwise it is refused with model_unavailable, which lists every supported model and its thinking levels (no fallback). A worker whose turn ends on a model or provider error it did not recover from files a blocked report to you with the evidence. A worker spawning for its own goal launches a swarm sub-agent (swarm_full, claude_reserved_for_kenaznia and swarm_depth are typed refusals). list and peek leave sub-agents out and give their coordinator counts of all descendants (total includes archived runs); list with parent=<id> lists that agent's own children. peek shows what workers are doing right now, read from their stored conversations: with id, one worker summary (last 2 messages, last 5 tool calls, last 3 turn inputs); full:true gives the longer view (last 6 messages, last 15 tool calls); without id, one line per active (unarchived, not stopped) worker, running first, at most ${PEEK_MAX_WORKERS}: name, goal, state, idle time, the last sentence it said and its last tool call, with ⚠ when it is waiting. The detailed view shows state, goal, the running turn (ageS, the inputs it answers, queued), live activity, idleS since its last stored activity, pending wakes and last report; tool calls carry short args and the start and end of their results; times are seconds ago; credential-looking text is redacted. An unknown or archived id is a typed error (worker_not_found, worker_archived, worker_id_ambiguous). Every id (id, goalId, parent) may be the full id or a unique prefix of at least 8 characters; one that matches nothing or several is worker_not_found/goal_not_found or worker_id_ambiguous/goal_id_ambiguous. Never spawn two active workers for one goal. dispatch (title, text, optional name, model and thinking, tools) launches a worker that is not yours: a new goal named title, with text as its brief and goal detail, and a top-level worker for it whose parent is ${person.name}'s Kenaznia, so it reports to ${person.name}\'s Kenaznia; Kenaznia gets no note for it (the goal shows as new in its next heartbeat, and your own report lists what you dispatched); you carry on with your own work. Use it when you hit a bug in a tool, the stack or a host service (a short title naming the bug; text with the evidence, the end state and the change you propose) or any other work that deserves its own owner. The worker is told who dispatched it, tells you in one line what changed when it reports, and you can message it directly. Search first: dispatch never starts a second worker on something an active worker already owns. Before dispatching, look with find (by name) or goals list for a worker already on it and message that worker instead; dispatch does the same search itself. An open goal with the same title, a component's standing owner, or an open goal from the last 6 hours whose title or brief overlaps strongly (the same tool named in any spelling with the same kind of problem, shared paths, error strings, a similar brief) gets your brief instead of a new worker: it arrives as a message from you and on that goal's notes, and you get dispatched: false, the reason (same_title, component_owner or likely_duplicate) and that worker's id to message. A goal whose worker reported done in the last 12 hours and overlaps strongly with your brief (the same component and kind of problem, or similar words) launches nothing either: you get dispatched: false, reason recently_resolved and that final report; if the problem is still there, dispatch again with force and a forceReason saying what is still broken. Standing owners: each of ${Object.keys(COMPONENTS).join(', ')} has at most one fixer at a time, the active worker of the oldest open goal whose title names it, and every dispatch whose title names it goes to that worker, which fixes them in batches; when it finishes, the next such dispatch launches the new owner. So name the component in the title (e.g. "gpurun: put stalls on a 30 MB archive"). force: true launches a separate worker anyway, only for genuinely different work, and needs forceReason saying why. reparent (id, parent) moves a worker that is not a swarm sub-agent, with its sub-agents, under another parent (a Claude worker or the manager; never a research worker, itself or one below it, or a worker on its own goal) without restarting it: its notes and report go to the new parent, the triggers held for its goal move to its new supervisor, and it gets a note saying so. Any worker may move workers this way. respawn (id, optional model, thinking, name, text) stops a worker you launched and starts a fresh one on its goal under the same parent, given its brief, last words and tool calls, checkouts and last report (text is added for the new one).${workText} ${categoryGuidance} list returns work under items and upkeep under system:{label,count,items}, with category on each worker; pagination covers both groups together. Compact peek returns work lines under workers and upkeep lines under system:{label,count,workers}; no worker appears twice.`,
    parameters: Type.Object({ action: Type.Union([Type.Literal('list'), Type.Literal('activity'), Type.Literal('find'), Type.Literal('spawn'), Type.Literal('message'), Type.Literal('stop'), Type.Literal('archive'), Type.Literal('restore'), Type.Literal('peek'), Type.Literal('dispatch'), Type.Literal('reparent'), Type.Literal('respawn')]), id: Type.Optional(Type.String()), ids: Type.Optional(Type.Array(Type.String(), { minItems: 1, maxItems: 50, description: 'message: send the same text to several agent ids or unique 8+ character prefixes; one result per id, including individual errors; use instead of id or to' })), full: Type.Optional(Type.Boolean({ description: 'peek with id: longer message/tool history instead of the default summary' })), hours: Type.Optional(Type.Number({ description: 'activity: hours back to look (default 6, at most 72)' })), title: Type.Optional(Type.String({ maxLength: GOAL_TITLE_MAX, description: `dispatch: the new goal's title, one line naming the work (at most ${GOAL_TITLE_MAX} characters)` })), goalId: Type.Optional(Type.String()), model: Type.Optional(Type.String()), thinking: Type.Optional(Type.String()), herRequest: Type.Optional(Type.Boolean({ description: 'Kenaznia only: set when the person has just explicitly asked for a request-only model (gpt-6-astra, claude-fable-*) or faster speed on spawn/message; logged' })), speed: Type.Optional(Type.Union([Type.Literal('normal'), Type.Literal('fast'), Type.Literal('ultrafast')], { description: 'spawn/message: how fast its model calls run; fast and ultrafast use more quota (see usage)' })), parent: Type.Optional(Type.String()), person: Type.Optional(Type.String({ description: 'find: only this person\'s agents (a person id, e.g. alice, carol); message with to: whose agents all, goal and name reach (default yours; "everyone" for every person\'s)' })), to: Type.Optional(Type.String({ description: 'message: broadcast to a group instead of one id: "all", "goal:ID", "subtree:ID", "name:TEXT", or "broadcast:ID" to reply-all' })), name: Type.Optional(Type.String({ maxLength: WORKER_TITLE_MAX, description: `spawn/dispatch/respawn: at most ${WORKER_TITLE_MAX} characters; find: a name fragment` })), text: Type.Optional(Type.String()), tools: Type.Optional(Type.Array(Type.String(), { description: 'spawn: optional tools the worker starts with beyond its core ones (e.g. mail, send, calendar; groups messaging, personal; or all). Names the brief and goal mention are added anyway, and the worker can add more with its tools tool' })), ...(canChooseChat(person) ? { chatId: Type.Optional(Type.String({ description: 'spawn/message: save this chat (an id from rooms list) as the work\'s origin; it answers there' })) } : {}), ...pageParameters, includeArchived: Type.Optional(Type.Boolean()), closeGoal: Type.Optional(Type.Boolean({ description: 'archive: also mark the worker\'s goal done when no other worker is active on it' })), force: Type.Optional(Type.Boolean({ description: 'dispatch: launch a separate worker even though an active worker already owns this (genuinely different work only); needs forceReason' })), forceReason: Type.Optional(Type.String({ description: 'dispatch with force: why this is different work from what the active worker is on' })), state: Type.Optional(Type.Union(['active','all','idle','running','stopped','interrupted','error'].map(v => Type.Literal(v)))), ...workParameter, ...categoryParameter }),
    execute: async (_id, args: any) => {
      if (args.action === 'list') {
        const parentId = args.parent === undefined || args.parent === agent.id || args.parent.startsWith('manager:') ? args.parent : resolveId(await deps.store.agentsMatching(person.id, args.parent, { includeBlank: true }), args.parent, 'agent').id;
        const [page, wakes] = await Promise.all([deps.store.listWorkersPage(person.id, { ...args, parent: parentId }), deps.store.pendingWakes(person.id)]);
        const swarms = workerDescendants(await deps.store.workerLineage(person.id, page.items.map(w => w.id)));
        const items = page.items.map(w => ({ ...w, category: w.category ?? 'work' as const, lastReport: w.lastReport && { ...w.lastReport, text: w.lastReport.text.slice(0,500), truncated: w.lastReport.text.length > 500 }, wakes: wakes.filter(wake => wake.agentId === w.id).map(wakeSummary), ...warningOf(w, wakes, swarms.get(w.id)), ...swarmOf(swarms, w.id) }));
        return result({ ...page, ...categoryGroups(items) });
      }
      if (args.action === 'activity') return result(await activityOf(deps, person.id, args));
      if (args.action === 'peek') {
        const blind = await blindGoal(agent.goalId);
        const wakes = await deps.store.pendingWakes(person.id);
        if (args.id) {
          const worker = resolveWorker((await deps.store.agentsMatching(person.id, args.id)).filter(w => w.role === 'worker'), args.id);
          const lineage = await deps.store.workerLineage(person.id, [worker.id]);
          if (blind && !ownSubtree(lineage, agent.id).has(worker.id)) throw new Error(`peek_blind_goal: goal ${agent.goalId} is blinded (${blind}), so you can peek only at your own sub-agents; another worker's context can carry material this goal must not see. Message it instead.`);
          const swarms = workerDescendants(lineage);
          return result({ now: new Date(deps.now()).toISOString(), worker: { ...(await peekWorkers(deps, person.id, [worker], args.full ? 'detailed' : 'summary', wakes))[0], ...warningOf(worker, wakes, swarms.get(worker.id)), ...swarmOf(swarms, worker.id) }, ...(!args.full ? { detail: 'Summary: last 2 messages, 5 tool calls and 3 turn inputs. workers peek id=<id> full=true shows 6 messages and 15 calls.' } : {}) });
        }
        const everyone = blind ? await deps.store.workerLineage(person.id, [agent.id]) : await deps.store.listAgents(person.id, { includeAncestors: true });
        const mine = blind ? ownSubtree(everyone, agent.id) : null;
        const workers = everyone.filter(w => w.role === 'worker' && (!mine || mine.has(w.id)));
        const rank = (w: AgentInfo) => w.state === 'running' ? 0 : 1;
        const subAgents = new Set([...swarmsOf(workers).values()].flat().map(w => w.id));
        const active = workers.filter(w => !w.archived && w.state !== 'stopped' && (mine !== null || !subAgents.has(w.id))).sort((a, b) => rank(a) - rank(b) || b.updatedAt - a.updatedAt);
        const selected = active.slice(0, PEEK_MAX_WORKERS);
        const [shown, lineage] = await Promise.all([peekWorkers(deps, person.id, selected, 'compact', wakes), deps.store.workerLineage(person.id, selected.map(w => w.id))]);
        const swarms = workerDescendants(lineage);
        const lines = shown.map((view, i) => peekLine(view, { ...warningOf(active[i]!, wakes, swarms.get(active[i]!.id)), ...swarmOf(swarms, active[i]!.id) }));
        const system = lines.filter((_line, i) => shown[i]!.category === 'upkeep');
        return result({ now: new Date(deps.now()).toISOString(), workers: lines.filter((_line, i) => shown[i]!.category !== 'upkeep'), system: { label: 'System', count: system.length, workers: system }, omitted: Math.max(0, active.length - PEEK_MAX_WORKERS), detail: 'workers peek id=<id> shows one worker in detail' });
      }
      if (args.action === 'spawn') {
        if (!args.goalId || !args.text) throw new Error('goalId and text are required');
        guardRequestOnly(args.model, args.herRequest);
        guardSpeed(args.speed, args.herRequest);
        const target = args.chatId === undefined ? undefined : await chatTarget(deps, agent, args.chatId);
        const fresh = await controls.spawnWorker(person.id,args.goalId,args.name??'Worker',args.text,agent.id,args.model||args.thinking?{model:args.model,thinking:args.thinking}:undefined,target,args.work,args.tools,args.speed,args.category);
        return result({ id: fresh.id, name: fresh.name, goalId: fresh.goalId, state: fresh.state, model: fresh.model, thinking: fresh.thinking, ...(fresh.speed !== 'normal' ? { speed: fresh.speed } : {}) });
      }
      if (args.action === 'dispatch') { guardRequestOnly(args.model, args.herRequest); }
      if (args.action === 'dispatch') return result(await dispatchWorker(deps, controls, person, (await deps.store.getAgent(agent.id)) ?? agent, { title: args.title, text: args.text, name: args.name, category: args.category, work: args.work, model: args.model, thinking: args.thinking, tools: args.tools, force: args.force, forceReason: args.forceReason }));
      if (args.action === 'respawn') {
        if (!args.id) throw new Error('id is required: the worker to replace with a fresh one');
        const old = resolveId((await deps.store.agentsMatching(person.id, args.id.trim())).filter(a => a.role === 'worker'), args.id.trim(), 'worker');
        if (agent.role !== 'manager' && old.parentAgentId !== agent.id) throw new Error(`respawn_not_yours: you can respawn a worker you launched, and ${old.id} isn't one`);
        if (!old.goalId) throw new Error(`respawn_no_goal: ${old.name} has no goal to start a fresh worker on`);
        const name = (args.name ?? old.name).trim();
        const long = titleRefusal('name', name);
        if (long) throw new Error(long);
        const models = await researchModels(deps.config);
        const model = args.model ?? old.model;
        await assertWorkerQuota(deps, person.id, model);
        if (args.model !== undefined) guardRequestOnly(args.model, args.herRequest);
        const thinking = args.thinking ?? old.thinking ?? (models.has(model) ? person.research?.worker.thinking : person.worker.thinking) ?? 'medium';
        const task = await handoffFor(deps, person.id, old, args.text);
        const tools = await readGrant(agentConfigDir(deps.config.dataDir, old.id)) ?? undefined;
        await controls.stopAgent(old.id);
        try {
          const fresh = await controls.spawnWorker(person.id, old.goalId, name, task, old.parentAgentId ?? agent.id, { model, thinking }, undefined, models.has(model) ? 'research' : 'product', tools, old.speed, args.category);
          return result({ replaced: old.id, id: fresh.id, name: fresh.name, model: fresh.model, thinking: fresh.thinking ?? null, goalId: fresh.goalId, category: fresh.category, handoffChars: task.length });
        } catch (error) {
          await controls.archiveAgent(old.id, false);
          throw new Error(`${(error as Error).message} (respawn: the old worker ${old.id} was restored, idle; message it to carry on)`);
        }
      }
      if (args.action === 'reparent') {
        if (!args.id || !args.parent) throw new Error('id and parent are required: the worker to move and its new parent (a Claude worker or the manager)');
        const [runs, parents] = await Promise.all([deps.store.agentsMatching(person.id, args.id), deps.store.agentsMatching(person.id, args.parent, { includeBlank: true })]);
        const worker = resolveId(runs.filter(a => a.role === 'worker'), args.id, 'worker');
        const newParent = resolveId(parents, args.parent, 'agent');
        const moved = await controls.reparentWorker(worker.id, newParent.id, agent.id);
        return result({ id: moved.worker.id, name: moved.worker.name, parentAgentId: moved.worker.parentAgentId, previousParent: moved.previousParent, movedTriggers: moved.movedTriggers });
      }
      if (args.action === 'find') {
        if (person.isolated && args.person !== undefined && args.person !== person.id) return result({ items: [], limit: FIND_LIMIT });
        const found = (await directoryOf(deps).find({ goal: args.goalId, name: args.name, parent: args.parent, person: person.isolated ? person.id : args.person, includeArchived: args.includeArchived === true })).filter(l => ownersVisible(person, deps.person?.(l.agent.ownerId), l.agent.ownerId));
        // Idle time from each channel's stored conversations; what it is on (its goal and last words) only for your own person's agents.
        const byChannel = new Map<string, Located[]>();
        for (const l of found) byChannel.set(l.channel.channel, [...(byChannel.get(l.channel.channel) ?? []), l]);
        const work = new Map<string, RecentWork>();
        await Promise.all([...byChannel.values()].map(async ls => { for (const [k, v] of await ls[0]!.channel.store.recentWork(ls.map(l => l.agent.conversationId), { said: 1, did: 0, chars: 400 })) work.set(k, v); }));
        const goalIds = [...new Set(found.filter(l => l.agent.ownerId === person.id && l.agent.goalId).map(l => l.agent.goalId!))];
        const titles = new Map((await Promise.all(goalIds.map(id => deps.store.getGoal(person.id, id)))).flatMap(g => g ? [[g.id, g.title] as const] : []));
        const now = deps.now();
        const line = (text: string) => { const t = redact(text).replace(/\s+/g, ' ').trim(); return t.length <= 200 ? t : `…${t.slice(-200)}`; };
        return result({ items: found.map(({ agent: a, channel, personName }) => {
          const recent = work.get(a.conversationId), turn = channel.here ? deps.runtime.turnOf(a.id) : null;
          const said = a.ownerId === person.id ? recent?.said.at(-1)?.text?.trim() : undefined;
          return { id: a.id, name: a.name, person: personName, role: a.role, goalId: a.goalId, category: a.category ?? 'work', ...(a.goalId && titles.has(a.goalId) ? { goal: titles.get(a.goalId) } : {}), parentAgentId: a.parentAgentId, state: a.state, idleS: Math.max(0, Math.round((now - Math.max(recent?.lastActivityAt ?? a.updatedAt, turn?.startedAt ?? 0)) / 1000)), ...(said ? { on: line(said) } : {}), archived: a.archived, model: a.model, lastReport: a.lastReport?.status ?? null, ...(channel.here ? {} : { channel: channel.channel }) };
        }), limit: FIND_LIMIT });
      }
      const parent = agent.role === 'worker' ? await parentOf(ctx) : null;
      if (args.action === 'message') {
        const refusal = await meetingAgentMessageRefusal(agent.id);
        if (refusal) throw new Error(refusal);
        return result(await message(parent, args));
      }
      const ref = args.id ?? ((args.action === 'archive' || args.action === 'restore') ? agent.id : undefined);
      // Only the runs this reference can name: listing all of a person's runs (8,000+ for Alice) on every call was slow under load.
      const runs = (typeof ref === 'string' && ref.trim() ? await deps.store.agentsMatching(person.id, ref.trim()) : []).filter(a => a.role === 'worker' || a.id === agent.id);
      const named = resolveId(runs, ref, 'worker');
      if (named.role !== 'worker' && named.id !== agent.id) throw new Error(`worker_not_found: ${ref} is not one of your workers`);
      const worker = named;
      if (args.action === 'stop') await controls.stopAgent(worker.id);
      else if (args.action === 'archive' || args.action === 'restore') {
        if (args.closeGoal !== undefined && args.action !== 'archive') throw new Error('closeGoal is only for archive');
        const run = await controls.archiveAgent(worker.id, args.action === 'archive');
        const closed = args.closeGoal === true ? await closeGoalOf(run) : {};
        return result({ id: run.id, name: run.name, state: run.state, archived: run.archived, goalId: run.goalId, lastReport: run.lastReport ? run.lastReport.status : null, ...closed });
      }
      return result('Done');
    },
  }, {
    name: 'attach', files: 'reads', records: 'none', label: 'Attach', description: `Send files as a chat message from you in your own conversation${agent.role === 'manager' ? ` with ${person.name}${canChooseChat(person) ? ' (in the chat your current turn answers)' : ''}` : ` (${person.name} sees it when she opens your run; to put a file in front of her, give your parent the paths and it attaches them)`}. They look exactly like her own attachments: images (PNG, JPEG, GIF, WebP, SVG, AVIF, BMP) inline and tappable to full size, any other file as a download chip. paths: 1–${ATTACH_LIMITS.files} files your account can read (absolute, ~/… or relative to your home), each up to ${ATTACH_LIMITS.fileBytes / 1048576} MiB and ${ATTACH_LIMITS.totalBytes / 1048576} MiB together. They are copied when sent, so later edits on disk don't change the message. text: optional words shown with the files (markdown). An unreadable path sends nothing and returns attach_unreadable with the reason for each path.`,
    parameters: Type.Object({ paths: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: ATTACH_LIMITS.files }), text: Type.Optional(Type.String()) }),
    execute: async (_id, args: any) => {
      const stored = await storeOwnerFiles(deps, deps.placement, person, args.paths);
      if (!stored.ok) throw new Error(attachErrorText(stored.error));
      const conversationId = answeringChat(agent, deps.runtime.turnOf(agent.id));
      const message = await deps.store.appendMessage({ conversationId, authorId: agent.id, role: 'assistant', display: 'shown', text: args.text ?? '', parts: stored.files.map(filePart) });
      queueKenazniaNotification(deps, message);
      deps.bus.toConversation(conversationId, { type: 'message', message });
      return result({ messageId: message.id, files: stored.files.map(f => ({ name: f.name, mime: f.mime, size: f.size })) });
    },
  }, {
    name: 'notify', files: 'reads', records: 'none', label: 'Notify', description: `Send ${person.name} a notification on her phone through the Kenan app. level "normal" is an ordinary notification. level "urgent" rings on the alarm stream through silent mode and Do Not Disturb: use it only for a genuine emergency, never for routine progress, calendar events or deliveries. All normal notifications obey her quietHours setting in the time zone reported by her phone. During quiet hours the result says held: true and quietHours.active: true, with zero devices alerted. The message still arrives in the app. Held alerts never replay individually; at the end of quiet hours there is at most one summary. Do not switch a held normal alert to urgent. Keep the title short; the body says what happened and what, if anything, she should do. imagePath (optional): an image file your account can read, shown as the notification's picture. Tapping it opens ${canChooseChat(person) ? 'the chat your current turn answers, else ' : ''}your own chat. connectedPhones counts Android apps listening right now (one that connects within a day still shows it, silently once it is over ten minutes old); webAppDevices counts installed web apps (an iPhone home-screen app) whose push service accepted it, where urgent is an ordinary notification because iOS gives web apps no alarm stream.`,
    parameters: Type.Object({ title: Type.String({ minLength: 1, maxLength: 120 }), body: Type.String({ minLength: 1, maxLength: 2000 }), level: Type.Union([Type.Literal('normal'), Type.Literal('urgent')]), imagePath: Type.Optional(Type.String({ minLength: 1 })) }),
    execute: async (_id, args: any) => {
      let imageFileId: string | null = null;
      if (args.imagePath !== undefined) {
        const mime = getMimeType(args.imagePath);
        if (!mime || !PHONE_IMAGES.has(mime)) throw new Error(`notify_image_not_image: ${args.imagePath} is ${mime ?? 'of unknown type'}; imagePath takes a .png, .jpg, .gif, .webp or .bmp file`);
        const stored = await storeOwnerFiles(deps, deps.placement, person, [args.imagePath]);
        if (!stored.ok) throw new Error(attachErrorText(stored.error));
        imageFileId = stored.files[0]!.id;
      }
      return result(await notify(deps, person.id, agent, answeringChat(agent, deps.runtime.turnOf(agent.id)), { title: args.title, body: args.body, level: args.level, imageFileId }));
    },
  }, { name: 'usage', files: 'none', records: 'reads', label: 'Usage', description: 'Read subscription quota, drain, reset and projected exhaustion per pool/account, API-list-price spend and prompt-cache rates. detailed:true adds per-agent/swarm spending and cache offenders.', parameters: Type.Object({ detailed: Type.Optional(Type.Boolean()) }),
    execute: async (_id, args) => result(usageToolResult(await usageReport(deps, person.id), (args as { detailed?: boolean }).detailed)) });
  if (agent.role === 'manager') tools.push(sealGuessTool(ctx));
  return tools;
}
