// Module interfaces. Owned by lead: change only by agreement, keep every implementation behind these.
import type { Device, ZoneReport } from '../shared/zone.js';
import type { Page, PageRequest } from './tools/pagination.js';
import type { Hono } from 'hono';
import type { Server } from 'node:http';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type {
  Layout, Onboarding, SearchQuery, SearchPage,
  Activity, AgentInfo, AgentState, ConversationSummary, Goal, GoalSummary, LatencyReport, Message, MessageDisplay, MessagePage, MessagePart, NoticeKind, Person, PhoneNotification, ServerEvent, Waiting, WebPushSubscription,
  ChatGroup, ChatGroupInput, TrayTile,
} from '../shared/contract.js';
import type { WebPush } from './web-push.js';
import type { PersonConfig, ServerConfig } from './config.js';
import type { ProcessPlacement } from './tools/owner.js';

// ---------------- Store (server/db/store.ts) ----------------
export type MessageCursor = { kind: 'latest' } | { kind: 'before'; seq: number } | { kind: 'after'; seq: number } | { kind: 'around'; target: string | number };
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
  id: string; name: string; ownerId: string; parentAgentId?: string | null; role: AgentInfo['role']; goalId: string | null; model: string; thinking?: NonNullable<AgentInfo['thinking']>; speed?: AgentInfo['speed']; sessionPath: string;
  originConversationId: string | null;
  conversationTitle: string;        // store creates the agent's own conversation (members: owner + agent)
}
export interface LatencyRow {
  messageId: string; conversationId: string; clientSentAt: number | null; receivedAt: number; admittedAt: number;
}
export type LatencyField = 'model_request_at' | 'first_token_at' | 'first_text_at';

export interface LoggedError { id: number; scope: string; message: string; at: number }
/** What the last delivered heartbeat showed (at), so the next one is sent only when something moved and marks what did; checkedAt is the last comparison. checklist: sha256 of HEARTBEAT.md, null when there is none. */
/** checklist: the HEARTBEAT.md text last delivered (older builds stored its sha256). shownFullAt: when the last heartbeat listing every goal and the whole HEARTBEAT.md was delivered; null once the manager's context may no longer hold it (a compaction). */
/** A host alert as a heartbeat last listed it: its title, severity rank (0 when the file names none) and when. */
export interface AlertShown { title: string; severity: number; at: number }
export interface HeartbeatState { at: number; checkedAt: number; errorId: number; goals: Record<string, number>; workers: Record<string, string>; alerts: string[]; checklist: string | null; shownFullAt: number | null;
  /** Host alerts by file name as last listed in full; one unchanged since is only counted (heartbeat.ts alertLines). */
  alertsShown: Record<string, AlertShown> }

/** Which Signal conversation counts: the sender's 1:1 chat with the person, groups whose name or id contains `group`, or every chat. */
export type SignalChat = { kind: 'direct' } | { kind: 'group'; group: string } | { kind: 'any' };
/** What wakes an agent besides time. Mail fires on matching UIDs newer than its per-mailbox/folder watermark.
 * Persisted mail events with `seen` keep their original message-id exclusion behavior.
 * Signal and text with `about` fire only on a matching message a small model judges to be about it (wake-about.ts). */
export type WakeEvent =
  | ({ source: 'mail'; folder: string; criteria: string } & ({ after: Record<string, string>; seen?: never } | { seen: string[]; after?: never }))
  | { source: 'signal'; account?: 'kenan-own'; from: string; chat: SignalChat; query: string | null; about?: string }
  | { source: 'text'; query: string; about?: string }
  | { source: 'event'; topic: string; prefix: boolean };
/** A host event (kenan-event, relays): taken from /var/lib/kenan/events/PERSON. `id` is the producer's idempotency key. */
export interface HostEvent { id: string; topic: string; body: unknown; arrivedAt: number; consumedAt: number | null }
/** What a wake listens for besides its own event and time.
 * `addressed`: anything addressed to the agent (host events whose topic names its id or goal that no wake has carried,
 * and, for a worker, reports, notes and messages sent to it); every wake an agent schedules listens this way unless it is a clock wake.
 * `clock`: nothing else, because the time itself is what the agent waits for; `reason` says why no event stands in for it.
 * `own`: only its own event and time; used for automatic job watches and sub-agent handoffs to their coordinator. */
export type WakeListen = { kind: 'addressed' } | { kind: 'clock'; reason: string } | { kind: 'own' };
/** A clock wake (time only, with its reason), or a wake on its event, its deadline or anything addressed to the agent, whichever comes first. */
export type NewWakeTrigger =
  | { at: number; event: null; listen: { kind: 'clock'; reason: string } }
  | { at: number | null; event: WakeEvent | null; listen: { kind: 'addressed' } }
  | ({ at: number; event: WakeEvent | null } | { at: null; event: WakeEvent }) & { listen: { kind: 'own' } };
export type WakeTrigger =
  | { at: number; event: null; listen: Extract<WakeListen, { kind: 'clock' }> }
  | { at: number | null; event: WakeEvent | null; listen: Extract<WakeListen, { kind: 'addressed' }> }
  | ({ at: number; event: WakeEvent | null } | { at: null; event: WakeEvent }) & { listen: Extract<WakeListen, { kind: 'own' }> };
/** Who an addressed wake listens for: host event topics with one of `ids` as a `:` segment after the first, or a first segment `goal-<goal>`. */
export interface WakeAddress { ids: string[]; goals: string[]; /** The ids among `ids` that are archived sub-agents': what names only them is old news to the listener. */ archived: string[] }
/** What a firing wake carries: its own topic's events, and up to `scan` of the newest host events addressed to its agent since
 * `since` (its creation), which `split` divides into those shown in full and those coalesced into one line per job. */
export interface WakeCarry { own: HostEvent[]; addressed: { address: WakeAddress; since: number }; scan: number; split: (events: HostEvent[]) => { full: HostEvent[]; brief: HostEvent[] } }
/** The events a wake fired with: `addressed` in full, `brief` (routine successes, progress and old backlog) coalesced; `waiting` addressed events did not fit and stay for its agent's next wake. */
export interface Carried { own: HostEvent[]; addressed: HostEvent[]; brief: HostEvent[]; waiting: number }
export type FiredSettlement = Extract<WakeSettlement, { status: 'fired' }>;
export type WakeSettlement =
  | { status: 'fired'; reason: 'time' | 'event'; detail: string }
  | { status: 'cancelled'; reason: 'cancelled'; detail: string }
  | { status: 'dropped'; reason: 'agent_archived' | 'agent_stopped' | 'agent_missing'; detail: string };
/** A trigger a manager holds for a goal instead of an agent waiting on it itself: a worker whose wait would be long hands
 * it over with its handoff (state, files, what to do when it fires) and ends archived (`workerId`); a manager can hold one
 * for a goal directly (`workerId` null). When it fires, the manager gets the event and the handoff and launches a fresh worker. */
export interface WakeHold { goalId: string; workerId: string | null; handoff: string }
/** originConversationId: the chat whose turn scheduled it (a held trigger takes its worker's); null: the agent's own chat. */
export type Wake = WakeTrigger & { id: string; agentId: string; ownerId: string; message: string; createdAt: number; held: WakeHold | null; originConversationId: string | null }
  & ({ status: 'pending' } | (WakeSettlement & { settledAt: number }));

/** What an agent's stored conversation shows it doing lately, newest last. Texts are cut to the requested chars; *Length is the full size. */
export interface RecentWork {
  lastActivityAt: number;
  said: { at: number; text: string; textLength: number; thinking: string }[];
  did: { at: number; updatedAt: number; running: boolean; isError: boolean; name: string; args: string; argsLength: number; head: string; tail: string; outLength: number }[];
}
/** A room change every member sees: its title, whether it is closed, who is in it. */
export type SharedRoomPatch = { title?: string; titleLocked?: boolean; archived?: boolean; addMemberIds?: string[]; removeMemberIds?: string[] };
/** A change to one member's own view of a room: where they have read to and how they organise it. */
export type MemberRoomPatch = {
  readThrough?: number; groupId?: string | null; color?: string | null; emoji?: string | null; pinnedAt?: number | null;
  keyDate?: string | null; keyLabel?: string | null; project?: boolean; statusLine?: string | null; projectId?: string | null;
  memberColors?: Record<string, string | null>;
};
export type RoomPatch = SharedRoomPatch & MemberRoomPatch;
/** How one member files a room: everything in MemberRoomPatch but where they have read to. */
export type RoomOrganisation = Pick<ConversationSummary, 'color' | 'memberColors' | 'emoji' | 'pinnedAt' | 'keyDate' | 'keyLabel' | 'project' | 'statusLine' | 'projectId' | 'groupId'>;
export type OrganisationPatch = Omit<MemberRoomPatch, 'readThrough'>;
/** Whether a patch changes what the room's other members see. */
export const sharedChange = (p: RoomPatch): boolean => p.title !== undefined || p.titleLocked !== undefined || p.archived !== undefined
  || !!p.addMemberIds?.length || !!p.removeMemberIds?.length;

/** Who a new chat of hers holds: her, the others she chose, and her Kenaznia unless another person is in it (then it is a channel). */
export const soloChatMembers = (owner: string, others: string[], manager: string | null, isPerson: (id: string) => boolean): string[] =>
  [...new Set([owner, ...others, ...(manager && !others.some(id => id !== owner && isPerson(id)) ? [manager] : [])])];

export interface PhoneLocation {
  personId: string; latitude: number; longitude: number; accuracy: number; measuredAt: number; receivedAt: number;
  place: string | null; wifiSsid: string | null; atHome: boolean; homeSince: number | null;
}

export interface Store {
  prunePhoneLocations(now: number): Promise<void>;
  savePhoneLocation(location: PhoneLocation): Promise<void>;
  latestPhoneLocation(personId: string, now: number): Promise<PhoneLocation | null>;
  migrate(): Promise<void>;
  /** Puts each person's Kenaznia into every chat of hers that has no other person in it and is no agent's own chat, the
   *  chats her messages reach it from; returns the memberships it added. */
  joinManagersToOwnChats(): Promise<{ conversationId: string; managerId: string }[]>;
  close(): Promise<void>;
  // people
  upsertPerson(p: Person): Promise<void>;
  getPerson(id: string): Promise<Person | null>;
  /** Names only, for the requested visible tool references; null means missing or ambiguous. */
  referenceNames(ownerId: string, visibleOwners: string[], refs: string[], isolated: boolean): Promise<Record<string, string | null>>;
  listPeople(opts?: { ids: string[]; includeHumans?: boolean }): Promise<Person[]>;
  // agents
  createAgent(a: NewAgent): Promise<AgentInfo>;
  getAgent(id: string): Promise<AgentInfo | null>;
  agentSessionPath(id: string): Promise<string | null>;
  listAgents(ownerId?: string, opts?: { includeArchived?: boolean; includeAncestors?: boolean; goalId?: string }): Promise<AgentInfo[]>;
  /** Named agents and only their ancestor chains, including archived parents. */
  agentAncestors(ownerId: string, roots: string[]): Promise<AgentInfo[]>;
  /** The selected workers, all their worker descendants (including archived ones), and their ancestors. */
  workerLineage(ownerId: string, roots: string[]): Promise<AgentInfo[]>;
  agentPresence(ownerId: string): Promise<{ agent: AgentInfo; goal: string | null; on: string }[]>;
  /** The person's agents among `ids` and their children, archived ones included: what deciding a wake needs, without reading
   *  every agent the person ever had. */
  agentsAround(ownerId: string, ids: string[]): Promise<AgentInfo[]>;
  /** Without `parent`, swarm sub-agents are left out (each coordinator stands for its swarm); with it, only that agent's own children. */
  listWorkersPage(ownerId: string, opts: PageRequest & { state?: AgentState | 'active' | 'all'; goalId?: string; includeArchived?: boolean; parent?: string }): Promise<Page<AgentInfo>>;
  listGoalsPage(ownerId: string, opts: PageRequest & { status?: Goal['status'] | 'all' }): Promise<Page<Omit<Goal, 'workerIds'> & { workerCount: number }>>;
  updateAgent(id: string, patch: Partial<{ state: AgentState; goalId: string | null; model: string; lastReport: AgentInfo['lastReport']; name: string; archived: boolean; originConversationId: string | null; turnChat: TurnChat; parentAgentId: string; speed: AgentInfo['speed']; thinking: NonNullable<AgentInfo['thinking']> }>): Promise<AgentInfo>;
  /** Pending held triggers (those held by `from`, or held for `goalId`, or both) move to agent `to`; returns their ids. */
  /** The person's agents whose id is `ref` or starts with it (8 characters or more): what an id reference can name, without listing every run. Blank chats are never named this way. */
  agentsMatching(ownerId: string, ref: string, opts?: { includeBlank?: boolean }): Promise<AgentInfo[]>;
  /** Agents (never blank chats) of these people matching every filter given: id (exact or 8+ character prefix), goal id prefix, parent id (exact or 8+ prefix), part of the name (any case). Unarchived first, most recently active first. */
  findAgents(f: { owners: readonly string[]; id?: string; goal?: string; parent?: string; name?: string; includeArchived: boolean; limit: number }): Promise<AgentInfo[]>;
  moveHeldWakes(where: { from?: string; goalId?: string }, to: string): Promise<string[]>;
  /** In one transaction: the worker's wait becomes a trigger its manager holds for the worker's goal, the handoff is
   * appended to the goal's notes, and the worker's report says it handed off (so its turn ends archived). */
  handOff(h: { worker: AgentInfo & { goalId: string }; managerId: string; message: string; trigger: NewWakeTrigger; handoff: string; summary: string }): Promise<{ wake: Wake & { replacedIds?: string[] }; goal: Goal; worker: AgentInfo }>;
  /** Whether the conversation's newest human message has no finished reply with words after it. */
  awaitingReply(conversationId: string): Promise<boolean>;
  /** Startup: every agent in state running → interrupted. Returns affected ids. */
  markRunningInterrupted(): Promise<string[]>;
  /** Unarchived agents whose turn was cut off by a restart or crash, with the chat that turn was answering. */
  listInterrupted(): Promise<Interrupted[]>;
  /** An input delivered to an agent, stored before delivery is acknowledged; returns its id. It stays until the agent's
   * transcript holds it or it is dropped (Stop, archive), so a restart or crash at any moment loses nothing. */
  storeInput(input: AgentInput): Promise<string | null>;
  /** Startup: every stored input not yet in its agent's transcript, in arrival order. */
  storedInputs(): Promise<StoredInput[]>;
  /** The inputs are in their agents' transcripts, or were dropped on purpose. */
  deleteInputs(ids: string[]): Promise<void>;
  /** In one transaction, deletes stored input `from` and stores `input` in its place; null when `from` was already gone, so a move happens once. */
  moveInput(from: string, input: AgentInput): Promise<string | null>;
  createWake(w: { agentId: string; ownerId: string; message: string; trigger: NewWakeTrigger; held?: WakeHold | null; originConversationId: string | null }): Promise<Wake & { replacedIds?: string[] }>;
  /** Pending wakes of every owner (ownerId null) or one owner, oldest first. */
  pendingWakes(ownerId: string | null): Promise<Wake[]>;
  /** Pending or settled wakes matching a full id or 8+ character prefix, scoped to one owner. */
  wakesMatching(ownerId: string, ref: string): Promise<Wake[]>;
  /** One owner's wakes settled after `since`, newest first, at most `limit`; optionally one agent's. */
  settledWakes(ownerId: string, since: number, limit: number, agentId?: string, goalId?: string | null): Promise<Wake[]>;
  /** Settles a pending wake; null when it was already settled, so each wake settles once. */
  settleWake(id: string, settlement: WakeSettlement): Promise<Wake | null>;
  /** Records a host event; false when the owner already has an event with this id. */
  recordHostEvent(e: { ownerId: string; id: string; topic: string; body: unknown }): Promise<boolean>;
  /** Events on the topic (or under it when `prefix`) that arrived at or after `since` or no wake has taken yet, oldest first. */
  /** Events on the topic that arrived from `since` on. An exact topic also takes older ones no wake carried; a prefix takes
   * older uncarried ones only within ADDRESSED_MAX_AGE_MS and naming one of `ids`. Events naming `ids` come first. */
  hostEventsFor(ownerId: string, topic: { topic: string; prefix: boolean }, since: number, limit: number, ids: readonly string[]): Promise<HostEvent[]>;
  /** The latest event ever on exactly `topic`, and the latest on a topic under it (`topic:…`); null where there is none. */
  topicHistory(ownerId: string, topic: string): Promise<{ exact: HostEvent | null; under: HostEvent | null }>;
  /** The newest `limit` host events addressed to `address` that arrived from `since` on and no wake has carried, oldest first. */
  addressedEventsFor(ownerId: string, address: WakeAddress, since: number, limit: number): Promise<HostEvent[]>;
  /** Fires a pending wake once, in one transaction: takes its own events and the newest `carry.scan` uncarried events
   * addressed to its agent, as `carry.split` divides them, settles it with the detail `describe` writes for exactly those, and
   * marks only those carried. `describe` returning null leaves the wake pending. Null when it did not fire. */
  fireWake(id: string, carry: WakeCarry, describe: (carried: Carried) => FiredSettlement | null): Promise<Wake | null>;
  /** Deletes host events that arrived before `before`. */
  pruneHostEvents(before: number): Promise<number>;
  getHeartbeat(agentId: string): Promise<HeartbeatState | null>;
  saveHeartbeat(agentId: string, state: HeartbeatState): Promise<void>;
  /** The manager's context was compacted: its next heartbeat lists everything again. */
  heartbeatForgotten(agentId: string): Promise<void>;
  // conversations
  /** groupId: the owner's group for it, set before its colour is chosen. */
  createConversation(c: { title: string; ownerId: string; memberIds: string[]; agentId?: string | null; groupId?: string | null }): Promise<ConversationSummary>;
  getConversation(id: string, forPersonId: string): Promise<ConversationSummary | null>;
  conversationMembers(id: string): Promise<string[]>;
  listConversations(forPersonId: string, opts?: { archived?: boolean; includeArchived?: boolean; limit?: number }): Promise<ConversationSummary[]>;
  /** Shared rooms the person belongs to, including chats whose other people have left. */
  sharedConversations(forPersonId: string, opts: { includeArchived: boolean }): Promise<ConversationSummary[]>;
  /** Removes only this membership and appends one visible notice atomically; retries do nothing. */
  leaveConversation(id: string, personId: string): Promise<Message | null>;
  updateConversation(id: string, forPersonId: string, patch: RoomPatch): Promise<ConversationSummary>;
  /** How the person files shared chats held on the other channel (server/channels/rooms.ts), by chat id; a chat they
   *  never organised has no entry. */
  remoteOrganisation(personId: string): Promise<Map<string, RoomOrganisation>>;
  organiseRemote(personId: string, conversationId: string, patch: OrganisationPatch): Promise<RoomOrganisation>;
  layoutOf(personId: string): Promise<Layout>;
  setLayout(personId: string, layout: Layout): Promise<Layout>;
  /** The tray tiles the person chose, in order; null: they never chose. */
  trayOf(personId: string): Promise<TrayTile[] | null>;
  setTray(personId: string, tiles: TrayTile[] | null): Promise<TrayTile[] | null>;
  /** The zone the person's app last reported, or null when it never has. */
  zoneOf(personId: string): Promise<string | null>;
  /** The zone the person's app last reported with the kind of device it came from, or null when it never has. */
  zoneReportOf(personId: string): Promise<ZoneReport | null>;
  /** Records the reported zone and device; changed is false when both were already that, and nothing is written. */
  setZone(personId: string, zone: string, device: Device): Promise<ZoneReport & { changed: boolean }>;
  seenOf(personId: string): Promise<Onboarding[]>;
  /** Adds item to what the person has seen; added is false when it was already there (each is given once). */
  markSeen(personId: string, item: Onboarding): Promise<{ added: boolean; seen: Onboarding[] }>;
  // messages (seq assigned atomically per conversation)
  appendMessage(m: NewMessage): Promise<Message>;
  sealGuess(input: { ownerId: string; authorId: string; conversationId: string; callId: string; guess: string; topic?: string }): Promise<Message>;
  revealGuess(ownerId: string, id: string, score?: 'called' | 'missed'): Promise<Message>;
  listSealedGuesses(ownerId: string, conversationId: string): Promise<Message[]>;
  /** The send path: one round trip, so a busy host delays it once rather than at every step. */
  admitHumanMessage(m: { conversationId: string; authorId: string; text: string; parts: MessagePart[]; clientId: string }): Promise<Admission>;
  updateMessage(id: string, patch: { text?: string; parts?: MessagePart[]; state?: Message['state']; display?: MessageDisplay; backgroundSummary?: string }): Promise<Message>;
  /** Replace an authored message, or physically replace it with a content-free deletion marker. */
  rewriteMessage(message: Message, text: string | null): Promise<Message>;
  /** Scrub copies on a linked host even when that host has no original message row. */
  scrubMessageCopies(message: Message, replacement: string): Promise<void>;
  /** Claims an unsummarized input once by storing its fallback before calling the model. */
  claimBackgroundSummary(id: string, fallback: string): Promise<Message | null>;
  getMessageByClientId(clientId: string): Promise<Message | null>;
  searchMessages(personId: string, query: SearchQuery): Promise<SearchPage>;
  listMessages(conversationId: string, cursor: MessageCursor, limit: number): Promise<MessagePage>;
  getMessage(conversationId: string, id: string): Promise<Message | null>;
  /** The newest assistant words and tool calls among each conversation's latest messages, cut to `chars` (workers peek). */
  recentWork(conversationIds: string[], shape: { said: number; did: number; chars: number }): Promise<Map<string, RecentWork>>;
  // goals
  createGoal(g: { ownerId: string; title: string; detail?: string; priority?: number; chatId?: string | null; category?: Goal['category'] }): Promise<Goal>;
  updateGoal(id: string, patch: Partial<Pick<Goal, 'title' | 'detail' | 'status' | 'priority' | 'chatId' | 'category'>> & { notes?: NotesChange }): Promise<Goal>;
  getGoal(ownerId: string, id: string): Promise<Goal | null>;
  /** Only the goals an exact id or an 8+ character prefix can name, without loading all goal details and workers. */
  goalsMatching(ownerId: string, ref: string): Promise<Goal[]>;
  /** Optional report filter avoids loading unrelated goal notes and worker lists. */
  listGoals(ownerId: string, status?: Goal['status'], filter?: { createdSince: number; notesContaining: string }): Promise<Goal[]>;
  /** Goals with an unarchived worker reporting done since this time; dispatch still checks lineage and duplicates. */
  goalsWithRecentReport(ownerId: string, since: number): Promise<Goal[]>;
  goalSummaries(ownerId: string, ids: string[]): Promise<GoalSummary[]>;
  // files
  createFile(f: { ownerId: string; name: string; mime: string; size: number; path: string }): Promise<{ id: string }>;
  getFile(id: string): Promise<StoredFile | null>;
  /** The person's file stored at exactly this path, or null. */
  fileAt(ownerId: string, path: string): Promise<StoredFile | null>;
  /** The file if the person owns it or it is shown in a conversation they are a member of. */
  visibleFile(personId: string, id: string): Promise<StoredFile | null>;
  // latency + usage + errors
  recordLatency(r: LatencyRow): Promise<void>;
  markLatency(messageId: string, field: LatencyField, at: number): Promise<void>;   // only sets if currently null
  latencyReport(windowMs: number): Promise<LatencyReport>;
  recordModelCall(c: { agentId: string; model: string; inputTokens: number; outputTokens: number; cacheRead: number; cacheWrite: number; costUsd: number; at: number }): Promise<void>;
  personSpend(ownerId: string, sinceMs: number): Promise<number>;
  spend(sinceMs: number): Promise<{ totalUsd: number; byAgent: { agentId: string; usd: number }[] }>;
  /** Model calls since sinceMs summed per agent, model, period (0: at >= hourStart, 1: at >= dayStart, 2: older) and tier
   * (how many of `thresholds` the call's prompt tokens exceeded, for tiered list prices). */
  cacheGroups(sinceMs: number, dayStart: number, hourStart: number, thresholds: number[]): Promise<CacheGroup[]>;
  /** Stores one broker poll (`source` = broker:<port>) and drops that broker's samples older than keepSinceMs. */
  recordUsageSamples(source: string, samples: UsageSample[], keepSinceMs: number): Promise<void>;
  usageSamples(source: string, sinceMs: number): Promise<UsageSample[]>;
  logError(scope: string, message: string): Promise<void>;
  // phone notifications
  notificationZoneOf(personId: string): Promise<string | null>;
  quietHours(personId: string): Promise<import('../shared/contract.js').QuietHours>;
  setQuietHours(personId: string, value: import('../shared/contract.js').QuietHours): Promise<void>;
  holdNotification(personId: string, id: number): Promise<void>;
  claimQuietSummary(personId: string): Promise<number>;
  createNotification(n: Omit<PhoneNotification, 'id' | 'createdAt'> & { personId: string }): Promise<PhoneNotification>;
  /** Oldest first: the person's notifications with id > afterId created at or after sinceMs, at most limit. */
  notificationsAfter(personId: string, afterId: number, sinceMs: number, limit: number): Promise<PhoneNotification[]>;
  /** Dismisses delivered alerts for a read chat; returns the largest affected ID, or null if nothing changed. */
  dismissNotifications(personId: string, conversationId: string): Promise<number | null>;
  /** Reconciles alerts read while a device's stream was disconnected. */
  dismissedNotifications(personId: string): Promise<{ conversationId: string; throughId: number }[]>;
  /** Stores (or moves to this person) a device's Web Push subscription, keyed by its endpoint. */
  savePushSubscription(personId: string, subscription: WebPushSubscription): Promise<void>;
  pushSubscriptions(personId: string): Promise<WebPushSubscription[]>;
  /** Removes the subscription with this endpoint (only the person's own when personId is given). */
  deletePushSubscription(endpoint: string, personId: string | null): Promise<void>;
  /** Newest first: errors after an error id, scoped to the owner's agents and to non-agent scopes. */
  errorsAfter(ownerId: string, afterId: number, limit: number): Promise<LoggedError[]>;
  // peer Kenaznia messages
  /** Queues an outbound message for the relay. */
  createPeerOutbound(m: { id?: string; ownerId: string; peerId: string; fromAgent: string; toAgent: string | null; text: string; originConversationId: string | null }): Promise<PeerMessage>;
  /** The origin chat of the newest message `agentId` wrote to the peer; null when none or written from its own chat. */
  peerConversationOrigin(ownerId: string, peerId: string, agentId: string): Promise<string | null>;
  /** Stores an inbound message once per id; null when that id was already received. */
  receivePeerInbound(m: { id: string; ownerId: string; peerId: string; fromAgent: string; toAgent: string | null; text: string; createdAt: number }): Promise<PeerMessage | null>;
  /** Fetch an already received inbound message by its owner and id. */
  getPeerInbound(ownerId: string, id: string): Promise<PeerMessage | null>;
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
  /** What of a person's waits behind their Kenaznia's turn elsewhere, as last published through toPerson. */
  waiting(personId: string): Waiting | null;
  /** Send to one person (all their open streams). */
  toPerson(personId: string, event: ServerEvent): void;
  subscribe(personId: string, send: (event: ServerEvent) => void): () => void;
  /** Sees every event sent to any person (the link forwards shared-chat events to members homed on the other channel). */
  tap(listener: (personId: string, event: ServerEvent) => void): () => void;
  /** Call when membership changes so the member cache is refreshed. */
  invalidateMembers(conversationId: string): void;
}

// ---------------- Agent runtime (server/agents/) ----------------
/** channel: a message from a channel (a Kenan shared chat, Signal, Discord, mail, texts) that reached the Kenaznia
 *  straight (server/channels/inbound.ts); someone is waiting on an answer, which goes out with send. */
export type InputKind = 'human' | 'report' | 'note' | 'heartbeat' | 'agent' | 'room' | 'channel' | 'external' | 'restart' | 'wake';
export interface AgentInput {
  /** Globally unique delivery identity, permanently remembered after the input is consumed. */
  deliveryKey?: string;
  agentId: string;
  kind: InputKind;
  text: string;
  fromId: string;                   // person id (human or agent) or 'system'
  conversationId: string;           // conversation the input belongs to (agent's own chat or a room)
  humanMessageId?: string;          // for latency marks
  fileIds?: string[];
  /** A person is waiting on a live voice or phone line for this request's spoken reply. */
  live?: { delegationId: string };
  /** Set for a person on the Organized layout (server/agents/origin.ts): the answer belongs to this input's chat, so it
   * never shares a turn with input from another chat. */
  chatBound?: true;
  /** Told to the agent with the input (not shown): which chat its answer appears in and why. */
  where?: string;
  /** Told to the agent with a human message (not shown): the screen she sent it from, e.g. "To-do, By urgency". */
  seenFrom?: string;
  /** Told to the agent with a human message (not shown): the chat it was typed in and, for a short reply, the end of the
   * agent's last message there (server/agents/chat-context.ts). */
  chat?: { id: string; title: string; own: boolean; answers?: string };
  /** A restart that cut a turn off in a model call, with no tool call outstanding: the same call is sent again instead of a prompt. */
  resume?: 'model_call';
  /** The wake whose firing this input delivers: one firing reaches the agent once, however it is queued, batched or redelivered. */
  firingId?: string;
  /** Delivers a wake the server opened for a failure addressed to a worker that had none waiting (wakes.ts unheard): it
   * neither withdraws a report the worker already filed nor makes a turn that read only such wakes owe one. */
  unheard?: true;
}
/** A stored input and when it first arrived (ms). */
export type StoredInput = { id: string; input: AgentInput; at: number };
export interface StoredFile { id: string; ownerId: string; name: string; mime: string; size: number; path: string }

/** The chat a turn answers, recorded when it starts so a restart resumes it there. */
export type TurnChat = { conversationId: string; chatBound: boolean };
/** turn null: cut off before turns recorded their chat. */
export type Interrupted = { id: string; turn: TurnChat | null };
/** What a worker's done report would go out without: fired wakes (by firing id) and messages from whoever assigns its work (by sender id). `next` reach it at its next model call, `later` only start its next turn. */
export interface UnreadFirings { next: string[]; later: string[]; assigned: { next: string[]; later: string[] } }
export interface AgentTurn { startedAt: number; conversationId: string; chatBound: boolean; inputs: Pick<AgentInput, 'kind' | 'fromId' | 'text'>[]; queued: number }
export type Delivery = { ok: true } | { ok: false; error: 'input_not_stored'; detail: string };
export interface Runtime {
  start(): Promise<void>;           // create managers, resume interrupted turns and retained inputs, schedule heartbeats from the persisted previous one
  shutdown(): Promise<void>;
  /** Called by HTTP after a human message is admitted. Routes to the agent(s) in that conversation. */
  /** seenFrom: the screen she sent it from (quick panel), or null. */
  onHumanMessage(message: Message, conversation: ConversationSummary, seenFrom: string | null): void;
  /** Deliver any input to a specific agent (used by tools, rooms, extensions). Never blocks on the model. Resolves once
   * the input is stored durably (it survives restarts and crashes from then on); never rejects. */
  deliver(input: AgentInput): Promise<Delivery>;
  stop(conversationId: string): Promise<void>;
  /** Stop active consumers, scrub their retained inputs and transcripts, and resume from the rewritten history. */
  rewriteMessageCopies(message: Message, replacement: string, commit?: () => Promise<void>): Promise<void>;
  archiveAgent(id: string, archived: boolean): Promise<AgentInfo>;
  /** Owner's manager agent id, if any. */
  managerFor(ownerId: string): string | null;
  /** The turn an agent is running now (when it started, the inputs it answers, how many wait behind it), or null between turns. */
  turnOf(agentId: string): AgentTurn | null;
  /** Called as a worker's done report is checked: the wake firings, and messages from `assigners` (its parent and its person's manager), it would leave unread. New work that joins its turn after this withdraws the report when the turn ends. */
  reportBasis(agentId: string, assigners: readonly string[]): UnreadFirings;
  /** Wake firings and assignments that joined the worker's running turn after its done report was checked: they withdraw that report, so a follow-up report may replace it. */
  lateReportWork(agentId: string, assigners: readonly string[]): string[];
}

// ---------------- Tools & extensions ----------------
/**
 * How a call touches the owner's files and the person's records (goals, workers, wakes, rooms), which orders it against
 * the other calls of its turn (server/tools/order.ts), separately for each: `writes` (creates, changes or runs anything)
 * starts after every earlier `reads`/`writes` call, `reads` after every earlier `writes` call, `none` at once.
 * streamArgs sees a call's arguments as the model writes them, before the call is complete and executed.
 */
export type Access = 'reads' | 'writes' | 'none';
export type KenanTool = ToolDefinition<any> & { files: Access; records: Access; parallelRecords?(args: any): string | undefined; streamArgs?(callId: string, args: Record<string, unknown>): void };
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
  /** Whether this person has the extension's tool and routes; default: their extensions list has its id. */
  enabled?(person: PersonConfig): boolean;
  /** Appended to the system prompt of agents that get the tool: one text for every role, or one per role. */
  promptSnippet?: string | Partial<Record<'manager' | 'worker', string>>;
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
  /** The agent's unfinished kenan-bg and gpurun jobs. */
  jobs: (agentId: string) => Promise<import('./agents/pending-work.js').RunningJob[]>;
  person(id: string): PersonConfig | undefined;
  now(): number;
}

/** One account's meter reading from one broker poll at `at`; readingAt is when the broker read the meter. */
/** Summed prompt tokens and cost of some model calls (Store.cacheGroups). */
export interface CacheGroup { agentId: string; model: string; period: 0 | 1 | 2; tier: number; calls: number; input: number; cacheRead: number; cacheWrite: number; costUsd: number }
export interface UsageSample {
  provider: string; metric: string; account: string;
  percentLeft: number | null; resetAt: number | null; windowHours: number | null; readingAt: number; at: number;
}
/** Goal notes are a dated log, newest first: `prepend` adds one entry at the top (stamped by `datedNote`); `replace`
 *  rewrites the whole field and is only ever an explicit request. */
export type NotesChange = { kind: 'prepend'; entry: string } | { kind: 'replace'; text: string };
