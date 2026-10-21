// Kenan Stack client/server contract. Shared by server/ and web/. Owned by lead.
// All HTTP responses are Result<T>. All timestamps are epoch milliseconds.

export type Result<T> = { ok: true; value: T } | { ok: false; error: AppError };
export interface AppError { code: ErrorCode; message: string }
export type ErrorCode = 'invalid_input' | 'unauthenticated' | 'forbidden' | 'not_found' | 'conflict' | 'unavailable' | 'internal';
export const errorStatus: Record<ErrorCode, number> = {
  invalid_input: 400, unauthenticated: 401, forbidden: 403, not_found: 404, conflict: 409, unavailable: 503, internal: 500,
};

// ---------- people ----------
export type PersonKind = 'human' | 'agent';
export interface Person { id: string; name: string; kind: PersonKind }
/** Agents are people too. An agent person has an owner (the human whose space it works in). */
export interface AgentInfo extends Person {
  kind: 'agent';
  ownerId: string;
  parentAgentId: string | null;
  archived: boolean;
  role: 'manager' | 'worker';
  conversationId: string;          // the agent's own chat
  goalId: string | null;
  state: AgentState;
  model: string;
  thinking?: 'off'|'minimal'|'low'|'medium'|'high'|'xhigh'|'max' | null;          // null preserves the owner profile default
  createdAt: number;
  updatedAt: number;
  /** `handed_off`: a worker whose long wait moved to its manager as a held trigger (server/agents/wakes.ts); it ends archived like `done`. */
  lastReport: { status: 'done' | 'blocked' | 'handed_off'; text: string; at: number } | null;
  /** The agent's pending self-scheduled wakes, soonest deadline first. */
  wakes: AgentWake[];
}
/** A pending wake as the app shows it: a deadline, an event source, or both (whichever comes first). `on: null` is a clock wake;
 * a wake that listens only for what is addressed to its agent shows `any`. `since`: when it was scheduled. `goalId`: set on a
 * trigger a manager holds for a goal (a worker's handed-off wait), null on an agent's own wake. */
export type AgentWake = ({ at: number; on: WakeSource | null } | { at: null; on: WakeSource }) & { since: number; goalId: string | null };
export type WakeSource = 'mail' | 'signal' | 'text' | 'event' | 'any';
export type AgentState = 'idle' | 'running' | 'stopped' | 'interrupted' | 'error';

// ---------- conversations & rooms ----------
/** A room is a conversation with more than two members; there is no separate type. */
export interface ConversationSummary {
  id: string;
  title: string;
  ownerId: string;                 // human whose space it lives in
  memberIds: string[];             // humans and agents
  agentId: string | null;          // the agent whose own chat this is (null for plain rooms)
  archived: boolean;
  color: string | null;
  /** Organized layout topic fields: an emoji, a pin (when) with an optional key date (YYYY-MM-DD) and its label ("Due"),
   *  and whether a person set the title herself (then nothing renames it automatically). */
  emoji: string | null;
  pinnedAt: number | null;
  keyDate: string | null;
  keyLabel: string | null;
  titleLocked: boolean;
  /** A project page: its status line, and the rooms grouped under it (their projectId). */
  project: boolean;
  statusLine: string | null;
  projectId: string | null;
  lastSeq: number;
  readThrough: number;             // for the requesting person
  /** The newest previewable message; it is unread when its seq is past readThrough. */
  lastMessage: { authorId: string; preview: string; at: number; seq: number } | null;
  updatedAt: number;
}
export const unread = (c: Pick<ConversationSummary, 'lastMessage' | 'readThrough'>): boolean => !!c.lastMessage && c.lastMessage.seq > c.readThrough;
/** What a conversation's agent run is doing right now; a conversation with no run has no Activity. */
export interface Activity { state: 'thinking' | 'tool' | 'streaming'; label: string | null; since: number }

export type MessageRole = 'human' | 'assistant' | 'tool' | 'notice';
/**
 * What a notice is. Background notices record an agent's inputs that came from no person (a worker's note or report to
 * its launcher, a peer Kenaznia's message, a fired wake, a heartbeat, a restart or refusal notice, notices imported with
 * history from another system); a worker's report in its own chat, an agent error and meeting captions are shown.
 */
export type NoticeKind = 'worker_note' | 'worker_report' | 'peer_message' | 'wake' | 'heartbeat' | 'system' | 'report' | 'agent_error' | 'meeting_caption' | 'imported';
export const NOTICE_DISPLAY: Record<NoticeKind, 'shown' | 'background'> = {
  worker_note: 'background', worker_report: 'background', peer_message: 'background', wake: 'background', heartbeat: 'background', system: 'background', imported: 'background',
  report: 'shown', agent_error: 'shown', meeting_caption: 'shown',
};
export const BACKGROUND_NOTICES = (Object.keys(NOTICE_DISPLAY) as NoticeKind[]).filter(kind => NOTICE_DISPLAY[kind] === 'background');
/**
 * How the app draws a message. shown: in the chat. background: folded into a collapsed run of background updates (inputs
 * from no person, and a manager's work on them). silent: never drawn and never previewed (an agent's NO_REPLY answer),
 * kept for the record. Human messages and notices take theirs from their kind; the runtime sets an agent message's.
 */
export type MessageDisplay = 'shown' | 'background' | 'silent';
/** An agent whose whole answer is this says nothing to the person: the message is stored as `silent`. */
export const NO_REPLY = 'NO_REPLY';
export const isNoReply = (text: string): boolean => text.trim() === NO_REPLY;
/** Text that may still become NO_REPLY is held back from streaming until it can't. */
export const mayBeNoReply = (text: string): boolean => NO_REPLY.startsWith(text.trimStart()) || isNoReply(text);
/** A message's role and, for notices only, its kind. */
export type MessageKind = { role: Exclude<MessageRole, 'notice'>; notice: null } | { role: 'notice'; notice: NoticeKind };
/** What a conversation's preview and unread mark count: shown words or files, not tool cards, thinking or empty streaming starts. store.ts PREVIEWABLE is the same predicate in SQL. */
export const previewable = (m: Pick<Message, 'display' | 'role' | 'text' | 'parts'>): boolean =>
  m.display === 'shown' && m.role !== 'tool' && (m.text.trim() !== '' || m.parts.some(p => p.type === 'file' || p.type === 'image'));
export type Message = MessageKind & {
  id: string;
  display: MessageDisplay;
  conversationId: string;
  seq: number;
  authorId: string;
  text: string;                    // full text so far (streaming messages grow)
  parts: MessagePart[];            // structured content (tool calls, images, thinking) — optional detail
  state: 'streaming' | 'done' | 'error' | 'stopped';
  clientId: string | null;         // client-generated id for human sends (idempotency)
  createdAt: number;
  updatedAt: number;
  /** True when long strings or lists were shortened for transport; `GET .../messages/:messageId` returns the full message. */
  clipped: boolean;
};
/** A contiguous run of a conversation's messages, oldest first. */
export interface MessagePage { messages: Message[]; hasOlder: boolean; hasNewer: boolean }
/** Only authenticated final-caption admission writes this provenance; never infer it from chat text. */
export interface MeetingCaptionProvenance {
  version: 1; sessionId: string; providerSessionId: string; eventId: string; ownerId: string;
  conversationId: string; at: number; speaker: string | null; speakerId: string | null;
  source: { channel: 'beta' | 'production'; eventKey: string; fingerprint: string; organizerEmail: string; startAt: string; endAt: string } | null;
}
export type MessagePart =
  | { type: 'text'; text: string; meetingCaption?: MeetingCaptionProvenance }
  | { type: 'thinking'; text: string }
  | { type: 'tool'; callId: string; name: string; args: unknown; result: string | null; isError: boolean }
  | { type: 'image'; fileId: string; mime: string }
  | { type: 'file'; fileId: string; name: string; mime: string; size: number };

export interface Goal {
  id: string;
  ownerId: string;
  title: string;
  detail: string;
  status: 'open' | 'done' | 'dropped';
  priority: number;                // lower = more important
  workerIds: string[];
  notes: string;
  createdAt: number;
  updatedAt: number;
}

/** What the sidebar shows of a goal; the goals page loads whole goals from GET /api/goals. */
export type GoalSummary = Pick<Goal, 'id' | 'title' | 'status'>;

export interface FileInfo { id: string; name: string; mime: string; size: number; url: string }

// ---------- HTTP API ----------
// Non-GET requests must send Origin matching a configured origin, or header `x-kenan-client: native`.
// Auth cookie: `kenan_session` (HttpOnly, Secure, SameSite=Lax, 30 days).
export interface Api {
  'GET /api/accounts': { res: Person[] };                                  // humans that can log in
  'POST /api/login': { req: { accountId: string; secret: string }; res: Bootstrap };
  'POST /api/logout': { req: Record<string, never>; res: null };
  'GET /api/bootstrap': { query: { includeArchived?: boolean }; res: Bootstrap };
  'PATCH /api/agents/:id': { req: { archived: boolean }; res: AgentInfo };
  // Newest page by default; `before` pages toward older seqs, `after` toward newer ones (never both).
  'GET /api/conversations/:id/messages': { query: { before?: number; after?: number; limit?: number }; res: MessagePage };
  'GET /api/conversations/:id/messages/:messageId': { res: Message };   // unclipped
  'POST /api/conversations': { req: { title: string; memberIds: string[] }; res: ConversationSummary };
  'PATCH /api/conversations/:id': { req: ConversationPatch; res: ConversationSummary };
  'PUT /api/layout': { req: { layout: Layout }; res: Layout };
  'POST /api/conversations/:id/messages': { req: SendRequest; res: Message };
  'POST /api/conversations/:id/stop': { req: Record<string, never>; res: null };
  'POST /api/files': { req: FormData /* field `file` */; res: FileInfo };
  'GET /api/files/:id': { query: { download?: '1' }; res: Blob };   // the owner's files and files shown in their conversations; download=1 saves instead of opening
  'GET /api/goals': { res: Goal[] };
  'GET /api/agents': { query: { includeArchived?: boolean }; res: AgentInfo[] };
  'GET /api/usage': { res: UsageReport };
  'GET /api/metrics': { res: LatencyReport };
  'POST /api/metrics/first-text': { req: { messageId: string; firstTextAt: number }; res: null };
  // `open`: the conversation to start on (the Kenaznia conversation when absent or not available); `limit`: its page size.
  // Web Push for installed web apps (iPhone home-screen app): the VAPID key to subscribe with, then register/remove the device.
  // confirm: send that device a confirmation notification now; `test` says whether its push service took it (null without confirm).
  // The app re-registers its subscription without confirm on every open, so a device the server lost comes back.
  'GET /api/push': { res: { publicKey: string } };
  'POST /api/push/subscriptions': { req: { subscription: WebPushSubscription; confirm: boolean }; res: { test: WebPushTest | null } };
  'DELETE /api/push/subscriptions': { req: { endpoint: string }; res: null };
  'GET /api/events': { query: { open?: string; limit?: number }; res: 'text/event-stream' };
}
/** The app's layout, chosen per person (PUT /api/layout). Classic is the original sidebar app. */
export const LAYOUTS = ['classic', 'organized'] as const;
export type Layout = typeof LAYOUTS[number];
export const TODO_LEVELS = ['today', 'week', 'someday'] as const;
export type TodoLevel = typeof TODO_LEVELS[number];
/** One to-do item (extension `organized`). doneAt/deletedAt null = open/present; dueAt epoch ms or null. */
export interface Todo {
  id: string; text: string; level: TodoLevel; tag: string | null; dueAt: number | null; remind: boolean;
  position: number; conversationId: string | null; doneAt: number | null; deletedAt: number | null; createdAt: number; updatedAt: number;
}
/** A title given here is the person's own: it locks the title unless titleLocked says otherwise. pinned true pins now. */
export interface ConversationPatch {
  title?: string; titleLocked?: boolean; archived?: boolean; color?: string | null; readThrough?: number; addMemberIds?: string[]; removeMemberIds?: string[];
  emoji?: string | null; pinned?: boolean; keyDate?: string | null; keyLabel?: string | null;
  project?: boolean; statusLine?: string | null; projectId?: string | null;
}
export interface SendRequest { clientId: string; text: string; fileIds: string[]; clientSentAt: number }

/** Where the person's Kenaznia answers: in a conversation here, in the app at another URL (the other channel), or nowhere (workers only). */
export type ManagerHome = { kind: 'here'; conversationId: string } | { kind: 'elsewhere'; url: string } | { kind: 'none' };
export interface Bootstrap {
  me: Person;
  people: Person[];                // everyone visible (humans + agents in my space + room members)
  agents: AgentInfo[];             // agents owned by me
  goals: GoalSummary[];            // the goals of `agents`
  conversations: ConversationSummary[];   // non-archived, most recent first (archived via ?archived=1 later)
  activity: Record<string, Activity>;     // live runs among `conversations`, by conversation id; absent = no run
  manager: ManagerHome;
  layout: Layout;
  extensions: { id: string; name: string }[];
  serverTime: number;
  channel: 'beta' | 'production';
}

// ---------- SSE /api/events ----------
// One stream per client, compressed (br/gzip) and flushed per event. Events (event name → data JSON);
// `id:` is a monotonically increasing per-process counter. The first event is `ready`: the startup
// snapshot, taken after the stream subscribed, so every later change arrives as an event. A reconnect
// gets a fresh `ready`. Without a valid session the only event is `unauthenticated`.
export type ServerEvent =
  | { type: 'message'; message: Message }                                   // created or replaced (clipped like history pages)
  | { type: 'delta'; conversationId: string; messageId: string; text: string }   // append to message.text
  | { type: 'conversation'; conversation: ConversationSummary }
  | { type: 'activity'; conversationId: string; activity: Activity | null }   // null: the run ended
  | { type: 'agent'; agent: AgentInfo }
  | { type: 'goal'; goal: Goal }
  | { type: 'todo'; todo: Todo }                                            // created or changed (deletedAt set: removed)
  | { type: 'layout'; layout: Layout }
  | { type: 'notification'; notification: PhoneNotification }              // only on GET /api/notifications
  | { type: 'heartbeat'; at: number };                                      // every 15 s
export const SSE_HEARTBEAT_MS = 15_000;
/** The newest page of the conversation a stream opened on. */
export interface StartupPage { conversationId: string; page: MessagePage }
export type StreamEvent =
  | Exclude<ServerEvent, { type: 'notification' }>
  | { type: 'ready'; bootstrap: Bootstrap; page: StartupPage | null }
  | { type: 'unauthenticated' };

// ---------- phone notifications ----------
/** normal: an ordinary heads-up notification. urgent: rings on the alarm stream through silent mode and Do Not Disturb. */
export type NotificationLevel = 'normal' | 'urgent';
/** A browser's Web Push subscription (PushSubscription.toJSON()): where to send and the keys to encrypt for. */
export interface WebPushSubscription { endpoint: string; keys: { p256dh: string; auth: string } }
/** What subscribing reports: the confirmation push sent to that device, and whether its push service accepted it. */
export type WebPushTest = { kind: 'delivered' } | { kind: 'rejected'; status: number; reason: string } | { kind: 'unreachable'; reason: string } | { kind: 'gone'; status: number };
export interface PhoneNotification { id: number; title: string; body: string; level: NotificationLevel; imageFileId: string | null; agentId: string; conversationId: string; createdAt: number }

// ---------- usage & metrics ----------
export interface UsageReport {
  observedAt: number;
  plans: UsagePlan[];
  /** Totals over every agent of the person, finished runs included; byAgent is the day's biggest spenders, most first. */
  spend: { lastHourUsd: number; lastDayUsd: number; byAgent: { agentId: string; archived: boolean; lastDayUsd: number }[] };
  /** Each swarm with spend in the last day: its coordinator, sub-agent counts and what the coordinator and its sub-agents cost (API-rate USD, the quota proxy). */
  swarms: { coordinatorId: string; name: string; subAgents: { total: number; active: number; running: number; done: number; blocked: number }; lastDayUsd: { coordinator: number; subAgents: number } }[];
}
/** A subscription pool's meter, modelled from each account's own share, drain and reset. */
export interface UsagePlan {
  provider: 'anthropic' | 'openai';
  metric: string;                  // e.g. five-hour, weekly
  percentLeft: number | null;      // pool share left: the accounts' remaining shares over their count
  projection: PoolProjection;
  accounts: UsageAccount[];
}
/**
 * stale: no account has a fresh reading (idle accounts, or failed polls), so there is no current drain.
 * unmeasured: fresh readings, but no account has enough of them in this window to measure a drain yet.
 * projected: the measured accounts' drains summed over the account count; exhaustionAt is when no account has quota left at
 * that drain, each resetting on its own schedule (null: not within 8 days). Accounts in unknownDrain still have quota but no
 * current drain (stale or unmeasured); their last share counts as capacity, so the projection is certain only when it is empty.
 */
export type PoolProjection =
  | { state: 'stale'; latestReadingAt: number }
  | { state: 'unmeasured' }
  | { state: 'projected'; drainPercentPerHour: number; exhaustionAt: number | null; unknownDrain: string[] };
export interface UsageAccount {
  accountId: string;
  percentLeft: number | null;      // as read, or 100 once its window has reset since
  readingAt: number;
  resetAt: number | null;          // its own next reset
  drain: AccountDrain;
  projectedExhaustionAt: number | null;    // at its measured drain; null when it resets first, is not draining or drain is not measured
}
/**
 * measured: decreases only (a reset is not negative drain) over at least 30 minutes of readings from the last 3 hours, the latest fresh.
 * stale: its latest reading is over 15 minutes old, so its current drain is unknown. unmeasured: fresh, but too few readings yet.
 */
export type AccountDrain =
  | { state: 'measured'; percentPerHour: number }
  | { state: 'stale'; readingAt: number }
  | { state: 'unmeasured' };
export interface LatencyReport {
  windowMs: number;
  count: number;
  intervals: Record<'receiveToAdmit' | 'admitToModelRequest' | 'admitToFirstToken' | 'admitToFirstText' | 'clientToAdmit', Percentiles>;
}
export interface Percentiles { p50: number | null; p90: number | null; p99: number | null; max: number | null }
