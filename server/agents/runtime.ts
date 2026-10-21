import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type AgentSession, type InlineExtension } from '@earendil-works/pi-coding-agent';
import type { Message as LlmMessage, StopReason } from '@earendil-works/pi-ai';
import { isNoReply, mayBeNoReply, type Activity, type AgentInfo, type ConversationSummary, type Message, type MessageDisplay, type MessagePart, type NoticeKind } from '../../shared/contract.js';
import type { AgentInput, AgentTurn, Deps, Runtime, KenanTool } from '../types.js';
import type { ModelProvider, PersonConfig } from '../config.js';
import { assertAllowedProvider, hostedManager } from '../config.js';
import { configurePool } from '../pool.js';
import { ownerTools } from '../tools/owner.js';
import { orderedByFiles } from '../tools/order.js';
import { controlTools, type Controls, type MessageOutcome } from '../tools/control.js';
import { heartbeatText } from './heartbeat.js';
import { describeFailures, installContextBudget } from './context-budget.js';
import { installRefusalRecovery, isRefusal, refusalNotice, type RefusalRecovery, type RequestModel } from './refusal.js';
import { promptInput } from './attachments.js';
import { describeTrigger, fireOnInput, SHORT_WAIT_MS, wakeTool } from './wakes.js';
import { peerTool } from '../peers.js';
import { liveAnswered } from './live.js';
import { contextSections } from './context-files.js';
import { usageReport } from '../metrics/usage.js';
import { isSubAgent, subAgentActive, SWARM_MAX_ACTIVE, SWARM_QUOTA_RESERVE_PERCENT, swarmQuota, swarmsOf } from '../../shared/swarm.js';

/** steered: inputs handed to Pi's steering queue during the active turn, in queue order. settling: the turn's prompt has returned, so new input waits for the next turn. */
type Lane = { queue: AgentInput[]; reportChases?: number; notices?: Promise<void>; session?: AgentSession; tools?: Map<string, KenanTool>; refusals?: RefusalRecovery & { models: string[] }; creating?: Promise<AgentSession>; active?: AgentInput[]; startedAt?: number; steered: AgentInput[]; prompted: boolean; settling: boolean; cutOff: boolean; pumping: boolean; preempting: boolean; stopped: boolean; task?: Promise<void>; steering?: Promise<void> };
/** Messages between agents join the recipient's running turn, as human messages join a human turn. */
const STEERED_KINDS = new Set<AgentInput['kind']>(['agent', 'note', 'report', 'wake']);
const HEARTBEAT_CHECK_MS = 60_000;
const SHUTDOWN_WAIT_MS = 5_000;
/** Inputs from no person that leave no other trace in the recipient's conversation get a background notice there when they arrive. Notes and peer messages bring their own. */
const INPUT_NOTICES: Partial<Record<AgentInput['kind'], NoticeKind>> = { report: 'worker_report', wake: 'wake', heartbeat: 'heartbeat', restart: 'system', refusal: 'system' };
/** Inputs that continue a cut-off turn: when that turn was answering a person, so is its continuation. */
const CONTINUATIONS = new Set<AgentInput['kind']>(['restart', 'refusal']);
/** A manager's turn answers background input when none of its inputs came from a person; its work folds away and only real text replies show. A worker's own chat is its work, so it all shows. */
export const answersBackground = (role: AgentInfo['role'], batch: AgentInput[]): boolean => role === 'manager' && !batch.some(input => input.kind === 'human' || input.kind === 'room');
/** How a finished assistant message is drawn: an exact NO_REPLY is silent; in a background turn, a message without words is background. */
export function finishedDisplay(text: string, background: boolean): MessageDisplay {
  if (isNoReply(text)) return 'silent';
  return background && text.trim() === '' ? 'background' : 'shown';
}
/** A prompted input is already in the transcript, so a cut-off turn is resumed with a notice, never by sending its input again. */
export const PREEMPT_NOTICE = 'Your previous turn was stopped so you could answer the message below first. Its input and the work it did are above. After answering, finish whatever it left undone. Before repeating a tool call from it, check whether it already took effect.';
/** Pi retries a transient model-call failure (connection, broker restart, 5xx, overload) inside the same turn, backing off to a minute between attempts, for as long as it persists. An explicit abort (stop, preemption, shutdown) cancels it. */
export const TRANSIENT_RETRY = { enabled: true, maxRetries: Number.MAX_SAFE_INTEGER, baseDelayMs: 2000, maxAgentDelayMs: 60_000 };
/** A turn answering someone on a live line thinks briefly: the person hears nothing until the reply is written. */
export const LIVE_THINKING = 'low';
/** A live request joins a turn that is still answering one; otherwise it preempts whatever runs, including a finished reply's wrap-up. */
export const joinsLiveTurn = (active: AgentInput[] | undefined) => !!active?.some(i => i.live && !liveAnswered(i.live.delegationId));
export const RESTART_NOTICE = 'The Kenan service restarted while your previous turn was running, so that turn was cut off. Continue from where you stopped. Before repeating a tool call that was in progress, check whether it already took effect.';
/** Providers reject an error tool result without content, so a tool that failed silently is described; stored histories replay unchanged. */
export function describeSilentErrors(messages: LlmMessage[]): LlmMessage[] {
  return messages.map(message => message.role === 'toolResult' && message.isError && !message.content.some(part => part.type === 'image' || part.text.trim())
    ? { ...message, content: [{ type: 'text', text: `The ${message.toolName} tool failed without any output.` }] } : message);
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
export function longPromptCache(session: AgentSession): void {
  const stream = session.agent.streamFunction;
  session.agent.streamFunction = (model, context, options) => stream(model, context, {
    ...options, cacheRetention: 'long',
    onPayload: async (payload, requestModel) => shareSystemPrefix(await options?.onPayload?.(payload, requestModel) ?? payload),
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
export const COORDINATOR_PROMPT = `You can run a swarm for your goal when it splits into many small, checkable tasks (one Lean lemma, one search query, one file): launch sub-agents with workers spawn using your own goalId, a name, the task text, and an explicit model and thinking (claude-haiku-5-5 with low or medium thinking for most; Opus only for a hard piece). Up to ${SWARM_MAX_ACTIVE} run at once (swarm_full beyond that: launch more as they report); launches are refused with swarm_quota_low while the subscription pool is in the reserve kept for human-facing work, so then schedule a wake and retry, or do the work yourself. Give each a self-contained task with exactly how to check it and what to report. Their reports come to you, not your manager; list them with workers list parent=<your id>. Verify every result yourself (build it, run the test, cross-check) before relying on it, relaunch or reassign failures with what went wrong, and report one combined result. Finishing or being stopped stops your sub-agents.`;
export const SUB_AGENT_REPORT_MISSING = 'Your turn ended without calling the report tool, so your coordinator has not received your result. Call report now: done with the result and how you checked it, or blocked with what failed.';
export const SUB_AGENT_PROMPT = `You are a swarm sub-agent: your launcher is coordinating many agents on one goal and gave you one small task. Do exactly that task, check it the way the task says (or as directly as you can), and report done with the result and how you checked it, or blocked with what failed and what you tried. Don't widen the task and don't launch workers; report anything that needs splitting.`;
export class ManagerPlacementFixed extends Error {
  constructor(readonly agentId: string) { super(`${agentId} is a person's Kenaznia; configuration places it, so it cannot be stopped or archived. A person's Stop button ends its current turn.`); }
}
export class AgentRuntime implements Runtime, Controls {
  private lanes = new Map<string, Lane>();
  private managers = new Map<string, string>();
  private timers: ReturnType<typeof setTimeout>[] = [];
  private closing = false;
  private spawning = new Map<string, Promise<AgentInfo>>();
  constructor(private readonly deps: Deps) {}
  private lane(id: string): Lane {
    let lane = this.lanes.get(id);
    if (!lane) { lane = { queue: [], steered: [], prompted: false, settling: false, cutOff: false, pumping: false, preempting: false, stopped: false }; this.lanes.set(id, lane); }
    return lane;
  }
  async start(): Promise<void> {
    await this.deps.store.markRunningInterrupted();
    const interrupted = await this.deps.store.listInterrupted();
    const pending = await this.deps.store.takePendingInputs();
    for (const person of this.deps.config.people) {
      const placed = await this.placeManager(person);
      if (!placed) continue;
      const manager = placed;
      this.managers.set(person.id, manager.id);
      // Prepare sessions before accepting traffic so a human never waits for discovery.
      void this.session(manager.id).catch(e => this.error(manager.id, e));
      const managed = manager;
      const check = () => { void this.heartbeat(person, managed.id, managed.conversationId).catch(e => this.error(managed.id, e)); };
      this.timers.push(setTimeout(check, 10000), setInterval(check, HEARTBEAT_CHECK_MS));
    }
    await this.resume(interrupted, pending);
  }
  /** Configuration owns where a person's Kenaznia runs: hosted here it exists and is never archived; otherwise any manager row on this channel is archived, so no person sees a second, unconfigured manager. */
  private async placeManager(person: PersonConfig): Promise<AgentInfo | null> {
    const profile = hostedManager(person);
    const existing = (await this.deps.store.listAgents(person.id, { includeArchived: true })).find(a => a.role === 'manager');
    if (!profile) {
      if (existing && !existing.archived) await this.deps.store.updateAgent(existing.id, { state: 'stopped', archived: true });
      return null;
    }
    if (!existing) return this.deps.store.createAgent({ id: `manager:${person.id}`, ownerId: person.id, name: profile.name, role: 'manager', goalId: null, model: profile.model, sessionPath: join(this.deps.config.dataDir, 'sessions', `manager-${person.id}.jsonl`), conversationTitle: profile.name });
    const placed = existing.archived ? await this.deps.store.updateAgent(existing.id, { state: 'idle', archived: false }) : existing;
    return placed.name === profile.name ? placed : this.deps.store.updateAgent(placed.id, { name: profile.name });
  }
  /** Every heartbeatMinutes since the persisted last check, compare; deliver only when something moved (heartbeat.ts decideHeartbeat). Restarts add none. */
  private async heartbeat(person: PersonConfig, managerId: string, conversationId: string): Promise<void> {
    if (this.closing) return;
    const current = await this.deps.store.getAgent(managerId);
    if (!current || current.archived) return;
    const lane = this.lane(managerId);
    if ([...lane.queue, ...(lane.active ?? [])].some(input => input.kind === 'heartbeat')) return;
    const previous = await this.deps.store.getHeartbeat(managerId);
    if (previous && this.deps.now() - previous.checkedAt < this.deps.config.heartbeatMinutes * 60000) return;
    const beat = await heartbeatText(this.deps, person, managerId);
    await this.deps.store.saveHeartbeat(managerId, beat.state);
    if (beat.kind === 'due') this.deliver({ agentId: managerId, kind: 'heartbeat', text: beat.text, fromId: 'system', conversationId });
  }
  private async resume(interrupted: string[], pending: AgentInput[]): Promise<void> {
    for (const id of interrupted) {
      const agent = await this.deps.store.getAgent(id);
      if (!agent || agent.archived) continue;
      this.deliver({ agentId: id, kind: 'restart', text: RESTART_NOTICE, fromId: 'system', conversationId: agent.conversationId });
    }
    for (const input of pending) {
      const agent = await this.deps.store.getAgent(input.agentId);
      if (agent && !agent.archived) this.enqueue(input);
    }
  }
  /** Stop, archive, preemption and shutdown abort the run on purpose. */
  private endRequested(lane: Lane): boolean { return lane.stopped || lane.preempting || this.closing; }
  managerFor(ownerId: string): string | null { return this.managers.get(ownerId) ?? null; }
  turnOf(agentId: string): AgentTurn | null {
    const lane = this.lanes.get(agentId);
    if (!lane?.active || lane.startedAt === undefined) return null;
    return { startedAt: lane.startedAt, inputs: lane.active.map(({ kind, fromId, text }) => ({ kind, fromId, text })), queued: lane.queue.length };
  }
  private async error(id: string, error: unknown): Promise<void> { await this.deps.store.logError(`agent:${id}`, String(error)).catch(() => {}); }
  onHumanMessage(message: Message, conversation: ConversationSummary): void {
    for (const id of conversation.memberIds) {
      if (id === message.authorId) continue;
      void this.deps.store.getAgent(id).then(agent => {
        if (agent) this.deliver({ agentId: id, kind: 'human', text: message.text, fromId: message.authorId, conversationId: conversation.id, humanMessageId: message.id, fileIds: message.parts.filter(p => p.type === 'file' || p.type === 'image').map(p => p.fileId) });
      }).catch(e => this.error(id, e));
    }
  }
  deliver(input: AgentInput): void {
    if (this.closing) return;
    const notice = INPUT_NOTICES[input.kind];
    if (notice) {
      const lane = this.lane(input.agentId);
      lane.notices = (lane.notices ?? Promise.resolve()).then(async () => {
        const message = await this.deps.store.appendMessage({ conversationId: input.conversationId, authorId: input.fromId, role: 'notice', notice, text: input.text });
        this.deps.bus.toConversation(input.conversationId, { type: 'message', message });
      }).catch(e => this.error(input.agentId, e));
    }
    this.enqueue(input);
    void fireOnInput(this.deps, input).catch(e => this.error(input.agentId, e));
  }
  /** Queues or steers an input; a retained input redelivered after a restart already has its notice. */
  private enqueue(input: AgentInput): void {
    if (this.closing) return;
    const lane = this.lane(input.agentId); lane.stopped = false;
    const joinsTurn = input.live ? joinsLiveTurn(lane.active) : input.kind === 'human' ? lane.active?.some(i => i.kind === 'human') : STEERED_KINDS.has(input.kind) && !!lane.active;
    if (joinsTurn && lane.session && !lane.preempting && !lane.settling) { this.steer(lane, input); return; }
    if (input.kind === 'human') {
      const humanEnd = input.live ? lane.queue.findIndex(i => !i.live) : lane.queue.findIndex(i => i.kind !== 'human');
      lane.queue.splice(humanEnd < 0 ? lane.queue.length : humanEnd, 0, input);
      if (lane.active && !lane.preempting && !lane.settling) { lane.preempting = true; void lane.session?.abort().catch(e => this.error(input.agentId, e)); }
    } else lane.queue.push(input);
    if (!lane.pumping) { lane.task = this.pump(input.agentId, lane); void lane.task.catch(e => this.error(input.agentId, e)); }
  }
  /** Joins the running turn before its next model call. Attachments are prepared concurrently but steered in arrival order. */
  private steer(lane: Lane, input: AgentInput): void {
    const session = lane.session!;
    lane.active!.push(input);
    const prepared = promptInput(this.deps, input).then(value => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }));
    lane.steering = (lane.steering ?? Promise.resolve()).then(async () => {
      await this.mark(input, 'model_request_at');
      const result = await prepared;
      if (!result.ok) throw result.error;
      await session.steer(result.value.text, result.value.images);
      lane.steered.push(input);
    }).catch(e => this.error(input.agentId, e));
  }
  /** Steered input the turn ended before reading goes back to the queue, so it starts the next turn instead of waiting for an unrelated prompt. */
  private async reclaimSteered(lane: Lane, session: AgentSession): Promise<void> {
    lane.settling = true;
    await lane.steering;
    const unread = session.getSteeringMessages().length;
    const left = unread ? lane.steered.slice(-unread) : [];
    lane.steered = [];
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
  private async session(id: string): Promise<AgentSession> {
    const lane = this.lane(id);
    if (lane.session) return lane.session;
    if (lane.creating) return lane.creating;
    lane.creating = (async () => {
      const agent = await this.deps.store.getAgent(id);
      if (!agent) throw new Error(`Agent ${id} not found`);
      const person = this.deps.person(agent.ownerId);
      if (!person) throw new Error(`Owner ${agent.ownerId} not configured`);
      const hosted = hostedManager(person);
      if (agent.role === 'manager' && !hosted) throw new Error(`${person.name}'s manager is not hosted on this channel`);
      const baseProfile = agent.role === 'manager' ? hosted! : person.worker;
      const catalog = JSON.parse(await readFile(this.deps.config.modelsPath, 'utf8'));
      const providers = catalog.catalog?.providers ?? catalog.providers;
      const provider = (['anthropic', 'openai-codex'] as const).find(id => providers?.[id]?.models?.some((model: { id: string }) => model.id === agent.model));
      if (!provider) throw new Error(`Configured subscription model not found: ${agent.model}`);
      assertAllowedProvider(this.deps.config.allowedProviders, provider);
      const profile = { ...baseProfile, provider, model: agent.model, thinking: agent.thinking ?? baseProfile.thinking, ...(agent.thinking != null ? {refusalFallbackModels: []} : {}) };
      const path = await this.deps.store.agentSessionPath(id);
      if (!path) throw new Error('Session path missing');
      await mkdir(dirname(path), { recursive: true });
      const agentDir = join(this.deps.config.dataDir, 'agent-config', id.replaceAll(':', '-'));
      await mkdir(agentDir, { recursive: true });
      const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, 'auth.json'), modelsPath: null, refreshOnCreate: false });
      await configurePool(modelRuntime, person, profile, this.deps.config.modelsPath, this.deps.config.allowedProviders, agent.id);
      const model = modelRuntime.getModel(profile.provider, agent.model);
      if (!model) throw new Error(`Unknown model ${profile.provider}/${agent.model}`);
      const refusalFallbacks = profile.refusalFallbackModels.filter(id => id !== agent.model).map(id => {
        const fallback = modelRuntime.getModel(profile.provider, id);
        if (!fallback) throw new Error(`Configured refusal fallback model not found: ${profile.provider}/${id}`);
        return fallback;
      });
      const context = await contextSections(profile.contextFiles);
      const extensions = this.deps.extensions.filter(e => person.extensions.includes(e.id) && (!e.roles || e.roles.includes(agent.role)));
      const launcher = agent.role === 'worker' && agent.parentAgentId ? await this.deps.store.getAgent(agent.parentAgentId) : null;
      const swarmRole = launcher && isSubAgent(agent, launcher) ? SUB_AGENT_PROMPT : agent.role === 'worker' ? COORDINATOR_PROMPT : '';
      const platform = agent.role === 'worker' ? `You are a worker (your id: ${agent.id})${agent.parentAgentId ? ` launched by ${agent.parentAgentId}` : ''}. Work on your assigned goal. Do not send progress reports. When your manager must act on something now, before your report (an urgent hand-off, a time-critical URL), send it with workers message to your parent's id; it joins their current turn and your run continues. Messages from your manager join your current turn. Call report once with done or blocked when finished or unable to continue. A done report archives this run after the turn settles. When the next step has to wait, schedule a wake on the event you wait for with a time as its deadline (never a time alone unless the time itself is the point) and end your turn without reporting. A waiting worker is a warning sign: you keep a wake only up to ${SHORT_WAIT_MS / 60_000} minutes; a longer wait hands off (the wake tool takes your handoff, your manager holds the trigger for your goal, this run is archived, and a fresh worker is launched when it fires). Use workers archive for other finished runs; never resume archived historical work without a current instruction. When the person should see a file (an image, a PDF, anything), give your parent its path in your report or a note; it attaches it to its chat. ${swarmRole}` : `You are Kenaznia (your id: ${agent.id}). Curate your goals and manage workers. Use the usage tool to control total subscription drain. Spawn at most one active worker per goal. Human messages take priority. The user closed all old agents and their open work before this rewrite. Historical workers and tasks are closed; do not resume them unless a new current goal or user request authorizes that work. Continue the currently requested heartbeat maintenance. Archive worker runs when nothing remains for them using workers archive. To see what workers are actually doing right now (before summarising them for the person, or when one has gone quiet), use workers peek: without an id it shows the current turn of every active worker, its recent words and tool calls, idle time and wakes compactly; with an id, one worker in detail. Workers don't wait long: a worker whose wait would exceed ${SHORT_WAIT_MS / 60_000} minutes hands its trigger to you with a handoff (also in the goal notes) and is archived. wake list shows every trigger you hold with its goal and handoff. When one fires you get the event and the handoff: launch a fresh worker for that goal right away (or message the goal's active worker). A worker still waiting shows as a warning in lists, peek, the heartbeat and the sidebar. You stay available to the person at all times; you are never archived. To show the person a file (an image, a chart, a PDF, any file, including paths a worker hands you), send it in this chat with the attach tool; it appears exactly like the files they send you. Inputs that come from no person (worker notes and reports, peer messages, wakes, heartbeats, system notices) fold into a collapsed background group in the chat, and so does your work on them. When one needs nothing from the person, answer with exactly NO_REPLY and nothing else: it is kept for the record but never shown or notified. Any other words you write are shown to the person, so write only what they should read.`;
      const settingsManager = SettingsManager.inMemory({ retry: TRANSIENT_RETRY, compaction: { enabled: false }, shellPath: '/bin/bash' });
      const snippets = extensions.map(e => e.promptSnippet ?? '').filter(Boolean).join('\n');
      const sections = promptSections(context, snippets, platform);
      const loader = new DefaultResourceLoader({ cwd: person.home, agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, systemPrompt: profile.systemPrompt, extensionFactories: [sectionsExtension(sections)] });
      await loader.reload();
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
      const ctx = { person, agent, deps: this.deps };
      const customTools = orderedByFiles([...ownerTools(this.deps.placement, person), ...controlTools(ctx, this), wakeTool(ctx), ...[peerTool(ctx)].filter((t): t is KenanTool => t !== null), ...extensions.flatMap(e => e.tool ? [e.tool(ctx)] : [])]);
      lane.tools = new Map(customTools.map(tool => [tool.name, tool]));
      const { session } = await createAgentSession({ cwd: person.home, agentDir, modelRuntime, model, thinkingLevel: profile.thinking as any, settingsManager, resourceLoader: loader, sessionManager, noTools: 'builtin', customTools, tools: customTools.map(t => t.name) });
      const convertToLlm = session.agent.convertToLlm;
      session.agent.convertToLlm = async messages => describeSilentErrors(await convertToLlm(messages));
      longPromptCache(session);
      const refusals = this.recoverRefusals(agent.id, lane, session, model, refusalFallbacks);
      installContextBudget(session, modelRuntime, {
        started: () => this.deps.bus.toConversation(agent.conversationId, { type: 'activity', conversationId: agent.conversationId, activity: { state: 'thinking', label: 'Compacting conversation', since: this.deps.now() } }),
        recovered: outcome => void this.error(agent.id, `context_compaction_recovered: route=${outcome.route}; ${describeFailures(outcome.failures)}`),
      }, { pinning: agent.role === 'worker' ? 'pin-first-task' : 'none', refusalFallbacks, stream: refusals.base });
      lane.session = session;
      return session;
    })();
    try { return await lane.creating; } finally { lane.creating = undefined; }
  }
  /** A refused request goes to the profile's refusal fallbacks within the same model response; each refusal is logged with what it cost. */
  private recoverRefusals(id: string, lane: Lane, session: AgentSession, model: RequestModel, fallbacks: RequestModel[]): RefusalRecovery {
    const recovery = installRefusalRecovery(session, fallbacks, {
      retried: (refusal, next) => {
        void this.error(id, `model_refusal_recovered: ${refusal.model} refused (${refusal.message.slice(0, 300)}); the same request went to ${next}`);
        const { usage } = refusal;
        void this.deps.store.recordModelCall({ agentId: id, model: refusal.model, inputTokens: usage.input, outputTokens: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite, costUsd: usage.cost.total, at: this.deps.now() }).catch(e => this.error(id, e));
        const conversationId = lane.active?.[0]?.conversationId;
        if (conversationId) this.deps.bus.toConversation(conversationId, { type: 'activity', conversationId, activity: { state: 'thinking', label: `${refusal.model} refused; retrying on ${next}`, since: this.deps.now() } });
      },
    });
    lane.refusals = { ...recovery, models: [model.id, ...fallbacks.filter(fallback => fallback.id !== model.id).map(fallback => fallback.id)] };
    return recovery;
  }
  /** Every model refused the turn's last request. The agent continues with the refusal in context, once: a refused continuation goes to its launcher instead of looping. */
  private async afterRefusal(agent: AgentInfo, lane: Lane, batch: AgentInput[], message: string): Promise<void> {
    const models = lane.refusals?.models ?? [agent.model];
    if (!batch.some(input => input.kind === 'refusal')) {
      await this.error(agent.id, `model_refusal_continued: every model refused (${models.join(', ')}): ${message.slice(0, 300)}`);
      this.deliver({ agentId: agent.id, kind: 'refusal', text: refusalNotice(models, message), fromId: 'system', conversationId: agent.conversationId });
      return;
    }
    await this.error(agent.id, `model_refusal_unrecovered: every model refused again after the refusal notice (${models.join(', ')}): ${message.slice(0, 300)}`);
    const parent = agent.parentAgentId ? await this.deps.store.getAgent(agent.parentAgentId) : null;
    if (!parent || parent.archived) return;
    const text = `every model (${models.join(', ')}) refused its requests twice in a row, before and after a refusal notice ("${message.slice(0, 200)}"), so it is idle. It needs a rephrased instruction, a narrower task or a replacement.`;
    const notice = await this.deps.store.appendMessage({ conversationId: parent.conversationId, authorId: agent.id, role: 'notice', notice: 'worker_note', text: `Note from worker ${agent.name}: ${text}` });
    this.deps.bus.toConversation(parent.conversationId, { type: 'message', message: notice });
    this.deliver({ agentId: parent.id, kind: 'note', fromId: agent.id, conversationId: parent.conversationId, text: `Worker ${agent.name} (${agent.id}), goal ${agent.goalId}: ${text} Reply with workers message id ${agent.id}.` });
  }
  private async pump(id: string, lane: Lane): Promise<void> {
    lane.pumping = true;
    try {
      while (lane.queue.length && !lane.stopped && !this.closing) {
        const first = lane.queue.shift()!;
        const batch = first.kind === 'human' ? [first] : [first, ...lane.queue.splice(0, lane.queue.findIndex(i => i.kind === 'human') < 0 ? lane.queue.length : lane.queue.findIndex(i => i.kind === 'human'))];
        lane.active = batch; lane.startedAt = this.deps.now(); lane.steered = []; lane.settling = false;
        try {
          const session = await this.session(id);
          if (lane.preempting) { lane.queue.push(...batch); continue; }
          const previous = await this.deps.store.getAgent(id);
          if (previous?.archived) { lane.stopped = true; lane.queue = []; continue; }
          const agent = await this.deps.store.updateAgent(id, { state: 'running' });
          this.deps.bus.toPerson(agent.ownerId, { type: 'agent', agent });
          await lane.notices;
          await this.runTurn(agent, lane, session, batch);
          if (this.closing) continue;
          const current = await this.deps.store.getAgent(id);
          const completed = current?.role === 'worker' && (current.lastReport?.status === 'done' || current.lastReport?.status === 'handed_off') && !lane.queue.length && !lane.preempting;
          // Only archiving stops a run for good; an interrupted turn leaves it available for its next input and wakes.
          const updated = await this.deps.store.updateAgent(id, completed ? { state: 'stopped', archived: true } : { state: current?.archived ? 'stopped' : 'idle' });
          await this.publishAgent(updated);
          if (completed) await this.stopSubAgents(id);
          else if (!updated.archived && !updated.lastReport && !lane.queue.length && !lane.preempting) await this.chaseSubAgentReport(updated, lane);
        } catch (e) {
          await this.error(id, e);
          if (this.closing) continue;
          const agent = await this.deps.store.updateAgent(id, { state: 'error' });
          this.deps.bus.toPerson(agent.ownerId, { type: 'agent', agent });
          const message = await this.deps.store.appendMessage({ conversationId: first.conversationId, authorId: id, role: 'notice', notice: 'agent_error', text: `Agent error: ${String(e)}`, state: 'error' });
          this.deps.bus.toConversation(first.conversationId, { type: 'message', message });
        } finally {
          if (lane.preempting && lane.active === batch) {
            if (lane.prompted) lane.cutOff = true;
            else if (!lane.queue.includes(first)) lane.queue.push(...batch);
          }
          if (!this.closing) { lane.active = undefined; lane.prompted = false; }
          lane.preempting = false;
        }
      }
    } finally { lane.pumping = false; }
  }
  private async runTurn(agent: AgentInfo, lane: Lane, session: AgentSession, batch: AgentInput[]): Promise<void> {
    const conversationId = batch[0]!.conversationId;
    const background = answersBackground(agent.role, batch) && !(batch.some(input => CONTINUATIONS.has(input.kind)) && await this.deps.store.awaitingReply(conversationId));
    let current: Message | undefined;
    let text = '';
    /** How much of the current message's text has streamed; text that may still be NO_REPLY is held back. */
    let streamed = 0;
    /** The turn's own messages and how each is drawn, so a NO_REPLY answer can fold away the work before it. */
    const drawn = new Map<string, MessageDisplay>();
    let answer: MessageDisplay | null = null;
    let parts: MessagePart[] = [];
    let refused: string | null = null;
    lane.refusals?.resetTurn();
    const toolMessages = new Map<string, Message>();
    const firstTokens = new Set<string>();
    let chain = Promise.resolve();
    const publish = (next: Activity | null) => this.deps.bus.toConversation(conversationId, { type: 'activity', conversationId, activity: next });
    const runningTools = new Map<string, string>();
    const activity = (state: Activity['state'], label: string | null = null) => {
      const shown = this.deps.bus.activity(conversationId);
      if (shown?.state !== state || shown.label !== label) publish({ state, label, since: this.deps.now() });
    };
    const afterTools = () => { const running = [...runningTools.values()].at(-1); if (running) activity('tool', running); else activity('thinking'); };
    activity('thinking');
    const finishMessage = async (state: Message['state'] = 'done') => {
      if (!current) return;
      const display = finishedDisplay(text, background);
      current = await this.deps.store.updateMessage(current.id, { text, parts, state, display });
      drawn.set(current.id, display); answer = display;
      if (text.trim()) worded.add(current.id);
      this.deps.bus.toConversation(conversationId, { type: 'message', message: current });
      if (state === 'done' && text && display === 'shown') await this.routeRoomReply(current);
      current = undefined;
    };
    /** An answer of NO_REPLY shows nothing: the turn's work folds into the background with it. Words written in a turn that answers a person always stay shown. */
    const worded = new Set<string>();
    const foldSilentTurn = async () => {
      if (answer !== 'silent') return;
      for (const [id, display] of drawn) {
        if (display !== 'shown' || (!background && worded.has(id))) continue;
        const message = await this.deps.store.updateMessage(id, { display: 'background' });
        this.deps.bus.toConversation(conversationId, { type: 'message', message });
      }
    };
    const unsubscribe = session.subscribe(event => {
      // Tool arguments stream straight to the tool, ahead of the persistence chain: a live reply is spoken as it is written.
      if (event.type === 'message_update' && event.assistantMessageEvent.type === 'toolcall_delta') {
        const block = event.assistantMessageEvent.partial.content[event.assistantMessageEvent.contentIndex];
        const tool = block?.type === 'toolCall' ? lane.tools?.get(block.name) : undefined;
        if (block?.type === 'toolCall' && tool?.streamArgs) { try { tool.streamArgs(block.id, block.arguments); } catch (e) { void this.error(agent.id, e); } }
      }
      chain = chain.then(async () => {
        if (event.type === 'message_start' && event.message.role === 'assistant') {
          await finishMessage(); text = ''; parts = []; streamed = 0;
          current = await this.deps.store.appendMessage({ conversationId, authorId: agent.id, role: 'assistant', text: '', state: 'streaming', display: background ? 'background' : 'shown' });
          drawn.set(current.id, current.display);
          this.deps.bus.toConversation(conversationId, { type: 'message', message: current });
        } else if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
          const delta = event.assistantMessageEvent.delta;
          text += delta;
          if (current && !mayBeNoReply(text)) {
            // Words in a background turn are a reply to the person, so the message leaves the background as it streams.
            if (current.display !== 'shown') {
              current = await this.deps.store.updateMessage(current.id, { text, display: 'shown' });
              drawn.set(current.id, 'shown');
              this.deps.bus.toConversation(conversationId, { type: 'message', message: current });
            } else this.deps.bus.toConversation(conversationId, { type: 'delta', conversationId, messageId: current.id, text: text.slice(streamed) });
            streamed = text.length;
          }
          await Promise.all((lane.active ?? []).filter(input => input.humanMessageId && !firstTokens.has(input.humanMessageId)).map(input => { firstTokens.add(input.humanMessageId!); return this.mark(input, 'first_token_at'); }));
          activity('streaming');
        } else if (event.type === 'auto_retry_start') {
          activity('thinking', `Retrying in ${Math.round(event.delayMs / 1000)}s after: ${event.errorMessage}`);
        } else if (event.type === 'tool_execution_start') {
          const part: MessagePart = { type: 'tool', callId: event.toolCallId, name: event.toolName, args: event.args, result: null, isError: false };
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
          const message = event.message;
          // A refused attempt's streamed deltas may precede its fallback's, so the saved text is the final response's own.
          text = message.content.flatMap(part => part.type === 'text' ? [part.text] : []).join('');
          refused = isRefusal(message) ? message.errorMessage! : null;
          parts = message.content.flatMap((part): MessagePart[] => part.type === 'thinking' ? [{ type: 'thinking', text: part.thinking }] : part.type === 'toolCall' ? [{ type: 'tool', callId: part.id, name: part.name, args: part.arguments, result: null, isError: false }] : []);
          const usage = message.usage;
          await this.deps.store.recordModelCall({ agentId: agent.id, model: message.model, inputTokens: usage.input, outputTokens: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite, costUsd: usage.cost.total, at: this.deps.now() });
          const outcome = turnOutcome(message.stopReason, this.endRequested(lane));
          if (outcome === 'error') { text += message.errorMessage ? `\n${message.errorMessage}` : '\nModel request failed'; await this.error(agent.id, message.errorMessage); }
          await finishMessage(outcome);
          afterTools();
        }
      }).catch(e => this.error(agent.id, e));
    });
    try {
      await Promise.all(batch.map(input => this.mark(input, 'model_request_at')));
      const inputs = await Promise.all(batch.map(input => promptInput(this.deps, input)));
      if (this.closing) return;
      const texts = inputs.map(input => input.text);
      if (lane.cutOff) texts.unshift(`[notice from system]\n${PREEMPT_NOTICE}`);
      lane.prompted = true; lane.cutOff = false;
      const restore = batch.some(input => input.live) ? session.thinkingLevel : null;
      if (restore) session.setThinkingLevel(LIVE_THINKING);
      try { await session.prompt(texts.join('\n\n'), { images: inputs.flatMap(input => input.images) }); }
      finally { if (restore) session.setThinkingLevel(restore); await this.reclaimSteered(lane, session); }
      await chain;
      if (refused && !this.endRequested(lane)) await this.afterRefusal(agent, lane, batch, refused);
    } finally {
      unsubscribe(); await chain; await finishMessage(this.endRequested(lane) ? 'stopped' : 'done');
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
  /**
   * A worker for an open goal. A worker launching a worker for its own goal makes a swarm sub-agent instead: the
   * coordinator's child, exempt from one-worker-per-goal, with an explicit model and thinking, at most
   * SWARM_MAX_ACTIVE active at once per coordinator, and refused while the pool's quota is in its reserve.
   */
  async spawnWorker(ownerId: string, goalId: string, name: string, task: string, parentAgentId?: string, profile?: {model:string;thinking:string}): Promise<AgentInfo> {
    const person = this.deps.person(ownerId); if (!person) throw new Error('Owner not configured');
    const parent = parentAgentId ?? this.managerFor(ownerId);
    const parentAgent = parent ? await this.deps.store.getAgent(parent) : null;
    if (!parentAgent || parentAgent.ownerId !== ownerId) throw new Error('Worker parent not found');
    const swarm = parentAgent.role === 'worker' && parentAgent.goalId === goalId;
    const key = swarm ? `swarm:${parentAgent.id}` : `${ownerId}:${goalId}`;
    const previous = this.spawning.get(key);
    if (previous && !swarm) throw new Error('A worker is already being created for this goal');
    const work = (async () => {
      // Sub-agents of one coordinator are admitted one at a time, so its active count is exact.
      if (previous) await previous.catch(() => {});
      if (!(await this.deps.store.listGoals(ownerId, 'open')).some(g => g.id === goalId)) throw new Error('Open goal not found');
      const agents = await this.deps.store.listAgents(ownerId, { includeArchived: true });
      const byId = new Map(agents.map(a => [a.id, a]));
      const admitted = profile && await this.admitProfile(profile);
      if (swarm) {
        if (isSubAgent(parentAgent, parentAgent.parentAgentId ? byId.get(parentAgent.parentAgentId) : undefined)) throw new Error('swarm_depth: a sub-agent cannot launch sub-agents; report what needs splitting to your coordinator');
        if (!profile) throw new Error('swarm_profile_required: a sub-agent needs an explicit model and thinking, e.g. model claude-haiku-5-5, thinking low');
        const active = (swarmsOf(agents).get(parentAgent.id) ?? []).filter(subAgentActive);
        if (active.length >= SWARM_MAX_ACTIVE) throw new Error(`swarm_full: ${active.length} of ${SWARM_MAX_ACTIVE} sub-agents are active; launch more as these report`);
        const quota = swarmQuota((await usageReport(this.deps, ownerId)).plans, admitted === 'openai-codex' ? 'openai' : 'anthropic', profile.model);
        if (!quota.ok) throw new Error(`swarm_quota_low: the subscription pool's ${quota.metric} meter has ${quota.percentLeft.toFixed(0)}% left, under the ${SWARM_QUOTA_RESERVE_PERCENT}% kept for human-facing work; schedule a wake and launch later, or do the work yourself`);
      } else if (agents.some(w => w.role === 'worker' && w.goalId === goalId && !w.archived && !w.lastReport && w.state !== 'stopped' && !isSubAgent(w, w.parentAgentId ? byId.get(w.parentAgentId) : undefined))) throw new Error('This goal already has an active worker');
      const id = randomUUID();
      const agent = await this.deps.store.createAgent({ id, name, ownerId, parentAgentId: parentAgent.id, role: 'worker', goalId, model: profile?.model??person.worker.model, ...(profile?{thinking:profile.thinking as NonNullable<AgentInfo['thinking']>}:{}), sessionPath: join(this.deps.config.dataDir, 'sessions', `${id}.jsonl`), conversationTitle: name });
      this.deps.bus.toPerson(ownerId, { type: 'agent', agent });
      const conversation = await this.deps.store.getConversation(agent.conversationId, ownerId);
      if (conversation) this.deps.bus.toPerson(ownerId, { type: 'conversation', conversation });
      const held = swarm ? [] : (await this.deps.store.pendingWakes(ownerId)).filter(w => w.held?.goalId === goalId);
      const text = held.length ? `${task}\n\nTriggers your manager holds for this goal, still waiting (wake list shows them; cancel any you replace): ${held.map(w => `${w.id} ${describeTrigger(w)}`).join('; ')}.` : task;
      this.deliver({ agentId: id, kind: 'agent', text, fromId: parentAgent.id, conversationId: agent.conversationId });
      return agent;
    })();
    this.spawning.set(key, work);
    try { return await work; } finally { if (this.spawning.get(key) === work) this.spawning.delete(key); }
  }
  /** An explicit worker profile names a catalog model of an allowed provider and a known thinking level; there is no fallback. */
  private async admitProfile(profile: {model:string;thinking:string}): Promise<ModelProvider> {
    if(!['off','minimal','low','medium','high','xhigh','max'].includes(profile.thinking))throw Error('Invalid explicit worker thinking');
    const catalog=JSON.parse(await readFile(this.deps.config.modelsPath,'utf8'));
    const providers=catalog.catalog?.providers??catalog.providers;
    const provider=(['anthropic','openai-codex'] as const).find(p=>providers?.[p]?.models?.some((m:{id:string})=>m.id===profile.model));
    if(!provider)throw Error('Explicit worker model unavailable; no fallback');
    assertAllowedProvider(this.deps.config.allowedProviders,provider);
    return provider;
  }
  /**
   * A sub-agent whose turn settles without a report and without a pending wake would leave its coordinator waiting
   * forever: it is asked once to report, and if it settles silently again its coordinator gets a note.
   */
  private async chaseSubAgentReport(agent: AgentInfo, lane: Lane): Promise<void> {
    const parent = agent.parentAgentId ? await this.deps.store.getAgent(agent.parentAgentId) : null;
    if (!parent || parent.archived || !isSubAgent(agent, parent)) return;
    if ((await this.deps.store.pendingWakes(agent.ownerId)).some(wake => wake.agentId === agent.id)) return;
    const chases = lane.reportChases ?? 0;
    lane.reportChases = chases + 1;
    if (chases === 0) this.deliver({ agentId: agent.id, kind: 'agent', fromId: 'system', conversationId: agent.conversationId, text: SUB_AGENT_REPORT_MISSING });
    else if (chases === 1) {
      const text = `sub-agent ${agent.name} (${agent.id}) ended its turn twice without calling report, once after being asked to. Read what it found with workers peek id ${agent.id}, then message it, stop it or relaunch the task.`;
      const notice = await this.deps.store.appendMessage({ conversationId: parent.conversationId, authorId: agent.id, role: 'notice', notice: 'worker_note', text: `Note from worker ${agent.name}: ${text}` });
      this.deps.bus.toConversation(parent.conversationId, { type: 'message', message: notice });
      this.deliver({ agentId: parent.id, kind: 'note', fromId: agent.id, conversationId: parent.conversationId, text: `Worker ${agent.name} (${agent.id}), goal ${agent.goalId}: ${text}` });
    }
  }
  /** A coordinator that stops or finishes stops its sub-agents with it. */
  private async stopSubAgents(id: string): Promise<void> {
    const coordinator = await this.deps.store.getAgent(id);
    if (!coordinator || coordinator.role !== 'worker') return;
    const children = swarmsOf(await this.deps.store.listAgents(coordinator.ownerId, { includeArchived: true })).get(id) ?? [];
    for (const child of children.filter(c => !c.archived)) await this.stopAgent(child.id);
  }
  /** An archived run stays archived: the message is refused, and only an explicit restore brings the run back. */
  async messageWorker(id: string, text: string, fromId?: string): Promise<MessageOutcome> {
    const agent = await this.deps.store.getAgent(id); if (!agent) throw new Error('Agent not found');
    if (agent.archived) return { delivered: false, error: 'recipient_archived', agent };
    if (agent.lastReport) await this.publishAgent(await this.deps.store.updateAgent(id, { lastReport: null }));
    this.deliver({ agentId: id, kind: 'agent', text, fromId: fromId ?? this.managerFor(agent.ownerId) ?? 'system', conversationId: agent.conversationId });
    return { delivered: true };
  }
  private async publishAgent(agent: AgentInfo): Promise<void> {
    this.deps.bus.toPerson(agent.ownerId, { type: 'agent', agent });
    const conversation = await this.deps.store.getConversation(agent.conversationId, agent.ownerId);
    if (conversation) this.deps.bus.toPerson(agent.ownerId, { type: 'conversation', conversation });
  }
  /** Ends the current turn and drops queued input; the run stays available. A run can stop itself from a tool, so the abort is not awaited. */
  private interrupt(id: string): void {
    const lane = this.lane(id); lane.stopped = true; lane.queue = []; lane.preempting = false; lane.cutOff = false;
    void lane.session?.abort().catch(error => this.error(id, error));
  }
  async stopAgent(id: string): Promise<void> {
    if ((await this.deps.store.getAgent(id))?.role === 'manager') throw new ManagerPlacementFixed(id);
    this.interrupt(id);
    await this.publishAgent(await this.deps.store.updateAgent(id, { state: 'stopped', archived: true }));
    await this.stopSubAgents(id);
  }
  async archiveAgent(id: string, archived: boolean): Promise<AgentInfo> {
    if ((await this.deps.store.getAgent(id))?.role === 'manager') throw new ManagerPlacementFixed(id);
    if (archived) await this.stopAgent(id);
    else if ((await this.deps.store.getAgent(id))?.archived) await this.publishAgent(await this.deps.store.updateAgent(id, { archived: false, state: 'idle' }));
    const agent = await this.deps.store.getAgent(id);
    if (!agent) throw new Error('Agent not found');
    return agent;
  }
  /** A person's Stop ends the agents' current turns in that conversation; it never archives them. */
  async stop(conversationId: string): Promise<void> {
    await Promise.all((await this.deps.store.conversationMembers(conversationId)).map(async id => {
      const agent = await this.deps.store.getAgent(id);
      if (!agent) return;
      this.interrupt(id);
      if (!this.lane(id).active && agent.state === 'running') await this.publishAgent(await this.deps.store.updateAgent(id, { state: 'idle' }));
    }));
  }
  /** Unstarted inputs are retained and cut-off turns are marked interrupted; the next start resumes both. */
  async shutdown(): Promise<void> {
    this.closing = true; for (const timer of this.timers) clearTimeout(timer);
    const lanes = [...this.lanes.entries()];
    // Requests wait in the channel socket while the process restarts, so a turn that won't end must not hold them:
    // after SHUTDOWN_WAIT_MS the state of every lane is saved as it is, and the slow ones are named.
    const unsettled = new Set(lanes.map(([id]) => id));
    const settled = Promise.all(lanes.map(async ([id, lane]) => { await lane.session?.abort(); await lane.task; unsettled.delete(id); }));
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([settled, new Promise(resolve => { timer = setTimeout(resolve, SHUTDOWN_WAIT_MS); })]);
    clearTimeout(timer);
    if (unsettled.size) console.log(JSON.stringify({ type: 'shutdown_slow', waitedMs: SHUTDOWN_WAIT_MS, agents: [...unsettled] }));
    const pending: AgentInput[] = [];
    for (const [, lane] of lanes) {
      pending.push(...(lane.active && !lane.prompted ? lane.active : []), ...lane.queue);
      lane.stopped = true; lane.queue = []; lane.session?.dispose();
    }
    await this.deps.store.savePendingInputs(pending).catch(e => this.error('shutdown', e));
    await Promise.all(lanes.filter(([, lane]) => lane.active || lane.cutOff).map(([id, lane]) =>
      this.deps.store.updateAgent(id, { state: lane.prompted || lane.cutOff ? 'interrupted' : 'idle' }).catch(e => this.error(id, e))));
  }
}
export const createRuntime = (deps: Deps): Runtime => new AgentRuntime(deps);
