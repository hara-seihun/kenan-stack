import { liveExtensionTool, releaseLiveExtensionCalls } from '../live-extensions.js';
import { queueKenazniaNotification } from '../chat-notify.js';
import { allowanceMessage, budgetStream, isAllowanceMessage } from './person-budget.js';
import { ownersVisible, personToolAllowed } from './person-isolation.js';
import { publicToolArgs } from '../tools/seal-guess.js';
import { replacePartsText, splitTextParts } from '../../shared/message-parts.js';
import { noteToolCall } from './service-activity.js';
import { redactCredentials, redactedTool } from '../redact.js';
import { UNSHOWN_NOTE } from '../../shared/toolNotes.js';
import { owedModelCall, resumeModelCall } from './resume.js';
import { QUOTA_WAKE_REASON, quotaHoldUntil, quotaResumeAt, quotaResumeText } from './quota-hold.js';
import { installStreamWatchdog } from './stream-watchdog.js';
import { titleRefusal } from './dispatch.js';
import { categoryGuidance, publishGoalCategory } from './goal-category.js';
import { dropForeignThinking } from './foreign-thinking.js';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type AgentSession, type InlineExtension } from '@earendil-works/pi-coding-agent';
import type { Message as LlmMessage, StopReason } from '@earendil-works/pi-ai';
import { BG_END, BG_START, backgroundPieces, endsWithNoReply, isNoReply, shownWhileStreaming, mayBeNoReply, stripNoReply, type Activity, type AgentInfo, type GoalCategory, type ConversationSummary, type Message, type MessageDisplay, type MessagePart, type NoticeKind, type Waiting, BUSY_LINE } from '../../shared/contract.js';
import type { AgentInput, AgentTurn, Delivery, Deps, Interrupted, Runtime, KenanTool, StoredInput, UnreadFirings, ToolContext } from '../types.js';
import type { ModelProvider, PersonConfig } from '../config.js';
import { assertAllowedProvider, hostedManager, DEFAULT_SWARM_MAX_ACTIVE, swarmMaxActive } from '../config.js';
import type { SpawnRequest } from './worker-profile.js';
import { configurePool, turnWorkClass } from '../pool.js';
import { admitModel, admitProviderAvailability, routeChoices, THINKING_LEVELS, type RouteChoice } from './model-route.js';
import { applySpeed, serviceTierOf, speedRefusal, type Speed } from './speed.js';
import { ownerTools } from '../tools/owner.js';
import { acknowledgeForeground, acknowledgeForegroundJournal, foregroundRoot, recoveredForeground } from '../tools/foreground.js';
import { trimSessionFile } from './session-trim.js';
import { rewriteSessionFile, sessionFileContains, sessionValueContains } from './session-rewrite.js';
import { messageRewriter } from '../message-rewrite.js';
import { orderedCalls } from '../tools/order.js';
import { goalOf } from '../ids.js';
import { ownedText, pendingWork, tolerantCensus } from './pending-work.js';
import { controlTools, fileReport, type Controls, type MessageOutcome } from '../tools/control.js';
import { heartbeatText } from './heartbeat.js';
import { COMPACT_NOW_FILE, compactionRequestFile, describeFailures, installContextBudget } from './context-budget.js';
import { isRefusal, rejectedFailure, rejectedText, withoutRejected } from './refusal.js';
import { promptInput } from './attachments.js';
import { BLANK_PROMPT } from './blank.js';
import { chatContext } from './chat-context.js';
import { humansIn, routeSharedMessage } from '../channels/kenan.js';
import { sendTool } from '../channels/send.js';
import { ADDRESSED_INPUTS, describeTrigger, fireOnInput, SHORT_WAIT_MS, wakeTool } from './wakes.js';
import { peerTool } from '../peers.js';
import { agentConfigDir, chooseTools, declared, readGrant, toolsTool, writeGrant } from './tool-scope.js';
import { canChooseChat, goalOrigin, originOf, placeOf, resumeRoute, retargeted, routeBackground, routesByChat, type Origin } from './origin.js';
import { liveAnswered } from './live.js';
import { draftLabel, TOOL_DRAFT_MS, toolDraft } from './tool-draft.js';
import { currentLocation, locationLine } from '../extensions/phone-location.js';
import { liveCallOf } from '../extensions/phone.js';
import { contextSections } from './context-files.js';
import { clockIn, HOME_ZONE, type ZoneReport } from '../../shared/zone.js';
import { assertPersonModel, assertWorkerQuota } from './worker-quota.js';
import { checkReparent, supervisorIn, supervisorOf } from './hierarchy.js';
import { isSubAgent, subAgentActive, swarmsOf, topWorker, workerDescendants } from '../../shared/swarm.js';

/** steered: inputs handed to Pi's steering queue during the active turn, in queue order. settling: the turn's prompt has returned, so new input waits for the next turn. */
type Lane = { rewriting?: boolean; budgetExhausted?: boolean; accounting?: Promise<void>; /** Restoring a still-running turn withdraws its completion; its old answer cannot become a new implicit report. */ restoredTurn?: AgentInput[]; recoverForeground?: () => Promise<string>; queue: AgentInput[]; /** Inputs handed to Pi (the prompt, each steer) that its transcript does not hold yet, by the exact text Pi was given. */ unread: { text: string; inputs: AgentInput[] }[]; /** The lane's stores in arrival order. */ storing?: Promise<unknown>; notices?: Promise<void>; session?: AgentSession; sessionGeneration?: AgentRuntime; sessionCallbacks?: (() => void)[]; tools?: Map<string, KenanTool>; toolDefinitions?: Map<string, KenanTool>; toolExecutions?: Map<string, KenanTool['execute']>; creating?: Promise<AgentSession>; active?: AgentInput[]; startedAt?: number; steered: AgentInput[]; /** Inputs that joined this turn by steering: the turn's own prompt leaves them out, so a joiner that was added to the batch before the prompt was written is read once. */ joined: Set<AgentInput>; /** Joined inputs the model has not read yet (they reach it at its next call). */ unseen: Set<AgentInput>; /** How many inputs had joined this turn when its done report was checked: new work that joins after it withdraws the report. */ reportBasis?: number; prompted: boolean; /** The turn resumes an interrupted model call. Workers release waiting input before the request; managers keep their gathering policy. */ resending: boolean; /** The turn is waiting on (or about to resend) a model call, with no tool call outstanding. */ calling: boolean; settling: boolean; cutOff: boolean; pumping: boolean; preempting: boolean; /** The run ended for good (archive, shutdown); a person's Stop is `stopping`. */ stopped: boolean; /** A person's Stop is ending the running turn. Input queued meanwhile stays queued and runs next. */ stopping: boolean; /** The previous turn was ended by a person's Stop: the next prompt says so. */ stoppedTurn: boolean; /** The run is archived: anything that still reaches this lane goes to its heir (orphan). */ archived?: boolean; task?: Promise<void>; steering?: Promise<void>; /** The person's waiting state publications, in order. */ waiting?: Promise<void>; /** A manager's queued background input waits for this timer to start its turn as one batch (coalesce). */ gathering?: ReturnType<typeof setTimeout>; /** The running turn answers a person and nothing it wrote has been shown yet. */ unshown?: boolean; /** The model call the last turn ended on, failed and not resent by Pi, with its evidence. */ failure?: string; /** The Codex service_tier its model calls carry now (speed.ts); undefined: normal. */ serviceTier?: string; /** Drops an idle worker's session from memory (IDLE_SESSION_MS). */ release?: ReturnType<typeof setTimeout> };
/** Messages between agents join the recipient's running turn, as human messages join a human turn. */
const STEERED_KINDS = new Set<AgentInput['kind']>(['agent', 'note', 'report', 'wake']);
const HEARTBEAT_CHECK_MS = 60_000;
const IDLE_SESSION_MS = 60 * 60_000;
/**
 * A person's Kenaznia takes background input (worker notes and reports, peer messages, wakes, heartbeats, call and meeting
 * outcomes) in batches, never one by one in the middle of a turn: on 2026-10-23 its single lane read 500 of them a day, each
 * steered into whatever turn was running, so answers to Alice stopped to archive workers and file notes, and every one cost
 * its own model call. Queued background input starts a turn once none has arrived for quietMs, or once the oldest has
 * waited capMs, and that turn takes all of it (for its chat) as one digest.
 */
export type Gathering = { quietMs: number; capMs: number };
export const BACKGROUND_GATHERING: Gathering = { quietMs: 30_000, capMs: 120_000 };
/** Tests and anything that must see each input's own turn at once. */
export const NO_GATHERING: Gathering = { quietMs: 0, capMs: 0 };
/** Input that is about no person's message: what a manager gathers into background batches. */
export const isBackground = (input: AgentInput): boolean => !input.live && !input.resume && (input.kind === 'report' || input.kind === 'note' || input.kind === 'agent' || input.kind === 'wake' || input.kind === 'heartbeat' || input.kind === 'external');
/** What a firing's text starts with, so the transcript shows whether the agent has already read it (the id alone also appears where the wake was scheduled). */
const firingMarkers = (firingId: string): string[] => [`Your wake ${firingId} fired`, `Held trigger ${firingId} for`];
/** Inputs delivering a wake firing that the transcript already holds or that appears earlier in the same batch. */
export function repeatedFirings(batch: AgentInput[], transcript: readonly unknown[]): AgentInput[] {
  const wakes = batch.filter(input => input.firingId !== undefined);
  if (!wakes.length) return [];
  const seen = new Set<string>();
  const history = JSON.stringify(transcript);
  return wakes.filter(input => {
    const id = input.firingId!;
    const repeat = seen.has(id) || firingMarkers(id).some(marker => history.includes(marker));
    seen.add(id);
    return repeat;
  });
}
/** The turn starting now with these queued background inputs, or how long to wait for more: the quiet window after the newest, capped from the oldest. */
export function gatherDelay(gathering: Gathering, arrivals: number[], now: number): number {
  if (!arrivals.length) return 0;
  const wait = Math.min(Math.max(...arrivals) + gathering.quietMs, Math.min(...arrivals) + gathering.capMs) - now;
  return wait > 0 ? wait : 0;
}
/** Told with a batch of several background inputs, ahead of them. */
export const digestHeader = (count: number): string => `[${count} background inputs arrived while you were busy or within a few seconds of each other. They are all below; handle them together in this one turn.]`;
const SHUTDOWN_WAIT_MS = 5_000;
/** Inputs from no person that leave no other trace in the recipient's conversation get a notice there when they arrive. Messages to workers are shown; other inputs fold away. Notes and peer messages bring their own. */
const INPUT_NOTICES: Partial<Record<AgentInput['kind'], NoticeKind>> = { agent: 'agent_message', report: 'worker_report', wake: 'wake', heartbeat: 'heartbeat', restart: 'system', channel: 'channel' };
/** Inputs that continue a cut-off turn: when that turn was answering a person, so is its continuation. */
const CONTINUATIONS = new Set<AgentInput['kind']>(['restart']);
/** A running turn takes in (steers) input from the same chat, or when neither is bound to its chat (a person on the Classic layout). Batches are always one chat's (untilBatchEnd). */
export const shareTurn = (a: AgentInput, b: AgentInput): boolean => a.conversationId === b.conversationId || (!a.chatBound && !b.chatBound);
/** A manager's turn answers background input when none of its inputs came from a person; its work folds away and only real text replies show. A worker's own chat is its work, so it all shows. */
/** How many queued inputs join a non-human first input's turn: those up to the next human input or the next input of
 *  another conversation, since the turn's answer lands in the first input's conversation. */
export function untilBatchEnd(queue: AgentInput[], first: AgentInput): number {
  const end = queue.findIndex(i => i.kind === 'human' || i.conversationId !== first.conversationId);
  return end < 0 ? queue.length : end;
}
/** Her chats with a message queued behind the running turn, each with how many queued turns go before it, read from the
 *  lane as the pump takes it (a human input is a turn of its own; other inputs batch up to the next human or another chat).
 *  The chat the running turn answers is left out: that message is already being answered there. */
export function queuedChats(personId: string, turnChat: string, queue: AgentInput[]): Record<string, number> {
  const queued: Record<string, number> = {};
  for (let at = 0, turns = 0; at < queue.length; turns++) {
    const first = queue[at]!;
    if (first.kind === 'human' && first.fromId === personId && first.conversationId !== turnChat && !(first.conversationId in queued)) queued[first.conversationId] = turns;
    at += first.kind === 'human' || first.resume ? 1 : 1 + untilBatchEnd(queue.slice(at + 1), first);
  }
  return queued;
}
/** How every agent learns the ::bg marker (shared/contract.ts backgroundPieces). */
export const BACKGROUND_BLOCKS = `Working narration that isn't for the person (notes to yourself between tool calls, what you're trying next) goes in a background block: a line starting with ${BG_START} begins it and a line starting with ${BG_END} ends it, or the end of the message does, so a message that starts with ${BG_START} is all background. The app folds that text into a compact background row, expandable, never notified or previewed; the rest of the message shows as normal.`;
export const answersBackground = (role: AgentInfo['role'], batch: AgentInput[]): boolean => role === 'manager' && !batch.some(input => input.kind === 'human' || input.kind === 'room' || input.kind === 'channel');
/** How a finished assistant message is drawn: an exact NO_REPLY is silent; in a background turn, a message without words (empty, or a cut-off NO_REPLY) is background. */
export function finishedDisplay(text: string, background: boolean): MessageDisplay {
  if (isNoReply(text) || (background && endsWithNoReply(text))) return 'silent';
  return background && mayBeNoReply(text) ? 'background' : 'shown';
}
/**
 * Added to every tool result of a turn that answers a person while nothing it wrote has been shown: thinking is never shown,
 * and on Beta 2026-10-24 04:46Z Kenaznia drafted its answer to Alice while thinking, ran tools, and then believed it had sent it.
 */
export { UNSHOWN_NOTE };
export function noteWhileUnshown(tool: KenanTool, unshown: () => boolean): KenanTool {
  return {
    ...tool,
    execute: async (...args) => {
      const result = await tool.execute(...args);
      return unshown() ? { ...result, content: [...result.content, { type: 'text', text: UNSHOWN_NOTE }] } : result;
    },
  };
}
/** Pi keeps these definitions for the whole turn; each new call selects the current implementation. */
function dispatchTools(definitions: Map<string, KenanTool>): KenanTool[] {
  return [...definitions].map(([name, initial]) => {
    const current = () => {
      const tool = definitions.get(name);
      if (!tool) throw new Error(`tool_removed: ${name}`);
      return tool;
    };
    return {
      ...initial,
      get files() { return current().files; },
      get records() { return current().records; },
      parallelRecords: args => current().parallelRecords?.(args),
      streamArgs: (id, args) => current().streamArgs?.(id, args),
      execute: (...args) => current().execute(...args),
    };
  });
}
/** Exactly once per turn: the batch holds each input once, and nothing it holds stays queued behind it. */
export function dedupe(agentId: string, batch: AgentInput[], queue: AgentInput[]): void {
  const seen = new Set<AgentInput>();
  for (let i = 0; i < batch.length; i++) {
    if (seen.has(batch[i]!)) { console.log(JSON.stringify({ type: 'input_duplicate', agentId, kind: batch[i]!.kind, fromId: batch[i]!.fromId, where: 'batch' })); batch.splice(i--, 1); }
    else seen.add(batch[i]!);
  }
  for (let i = 0; i < queue.length; i++) if (seen.has(queue[i]!)) { console.log(JSON.stringify({ type: 'input_duplicate', agentId, kind: queue[i]!.kind, fromId: queue[i]!.fromId, where: 'queue' })); queue.splice(i--, 1); }
}
/** A prompted input is already in the transcript, so a cut-off turn is resumed with a notice, never by sending its input again. */
export const STOP_NOTICE = 'Your previous turn was ended by the Stop button. Don\'t pick its work back up unless asked. The messages that were waiting for you follow; read and answer them.';
export const PREEMPT_NOTICE = 'Your previous turn was stopped so you could answer the message below first. Its input and the work it did are above. After answering, finish whatever it left undone. Before repeating a tool call from it, check whether it already took effect.';
/** Pi retries a transient model-call failure (connection, broker restart, 5xx, overload) inside the same turn, backing off to a minute between attempts for eight retries (242 seconds of backoff). An explicit abort (stop, preemption, shutdown) cancels it. */
export const TRANSIENT_RETRY = { enabled: true, maxRetries: 8, baseDelayMs: 2000, maxAgentDelayMs: 60_000 };
/** Notes steered into a running turn are all read at its next model call. Pi's default reads one per call, so with calls of 6-13 minutes (research workers) 50 queued notes waited 20 minutes and more (2026-10-27). */
export const SESSION_SETTINGS = { retry: TRANSIENT_RETRY, compaction: { enabled: false }, shellPath: '/bin/bash', steeringMode: 'all' } as const;
/** A turn answering someone on a live line does not think first: the person hears nothing until the reply is written, and on
 *  call 3789b6d7 low thinking put the first spoken words 3.2 s after the request. */
export const LIVE_THINKING = 'off';
/** A live request joins a turn that is still answering one; otherwise it preempts whatever runs, including a finished reply's wrap-up. */
export const joinsLiveTurn = (active: AgentInput[] | undefined) => !!active?.some(i => i.live && !liveAnswered(i.live.delegationId));
/** Shown (not prompted) when a restart cut a turn off in a model call and it continues from saved context. */
export const MODEL_CALL_RESUMED = 'The Kenan service restarted during a model call; it is continuing from the saved conversation.';
export const RESTART_NOTICE = 'The Kenan service restarted while your previous turn was running, so that turn was cut off. Continue from where you stopped. Before repeating a tool call that was in progress, check whether it already took effect.';
/** Added to the restart notice when messages sent to the agent had not reached its transcript when the turn was cut off. */
export const RESTART_UNREAD = 'Messages sent to you that you had not read yet follow this notice; read them before you continue.';
/** Restart notices are derived at each start from the agents left interrupted, so they are never stored. */
const stores = (input: AgentInput): boolean => input.kind !== 'restart' || input.deliveryKey !== undefined;
/** Peer messages cannot reopen a completed assignment; the parent or manager can assign new work. */
const reopensReport = (agent: AgentInfo, sender: string, manager: string | null): boolean => !!agent.lastReport && (agent.lastReport.status !== 'done' || sender === agent.parentAgentId || sender === manager);
/** The agent's own system inputs: meaningless to anyone else, so an archived run's are dropped (and logged), never passed on. */
const OWN_KINDS = new Set<AgentInput['kind']>(['restart', 'heartbeat']);
/** What an archived run's heir is told about input the run never read. */
export const orphanText = (agent: Pick<AgentInfo, 'id' | 'name' | 'role'>, input: AgentInput): string =>
  `This ${input.kind} from ${input.fromId} was sent to ${agent.role} ${agent.name} (${agent.id}), which is no longer running and never read it, so it came to you. Act on it if it still matters (relaunch the work, reply to the sender or pass it on), otherwise let it go.\n${input.text}`;
/** Removes and returns the queued inputs that match, in order. */
function take(queue: AgentInput[], match: (input: AgentInput) => boolean): AgentInput[] {
  const taken = queue.filter(match);
  const kept = queue.filter(input => !match(input));
  queue.splice(0, queue.length, ...kept);
  return taken;
}
/** The text of a user message as Pi compares queued input (its text blocks, newline-joined). */
const userText = (content: string | readonly { type: string; text?: string }[]): string =>
  typeof content === 'string' ? content : content.flatMap(part => part.type === 'text' && part.text !== undefined ? [part.text] : []).join('\n');
/** Providers reject an error tool result without content, so a tool that failed silently is described; stored histories replay unchanged. */
export function describeSilentErrors(messages: LlmMessage[]): LlmMessage[] {
  return messages.map(message => message.role === 'toolResult' && message.isError && !message.content.some(part => part.type === 'image' || part.text.trim())
    ? { ...message, content: [{ type: 'text', text: `The ${message.toolName} tool failed without any output.` }] } : message);
}
/** What each model request carries of the transcript: silent tool failures described, and a request the provider rejected
 *  never sent again, since its part of the transcript leaves every later request (refusal.ts). */
export function modelContext(session: AgentSession): void {
  const convertToLlm = session.agent.convertToLlm;
  session.agent.convertToLlm = async messages => withoutRejected(describeSilentErrors(await convertToLlm(messages)));
}
/** Each prompt opens with the person's local time, read in the zone their app last reported and naming the kind of device
 *  it reported from (never guessed: an unclassified one is just "their device"), so "tomorrow" and "at 9" mean theirs. */
export function clockLine(report: ZoneReport | null, now: number): string {
  if (report === null) return `[Local time for the person you work for: ${clockIn(now, HOME_ZONE)}; the household zone, since their app has not reported one yet]`;
  return `[Local time for the person you work for: ${clockIn(now, report.zone)}, from their ${report.device === 'unknown' ? 'device' : report.device}]`;
}
/** The system prompt after the profile's own text, as independently replaceable Pi sections: each context file, the
 * extensions' notes, then this agent's role (it names the agent, so it goes last and everything before it is the same for
 * every agent of the person). A changed file or role text is re-sent to a running session alone, never the whole prompt. */
export function promptSections(context: Record<string, string>, snippets: string, role: string): Record<string, string> {
  return { ...context, ...(snippets ? { extension_notes: snippets } : {}), role };
}
/** Installs the sections into every turn's system prompt (Pi diffs them against the transcript and sends only changes). */
export const sectionsExtension = (sections: Record<string, string>): InlineExtension =>
  ({ name: 'kenan-prompt-sections', hidden: true, factory: pi => { pi.on('before_agent_start', event => { Object.assign(event.systemPromptOptions.sections, sections); }); } });
/** Every model call writes its prompt cache with the one-hour lifetime. Agents sit idle between inputs for minutes at a time
 * (wakes, reports, notes, heartbeats); with the five-minute default each of those turns rewrote the whole context at the
 * cache-write price (Beta, 2026-10-21: 34% of the day's spend). One-hour writes cost 1.6× a five-minute write, and reads stay
 * hits across those gaps (work/kenan/token-spend/README.md). */
export function longPromptCache(session: AgentSession, requestBuilt: () => void = () => {}): void {
  const stream = session.agent.streamFunction;
  session.agent.streamFunction = (model, context, options) => stream(model, context, {
    ...options, cacheRetention: 'long',
    onPayload: async (payload, requestModel) => { const built = shareSystemPrefix(await options?.onPayload?.(payload, requestModel) ?? payload); requestBuilt(); return built; },
  });
}
const ROLE_SECTION = '\n\n<role>\n';
type TextBlock = { type: 'text'; text: string; cache_control?: unknown };
const isTextBlock = (b: unknown): b is TextBlock => !!b && typeof b === 'object' && (b as TextBlock).type === 'text' && typeof (b as TextBlock).text === 'string';
/** Everything in the system prompt before the role section is the same for every agent of a person, so it becomes its own
 * cached block: a new worker reads the tools and shared prompt from cache instead of writing them again. The breakpoint
 * moves from the Claude Code identity block (the tools breakpoint already covers that prefix), so a request keeps
 * Anthropic's four. A payload without the Anthropic OAuth system shape (identity block, prompt block) is sent as built. */
export function shareSystemPrefix(payload: unknown): unknown {
  const system = (payload as { system?: unknown } | null)?.system;
  if (!Array.isArray(system) || system.length !== 2 || !system.every(isTextBlock)) return payload;
  const [identity, prompt] = system as [TextBlock, TextBlock];
  const cut = prompt.text.lastIndexOf(ROLE_SECTION);
  if (cut < 0 || identity.cache_control === undefined || prompt.cache_control === undefined) return payload;
  const { cache_control: _moved, ...plainIdentity } = identity;
  const shared = { ...prompt, text: prompt.text.slice(0, cut) };
  const role = { ...prompt, text: prompt.text.slice(cut + 2) };
  return { ...(payload as object), system: [plainIdentity, shared, role] };
}
/** A requested end can surface from Pi as an 'error' (an aborted request setup is reported that way), so the runtime's own intent decides: a stopped run is stopped, not failed. */
export function turnOutcome(stopReason: StopReason, endRequested: boolean): 'done' | 'stopped' | 'error' {
  switch (stopReason) {
    case 'aborted': return 'stopped';
    case 'error': return endRequested ? 'stopped' : 'error';
    case 'stop': case 'length': case 'toolUse': case 'pending': case 'deferred': return 'done';
  }
}
/** A person's manager is placed by configuration; archiving or stopping it would leave the person with no one answering. */
/** What a worker is told about swarms: a top-level worker may coordinate one; a sub-agent does one small task. */
const coordinatorBase = (maxActive: number): string => `You can run a swarm for your goal when it splits into many small, checkable tasks (one Lean lemma, one search query, one file): launch sub-agents with workers spawn using your own goalId, a name, the task text, and an explicit model and thinking (helpers (swarm sub-agents) should usually be Terra (GPT) or Haiku (Claude), but choose what the task needs; choose the model that fits the task from the models and thinking levels this host serves). Nesting is allowed, but your top-level worker’s entire tree shares a limit of ${maxActive} active descendants (swarm_full names its count and top worker), and at most 10 spawns in any rolling minute (swarm_spawn_rate_limited gives retryAfterMs); Claude launches are refused with claude_reserved_for_kenaznia while the shared Claude pool is below its configured reserve; choose GPT explicitly instead. Give each a self-contained task with exactly how to check it and what to report. Their reports come to you, not your manager; list them with workers list parent=<your id>. Verify every result yourself (build it, run the test, cross-check) before relying on it, relaunch or reassign failures with what went wrong, and report one combined result. Finishing or being stopped stops your sub-agents. Guidance on who writes the code, not a rule; your judgement wins. For implementation work the usual pattern is that you plan (spec, interfaces, tests, acceptance checks), sub-agents implement, and you review and verify; don't write code yourself that a sub-agent can write well from a good plan. Writing it yourself is usually worth it for performance kernels where the idea is the data layout, verifiers and checkers that decide what is true, subtle debugging (races, small numeric discrepancies), exploratory research code where the plan emerges by writing, a surgical diff smaller than the plan that would describe it, interfaces, data models and test contracts, and security-critical code. Lean proofs are fine for swarms.`;
export const COORDINATOR_PROMPT = coordinatorBase(DEFAULT_SWARM_MAX_ACTIVE);
/** Every coordinator can supervise workers on other goals. */
export const AREA_PROMPT = `You can also manage other goals: workers spawn with another open goal's id launches a worker that reports to you, and workers reparent (id, parent) moves a worker under any other worker or Kenaznia without restarting it. Workers you launch or take on send you their notes, reports and long waits. wake list shows triggers you hold; when one fires, launch the fresh worker for that goal. Coordinate shared files, resources and duplicated work. Send your own parent results and decisions, briefly.`;
export function coordinatorPrompt(person: PersonConfig): string {
  return AREA_PROMPT + ' ' + coordinatorBase(swarmMaxActive(person));
}
/** Heads a report the runtime filed for a worker that ended its turn without one (reportImplicitly). */
export const IMPLICIT_REPORT = '(Filed automatically: it ended its turn without calling report and nothing was left to resume it, so its last message is its report.)';
/** The shown words of the turn's last assistant message that has any: what a worker that never called report said last. */
export function lastWords(messages: AgentSession['messages']): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.role === 'user') return '';
    if (message.role !== 'assistant') continue;
    const text = message.content.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n').trim();
    if (!text) continue;
    const shown = backgroundPieces(text).filter(piece => !piece.background).map(piece => piece.text).join('\n\n').trim();
    return shown || text;
  }
  return '';
}
/** Last words that say the worker can't go on, or needs something from someone, make its implicit report blocked. */
const BLOCKED_WORDS = /(?<!\b(?:not|nothing|never|isn't|wasn't|no longer) )\bblocked\b|\b(?:i|we) (?:still )?need (?:you|your|a decision|an answer|approval|permission|access|someone)\b|\bneeds? your\b|\bwaiting (?:for|on) (?:you|your|a reply|an answer|approval|a decision)\b|\bcan(?:no|')t (?:continue|proceed|go on|finish)\b|\bunable to (?:continue|proceed|finish|complete)\b/i;
export const soundsBlocked = (words: string): boolean => BLOCKED_WORDS.test(words);
export const SUB_AGENT_PROMPT = `You share your launcher's goal. Follow the assigned task, check it as instructed, and report to your launcher. You can coordinate helpers when the task needs them.`;
export class ManagerPlacementFixed extends Error {
  constructor(readonly agentId: string) { super(`${agentId} is a person's Kenaznia; configuration places it, so it cannot be stopped or archived. A person's Stop button ends its current turn.`); }
}
/** Mutable scheduler state outlives any imported release generation. */
type RuntimeState = {
  current: AgentRuntime;
  lanes: Map<string, Lane>;
  paused: Set<string>;
  placementPaused: Set<string>;
  managers: Map<string, string>;
  timers: ReturnType<typeof setTimeout>[];
  closing: boolean;
  rewriting?: { done: Promise<void>; committing: boolean; scrub: (input: AgentInput) => Promise<void> };
  deliveries: Set<AgentInput>;
  spawning: Map<string, Promise<AgentInfo>>;
  workerChanges?: Map<string, Promise<unknown>>;
  /** Input row ids live until their transcript consumes them (null means storage failed). */
  stored: WeakMap<AgentInput, Promise<string | null>>;
  /** Original arrival times survive generation changes and background gathering. */
  received: WeakMap<AgentInput, number>;
  firings: Set<string>;
  heartbeats: Map<string, Promise<void>>;
  /** Shutdown waits for row deletions already in flight. */
  consuming: Set<Promise<void>>;
  waitingSent: Map<string, string>;
  /** Whole pump tasks, including report publication, child adoption and final cleanup. */
  tasks: Map<Promise<void>, number>;
};
export class AgentRuntime implements Runtime, Controls {
  /** Old async frames and the latest runtime always read and write this same object. */
  private state: RuntimeState;
  private generation = 0;
  /** Pre-upgrade field name that existing tests still read; the map itself lives in the shared state. */
  private get managers(): Map<string, string> { return this.state.managers; }
  constructor(private readonly deps: Deps, private readonly gathering: Gathering = BACKGROUND_GATHERING) {
    this.state = {
      current: this, lanes: new Map(), paused: new Set(), placementPaused: new Set(), managers: new Map(), timers: [],
      closing: false, deliveries: new Set(), spawning: new Map(), stored: new WeakMap(), received: new WeakMap(),
      firings: new Set(), heartbeats: new Map(), consuming: new Set(), waitingSent: new Map(), tasks: new Map(),
    };
  }
  /** Adopt live input and sessions without startup recovery or interrupting a single turn. */
  async upgrade(previous: AgentRuntime): Promise<void> {
    if (previous.deps !== this.deps) throw new Error('runtime_upgrade_deps_changed: live upgrades require the same dependencies');
    if (previous.state.current !== previous || previous.state.closing) throw new Error('runtime_upgrade_not_current: the previous runtime must be current and open');
    this.state = previous.state;
    this.generation = previous.generation + 1;
    this.state.current = this;
    for (const timer of this.state.timers) clearTimeout(timer);
    this.state.timers = [];
    for (const lane of this.state.lanes.values()) {
      clearTimeout(lane.gathering); lane.gathering = undefined;
      clearTimeout(lane.release); lane.release = undefined;
    }
    const managers = new Map<string, string>();
    for (const person of this.deps.config.people) {
      const elsewhere = !!person.manager && 'elsewhere' in person.manager;
      if (elsewhere || this.state.placementPaused.size) {
        for (const agent of await this.deps.store.listAgents(person.id, { includeArchived: true })) {
          if (elsewhere) { this.state.paused.add(agent.id); this.state.placementPaused.add(agent.id); }
          else if (this.state.placementPaused.delete(agent.id)) this.state.paused.delete(agent.id);
        }
      }
      await this.deps.store.upsertPerson({ id: person.id, name: person.name, kind: 'human' });
      const manager = await this.placeManager(person);
      if (manager) { managers.set(person.id, manager.id); this.scheduleHeartbeat(person, manager); }
    }
    this.state.managers = managers;
    // Keep running streams and async frames, but route their next tool calls through this release.
    for (const [id, lane] of this.state.lanes) {
      if (lane.creating) await lane.creating;
      if (lane.session && lane.tools) await this.refreshTools(id, lane);
      this.startPump(id, lane);
      if (!lane.pumping && !lane.stopped && !this.isManager(id)) this.releaseWhenIdle(lane);
    }
  }
  /** Snapshot now: turns started by a newer runtime must not extend this generation's drain. */
  async drained(): Promise<void> {
    await Promise.allSettled([...this.state.tasks].filter(([, generation]) => generation <= this.generation).map(([task]) => task));
  }
  private lane(id: string): Lane {
    let lane = this.state.lanes.get(id);
    if (!lane) { lane = { queue: [], unread: [], steered: [], joined: new Set(), unseen: new Set(), prompted: false, resending: false, calling: false, settling: false, cutOff: false, pumping: false, preempting: false, stopped: false, stopping: false, stoppedTurn: false }; this.state.lanes.set(id, lane); }
    return lane;
  }
  async start(): Promise<void> {
    for (const person of this.deps.config.people) if (person.manager && 'elsewhere' in person.manager) {
      for (const agent of await this.deps.store.listAgents(person.id, { includeArchived: true })) { this.state.paused.add(agent.id); this.state.placementPaused.add(agent.id); }
    }
    await this.deps.store.markRunningInterrupted();
    const interrupted = await this.deps.store.listInterrupted();
    const pending = await this.deps.store.storedInputs();
    for (const person of this.deps.config.people) await this.addPerson(person);
    await this.resume(interrupted, pending);
  }
  /** Live enrollment uses the same placement and heartbeat setup as startup, without restarting existing agents. */
  async addPerson(person: PersonConfig): Promise<void> {
    if (this.state.managers.has(person.id)) return;
    await this.deps.store.upsertPerson({ id: person.id, name: person.name, kind: 'human' });
    const placed = await this.placeManager(person);
    if (!placed) return;
    const manager = placed;
    this.state.managers.set(person.id, manager.id);
    // Prepare sessions before accepting traffic so a human never waits for discovery.
    void this.session(manager.id).catch(e => this.error(manager.id, e));
    this.scheduleHeartbeat(person, manager);
  }
  private scheduleHeartbeat(person: PersonConfig, manager: AgentInfo): void {
    if (this.state.current !== this || this.state.closing) return;
    // Isolated people only work when asked, never from host-wide status heartbeats.
    if (person.isolated) return;
    const check = () => {
      if (this.state.current === this && !this.state.closing) void this.heartbeat(person, manager.id, manager.conversationId).catch(e => this.error(manager.id, e));
    };
    this.state.timers.push(setTimeout(check, 10000), setInterval(check, HEARTBEAT_CHECK_MS));
  }
  /** Configuration owns where a person's Kenaznia runs and on which model: hosted here it exists, is never archived and takes its profile's name and model; otherwise any manager row on this channel is archived, so no person sees a second, unconfigured manager. */
  private async placeManager(person: PersonConfig): Promise<AgentInfo | null> {
    const profile = hostedManager(person);
    const existing = (await this.deps.store.listAgents(person.id, { includeArchived: true })).find(a => a.role === 'manager');
    if (!profile) {
      if (existing && !existing.archived) await this.deps.store.updateAgent(existing.id, { state: 'stopped', archived: true });
      return null;
    }
    if (!existing) return this.deps.store.createAgent({ id: `manager:${person.id}`, ownerId: person.id, name: profile.name, role: 'manager', goalId: null, model: profile.model, sessionPath: join(this.deps.config.dataDir, 'sessions', `manager-${person.id}.jsonl`), conversationTitle: profile.name, originConversationId: null });
    const placed = existing.archived ? await this.deps.store.updateAgent(existing.id, { state: 'idle', archived: false }) : existing;
    // A manager's model is its configured profile's, applied at the next start; workers keep the model they were admitted with.
    return placed.name === profile.name && placed.model === profile.model ? placed : this.deps.store.updateAgent(placed.id, { name: profile.name, model: profile.model });
  }
  /**
   * Every heartbeatMinutes since the persisted last check, compare; deliver only when something moved (heartbeat.ts decideHeartbeat). Restarts add none.
   * One check per manager at a time: during a stall every minute's tick passed the checks below before any had saved, and
   * Kenaznia got seven heartbeats in one batch (2026-10-29 17:36Z).
   */
  private heartbeat(person: PersonConfig, managerId: string, conversationId: string): Promise<void> {
    const running = this.state.heartbeats.get(managerId);
    if (running) return running;
    const check = this.checkHeartbeat(person, managerId, conversationId).finally(() => this.state.heartbeats.delete(managerId));
    this.state.heartbeats.set(managerId, check);
    return check;
  }
  private async checkHeartbeat(person: PersonConfig, managerId: string, conversationId: string): Promise<void> {
    if (this.state.closing || this.state.current !== this) return;
    const current = await this.deps.store.getAgent(managerId);
    if (!current || current.archived) return;
    const lane = this.lane(managerId);
    const pending = () => [...lane.queue, ...(lane.active ?? [])].some(input => input.kind === 'heartbeat');
    if (pending()) return;
    const previous = await this.deps.store.getHeartbeat(managerId);
    if (previous && this.deps.now() - previous.checkedAt < this.deps.config.heartbeatMinutes * 60000) return;
    const beat = await heartbeatText(this.deps, person, managerId);
    if (this.state.current !== this) return;
    await this.deps.store.saveHeartbeat(managerId, beat.state);
    if (beat.kind === 'due' && !pending() && !this.state.closing && this.state.current === this) this.deliver({ agentId: managerId, kind: 'heartbeat', text: beat.text, fromId: 'system', conversationId });
  }
  /**
   * Every input stored and not yet in its agent's transcript is queued again, in arrival order, behind the restart notice
   * of an agent whose turn was cut off, so the notice's turn carries them. Inputs of archived runs go to their heir (orphan).
   */
  private async resume(interrupted: Interrupted[], pending: StoredInput[]): Promise<void> {
    // A turn cut off in a model call left its own resume input; the others get the restart notice.
    const resumesCall = new Set(pending.filter(({ input }) => input.resume === 'model_call').map(({ input }) => input.agentId));
    const live = new Map<string, boolean>();
    const isLive = async (id: string) => {
      if (!live.has(id)) { const agent = await this.deps.store.getAgent(id); live.set(id, !!agent && !agent.archived); }
      return live.get(id)!;
    };
    const kept: AgentInput[] = [];
    const orphans: AgentInput[] = [];
    for (const { id, input, at } of pending) {
      const owner = await this.deps.store.getAgent(input.agentId);
      const person = owner && this.deps.person(owner.ownerId);
      if (person?.manager && 'elsewhere' in person.manager) continue;
      this.state.stored.set(input, Promise.resolve(id));
      this.state.received.set(input, at);
      (await isLive(input.agentId) ? kept : orphans).push(input);
    }
    // Input left stored for a run that was archived before it read it goes to the run's heir.
    for (const input of orphans) this.orphan(input.agentId, [input]);
    const unread = new Set(kept.filter(input => !input.resume).map(input => input.agentId));
    const queued: AgentInput[] = [];
    for (const { id, turn } of interrupted) {
      const agent = await this.deps.store.getAgent(id);
      if (!agent || agent.archived || resumesCall.has(id)) continue;
      const person = this.deps.person(agent.ownerId);
      if (person?.manager && 'elsewhere' in person.manager) continue;
      const restart: AgentInput = { agentId: id, kind: 'restart', text: unread.has(id) ? `${RESTART_NOTICE} ${RESTART_UNREAD}` : RESTART_NOTICE, fromId: 'system', ...await resumeRoute(this.deps, agent, turn) };
      this.announce(restart);
      queued.push(restart);
    }
    // A resumed model call goes out first and alone; the inputs that wait behind it follow.
    for (const input of kept.filter(input => input.resume)) { this.announce(input); queued.push(input); }
    queued.push(...kept.filter(input => !input.resume));
    for (const input of queued) this.enqueue(input, { start: false });
    for (const id of new Set(queued.map(input => input.agentId))) this.startPump(id, this.lane(id));
  }
  /** Stop, archive, preemption and shutdown abort the run on purpose. */
  private endRequested(lane: Lane): boolean { return lane.stopped || lane.stopping || lane.preempting || !!lane.rewriting || this.state.closing; }
  managerFor(ownerId: string): string | null { return this.state.managers.get(ownerId) ?? null; }
  turnOf(agentId: string): AgentTurn | null {
    const lane = this.state.lanes.get(agentId);
    if (!lane?.active || lane.startedAt === undefined) return null;
    const first = lane.active[0]!;
    return { startedAt: lane.startedAt, conversationId: first.conversationId, chatBound: !!first.chatBound, inputs: lane.active.map(({ kind, fromId, text }) => ({ kind, fromId, text })), queued: lane.queue.length };
  }
  /**
   * After any change to a manager's lane, tells its person (extension busyline) which of her chats has a message waiting
   * behind the running turn and where that turn is: one of her own chats by id, or other work (a background turn in its
   * own chat, a chat she is not in). Sent only when it changed; null once nothing of hers waits.
   */
  private waitingChanged(id: string, lane: Lane): void {
    const personId = [...this.state.managers].find(([, manager]) => manager === id)?.[0];
    if (!personId || !this.deps.person(personId)?.extensions.includes(BUSY_LINE)) return;
    const active = lane.active ? [...lane.active] : null;
    const queued = active ? queuedChats(personId, active[0]!.conversationId, lane.queue) : {};
    lane.waiting = (lane.waiting ?? Promise.resolve()).then(async () => {
      let waiting: Waiting | null = null;
      if (active && Object.keys(queued).length) {
        const chat = active[0]!.conversationId;
        const ownBackground = answersBackground('manager', active) && (await this.deps.store.getAgent(id))?.conversationId === chat;
        const hers = !ownBackground && (await this.deps.store.conversationMembers(chat)).includes(personId);
        waiting = { busy: hers ? { kind: 'chat', conversationId: chat } : { kind: 'other' }, queued };
      }
      const sent = JSON.stringify(waiting);
      if ((this.state.waitingSent.get(id) ?? 'null') === sent) return;
      this.state.waitingSent.set(id, sent);
      this.deps.bus.toPerson(personId, { type: 'waiting', waiting });
    }).catch(e => this.error(id, e));
  }
  private async error(id: string, error: unknown): Promise<void> { await this.deps.store.logError(`agent:${id}`, String(error)).catch(() => {}); }
  /**
   * No Pi object survives this operation: replacing agent.state.messages alone leaves SessionManager's old entries,
   * compactions and steering queues alive. Stop writers, rewrite every entry, then reopen from disk on the next turn.
   * The callback keeps pending-input and message-row edits inside the same prompt barrier.
   * A tool in an affected session must schedule this outside its own execution, not await its own termination.
   */
  async rewriteMessageCopies(message: Message, replacement: string, commit?: () => Promise<void>): Promise<void> {
    while (this.state.rewriting) await this.state.rewriting.done;
    const rewrite = messageRewriter(message, replacement);
    const owners = new Set<string>();
    const scrubInput = (input: AgentInput): void => {
      for (const field of ['text', 'where', 'seenFrom'] as const) {
        const value = input[field];
        if (typeof value === 'string') input[field] = rewrite(value);
      }
      if (input.chat) { input.chat.title = rewrite(input.chat.title); if (input.chat.answers) input.chat.answers = rewrite(input.chat.answers); }
    };
    let scoped!: () => void;
    const ready = new Promise<void>(resolve => { scoped = resolve; });
    let release!: () => void;
    const done = new Promise<void>(resolve => { release = resolve; });
    const barrier = { done, committing: false, scrub: async (input: AgentInput) => {
      await ready;
      const agent = await this.deps.store.getAgent(input.agentId);
      if (agent && owners.has(agent.ownerId)) scrubInput(input);
    } };
    this.state.rewriting = barrier;
    const lanes: [string, Lane][] = [];
    let finished = false;
    try {
      const members = new Set([message.authorId, ...await this.deps.store.conversationMembers(message.conversationId)]);
      for (const id of members) {
        const agent = await this.deps.store.getAgent(id);
        if (agent) owners.add(agent.ownerId);
        else if (await this.deps.store.getPerson(id)) owners.add(id);
      }
      // Include archived sessions: workers often quote their task in reports and compaction summaries.
      const agents = (await this.deps.store.listAgents(undefined, { includeArchived: true })).filter(agent => owners.has(agent.ownerId));
      const pathsByAgent = new Map<string, Set<string>>();
      const stems = new Map<string, string>();
      for (const agent of agents) {
        const path = await this.deps.store.agentSessionPath(agent.id);
        pathsByAgent.set(agent.id, new Set(path ? [path] : []));
        stems.set(agent.id, agent.id);
        if (path) stems.set(basename(path, '.jsonl'), agent.id);
      }
      // session-trim keeps full pre-compaction journals as hard links in transcripts/.
      const transcripts = join(this.deps.config.dataDir, 'transcripts');
      const names = await readdir(transcripts).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return []; throw error; });
      for (const name of names) if (name.endsWith('.jsonl')) {
        for (const [stem, id] of stems) if (name === `${stem}.jsonl` || name.startsWith(`${stem}.`)) { pathsByAgent.get(id)!.add(join(transcripts, name)); break; }
      }
      const inputContains = (input: AgentInput): boolean => [input.text, input.where, input.seenFrom, input.chat?.title, input.chat?.answers].some(text => typeof text === 'string' && rewrite(text) !== text);
      const liveContains = (id: string): boolean => {
        const lane = this.state.lanes.get(id);
        if (!lane) return false;
        const inputs = [...lane.queue, ...lane.active ?? [], ...lane.steered, ...lane.restoredTurn ?? [], ...lane.joined, ...lane.unseen, ...lane.unread.flatMap(entry => entry.inputs), ...[...this.state.deliveries].filter(input => input.agentId === id)];
        return inputs.some(inputContains) || lane.unread.some(entry => rewrite(entry.text) !== entry.text)
          || sessionValueContains(lane.session?.messages, rewrite)
          || sessionValueContains(lane.session?.sessionManager?.getEntries(), rewrite);
      };
      const ids = new Set<string>();
      scoped();
      // Search all possible owners, but stop only sessions that actually hold copies. Direct recipients also count
      // when compaction has paraphrased the source so it no longer has an exact textual match.
      for (let at = 0; at < agents.length; at += 8) await Promise.all(agents.slice(at, at + 8).map(async agent => {
        if (members.has(agent.id) || agent.conversationId === message.conversationId || liveContains(agent.id)) { ids.add(agent.id); return; }
        for (const path of pathsByAgent.get(agent.id)!) if (await sessionFileContains(path, rewrite)) { ids.add(agent.id); return; }
        if (liveContains(agent.id)) ids.add(agent.id);
      }));
      for (const [id, lane] of this.state.lanes) if (ids.has(id)) {
        lanes.push([id, lane]); lane.rewriting = true;
        clearTimeout(lane.release); clearTimeout(lane.gathering); lane.gathering = undefined;
      }
      // Session creation and attachment preparation can be in flight even when Pi is not streaming yet.
      await Promise.all(lanes.map(async ([, lane]) => {
        await lane.creating;
        await lane.session?.abort();
        await lane.steering;
        await lane.task;
        await lane.session?.abort();
      }));
      for (const [, lane] of lanes) {
        for (const input of new Set([...lane.queue, ...lane.active ?? [], ...lane.steered, ...lane.restoredTurn ?? [], ...lane.joined, ...lane.unseen, ...lane.unread.flatMap(entry => entry.inputs)])) scrubInput(input);
        lane.unread = []; lane.steered = []; lane.joined.clear(); lane.unseen.clear(); lane.restoredTurn = undefined;
        if (lane.failure) lane.failure = rewrite(lane.failure);
        this.disposeSession(lane);
      }
      for (const input of this.state.deliveries) if (ids.has(input.agentId)) scrubInput(input);
      await Promise.all(lanes.map(([, lane]) => lane.storing));
      const paths = new Set([...ids].flatMap(id => [...pathsByAgent.get(id)!]));
      const files = [...paths];
      for (let at = 0; at < files.length; at += 8) await Promise.all(files.slice(at, at + 8).map(path => rewriteSessionFile(path, rewrite)));
      // Tool deliveries remain acknowledgeable while abort drains a running tool. Only the final database write
      // pauses them; otherwise a tool awaiting deliver() and this method awaiting lane.task would deadlock.
      barrier.committing = true;
      await Promise.all([...this.state.lanes].filter(([id]) => ids.has(id)).flatMap(([, lane]) => [lane.storing, lane.notices]));
      await commit?.();
      for (const [id] of lanes) {
        const agent = await this.deps.store.getAgent(id);
        if (agent?.state === 'running') await this.publishAgent(await this.deps.store.updateAgent(id, { state: 'idle' }));
      }
      finished = true;
    } finally {
      for (const [, lane] of lanes) {
        lane.rewriting = false;
        // A failed rewrite must not start a model on a journal that was only partly changed.
        if (!finished) lane.stopped = true;
      }
      scoped(); this.state.rewriting = undefined; release();
      for (const [id, lane] of this.state.lanes) if (!this.state.closing && !lane.stopped && !this.state.paused.has(id)) this.startPump(id, lane);
    }
  }
  /**
   * A person's message reaches every agent in a chat with one person (her own chats with her agents). A chat with two or
   * more people is a channel (server/channels/kenan.ts): no agent sits in it; each member's own Kenaznia gets the
   * messages its channel mode passes, in its own chat, and answers there with send.
   */
  /** Resolves once the message is delivered to every agent it reaches (tests wait on it; the server does not). */
  onHumanMessage(message: Message, conversation: ConversationSummary, seenFrom: string | null): Promise<void> {
    return (async () => {
      const { humans, names } = await humansIn(this.deps, conversation);
      if (humans.length >= 2) return routeSharedMessage(this.deps, message, conversation, humans, names);
      for (const id of conversation.memberIds) {
        const agent = await this.deps.store.getAgent(id);
        if (!agent || id === message.authorId) continue;
        const person = this.deps.person(agent.ownerId);
        const bound = person && await routesByChat(this.deps, person) ? { chatBound: true as const } : {};
        // A blank chat reads only the words and files: no chat name, no earlier replies, nothing about where it was typed.
        const context = agent.role === 'blank' ? {} : { chat: await chatContext(this.deps, agent, message, conversation), ...(seenFrom === null ? {} : { seenFrom }) };
        this.deliver({ agentId: id, kind: 'human', text: message.text, fromId: message.authorId, conversationId: conversation.id, humanMessageId: message.id, fileIds: message.parts.filter(p => p.type === 'file' || p.type === 'image').map(p => p.fileId), ...bound, ...context });
      }
    })().catch(e => this.deps.store.logError('runtime', String(e)).catch(() => {}));
  }
  /**
   * Stores the input before anything else, so from the moment delivery is acknowledged it survives restarts and crashes
   * (worker 026cc33e lost its manager's message steered into a turn that a restart cut off mid-tool). The row goes once
   * the agent's transcript holds the input, or when it is dropped on purpose. During shutdown the input is only stored:
   * the next start delivers it.
   */
  deliver(input: AgentInput, { start = true }: { start?: boolean } = {}): Promise<Delivery> {
    const rewrite = this.state.rewriting;
    if (rewrite) return (async () => {
      if (rewrite.committing) await rewrite.done;
      await rewrite.scrub(input);
      return this.deliverInput(input, { start });
    })();
    return this.deliverInput(input, { start });
  }
  private deliverInput(input: AgentInput, { start }: { start: boolean }): Promise<Delivery> {
    if (input.firingId !== undefined) {
      const key = `${input.agentId}:${input.firingId}`;
      if (this.state.firings.has(key)) { console.log(JSON.stringify({ type: 'wake_firing_duplicate', agentId: input.agentId, firingId: input.firingId, where: 'deliver' })); return Promise.resolve({ ok: true }); }
      this.state.firings.add(key);
      if (this.state.firings.size > 20_000) this.state.firings.delete(this.state.firings.values().next().value!);
    }
    if (this.state.received.has(input)) { console.log(JSON.stringify({ type: 'input_duplicate', agentId: input.agentId, kind: input.kind, fromId: input.fromId, where: 'deliver' })); return Promise.resolve({ ok: true }); }
    this.state.received.set(input, this.deps.now());
    this.state.deliveries.add(input);
    const stored = this.store(input);
    if (input.deliveryKey !== undefined || ADDRESSED_INPUTS.has(input.kind)) {
      return stored.then(async result => {
        if (!result.ok) {
          this.state.deliveries.delete(input); this.state.received.delete(input);
          if (input.firingId !== undefined) this.state.firings.delete(`${input.agentId}:${input.firingId}`);
          return result;
        }
        if (input.deliveryKey !== undefined && await this.state.stored.get(input) === null) { this.state.deliveries.delete(input); this.state.stored.delete(input); return result; }
        if (input.deliveryKey !== undefined && input.kind === 'agent') {
          try {
            const agent = await this.deps.store.getAgent(input.agentId);
            if (agent && reopensReport(agent, input.fromId, this.managerFor(agent.ownerId))) await this.publishAgent(await this.deps.store.updateAgent(agent.id, { lastReport: null }));
          } catch (e) { void this.error(input.agentId, `linked_report_update_failed: ${String(e)}`); }
        }
        await this.accept(input, start);
        return result;
      });
    }
    void this.accept(input, start);
    return stored;
  }
  /** Settle input-triggered wakes before starting or steering the input: their context belongs to the same turn. */
  private async accept(input: AgentInput, start = true): Promise<void> {
    try { await this.acceptInput(input, start); }
    finally { this.state.deliveries.delete(input); }
  }
  private async acceptInput(input: AgentInput, start: boolean): Promise<void> {
    const rewrite = this.state.rewriting;
    if (rewrite) { if (rewrite.committing) await rewrite.done; await rewrite.scrub(input); }
    const wakes: AgentInput[] = [];
    if (ADDRESSED_INPUTS.has(input.kind)) await fireOnInput(this.deps, input, wake => { wakes.push(wake); }).catch(e => this.error(input.agentId, e));
    // A rewrite may have begun while wake matching awaited storage.
    const afterWake = this.state.rewriting;
    if (afterWake) { if (afterWake.committing) await afterWake.done; await afterWake.scrub(input); }
    this.announce(input);
    this.enqueue(input, { start: false });
    for (const wake of wakes) void this.deliver(wake, { start: false });
    if (start && !this.state.closing && !this.state.paused.has(input.agentId)) this.startPump(input.agentId, this.lane(input.agentId));
  }
  private store(input: AgentInput): Promise<Delivery> {
    if (!stores(input)) return Promise.resolve({ ok: true });
    const lane = this.lane(input.agentId);
    const row = (lane.storing ?? Promise.resolve()).then(() => this.deps.store.storeInput(input));
    const id = row.then(value => value, (error: unknown) => { void this.error(input.agentId, `input_not_stored: ${String(error)}`); return null; });
    lane.storing = id;
    this.state.stored.set(input, id);
    return row.then((): Delivery => ({ ok: true }), (error: unknown): Delivery => ({ ok: false, error: 'input_not_stored', detail: String(error) }));
  }
  /** The inputs are in the agent's transcript (or dropped on purpose): their rows go, once. */
  private consume(inputs: AgentInput[]): void {
    const rows = inputs.flatMap(input => { const id = this.state.stored.get(input); this.state.stored.delete(input); return id ? [id] : []; });
    if (!rows.length) return;
    const done = Promise.all(rows)
      .then(ids => this.deps.store.deleteInputs(ids.filter((id): id is string => id !== null)))
      .catch(e => this.error(inputs[0]!.agentId, `input_not_deleted: ${String(e)}`));
    this.state.consuming.add(done);
    void done.then(() => this.state.consuming.delete(done));
  }
  /** The agent's transcript now holds these inputs: one journal line each with how long it waited since it arrived. */
  private read(inputs: AgentInput[]): void {
    const now = this.deps.now();
    for (const input of inputs) {
      const at = this.state.received.get(input);
      if (at === undefined || input.fromId === 'system' && input.kind === 'restart') continue;
      console.log(JSON.stringify({ type: 'input_read', agentId: input.agentId, kind: input.kind, fromId: input.fromId, waitMs: now - at }));
    }
  }
  private dropped(agentId: string, input: AgentInput, why: 'own_input_of_archived_run' | 'no_heir'): void {
    void this.error(agentId, `input_dropped: ${why}: ${input.kind} from ${input.fromId}: ${input.text.slice(0, 300)}`);
  }
  /**
   * Input its run will never read, because the run is archived (it arrived during or after the archive, or was stored
   * when the run was archived), goes to the run's heir: the agent that launched it while that one is live, otherwise the
   * person's manager, as a note with the original sender and text. Its stored row moves to the heir in one transaction,
   * so it arrives exactly once, even across a crash. The run's own system inputs are dropped and logged, and so is
   * everything for a closed blank chat, which has no heir.
   */
  private orphan(agentId: string, inputs: AgentInput[]): void {
    const taken = inputs.filter(input => this.state.stored.has(input) || !stores(input));
    const rows = new Map(taken.map(input => [input, this.state.stored.get(input) ?? Promise.resolve(null)] as const));
    for (const input of taken) this.state.stored.delete(input);
    if (!taken.length) return;
    const done = (async () => {
      const agent = await this.deps.store.getAgent(agentId);
      const heir = agent ? await this.heir(agent) : null;
      for (const input of taken) {
        const row = await rows.get(input)!;
        if (!agent || !heir || OWN_KINDS.has(input.kind)) {
          if (row) await this.deps.store.deleteInputs([row]);
          this.dropped(agentId, input, !agent || !heir ? 'no_heir' : 'own_input_of_archived_run');
          continue;
        }
        const route = await routeBackground(this.deps, heir, agent.originConversationId);
        const moved: AgentInput = { agentId: heir.id, kind: 'note', fromId: input.fromId, ...route, text: orphanText(agent, input) };
        const id = row ? await this.deps.store.moveInput(row, moved) : await this.deps.store.storeInput(moved);
        // Someone else already took this row: it was delivered or moved once already.
        if (id === null) continue;
        console.log(JSON.stringify({ type: 'input_rerouted', from: agentId, to: heir.id, kind: input.kind, fromId: input.fromId }));
        const notice = await this.deps.store.appendMessage({ conversationId: route.conversationId, authorId: agentId, role: 'notice', notice: 'worker_note', text: `Not read by ${agent.name}, which is no longer running, so passed to ${heir.name}: ${input.text}` });
        this.deps.bus.toConversation(route.conversationId, { type: 'message', message: notice });
        this.state.stored.set(moved, Promise.resolve(id));
        await this.accept(moved);
      }
    })().catch(e => this.error(agentId, `input_not_rerouted: ${String(e)}`));
    this.state.consuming.add(done);
    void done.then(() => this.state.consuming.delete(done));
  }
  /** Who takes over what an archived run never read: its launcher while that one is live, otherwise the person's manager. */
  private async heir(agent: AgentInfo): Promise<AgentInfo | null> {
    // A closed blank chat's unread words are hers alone: they never become Kenaznia's context.
    if (agent.role === 'blank') return null;
    const parent = agent.parentAgentId ? await this.deps.store.getAgent(agent.parentAgentId) : null;
    if (parent && !parent.archived && parent.id !== agent.id) return parent;
    const manager = this.managerFor(agent.ownerId);
    const placed = manager && manager !== agent.id ? await this.deps.store.getAgent(manager) : null;
    return placed && !placed.archived ? placed : null;
  }
  /** The background notice an input brings, once, when it first arrives. */
  private announce(input: AgentInput): void {
    const notice = INPUT_NOTICES[input.kind];
    if (notice) {
      const lane = this.lane(input.agentId);
      lane.notices = (lane.notices ?? Promise.resolve()).then(async () => {
        const message = await this.deps.store.appendMessage({ conversationId: input.conversationId, authorId: input.fromId, role: 'notice', notice, text: input.text });
        this.deps.bus.toConversation(input.conversationId, { type: 'message', message });
      }).catch(e => this.error(input.agentId, e));
    }
  }
  /** Queues or steers an input; a retained input redelivered after a restart already has its notice. */
  private enqueue(input: AgentInput, { start }: { start: boolean } = { start: true }): void {
    if (this.state.closing || this.state.paused.has(input.agentId)) return;
    const lane = this.lane(input.agentId);
    if (lane.archived) { this.orphan(input.agentId, [input]); return; }
    // Exactly once: an input already queued or in the running turn is never queued a second time.
    if (lane.queue.includes(input) || lane.active?.includes(input)) { console.log(JSON.stringify({ type: 'input_duplicate', agentId: input.agentId, kind: input.kind, fromId: input.fromId })); return; }
    lane.stopped = false;
    const sameTurn = this.sameTurn(lane, input);
    if (this.joinsTurn(lane, input)) { this.steer(lane, input); return; }
    if (input.kind === 'human') {
      const humanEnd = input.live ? lane.queue.findIndex(i => !i.live) : lane.queue.findIndex(i => i.kind !== 'human');
      lane.queue.splice(humanEnd < 0 ? lane.queue.length : humanEnd, 0, input);
      // A person in another chat waits for the answer to this one; it is not cut off.
      const answeringElsewhere = !input.live && !sameTurn && !!lane.active?.some(i => i.kind === 'human' && !i.live);
      if (lane.active && !lane.preempting && !lane.settling && !answeringElsewhere) { lane.preempting = true; void lane.session?.abort().catch(e => this.error(input.agentId, e)); }
    } else lane.queue.push(input);
    if (start) this.startPump(input.agentId, lane);
    this.waitingChanged(input.agentId, lane);
  }
  /** Whether the input belongs to the running turn's chat. A resent model call goes out exactly as it was, so until it has, nothing joins it. */
  private sameTurn(lane: Lane, input: AgentInput): boolean {
    return !!lane.active && !lane.resending && shareTurn(lane.active[0]!, input);
  }
  /** Whether the input joins the running turn now, read before its next model call. */
  private joinsTurn(lane: Lane, input: AgentInput): boolean {
    if (this.state.rewriting || !lane.session || lane.preempting || lane.settling || lane.stopping) return false;
    if (input.live) return joinsLiveTurn(lane.active);
    if (!this.sameTurn(lane, input)) return false;
    if (this.isManager(input.agentId) && input.kind !== 'human') return false;
    return input.kind === 'human' ? !!lane.active?.some(i => i.kind === 'human') : STEERED_KINDS.has(input.kind);
  }
  /**
   * Queued input that can join the running turn joins it now. Input stored at a restart waits behind the resent model call
   * and arrives while it is in flight; once that request has gone out, the rest of the turn reads it at its next tool call
   * instead of after the whole turn (the 2026-10-23 coordinator waited 23 minutes for a sub-agent's report that way).
   */
  private steerQueued(id: string, lane: Lane, only: (input: AgentInput) => boolean = () => true): void {
    const waiting = lane.queue.filter(input => input.kind !== 'human' && only(input) && this.joinsTurn(lane, input));
    if (!waiting.length) return;
    lane.queue = lane.queue.filter(input => !waiting.includes(input));
    for (const input of waiting) this.steer(lane, input);
    this.waitingChanged(id, lane);
  }
  private startPump(id: string, lane: Lane): void {
    if (this.state.current !== this) { this.state.current.startPump(id, lane); return; }
    if (!this.state.closing && !this.state.paused.has(id) && !lane.stopped && !this.state.rewriting && !lane.rewriting && !lane.pumping && lane.queue.length > 0) {
      const task = this.pump(id, lane);
      lane.task = task;
      this.state.tasks.set(task, this.generation);
      void task.catch(e => this.error(id, e)).finally(() => this.state.tasks.delete(task));
    }
  }
  private isManager(id: string): boolean { return [...this.state.managers.values()].includes(id); }
  /**
   * Whether a manager's next turn waits to gather more background input (Gathering). The pump
   * then stops and a timer starts it again; a person's message starts it at once, ahead of the background.
   */
  private gather(id: string, lane: Lane): boolean {
    if (lane.gathering) { clearTimeout(lane.gathering); lane.gathering = undefined; }
    const first = lane.queue[0];
    if (!first || !isBackground(first) || !this.isManager(id)) return false;
    const now = this.deps.now();
    const delay = gatherDelay(this.gathering, lane.queue.filter(isBackground).map(input => this.state.received.get(input) ?? 0), now);
    if (!delay) return false;
    lane.gathering = setTimeout(() => { lane.gathering = undefined; if (!this.state.closing) this.startPump(id, lane); }, delay);
    lane.gathering.unref?.();
    return true;
  }
  /** Joins the running turn before its next model call. Attachments are prepared concurrently but steered in arrival order. */
  private steer(lane: Lane, input: AgentInput): void {
    const session = lane.session!;
    lane.active!.push(input);
    lane.joined.add(input);
    lane.unseen.add(input);
    const prepared = promptInput(this.deps, input).then(value => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }));
    lane.steering = (lane.steering ?? Promise.resolve()).then(async () => {
      await this.mark(input, 'model_request_at');
      const result = await prepared;
      if (!result.ok) throw result.error;
      lane.unread.push({ text: result.value.text, inputs: [input] });
      await session.steer(result.value.text, result.value.images);
      lane.steered.push(input);
    }).catch(e => this.error(input.agentId, e));
  }
  /** Steered input the turn ended before reading goes back to the queue, so it starts the next turn instead of waiting for an unrelated prompt. */
  private async reclaimSteered(lane: Lane, session: AgentSession): Promise<void> {
    lane.settling = true;
    await lane.steering;
    const pending = new Set(session.getSteeringMessages());
    const left = lane.unread.filter(entry => pending.has(entry.text)).flatMap(entry => entry.inputs);
    lane.steered = [];
    lane.unread = lane.unread.filter(entry => !entry.inputs.some(input => left.includes(input)));
    if (!left.length) return;
    session.clearQueue();
    const humans = left.filter(i => i.kind === 'human'), others = left.filter(i => i.kind !== 'human');
    const humanEnd = lane.queue.findIndex(i => i.kind !== 'human');
    lane.queue.splice(humanEnd < 0 ? lane.queue.length : humanEnd, 0, ...others);
    lane.queue.unshift(...humans);
  }
  private async mark(input: AgentInput, field: 'model_request_at' | 'first_token_at'): Promise<void> {
    if (input.humanMessageId) await this.deps.store.markLatency(input.humanMessageId, field, this.deps.now());
  }
  private coreTools(ctx: ToolContext): KenanTool[] {
    const { person, agent } = ctx;
    const blank = agent.role === 'blank';
    const files = ownerTools(this.deps.placement, person, agent.id, undefined, blank ? 'plain' : 'host', () => this.state.closing);
    return (blank ? files : [...files, ...controlTools(ctx, this), wakeTool(ctx), sendTool(ctx), ...[peerTool(ctx)].filter((tool): tool is KenanTool => tool !== null)])
      .filter(tool => personToolAllowed(person, tool.name));
  }
  private wrapTools(id: string, lane: Lane, definitions: Map<string, KenanTool>, pending?: { files: Promise<void>; records: Promise<void> }): KenanTool[] {
    return orderedCalls(dispatchTools(definitions), timing => console.log(JSON.stringify({ type: 'tool_call_slow', agentId: id, ...timing })), pending)
      .map(redactedTool).map(tool => noteWhileUnshown(tool, () => lane.unshown === true));
  }
  private async refreshTools(id: string, lane: Lane): Promise<void> {
    const agent = await this.deps.store.getAgent(id);
    const person = agent && this.deps.person(agent.ownerId);
    if (!agent || !person || !lane.session || !lane.tools) return;
    const replacements = this.coreTools({ person, agent, deps: this.deps });
    if (lane.toolDefinitions) {
      for (const tool of replacements) if (lane.toolDefinitions.has(tool.name)) lane.toolDefinitions.set(tool.name, tool);
      // Pi keeps the original wrappers, too. Refresh redaction around them while preserving their ordering gates.
      const original = lane.toolExecutions ??= new Map([...lane.tools].map(([name, tool]) => [name, tool.execute]));
      for (const [name, held] of lane.tools) {
        const execute = original.get(name);
        if (execute) held.execute = redactedTool({ ...held, execute }).execute;
      }
      return;
    }
    // Adopt definitions already held by Pi, including sessions created before live dispatch was installed.
    // Calls whose start was emitted before adoption keep their existing implementation and ordering.
    const previous = new Map([...lane.tools].map(([name, tool]) => [name, { ...tool }]));
    const pending = new Set(lane.session.agent.state.pendingToolCalls);
    const started = new Set(pending);
    const done = pending.size ? new Promise<void>(resolve => {
      const unsubscribe = lane.session!.subscribe(event => {
        if (event.type === 'tool_execution_end') pending.delete(event.toolCallId);
        if (!pending.size) { unsubscribe(); resolve(); }
      });
    }) : Promise.resolve();
    const definitions = lane.toolDefinitions = new Map(previous);
    for (const tool of replacements) if (definitions.has(tool.name)) definitions.set(tool.name, tool);
    for (const tool of this.wrapTools(id, lane, definitions, { files: done, records: done })) {
      const held = lane.tools.get(tool.name)!;
      held.execute = (...args) => started.has(args[0]) ? previous.get(tool.name)!.execute(...args) : tool.execute(...args);
      held.streamArgs = tool.streamArgs;
    }
  }
  private async session(id: string): Promise<AgentSession> {
    const lane = this.lane(id);
    if (this.state.current !== this && !lane.pumping) return this.state.current.session(id);
    if (lane.session) return lane.session;
    if (lane.creating) return lane.creating;
    lane.creating = (async () => {
      const agent = await this.deps.store.getAgent(id);
      if (!agent) throw new Error(`Agent ${id} not found`);
      const person = this.deps.person(agent.ownerId);
      if (!person) throw new Error(`Owner ${agent.ownerId} not configured`);
      assertPersonModel(person, agent.model);
      const hosted = hostedManager(person);
      if (agent.role === 'manager' && !hosted) throw new Error(`${person.name}'s manager is not hosted on this channel`);
      const catalog = JSON.parse(await readFile(this.deps.config.modelsPath, 'utf8'));
      const providers = catalog.catalog?.providers ?? catalog.providers;
      const provider = (['anthropic', 'openai-codex', 'openrouter', 'xai', 'nvidia', 'google-cli'] as const).find(id => providers?.[id]?.models?.some((model: { id: string }) => model.id === agent.model));
      if (!provider) throw new Error(`Configured subscription model not found: ${agent.model}`);
      assertAllowedProvider(this.deps.config.allowedProviders, provider);
      if ((provider === 'google-cli') && agent.role !== 'worker') throw new Error('google_antigravity_workers_only: native Antigravity serves selectable workers only');
      if (provider === 'nvidia' && agent.role !== 'worker') throw new Error('nvidia_workers_only: NVIDIA free models log prompts and outputs; they serve research and public-code workers only, never Kenaznia or chats');
      const blank = agent.role === 'blank';
      const baseProfile = agent.role === 'manager' ? hosted! : person.worker;
      const profile = { ...baseProfile, provider, model: agent.model, thinking: agent.thinking ?? baseProfile.thinking, ...(agent.thinking != null ? {refusalFallbackModels: []} : {}), ...(blank ? { systemPrompt: BLANK_PROMPT, contextFiles: [] } : {}) };
      const path = await this.deps.store.agentSessionPath(id);
      if (!path) throw new Error('Session path missing');
      await mkdir(dirname(path), { recursive: true });
      const agentDir = agentConfigDir(this.deps.config.dataDir, id);
      await mkdir(agentDir, { recursive: true });
      const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, 'auth.json'), modelsPath: null, refreshOnCreate: false });
      await configurePool(modelRuntime, person, profile, this.deps.config.modelsPath, this.deps.config.allowedProviders, agent.id, () => turnWorkClass([...(lane.active ?? []), ...lane.steered]));
      const model = modelRuntime.getModel(profile.provider, agent.model);
      if (!model) throw new Error(`Unknown model ${profile.provider}/${agent.model}`);
      const refusalFallbacks = profile.refusalFallbackModels.filter(id => id !== agent.model).map(id => {
        const fallback = modelRuntime.getModel(profile.provider, id);
        if (!fallback) throw new Error(`Configured refusal fallback model not found: ${profile.provider}/${id}`);
        return fallback;
      });
      const grant = agent.role === 'worker' ? (await readGrant(agentDir)) ?? [] : null;
      const context = await contextSections(profile.contextFiles);
      const extensions = blank ? [] : this.deps.extensions.filter(e => personToolAllowed(person, e.id) && (e.enabled ? e.enabled(person) : person.extensions.includes(e.id)) && (!e.roles || (agent.role !== 'blank' && e.roles.includes(agent.role))));
      const launcher = agent.role === 'worker' && agent.parentAgentId ? await this.deps.store.getAgent(agent.parentAgentId) : null;
      const swarmRole = agent.role === 'worker' ? `${launcher && isSubAgent(agent, launcher) ? SUB_AGENT_PROMPT + ' ' : ''}${coordinatorPrompt(person)}` : '';
      const platform = blank ? '' : agent.role === 'worker' ? `You are a worker (your id: ${agent.id})${agent.parentAgentId ? ` launched by ${agent.parentAgentId}` : ''}. Work on your assigned goal${agent.goalId ? ` (goal id: ${agent.goalId}; use it to launch sub-agents)` : ''}. Edit live trees directly; use a private checkout of only the necessary paths when concurrent editing would disturb a build, then fold it back on completion. When your manager must act on something now, before your report (an urgent hand-off, a time-critical URL), send it with workers message to your parent's id and your run continues; a coordinator reads it in its current turn, and a person's Kenaznia within about two minutes, after it finishes answering the person. Messages from your manager join your current turn. You can message any agent on the host directly with workers message (id or 8+ character prefix): another worker, a sub-agent in another swarm, a Kenaznia or another person's agent; workers find lists agents by goal, name, parent or person. Messages from other agents name the sender and its id; reply to that id. When you hit a bug in a tool, the stack or a host service, or find other work that deserves its own owner, first look for a worker already on it (workers find by name, or goals list) and message that one; otherwise dispatch a worker for it with workers dispatch (a title naming the tool and the bug, a brief with the evidence and the end state): it gets its own goal and reports to Kenaznia, not to you, and you carry on with your own task. Dispatch searches too: if an active worker already owns that tool or problem (gpurun, cpu-slot and the other host tools each have one standing owner), your brief goes to it as a message instead and you get its id. Your final step is always one call to report: done with the result, or blocked with what failed and what you need; write the result in the report itself, not only as a message. A done report archives this run after the turn settles. A turn you end without reporting, while you own no pending wake, unfinished job or active worker, ends the run anyway: your last message is filed as your report (blocked if it says you are blocked or need something, otherwise done). When the next step has to wait, schedule a wake on the event you wait for with a time as its deadline (never a time alone unless the time itself is the point) and end your turn without reporting. A waiting worker is a warning sign: you keep a wake only up to ${SHORT_WAIT_MS / 60_000} minutes; a longer wait hands off (the wake tool takes your handoff, your manager holds the trigger for your goal, this run is archived, and a fresh worker is launched when it fires). Use workers archive for other finished runs; never resume archived historical work without a current instruction. When the person should see a file (an image, a PDF, anything), give your parent its path in your report or a note; it attaches it to its chat. ${BACKGROUND_BLOCKS} ${swarmRole}` : `You are Kenaznia (your id: ${agent.id}). Curate your goals and manage workers. Use the usage tool to control total subscription drain. Spawn at most one active worker per goal. Human messages take priority. Archive worker runs when nothing remains for them using workers archive. To see what workers are actually doing right now (before summarising them for the person, or when one has gone quiet), use workers peek: without an id, one line per active worker (goal, state, idle time, its last sentence and last tool call); with an id, one worker in detail. Workers don't wait long: a worker whose wait would exceed ${SHORT_WAIT_MS / 60_000} minutes hands its trigger to you with a handoff (also in the goal notes) and is archived. wake list shows every trigger you hold with its goal and handoff. When one fires you get the event and the handoff: launch a fresh worker for that goal right away (or message the goal's active worker). Any worker, sub-agents included, may dispatch a worker under you for new work (workers dispatch: a new goal and a worker whose parent is you), most often to fix a system bug it hit; you get a note naming the dispatcher, and the worker reports to you like any other. Each host tool (gpurun, cpu-slot and the others workers dispatch names) has one standing owner at a time: a dispatch naming it goes to that worker as a message instead of launching another, and before you spawn a fixer for a host tool yourself, check workers find for one already on it and message it instead. Check it doesn't duplicate work already running, and otherwise let it work. A worker still waiting shows as a warning in lists, peek, the heartbeat and the sidebar. You stay available to the person at all times; you are never archived. To show the person a file (an image, a chart, a PDF, any file, including paths a worker hands you), send it in this chat with the attach tool; it appears exactly like the files they send you. Inputs that come from no person (worker notes and reports, peer messages, wakes, heartbeats, system notices) fold into a compact expandable background rows in the chat, and so does your work on them. They reach you in batches, never in the middle of a turn: whatever arrived while you were busy, or within a minute or two of each other, comes together in one turn, so the person's messages always come first. Handle the whole batch in that turn (one workers peek or goals list can cover several inputs). When one needs nothing from the person, answer with exactly NO_REPLY and nothing else: it is kept for the record but never shown or notified. Any other words you write are shown to the person, so write only what they should read. ${BACKGROUND_BLOCKS} Your thinking is never shown: an answer exists for the person only once you write it as text. ${canChooseChat(person) ? `Where background answers appear: for a person who works in topic chats, a report, note or wake about work you started or instructed from a chat (a spawn, a workers message, a wake you scheduled, a peer message you sent) is answered in that chat, and the input says so ("your answer appears there"); notify and attach then point at that chat too. If that chat is closed or they left it, the input says the answer appears here instead, so name the chat it came from. Heartbeats, and everything for a person on the Classic layout, are answered here. On the Organized layout she can ask from any chat for results to land in another ("do this, send it to Business"): give workers spawn or message, or wake schedule, that chat's chatId (from rooms list) so the report and your answer appear there, or put something ready now there with send to kenan:CHAT_ID; then reply briefly where she asked, with a pointer ("On it: results will go to Business"). A goal can belong to one of her existing chats (goals create/update chatId): its workers, their reports and notes, your answers and the triggers held for it then land there without chatId on each call; an explicit chatId still wins, and heartbeats stay in your own chat. ` : ''}Channels: every place you hear people other than in your own chats with the person (shared Kenan chats with two or more people, Signal, Discord, mail, texts to Kenan's line) is a channel. A message from one reaches you here, in your own chat, either straight (a "Kenan chat · …", "Signal · …" line with the text) or in a watcher note; you are never inside those conversations, so what you write here is shown only to the person. To answer on a channel, use the send tool with the channel the input names (kenan:CHAT, signal:…, discord:…, mail:…, texts:…) and, when it gives one, its replyTo. In a shared Kenan chat, "Kenaznia", "Kenan" or "@kenaznia" means the writer's own Kenaznia, so you hear the person's own requests there, messages naming you as theirs ("Alice's Kenaznia"), replies to your messages, and whatever their channel settings pass; you act only for the person, never sharing their private context with the others there. If a channel message needs nothing from you, answer exactly NO_REPLY. Chats with just the person and you are unchanged: you answer in them directly.`;
      const settingsManager = SettingsManager.inMemory(SESSION_SETTINGS);
      const ctx = { person, agent, deps: this.deps };
      const extensionTools = extensions.map(e => ({ tool: liveExtensionTool(e, ctx), note: typeof e.promptSnippet === 'string' ? e.promptSnippet : (agent.role === 'blank' ? '' : e.promptSnippet?.[agent.role] ?? '') }));
      const tools = [...this.coreTools(ctx), ...extensionTools.flatMap(e => e.tool ? [e.tool] : [])].filter(t => personToolAllowed(person, t.name));
      const declaredNames = new Set(declared(tools, grant).map(t => t.name));
      const notesOf = (shown: (name: string) => boolean) => extensionTools.filter(e => e.note && (!e.tool || shown(e.tool.name))).map(e => e.note).join('\n');
      const sections = promptSections(context, notesOf(name => declaredNames.has(name)), blank ? platform : `${platform} ${categoryGuidance}`);
      const loader = new DefaultResourceLoader({ cwd: person.home, agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, systemPrompt: profile.systemPrompt, extensionFactories: [sectionsExtension(sections)] });
      await loader.reload();
      const foreground = this.deps.placement.kind === 'channelScope' ? foregroundRoot(person.home, this.deps.config.channel, agent.id) : undefined;
      if (foreground) await acknowledgeForegroundJournal(foreground, path, this.deps.config.dataDir);
      // An oversized transcript is cut to what Pi still reads before Pi loads all of it (session-trim.ts).
      await trimSessionFile(path, this.deps.config.dataDir).catch(error => console.log(JSON.stringify({ type: 'session_trim_failed', agentId: agent.id, error: String(error) })));
      const fresh = !(await stat(path).catch(() => null));
      const sessionManager = SessionManager.open(path, dirname(path), person.home);
      if (fresh) {
        const history = await this.deps.store.listMessages(agent.conversationId, { kind: 'latest' }, 200);
        for (const message of history.messages) {
          if (lane.active?.some(input => input.humanMessageId === message.id)) continue;
          if (message.role === 'human') sessionManager.appendMessage({ role: 'user', content: message.text, timestamp: message.createdAt });
          // Imported assistant text is context without fabricating provider usage metadata.
          else if (message.role === 'assistant') sessionManager.appendCustomMessageEntry('imported-assistant', `Previous assistant response:\n${message.text}`, false);
        }
      }
      if (grant !== null) {
        tools.push(toolsTool({
          all: () => tools, active: () => [...declaredNames],
          noteFor: name => extensionTools.find(e => e.tool?.name === name)?.note || undefined,
          activate: async names => {
            const added = new Set([...(await readGrant(agentDir) ?? []), ...names]);
            await writeGrant(agentDir, [...added]);
            for (const name of names) declaredNames.add(name);
            lane.session?.setActiveToolsByName([...declaredNames]);
            const notes = notesOf(name => declaredNames.has(name));
            if (notes) sections.extension_notes = notes;
          },
        }));
        declaredNames.add('tools');
      }
      const definitions = lane.toolDefinitions = new Map(tools.map(tool => [tool.name, tool]));
      const customTools = this.wrapTools(agent.id, lane, definitions);
      lane.tools = new Map(customTools.map(tool => [tool.name, tool]));
      const { session } = await createAgentSession({ cwd: person.home, agentDir, modelRuntime, model, thinkingLevel: profile.thinking as any, settingsManager, resourceLoader: loader, sessionManager, noTools: 'builtin', customTools, tools: customTools.map(t => t.name) });
      if (grant !== null) session.setActiveToolsByName(customTools.map(t => t.name).filter(name => declaredNames.has(name)));
      modelContext(session);
      dropForeignThinking(session);
      longPromptCache(session, () => { if (lane.resending) { lane.resending = false; this.steerQueued(id, lane); } });
      lane.serviceTier = serviceTierOf(provider, agent.speed);
      applySpeed(session, () => lane.serviceTier);
      installStreamWatchdog(session, failure => console.log(JSON.stringify({ type: 'model_stream_failed', agentId: agent.id, ...failure })));
      if (person.budget) session.agent.streamFunction = budgetStream(session.agent.streamFunction,
        async () => { await lane.accounting; return allowanceMessage(this.deps.store, person, this.deps.now()); },
        () => { lane.budgetExhausted = true; }, this.deps.now);
      installContextBudget(session, modelRuntime, {
        started: () => this.deps.bus.toConversation(agent.conversationId, { type: 'activity', conversationId: agent.conversationId, activity: { state: 'thinking', label: 'Compacting conversation', since: this.deps.now() } }),
        recovered: outcome => void this.error(agent.id, `context_compaction_recovered: route=${outcome.route}; ${describeFailures(outcome.failures)}`),
        compacted: () => { if (agent.role === 'manager') this.deps.store.heartbeatForgotten(agent.id).catch(e => this.error(agent.id, e)); },
      }, { pinning: agent.role === 'worker' ? 'pin-first-task' : 'none', refusalFallbacks, stream: session.agent.streamFunction, request: compactionRequestFile(join(agentDir, COMPACT_NOW_FILE)) });
      if (foreground) {
        lane.recoverForeground = () => recoveredForeground(foreground, session.messages, () => this.state.closing, () => lane.stopping || lane.stopped || lane.preempting);
        let acknowledged = Promise.resolve();
        (lane.sessionCallbacks ??= []).push(session.subscribe(event => {
          if (event.type !== 'message_end' || !(event.message.role === 'toolResult' && event.message.toolName === 'bash' || event.message.role === 'user' && JSON.stringify(event.message.content).includes('Recovered foreground bash ('))) return;
          // Pi appends the message synchronously after notifying listeners. The promise callback runs after that
          // append, so a crash before persistence retains the pending command. Compaction cannot erase the ack.
          acknowledged = acknowledged.then(() => acknowledgeForeground(foreground, [event.message])).catch(error => this.error(agent.id, error));
        }));
      }
      lane.sessionGeneration = this;
      lane.session = session;
      return session;
    })();
    try { return await lane.creating; } finally { lane.creating = undefined; }
  }
  /**
   * A worker whose model call the broker holds until a known reset (background_reserve) does not end: it parks on a clock
   * wake at the reset, its parent hears once, and the wake's turn carries on with the same model and conversation
   * (2026-11-07: eleven workers filed blocked reports at 01:29 and sat dead 2.5 hours while the windows reset).
   */
  private async parkOrReport(id: string, lane: Lane, evidence: string): Promise<void> {
    const holdUntil = quotaHoldUntil(evidence);
    const agent = holdUntil === null ? null : await this.deps.store.getAgent(id);
    if (holdUntil === null || !agent || agent.role !== 'worker' || agent.archived || agent.lastReport || this.endRequested(lane) || lane.queue.length) return this.reportFailure(id, lane, evidence);
    lane.failure = undefined;
    const resumeAt = quotaResumeAt(holdUntil, this.deps.now());
    await this.deps.store.createWake({ agentId: id, ownerId: agent.ownerId, message: quotaResumeText(agent.model), originConversationId: agent.originConversationId,
      trigger: { at: resumeAt, event: null, listen: { kind: 'clock', reason: QUOTA_WAKE_REASON } } });
    console.log(JSON.stringify({ type: 'worker_parked_on_quota', agentId: id, parentAgentId: agent.parentAgentId, resumeAt: new Date(resumeAt).toISOString() }));
    // The worker's waiting state already reports this pause; do not wake its parent for a shared quota.
  }
  /**
   * A worker whose turn ends on an error it did not recover from, before it reported, files a blocked report with the
   * evidence, so its launcher never waits on a dead child: Acme child 23ed8dcd ended on two provider refusals of its
   * model with no report, and its parent would have idled forever. The run stays available; a message retries it.
   */
  private async reportFailure(id: string, lane: Lane, evidence: string): Promise<void> {
    lane.failure = undefined;
    if (this.endRequested(lane) || lane.queue.length) return;
    const agent = await this.deps.store.getAgent(id);
    if (!agent || agent.role !== 'worker' || agent.archived || agent.lastReport || liveCallOf(agent.id)) return;
    console.log(JSON.stringify({ type: 'worker_failure_reported', agentId: id, parentAgentId: agent.parentAgentId, evidence: evidence.slice(0, 500) }));
    await fileReport({ ...this.deps, runtime: this }, agent, 'blocked', `Failed and stopped: ${evidence}\nModel ${agent.model}${agent.thinking ? `, thinking ${agent.thinking}` : ''}. Nothing more will happen on this run by itself. Message it (workers message id ${agent.id}) to retry the same model, or launch a fresh worker with a model the route serves.`);
  }
  private async pump(id: string, lane: Lane): Promise<void> {
    lane.pumping = true;
    try {
      while (this.state.current === this && lane.queue.length > 0 && !lane.stopped && !lane.rewriting && !this.state.closing && !this.state.paused.has(id)) {
        // A prewarm may still be creating an idle session from an earlier release.
        // Do not dispose a session while that constructor or an old turn is using it.
        if (lane.creating) await lane.creating;
        if (this.state.current !== this) break;
        // Only a session an earlier release created is replaced; one with no recorded generation was handed in whole (tests).
        if (lane.session && lane.sessionGeneration !== undefined && lane.sessionGeneration !== this) this.disposeSession(lane);
        if (this.gather(id, lane)) break;
        const first = lane.queue.shift()!;
        const batch = first.kind === 'human' || first.resume ? [first]
          : this.isManager(id) && (isBackground(first) || first.kind === 'restart') ? [first, ...take(lane.queue, input => isBackground(input) && shareTurn(first, input))]
          : [first, ...lane.queue.splice(0, untilBatchEnd(lane.queue, first))];
        dedupe(id, batch, lane.queue);
        lane.restoredTurn = undefined; lane.active = batch; lane.startedAt = this.deps.now(); lane.steered = []; lane.joined = new Set(); lane.unseen = new Set(); lane.reportBasis = undefined; lane.settling = false; lane.calling = false; lane.resending = !!first.resume;
        this.waitingChanged(id, lane);
        try {
          const queuedBefore = new Set(lane.queue);
          const session = await this.session(id);
          const repeats = repeatedFirings(batch, session.messages);
          if (repeats.length) {
            for (const input of repeats) console.log(JSON.stringify({ type: 'wake_firing_duplicate', agentId: id, firingId: input.firingId, where: 'batch' }));
            this.consume(repeats);
            for (const input of repeats) batch.splice(batch.indexOf(input), 1);
            if (!batch.length) { lane.active = undefined; this.waitingChanged(id, lane); continue; }
          }
          // Stopped before the model read it: the batch is carried into the next turn, like everything queued.
          if (lane.stopping) { lane.queue.unshift(...batch); continue; }
          if (lane.preempting) { lane.queue.push(...batch); continue; }
          const previous = await this.deps.store.getAgent(id);
          if (!previous || previous.archived) { lane.stopped = true; lane.archived = true; this.orphan(id, [...batch, ...lane.queue]); lane.queue = []; continue; }
          // A done report whose turn ended with input queued is not archived on; a wake firing that starts the next turn
          // withdraws it, as one that joined the reporting turn would (confirmDone), so the run reports that outcome once more.
          // Assignments do too: their sender may have checked lastReport before the reporting tool wrote it.
          if (previous.role === 'worker' && previous.lastReport?.status === 'done' && batch.some(input => input.firingId !== undefined || input.kind === 'agent' && (input.fromId === previous.parentAgentId || input.fromId === this.managerFor(previous.ownerId)))) await this.publishAgent(await this.deps.store.updateAgent(id, { lastReport: null }));
          const agent = await this.deps.store.updateAgent(id, { state: 'running', turnChat: { conversationId: first.conversationId, chatBound: !!first.chatBound } });
          this.deps.bus.toPerson(agent.ownerId, { type: 'agent', agent });
          await lane.notices;
          lane.failure = undefined; lane.budgetExhausted = false;
          // Input that arrived while the session was being built (after a restart) could not join yet: it joins now, not next turn.
          this.steerQueued(id, lane, input => !queuedBefore.has(input));
          await this.runTurn(agent, lane, session, batch);
          if (this.state.closing || this.state.paused.has(id) || lane.rewriting) continue;
          if (lane.failure) await this.parkOrReport(id, lane, lane.failure);
          // A check that fails leaves the run open as before; it never turns a finished turn into an error.
          else if (!lane.budgetExhausted) await this.reportImplicitly(id, lane, session, batch).catch(e => this.error(id, `implicit_report_failed: ${String(e)}`));
          const settled = await this.deps.store.getAgent(id);
          const current = settled?.role === 'worker' && settled.lastReport?.status === 'done' && !lane.queue.length && !lane.preempting ? await this.confirmDone(settled, lane) : settled;
          const completed = current?.role === 'worker' && (current.lastReport?.status === 'done' || current.lastReport?.status === 'handed_off') && !lane.queue.length && !lane.preempting;
          // Only archiving stops a run for good; an interrupted turn leaves it available for its next input and wakes.
          if (completed || current?.archived) lane.archived = true;
          const updated = await this.deps.store.updateAgent(id, completed ? { state: 'stopped', archived: true } : { state: current?.archived ? 'stopped' : 'idle' });
          await this.publishAgent(updated);
          if (completed) { await this.stopSubAgents(id); await this.passHeldUp(updated); await this.adoptChildren(updated); }
        } catch (e) {
          await this.error(id, e);
          if (this.state.closing || this.state.paused.has(id) || lane.rewriting) continue;
          // The failed turn's input goes with it, as the error notice says; it is not delivered again at the next start.
          this.consume(batch);
          const agent = await this.deps.store.updateAgent(id, { state: 'error' });
          this.deps.bus.toPerson(agent.ownerId, { type: 'agent', agent });
          const message = await this.deps.store.appendMessage({ conversationId: first.conversationId, authorId: id, role: 'notice', notice: 'agent_error', text: `Agent error: ${String(e)}`, state: 'error' });
          this.deps.bus.toConversation(first.conversationId, { type: 'message', message });
          await this.reportFailure(id, lane, `its turn failed before or while calling the model: ${String(e).slice(0, 1000)}`).catch(failure => this.error(id, failure));
        } finally {
          releaseLiveExtensionCalls(this.deps, id);
          if (lane.preempting && lane.active === batch) {
            if (lane.prompted) lane.cutOff = true;
            else if (!lane.queue.includes(first)) lane.queue.push(...batch);
          }
          if (lane.stopping) { lane.stopping = false; lane.cutOff = false; lane.stoppedTurn ||= lane.prompted; }
          if (!this.state.closing) { lane.active = undefined; lane.prompted = false; lane.resending = false; }
          lane.preempting = false;
        }
      }
    } finally {
      lane.pumping = false;
      // Input that reached the lane after its run was stopped (steered into the turn being stopped, then given back
      // unread) would otherwise wait here forever: worker 59b028c6 was archived while a peer message was steered in.
      if (!this.state.closing && !this.state.paused.has(id) && lane.stopped && lane.queue.length) this.orphan(id, lane.queue.splice(0));
      this.waitingChanged(id, lane);
      const current = this.state.current;
      if (current !== this) current.startPump(id, lane);
      if (!lane.pumping && !this.state.closing && !lane.stopped && !current.isManager(id)) current.releaseWhenIdle(lane);
    }
  }
  /** Only called at an idle/finished-turn boundary, never while a constructor is running. */
  private disposeSession(lane: Lane): void {
    clearTimeout(lane.release); lane.release = undefined;
    for (const unsubscribe of lane.sessionCallbacks ?? []) unsubscribe();
    lane.sessionCallbacks = undefined;
    lane.session?.clearQueue(); lane.session?.dispose(); lane.session = undefined;
    lane.sessionGeneration = undefined;
    lane.tools = undefined;
    lane.toolDefinitions = undefined;
    lane.toolExecutions = undefined;
    lane.recoverForeground = undefined;
    lane.serviceTier = undefined;
  }
  /**
   * A live session holds the agent's transcript in memory, and Pi never lets go of it: on 2026-10-31 Beta's heap stayed near
   * 2 GiB of sessions, most of them workers waiting on a wake or a reply, and its garbage collection stalled every agent. A
   * worker idle for IDLE_SESSION_MS (the prompt cache's own lifetime, so the next turn pays nothing extra) drops its session;
   * the next turn reopens it from disk, as after a reparent. Managers keep theirs so a person never waits for a reload.
   */
  private releaseWhenIdle(lane: Lane): void {
    clearTimeout(lane.release);
    lane.release = setTimeout(() => {
      if (lane.active || lane.creating || lane.pumping || lane.queue.length || lane.stopped || !lane.session) return;
      this.disposeSession(lane);
    }, IDLE_SESSION_MS);
    lane.release.unref?.();
  }
  private async runTurn(agent: AgentInfo, lane: Lane, session: AgentSession, batch: AgentInput[]): Promise<void> {
    const conversationId = batch[0]!.conversationId;
    const person = this.deps.person(agent.ownerId);
    const allowance = person ? await allowanceMessage(this.deps.store, person, this.deps.now()) : null;
    if (allowance) {
      lane.budgetExhausted = true;
      // No prompt will read the queued steering messages. Consume the whole active batch once and remove those
      // messages from Pi too, so they cannot run later when this person's allowance becomes available again.
      lane.settling = true;
      await lane.steering;
      session.clearQueue();
      lane.unread = []; lane.steered = []; lane.unseen.clear();
      this.consume(batch);
      const message = await this.deps.store.appendMessage({ conversationId, authorId: agent.id, role: 'assistant', display: 'shown', text: allowance });
      this.deps.bus.toConversation(conversationId, { type: 'message', message });
      return;
    }
    const background = answersBackground(agent.role, batch) && !(batch.some(input => CONTINUATIONS.has(input.kind)) && await this.deps.store.awaitingReply(conversationId));
    lane.unshown = agent.role === 'manager' && !background;
    let current: Message | undefined;
    let text = '';
    /** The current message's text streamed so far: its shown parts (background blocks never stream), held back while it may still be NO_REPLY. */
    let streamed = '';
    /** The current message's thinking as it streams: each `thinking` event names its block, and a mid-stream message update keeps it. */
    let thinking: string[] = [];
    /** The turn's own messages and how each is drawn, so a NO_REPLY answer can fold away the work before it. */
    const drawn = new Map<string, MessageDisplay>();
    let answer: MessageDisplay | null = null;
    let parts: MessagePart[] = [];
    let refused: string | null = null;
    /** A failed model call waits here until Pi either resends it (auto_retry_start) or doesn't; only then is it an error. */
    let failed: { messageId: string; text: string; error: string; model: string } | null = null;
    const retried: { error: string; at: number }[] = [];
    /** A failure Pi did not resend is the turn's error, shown and logged as before. */
    const surfaceFailure = async () => {
      if (!failed) return;
      const { messageId, text: shownText, error, model } = failed; failed = null;
      lane.failure = refused ? rejectedFailure(model, error) : `the model call on ${model} failed: ${error}${retried.length ? ` (after ${retried.length} earlier attempt${retried.length === 1 ? '' : 's'} that were resent: ${retried.map(r => r.error.slice(0, 200)).join(' | ')})` : ''}`;
      // A local background reserve pauses work; it did not reject a person's message.
      const reserveWait = background && quotaHoldUntil(error) !== null;
      const message = await this.deps.store.updateMessage(messageId, { display: reserveWait ? (/^\s*429\b/.test(shownText) ? 'silent' : 'background') : refused ? 'shown' : finishedDisplay(shownText, background) });
      this.deps.bus.toConversation(conversationId, { type: 'message', message });
      if (reserveWait) console.log(JSON.stringify({ type: 'background_quota_wait', agentId: agent.id, model, until: quotaHoldUntil(error) }));
      else await this.error(agent.id, refused ? `model_request_rejected: ${model}: ${error}` : error);
    };
    const toolMessages = new Map<string, Message>();
    const firstTokens = new Set<string>();
    let chain = Promise.resolve();
    const publish = (next: Activity | null) => this.deps.bus.toConversation(conversationId, { type: 'activity', conversationId, activity: next });
    const runningTools = new Map<string, string>();
    const activity = (state: Activity['state'], label: string | null = null) => {
      const shown = this.deps.bus.activity(conversationId);
      if (shown?.state !== state || shown.label !== label) publish({ state, label, since: this.deps.now() });
    };
    const showText = async (delta: string) => {
      flushDraft();
      text += delta;
      parts = replacePartsText(parts, text);
      const visible = shownWhileStreaming(text);
      const liveParts = () => {
        if (visible === text) return parts;
        const pieces = backgroundPieces(text);
        const ordered = splitTextParts(parts, text, pieces.map(piece => piece.text));
        const shown = ordered.filter((_, i) => !pieces[i]!.background);
        const projected = shown.flatMap((row, i): MessagePart[] => i ? [{ type: 'text', text: '\n\n' }, ...row] : row);
        return replacePartsText(projected, visible);
      };
      if (current && !mayBeNoReply(visible) && visible !== streamed) {
        // Words in a background turn are a reply to the person, so the message leaves the background as it streams.
        if (current.display !== 'shown') {
          current = await this.deps.store.updateMessage(current.id, { text: visible, parts: liveParts(), display: 'shown' });
          drawn.set(current.id, 'shown');
          this.deps.bus.toConversation(conversationId, { type: 'message', message: current });
        } else if (visible.startsWith(streamed)) this.deps.bus.toConversation(conversationId, { type: 'delta', conversationId, messageId: current.id, text: visible.slice(streamed.length) });
        // A marker line that just closed can take back held text: the whole shown text replaces what streamed.
        else {
          current = await this.deps.store.updateMessage(current.id, { text: visible, parts: liveParts() });
          this.deps.bus.toConversation(conversationId, { type: 'message', message: current });
        }
        streamed = visible;
      }
      await Promise.all((lane.active ?? []).filter(input => input.humanMessageId && !firstTokens.has(input.humanMessageId)).map(input => { firstTokens.add(input.humanMessageId!); return this.mark(input, 'first_token_at'); }));
      activity('streaming');
    };
    const afterTools = () => { const running = [...runningTools.values()].at(-1); if (running) activity('tool', running); else activity('thinking'); };
    /** The tool call being written right now, drawn live (tool-draft.ts): sent at most every TOOL_DRAFT_MS, through the chain so it never lands after its settled message. */
    let pendingDraft: { index: number; partial: { content: { type: string }[] } } | null = null;
    let draftTimer: ReturnType<typeof setTimeout> | undefined;
    let draftAt = -Infinity;
    const dropDraft = () => { clearTimeout(draftTimer); draftTimer = undefined; pendingDraft = null; };
    const flushDraft = () => {
      const pending = pendingDraft; dropDraft();
      const block = pending?.partial.content[pending.index] as { type: string; id?: string; name?: string; arguments?: unknown } | undefined;
      if (!current || block?.type !== 'toolCall' || !block.id || !block.name) return;
      draftAt = this.deps.now();
      const part = toolDraft(block.id, block.name, block.arguments ?? {});
      const index = parts.findIndex(p => p.type === 'tool' && p.callId === part.callId);
      if (index < 0) parts.push(part); else parts[index] = part;
      this.deps.bus.toConversation(conversationId, { type: 'tool_draft', conversationId, messageId: current.id, part });
      activity('streaming', draftLabel(part));
    };
    activity('thinking');
    /** A finished message with ::bg blocks becomes one row per part, in order: background parts fold away, shown parts stay messages. */
    const finishMessage = async (state: Message['state'] = 'done', shown?: MessageDisplay) => {
      if (!current) return;
      const pieces = shown ? [] : backgroundPieces(text);
      const split = pieces.some(piece => piece.background);
      const rows = split ? pieces : [{ text, background: false }];
      const ordered = split ? splitTextParts(parts, text, rows.map(piece => piece.text)) : [parts];
      const displays: MessageDisplay[] = [];
      for (const [at, piece] of rows.entries()) {
        const display = piece.background ? 'background' : at === 0 && shown ? shown : finishedDisplay(piece.text, background);
        // Words to a person never carry the token; in a background turn a closing NO_REPLY has already made the whole message silent.
        const body = display === 'shown' ? stripNoReply(piece.text) : piece.text;
        const rowParts = replacePartsText(ordered[at]!, body);
        if (!split) text = body;
        const message = at === 0
          ? await this.deps.store.updateMessage(current.id, { text: body, parts: rowParts, state, display })
          : await this.deps.store.appendMessage({ conversationId, authorId: agent.id, role: 'assistant', text: body, parts: rowParts, state, display });
        drawn.set(message.id, display); displays.push(display);
        if (!piece.background && !mayBeNoReply(body)) worded.add(message.id);
        this.deps.bus.toConversation(conversationId, { type: 'message', message });
        if (state === 'done' && body && display === 'shown') {
          queueKenazniaNotification(this.deps, message);
          await this.routeRoomReply(message);
        }
      }
      answer = displays.includes('silent') ? 'silent' : displays.includes('shown') ? 'shown' : displays.at(-1)!;
      current = undefined;
    };
    /** An answer of NO_REPLY folds the turn's wordless work into the background. Words always stay shown, in any turn: on Beta 2026-10-23 answers to Alice written in background turns (her house taxes at 19:40Z) folded away when the turn ended NO_REPLY. */
    const worded = new Set<string>();
    const foldSilentTurn = async () => {
      if (answer !== 'silent') return;
      for (const [id, display] of drawn) {
        if (display !== 'shown' || worded.has(id)) continue;
        const message = await this.deps.store.updateMessage(id, { display: 'background' });
        this.deps.bus.toConversation(conversationId, { type: 'message', message });
      }
    };
    const unsubscribe = session.subscribe(event => {
      // Pi writes a user message to the session file right after this listener returns; the row goes after that.
      if (event.type === 'message_end' && event.message.role === 'user') {
        const text = userText(event.message.content);
        const at = lane.unread.findIndex(entry => entry.text === text);
        if (at >= 0) { const { inputs } = lane.unread.splice(at, 1)[0]!; for (const input of inputs) lane.unseen.delete(input); this.read(inputs); this.consume(inputs); }
      }
      // Before its tool calls run, so their results already know the person has read words.
      if (event.type === 'message_end' && event.message.role === 'assistant' && !mayBeNoReply(shownWhileStreaming(event.message.content.flatMap(part => part.type === 'text' ? [part.text] : []).join('')))) lane.unshown = false;
      // The initial request is on its way, so queued input may join before the next call. This also takes
      // worker reports held during human preemption; newer arrivals must not pass them for the whole turn.
      if (event.type === 'message_start' && event.message.role === 'assistant') { lane.resending = false; this.steerQueued(agent.id, lane); }
      if (event.type === 'turn_start' || event.type === 'auto_retry_start') lane.calling = true;
      else if (event.type === 'message_end' && event.message.role === 'assistant') lane.calling = event.message.stopReason === 'error' || event.message.stopReason === 'aborted';
      else if (event.type === 'turn_end' && event.toolResults.length) lane.calling = true;
      // Tool arguments stream straight to the tool, ahead of the persistence chain: a live reply is spoken as it is written.
      if (event.type === 'message_update' && event.assistantMessageEvent.type === 'toolcall_delta') {
        const block = event.assistantMessageEvent.partial.content[event.assistantMessageEvent.contentIndex];
        const tool = block?.type === 'toolCall' ? lane.tools?.get(block.name) : undefined;
        if (block?.type === 'toolCall' && tool?.streamArgs) { try { tool.streamArgs(block.id, block.arguments); } catch (e) { void this.error(agent.id, e); } }
      }
      chain = chain.then(async () => {
        if (event.type === 'message_start' && event.message.role === 'assistant') {
          dropDraft(); await finishMessage(); await surfaceFailure(); text = ''; parts = []; streamed = ''; thinking = [];
          activity('thinking');
          current = await this.deps.store.appendMessage({ conversationId, authorId: agent.id, role: 'assistant', text: '', state: 'streaming', display: background ? 'background' : 'shown' });
          drawn.set(current.id, current.display);
          this.deps.bus.toConversation(conversationId, { type: 'message', message: current });
        } else if (event.type === 'message_update' && (event.assistantMessageEvent.type === 'thinking_start' || event.assistantMessageEvent.type === 'thinking_delta')) {
          flushDraft();
          if (event.assistantMessageEvent.type === 'thinking_start' || !thinking.length) { thinking.push(''); parts.push({ type: 'thinking', text: '' }); }
          const delta = event.assistantMessageEvent.type === 'thinking_delta' ? event.assistantMessageEvent.delta : '';
          if (current) {
            thinking[thinking.length - 1] += delta;
            const at = parts.flatMap((p, i) => p.type === 'thinking' ? [i] : []).at(-1);
            if (at !== undefined) parts[at] = { type: 'thinking', text: thinking.at(-1)! };
            this.deps.bus.toConversation(conversationId, { type: 'thinking', conversationId, messageId: current.id, block: thinking.length - 1, text: delta }); }
        } else if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
          await showText(event.assistantMessageEvent.delta);
        } else if (event.type === 'message_update' && (event.assistantMessageEvent.type === 'toolcall_start' || event.assistantMessageEvent.type === 'toolcall_delta' || event.assistantMessageEvent.type === 'toolcall_end')) {
          const e = event.assistantMessageEvent;
          if (pendingDraft && pendingDraft.index !== e.contentIndex) flushDraft();
          pendingDraft = { index: e.contentIndex, partial: e.partial };
          const wait = draftAt + TOOL_DRAFT_MS - this.deps.now();
          // A finished call is drawn whole at once; a growing one at most every TOOL_DRAFT_MS.
          if (e.type === 'toolcall_end' || wait <= 0) flushDraft();
          else draftTimer ??= setTimeout(() => { draftTimer = undefined; chain = chain.then(flushDraft); }, wait);
        } else if (event.type === 'auto_retry_start') {
          lane.failure = undefined;
          // The failed attempt stays in history, folded away; the same request goes out again, so it is not an error.
          if (failed) { console.log(JSON.stringify({ type: 'model_call_retry', agentId: agent.id, model: failed.model, attempt: event.attempt, delayMs: event.delayMs, error: failed.error.slice(0, 300) })); retried.push({ error: failed.error, at: this.deps.now() }); failed = null; }
          if (background && quotaHoldUntil(event.errorMessage) !== null) publish(null);
          else activity('thinking', `Retrying in ${Math.round(event.delayMs / 1000)}s after: ${event.errorMessage}`);
        } else if (event.type === 'tool_execution_start') {
          noteToolCall(agent.ownerId, agent, event.toolName, event.args, this.deps.now());
          const part: MessagePart = { type: 'tool', callId: event.toolCallId, name: event.toolName, args: publicToolArgs(event.toolName, event.args), result: null, isError: false };
          const tool = await this.deps.store.appendMessage({ conversationId, authorId: agent.id, role: 'tool', text: event.toolName, parts: [part], state: 'streaming', display: background ? 'background' : 'shown' });
          toolMessages.set(event.toolCallId, tool); drawn.set(tool.id, tool.display);
          this.deps.bus.toConversation(conversationId, { type: 'message', message: tool }); runningTools.set(event.toolCallId, event.toolName); activity('tool', event.toolName);
        } else if (event.type === 'tool_execution_end') {
          const tool = toolMessages.get(event.toolCallId);
          const part = tool?.parts[0];
          if (tool && part?.type === 'tool') {
            part.result = JSON.stringify(event.result); part.isError = event.isError;
            const updated = await this.deps.store.updateMessage(tool.id, { parts: [part], state: event.isError ? 'error' : 'done' });
            this.deps.bus.toConversation(conversationId, { type: 'message', message: updated });
          }
          runningTools.delete(event.toolCallId); afterTools();
        } else if (event.type === 'message_end' && event.message.role === 'assistant') {
          dropDraft();
          const message = event.message;
          const content = message.content;
          text = content.flatMap(part => part.type === 'text' ? [part.text] : []).join('');
          refused = isRefusal(message) ? message.errorMessage! : null;
          // A call cut off by an abort or a failed model call never runs, so it isn't drawn: its live card just goes.
          const runs = message.stopReason !== 'aborted' && message.stopReason !== 'error';
          parts = content.flatMap((part): MessagePart[] => part.type === 'text' ? [{ type: 'text', text: part.text }] : part.type === 'thinking' ? [{ type: 'thinking', text: part.thinking }] : part.type === 'toolCall' && runs ? [{ type: 'tool', callId: part.id, name: part.name, args: publicToolArgs(part.name, part.arguments), result: null, isError: false }] : []);
          const usage = message.usage;
          // Pi sets responseModel only when the provider says a different model answered than the one asked for.
          if (message.responseModel) console.error(JSON.stringify({ type: 'served_model_differs', agentId: agent.id, requested: message.model, served: message.responseModel }));
          if (!isAllowanceMessage(message)) await this.deps.store.recordModelCall({ agentId: agent.id, model: message.responseModel ?? message.model, inputTokens: usage.input, outputTokens: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite, costUsd: usage.cost.total, at: this.deps.now() });
          const outcome = turnOutcome(message.stopReason, this.endRequested(lane));
          if (outcome === 'error') {
            text += refused ? `${text ? '\n' : ''}${rejectedText(refused)}` : message.errorMessage ? `\n${message.errorMessage}` : '\nModel request failed';
            parts = replacePartsText(parts, text);
            if (current) { failed = { messageId: current.id, text, error: message.errorMessage ?? 'Model request failed', model: message.model }; await finishMessage(outcome, 'background'); }
            else { lane.failure = refused ? rejectedFailure(message.model, refused) : `the model call on ${message.model} failed: ${message.errorMessage ?? 'Model request failed'}`; await this.error(agent.id, message.errorMessage); }
          } else {
            lane.failure = undefined;
            if (outcome === 'done' && retried.length) console.log(JSON.stringify({ type: 'model_call_resumed', agentId: agent.id, model: message.model, attempts: retried.length, afterMs: this.deps.now() - retried[0]!.at, firstError: retried[0]!.error.slice(0, 300) }));
            retried.length = 0;
            await finishMessage(outcome, isAllowanceMessage(message) ? 'shown' : undefined);
          }
          afterTools();
        }
      }).catch(e => this.error(agent.id, e));
      lane.accounting = chain;
    });
    try {
      await Promise.all(batch.map(input => this.mark(input, 'model_request_at')));
      const recovered = lane.recoverForeground ? await lane.recoverForeground() : '';
      if (this.endRequested(lane)) return;
      // A saved command result takes precedence over a synthetic abort result from shutdown.
      // Otherwise a resume input whose transcript no longer owes a call is the ordinary restart notice.
      const resumeCall = !recovered && batch[0]!.resume === 'model_call' && owedModelCall(session.messages);
      if (resumeCall) {
        if (this.state.closing) return;
        lane.prompted = true; lane.cutOff = false; lane.calling = true;
        this.consume(batch);
        // The interrupted call performed no tools. Give it the worker's waiting instructions before
        // sending it again, rather than repeating minutes of obsolete thinking before reading them.
        // Managers still gather background inputs separately, without interrupting a person's answer.
        if (agent.role === 'worker') {
          lane.resending = false;
          this.steerQueued(agent.id, lane);
          await lane.steering;
        }
        console.log(JSON.stringify({ type: 'model_call_resumed_after_restart', agentId: agent.id }));
        try { await resumeModelCall(session); } finally { await this.reclaimSteered(lane, session); }
        await chain;
        return;
      }
      const wasResending = lane.resending;
      lane.resending = false;
      // Only a replaced resend releases inputs held behind it. Ordinary turns keep their queued
      // background input for its own turn, including after a person takes a reserved slot.
      if (wasResending) this.steerQueued(agent.id, lane);
      const own = batch.filter(input => !lane.joined.has(input));
      const inputs = await Promise.all(own.map(input => promptInput(this.deps, input.resume ? { ...input, text: RESTART_NOTICE } : input)));
      if (this.state.closing) return;
      const texts = inputs.map(input => input.text);
      if (recovered) texts.push(redactCredentials(recovered).text);
      const gathered = own.filter(isBackground).length;
      if (gathered > 1) texts.unshift(digestHeader(gathered));
      if (lane.cutOff) texts.unshift(`[notice from system]\n${PREEMPT_NOTICE}`);
      else if (lane.stoppedTurn) texts.unshift(`[notice from system]\n${STOP_NOTICE}`);
      if (agent.role !== 'blank') {
        const zone = await this.deps.store.zoneReportOf(agent.ownerId);
        const person = this.deps.person(agent.ownerId);
        if (agent.role === 'manager' && person?.extensions.includes('phone-settings')) {
          const location = locationLine(await currentLocation(this.deps.store, person, this.deps.now()), zone?.zone ?? HOME_ZONE);
          if (location) texts.unshift(location);
        }
        texts.unshift(clockLine(zone, this.deps.now()));
      }
      if (this.endRequested(lane)) return;
      lane.prompted = true; lane.cutOff = false; lane.stoppedTurn = false; lane.calling = true;
      const restore = own.some(input => input.live) ? session.thinkingLevel : null;
      if (restore) session.setThinkingLevel(LIVE_THINKING);
      lane.unread.push({ text: texts.join('\n\n'), inputs: own });
      try { await session.prompt(texts.join('\n\n'), { images: inputs.flatMap(input => input.images) }); }
      finally { if (restore) session.setThinkingLevel(restore); await this.reclaimSteered(lane, session); }
      await chain;
    } finally {
      // Input Pi never wrote to the transcript: during shutdown it stays stored for the next start; otherwise the turn
      // failed before reaching the model and the input goes, as the turn's error says.
      if (!this.state.closing) for (const entry of lane.unread.splice(0)) this.consume(entry.inputs);
      lane.unshown = false;
      unsubscribe(); await chain; dropDraft(); await finishMessage(this.endRequested(lane) ? 'stopped' : 'done');
      if (!this.endRequested(lane)) await surfaceFailure();
      if (!this.endRequested(lane)) await foldSilentTurn();
      publish(null);
    }
  }
  private async routeRoomReply(message: Message): Promise<void> {
    const members = await this.deps.store.conversationMembers(message.conversationId);
    for (const id of members) {
      if (id === message.authorId) continue;
      const target = await this.deps.store.getAgent(id);
      if (!target || target.conversationId === message.conversationId) continue;
      const mentioned = [target.id, target.name].some(name => message.text.toLowerCase().includes(`@${name.toLowerCase()}`));
      if (mentioned) this.deliver({ agentId: id, kind: 'room', text: message.text, fromId: message.authorId, conversationId: message.conversationId });
    }
  }
  /** Serialize only worker record changes, not model lookup or running turns. Shared across live upgrades. */
  private async changeWorkers<T>(ownerId: string, change: () => Promise<T>): Promise<T> {
    const changes = this.state.workerChanges ??= new Map();
    const previous = changes.get(ownerId);
    const work = (async () => { if (previous) await previous.catch(() => {}); return change(); })();
    changes.set(ownerId, work);
    try { return await work; } finally { if (changes.get(ownerId) === work) changes.delete(ownerId); }
  }
  private async workerTree(parent: AgentInfo): Promise<{ top: AgentInfo; agents: AgentInfo[] } | null> {
    if (parent.role !== 'worker') return null;
    const ancestors = await this.deps.store.agentAncestors(parent.ownerId, [parent.id]);
    const top = topWorker(parent, new Map(ancestors.map(a => [a.id, a])));
    return { top, agents: await this.deps.store.workerLineage(parent.ownerId, [top.id]) };
  }
  private assertTreeCapacity(tree: { top: AgentInfo; agents: AgentInfo[] }, adding: number): void {
    const active = tree.agents.filter(a => a.role === 'worker' && a.id !== tree.top.id && subAgentActive(a)).length;
    const limit = swarmMaxActive(this.deps.person(tree.top.ownerId)!);
    if (active + adding > limit) throw Object.assign(new Error(`swarm_full: ${active} of ${limit} active descendants under top worker ${tree.top.name} (${tree.top.id}); adding ${adding} would exceed the tree limit`), { code: 'swarm_full', topWorkerId: tree.top.id, count: active, limit });
  }
  private assertTreeSpawnRate(tree: { top: AgentInfo; agents: AgentInfo[] }): void {
    const now = this.deps.now();
    const recent = tree.agents.filter(a => a.role === 'worker' && a.id !== tree.top.id && a.createdAt > now - 60_000);
    if (recent.length >= 10) {
      const retryAfterMs = Math.max(1, recent.map(a => a.createdAt).sort((a, b) => b - a)[9]! + 60_000 - now);
      throw Object.assign(new Error(`swarm_spawn_rate_limited: ${recent.length} of 10 spawns in the last minute under top worker ${tree.top.name} (${tree.top.id}); retry after ${retryAfterMs} ms`), { code: 'swarm_spawn_rate_limited', topWorkerId: tree.top.id, count: recent.length, limit: 10, retryAfterMs });
    }
  }
  /** A worker for an open goal; same-goal children are helpers, and every descendant shares its top worker’s limits. */
  async spawnWorker(ownerId: string, goalRef: string, name: string, task: string, parentAgentId?: string, explicit?: SpawnRequest, target?: Origin, _work?: unknown, toolNames?: string[], speed?: string, category?: GoalCategory): Promise<AgentInfo> {
    const person = this.deps.person(ownerId); if (!person) throw new Error('Owner not configured');
    if (person.manager && 'elsewhere' in person.manager) throw new Error('owner_elsewhere: this person is hosted on another server');
    const long = titleRefusal('name', name);
    if (long) throw new Error(long);
    const parent = parentAgentId ?? this.managerFor(ownerId);
    const parentAgent = parent ? await this.deps.store.getAgent(parent) : null;
    if (!parentAgent || parentAgent.ownerId !== ownerId) throw new Error('Worker parent not found');
    const goal = await goalOf(this.deps, ownerId, goalRef), goalId = goal.id;
    if (goal.status !== 'open') throw new Error(`goal_not_open: goal ${goalId} is ${goal.status}; reopen it with goals update status=open, then spawn`);
    const swarm = parentAgent.role === 'worker' && parentAgent.goalId === goalId;
    const profile = await this.workerProfile(person, explicit);
    const requested = profile;
    await assertWorkerQuota(this.deps, ownerId, requested.model);
    // Model lookup is independent; only worker record changes are serialized.
    const choice = await this.admitProfile(person, requested);
    const key = `${ownerId}:${goalId}`;
    const previous = this.state.spawning.get(key);
    if (previous && !swarm) throw new Error('A worker is already being created for this goal');
    const work = this.changeWorkers(ownerId, async () => {
      const currentParent = await this.deps.store.getAgent(parentAgent.id);
      if (!currentParent || currentParent.archived || currentParent.state === 'stopped') throw new Error(`worker_archived: parent ${parentAgent.id} is not available`);
      const tree = await this.workerTree(currentParent);
      if (tree) { this.assertTreeCapacity(tree, 1); this.assertTreeSpawnRate(tree); }
      const agents = swarm ? [] : await this.deps.store.listAgents(ownerId, { goalId, includeAncestors: true });
      const byId = new Map(agents.map(a => [a.id, a]));
      const runSpeed = speed ?? 'normal';
      const slower = speedRefusal(choice.provider, choice.model, choice.speeds, runSpeed, false);
      if (slower) throw new Error(slower);
      if (!swarm && agents.some(w => w.role === 'worker' && w.goalId === goalId && !w.archived && !w.lastReport && w.state !== 'stopped' && !isSubAgent(w, w.parentAgentId ? byId.get(w.parentAgentId) : undefined))) throw new Error('This goal already has an active worker');
      if (category !== undefined && category !== goal.category) {
        await publishGoalCategory(this.deps, await this.deps.store.updateGoal(goalId, { category }));
      }
      const id = randomUUID();
      if (person.manager && 'elsewhere' in person.manager) throw new Error('owner_elsewhere: this person is hosted on another server');
      const agent = await this.deps.store.createAgent({ id, name, ownerId, parentAgentId: parentAgent.id, role: 'worker', goalId, model: profile.model, thinking: profile.thinking as NonNullable<AgentInfo['thinking']>, speed: runSpeed as Speed, sessionPath: join(this.deps.config.dataDir, 'sessions', `${id}.jsonl`), conversationTitle: name, originConversationId: goalOrigin(target, parentAgent.role === 'manager' ? goal.chatId : null, () => originOf(placeOf(parentAgent, this.turnOf(parentAgent.id)))) });
      // The optional tools it declares (tool-scope.ts): what the spawn names and what the brief and goal mention. A sub-agent's
      // goal is its coordinator's whole goal, so only its own task counts.
      await writeGrant(agentConfigDir(this.deps.config.dataDir, id), chooseTools(swarm ? [task] : [task, goal.title, goal.detail], toolNames));
      this.deps.bus.toPerson(ownerId, { type: 'agent', agent });
      const conversation = await this.deps.store.getConversation(agent.conversationId, ownerId);
      if (conversation) this.deps.bus.toPerson(ownerId, { type: 'conversation', conversation });
      const held = swarm ? [] : (await this.deps.store.pendingWakes(ownerId)).filter(w => w.held?.goalId === goalId);
      const text = held.length ? `${task}\n\nTriggers your manager holds for this goal, still waiting (wake list shows them; cancel any you replace): ${held.map(w => `${w.id} ${describeTrigger(w)}`).join('; ')}.` : task;
      this.deliver({ agentId: id, kind: 'agent', text, fromId: parentAgent.id, conversationId: agent.conversationId });
      return agent;
    });
    this.state.spawning.set(key, work);
    try { return await work; } finally { if (this.state.spawning.get(key) === work) this.state.spawning.delete(key); }
  }
  private async workerProfile(person: PersonConfig, request?: SpawnRequest): Promise<{model:string;thinking:string}> {
    if (request?.model && !request.thinking) throw new Error(`thinking_required: a spawn that names model ${request.model} names its thinking too. Leave model out to use the default model. Nothing was launched.`);
    return { model: request?.model ?? person.worker.model, thinking: request?.thinking ?? person.worker.thinking };
  }
  /**
   * The model and thinking a spawn asks for (or the person's worker profile) must be served by this host's subscription
   * route as it is now: a Acme child launched with gpt-5.5, which the catalog listed and the ChatGPT accounts refuse,
   * failed twice and died. A refusal is typed model_unavailable and lists every supported choice; there is no fallback.
   */
  private async admitProfile(person: PersonConfig, profile: {model:string;thinking:string}): Promise<RouteChoice> {
    if (!(THINKING_LEVELS as readonly string[]).includes(profile.thinking)) throw new Error(`model_unavailable: thinking ${profile.thinking} is not a thinking level (${THINKING_LEVELS.join(', ')})`);
    const choices = await routeChoices(this.deps.config.modelsPath, this.deps.config.allowedProviders, person);
    if (!choices.ok) throw new Error(choices.error.message);
    let admitted = admitModel(choices.value, profile.model, profile.thinking);
    // A refusal from a listing older than a minute is checked against one fetched now (model-route.ts routeChoices fresh).
    if (!admitted.ok) {
      const now = await routeChoices(this.deps.config.modelsPath, this.deps.config.allowedProviders, person, fetch, true);
      if (now.ok) admitted = admitModel(now.value, profile.model, profile.thinking);
    }
    if (!admitted.ok) throw new Error(admitted.error.message);
    const availability = await admitProviderAvailability(admitted.value, person);
    if (!availability.ok) throw new Error(availability.error.message);
    assertAllowedProvider(this.deps.config.allowedProviders, admitted.value.provider);
    return admitted.value;
  }
  /**
   * Switches a worker's speed (workers message speed). Admitted like a spawn's, against what its model's route offers
   * now; a running turn's next model call already carries the new tier.
   */
  async setWorkerSpeed(id: string, speed: string): Promise<AgentInfo> {
    const agent = await this.deps.store.getAgent(id); if (!agent) throw new Error('Agent not found');
    const person = this.deps.person(agent.ownerId); if (!person) throw new Error('Owner not configured');
    const choices = await routeChoices(this.deps.config.modelsPath, this.deps.config.allowedProviders, person);
    if (!choices.ok) throw new Error(choices.error.message);
    const choice = choices.value.find(c => c.model === agent.model);
    if (!choice) throw new Error(`model_unavailable: ${agent.model} is not served by this host's subscription route right now, so its speed can't be set; nothing was changed`);
    const refused = speedRefusal(choice.provider, choice.model, choice.speeds, speed, false);
    if (refused) throw new Error(refused);
    const updated = await this.deps.store.updateAgent(id, { speed: speed as Speed });
    const lane = this.state.lanes.get(id);
    if (lane) lane.serviceTier = serviceTierOf(choice.provider, updated.speed);
    await this.publishAgent(updated);
    return updated;
  }
  /**
   * Switches a running or idle worker's thinking and/or model (workers message thinking/model), keeping its conversation.
   * Admitted like a spawn's, against what the route serves now. Thinking reaches a running turn at its next model call; a
   * new model starts with the next turn (an idle session is rebuilt on it). The model stays with the same provider and
   * must offer the worker's current speed.
   */
  async setWorkerProfile(id: string, change: { model?: string; thinking?: string }): Promise<AgentInfo> {
    const agent = await this.deps.store.getAgent(id); if (!agent) throw new Error('Agent not found');
    const person = this.deps.person(agent.ownerId); if (!person) throw new Error('Owner not configured');
    assertPersonModel(person, change.model ?? agent.model);
    const model = change.model ?? agent.model, thinking = change.thinking ?? agent.thinking ?? person.worker.thinking;
    if (change.model !== undefined && agent.role !== 'manager') await assertWorkerQuota(this.deps, agent.ownerId, model);
    const choices = await routeChoices(this.deps.config.modelsPath, this.deps.config.allowedProviders, person);
    if (!choices.ok) throw new Error(choices.error.message);
    // Another provider's model needs a fresh worker: say so (with the exact call) before judging thinking levels.
    const before = choices.value.find(c => c.model === agent.model), after = choices.value.find(c => c.model === model);
    if (model !== agent.model && before && after && before.provider !== after.provider) {
      const accepted = after.thinking as readonly string[], named = /-(low|medium|high|xhigh|max)$/.exec(model)?.[1];
      const level = [thinking, named].find(t => t !== undefined && accepted.includes(t)) ?? accepted.at(-1);
      throw new Error(`model_provider_change: ${agent.model} runs on ${before.provider} and ${model} on ${after.provider}; a running worker keeps its provider, so nothing was changed. Use respawn with model ${model}: workers action=respawn id=${agent.id} model=${model} thinking=${level} (add text for anything the fresh worker should know; it gets the old one's brief, last words and checkouts).`);
    }
    const admitted = admitModel(choices.value, model, thinking);
    if (!admitted.ok) throw new Error(`${admitted.error.message}; nothing was changed`);
    const availability = await admitProviderAvailability(admitted.value, person);
    if (!availability.ok) throw new Error(availability.error.message);
    if (model !== agent.model) {
      const slower = speedRefusal(admitted.value.provider, model, admitted.value.speeds, agent.speed, false);
      if (slower) throw new Error(slower);
    }
    const updated = await this.deps.store.updateAgent(id, { model, thinking: admitted.value.level as NonNullable<AgentInfo['thinking']> });
    const lane = this.state.lanes.get(id);
    if (lane?.session) {
      const busy = lane.active || lane.creating || lane.pumping;
      if (model !== agent.model && !busy) { this.disposeSession(lane); }
      else lane.session.setThinkingLevel(admitted.value.level as never);
    }
    console.log(JSON.stringify({ type: 'worker_profile_changed', agentId: id, from: { model: agent.model, thinking: agent.thinking }, to: { model, thinking: admitted.value.level } }));
    await this.publishAgent(updated);
    return updated;
  }
  /**
   * A sub-agent whose turn settles without a report and without a pending wake would leave its coordinator waiting
   * forever: it is asked once to report, and if it settles silently again its coordinator gets a note.
   */
  /** The wake firings and assignments a worker's done report would leave unread: `next` reach the model at its next call (queued input that
   * can join the turn joins it now), `later` start its next turn. From here, any new work that joins the turn withdraws the report when the turn ends. */
  reportBasis(agentId: string, assigners: readonly string[]): UnreadFirings {
    const lane = this.state.lanes.get(agentId);
    if (!lane) return { next: [], later: [], assigned: { next: [], later: [] } };
    this.steerQueued(agentId, lane);
    lane.reportBasis = lane.joined.size;
    const firings = (inputs: Iterable<AgentInput>) => [...inputs].flatMap(input => input.firingId !== undefined ? [input.firingId] : []);
    // A message from whoever assigns its work, sent before the report, is new work the report would go out without (e33a124c, 2026-11-02).
    const assigned = (inputs: Iterable<AgentInput>) => [...new Set([...inputs].flatMap(input => input.kind === 'agent' && input.fromId && assigners.includes(input.fromId) ? [input.fromId] : []))];
    return { next: firings(lane.unseen), later: firings(lane.queue), assigned: { next: assigned(lane.unseen), later: assigned(lane.queue) } };
  }
  lateReportWork(agentId: string, assigners: readonly string[]): string[] {
    const lane = this.state.lanes.get(agentId);
    // No basis this turn: the report was filed in an earlier one, so every input that joined this turn came after it.
    if (!lane) return [];
    return [...new Set([...lane.joined].slice(lane.reportBasis ?? 0).flatMap(input => input.firingId !== undefined ? [`wake ${input.firingId}`] : input.kind === 'agent' && assigners.includes(input.fromId) ? [`assignment from ${input.fromId}`] : []))];
  }
  /**
   * A done report ends the run only if nothing still needs it when its turn ends. A worker that reported and then started
   * a job or scheduled a wake (922331c3, 2026-10-29), or whose completion wake fired while it was reporting (26a14948), kept
   * its report and was archived, dropping the only trigger for its live GPU work. Such a report is withdrawn: the run stays
   * open, its parent hears why, and a worker nothing would resume is told to finish and report again.
   */
  private async confirmDone(agent: AgentInfo, lane: Lane): Promise<AgentInfo> {
    const late = this.lateReportWork(agent.id, [agent.parentAgentId, this.managerFor(agent.ownerId)].filter((id): id is string => !!id));
    const parent = agent.parentAgentId ? await this.deps.store.getAgent(agent.parentAgentId) : null;
    // The report tool checked the census when the report was filed; a census that fails now leaves that check standing.
    const pending = late.length ? null : await pendingWork(tolerantCensus(this.deps, agent.id).deps, agent, isSubAgent(agent, parent ?? undefined));
    if (!late.length && !pending) return agent;
    const why = late.length ? `new work (${late.join(', ')}) arrived after it during the same turn` : `it still owns ${ownedText(pending!)}`;
    const reopened = await this.deps.store.updateAgent(agent.id, { lastReport: null });
    await this.publishAgent(reopened);
    if (parent && !parent.archived) this.deliver({ agentId: parent.id, kind: 'note', fromId: agent.id, conversationId: parent.conversationId, text: `Worker ${agent.name} (${agent.id}), goal ${agent.goalId}: its done report was withdrawn and the run stays open, because ${why}. It will report again when that work has finished.` });
    const resumes = !late.length && (await this.deps.store.pendingWakes(agent.ownerId)).some(wake => wake.agentId === agent.id && !wake.held);
    if (!resumes) this.deliver({ agentId: agent.id, kind: 'agent', fromId: 'system', conversationId: agent.conversationId, text: late.length ? `report_withdrawn: your done report went out before ${why}, so this run stays open. Finish what that result needs, then report again with the full outcome.` : `report_withdrawn: your done report was withdrawn at the end of your turn, because you still own ${ownedText(pending!)}. ${pending!.how}` });
    return reopened;
  }
  /**
   * A worker whose turn ends without a report and with nothing left that would resume it (no wake, unfinished job, active
   * child or queued input) is finished: its last words are its report. Worker 4cd7a488 (2026-11-01) wrote its result as
   * plain text, ended its turn and sat idle for 23 minutes until Kenaznia archived it by hand. Words that say it is blocked
   * or needs something file blocked, which keeps the run available; anything else files done, and the run is archived.
   */
  private async reportImplicitly(id: string, lane: Lane, session: AgentSession, batch: AgentInput[]): Promise<void> {
    // A turn that read only a wake the server opened owes no report, and a person talking to the run is answered, not ended.
    if (this.endRequested(lane) || lane.queue.length || lane.restoredTurn === batch || batch.every(input => input.unheard) || batch.some(input => input.kind === 'human')) return;
    const agent = await this.deps.store.getAgent(id);
    if (!agent || agent.role !== 'worker' || agent.archived || agent.lastReport || liveCallOf(agent.id)) return;
    // A peer's coordination message is not an assignment. In particular, a restored worker must remain
    // available for its launcher's next message even when peers talk to it first. Child reports, wakes
    // and restart continuations still finish the work that produced them.
    if (!batch.some(input => input.fromId === agent.parentAgentId || input.fromId === this.managerFor(agent.ownerId) || input.kind === 'report' || input.kind === 'wake' || input.kind === 'restart')) return;
    const parent = agent.parentAgentId ? await this.deps.store.getAgent(agent.parentAgentId) : null;
    const census = tolerantCensus(this.deps, id);
    if (await pendingWork(census.deps, agent, isSubAgent(agent, parent ?? undefined), true)) return;
    if ((await this.deps.store.agentsAround(agent.ownerId, [id])).some(child => child.parentAgentId === id && subAgentActive(child))) return;
    const words = lastWords(session.messages);
    // No result is not a successful result. Keep the run available for its parent and the heartbeat.
    if (!words.trim() || lane.restoredTurn === batch) return;
    const status = soundsBlocked(words) ? 'blocked' : 'done';
    console.log(JSON.stringify({ type: 'worker_implicit_report', agentId: id, parentAgentId: agent.parentAgentId, status }));
    // The words were read in this turn, wakes that fired into it included, so none of them withdraws the report (confirmDone).
    lane.reportBasis = lane.joined.size;
    const unavailable = census.unavailable();
    const note = unavailable ? `\n\n(Census unavailable: the runtime could not list this worker's background jobs when filing this report, so a job it started may still be running. ${unavailable})` : '';
    await fileReport({ ...this.deps, runtime: this }, agent, status, `${IMPLICIT_REPORT}\n${words || '(It wrote no final message.)'}${note}`);
  }
  /** A coordinator that stops or finishes stops its sub-agents with it. */
  private async stopSubAgents(id: string): Promise<void> {
    const coordinator = await this.deps.store.getAgent(id);
    if (!coordinator || coordinator.role !== 'worker') return;
    const children = swarmsOf(await this.deps.store.agentsAround(coordinator.ownerId, [id])).get(id) ?? [];
    for (const child of children.filter(c => !c.archived)) await this.stopAgent(child.id);
  }
  /** An archived run stays archived: the message is refused, and only an explicit restore brings the run back. */
  async messageWorker(id: string, text: string, fromId?: string, target?: Origin): Promise<MessageOutcome> {
    const agent = await this.deps.store.getAgent(id); if (!agent) throw new Error('Agent not found');
    if (agent.archived) return { delivered: false, error: 'recipient_archived', agent };
    const from = fromId ? await this.deps.store.getAgent(fromId) : null;
    if (from && !ownersVisible(this.deps.person(from.ownerId) ?? { id: from.ownerId }, this.deps.person(agent.ownerId), agent.ownerId)) throw new Error('agent_not_found: recipient is not visible to this person');
    const sender = fromId ?? this.managerFor(agent.ownerId) ?? 'system';
    const launcher = sender === agent.parentAgentId ? await this.deps.store.getAgent(sender) : null;
    const goalChatId = launcher?.role === 'manager' && agent.goalId ? (await this.deps.store.getGoal(agent.ownerId, agent.goalId))?.chatId ?? null : null;
    const origin = goalOrigin(target, goalChatId, () => launcher ? retargeted(placeOf(launcher, this.turnOf(launcher.id)), agent.originConversationId) : agent.originConversationId);
    // A done report ends the run: a peer's message queued behind it is still read, but cannot reopen the run for a second done.
    // A message from whoever assigns its work (its parent or the person's manager) is a new assignment: it withdraws the report,
    // so the run reports that work once more and is archived only after it (c8154cd2, 2026-11-01: its parent's follow-up
    // finished, then report said already_reported and the run was archived on the old result).
    const reopens = reopensReport(agent, sender, this.managerFor(agent.ownerId));
    if (reopens || origin !== agent.originConversationId) await this.changeWorkers(agent.ownerId, async () => {
      const current = await this.deps.store.getAgent(id);
      if (!current || current.archived) throw new Error(`worker_archived: ${id}`);
      if (reopens && !subAgentActive(current)) {
        const tree = await this.workerTree(current);
        if (tree && tree.top.id !== id) this.assertTreeCapacity(tree, 1);
      }
      await this.publishAgent(await this.deps.store.updateAgent(id, { ...(reopens ? { lastReport: null } : {}), originConversationId: origin }));
    });
    const stored = await this.deliver({ agentId: id, kind: 'agent', text, fromId: sender, conversationId: agent.conversationId });
    return stored.ok ? { delivered: true } : { delivered: false, error: stored.error, detail: stored.detail };
  }
  private async publishAgent(agent: AgentInfo): Promise<void> {
    this.deps.bus.toPerson(agent.ownerId, { type: 'agent', agent });
    const conversation = await this.deps.store.getConversation(agent.conversationId, agent.ownerId);
    if (conversation) this.deps.bus.toPerson(agent.ownerId, { type: 'conversation', conversation });
  }
  /** Archiving ends the current turn and passes queued input to the run's heir. A run can archive itself from a tool, so the abort is not awaited. */
  private interrupt(id: string): void {
    const lane = this.lane(id); lane.stopped = true; lane.archived = true; lane.preempting = false; lane.cutOff = false; lane.stopping = false;
    this.orphan(id, lane.queue.splice(0));
    this.waitingChanged(id, lane);
    void lane.session?.abort().catch(error => this.error(id, error));
  }
  /**
   * A person's Stop in a chat ends the agent's running turn when it answers there (a worker's or call agent's own chat is
   * its whole run). It never drops input: everything queued for the agent, and whatever was steered into the stopped turn
   * unread, runs next with a notice that the previous turn was stopped (Kenaznia lost a message from Alice, a shared-chat
   * message, a peer note and a held trigger's firing to Stop on 2026-10-29).
   */
  private stopIn(agent: AgentInfo, conversationId: string): void {
    const lane = this.lane(agent.id);
    const answersHere = (input: AgentInput) => input.conversationId === conversationId || (agent.role !== 'manager' && agent.conversationId === conversationId);
    if (lane.active && answersHere(lane.active[0]!)) {
      lane.stopping = true; lane.preempting = false; lane.cutOff = false;
      void lane.session?.abort().catch(error => this.error(agent.id, error));
    }
    this.waitingChanged(agent.id, lane);
  }
  async stopAgent(id: string): Promise<void> {
    if ((await this.deps.store.getAgent(id))?.role === 'manager') throw new ManagerPlacementFixed(id);
    this.interrupt(id);
    const stopped = await this.deps.store.updateAgent(id, { state: 'stopped', archived: true });
    await this.publishAgent(stopped);
    await this.stopSubAgents(id);
    await this.passHeldUp(stopped);
    await this.adoptChildren(stopped);
  }
  /** Workers still running under a run that ends move to its supervisor (its own parent while that one is live), as `workers reparent` would move them, so their reports and notes keep a reader. Its swarm sub-agents were stopped with it. */
  private async adoptChildren(agent: AgentInfo): Promise<void> {
    if (agent.role !== 'worker') return;
    const children = (await this.deps.store.agentsAround(agent.ownerId, [agent.id])).filter(c => c.role === 'worker' && c.parentAgentId === agent.id && !c.archived && c.state !== 'stopped');
    if (!children.length) return;
    const heir = await supervisorOf(this.deps, agent);
    if (!heir) return;
    for (const child of children) {
      try { await this.reparentWorker(child.id, heir.id, heir.id); }
      catch (e) { console.log(JSON.stringify({ type: 'child_not_adopted', agentId: child.id, archived: agent.id, to: heir.id, error: String(e) })); }
    }
  }
  /** Triggers a run held for the workers below it pass to its own supervisor when it ends, so none is dropped with it. */
  private async passHeldUp(agent: AgentInfo): Promise<void> {
    if (agent.role !== 'worker') return;
    if (!(await this.deps.store.pendingWakes(agent.ownerId)).some(w => w.held && w.agentId === agent.id)) return;
    const supervisor = await supervisorOf(this.deps, agent);
    if (!supervisor) return;
    const moved = await this.deps.store.moveHeldWakes({ from: agent.id }, supervisor.id);
    if (!moved.length) return;
    console.log(JSON.stringify({ type: 'held_triggers_passed_up', from: agent.id, to: supervisor.id, wakes: moved }));
    await this.publishAgent(await this.deps.store.getAgent(supervisor.id) ?? supervisor);
  }
  /**
   * Moves a running or idle worker (with its sub-agents) under another parent, without restarting it: its reports and
   * notes go to the new parent from now on, and the triggers held for its goal move to its new supervisor.
   */
  async reparentWorker(id: string, parentId: string, byId: string): Promise<{ worker: AgentInfo; previousParent: string | null; movedTriggers: string[] }> {
    const by = await this.deps.store.getAgent(byId);
    const found = await this.deps.store.getAgent(id);
    if (!by || !found || found.role !== 'worker' || found.ownerId !== by.ownerId) throw new Error(`worker_not_found: ${id}`);
    return this.changeWorkers(found.ownerId, async () => {
      const worker = await this.deps.store.getAgent(id);
      if (!worker) throw new Error(`worker_not_found: ${id}`);
      const all = await this.deps.store.agentAncestors(worker.ownerId, [worker.id, parentId, this.managerFor(worker.ownerId)].filter((id): id is string => !!id));
      const agents = new Map(all.map(a => [a.id, a]));
      const parent = checkReparent(worker, agents.get(parentId), agents);
      const previousParent = worker.parentAgentId;
      if (previousParent === parent.id) return { worker, previousParent, movedTriggers: [] };
      const destination = await this.workerTree(parent);
      if (destination && !destination.agents.some(a => a.id === worker.id)) {
        const incoming = await this.deps.store.workerLineage(worker.ownerId, [worker.id]);
        // workerLineage includes ancestors too; only the moved worker and its descendants join the destination.
        const descendants = workerDescendants(incoming).get(worker.id) ?? [];
        this.assertTreeCapacity(destination, [worker, ...descendants].filter(subAgentActive).length);
      }
      const moved = await this.deps.store.updateAgent(id, { parentAgentId: parent.id });
      agents.set(id, moved);
      const holder = supervisorIn(moved, agents, this.managerFor(worker.ownerId));
      const movedTriggers = holder && worker.goalId ? await this.deps.store.moveHeldWakes({ goalId: worker.goalId }, holder.id) : [];
      console.log(JSON.stringify({ type: 'worker_reparented', agentId: id, from: previousParent, to: parent.id, by: byId, movedTriggers }));
      await this.publishAgent(moved);
      // An idle session is rebuilt at its next turn, so its prompt names the new parent; a running one learns it from this note.
      const lane = this.lane(id);
      if (!lane.active && !lane.creating && !lane.pumping && lane.session) { this.disposeSession(lane); }
      const supervisorLine = holder && holder.id !== parent.id ? ` Lifecycle issues and long-wait handoffs go to ${holder.id}, your nearest live supervisor.` : '';
      this.deliver({ agentId: id, kind: 'agent', fromId: byId, conversationId: moved.conversationId, text: `You now work under ${parent.name} (${parent.id}) instead of ${previousParent ?? 'no parent'}. From now on your notes (workers message id ${parent.id}) and your report go to ${parent.id}.${supervisorLine} Nothing else changes: keep going on your goal.` });
      return { worker: moved, previousParent, movedTriggers };
    });
  }
  async archiveAgent(id: string, archived: boolean): Promise<AgentInfo> {
    if ((await this.deps.store.getAgent(id))?.role === 'manager') throw new ManagerPlacementFixed(id);
    if (archived) await this.stopAgent(id);
    else {
      let current = await this.deps.store.getAgent(id);
      const ending = current?.lastReport?.status === 'done' || current?.lastReport?.status === 'handed_off';
      if (current && (current.archived || ending)) {
        const lane = this.lane(id);
        // An archived turn may still be aborting or publishing its completion. Finish that cleanup
        // before making the run available; otherwise its old finalizer can archive the restored run.
        // A live turn can restore itself from a tool, so never wait on that turn's own task.
        if (lane.pumping && (current.archived || lane.settling)) {
          if (current.archived) this.interrupt(id);
          await lane.task;
          current = await this.deps.store.getAgent(id);
          if (!current) throw new Error('Agent not found');
        }
        await this.changeWorkers(current!.ownerId, async () => {
          current = await this.deps.store.getAgent(id);
          if (!current) throw new Error('Agent not found');
          const tree = await this.workerTree(current);
          if (tree && tree.top.id !== id && !subAgentActive(current)) this.assertTreeCapacity(tree, 1);
          lane.restoredTurn = lane.active;
          lane.archived = false;
          await this.publishAgent(await this.deps.store.updateAgent(id, { archived: false, lastReport: null, ...(current.archived ? { state: 'idle' as const } : {}) }));
        });
      }
    }
    const agent = await this.deps.store.getAgent(id);
    if (!agent) throw new Error('Agent not found');
    return agent;
  }
  /** A person's Stop ends the agents' current turns in that conversation; it never archives them, and leaves their turns and input in other chats alone. */
  async stop(conversationId: string): Promise<void> {
    await Promise.all((await this.deps.store.conversationMembers(conversationId)).map(async id => {
      const agent = await this.deps.store.getAgent(id);
      if (!agent) return;
      this.stopIn(agent, conversationId);
      if (!this.lane(id).active && agent.state === 'running') await this.publishAgent(await this.deps.store.updateAgent(id, { state: 'idle' }));
    }));
  }
  /** Cut-off turns are marked interrupted and stored inputs stay stored; the next start resumes both. */
  /** Stop one person's turns without stopping the rest of the server. */
  async pausePerson(ownerId: string): Promise<void> {
    await Promise.allSettled([...this.state.spawning.values()]);
    const agents = await this.deps.store.listAgents(ownerId, { includeArchived: true });
    for (const agent of agents) this.state.paused.add(agent.id);
    const lanes = agents.flatMap(agent => { const lane = this.state.lanes.get(agent.id); return lane ? [[agent.id, lane] as const] : []; });
    const interrupted = new Set(lanes.filter(([, lane]) => lane.active || lane.cutOff).map(([id]) => id));
    for (const [, lane] of lanes) { lane.stopped = true; if (lane.gathering) clearTimeout(lane.gathering); }
    await Promise.all(lanes.map(async ([, lane]) => { await lane.session?.abort(); await lane.task; }));
    for (const [id, lane] of lanes) {
      lane.queue = []; this.disposeSession(lane);
      if (interrupted.has(id)) await this.deps.store.updateAgent(id, { state: 'interrupted' });
    }
    await Promise.all(lanes.map(([, lane]) => lane.storing));
    this.state.managers.delete(ownerId);
  }
  async shutdown(): Promise<void> {
    this.state.closing = true; for (const timer of this.state.timers) clearTimeout(timer);
    const lanes = [...this.state.lanes.entries()];
    // Requests wait in the channel socket while the process restarts, so a turn that won't end must not hold them:
    // after SHUTDOWN_WAIT_MS the state of every lane is saved as it is, and the slow ones are named.
    // Read before the abort: a turn waiting on a model call, with no tool call outstanding, resumes by sending that call again.
    const resumable = new Map(lanes.flatMap(([id, lane]) => lane.active && lane.prompted && lane.calling && !lane.cutOff ? [[id, lane.active[0]!] as const] : []));
    const unsettled = new Set(lanes.map(([id]) => id));
    const settled = Promise.all(lanes.map(async ([id, lane]) => { await lane.session?.abort(); await lane.task; unsettled.delete(id); }));
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([settled, new Promise(resolve => { timer = setTimeout(resolve, SHUTDOWN_WAIT_MS); })]);
    clearTimeout(timer);
    if (unsettled.size) console.log(JSON.stringify({ type: 'shutdown_slow', waitedMs: SHUTDOWN_WAIT_MS, agents: [...unsettled] }));
    // Every other input is already stored from its delivery until its agent's transcript holds it.
    const resumes: AgentInput[] = [];
    for (const [id, lane] of lanes) {
      const cut = resumable.get(id);
      if (cut) resumes.push({ agentId: id, kind: 'restart', resume: 'model_call', text: MODEL_CALL_RESUMED, fromId: 'system', conversationId: cut.conversationId, ...(cut.chatBound ? { chatBound: true as const } : {}) });
      lane.stopped = true; lane.queue = []; this.disposeSession(lane);
    }
    await Promise.all(resumes.map(input => this.deps.store.storeInput(input).catch(e => this.error('shutdown', e))));
    await Promise.all([...[...this.state.lanes.values()].map(lane => lane.storing), ...this.state.consuming]);
    await Promise.all(lanes.filter(([, lane]) => lane.active || lane.cutOff).map(([id, lane]) =>
      this.deps.store.updateAgent(id, { state: lane.prompted || lane.cutOff ? 'interrupted' : 'idle' }).catch(e => this.error(id, e))));
  }
}
export const createRuntime = (deps: Deps): AgentRuntime => new AgentRuntime(deps, BACKGROUND_GATHERING);
