// Kenan Stack client/server contract. Shared by server/ and web/. Owned by lead.
// All HTTP responses are Result<T>. All timestamps are epoch milliseconds.

export type Result<T> = { ok: true; value: T } | { ok: false; error: AppError };
export interface AppError { code: ErrorCode; message: string }
export type ErrorCode = 'invalid_input' | 'unauthenticated' | 'forbidden' | 'not_found' | 'conflict' | 'unavailable' | 'internal';
export const errorStatus: Record<ErrorCode, number> = {
  invalid_input: 400, unauthenticated: 401, forbidden: 403, not_found: 404, conflict: 409, unavailable: 503, internal: 500,
};

import type { Device, ZoneReport } from './zone.js';

// ---------- people ----------
export type PersonKind = 'human' | 'agent';
export type GoalCategory = 'work' | 'upkeep';
export interface Person { id: string; name: string; kind: PersonKind }
/** Agents are people too. An agent person has an owner (the human whose space it works in). */
export interface AgentInfo extends Person {
  kind: 'agent';
  ownerId: string;
  parentAgentId: string | null;
  archived: boolean;
  /** `blank`: a temporary chat the person opened with a model of their choice and no context (server/agents/blank.ts). */
  role: 'manager' | 'worker' | 'blank';
  conversationId: string;          // the agent's own chat
  goalId: string | null;
  /** Inherited from the goal at read time; managers and agents without a goal are work. */
  category?: GoalCategory;
  state: AgentState;
  model: string;
  thinking?: 'off'|'minimal'|'low'|'medium'|'high'|'xhigh'|'max' | null;          // null preserves the owner profile default
  /** How fast its model calls run (server/agents/speed.ts): fast and ultrafast are Codex service tiers that use more quota. */
  speed: 'normal' | 'fast' | 'ultrafast';
  createdAt: number;
  updatedAt: number;
  /** `handed_off`: a worker whose long wait moved to its manager as a held trigger (server/agents/wakes.ts); it ends archived like `done`. */
  lastReport: { status: 'done' | 'blocked' | 'handed_off'; text: string; at: number } | null;
  /** The chat whose turn launched or last instructed this worker (server/agents/origin.ts); null: its launcher's own chat. */
  originConversationId: string | null;
  /** The agent's pending self-scheduled wakes, soonest deadline first. */
  wakes: AgentWake[];
  /** Alive jobs owned by this agent; presentation only, never changes its run state. */
  runningJobs?: { name: string; topic: string; kind: 'kenan-bg' | 'gpurun' }[];
}
/** A pending wake as the app shows it: a deadline, an event source, or both (whichever comes first). `on: null` is a clock wake;
 * a wake that listens only for what is addressed to its agent shows `any`. `since`: when it was scheduled. `goalId`: set on a
 * trigger a manager holds for a goal (a worker's handed-off wait), null on an agent's own wake. */
export type AgentWake = ({ at: number; on: WakeSource | null } | { at: null; on: WakeSource }) & { since: number; goalId: string | null; event?: { topic: string; prefix: boolean } | null };
export type WakeSource = 'mail' | 'signal' | 'text' | 'event' | 'any';
export type AgentState = 'idle' | 'running' | 'stopped' | 'interrupted' | 'error';

/** A model a blank chat can run on: what the subscription route serves now, with its thinking levels. */
export interface BlankModel { model: string; name: string; thinking: string[] }

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
  /** The reader's own colours for people's messages here (person id → one of shared/colors.ts MEMBER_COLORS); none set: {}. */
  memberColors: Record<string, string>;
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
  /** The reader's own chat group for it (per person: a shared room sits in each member's own group), or none. */
  groupId: string | null;
  lastSeq: number;
  readThrough: number;             // for the requesting person
  /** The newest previewable message; it is unread when its seq is past readThrough. */
  lastMessage: { authorId: string; preview: string; at: number; seq: number } | null;
  updatedAt: number;
}
export const unread = (c: Pick<ConversationSummary, 'lastMessage' | 'readThrough'>): boolean => !!c.lastMessage && c.lastMessage.seq > c.readThrough;
/** A Markdown link to a chat, which the app shows as a chip that opens it: [🎨 App Redesign](chat:<id>). */
export const chatLink = (c: Pick<ConversationSummary, 'id' | 'title' | 'emoji'>): string =>
  `[${`${c.emoji ? `${c.emoji} ` : ''}${c.title}`.replace(/[\\[\]]/g, m => `\\${m}`)}](chat:${c.id})`;
/** What a conversation's agent run is doing right now; a conversation with no run has no Activity. */
export interface Activity { state: 'thinking' | 'tool' | 'streaming'; label: string | null; since: number }

export type MessageRole = 'human' | 'assistant' | 'tool' | 'notice';
/**
 * What a notice is. Background notices record an agent's inputs that came from no person (a message arriving from a channel: texts, Signal, Discord, mail, a shared chat or the watcher's note; a worker's note or report to
 * its launcher, a peer Kenaznia's message, a fired wake, a heartbeat, a restart or refusal notice, notices imported with
 * history from another system); messages to workers, a worker's report in its own chat, an agent error and meeting captions are shown.
 */
export type NoticeKind = 'agent_message' | 'worker_note' | 'worker_report' | 'peer_message' | 'wake' | 'heartbeat' | 'system' | 'report' | 'agent_error' | 'meeting_caption' | 'imported' | 'channel' | 'membership';
export const NOTICE_DISPLAY: Record<NoticeKind, 'shown' | 'background'> = {
  worker_note: 'background', worker_report: 'background', peer_message: 'background', wake: 'background', heartbeat: 'background', system: 'background', imported: 'background', channel: 'background',
  agent_message: 'shown', membership: 'shown', report: 'shown', agent_error: 'shown', meeting_caption: 'shown',
};
export const BACKGROUND_NOTICES = (Object.keys(NOTICE_DISPLAY) as NoticeKind[]).filter(kind => NOTICE_DISPLAY[kind] === 'background');
/**
 * How the app draws a message. shown: in the chat. background: folded into compact expandable update rows (inputs
 * from no person, and a manager's work on them). silent: never drawn and never previewed (an agent's NO_REPLY answer),
 * kept for the record. Human messages and notices take theirs from their kind; the runtime sets an agent message's.
 */
export type MessageDisplay = 'shown' | 'background' | 'silent';
/** An agent whose whole answer is this says nothing to the person: the message is stored as `silent`. */
export const NO_REPLY = 'NO_REPLY';
export const isNoReply = (text: string): boolean => text.trim() === NO_REPLY;
/** The last non-blank line is NO_REPLY by itself: a model that wrote words and then closed with the token. */
export const endsWithNoReply = (text: string): boolean => text.trimEnd().split('\n').at(-1)!.trim() === NO_REPLY;
/** The text without the token, for a reply that is shown to a person. */
export const stripNoReply = (text: string): string => text.includes(NO_REPLY) ? text.split(NO_REPLY).join('').replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim() : text;
/** Text that may still become NO_REPLY is held back from streaming until it can't. */
export const mayBeNoReply = (text: string): boolean => NO_REPLY.startsWith(text.trimStart()) || isNoReply(text);
/**
 * Background blocks in an agent's reply: a line starting with `::bg` begins text the app folds into the collapsed
 * background rows (shown when expanded, never notified or previewed), up to a line starting with `::end` or the end of
 * the message; text after either marker on its line belongs to the new part. Markers inside ``` code fences are text.
 */
export const BG_START = '::bg';
export const BG_END = '::end';
export type TextPiece = { text: string; background: boolean };
const markerAt = (line: string, marker: string): string | null => {
  const t = line.trimStart();
  return t === marker || t.startsWith(`${marker} `) || t.startsWith(`${marker}\t`) ? t.slice(marker.length).trimStart() : null;
};
/** The reply as its shown and background parts in order, blank parts dropped; a reply without markers is one shown part, unchanged. */
export function backgroundPieces(text: string): TextPiece[] {
  const pieces: TextPiece[] = [];
  let background = false, fenced = false, marked = false, lines: string[] = [];
  const flush = () => { const body = lines.join('\n').replace(/^(?:[ \t]*\n)+/, '').trimEnd(); if (body) pieces.push({ text: body, background }); lines = []; };
  for (const line of text.split('\n')) {
    if (line.trimStart().startsWith('```')) fenced = !fenced;
    const rest = fenced ? null : markerAt(line, background ? BG_END : BG_START);
    const stray = fenced || rest !== null ? null : markerAt(line, background ? BG_START : BG_END);
    if (rest !== null) { flush(); background = !background; marked = true; if (rest) lines.push(rest); }
    // Repeated or unmatched markers still break the source slice, even when the display mode stays the same.
    else if (stray !== null) { flush(); marked = true; if (stray) lines.push(stray); }
    else lines.push(line);
  }
  if (!marked) return text ? [{ text, background: false }] : [];
  flush();
  return pieces;
}
/** What of a reply that is still streaming is shown: its shown parts, holding back a last line that may still become a marker. */
export function shownWhileStreaming(text: string): string {
  const cut = text.lastIndexOf('\n') + 1;
  const tail = text.slice(cut).trimStart();
  const pending = tail !== '' && (BG_START.startsWith(tail) || BG_END.startsWith(tail));
  const pieces = backgroundPieces(pending ? text.slice(0, cut) : text);
  return pieces.some(p => p.background) || pending ? pieces.filter(p => !p.background).map(p => p.text).join('\n\n') : text;
}
/** A message's role and, for notices only, its kind. */
export type MessageKind = { role: Exclude<MessageRole, 'notice'>; notice: null } | { role: 'notice'; notice: NoticeKind };
/** A message preview as plain words for one-line lists: markdown markers (bold, code, headings, quotes, list bullets, link targets) removed. */
export const plainPreview = (text: string): string => text
  .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
  .replace(/(\*\*|__|~~|`+)/g, '')
  .replace(/(^|\s)[*_]([^*_\s][^*_]*?)[*_](?=[\s.,;:!?)]|$)/g, '$1$2')
  .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, '')
  .replace(/\s+/g, ' ').trim();
/** What a conversation's preview and unread mark count: shown words or files, not tool cards, thinking or empty streaming starts. store.ts PREVIEWABLE is the same predicate in SQL. */
export const previewable = (m: Pick<Message, 'display' | 'role' | 'text' | 'parts'>): boolean =>
  m.display === 'shown' && m.role !== 'tool' && (m.text.trim() !== '' || m.parts.some(p => p.type === 'file' || p.type === 'image'));
export type Message = MessageKind & {
  id: string;
  display: MessageDisplay;
  conversationId: string;
  seq: number;
  authorId: string;
  authorName?: string;
  /** Generated once when a background input arrives; retained even when the model is unavailable. */
  backgroundSummary?: string;
  text: string;                    // full text so far (streaming messages grow)
  parts: MessagePart[];            // content in production order, including text; text above is its aggregate for previews and copying
  state: 'streaming' | 'done' | 'error' | 'stopped';
  clientId: string | null;         // client-generated id for human sends (idempotency)
  createdAt: number;
  updatedAt: number;
  editedAt?: number | null;
  deletedAt?: number | null;
  /** True when long strings or lists were shortened for transport; `GET .../messages/:messageId` returns the full message. */
  clipped: boolean;
};
/** Closed chat cards and new worker/goal titles share this character budget. */
export const CARD_LINE_MAX = 32;
/** Keep whole words where possible, with no ellipsis; full text stays in the opened card. */
export function shortCardLine(value: string): string {
  const text = value.replace(/…|\.{3}/g, '').replace(/\s+/g, ' ').trim();
  if (text.length <= CARD_LINE_MAX) return text;
  const boundary = text.slice(0, CARD_LINE_MAX + 1).lastIndexOf(' ');
  return text.slice(0, boundary > 0 ? boundary : CARD_LINE_MAX).replace(/[\s:—-]+$/, '');
}
type BackgroundInput = Pick<Message, 'authorId' | 'authorName' | 'text'> & { notice?: NoticeKind | null };
/** The source is separate from the news, so delivery prefixes never become a chain of colons. */
export function backgroundSource(message: BackgroundInput, senderName?: string): string {
  const peer = message.text.match(/^Message from ([^\n]+?):\s/);
  if (peer) return peer[1]!.replace(/:+$/, '').trim();
  if (message.notice === 'worker_note' || message.notice === 'worker_report') {
    const worker = senderName ?? message.authorName ?? message.text.match(/^(?:Note from worker |Worker )([^\n]+?)(?: \([0-9a-f-]{36}\)|:\s)/)?.[1] ?? 'Worker';
    const name = worker.split(':')[0]!.trim().replace(/:+$/, '');
    return /worker$/i.test(name) ? name : `${name} worker`;
  }
  return ({ wake: 'Wake', heartbeat: 'Heartbeat', system: 'System', channel: 'Chat message', imported: 'Update' } as Partial<Record<NoticeKind, string>>)[message.notice!]
    ?? senderName ?? message.authorName ?? 'Kenaznia';
}
/** Strip transport headers, not the update itself. The full original remains under the card. */
export function backgroundContent(message: BackgroundInput, senderName?: string): string {
  let text = message.text;
  if (message.notice === 'worker_report') text = text.replace(/^Worker [^\n]* reports (?:done|blocked):\s*/i, '');
  if (message.notice === 'worker_note') {
    const prefix = `Note from worker ${senderName ?? message.authorName ?? ''}:`;
    text = prefix !== 'Note from worker :' && text.startsWith(prefix) ? text.slice(prefix.length).trimStart() : text.replace(/^Note from worker [^:\n]+:\s*/, '');
  }
  return text.replace(/^Message from [^\n]+?:\s*/, '').replace(/^\[?System(?: notice)?\]?:\s*/i, '');
}
/** A short body-only fallback; the sender has its own line on the folded card. */
export function backgroundFallback(message: BackgroundInput, senderName?: string): string {
  const body = plainPreview(backgroundContent(message, senderName)).replace(/^(?:Kenaznia:\s*)+/i, '').replace(/:/g, ' —').trim();
  return shortCardLine(body.split(/\s+/).slice(0, 6).join(' ').replace(/[\s:—-]+$/, '')) || 'No update text';
}
/** A contiguous run of a conversation's messages, oldest first. */
export interface MessagePage { messages: Message[]; hasOlder: boolean; hasNewer: boolean }
/** Search hits carry a direct chat/message link; title and filename hits have no message position. */
export interface SearchItem {
  conversationId: string; conversationTitle: string; messageId: string | null; seq: number | null;
  text: string; snippet: string; createdAt: number; link: string;
}
/** Plain word-AND message search; title and filename matches are literal substrings. Dates are inclusive after, exclusive before. */
export interface SearchQuery { q: string; chat?: string; after?: string | number; before?: string | number; limit?: number }
export interface SearchPage { items: SearchItem[]; unavailable?: string[] }

/** Only authenticated final-caption admission writes this provenance; never infer it from chat text. */
export interface MeetingCaptionProvenance {
  version: 1; sessionId: string; providerSessionId: string; eventId: string; ownerId: string;
  conversationId: string; at: number; speaker: string | null; speakerId: string | null;
  source: { channel: 'beta' | 'production'; eventKey: string; fingerprint: string; organizerEmail: string; startAt: string; endAt: string } | null;
}
export type MessagePart =
  | { type: 'text'; text: string; meetingCaption?: MeetingCaptionProvenance }
  | { type: 'thinking'; text: string }
  /** `draft` only on a call the model is still writing (`tool_draft` events, never stored): its arguments so far, long
   *  strings cut to their end, and their full size (all string characters; lines of the longest string). */
  | { type: 'tool'; callId: string; name: string; args: unknown; result: string | null; isError: boolean; draft?: { chars: number; lines: number } }
  | { type: 'image'; fileId: string; mime: string }
  | { type: 'file'; fileId: string; name: string; mime: string; size: number }
  /** A question card: its state (open, answered, withdrawn) is the to-do todoId's. */
  | { type: 'question'; todoId: string; options: string[] }
  | { type: 'seal'; id: string; topic?: string | null; hash: string; sealedAt: number; reveal: null | { guess: string; salt: string; revealedAt: number; verified: boolean; score: null | 'called' | 'missed' } };
export type ToolPart = Extract<MessagePart, { type: 'tool' }>;

export interface Goal {
  category: GoalCategory;
  id: string;
  ownerId: string;
  title: string;
  detail: string;
  status: 'open' | 'done' | 'dropped';
  priority: number;                // lower = more important
  workerIds: string[];
  notes: string;
  /** The topic chat this goal belongs to (Organized): its work's reports and answers land there; null: where it was asked. */
  chatId: string | null;
  createdAt: number;
  updatedAt: number;
}

/** What the sidebar shows of a goal; the goals page loads whole goals from GET /api/goals. */
export type GoalSummary = Pick<Goal, 'id' | 'title' | 'status' | 'category'>;

export interface FileInfo { id: string; name: string; mime: string; size: number; url: string }
/** `GET /api/files/:id?frame=1` serves an HTML file for the app's viewer (sandboxed, links open outside it). The name
 * changed from `view` when links were added, so a page a browser had cached without them is not reused. */
export const VIEWER_QUERY = 'frame';
/** `GET /api/files/:id/pdf` gives a PDF's page sizes (points, as shown); `GET /api/files/:id/pdf/:page?w=WIDTH` draws one
 * page (1-based) as a JPEG of one of these widths in pixels. */
export const PDF_PAGE_WIDTHS = [480, 960, 1600, 2400] as const;
export type PdfPageWidth = typeof PDF_PAGE_WIDTHS[number];
export interface PdfInfo { pages: { width: number; height: number }[] }
export const pdfFile = (mime: string, name: string): boolean => mime.split(';', 1)[0]!.trim().toLowerCase() === 'application/pdf' || /\.pdf$/i.test(name);

// ---------- HTTP API ----------
// Non-GET requests must send Origin matching a configured origin, or header `x-kenan-client: native`.
// Auth cookie: `kenan_session` (HttpOnly, Secure, SameSite=Lax, 30 days).
export interface Api {
  'GET /api/accounts': { res: Person[] };                                  // humans that can log in
  'POST /api/login': { req: { accountId: string; secret: string }; res: Bootstrap };
  'POST /api/logout': { req: Record<string, never>; res: null };
  'GET /api/bootstrap': { query: { includeArchived?: boolean }; res: Bootstrap };
  'GET /api/references': { query: { ids: string }; res: Record<string, string | null> };
  'PATCH /api/agents/:id': { req: { archived: boolean }; res: AgentInfo };
  /** Blank chats: what can be chosen, and a new one with that model (server/agents/blank.ts). Closing one is PATCH /api/agents/:id. */
  'GET /api/blank-chats/models': { res: BlankModel[] };
  'POST /api/blank-chats': { req: { model: string; thinking: string }; res: { agent: AgentInfo; conversation: ConversationSummary } };
  // Newest page by default; `before` pages toward older seqs, `after` toward newer ones (never both).
  'GET /api/conversations/:id': { res: ConversationSummary };
  'GET /api/search': { query: SearchQuery; res: SearchPage };
  'GET /api/conversations/:id/messages': { query: { before?: number; after?: number; around?: string | number; limit?: number }; res: MessagePage };
  'GET /api/conversations/:id/messages/:messageId': { res: Message };   // unclipped
  'POST /api/conversations/:id/leave': { req: {}; res: { id: string } };
  'POST /api/conversations': { req: { title: string; memberIds: string[] }; res: ConversationSummary };
  'PATCH /api/conversations/:id': { req: ConversationPatch; res: ConversationSummary };
  'PUT /api/layout': { req: { layout: Layout }; res: Layout };
  /** The tray tiles to show, in order (distinct TRAY_TILES); null drops the person's choice back to the configured default. The reply is the tray now in effect. */
  'PUT /api/tray': { req: { tiles: TrayTile[] | null }; res: { tiles: TrayTile[] | null } };
  /** The device's IANA zone and kind (shared/zone.ts DEVICES), sent on load and when the app comes back to the foreground;
   *  written only when either changed. An unknown zone or device is invalid_input. */
  'PUT /api/zone': { req: { zone: string; device: Device }; res: ZoneReport & { changed: boolean } };
  'POST /api/seen': { req: { tip: Mark }; res: Onboarding[] };
  'POST /api/conversations/:id/messages': { req: SendRequest; res: Message };
  'POST /api/conversations/:id/stop': { req: Record<string, never>; res: null };
  'POST /api/files': { req: FormData /* field `file` */; res: FileInfo };
  'GET /api/files/:id': { query: { download?: '1'; view?: '1' }; res: Blob };   // the owner's files and files shown in their conversations; download=1 saves instead of opening
  'GET /api/goals': { res: Goal[] };
  'GET /api/agents': { query: { includeArchived?: boolean }; res: AgentInfo[] };
  'GET /api/usage': { res: UsageReport };
  'GET /api/usage/gpus': { res: GpuFleetReport };
  'GET /api/metrics': { res: LatencyReport };
  'POST /api/metrics/first-text': { req: { messageId: string; firstTextAt: number }; res: null };
  // `open`: the conversation to start on (the Kenaznia conversation when absent or not available); `limit`: its page size.
  // Web Push for installed web apps (iPhone home-screen app): the VAPID key to subscribe with, then register/remove the device.
  // confirm: send that device a confirmation notification now; `test` says whether its push service took it (null without confirm).
  // The app re-registers its subscription without confirm on every open, so a device the server lost comes back.
  'GET /api/push': { res: { publicKey: string } };
  'POST /api/push/subscriptions': { req: { subscription: WebPushSubscription; confirm: boolean; replaces: string | null }; res: { test: WebPushTest | null } };
  'DELETE /api/push/subscriptions': { req: { endpoint: string }; res: null };
  'GET /api/events': { query: { open?: string; limit?: number }; res: 'text/event-stream' };
}
/** The app's layout, chosen per person (PUT /api/layout). Classic is the original sidebar app. */
export const LAYOUTS = ['classic', 'organized'] as const;
export type Layout = typeof LAYOUTS[number];
/** Organized onboarding, each given once per person: the welcome message in their Kenaznia chat the first time they
 *  switch to Organized, the first-visit tip of Home and Chats (dismissed with OK), and the note on where the 🌀
 *  bubble went the first time she hides it (Carol 2026-10-22: only ever once). The app marks them: POST /api/seen. */
export const ONBOARDING = ['welcome', 'home', 'chats', 'todo', 'bubble'] as const;
export type Onboarding = typeof ONBOARDING[number];
export const TIPS = ['home', 'chats'] as const satisfies readonly Onboarding[];
export type Tip = typeof TIPS[number];
export const MARKS = [...TIPS, 'bubble'] as const satisfies readonly Onboarding[];
export type Mark = typeof MARKS[number];
/** A chat group's colour family: its topics are shades of one hue (modules/organized/web/colors.ts FAMILIES). */
export const GROUP_FAMILIES = ['amber', 'garnet', 'plum', 'blue', 'teal', 'lime'] as const;
export type GroupFamily = typeof GROUP_FAMILIES[number];
/** One of a person's chat groups (Chats sections, the `organized` module); `position` orders them. */
export interface ChatGroup { id: string; name: string; emoji: string | null; family: GroupFamily; position: number }
export interface ChatGroupInput { name: string; emoji: string | null; family: GroupFamily }
/** Today; Soon (next few days, no set day); Later (this month); Someday. The API and the todos tool also take 'week',
 *  the old "This week", as an alias for 'soon'. */
export const TODO_LEVELS = ['today', 'soon', 'later', 'someday'] as const;
export type TodoLevel = typeof TODO_LEVELS[number];
/** One to-do item (extension `todos`). doneAt/deletedAt null = open/present; dueAt epoch ms or null.
 *  onDate: the day it is for (YYYY-MM-DD, no time; read in the person's own time zone, shared/zone.ts), or null: from that day on, while open,
 *  it shows in Today whatever its level. details: markdown shown at the top of the item's chat (text stays a short title), or null. onHome: she asked for it on Home ("Waiting on you") whatever its level.
 *  ownRoom: conversationId is the chat made for this item when she tapped it (POST /api/ext/todos/todos/:id/chat);
 *  that chat closes when the item is done or deleted and reopens with it. */
export interface Todo {
  /** Immutable social-post review. Only the dedicated client decision endpoint can approve it. */
  postProposalId?: string;
  id: string; text: string; details: string | null; level: TodoLevel; tag: string | null; dueAt: number | null; onDate: string | null; remind: boolean; onHome: boolean;
  position: number; conversationId: string | null; ownRoom: boolean; doneAt: number | null; deletedAt: number | null; createdAt: number; updatedAt: number;
  /** A question from Kenaznia (the question tool): the answers she taps, and the one she chose (null until then). Null options: an ordinary to-do. */
  options: string[] | null; answer: string | null;
  /** When she tapped Dismiss on the question (deletedAt is set with it); null otherwise. */
  dismissedAt: number | null;
}
/** POST /api/ext/todos/todos/:id/chat: the chat to do the item in (its linked chat, the linked project's chat, or a new
 *  chat made for it); opener says whether Kenaznia was asked to start the new chat ('none' when it already existed). */
export interface TodoChat { conversation: ConversationSummary; todo: Todo; opener: 'asked' | 'none' | 'no_manager' }
/** The 🛒 To buy list (extension `todos`, Carol 2026-10-22): a permanent shopping list per person, apart from to-dos.
 *  Sections are hers to add, rename and recolour (color #rrggbb); an item is open until bought (boughtAt), when it leaves
 *  the list. GET /api/ext/todos/buy and every change answer the whole list, which the `buy` event also carries. */
export interface BuySection { id: string; name: string; emoji: string | null; color: string; position: number }
export interface BuyItem { id: string; sectionId: string; text: string; position: number; boughtAt: number | null }
export interface BuyList { sections: BuySection[]; items: BuyItem[] }
/** 📰 What's new (extension `changelog`): the commits live on this channel in plain words, newest first. An entry's
 *  `text` is null for a behind-the-scenes change (the page folds those into one line per day); `pending` counts commits
 *  still being written up. `seenThrough`: the newest entry time the person had seen (null: never opened). */
export interface ChangelogEntry { hash: string; at: number; text: string | null }
export type Changelog =
  | { kind: 'ready'; commit: string; entries: ChangelogEntry[]; pending: number; seenThrough: number | null }
  | { kind: 'unavailable'; reason: string };
/** A title given here is the person's own: it locks the title unless titleLocked says otherwise. pinned true pins now. */
export interface ConversationPatch {
  title?: string; titleLocked?: boolean; archived?: boolean; color?: string | null; readThrough?: number; addMemberIds?: string[]; removeMemberIds?: string[];
  emoji?: string | null; pinned?: boolean; keyDate?: string | null; keyLabel?: string | null;
  project?: boolean; statusLine?: string | null; projectId?: string | null; groupId?: string | null;
  /** Sets (a colour) or clears (null) the reader's colour for each person named; the others stay as they are. */
  memberColors?: Record<string, string | null>;
}
/** seenFrom: the screen the person sent it from (the Organized quick panel), told to her Kenaznia with the message and never shown. */
export interface SendRequest { clientId: string; text: string; fileIds: string[]; clientSentAt: number; seenFrom?: string }

/** Where the person's Kenaznia answers: in a conversation here, in the app at another URL (the other channel), or nowhere (workers only). */
/** Art drawn behind the app for a person who chose it (`background` on their people[] entry); more kinds join this list. */
/** The footer tray's tiles, in the order a person's list shows them (Settings ⚙ stays last, always). null in Bootstrap.trayTiles: all that apply. */
export const TRAY_TILES = ['calendar', 'todo', 'search', 'goals', 'usage', 'news', 'finder', 'sky'] as const;
export type TrayTile = (typeof TRAY_TILES)[number];
export const isTray = (v: unknown): v is TrayTile[] => Array.isArray(v) && new Set(v).size === v.length && v.every(t => (TRAY_TILES as readonly unknown[]).includes(t));
export const BACKGROUNDS = ['starfield', 'forest'] as const;
export type Background = (typeof BACKGROUNDS)[number];

/**
 * Her Kenaznia is in a turn for another chat while messages of hers wait behind it (one session answers all her chats, one
 * turn at a time). `busy`: the chat that turn answers, when it is one of hers, or other work (a heartbeat, a report in its
 * own chat). `queued`: each of her chats with a message waiting, and how many queued turns go before it (0: it is next).
 * A chat whose message the running turn already answers is never listed.
 */
export interface Waiting { busy: { kind: 'chat'; conversationId: string } | { kind: 'other' }; queued: Record<string, number> }
/** The per-person extension that turns the busy line on while it rolls out. */
export const BUSY_LINE = 'busyline';
export type ManagerHome = { kind: 'here'; conversationId: string } | { kind: 'elsewhere'; url: string } | { kind: 'none' };
export interface Bootstrap {
  clientHome?: string;             // set only when this account, not just its manager, has moved
  me: Person;
  people: Person[];                // everyone visible (humans + agents in my space + room members)
  agents: AgentInfo[];             // agents owned by me
  goals: GoalSummary[];            // the goals of `agents`
  conversations: ConversationSummary[];   // non-archived, most recent first (archived via ?archived=1 later)
  activity: Record<string, Activity>;     // live runs among `conversations`, by conversation id; absent = no run
  manager: ManagerHome;
  layout: Layout;
  /** The IANA zone the server reads this person's day in and the kind of device that reported it (PUT /api/zone); null: never reported. */
  zone: ZoneReport | null;
  seen: Onboarding[];
  extensions: { id: string; name: string }[];
  /** The composer shows the live voice button: the person's `composerVoice` config with the `voice` extension. */
  composerVoice: boolean;
  /** The art behind the app: the person's `background` config; null: none (the plain page colour). */
  background: Background | null;
  /** The person's own message bubbles: their `bubbleColor` config (#RRGGBB, white text reads on it); null: the app's colour. */
  bubbleColor: string | null;
  /** The tray tiles this person shows, in order: their own choice (PUT /api/tray), else their `trayTiles` config; null: every tile that applies. */
  trayTiles: TrayTile[] | null;
  /** Her messages waiting for her Kenaznia while it answers elsewhere (extension `busyline`); null: none waits, or no flag. */
  waiting: Waiting | null;
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
  | { type: 'thinking'; conversationId: string; messageId: string; block: number; text: string }   // append to the message's block-th thinking part; block = its thinking-part count starts a new one
  | { type: 'tool_draft'; conversationId: string; messageId: string; part: ToolPart }   // a tool call still being written: replaces the streaming message's part with this callId, or adds it
  | { type: 'conversation'; conversation: ConversationSummary }
  | { type: 'activity'; conversationId: string; activity: Activity | null }   // null: the run ended
  | { type: 'waiting'; waiting: Waiting | null }                           // her Kenaznia's queue changed (extension `busyline`)
  | { type: 'agent'; agent: AgentInfo }
  | { type: 'goal'; goal: Goal }
  | { type: 'todo'; todo: Todo }                                            // created or changed (deletedAt set: removed)
  | { type: 'chat_groups'; groups: ChatGroup[] }                            // the person's whole group list after any change
  | { type: 'buy'; list: BuyList }                                          // the person's whole To buy list (open items) after any change
  | { type: 'layout'; layout: Layout }
  | { type: 'seen'; seen: Onboarding[] }                                   // the person's whole onboarding list after a change
  | { type: 'notifications_cleared'; conversationId: string; throughId: number } // delivered alerts read on any device
  | { type: 'notification'; notification: PhoneNotification }              // only on GET /api/notifications
  | { type: 'phone'; command: PhoneCommand }                                // only on GET /api/notifications?phone=1
  | { type: 'phone_settings'; command: { id: string; at: number; action: string; [key: string]: unknown } } // native app commands
  | { type: 'heartbeat'; at: number };                                      // every 15 s
export const SSE_HEARTBEAT_MS = 15_000;
/** How soon a browser reopens an event stream the server ended (sent as the stream's `retry:`). */
export const SSE_RETRY_MS = 500;
/** The newest page of the conversation a stream opened on. */
export interface StartupPage { conversationId: string; page: MessagePage }
export type StreamEvent =
  | Exclude<ServerEvent, { type: 'notification' | 'phone' | 'phone_settings' }>
  | { type: 'ready'; bootstrap: Bootstrap; page: StartupPage | null }
  | { type: 'unauthenticated' };

// ---------- phone control (extension `phone`) ----------
/** Coordinates are screenshot pixels: the phone scales its screen so the long side is at most PHONE_SHOT_MAX_SIDE. */
export const PHONE_SHOT_MAX_SIDE = 1568;
export type PhoneKey = 'back' | 'home' | 'recents' | 'notifications' | 'enter';
export type PhoneDirection = 'up' | 'down' | 'left' | 'right';
export type PhoneAction =
  | { action: 'start' } | { action: 'end' } | { action: 'screenshot' } | { action: 'ui' }
  | { action: 'tap'; target: { kind: 'point'; x: number; y: number } | { kind: 'node'; node: number }; long: boolean }
  | { action: 'swipe'; x1: number; y1: number; x2: number; y2: number; durationMs: number }
  | { action: 'scroll'; direction: PhoneDirection; node: number | null }
  | { action: 'type'; text: string; secret: boolean }
  | { action: 'key'; key: PhoneKey }
  | { action: 'open'; package: string }
  | { action: 'say'; text: string; place: PhoneBubblePlace; point: { x: number; y: number } | null };
/** Where an instruction bubble sits: top or bottom of the screen, or away: the half not holding its point. */
export type PhoneBubblePlace = 'top' | 'bottom' | 'away';
export type PhoneCommand = { id: string; sessionId: string; at: number } & PhoneAction;
/** What the phone posts to /api/ext/phone/results for a command. */
export type PhoneResult = { id: string; ok: true; value: Record<string, unknown> } | { id: string; ok: false; error: { code: string; message: string } };

// ---------- phone notifications ----------
/** normal: an ordinary heads-up notification. urgent: rings on the alarm stream through silent mode and Do Not Disturb. */
export type NotificationLevel = 'normal' | 'urgent';
/** A browser's Web Push subscription (PushSubscription.toJSON()): where to send and the keys to encrypt for. */
export interface WebPushSubscription { endpoint: string; keys: { p256dh: string; auth: string } }
/** What subscribing reports: the confirmation push sent to that device, and whether its push service accepted it. */
export type WebPushTest = { kind: 'delivered' } | { kind: 'rejected'; status: number; reason: string } | { kind: 'unreachable'; reason: string } | { kind: 'gone'; status: number };
export interface QuietHours { enabled: boolean; start: string; end: string }
export interface PhoneNotification { quietHours?: QuietHours & { timeZone: string }; quietHeld?: boolean; collapseKey?: string; id: number; title: string; body: string; level: NotificationLevel; imageFileId: string | null; agentId: string; conversationId: string; createdAt: number }

// ---------- usage & metrics ----------
export interface CapacityBalance { id: string; unit: 'credits' | 'USD' | 'resets'; remaining: number; available: boolean | null; observedAt: number | null; expiresAt: number | null; burnPerHour?: number | null; burnPerDay?: number | null; runsOutAt?: number | null; historyHours?: number | null }
export interface CapacityMeter { id: string; label: string; scope: string; windowHours: number | null; percentLeft: number | null; resetAt: number | null; observedAt: number | null; state: 'fresh' | 'stale' | 'unknown'; source: string; coverage: number; total: number }
export interface CapacityAccount { id: string; plan: string | null; weight: number; enabled: boolean; reason: string | null; meters: CapacityMeter[]; balances: CapacityBalance[] }
export interface CapacityObservation { label: string; used: number; limit: number | null; unit: 'USD' | 'requests/min'; observedAt: number; source: string }
export interface CapacityProvider { id: string; name: string; rule: string; state: 'available' | 'credits' | 'limited' | 'readings' | 'unknown'; observations?: CapacityObservation[]; accounts: CapacityAccount[]; meters: CapacityMeter[]; balances: CapacityBalance[]; monthlyUsd: number; source: string; documentation: string | null }
export interface UsageReport {
  capacity?: CapacityProvider[];
  observedAt: number;
  plans: UsagePlan[];
  /** Recorded calls at API list prices, not subscription charges; rolling hour/day per provider, finished agents included. */
  providerSpend: { provider: string; lastHourUsd: number; lastDayUsd: number }[];
  /** Totals over every agent of the person, finished runs included; byAgent is the day's biggest spenders, most first. */
  spend: { lastHourUsd: number; lastDayUsd: number; byAgent: { agentId: string; archived: boolean; lastDayUsd: number }[] };
  /** Each swarm with spend in the last day: its coordinator, sub-agent counts and what the coordinator and its sub-agents cost (API-rate USD, the quota proxy). */
  swarms: { coordinatorId: string; name: string; subAgents: { total: number; active: number; running: number; done: number; blocked: number }; lastDayUsd: { coordinator: number; subAgents: number } }[];
  /** Each speed above normal: how many times normal's rate it uses the included quota (server/agents/speed.ts QUOTA_RATE), and the active workers running at it. */
  speeds: { speed: 'fast' | 'ultrafast'; quotaRate: number; workers: { id: string; name: string; model: string }[] }[];
  /** Prompt caching over the person's agents' model calls (server/metrics/cache.ts). */
  cache: CacheReport;
  /** What the subscriptions cost in real dollars, from the plan-prices file (config plansPath). */
  planCosts: PlanCosts | { unavailable: string };
  /** ResearchCo's Mercury balances and spending (~/tools/mercury writes the record; Alice only). */
  mercury: MercuryReport | { unavailable: string };
}
/** What `mercury-balance` caches: balances per account, the IO credit card, and spending since the account opened. */
export interface MercuryReport {
  observedAt: number;
  accounts: { name: string; kind: string; available: number; current: number }[];
  /** limit is null when Mercury's API does not expose it. */
  creditCard: { available: number; current: number; limit: number | null; spentToDate: number };
  cash: { available: number; current: number };
  inTotal: number;
  spent: { sinceOpening: number; thisMonth: number; monthLabel: string; openedOn: string };
  spentByGroup: Record<string, { sinceOpening: number; thisMonth: number }>;
  /** Set when the record is older than the refresh timer allows. */
  problem: string | null;
}
/** A subscription account we pay for: its plan price and who pays, with the live quota windows the broker reports for it. */
export interface PlanAccountCost {
  /** Relative subscription capacity (Pro 1x, Max 5x, Ultra 10x), independent of price. */
  capacityMultiplier?: number;
  /** Known reason an account has no active quota readings. */
  status?: string;
  accountId: string;
  provider: string;
  email: string;
  plan: string;
  usdPerMonth: number;
  payer: string;
  card: string;
  /** Next renewal, YYYY-MM-DD, rolled forward a month at a time from the file's date. */
  renewsOn: string | null;
  /** Which host holds the account; inPool: this person's broker lists it. */
  host: string;
  inPool: boolean;
  note: string;
  /** One entry per window the broker reports for this account, percentUsed = 100 - percentLeft. */
  quota: { metric: string; percentUsed: number | null; resetAt: number | null; readingAt: number }[];
}
/** Plan spend. monthlyUsd covers every account we pay (not ACME's); dailyUsd is monthlyUsd over an average month of 365/12 days. */
export interface PlanCosts {
  monthlyUsd: number;
  dailyUsd: number;
  poolMonthlyUsd: number;
  accounts: PlanAccountCost[];
  /** Accounts the broker serves that the plan-prices file doesn't list: add them there. */
  unpriced: string[];
}
/**
 * Prompt tokens of a set of model calls. Every prompt token is a cache read, a cache write or uncached input; hitRate is
 * cacheRead over all three (null without prompt tokens). costUsd is the calls' API-list-price cost, output included;
 * savedUsd what their prompts would have cost more with no cache at all (cache writes cost more than plain input on
 * Anthropic, so it subtracts those), at each model's list prices.
 */
export interface CacheFigures { calls: number; promptTokens: number; cacheRead: number; cacheWrite: number; uncached: number; hitRate: number | null; costUsd: number; savedUsd: number }
/** One window of calls: everything, per provider, per model (most prompt tokens first), the agents with the most prompt
 * tokens, and the worst offenders: agents that sent the most prompt tokens fresh beyond what the window's overall hit rate
 * would have sent (excessMiss), most first. */
export interface CacheWindow {
  overall: CacheFigures;
  byProvider: (CacheFigures & { provider: string })[];
  byModel: (CacheFigures & { model: string })[];
  topAgents: (CacheFigures & { agentId: string; name: string })[];
  worstAgents: (CacheFigures & { agentId: string; name: string; excessMiss: number })[];
}
/** Rolling windows ending now: the last 60 minutes, 24 hours and 7 days. */
export interface CacheReport { hour: CacheWindow; day: CacheWindow; week: CacheWindow }
/** A subscription pool's meter, modelled from each account's own share, drain and reset. */
export interface UsagePlan {
  provider: 'anthropic' | 'openai' | 'xai' | 'google';
  credits?: { balance: number; available: boolean; accounts: { accountId: string; balance: number; available: boolean }[] };
  /** Why a normal quota or drain reading is unavailable, or why the subscription is exhausted. */
  quotaUnavailableReason?: string;
  /** Live subscription availability; an available subscription can still have an unknown quota. */
  availability?: { available: boolean; exhausted: boolean; reason: string | null; resetAt: string | null; nextProbeAt: string | null; percentLeft?: number | null };
  metric: string;                  // e.g. five-hour, weekly
  percentLeft: number | null;      // capacity-weighted share left across the accounts
  projection: PoolProjection;
  accounts: UsageAccount[];
  /** True on the one limit of this provider that runs out first (earliest projected exhaustion, else least left); projections that matter run off it. */
  binding: boolean;
}
/**
 * stale: no account has a fresh reading (idle accounts, or failed polls), so there is no current drain.
 * unmeasured: fresh readings, but no account has enough of them in this window to measure a drain yet.
 * projected: the measured accounts' capacity-weighted drains over total capacity; exhaustionAt is when no account has quota left at
 * that drain, each resetting on its own schedule (null: not within 8 days). Accounts in unknownDrain still have quota but no
 * current drain (stale or unmeasured); their last share counts as capacity, so the projection is certain only when it is empty.
 */
export type PoolProjection =
  | { state: 'stale'; latestReadingAt: number }
  | { state: 'unmeasured' }
  | { state: 'projected'; drainPercentPerHour: number; exhaustionAt: number | null; unknownDrain: string[] };
export interface UsageAccount {
  /** Relative capacity used by pool totals, forecasts and reset gains. */
  capacityMultiplier?: number;
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

/** The immutable JSON reviewed for social publication. Media hashes identify content, not builds. */
export interface SocialPostProposal {
  source_file: string; title: string;
  posts: { platform: string; text: string; destination?: string; link?: string; images?: { path: string; alt?: string }[]; video?: string | { path: string } }[];
  media: { path: string; sha256: string; size: number }[];
}

// ---------- GPU fleet (kenan-gpus: one record per machine across every provider) ----------
export type GpuPoolKind = 'credit' | 'money' | 'free';
export type GpuOwner =
  | { kind: 'worker'; id: string; name: string | null; goal: string | null; state: string | null }
  | { kind: 'service'; name: string }
  | { kind: 'shared'; label: string; workers: { id: string; name: string }[] };
export interface GpuMachine {
  key: string;
  provider: string;
  id: string;
  name: string;
  card: string | null;
  gpus: number | null;
  owner: GpuOwner | null;
  doing: string | null;
  status: string | null;
  startedAt: number | null;
  endsAt: number | null;
  endsWhy: string | null;
  computeUnitsPerHour?: number | null;
  /** Actual usage reported by the provider, not an estimate or today’s spend. */
  computeUnitsUsed?: number | null;
  memoryMiB?: number | null;
  usdPerHour: number | null;
  rateWhy: string | null;
  costUsd: number | null;
  pool: string | null;
  gpuUtil: number | null;
  /** Why this machine is billing without doing work; null when it is working or free. */
  idle: string | null;
  /** The provider could not be read this time; the row is its last good reading. */
  stale?: boolean;
  /** Field name → why it has no value. */
  unknown: Record<string, string>;
}
export interface GpuPool {
  id: string;
  label: string;
  kind: GpuPoolKind;
  unit?: 'compute-unit';
  computeUnitsPerHour?: number | null;
  /** Actual usage reported by the provider, not today’s spend. */
  computeUnitsUsed?: number | null;
  remainingComputeUnits?: number | null;
  usdPerHour: number | null;
  machines: number;
  todayUsd: number | null;
  todayWhy: string | null;
  capTodayUsd: number | null;
  remainingUsd: number | null;
}
export interface GpuFleetReport {
  /** False for accounts without provider access; other people's machines are never exposed. */
  available: boolean;
  observedAt: number;
  /** Why the record could not be read, or is older than three minutes. */
  problem: string | null;
  machines: GpuMachine[];
  pools: GpuPool[];
  providers: { name: string; ok: boolean; error: string | null; observedAt: number | null }[];
  totals: { machines: number; gpus: number; usdPerHour: number; creditUsdPerHour: number; moneyUsdPerHour: number; todayUsd: number; idle: number };
}

/** Local reserve pauses are background status, not failed human requests. */
export const isBackgroundQuotaPause = (text: string): boolean => /"code"\s*:\s*"background_reserve"/.test(text);
