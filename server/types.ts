// Module interfaces. Owned by lead: change only by agreement, keep every implementation behind these.
import type { Page, PageRequest } from './tools/pagination.js';
import type { Hono } from 'hono';
import type { Server } from 'node:http';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type {
  Layout,
  Activity, AgentInfo, AgentState, ConversationSummary, Goal, LatencyReport, Message, MessageDisplay, MessagePage, MessagePart, NoticeKind, Person, PhoneNotification, ServerEvent, WebPushSubscription,
} from '../shared/contract.js';
import type { WebPush } from './web-push.js';
import type { PersonConfig, ServerConfig } from './config.js';
import type { ProcessPlacement } from './tools/owner.js';

// ---------------- Store (server/db/store.ts) ----------------
export type MessageCursor = { kind: 'latest' } | { kind: 'before'; seq: number } | { kind: 'after'; seq: number };
/** Human messages are shown and a notice's kind gives its display; an agent's messages carry the display its turn gave them. */
export type NewMessage = (
  | { role: 'human'; notice?: never; display?: never }
  | { role: 'assistant' | 'tool'; notice?: never; display: MessageDisplay }
  | { role: 'notice'; notice: NoticeKind; display?: never }
) & {
  conversationId: string; authorId: string; text: string;
  parts?: MessagePart[]; state?: Message['state']; clientId?: string | null; id?: string;
};
/** A person's message entering a conversation: idempotency, membership, archive state, sequence and insert decided in one statement. */
export type Admission =
  | { kind: 'admitted'; message: Message; conversation: ConversationSummary }
  | { kind: 'duplicate'; message: Message }
  | { kind: 'not_found' } | { kind: 'forbidden' } | { kind: 'archived' } | { kind: 'client_id_taken' };
export interface NewAgent {
  id: string; name: string; ownerId: string; parentAgentId?: string | null; role: 'manager' | 'worker'; goalId: string | null; model: string; thinking?: NonNullable<AgentInfo['thinking']>; sessionPath: string;
  conversationTitle: string;        // store creates the agent's own conversation (members: owner + agent)
}
export interface LatencyRow {
  messageId: string; conversationId: string; clientSentAt: number | null; receivedAt: number; admittedAt: number;
}
export type LatencyField = 'model_request_at' | 'first_token_at' | 'first_text_at';

export interface LoggedError { id: number; scope: string; message: string; at: number }
/** What the last delivered heartbeat showed (at), so the next one is sent only when something moved and marks what did; checkedAt is the last comparison. checklist: sha256 of HEARTBEAT.md, null when there is none. */
export interface HeartbeatState { at: number; checkedAt: number; errorId: number; goals: Record<string, number>; workers: Record<string, string>; alerts: string[]; checklist: string | null }

/** Which Signal conversation counts: the sender's 1:1 chat with the person, groups whose name or id contains `group`, or every chat. */
export type SignalChat = { kind: 'direct' } | { kind: 'group'; group: string } | { kind: 'any' };
/** What wakes an agent besides time. Mail fires on a matching message whose id was not in `seen` when the wake was scheduled. */
export type WakeEvent =
  | { source: 'mail'; folder: string; criteria: string; seen: string[] }
  | { source: 'signal'; from: string; chat: SignalChat; query: string | null }
  | { source: 'text'; query: string }
  | { source: 'event'; topic: string; prefix: boolean };
/** A host event (kenan-event, relays): taken from /var/lib/kenan/events/PERSON. `id` is the producer's idempotency key. */
export interface HostEvent { id: string; topic: string; body: unknown; arrivedAt: number; consumedAt: number | null }
/** What a wake listens for besides its own event and time.
 * `addressed`: anything addressed to the agent (host events whose topic names its id or goal that no wake has carried,
 * and, for a worker, reports, notes and messages sent to it); every wake an agent schedules listens this way unless it is a clock wake.
 * `clock`: nothing else, because the time itself is what the agent waits for; `reason` says why no event stands in for it.
 * `own`: only its own event and time; wakes settled before the time-or-event contract (2026-10-21) recorded this way. */
export type WakeListen = { kind: 'addressed' } | { kind: 'clock'; reason: string } | { kind: 'own' };
/** A clock wake (time only, with its reason), or a wake on its event, its deadline or anything addressed to the agent, whichever comes first. */
export type NewWakeTrigger =
  | { at: number; event: null; listen: { kind: 'clock'; reason: string } }
  | { at: number | null; event: WakeEvent | null; listen: { kind: 'addressed' } };
export type WakeTrigger =
  | { at: number; event: null; listen: Extract<WakeListen, { kind: 'clock' }> }
  | { at: number | null; event: WakeEvent | null; listen: Extract<WakeListen, { kind: 'addressed' }> }
  | ({ at: number; event: WakeEvent | null } | { at: null; event: WakeEvent }) & { listen: Extract<WakeListen, { kind: 'own' }> };
/** Who an addressed wake listens for: host event topics with one of `ids` as a `:` segment after the first, or a first segment `goal-<goal>`. */
export interface WakeAddress { ids: string[]; goals: string[] }
/** What a firing wake carries: its own topic's events, and the host events addressed to its agent since `since` (its creation). */
export interface WakeCarry { own: HostEvent[]; addressed: { address: WakeAddress; since: number }; limit: number }
/** The events a wake fired with; `waiting` addressed events did not fit and stay for its agent's next wake. */
export interface Carried { own: HostEvent[]; addressed: HostEvent[]; waiting: number }
export type FiredSettlement = Extract<WakeSettlement, { status: 'fired' }>;
export type WakeSettlement =
  | { status: 'fired'; reason: 'time' | 'event'; detail: string }
  | { status: 'cancelled'; reason: 'cancelled'; detail: string }
  | { status: 'dropped'; reason: 'agent_archived' | 'agent_stopped' | 'agent_missing'; detail: string };
/** A trigger a manager holds for a goal instead of an agent waiting on it itself: a worker whose wait would be long hands
 * it over with its handoff (state, files, what to do when it fires) and ends archived (`workerId`); a manager can hold one
 * for a goal directly (`workerId` null). When it fires, the manager gets the event and the handoff and launches a fresh worker. */
export interface WakeHold { goalId: string; workerId: string | null; handoff: string }
export type Wake = WakeTrigger & { id: string; agentId: string; ownerId: string; message: string; createdAt: number; held: WakeHold | null }
  & ({ status: 'pending' } | (WakeSettlement & { settledAt: number }));

/** What an agent's stored conversation shows it doing lately, newest last. Texts are cut to the requested chars; *Length is the full size. */
export interface RecentWork {
  lastActivityAt: number;
  said: { at: number; text: string; textLength: number; thinking: string }[];
  did: { at: number; updatedAt: number; running: boolean; isError: boolean; name: string; args: string; argsLength: number; head: string; tail: string; outLength: number }[];
}
export interface Store {
  migrate(): Promise<void>;
  close(): Promise<void>;
  // people
  upsertPerson(p: Person): Promise<void>;
  getPerson(id: string): Promise<Person | null>;
  listPeople(): Promise<Person[]>;
  // agents
  createAgent(a: NewAgent): Promise<AgentInfo>;
  getAgent(id: string): Promise<AgentInfo | null>;
  agentSessionPath(id: string): Promise<string | null>;
  listAgents(ownerId?: string, opts?: { includeArchived?: boolean }): Promise<AgentInfo[]>;
  /** Without `parent`, swarm sub-agents are left out (each coordinator stands for its swarm); with it, only that agent's own children. */
  listWorkersPage(ownerId: string, opts: PageRequest & { state?: AgentState | 'active' | 'all'; goalId?: string; includeArchived?: boolean; parent?: string }): Promise<Page<AgentInfo>>;
  listGoalsPage(ownerId: string, opts: PageRequest & { status?: Goal['status'] | 'all' }): Promise<Page<Omit<Goal, 'workerIds'> & { workerCount: number }>>;
  updateAgent(id: string, patch: Partial<{ state: AgentState; goalId: string | null; model: string; lastReport: AgentInfo['lastReport']; name: string; archived: boolean }>): Promise<AgentInfo>;
  /** In one transaction: the worker's wait becomes a trigger its manager holds for the worker's goal, the handoff is
   * appended to the goal's notes, and the worker's report says it handed off (so its turn ends archived). */
  handOff(h: { worker: AgentInfo & { goalId: string }; managerId: string; message: string; trigger: NewWakeTrigger; handoff: string; summary: string }): Promise<{ wake: Wake; goal: Goal; worker: AgentInfo }>;
  /** Whether the conversation's newest human message has no finished reply with words after it. */
  awaitingReply(conversationId: string): Promise<boolean>;
  /** Startup: every agent in state running → interrupted. Returns affected ids. */
  markRunningInterrupted(): Promise<string[]>;
  /** Unarchived agents whose turn was cut off by a restart or crash. */
  listInterrupted(): Promise<string[]>;
  /** Shutdown: inputs that were queued but not yet started, retained for the next start. */
  savePendingInputs(inputs: AgentInput[]): Promise<void>;
  /** Startup: returns and removes every retained input in arrival order. */
  takePendingInputs(): Promise<AgentInput[]>;
  createWake(w: { agentId: string; ownerId: string; message: string; trigger: NewWakeTrigger; held?: WakeHold | null }): Promise<Wake>;
  /** Pending wakes of every owner (ownerId null) or one owner, oldest first. */
  pendingWakes(ownerId: string | null): Promise<Wake[]>;
  /** One owner's wakes settled after `since`, newest first, at most `limit`; optionally one agent's. */
  settledWakes(ownerId: string, since: number, limit: number, agentId?: string): Promise<Wake[]>;
  /** Settles a pending wake; null when it was already settled, so each wake settles once. */
  settleWake(id: string, settlement: WakeSettlement): Promise<Wake | null>;
  /** Records a host event; false when the owner already has an event with this id. */
  recordHostEvent(e: { ownerId: string; id: string; topic: string; body: unknown }): Promise<boolean>;
  /** Events on the topic (or under it when `prefix`) that arrived at or after `since` or no wake has taken yet, oldest first. */
  hostEventsFor(ownerId: string, topic: { topic: string; prefix: boolean }, since: number, limit: number): Promise<HostEvent[]>;
  /** Host events addressed to `address` that arrived from `since` on and no wake has carried, oldest first, at most `limit`. */
  addressedEventsFor(ownerId: string, address: WakeAddress, since: number, limit: number): Promise<HostEvent[]>;
  /** Fires a pending wake once, in one transaction: takes its own events and, after them, the oldest uncarried events
   * addressed to its agent up to `carry.limit` in all, settles it with the detail `describe` writes for exactly those, and
   * marks only those carried. `describe` returning null leaves the wake pending. Null when it did not fire. */
  fireWake(id: string, carry: WakeCarry, describe: (carried: Carried) => FiredSettlement | null): Promise<Wake | null>;
  /** Deletes host events that arrived before `before`. */
  pruneHostEvents(before: number): Promise<number>;
  getHeartbeat(agentId: string): Promise<HeartbeatState | null>;
  saveHeartbeat(agentId: string, state: HeartbeatState): Promise<void>;
  // conversations
  createConversation(c: { title: string; ownerId: string; memberIds: string[]; agentId?: string | null }): Promise<ConversationSummary>;
  getConversation(id: string, forPersonId: string): Promise<ConversationSummary | null>;
  conversationMembers(id: string): Promise<string[]>;
  listConversations(forPersonId: string, opts?: { archived?: boolean; includeArchived?: boolean; limit?: number }): Promise<ConversationSummary[]>;
  updateConversation(id: string, forPersonId: string, patch: { title?: string; titleLocked?: boolean; archived?: boolean; color?: string | null; emoji?: string | null; pinnedAt?: number | null; keyDate?: string | null; keyLabel?: string | null; project?: boolean; statusLine?: string | null; projectId?: string | null; readThrough?: number; addMemberIds?: string[]; removeMemberIds?: string[] }): Promise<ConversationSummary>;
  layoutOf(personId: string): Promise<Layout>;
  setLayout(personId: string, layout: Layout): Promise<Layout>;
  // messages (seq assigned atomically per conversation)
  appendMessage(m: NewMessage): Promise<Message>;
  /** The send path: one round trip, so a busy host delays it once rather than at every step. */
  admitHumanMessage(m: { conversationId: string; authorId: string; text: string; parts: MessagePart[]; clientId: string }): Promise<Admission>;
  updateMessage(id: string, patch: { text?: string; parts?: MessagePart[]; state?: Message['state']; display?: MessageDisplay }): Promise<Message>;
  getMessageByClientId(clientId: string): Promise<Message | null>;
  listMessages(conversationId: string, cursor: MessageCursor, limit: number): Promise<MessagePage>;
  getMessage(conversationId: string, id: string): Promise<Message | null>;
  /** The newest assistant words and tool calls among each conversation's latest messages, cut to `chars` (workers peek). */
  recentWork(conversationIds: string[], shape: { said: number; did: number; chars: number }): Promise<Map<string, RecentWork>>;
  // goals
  createGoal(g: { ownerId: string; title: string; detail?: string; priority?: number }): Promise<Goal>;
  updateGoal(id: string, patch: Partial<Pick<Goal, 'title' | 'detail' | 'status' | 'priority'>> & { notes?: NotesChange }): Promise<Goal>;
  getGoal(ownerId: string, id: string): Promise<Goal | null>;
  listGoals(ownerId: string, status?: Goal['status']): Promise<Goal[]>;
  // files
  createFile(f: { ownerId: string; name: string; mime: string; size: number; path: string }): Promise<{ id: string }>;
  getFile(id: string): Promise<StoredFile | null>;
  /** The file if the person owns it or it is shown in a conversation they are a member of. */
  visibleFile(personId: string, id: string): Promise<StoredFile | null>;
  // latency + usage + errors
  recordLatency(r: LatencyRow): Promise<void>;
  markLatency(messageId: string, field: LatencyField, at: number): Promise<void>;   // only sets if currently null
  latencyReport(windowMs: number): Promise<LatencyReport>;
  recordModelCall(c: { agentId: string; model: string; inputTokens: number; outputTokens: number; cacheRead: number; cacheWrite: number; costUsd: number; at: number }): Promise<void>;
  spend(sinceMs: number): Promise<{ totalUsd: number; byAgent: { agentId: string; usd: number }[] }>;
  /** Stores one broker poll (`source` = broker:<port>) and drops that broker's samples older than keepSinceMs. */
  recordUsageSamples(source: string, samples: UsageSample[], keepSinceMs: number): Promise<void>;
  usageSamples(source: string, sinceMs: number): Promise<UsageSample[]>;
  logError(scope: string, message: string): Promise<void>;
  // phone notifications
  createNotification(n: Omit<PhoneNotification, 'id' | 'createdAt'> & { personId: string }): Promise<PhoneNotification>;
  /** Oldest first: the person's notifications with id > afterId created at or after sinceMs, at most limit. */
  notificationsAfter(personId: string, afterId: number, sinceMs: number, limit: number): Promise<PhoneNotification[]>;
  /** Stores (or moves to this person) a device's Web Push subscription, keyed by its endpoint. */
  savePushSubscription(personId: string, subscription: WebPushSubscription): Promise<void>;
  pushSubscriptions(personId: string): Promise<WebPushSubscription[]>;
  /** Removes the subscription with this endpoint (only the person's own when personId is given). */
  deletePushSubscription(endpoint: string, personId: string | null): Promise<void>;
  /** Newest first: errors after an error id, scoped to the owner's agents and to non-agent scopes. */
  errorsAfter(ownerId: string, afterId: number, limit: number): Promise<LoggedError[]>;
  // peer Kenaznia messages
  /** Queues an outbound message for the relay. */
  createPeerOutbound(m: { ownerId: string; peerId: string; fromAgent: string; toAgent: string | null; text: string }): Promise<PeerMessage>;
  /** Stores an inbound message once per id; null when that id was already received. */
  receivePeerInbound(m: { id: string; ownerId: string; peerId: string; fromAgent: string; toAgent: string | null; text: string; createdAt: number }): Promise<PeerMessage | null>;
  /** Outbound messages the relay has not acknowledged, oldest first. */
  peerOutbox(ownerId: string, peerId: string, limit: number): Promise<PeerMessage[]>;
  /** Marks outbound messages relayed; returns the ids that were pending. */
  ackPeerOutbound(ownerId: string, peerId: string, ids: string[]): Promise<string[]>;
  /** Both directions, newest first. */
  peerHistory(ownerId: string, peerId: string, limit: number): Promise<PeerMessage[]>;
}
/** toAgent: the agent on the receiving side it is addressed to; null addresses that side's Kenaznia. */
export type PeerMessage = { id: string; ownerId: string; peerId: string; fromAgent: string; toAgent: string | null; text: string; createdAt: number }
  & ({ direction: 'out'; relayedAt: number | null } | { direction: 'in' });

// ---------------- Event bus (server/events/bus.ts) ----------------
export interface Bus {
  /** Send to every human member of the conversation (looked up via store, cached). */
  toConversation(conversationId: string, event: ServerEvent): void;
  /** Current Activity of each conversation with a live run, as last published through toConversation. */
  activity(conversationId: string): Activity | null;
  /** Send to one person (all their open streams). */
  toPerson(personId: string, event: ServerEvent): void;
  subscribe(personId: string, send: (event: ServerEvent) => void): () => void;
  /** Call when membership changes so the member cache is refreshed. */
  invalidateMembers(conversationId: string): void;
}

// ---------------- Agent runtime (server/agents/) ----------------
export type InputKind = 'human' | 'report' | 'note' | 'heartbeat' | 'agent' | 'room' | 'external' | 'restart' | 'wake' | 'refusal';
export interface AgentInput {
  agentId: string;
  kind: InputKind;
  text: string;
  fromId: string;                   // person id (human or agent) or 'system'
  conversationId: string;           // conversation the input belongs to (agent's own chat or a room)
  humanMessageId?: string;          // for latency marks
  fileIds?: string[];
  /** A person is waiting on a live voice or phone line for this request's spoken reply. */
  live?: { delegationId: string };
}
export interface StoredFile { id: string; ownerId: string; name: string; mime: string; size: number; path: string }

export interface AgentTurn { startedAt: number; inputs: Pick<AgentInput, 'kind' | 'fromId' | 'text'>[]; queued: number }
export interface Runtime {
  start(): Promise<void>;           // create managers, resume interrupted turns and retained inputs, schedule heartbeats from the persisted previous one
  shutdown(): Promise<void>;
  /** Called by HTTP after a human message is admitted. Routes to the agent(s) in that conversation. */
  onHumanMessage(message: Message, conversation: ConversationSummary): void;
  /** Deliver any input to a specific agent (used by tools, rooms, extensions). Never blocks on the model. */
  deliver(input: AgentInput): void;
  stop(conversationId: string): Promise<void>;
  archiveAgent(id: string, archived: boolean): Promise<AgentInfo>;
  /** Owner's manager agent id, if any. */
  managerFor(ownerId: string): string | null;
  /** The turn an agent is running now (when it started, the inputs it answers, how many wait behind it), or null between turns. */
  turnOf(agentId: string): AgentTurn | null;
}

// ---------------- Tools & extensions ----------------
/**
 * How a call touches the owner's files, which orders it against the other calls of its turn (server/tools/order.ts):
 * `writes` (creates, changes or runs anything) starts after every earlier `reads`/`writes` call, `reads` after every earlier `writes` call, `none` at once.
 * streamArgs sees a call's arguments as the model writes them, before the call is complete and executed.
 */
export type FileAccess = 'reads' | 'writes' | 'none';
export type KenanTool = ToolDefinition<any> & { files: FileAccess; streamArgs?(callId: string, args: Record<string, unknown>): void };
export interface ToolContext {
  person: PersonConfig;             // owner of the agent
  agent: AgentInfo;
  deps: Deps;
}
export interface Extension {
  id: string;                       // matches PersonConfig.extensions entries
  name: string;
  /** At most ONE tool per extension (use an `action` parameter). Given to agents of people with the extension enabled. */
  tool?(ctx: ToolContext): KenanTool;
  roles?: ('manager' | 'worker')[]; // default both
  promptSnippet?: string;           // appended to the system prompt of agents that get the tool
  routes?(app: Hono, deps: Deps): void;   // mounted under /api/ext/<id>/...
  /** Unauthenticated provider webhooks, mounted under /hooks/<id>/...; each handler authenticates its caller itself. */
  hooks?(app: Hono, deps: Deps): void;
  /** Unauthenticated provider WebSocket upgrades on the HTTP server; each handler authenticates its caller itself. */
  publicSockets?(server: Server): void;
  start?(deps: Deps): Promise<void>;
  stop?(): Promise<void>;
}

export interface Deps {
  config: ServerConfig;
  /** Where owner processes (agent tools, mail, browser, observers) run: the channel's scopes in service, the caller's cgroup in tests. */
  placement: ProcessPlacement;
  store: Store;
  bus: Bus;
  runtime: Runtime;
  extensions: Extension[];
  webPush: WebPush;
  person(id: string): PersonConfig | undefined;
  now(): number;
}

/** One account's meter reading from one broker poll at `at`; readingAt is when the broker read the meter. */
export interface UsageSample {
  provider: string; metric: string; account: string;
  percentLeft: number | null; resetAt: number | null; windowHours: number | null; readingAt: number; at: number;
}
/** Goal notes are a dated log, newest first: `prepend` adds one entry at the top (stamped by `datedNote`); `replace`
 *  rewrites the whole field and is only ever an explicit request. */
export type NotesChange = { kind: 'prepend'; entry: string } | { kind: 'replace'; text: string };
