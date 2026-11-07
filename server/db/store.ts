import { titleRefusal } from '../../shared/title-limits.js';
import {boundedErrorLog} from './error-log.js';
import { pageSize, pageKey, finishPage } from '../tools/pagination.js';
// Postgres implementation of Store. One pool, plain SQL, no triggers.
import { randomUUID, randomBytes } from 'node:crypto';
import { guessHash } from '../tools/seal-guess.js';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { NOTICE_DISPLAY, type TrayTile, type AgentInfo, type AgentState, type AgentWake, type ConversationSummary, type Goal, type LatencyReport, type Message, type MessageDisplay, type MessagePart, type Layout, type Onboarding, type Person, type PhoneNotification } from '../../shared/contract.js';
import type { Admission, AgentInput, HostEvent, LatencyField, NewMessage, LoggedError, PhoneLocation, PeerMessage, RecentWork, RoomOrganisation, Store, UsageSample, Wake } from '../types.js';
import type { Device } from '../../shared/zone.js';
import { fail } from './errors.js';
import { applySchema } from './schema-apply.js';
import { ensureSearchFunctions, ensureSearchIndexes } from './search-indexes.js';
import { searchMessages } from './search.js';
import { FAMILIES, OTHER, PINNED, pickColor } from '../../shared/colors.js';
import { messageRewriter, rewriteStrings } from '../message-rewrite.js';

export interface Session { id: string; personId: string; expiresAt: number }
/** Store plus the core-only extras (sessions, usage sample source). */
export interface PgStore extends Store {
  createSession(s: Session): Promise<void>;
  extendSession(id: string, expiresAt: number): Promise<void>;
  getSession(id: string): Promise<Session | null>;
  deleteSession(id: string): Promise<void>;
}

type Row = Record<string, any>;
type Query = (sql: string, params?: unknown[]) => Promise<Row[]>;

// bigint/numeric as JS numbers (epoch ms and seq fit comfortably).
const types = {
  getTypeParser: ((oid: number, format?: 'text' | 'binary') =>
    oid === 20 || oid === 1700 ? (v: string) => Number(v) : pg.types.getTypeParser(oid, format as 'text')) as any,
};


/** Every human member of an open topic (no agent's chat) without a colour gets one, once, from its section: her projects
 *  for a project page, else her group's family or Other (shared/colors.ts pickColor). Moving, pinning, regrouping or
 *  making it a project never recolours it; only she (or Kenan for her) changes it, and clearing it picks a new one. */
async function settleColors(t: Query, conversationId: string): Promise<void> {
  const rows = await t(`SELECT m.person_id, m.group_id, m.project, g.family FROM member m JOIN conversation c ON c.id = m.conversation_id
      JOIN person p ON p.id = m.person_id AND p.kind = 'human' LEFT JOIN chat_group g ON g.id = m.group_id
    WHERE m.conversation_id = $1 AND m.color IS NULL AND c.agent_id IS NULL AND NOT c.archived FOR UPDATE OF m`, [conversationId]);
  for (const r of rows) {
    const section = (await t(`SELECT m.color FROM member m JOIN conversation c ON c.id = m.conversation_id
        WHERE m.person_id = $1 AND m.conversation_id <> $2 AND m.color IS NOT NULL AND NOT c.archived AND c.agent_id IS NULL
          AND m.project = $3 AND ($3 OR m.group_id IS NOT DISTINCT FROM $4) ORDER BY c.updated_at DESC`,
      [r.person_id, conversationId, r.project, r.family === null ? null : r.group_id])).map(x => x.color as string);
    const palette = r.project ? PINNED : r.family === null ? OTHER : FAMILIES[r.family as keyof typeof FAMILIES];
    await t('UPDATE member SET color = $3 WHERE conversation_id = $1 AND person_id = $2', [conversationId, r.person_id, pickColor(palette, section, section)]);
  }
}

/** shared/contract.ts `previewable` in SQL; schema.sql's message_preview index has the same predicate. */
const PREVIEWABLE = `display = 'shown' AND role <> 'tool' AND (btrim(text, E' \\t\\n\\r') <> '' OR parts @> '[{"type":"file"}]' OR parts @> '[{"type":"image"}]')`;
const SUMMARY = `
SELECT c.id, c.title, c.owner_id, c.agent_id, c.archived, me.color, me.member_colors, me.emoji, me.pinned_at, me.key_date, me.key_label, c.title_locked, coalesce(me.project, false) AS project, me.status_line, me.project_id, c.last_seq, c.updated_at,
  coalesce(me.read_through, 0) AS read_through, me.group_id,
  (SELECT coalesce(array_agg(m.person_id ORDER BY m.person_id), '{}') FROM member m WHERE m.conversation_id = c.id) AS member_ids,
  lm.author_id AS lm_author, lm.preview AS lm_preview, lm.created_at AS lm_at, lm.seq AS lm_seq
FROM conversation c
LEFT JOIN member me ON me.conversation_id = c.id AND me.person_id = $1
LEFT JOIN LATERAL (
  SELECT author_id, left(text, 140) AS preview, created_at, seq FROM message WHERE conversation_id = c.id AND ${PREVIEWABLE} ORDER BY seq DESC LIMIT 1
) lm ON true`;

/** Records the conversation of message `m` as showing the files in parameter `param` (uuid[]), so its members can open them. */
const linkFiles = (param: number) => `INSERT INTO conversation_file (file_id, conversation_id) SELECT unnest($${param}::uuid[]), m.conversation_id FROM m ON CONFLICT DO NOTHING`;
const shownFiles = (parts: MessagePart[]) => [...new Set(parts.flatMap(p => p.type === 'image' || p.type === 'file' ? [p.fileId] : []))];
const toFile = (r: Row) => ({ id: r.id as string, ownerId: r.owner_id as string, name: r.name as string, mime: r.mime as string, size: r.size as number, path: r.path as string });

const AGENT = `SELECT a.*, p.name, CASE WHEN a.role = 'manager' THEN 'work' ELSE coalesce((SELECT g.category FROM goal g WHERE g.id = a.goal_id), 'work') END AS category, (SELECT coalesce(json_agg(json_build_object('at', w.at, 'on', coalesce(w.event->>'source', CASE w.listen WHEN 'addressed' THEN 'any' END), 'since', w.created_at, 'goalId', w.goal_id, 'event', CASE WHEN w.event->>'source' = 'event' THEN json_build_object('topic', w.event->>'topic', 'prefix', coalesce((w.event->>'prefix')::boolean, false)) ELSE NULL END) ORDER BY w.at NULLS LAST, w.created_at), '[]')
  FROM wake w WHERE w.agent_id = a.id AND w.status = 'pending') AS wakes FROM agent a JOIN person p ON p.id = a.id`;
const GOAL = `SELECT g.*, (SELECT coalesce(array_agg(a.id ORDER BY a.created_at, a.id), '{}') FROM agent a WHERE a.goal_id = g.id) AS worker_ids FROM goal g`;

const toSummary = (r: Row): ConversationSummary => ({
  id: r.id, title: r.title, ownerId: r.owner_id, memberIds: r.member_ids, agentId: r.agent_id, archived: r.archived,
  color: r.color, memberColors: r.member_colors ?? {}, emoji: r.emoji, pinnedAt: r.pinned_at, keyDate: r.key_date, keyLabel: r.key_label, titleLocked: r.title_locked, project: r.project, statusLine: r.status_line, projectId: r.project_id, groupId: r.group_id ?? null, lastSeq: r.last_seq, readThrough: r.read_through,
  lastMessage: r.lm_at == null ? null : { authorId: r.lm_author, preview: r.lm_preview, at: r.lm_at, seq: r.lm_seq },
  updatedAt: r.updated_at,
});
const ORGANISATION = { groupId: 'group_id', color: 'color', memberColors: 'member_colors', emoji: 'emoji', pinnedAt: 'pinned_at', keyDate: 'key_date', keyLabel: 'key_label', project: 'project', statusLine: 'status_line', projectId: 'project_id' };
const toOrganisation = (r: Row): RoomOrganisation => ({
  color: r.color, memberColors: r.member_colors, emoji: r.emoji, pinnedAt: r.pinned_at, keyDate: r.key_date, keyLabel: r.key_label, project: r.project, statusLine: r.status_line, projectId: r.project_id, groupId: r.group_id,
});
const displayOf = (m: NewMessage): MessageDisplay => {
  switch (m.role) {
    case 'human': return 'shown';
    case 'notice': return NOTICE_DISPLAY[m.notice];
    case 'assistant': case 'tool': return m.display;
  }
};
// JSON copies mix prose with routing and protocol fields; a short source such as "human" must not change its kind.
const copyIdentifiers = new Set(['id', 'type', 'role', 'kind', 'status', 'source', 'chat', 'group', 'topic', 'agentId', 'fromId', 'authorId', 'personId', 'ownerId', 'conversationId', 'humanMessageId', 'deliveryKey', 'fileId', 'fileIds', 'callId', 'model', 'provider', 'category', 'state', 'level', 'reason']);
const toMessage = (r: Row): Message => ({
  id: r.id, conversationId: r.conversation_id, seq: r.seq, authorId: r.author_id, role: r.role, notice: r.notice, display: r.display, text: r.text,
  parts: r.parts, state: r.state, clientId: r.client_id, createdAt: r.created_at, updatedAt: r.updated_at, editedAt: r.edited_at ?? null, deletedAt: r.deleted_at ?? null, clipped: false, ...(r.background_summary ? { backgroundSummary: r.background_summary } : {}),
});
const agentRow = (r: Row): AgentInfo => ({
  id: r.id, name: r.name, kind: 'agent', ownerId: r.owner_id, role: r.role, conversationId: r.conversation_id,
  parentAgentId: r.parent_agent_id, archived: r.archived, goalId: r.goal_id, category: r.category, state: r.state, model: r.model, thinking: r.thinking ?? null, speed: r.speed, createdAt: r.created_at, updatedAt: r.updated_at, lastReport: r.last_report, originConversationId: r.origin_conversation_id ?? null,
  wakes: (r.wakes as { at: string | number | null; on: AgentWake['on']; since: string | number; goalId: string | null; event?: AgentWake['event'] }[]).map(w => ({ at: w.at === null ? null : Number(w.at), on: w.on, since: Number(w.since), goalId: w.goalId, event: w.event ?? null }) as AgentWake),
});
const notificationRow = (r: Row): PhoneNotification => ({ quietHeld: r.quiet_held, ...(r.collapse_key ? { collapseKey: r.collapse_key } : {}), id: r.id, title: r.title, body: r.body, level: r.level, imageFileId: r.image_file_id, agentId: r.agent_id, conversationId: r.conversation_id, createdAt: r.created_at });
const toWake = (r: Row): Wake => {
  const held = r.goal_id === null ? null : { goalId: r.goal_id, workerId: r.held_for, handoff: r.handoff };
  const base = { id: r.id, agentId: r.agent_id, ownerId: r.owner_id, message: r.message, createdAt: Number(r.created_at), held, originConversationId: r.origin_conversation_id ?? null };
  const listen = r.listen === 'addressed' ? { kind: 'addressed' } : r.listen === 'clock' ? { kind: 'clock', reason: r.clock_reason } : { kind: 'own' };
  const trigger = { at: r.at === null ? null : Number(r.at), event: r.event, listen };
  if (r.status === 'pending') return { ...base, ...trigger, status: 'pending' } as Wake;
  return { ...base, ...trigger, status: r.status, reason: r.reason, detail: r.detail, settledAt: r.settled_at } as Wake;
};
const toHostEvent = (r: Row): HostEvent => ({ id: r.id, topic: r.topic, body: r.body, arrivedAt: Number(r.arrived_at), consumedAt: r.consumed_at === null ? null : Number(r.consumed_at) });
/** An addressed host event no wake carried within this long no longer fires or rides along with wakes: what it said has
 * gone stale, and a backlog would otherwise fire every addressed wake at once. `on: "event"` wakes for its topic still see it. */
export const ADDRESSED_MAX_AGE_MS = 6 * 3600_000;
const nowMs = `(extract(epoch from clock_timestamp()) * 1000)::bigint`;
/** Host events of owner $1 addressed to ids $2 or goals $3 that arrived from $4 on, within ADDRESSED_MAX_AGE_MS, and no wake has carried. */
const ADDRESSED = `owner_id = $1 AND consumed_at IS NULL AND arrived_at >= $4 AND arrived_at >= ${nowMs} - ${ADDRESSED_MAX_AGE_MS} AND strpos(topic, ':') > 0
  AND (split_part(topic, ':', 1) = ANY (SELECT 'goal-' || g FROM unnest($3::text[]) g)
    OR EXISTS (SELECT 1 FROM unnest($2::text[]) i WHERE strpos(':' || substr(topic, strpos(topic, ':') + 1) || ':', ':' || i || ':') > 0))`;
/** A host event body `{phase: 'resolved', condition}` closes the condition its `{phase: 'opened', condition}` event on the
 * same topic opened. When no wake carried the opening, both are settled together: a condition that opened and closed
 * unseen is nothing to act on. */
const resolvedCondition = (body: unknown): string | null => {
  const b = body as { phase?: unknown; condition?: unknown } | null;
  return b && typeof b === 'object' && b.phase === 'resolved' && typeof b.condition === 'string' && b.condition ? b.condition : null;
};
const toGoal = (r: Row): Goal => ({
  id: r.id, ownerId: r.owner_id, title: r.title, detail: r.detail, status: r.status, category: r.category, priority: r.priority,
  workerIds: r.worker_ids, notes: r.notes, chatId: r.chat_id ?? null, createdAt: r.created_at, updatedAt: r.updated_at,
});

/** Build `col = $n` assignments for the defined keys of a patch. */
/** One entry of a goal's notes log: `YYYY-MM-DD HH:MMZ — text`, unless the text already starts with such a stamp. */
export function datedNote(entry: string, now: number): string {
  const text = entry.trim();
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}Z/.test(text)) return text;
  const iso = new Date(now).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}Z — ${text}`;
}
/** Goal notes are newest first: the entry in parameter $n goes on top. */
const prependNote = (n: number) => `notes = CASE WHEN btrim(notes) = '' THEN $${n} ELSE $${n} || E'\n' || notes END`;
function assignments(patch: Record<string, unknown>, columns: Record<string, string>, params: unknown[]): string[] {
  const out: string[] = [];
  for (const [key, col] of Object.entries(columns)) {
    if (patch[key] === undefined) continue;
    const v = patch[key];
    const json = col === 'last_report' || col === 'parts' || col === 'turn_chat' || col === 'member_colors';
    params.push(col === 'parts' ? stripNul(v) : json ? JSON.stringify(v) : v);
    out.push(col === 'member_colors' ? `${col} = jsonb_strip_nulls(${col} || $${params.length}::jsonb)` : `${col} = $${params.length}`);
  }
  return out;
}

/** Peeks look only this far back in a conversation, so a long run's older work never costs a scan. */
const RECENT_WINDOW = 400;
/** A tool result is JSON text inside the part; Postgres cannot cast a \u0000 escape, so rows stored before NULs were stripped lose theirs here. */
const RESULT_RAW = `replace(parts->0->>'result', '\\u0000', '')`;
const RESULT_TEXT = `CASE WHEN ${RESULT_RAW} IS JSON OBJECT THEN (SELECT string_agg(c->>'text', E'\\n') FROM jsonb_array_elements(
  CASE WHEN jsonb_typeof((${RESULT_RAW})::jsonb->'content') = 'array' THEN (${RESULT_RAW})::jsonb->'content' ELSE '[]'::jsonb END) c WHERE c->>'type' = 'text')
  ELSE coalesce(${RESULT_RAW}, '') END`;
/** Postgres text cannot hold NUL: drop it, in both raw and JSON-escaped (\u0000) form, from everything stored in a message part. */
const stripNul = (parts: unknown) => JSON.stringify(parts).replace(/((?:^|[^\\])(?:\\\\)*)\\u0000/g, '$1').replace(/((?:^|[^\\])(?:\\\\)*)\\u0000/g, '$1');
/** A call's arguments as key=value pairs, strings unquoted, so a command reads as written. */
const ARGS_TEXT = `WHEN jsonb_typeof(parts->0->'args') = 'object' THEN (SELECT string_agg(key || '=' || CASE WHEN jsonb_typeof(value) = 'string' THEN value #>> '{}' ELSE value::text END, ' ')
  FROM jsonb_each(parts->0->'args')) ELSE (parts->0->'args')::text`;
const RECENT_WORK = `WITH recent AS (
    SELECT m.conversation_id, m.seq, m.role, m.updated_at, m.role = 'assistant' AND m.display <> 'silent'
      AND (btrim(m.text, E' \\t\\n\\r') <> '' OR m.parts @> '[{"type":"thinking"}]') AS words
    FROM unnest($1::uuid[]) AS c(id) CROSS JOIN LATERAL (SELECT * FROM message WHERE conversation_id = c.id ORDER BY seq DESC LIMIT $2::int) m),
  ranked AS (SELECT conversation_id, seq, words, row_number() OVER (PARTITION BY conversation_id, words, role ORDER BY seq DESC) AS n FROM recent WHERE words OR role = 'tool'),
  picked AS (SELECT m.*, r.words FROM ranked r JOIN message m USING (conversation_id, seq) WHERE r.n <= CASE WHEN r.words THEN $3::int ELSE $4::int END)
  SELECT CASE WHEN words THEN 'said' ELSE 'did' END AS kind, conversation_id, seq, created_at AS at, updated_at, state,
    left(text, $5::int) AS text, length(text) AS text_length,
    (SELECT right(string_agg(p->>'text', E'\\n'), $5::int) FROM jsonb_array_elements(parts) p WHERE p->>'type' = 'thinking') AS thinking,
    parts->0->>'name' AS name, left(a.args, $5::int) AS args, length(a.args) AS args_length,
    left(o.out, $5::int) AS head, right(o.out, $5::int) AS tail, length(o.out) AS out_length
  FROM picked CROSS JOIN LATERAL (SELECT CASE WHEN words THEN NULL ELSE ${RESULT_TEXT} END AS out) o
  CROSS JOIN LATERAL (SELECT CASE WHEN words THEN NULL ${ARGS_TEXT} END AS args) a
  UNION ALL
  SELECT 'last', conversation_id, max(seq), max(updated_at), NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL FROM recent GROUP BY conversation_id
  ORDER BY conversation_id, seq`;
const LATENCY_INTERVALS = {
  receiveToAdmit: 'admitted_at - received_at',
  admitToModelRequest: 'model_request_at - admitted_at',
  admitToFirstToken: 'first_token_at - admitted_at',
  admitToFirstText: 'first_text_at - admitted_at',
  clientToAdmit: 'admitted_at - client_sent_at',
} as const;
const LATENCY_SQL = `SELECT count(*) AS count, ${Object.entries(LATENCY_INTERVALS).map(([k, e]) => [
  ...[50, 90, 99].map(p => `percentile_cont(${p / 100}) WITHIN GROUP (ORDER BY (${e})::float8) AS "${k}_p${p}"`),
  `max(${e}) AS "${k}_max"`,
].join(', ')).join(', ')} FROM latency WHERE admitted_at >= $1`;
const LATENCY_FIELDS: LatencyField[] = ['model_request_at', 'first_token_at', 'first_text_at'];

const toPeer = (r: Row): PeerMessage => {
  const base = { id: r.id, ownerId: r.owner_id, peerId: r.peer_id, fromAgent: r.from_agent, toAgent: r.to_agent, text: r.text, createdAt: r.created_at };
  switch (r.direction) {
    case 'out': return { ...base, direction: 'out', relayedAt: r.relayed_at };
    case 'in': return { ...base, direction: 'in' };
    default: throw new Error(`peer_message ${r.id} has unknown direction ${r.direction}`);
  }
};

export function createStore(databaseUrl: string, { max = 20, observeAgent = async agent => agent }: { max?: number; observeAgent?: (agent: AgentInfo) => Promise<AgentInfo> } = {}): PgStore {
  const toAgent = (row: Row) => observeAgent(agentRow(row));
  const pool = new pg.Pool({ connectionString: databaseUrl, max, types });
  pool.on('error', e => console.error(JSON.stringify({ type: 'pg_pool_error', error: String(e) })));
  const q: Query = async (sql, params) => (await pool.query(sql, params)).rows;
  const one = async (sql: string, params: unknown[] | undefined, what: string): Promise<Row> => (await q(sql, params))[0] ?? fail('not_found', `${what} not found`);
  async function tx<T>(fn: (q: Query) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(async (sql, params) => (await client.query(sql, params)).rows);
      await client.query('COMMIT');
      return result;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally { client.release(); }
  }

  /** Replace the same wait atomically: same event topic, or for time-only/any waits the same clock reason / same message. Different held goals/workers remain independent.
   * Retire old ids so a scheduler already checking their old deadlines cannot fire the replacement. */
  async function scheduleWake(t: Query, w: Parameters<Store['createWake']>[0]): Promise<Wake & { replacedIds: string[] }> {
    const now = Date.now(), { trigger, held } = w;
    await t('SELECT id FROM agent WHERE id = $1 FOR UPDATE', [w.agentId]);
    const event = trigger.event;
    const replaced = event === null || event.source === 'event' ? await t(`SELECT id, created_at FROM wake
      WHERE agent_id = $1 AND owner_id = $2 AND status = 'pending' AND listen = $3
        AND goal_id IS NOT DISTINCT FROM $4::uuid AND held_for IS NOT DISTINCT FROM $5::text
        AND (($6::jsonb IS NULL AND event IS NULL
          AND (($3 = 'clock' AND clock_reason IS NOT DISTINCT FROM $7::text) OR ($3 <> 'clock' AND message = $8::text)))
          OR (event->>'source' = 'event' AND $6::jsonb->>'source' = 'event'
          AND (event->>'topic' = $6::jsonb->>'topic'
            OR (event->>'prefix' = 'true' AND starts_with($6::jsonb->>'topic', event->>'topic'))
            OR ($6::jsonb->>'prefix' = 'true' AND starts_with(event->>'topic', $6::jsonb->>'topic')))))
      ORDER BY created_at, id FOR UPDATE`, [w.agentId, w.ownerId, trigger.listen.kind, held?.goalId ?? null, held?.workerId ?? null,
        event === null ? null : JSON.stringify(event), trigger.listen.kind === 'clock' ? trigger.listen.reason : null, w.message]) : [];
    const id = randomUUID(), replacedIds = replaced.map(r => r.id as string);
    if (replacedIds.length) await t(`UPDATE wake SET status = 'cancelled', reason = 'cancelled', settled_at = $2,
      detail = $3 WHERE id = ANY($1::uuid[])`, [replacedIds, now, `Replaced by wake ${id}`]);
    const createdAt = replaced.length ? Number(replaced[0]!.created_at) : now;
    const row = (await t(`INSERT INTO wake (id, agent_id, owner_id, message, at, event, status, created_at, listen, clock_reason, listen_since, goal_id, held_for, handoff, origin_conversation_id)
      VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, $8, $9,
        CASE WHEN $8 = 'addressed' THEN CASE WHEN $10::uuid IS NOT NULL THEN $7 ELSE coalesce((SELECT created_at FROM agent WHERE id = $2), $7) END END,
        $10, $11, $12, $13) RETURNING *`,
      [id, w.agentId, w.ownerId, w.message, trigger.at, event === null ? null : JSON.stringify(event), createdAt,
        trigger.listen.kind, trigger.listen.kind === 'clock' ? trigger.listen.reason : null,
        held?.goalId ?? null, held?.workerId ?? null, held?.handoff ?? null, w.originConversationId]))[0]!;
    return { ...toWake(row), replacedIds };
  }

  async function scrubMessageCopies(t: Query, message: Message, replacement: string, excludeSource = false): Promise<void> {
    const rewrite = messageRewriter(message, replacement);
    // Both spellings are needed because jsonb serializes quotes, backslashes and newlines.
    const needles = [...new Set(rewrite.needles.flatMap(value => [value, JSON.stringify(value).slice(1, -1)]))];
    await t(`UPDATE notification SET title = '', body = '', image_file_id = NULL, dismissed = true, quiet_summarized = true WHERE conversation_id = $1`, [message.conversationId]);
    if (!needles.length) return;
    const owners = (await t(`SELECT id AS owner_id FROM person WHERE id = $1 AND kind = 'human'
      UNION SELECT coalesce(a.owner_id, p.id) AS owner_id FROM member m JOIN person p ON p.id = m.person_id LEFT JOIN agent a ON a.id = p.id WHERE m.conversation_id = $2
      UNION SELECT owner_id FROM conversation WHERE id = $2`, [message.authorId, message.conversationId])).map(row => row.owner_id);
    if (!owners.length) return;
    // These fields hold delivered copies, summaries and reports which can outlive the original message.
    const copies: { table: string; keys: string[]; text?: string[]; json?: string[] }[] = [
      { table: 'message', keys: ['id'], text: ['text', 'background_summary'], json: ['parts'] },
      { table: 'agent_pending_input', keys: ['id'], json: ['input'] },
      { table: 'agent', keys: ['id'], json: ['last_report'] },
      { table: 'goal', keys: ['id'], text: ['title', 'detail', 'notes'] },
      { table: 'wake', keys: ['id'], text: ['message', 'detail', 'handoff'], json: ['event'] },
      { table: 'agent_heartbeat', keys: ['agent_id'], text: ['checklist'], json: ['goals', 'workers', 'alerts', 'alerts_shown'] },
      { table: 'notification', keys: ['id'], text: ['title', 'body'] },
      { table: 'peer_message', keys: ['owner_id', 'id'], text: ['text'] },
      { table: 'host_event', keys: ['owner_id', 'id'], json: ['body'] },
      { table: 'error_log', keys: ['id'], text: ['message'] },
    ];
    for (const { table, keys, text = [], json = [] } of copies) {
      const columns = [...text, ...json];
      const ownerFilter = table === 'message'
        ? `(conversation_id = $3 OR conversation_id IN (SELECT c.id FROM conversation c WHERE c.owner_id = ANY($2::text[]) OR EXISTS (SELECT 1 FROM member m WHERE m.conversation_id = c.id AND m.person_id = ANY($2::text[]))))`
        : table === 'agent_pending_input' || table === 'agent_heartbeat'
          ? `agent_id IN (SELECT id FROM agent WHERE owner_id = ANY($2::text[]))`
          : table === 'notification' ? 'person_id = ANY($2::text[])'
          : table === 'error_log' ? `scope IN (SELECT 'agent:' || id FROM agent WHERE owner_id = ANY($2::text[]))`
          : 'owner_id = ANY($2::text[])';
      const params: unknown[] = [needles, owners];
      if (table === 'message') params.push(message.conversationId);
      const sourceFilter = table === 'message' && excludeSource ? ' AND id <> $4' : '';
      if (sourceFilter) params.push(message.id);
      // The scan reads every candidate message; FOR UPDATE would forbid parallel workers, so find the keys first and lock only those rows.
      await t(`SET LOCAL max_parallel_workers_per_gather = 8`);
      const found = await t(`SELECT ${keys.join(', ')} FROM ${table}
        WHERE ${ownerFilter} AND EXISTS (SELECT 1 FROM unnest($1::text[]) AS n(value) WHERE strpos(concat_ws(chr(31), ${columns.map(col => `${col}::text`).join(', ')}), n.value) > 0)${sourceFilter}
        ORDER BY ${keys.join(', ')}`, params);
      const rows: Row[] = [];
      for (const key of found) rows.push(...await t(`SELECT ${[...keys, ...columns].join(', ')} FROM ${table} WHERE ${keys.map((k, i) => `${k} = $${i + 1}`).join(' AND ')} FOR UPDATE`, keys.map(k => key[k])));
      for (const row of rows) {
        const values: unknown[] = keys.map(key => row[key]);
        const sets: string[] = [];
        for (const col of columns) {
          const before = row[col], after = rewriteStrings(before, rewrite, copyIdentifiers);
          if (JSON.stringify(before) === JSON.stringify(after)) continue;
          values.push(json.includes(col) ? JSON.stringify(after) : after);
          sets.push(`${col} = $${values.length}${json.includes(col) ? '::jsonb' : ''}`);
        }
        if (!sets.length) continue;
        if (table === 'message') sets.push('updated_at = greatest(updated_at + 1, ' + Date.now() + ')');
        if (table === 'notification') sets.push('dismissed = true', 'quiet_summarized = true', 'image_file_id = NULL');
        await t(`UPDATE ${table} SET ${sets.join(', ')} WHERE ${keys.map((key, i) => `${key} = $${i + 1}`).join(' AND ')}`, values);
      }
    }
  }

  // The search indexes build in the background after a migration. A later migrate() on this store waits for that build:
  // its CREATE INDEX CONCURRENTLY changes the schema fingerprint, so the schema is reapplied, and the two deadlocked
  // (shopping.test.ts migrates twice; intake qualification of a9302470, 2026-11-06).
  let indexing: Promise<void> = Promise.resolve();
  const store: PgStore = {
    async migrate() {
      await indexing;
      await applySchema(pool, 'core', [await readFile(new URL('./schema.sql', import.meta.url), 'utf8')]);
      await ensureSearchFunctions(pool);
      indexing = ensureSearchIndexes(pool).catch(error => console.error(JSON.stringify({ type: 'search_index_error', error: String(error) })));
    },
    async joinManagersToOwnChats() {
      const { rows } = await pool.query(`INSERT INTO member (conversation_id, person_id)
        SELECT c.id, a.id FROM conversation c JOIN agent a ON a.owner_id = c.owner_id AND a.role = 'manager'
        WHERE c.agent_id IS NULL
          AND EXISTS (SELECT 1 FROM member m WHERE m.conversation_id = c.id AND m.person_id = c.owner_id)
          AND NOT EXISTS (SELECT 1 FROM member m JOIN person p ON p.id = m.person_id
                          WHERE m.conversation_id = c.id AND p.kind = 'human' AND p.id <> c.owner_id)
        ON CONFLICT DO NOTHING RETURNING conversation_id, person_id`);
      return rows.map(r => ({ conversationId: r.conversation_id as string, managerId: r.person_id as string }));
    },
    async close() { await pool.end(); },

    async prunePhoneLocations(now) {
      await q('DELETE FROM phone_location WHERE measured_at < $1', [now - 30 * 24 * 60 * 60 * 1000]);
    },
    async savePhoneLocation(location) {
      const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
      await tx(async t => {
        await t('DELETE FROM phone_location WHERE person_id = $1 AND measured_at < $2', [location.personId, cutoff]);
        if (location.measuredAt < cutoff) return;
        await t(`INSERT INTO phone_location (person_id, latitude, longitude, accuracy, measured_at, received_at, place, wifi_ssid, at_home, home_since)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (person_id, measured_at) DO NOTHING`,
          [location.personId, location.latitude, location.longitude, location.accuracy, location.measuredAt, location.receivedAt, location.place, location.wifiSsid, location.atHome, location.homeSince]);
      });
    },
    async latestPhoneLocation(personId, now) {
      const cutoff = now - 30 * 24 * 60 * 60 * 1000;
      return tx(async t => {
        await t('DELETE FROM phone_location WHERE person_id = $1 AND measured_at < $2', [personId, cutoff]);
        const r = (await t('SELECT * FROM phone_location WHERE person_id = $1 AND measured_at >= $2 ORDER BY measured_at DESC LIMIT 1', [personId, cutoff]))[0];
        return r ? { personId: r.person_id, latitude: r.latitude, longitude: r.longitude, accuracy: r.accuracy,
          measuredAt: r.measured_at, receivedAt: r.received_at, place: r.place, wifiSsid: r.wifi_ssid,
          atHome: r.at_home, homeSince: r.home_since } as PhoneLocation : null;
      });
    },

    // ---------- people ----------
    async upsertPerson(p) {
      await q(`INSERT INTO person (id, name, kind, created_at) VALUES ($1, $2, $3, $4)
        ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, kind = EXCLUDED.kind`, [p.id, p.name, p.kind, Date.now()]);
    },
    async getPerson(id) { return ((await q('SELECT id, name, kind FROM person WHERE id = $1', [id]))[0] as Person | undefined) ?? null; },
    async layoutOf(id) { return ((await q('SELECT layout FROM person WHERE id = $1', [id]))[0]?.layout as Layout | undefined) ?? fail('not_found', 'Unknown person'); },
    async setLayout(id, layout) { return ((await q('UPDATE person SET layout = $2 WHERE id = $1 RETURNING layout', [id, layout]))[0]?.layout as Layout | undefined) ?? fail('not_found', 'Unknown person'); },
    async zoneOf(id) { const r = (await q('SELECT time_zone FROM person WHERE id = $1', [id]))[0]; return r ? (r.time_zone as string | null) : fail('not_found', 'Unknown person'); },
    async zoneReportOf(id) {
      const r = (await q('SELECT time_zone, zone_device FROM person WHERE id = $1', [id]))[0] ?? fail('not_found', 'Unknown person');
      return r.time_zone === null ? null : { zone: r.time_zone as string, device: r.zone_device as Device };
    },
    async setZone(id, zone, device) {
      if ((await q(`UPDATE person SET time_zone = $2, zone_device = $3, phone_time_zone = CASE WHEN $3 = 'phone' THEN $2 ELSE phone_time_zone END WHERE id = $1 AND ((time_zone, zone_device) IS DISTINCT FROM ($2, $3) OR ($3 = 'phone' AND phone_time_zone IS DISTINCT FROM $2)) RETURNING 1`, [id, zone, device])).length) return { zone, device, changed: true };
      return (await q('SELECT 1 FROM person WHERE id = $1', [id])).length ? { zone, device, changed: false } : fail('not_found', 'Unknown person');
      },
    async trayOf(id) { return ((await q('SELECT tray_tiles FROM person WHERE id = $1', [id]))[0] ?? fail('not_found', 'Unknown person')).tray_tiles as TrayTile[] | null; },
    async setTray(id, tiles) { return ((await q('UPDATE person SET tray_tiles = $2 WHERE id = $1 RETURNING tray_tiles', [id, tiles]))[0] ?? fail('not_found', 'Unknown person')).tray_tiles as TrayTile[] | null; },
    async seenOf(id) { return ((await q('SELECT seen FROM person WHERE id = $1', [id]))[0]?.seen as Onboarding[] | undefined) ?? fail('not_found', 'Unknown person'); },
    async markSeen(id, item) {
      const added = (await q('UPDATE person SET seen = array_append(seen, $2) WHERE id = $1 AND NOT $2 = ANY (seen) RETURNING seen', [id, item]))[0]?.seen as Onboarding[] | undefined;
      return added ? { added: true, seen: added } : { added: false, seen: await store.seenOf(id) };
    },
    async listPeople(opts) {
      return (await q(`SELECT id, name, kind FROM person ${opts ? "WHERE id = ANY($1::text[]) OR ($2 AND kind = 'human')" : ''} ORDER BY kind DESC, name`, opts ? [opts.ids, opts.includeHumans === true] : undefined)) as Person[];
    },
    async referenceNames(ownerId, visibleOwners, refs, isolated) {
      if (!refs.length) return {};
      const rows = await q(`WITH names AS (
          SELECT p.id, p.name FROM person p
          WHERE (p.kind = 'human' AND p.id = ANY($2::text[]))
            OR EXISTS (SELECT 1 FROM agent a WHERE a.id = p.id AND a.owner_id = ANY($2::text[]))
          UNION ALL SELECT g.id::text, g.title FROM goal g WHERE g.owner_id = $1
          UNION ALL SELECT c.id::text, c.title FROM conversation c JOIN member m ON m.conversation_id = c.id WHERE m.person_id = $1
            AND (NOT $4 OR NOT EXISTS (SELECT 1 FROM member other WHERE other.conversation_id = c.id AND other.person_id <> $1
              AND NOT EXISTS (SELECT 1 FROM agent a WHERE a.id = other.person_id AND a.owner_id = $1)))
        ) SELECT r.ref, n.id, n.name FROM unnest($3::text[]) r(ref) JOIN names n
          ON n.id = r.ref OR (length(r.ref) >= 8 AND starts_with(n.id, r.ref))`, [ownerId, visibleOwners, refs, isolated]);
      return Object.fromEntries(refs.map(ref => {
        const matches = rows.filter(r => r.ref === ref), exact = matches.find(r => r.id === ref);
        return [ref, exact?.name ?? (matches.length === 1 ? matches[0]!.name : null)];
      }));
    },

    // ---------- agents ----------
    async createAgent(a) {
      const now = Date.now(), conversationId = randomUUID();
      await tx(async t => {
        await t('SELECT id FROM person WHERE id = $1 FOR UPDATE', [a.ownerId]);
        if (a.parentAgentId && !(await t('SELECT 1 FROM agent WHERE id=$1 AND owner_id=$2', [a.parentAgentId, a.ownerId])).length) fail('invalid_input', 'Parent agent must belong to the same owner');
        await t(`INSERT INTO person (id, name, kind, created_at) VALUES ($1, $2, 'agent', $3) ON CONFLICT (id) DO UPDATE SET name = excluded.name, kind = 'agent'`, [a.id, a.name, now]);
        await t(`INSERT INTO conversation (id, title, owner_id, agent_id, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $5)`,
          [conversationId, a.conversationTitle, a.ownerId, a.id, now]);
        await t('INSERT INTO member (conversation_id, person_id) VALUES ($1, $2), ($1, $3)', [conversationId, a.ownerId, a.id]);
        await t(`INSERT INTO agent (id, owner_id, role, conversation_id, goal_id, model, session_path, created_at, updated_at, parent_agent_id, thinking, origin_conversation_id, speed)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, $9, $10, $11, $12)`, [a.id, a.ownerId, a.role, conversationId, a.goalId, a.model, a.sessionPath, now, a.parentAgentId ?? null, a.thinking ?? null, a.originConversationId, a.speed ?? 'normal']);
      });
      return (await store.getAgent(a.id))!;
    },
    async getAgent(id) { const r = (await q(`${AGENT} WHERE a.id = $1`, [id]))[0]; return r ? toAgent(r) : null; },
    async agentSessionPath(id) { return (await q('SELECT session_path FROM agent WHERE id = $1', [id]))[0]?.session_path ?? null; },
    async listAgents(ownerId, opts = {}) {
      const ancestors = opts.includeAncestors && !opts.includeArchived;
      const rows = await q(`${ancestors ? `WITH RECURSIVE selected_agent(id, parent_agent_id) AS (
        SELECT id, parent_agent_id FROM agent WHERE ($1::text IS NULL OR owner_id = $1) AND ($2::boolean OR NOT archived)
          AND ($3::uuid IS NULL OR goal_id = $3::uuid)
        UNION
        SELECT p.id, p.parent_agent_id FROM agent p JOIN selected_agent child ON p.id = child.parent_agent_id
          WHERE ($1::text IS NULL OR p.owner_id = $1)
      )` : ''} ${AGENT} WHERE ($1::text IS NULL OR a.owner_id=$1)
        AND ${ancestors ? 'a.id IN (SELECT id FROM selected_agent)' : '($2 OR NOT a.archived) AND ($3::uuid IS NULL OR a.goal_id = $3::uuid)'}
        ORDER BY a.created_at,a.id`, [ownerId ?? null, opts.includeArchived === true, opts.goalId ?? null]);
      return Promise.all(rows.map(toAgent));
    },
    async agentAncestors(ownerId, roots) {
      if (!roots.length) return [];
      const rows = await q(`WITH RECURSIVE ancestors(id, parent_agent_id) AS (
        SELECT id, parent_agent_id FROM agent WHERE owner_id = $1 AND id = ANY($2::text[])
        UNION
        SELECT p.id, p.parent_agent_id FROM agent p JOIN ancestors child ON p.id = child.parent_agent_id
          WHERE p.owner_id = $1
      ) ${AGENT} WHERE a.owner_id = $1 AND a.id IN (SELECT id FROM ancestors)
        ORDER BY a.created_at, a.id`, [ownerId, roots]);
      return Promise.all(rows.map(toAgent));
    },
    async workerLineage(ownerId, roots) {
      if (!roots.length) return [];
      const rows = await q(`WITH RECURSIVE descendants(id, parent_agent_id) AS (
        SELECT id, parent_agent_id FROM agent WHERE owner_id = $1 AND role = 'worker' AND id = ANY($2::text[])
        UNION
        SELECT child.id, child.parent_agent_id FROM agent child JOIN descendants parent ON child.parent_agent_id = parent.id
          WHERE child.owner_id = $1 AND child.role = 'worker'
      ), ancestors(id, parent_agent_id) AS (
        SELECT id, parent_agent_id FROM agent WHERE owner_id = $1 AND id = ANY($2::text[])
        UNION
        SELECT parent.id, parent.parent_agent_id FROM agent parent JOIN ancestors child ON parent.id = child.parent_agent_id
          WHERE parent.owner_id = $1
      ) ${AGENT} WHERE a.owner_id = $1 AND a.id IN (SELECT id FROM descendants UNION SELECT id FROM ancestors)
        ORDER BY a.created_at, a.id`, [ownerId, roots]);
      return Promise.all(rows.map(toAgent));
    },
    async agentPresence(ownerId) {
      const rows = await q(`SELECT a.*, g.title AS goal_title, coalesce(w.text, '') AS work_text
        FROM (${AGENT} WHERE a.owner_id = $1 AND NOT a.archived AND a.state <> 'stopped' AND a.role <> 'blank') a
        LEFT JOIN goal g ON g.id = a.goal_id
        LEFT JOIN LATERAL (
          SELECT right(m.text, 200) AS text FROM (
            SELECT seq, role, display, text FROM message WHERE conversation_id = a.conversation_id ORDER BY seq DESC LIMIT 16
          ) m WHERE m.role = 'assistant' AND m.display <> 'silent' AND m.text <> '' ORDER BY m.seq DESC LIMIT 1
        ) w ON true
        ORDER BY a.created_at, a.id`, [ownerId]);
      return Promise.all(rows.map(async r => ({ agent: await toAgent(r), goal: r.goal_title ?? null, on: r.work_text })));
    },
    async agentsAround(ownerId, ids) {
      if (!ids.length) return [];
      return Promise.all((await q(`${AGENT} WHERE a.owner_id = $1 AND (a.id = ANY($2::text[]) OR a.parent_agent_id = ANY($2::text[])) ORDER BY a.created_at, a.id`, [ownerId, ids])).map(toAgent));
    },
    async agentsMatching(ownerId, ref, opts = {}) {
      const rows = await q(`${AGENT} WHERE a.owner_id = $1 AND ($3::boolean OR a.role <> 'blank') AND (a.id = $2 OR (length($2) >= 8 AND starts_with(lower(a.id), lower($2)))) ORDER BY a.created_at, a.id LIMIT 50`, [ownerId, ref, opts.includeBlank === true]);
      return Promise.all(rows.map(toAgent));
    },
    async findAgents(f) {
      const rows = await q(`${AGENT} WHERE a.owner_id = ANY($1::text[]) AND a.role <> 'blank'
        AND ($2::text IS NULL OR a.id = $2 OR (length($2) >= 8 AND starts_with(lower(a.id), lower($2))))
        AND ($3::text IS NULL OR starts_with(lower(a.goal_id::text), lower($3)))
        AND ($4::text IS NULL OR a.parent_agent_id = $4 OR (length($4) >= 8 AND starts_with(lower(a.parent_agent_id), lower($4))))
        AND ($5::text IS NULL OR strpos(lower(p.name), lower($5)) > 0)
        AND ($6 OR NOT a.archived)
        ORDER BY a.archived, a.updated_at DESC, a.id LIMIT $7`, [f.owners, f.id ?? null, f.goal ?? null, f.parent ?? null, f.name ?? null, f.includeArchived, f.limit]);
      return Promise.all(rows.map(toAgent));
    },
    async listWorkersPage(ownerId, opts) {
      const state = opts.state ?? 'active', scope = JSON.stringify(['workers', ownerId, state, opts.goalId ?? null, opts.includeArchived === true, opts.parent ?? null]);
      const limit = pageSize(opts.limit), key = pageKey(opts.cursor, scope);
      if (key && (key.length !== 3 || typeof key[0] !== 'number' || typeof key[1] !== 'number' || typeof key[2] !== 'string')) throw new Error('Invalid worker cursor');
      const rank = "CASE a.state WHEN 'running' THEN 0 WHEN 'idle' THEN 1 WHEN 'interrupted' THEN 2 WHEN 'error' THEN 3 ELSE 4 END";
      const rows = await q(`${AGENT} WHERE a.owner_id=$1 AND a.role='worker'
        AND ($8 OR NOT a.archived) AND ($2='all' OR ($2='active' AND a.state <> 'stopped') OR a.state=$2) AND ($3::text IS NULL OR a.goal_id::text=$3)
        AND ($4::int IS NULL OR (${rank}, -a.created_at, a.id) > ($4::int,$5::bigint,$6::text))
        AND CASE WHEN $9::text IS NULL THEN NOT EXISTS (SELECT 1 FROM agent c WHERE c.id = a.parent_agent_id AND c.role = 'worker' AND c.goal_id = a.goal_id)
          ELSE a.parent_agent_id = $9 END
        ORDER BY ${rank}, a.created_at DESC, a.id LIMIT $7`, [ownerId, state, opts.goalId ?? null, key?.[0] ?? null, key?.[1] ?? null, key?.[2] ?? null, limit + 1, opts.includeArchived === true, opts.parent ?? null]);
      const ranks: Record<AgentState, number> = { running: 0, idle: 1, interrupted: 2, error: 3, stopped: 4 };
      return finishPage(await Promise.all(rows.map(toAgent)), limit, scope, row => [ranks[row.state], -row.createdAt, row.id]);
    },
    async listGoalsPage(ownerId, opts) {
      const status = opts.status ?? 'open', scope = JSON.stringify(['goals', ownerId, status]);
      const limit = pageSize(opts.limit), key = pageKey(opts.cursor, scope);
      if (key && (key.length !== 4 || key.slice(0,3).some(v => typeof v !== 'number') || typeof key[3] !== 'string')) throw new Error('Invalid goal cursor');
      const rank = "CASE g.status WHEN 'open' THEN 0 WHEN 'done' THEN 1 ELSE 2 END";
      const rows = await q(`SELECT g.*, (SELECT count(*) FROM agent a WHERE a.goal_id=g.id) AS worker_count FROM goal g
        WHERE g.owner_id=$1 AND ($2='all' OR g.status=$2)
        AND ($3::int IS NULL OR (${rank},g.priority,g.created_at,g.id::text) > ($3::int,$4::float8,$5::bigint,$6::text))
        ORDER BY ${rank},g.priority,g.created_at,g.id LIMIT $7`, [ownerId,status,key?.[0] ?? null,key?.[1] ?? null,key?.[2] ?? null,key?.[3] ?? null,limit+1]);
      const items = rows.map(r => { const { workerIds, ...goal } = toGoal({ ...r, worker_ids: [] }); return { ...goal, workerCount: r.worker_count }; });
      const ranks = { open: 0, done: 1, dropped: 2 };
      return finishPage(items, limit, scope, row => [ranks[row.status], row.priority, row.createdAt, row.id]);
    },
    async updateAgent(id, patch) {
      await tx(async t => {
        if (patch.name !== undefined) await t(`UPDATE person SET name = $2 WHERE id = $1 AND kind = 'agent'`, [id, patch.name]);
        const params: unknown[] = [id, Date.now()];
        const sets = assignments(patch, { state: 'state', goalId: 'goal_id', model: 'model', lastReport: 'last_report', archived: 'archived', originConversationId: 'origin_conversation_id', turnChat: 'turn_chat', parentAgentId: 'parent_agent_id', speed: 'speed', thinking: 'thinking' }, params);
        const rows = await t(`UPDATE agent SET ${['updated_at = $2', ...sets].join(', ')} WHERE id = $1 RETURNING id`, params);
        if (!rows.length) fail('not_found', `Agent ${id} not found`);
        if (patch.archived !== undefined) await t('UPDATE conversation SET archived=$2,updated_at=$3 WHERE agent_id=$1',[id,patch.archived,Date.now()]);
      });
      return (await store.getAgent(id))!;
    },
    async moveHeldWakes({ from, goalId }, to) {
      const rows = await q(`UPDATE wake SET agent_id = $1 WHERE status = 'pending' AND goal_id IS NOT NULL AND agent_id <> $1
        AND ($2::text IS NULL OR agent_id = $2) AND ($3::uuid IS NULL OR goal_id = $3) RETURNING id`, [to, from ?? null, goalId ?? null]);
      return rows.map(r => r.id as string);
    },
    async handOff({ worker, managerId, message, trigger, handoff, summary }) {
      const now = Date.now();
      const wake = await tx(async t => {
        const scheduled = await scheduleWake(t, { agentId: managerId, ownerId: worker.ownerId, message, trigger,
          held: { goalId: worker.goalId, workerId: worker.id, handoff }, originConversationId: worker.originConversationId ?? null });
        await t(`UPDATE goal SET ${prependNote(2)}, updated_at = $3 WHERE id = $1`,
          [worker.goalId, datedNote(`Handoff from worker ${worker.id.slice(0, 8)} (held trigger ${scheduled.id.slice(0, 8)}, ${summary}):\n${handoff}`, now), now]);
        await t(`UPDATE agent SET last_report = $2, updated_at = $3 WHERE id = $1`, [worker.id, JSON.stringify({ status: 'handed_off', text: `Handed off to ${managerId}: ${summary}.\n${handoff}`, at: now }), now]);
        return scheduled;
      });
      return { wake, goal: toGoal(await one(`${GOAL} WHERE g.id = $1`, [worker.goalId], 'Goal')), worker: (await store.getAgent(worker.id))! };
    },
    async awaitingReply(conversationId) {
      const newest = (await q(`SELECT role FROM message WHERE conversation_id = $1 AND (role = 'human'
        OR (role = 'assistant' AND state = 'done' AND display IN ('shown', 'silent') AND btrim(text, E' \t\n\r') <> '')) ORDER BY seq DESC LIMIT 1`, [conversationId]))[0];
      return newest?.role === 'human';
    },
    async markRunningInterrupted() {
      return (await q(`UPDATE agent SET state = 'interrupted', updated_at = $1 WHERE state = 'running' RETURNING id`, [Date.now()])).map(r => r.id);
    },
    async listInterrupted() {
      return (await q(`SELECT id, turn_chat FROM agent WHERE state = 'interrupted' AND NOT archived ORDER BY updated_at`)).map(r => ({ id: r.id, turn: r.turn_chat ?? null }));
    },
    async storeInput(input) {
      if (input.deliveryKey === undefined) {
        return String((await q('INSERT INTO agent_pending_input (agent_id, input, created_at) VALUES ($1, $2, $3) RETURNING id', [input.agentId, JSON.stringify(input), Date.now()]))[0]!.id);
      }
      return tx(async t => {
        const claimed = await t('INSERT INTO agent_input_delivery_key (delivery_key, owner_id) VALUES ($1, (SELECT owner_id FROM agent WHERE id = $2)) ON CONFLICT DO NOTHING RETURNING delivery_key', [input.deliveryKey, input.agentId]);
        if (!claimed.length) return null;
        return String((await t('INSERT INTO agent_pending_input (agent_id, input, created_at) VALUES ($1, $2, $3) RETURNING id', [input.agentId, JSON.stringify(input), Date.now()]))[0]!.id);
      });
    },
    async storedInputs() {
      return (await q('SELECT id, input, created_at FROM agent_pending_input ORDER BY id')).map(r => ({ id: String(r.id), input: r.input as AgentInput, at: Number(r.created_at) }));
    },
    async deleteInputs(ids) {
      if (ids.length) await q('DELETE FROM agent_pending_input WHERE id = ANY($1::bigint[])', [ids]);
    },
    async moveInput(from, input) {
      const rows = await q(`WITH gone AS (DELETE FROM agent_pending_input WHERE id = $1::bigint RETURNING created_at)
        INSERT INTO agent_pending_input (agent_id, input, created_at) SELECT $2, $3, created_at FROM gone RETURNING id`, [from, input.agentId, JSON.stringify(input)]);
      return rows[0] ? String(rows[0].id) : null;
    },
    async createWake(w) {
      return tx(t => scheduleWake(t, w));
    },
    async pendingWakes(ownerId) {
      return (await q(`SELECT * FROM wake WHERE status = 'pending' AND ($1::text IS NULL OR owner_id = $1) ORDER BY created_at, id`, [ownerId])).map(toWake);
    },
    async wakesMatching(ownerId, ref) {
      return (await q(`SELECT * FROM wake WHERE owner_id = $1 AND (id::text = $2 OR (length($2) >= 8 AND starts_with(lower(id::text), lower($2))))`, [ownerId, ref])).map(toWake);
    },
    async settledWakes(ownerId, since, limit, agentId, goalId) {
      return (await q(`SELECT * FROM wake WHERE owner_id = $1 AND status <> 'pending' AND settled_at > $2
        AND ($4::text IS NULL OR agent_id = $4 OR held_for = $4 OR goal_id = $5::uuid)
        ORDER BY settled_at DESC LIMIT $3`, [ownerId, since, limit, agentId ?? null, goalId ?? null])).map(toWake);
    },
    async recordHostEvent(e) {
      return tx(async t => {
        const now = Date.now();
        const recorded = (await t(`INSERT INTO host_event (owner_id, id, topic, body, arrived_at) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING RETURNING id`,
          [e.ownerId, e.id, e.topic, JSON.stringify(e.body), now])).length === 1;
        const condition = resolvedCondition(e.body);
        if (recorded && condition !== null)
          await t(`WITH opened AS (UPDATE host_event SET consumed_at = $4 WHERE owner_id = $1 AND topic = $2 AND id <> $3 AND consumed_at IS NULL
              AND body->>'phase' = 'opened' AND body->>'condition' = $5 RETURNING id)
            UPDATE host_event SET consumed_at = $4 WHERE owner_id = $1 AND id = $3 AND EXISTS (SELECT 1 FROM opened)`, [e.ownerId, e.topic, e.id, now, condition]);
        return recorded;
      });
    },
    async hostEventsFor(ownerId, { topic, prefix }, since, limit, ids) {
      // A wildcard wake took every uncarried event under its prefix, however old and whoever it named: a wake on
      // research-publication:* replayed ten unrelated 12-hour-old events (808b7b3f, 2026-10-28).
      const names = `EXISTS (SELECT 1 FROM unnest($6::text[]) i WHERE strpos(':' || substr(topic, strpos(topic, ':') + 1) || ':', ':' || i || ':') > 0)`;
      // Progress (a job queued or started) never fires a wake, even on the wake's own topic: a wait on gpurun:<id>:<job>
      // fired at once on the job's start while its model was still downloading (2026-10-30). It rides along coalesced.
      return (await q(`SELECT * FROM host_event WHERE owner_id = $1 AND (topic = $2 OR ($3 AND starts_with(topic, $2)))
        AND body->'progress' IS DISTINCT FROM 'true'::jsonb
        AND (arrived_at >= $4 OR (consumed_at IS NULL AND (NOT $3 OR (arrived_at >= ${nowMs} - ${ADDRESSED_MAX_AGE_MS} AND ${names}))))
        ORDER BY ${names} DESC, arrived_at, id LIMIT $5`, [ownerId, topic, prefix, since, limit, ids]))
        .map(toHostEvent);
    },
    async topicHistory(ownerId, topic) {
      const [exact, under] = await Promise.all([
        q(`SELECT * FROM host_event WHERE owner_id = $1 AND topic = $2 ORDER BY arrived_at DESC LIMIT 1`, [ownerId, topic]),
        q(`SELECT * FROM host_event WHERE owner_id = $1 AND starts_with(topic, $2 || ':') ORDER BY arrived_at DESC LIMIT 1`, [ownerId, topic]),
      ]);
      return { exact: exact[0] ? toHostEvent(exact[0]) : null, under: under[0] ? toHostEvent(under[0]) : null };
    },
    async addressedEventsFor(ownerId, address, since, limit) {
      return (await q(`SELECT * FROM host_event WHERE ${ADDRESSED} ORDER BY arrived_at DESC, id DESC LIMIT $5`, [ownerId, address.ids, address.goals, since, limit])).map(toHostEvent).reverse();
    },
    async fireWake(id, carry, describe) {
      return tx(async t => {
        const wake = (await t(`SELECT owner_id FROM wake WHERE id = $1 AND status = 'pending' FOR UPDATE`, [id]))[0];
        if (!wake) return null;
        const own = carry.own.map(e => e.id);
        const params = [wake.owner_id, carry.addressed.address.ids, carry.addressed.address.goals, carry.addressed.since, own];
        // Newest first, so a backlog never crowds out what just arrived (2026-10-29: a wake fired by a job's new event
        // carried ten 2-hour-old events instead, and left the new one for the next wake).
        const scanned = (await t(`SELECT * FROM host_event WHERE ${ADDRESSED} AND NOT (id = ANY($5::text[])) ORDER BY arrived_at DESC, id DESC LIMIT $6 FOR UPDATE`, [...params, carry.scan])).map(toHostEvent).reverse();
        const { full: addressed, brief } = carry.split(scanned);
        const taken = [...own, ...addressed.map(e => e.id), ...brief.map(e => e.id)];
        const waiting = Number((await t(`SELECT count(*) AS n FROM host_event WHERE ${ADDRESSED} AND NOT (id = ANY($5::text[]))`, [...params.slice(0, 4), taken]))[0]!.n);
        const s = describe({ own: carry.own, addressed, brief, waiting });
        if (!s) return null;
        const now = Date.now();
        await t(`UPDATE host_event SET consumed_at = $3 WHERE owner_id = $1 AND id = ANY($2::text[]) AND consumed_at IS NULL`, [wake.owner_id, taken, now]);
        return toWake((await t(`UPDATE wake SET status = $2, reason = $3, detail = $4, settled_at = $5 WHERE id = $1 RETURNING *`, [id, s.status, s.reason, s.detail, now]))[0]!);
      });
    },
    async pruneHostEvents(before) {
      return (await q(`DELETE FROM host_event WHERE arrived_at < $1 RETURNING id`, [before])).length;
    },
    async settleWake(id, s) {
      const r = (await q(`UPDATE wake SET status = $2, reason = $3, detail = $4, settled_at = $5 WHERE id = $1 AND status = 'pending' RETURNING *`, [id, s.status, s.reason, s.detail, Date.now()]))[0];
      return r ? toWake(r) : null;
    },
    async getHeartbeat(agentId) {
      const r = (await q('SELECT at, checked_at, error_id, goals, workers, alerts, checklist, shown_full_at, alerts_shown FROM agent_heartbeat WHERE agent_id = $1', [agentId]))[0];
      return r ? { at: Number(r.at), checkedAt: Number(r.checked_at), errorId: Number(r.error_id), goals: r.goals, workers: r.workers, alerts: r.alerts, checklist: r.checklist, shownFullAt: r.shown_full_at === null ? null : Number(r.shown_full_at), alertsShown: r.alerts_shown } : null;
    },
    async saveHeartbeat(agentId, state) {
      await q(`INSERT INTO agent_heartbeat (agent_id, at, checked_at, error_id, goals, workers, alerts, checklist, shown_full_at, alerts_shown) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        ON CONFLICT (agent_id) DO UPDATE SET at = EXCLUDED.at, checked_at = EXCLUDED.checked_at, error_id = EXCLUDED.error_id, goals = EXCLUDED.goals,
          workers = EXCLUDED.workers, alerts = EXCLUDED.alerts, checklist = EXCLUDED.checklist, shown_full_at = EXCLUDED.shown_full_at, alerts_shown = EXCLUDED.alerts_shown`,
        [agentId, state.at, state.checkedAt, state.errorId, JSON.stringify(state.goals), JSON.stringify(state.workers), JSON.stringify(state.alerts), state.checklist, state.shownFullAt, JSON.stringify(state.alertsShown)]);
    },
    async heartbeatForgotten(agentId) {
      await q('UPDATE agent_heartbeat SET shown_full_at = NULL WHERE agent_id = $1', [agentId]);
    },

    // ---------- conversations ----------
    async createConversation(c) {
      const id = randomUUID(), now = Date.now();
      const members = [...new Set([c.ownerId, ...c.memberIds])];
      await tx(async t => {
        await t(`INSERT INTO conversation (id, title, owner_id, agent_id, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $5)`,
          [id, c.title, c.ownerId, c.agentId ?? null, now]);
        await t('INSERT INTO member (conversation_id, person_id) SELECT $1, unnest($2::text[])', [id, members]);
        if (c.groupId) await t('UPDATE member SET group_id = $3 WHERE conversation_id = $1 AND person_id = $2', [id, c.ownerId, c.groupId]);
        await settleColors(t, id);
      });
      return (await store.getConversation(id, c.ownerId))!;
    },
    async getConversation(id, forPersonId) {
      const r = (await q(`${SUMMARY} WHERE c.id = $2`, [forPersonId, id]))[0];
      return r ? toSummary(r) : null;
    },
    async conversationMembers(id) {
      return (await q('SELECT person_id FROM member WHERE conversation_id = $1 ORDER BY person_id', [id])).map(r => r.person_id);
    },
    async listConversations(forPersonId, opts = {}) {
      const rows = await q(`${SUMMARY} WHERE me.person_id IS NOT NULL AND ($4 OR c.archived = $2) ORDER BY c.updated_at DESC LIMIT $3`,
        [forPersonId, opts.archived ?? false, opts.limit ?? 500, opts.includeArchived === true]);
      return rows.map(toSummary);
    },
    async sharedConversations(forPersonId, opts) {
      const rows = await q(`${SUMMARY} WHERE me.person_id IS NOT NULL AND c.agent_id IS NULL AND ($2 OR NOT c.archived)
        AND ((SELECT count(*) FROM member m JOIN person p ON p.id = m.person_id AND p.kind = 'human' WHERE m.conversation_id = c.id) >= 2
          OR EXISTS (SELECT 1 FROM message WHERE conversation_id = c.id AND notice = 'membership'))
        ORDER BY c.updated_at DESC`, [forPersonId, opts.includeArchived]);
      return rows.map(toSummary);
    },
    async leaveConversation(id, personId) {
      return tx(async t => {
        const room = (await t('SELECT agent_id FROM conversation WHERE id = $1 FOR UPDATE', [id]))[0] ?? fail('not_found', 'Conversation not found');
        if (room.agent_id) fail('conflict', 'An agent chat cannot be left');
        if (!(await t('DELETE FROM member WHERE conversation_id = $1 AND person_id = $2 RETURNING 1', [id, personId])).length) return null;
        const person = (await t('SELECT name FROM person WHERE id = $1', [personId]))[0]!;
        const now = Date.now();
        const rows = await t(`WITH c AS (UPDATE conversation SET last_seq = last_seq + 1, updated_at = $4 WHERE id = $2 RETURNING last_seq)
          INSERT INTO message (id, conversation_id, seq, author_id, role, notice, display, text, parts, state, created_at, updated_at)
          SELECT $1, $2, c.last_seq, $3, 'notice', 'membership', 'shown', $5, '[]'::jsonb, 'done', $4, $4 FROM c RETURNING *`,
          [randomUUID(), id, personId, now, `${person.name} left`]);
        return toMessage(rows[0]!);
      });
    },
    async updateConversation(id, forPersonId, patch) {
      await tx(async t => {
        if (!(await t('SELECT id FROM conversation WHERE id = $1 FOR UPDATE', [id])).length) fail('not_found', 'Conversation not found');
        const params: unknown[] = [id, Date.now()];
        const sets = assignments(patch, { title: 'title', titleLocked: 'title_locked', archived: 'archived' }, params);
        const membersChange = !!(patch.addMemberIds?.length || patch.removeMemberIds?.length);
        if (sets.length || membersChange) await t(`UPDATE conversation SET ${['updated_at = $2', ...sets].join(', ')} WHERE id = $1`, params);
        if (patch.archived !== undefined) await t('UPDATE agent SET archived=$2,updated_at=$3 WHERE conversation_id=$1',[id,patch.archived,Date.now()]);
        if (patch.addMemberIds?.length)
          await t('INSERT INTO member (conversation_id, person_id) SELECT $1, unnest($2::text[]) ON CONFLICT DO NOTHING', [id, patch.addMemberIds]);
        if (patch.removeMemberIds?.length)
          await t('DELETE FROM member WHERE conversation_id = $1 AND person_id = ANY($2::text[])', [id, patch.removeMemberIds]);
        const own: unknown[] = [id, forPersonId];
        const mine = assignments(patch, { readThrough: 'read_through', groupId: 'group_id', color: 'color', memberColors: 'member_colors', emoji: 'emoji', pinnedAt: 'pinned_at', keyDate: 'key_date', keyLabel: 'key_label', project: 'project', statusLine: 'status_line', projectId: 'project_id' }, own);
        if (mine.length && !(await t(`UPDATE member SET ${mine.join(', ')} WHERE conversation_id = $1 AND person_id = $2 RETURNING 1`, own)).length)
          fail('forbidden', 'Only a member can organise a conversation');
        await settleColors(t, id);
      });
      return (await store.getConversation(id, forPersonId))!;
    },
    async remoteOrganisation(personId) {
      return new Map((await q('SELECT * FROM remote_member WHERE person_id = $1', [personId])).map(r => [r.conversation_id as string, toOrganisation(r)]));
    },
    async organiseRemote(personId, conversationId, patch) {
      const params: unknown[] = [conversationId, personId];
      const sets = assignments(patch, ORGANISATION, params);
      return tx(async t => {
        await t('INSERT INTO remote_member (conversation_id, person_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [conversationId, personId]);
        const rows = sets.length ? await t(`UPDATE remote_member SET ${sets.join(', ')} WHERE conversation_id = $1 AND person_id = $2 RETURNING *`, params)
          : await t('SELECT * FROM remote_member WHERE conversation_id = $1 AND person_id = $2', params);
        return toOrganisation(rows[0]!);
      });
    },

    // ---------- messages ----------
    async appendMessage(m) {
      // One statement: bump last_seq (row lock serialises concurrent appends) and insert with that seq.
      const now = Date.now();
      const files = shownFiles(m.parts ?? []);
      const params: unknown[] = [m.id ?? randomUUID(), m.conversationId, m.authorId, m.role, m.text, stripNul(m.parts ?? []), m.state ?? 'done', m.clientId ?? null, now, m.role === 'notice' ? m.notice : null, displayOf(m)];
      const insert = `WITH c AS (UPDATE conversation SET last_seq = last_seq + 1, updated_at = $9 WHERE id = $2 RETURNING last_seq),
        m AS (INSERT INTO message (id, conversation_id, seq, author_id, role, notice, display, text, parts, state, client_id, created_at, updated_at)
        SELECT $1, $2, c.last_seq, $3, $4, $10, $11, $5, $6, $7, $8, $9, $9 FROM c RETURNING *)`;
      const rows = files.length
        ? await q(`${insert}, f AS (${linkFiles(12)}) SELECT * FROM m`, [...params, files])
        : await q(`${insert} SELECT * FROM m`, params);
      return toMessage(rows[0] ?? fail('not_found', 'Conversation not found'));
    },
    async sealGuess(input) {
      return tx(async t => {
        const existing = (await t(`SELECT m.* FROM sealed_guess s JOIN message m ON m.id = s.id WHERE s.author_id = $1 AND s.call_id = $2`, [input.authorId, input.callId]))[0];
        if (existing) return toMessage(existing);
        const room = (await t(`SELECT c.id FROM conversation c WHERE c.id = $1 AND NOT c.archived
          AND EXISTS (SELECT 1 FROM member WHERE conversation_id = c.id AND person_id = $2)
          AND EXISTS (SELECT 1 FROM member WHERE conversation_id = c.id AND person_id = $3)`, [input.conversationId, input.ownerId, input.authorId]))[0];
        if (!room) fail('not_found', 'seal_chat_not_found: choose an open chat you and your person belong to');
        const id = randomUUID(), salt = randomBytes(32).toString('hex'), topic = input.topic ?? null, hash = guessHash(salt, input.guess, topic);
        const at = Number((await t(`SELECT ${nowMs} AS at`))[0]!.at);
        const part: MessagePart = { type: 'seal', id, topic, hash, sealedAt: at, reveal: null };
        const row = (await t(`WITH c AS (UPDATE conversation SET last_seq = last_seq + 1, updated_at = $4 WHERE id = $2 RETURNING last_seq)
          INSERT INTO message (id, conversation_id, seq, author_id, role, notice, display, text, parts, state, created_at, updated_at)
          SELECT $1, $2, c.last_seq, $3, 'assistant', NULL, 'shown', '', $5, 'done', $4, $4 FROM c RETURNING *`,
          [id, input.conversationId, input.authorId, at, JSON.stringify([part])]))[0]!;
        await t(`INSERT INTO sealed_guess (id, owner_id, author_id, call_id, guess, salt, hash, sealed_at, topic) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [id, input.ownerId, input.authorId, input.callId, input.guess, salt, hash, at, topic]);
        return toMessage(row);
      });
    },
    async revealGuess(ownerId, id, score) {
      if (!/^(?:[0-9a-f]{8}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.test(id)) fail('invalid_input', 'seal_id_invalid: use the full id or its first 8 characters');
      return tx(async t => {
        const rows = await t(`SELECT m.*, s.guess, s.salt, s.hash, s.topic, s.sealed_at FROM sealed_guess s JOIN message m ON m.id = s.id
          WHERE (s.id::text = $1 OR (length($1) = 8 AND left(s.id::text, 8) = $1)) AND s.owner_id = $2 LIMIT 2 FOR UPDATE OF m`, [id.toLowerCase(), ownerId]);
        if (rows.length > 1) fail('invalid_input', 'seal_id_ambiguous: more than one seal matches; use the full id');
        const row = rows[0] ?? fail('not_found', 'seal_not_found: no seal matches this id');
        const old = (row.parts as MessagePart[]).find(p => p.type === 'seal') ?? fail('invalid_input', 'seal_card_missing');
        const verified = old.id === row.id && (old.topic ?? null) === row.topic && old.hash === row.hash && old.sealedAt === Number(row.sealed_at) && guessHash(row.salt, row.guess, row.topic) === old.hash;
        if (old.reveal) {
          if (score !== undefined && old.reveal.score !== score) fail('invalid_input', 'seal_already_revealed: the original reveal and score cannot be changed');
          return toMessage(row);
        }
        const at = Number((await t(`SELECT ${nowMs} AS at`))[0]!.at);
        const part: MessagePart = { ...old, reveal: { guess: row.guess, salt: row.salt, revealedAt: at, verified, score: score ?? null } };
        return toMessage((await t(`UPDATE message SET parts = $2, updated_at = $3 WHERE id = $1 RETURNING *`, [row.id, JSON.stringify([part]), at]))[0]!);
      });
    },
    async listSealedGuesses(ownerId, conversationId) {
      return (await q(`SELECT m.* FROM sealed_guess s JOIN message m ON m.id = s.id WHERE s.owner_id = $1 AND m.conversation_id = $2 ORDER BY s.sealed_at DESC LIMIT 50`, [ownerId, conversationId])).map(toMessage);
    },
    async admitHumanMessage(a) {
      const now = Date.now(), files = shownFiles(a.parts);
      const sql = `WITH conv AS (
          SELECT c.id, c.title, c.owner_id, c.agent_id, c.archived, me.color, me.member_colors, me.emoji, me.pinned_at, me.key_date, me.key_label, c.title_locked, coalesce(me.project, false) AS project, me.status_line, me.project_id, coalesce(me.read_through, 0) AS read_through, me.group_id, me.person_id IS NOT NULL AS member,
            (SELECT coalesce(array_agg(p.person_id ORDER BY p.person_id), '{}') FROM member p WHERE p.conversation_id = c.id) AS member_ids
          FROM conversation c LEFT JOIN member me ON me.conversation_id = c.id AND me.person_id = $3 WHERE c.id = $2),
        existing AS (SELECT * FROM message WHERE client_id = $6),
        c AS (UPDATE conversation SET last_seq = last_seq + 1, updated_at = $7 WHERE id = $2
          AND EXISTS (SELECT 1 FROM conv WHERE member AND NOT archived) AND NOT EXISTS (SELECT 1 FROM existing) RETURNING last_seq),
        m AS (INSERT INTO message (id, conversation_id, seq, author_id, role, notice, display, text, parts, state, client_id, created_at, updated_at)
          SELECT $1, $2, c.last_seq, $3, 'human', NULL, 'shown', $4, $5, 'done', $6, $7, $7 FROM c RETURNING *)
        ${files.length ? `, f AS (${linkFiles(8)})` : ''}
        SELECT (SELECT to_jsonb(conv) FROM conv) AS conv, (SELECT to_jsonb(existing) FROM existing) AS existing, (SELECT to_jsonb(m) FROM m) AS inserted`;
      const r = (await q(sql, [randomUUID(), a.conversationId, a.authorId, a.text, stripNul(a.parts), a.clientId, now, ...(files.length ? [files] : [])]))[0]!;
      const conv = r.conv as Row | null, existing = r.existing as Row | null, inserted = r.inserted as Row | null;
      if (!conv) return { kind: 'not_found' };
      if (!conv.member) return { kind: 'forbidden' };
      if (existing) return existing.conversation_id === conv.id ? { kind: 'duplicate', message: toMessage(existing) } : { kind: 'client_id_taken' };
      if (conv.archived) return { kind: 'archived' };
      if (!inserted) throw new Error(`admitHumanMessage: conversation ${a.conversationId} admitted nothing`);
      const message = toMessage(inserted);
      return { kind: 'admitted', message, conversation: toSummary({ ...conv, last_seq: message.seq, updated_at: message.createdAt,
        lm_author: a.authorId, lm_preview: a.text.slice(0, 140), lm_at: message.createdAt, lm_seq: message.seq }) };
    },
    async updateMessage(id, patch) {
      const params: unknown[] = [id, Date.now()];
      const sets = assignments(patch, { text: 'text', parts: 'parts', state: 'state', display: 'display', backgroundSummary: 'background_summary' }, params);
      const files = shownFiles(patch.parts ?? []);
      const update = `WITH m AS (UPDATE message SET ${['updated_at = $2', ...sets].join(', ')} WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM sealed_guess WHERE sealed_guess.id = message.id) RETURNING *)`;
      const rows = files.length
        ? await q(`${update}, f AS (${linkFiles(params.length + 1)}) SELECT * FROM m`, [...params, files])
        : await q(`${update} SELECT * FROM m`, params);
      return toMessage(rows[0] ?? fail('not_found', 'Message not found'));
    },
    async rewriteMessage(message, text) {
      return tx(async t => {
        const row = (await t('SELECT * FROM message WHERE id = $1 AND conversation_id = $2 FOR UPDATE', [message.id, message.conversationId]))[0] ?? fail('not_found', 'Message not found');
        if (row.deleted_at != null) {
          if (text === null) return toMessage(row);
          return fail('conflict', 'Deleted messages cannot be edited');
        }
        const original = toMessage(row), now = Math.max(Date.now(), Number(row.updated_at) + 1);
        const replacement = text ?? '[message deleted]';
        let rewritten: Row;
        if (text === null) {
          await t('DELETE FROM message WHERE id = $1', [row.id]);
          rewritten = (await t(`INSERT INTO message (id, conversation_id, seq, author_id, role, notice, display, text, parts, state, client_id, created_at, updated_at, edited_at, deleted_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'done', $10, $11, $12, $13, $12) RETURNING *`,
          [row.id, row.conversation_id, row.seq, row.author_id, row.role, row.notice, row.display, replacement, JSON.stringify([{ type: 'text', text: replacement }]), row.client_id, row.created_at, now, row.edited_at]))[0]!;
        } else {
          const parts: MessagePart[] = [{ type: 'text', text }, ...original.parts.filter(part => part.type !== 'text')];
          rewritten = (await t(`UPDATE message SET text = $2, parts = $3, background_summary = NULL, edited_at = $4, updated_at = $4 WHERE id = $1 RETURNING *`, [row.id, text, JSON.stringify(parts), now]))[0]!;
        }
        await scrubMessageCopies(t, original, replacement, true);
        await t('UPDATE conversation SET updated_at = greatest(updated_at + 1, $2) WHERE id = $1', [row.conversation_id, now]);
        return toMessage(rewritten);
      });
    },
    async scrubMessageCopies(message, replacement) {
      await tx(t => scrubMessageCopies(t, message, replacement));
    },
    async claimBackgroundSummary(id, fallback) {
      const r = (await q("UPDATE message SET background_summary = $2, updated_at = $3 WHERE id = $1 AND background_summary IS NULL AND display = 'background' AND role = 'notice' RETURNING *", [id, fallback, Date.now()]))[0];
      return r ? toMessage(r) : null;
    },
    async getMessageByClientId(clientId) {
      const r = (await q('SELECT * FROM message WHERE client_id = $1', [clientId]))[0];
      return r ? toMessage(r) : null;
    },
    searchMessages: (personId, query) => searchMessages(pool, personId, query),
    async listMessages(conversationId, cursor, limit) {
      if (cursor.kind === 'around') {
        const target = (await q(`SELECT seq FROM message WHERE conversation_id = $1 AND ${typeof cursor.target === 'number' ? 'seq' : 'id'} = $2`, [conversationId, cursor.target]))[0] ?? fail('not_found', 'Message not found');
        const before = Math.floor((limit - 1) / 2);
        const rows = await q(`(SELECT * FROM message WHERE conversation_id = $1 AND seq < $2 ORDER BY seq DESC LIMIT $3)
          UNION ALL (SELECT * FROM message WHERE conversation_id = $1 AND seq >= $2 ORDER BY seq ASC LIMIT $4) ORDER BY seq`,
          [conversationId, target.seq, before, limit - before]);
        const first = rows[0]!.seq, last = rows[rows.length - 1]!.seq;
        const flags = (await q(`SELECT EXISTS(SELECT 1 FROM message WHERE conversation_id = $1 AND seq < $2) AS older,
          EXISTS(SELECT 1 FROM message WHERE conversation_id = $1 AND seq > $3) AS newer`, [conversationId, first, last]))[0]!;
        return { messages: rows.map(toMessage), hasOlder: flags.older, hasNewer: flags.newer };
      }
      const newestFirst = cursor.kind !== 'after';
      const rows = await q(`SELECT * FROM message WHERE conversation_id = $1 AND ($2::bigint IS NULL OR seq < $2) AND ($3::bigint IS NULL OR seq > $3) ORDER BY seq ${newestFirst ? 'DESC' : 'ASC'} LIMIT $4`,
        [conversationId, cursor.kind === 'before' ? cursor.seq : null, cursor.kind === 'after' ? cursor.seq : null, limit + 1]);
      const more = rows.length > limit;
      const page = rows.slice(0, limit);
      if (newestFirst) page.reverse();
      const beyond = async (sql: string, seq: number) => (await q(`SELECT EXISTS (SELECT 1 FROM message WHERE conversation_id = $1 AND seq ${sql} $2) AS found`, [conversationId, seq]))[0]!.found as boolean;
      const messages = page.map(toMessage);
      switch (cursor.kind) {
        case 'latest': return { messages, hasOlder: more, hasNewer: false };
        case 'before': return { messages, hasOlder: more, hasNewer: await beyond('>=', cursor.seq) };
        case 'after': return { messages, hasOlder: await beyond('<=', cursor.seq), hasNewer: more };
      }
    },
    async recentWork(conversationIds, shape) {
      const rows = await q(RECENT_WORK, [conversationIds, RECENT_WINDOW, shape.said, shape.did, shape.chars]);
      const work = new Map<string, RecentWork>();
      for (const r of rows) {
        const entry = work.get(r.conversation_id) ?? { lastActivityAt: 0, said: [], did: [] };
        work.set(r.conversation_id, entry);
        if (r.kind === 'last') entry.lastActivityAt = r.at;
        else if (r.kind === 'said') entry.said.push({ at: r.at, text: r.text, textLength: r.text_length, thinking: r.thinking ?? '' });
        else entry.did.push({ at: r.at, updatedAt: r.updated_at, running: r.state === 'streaming', isError: r.state === 'error', name: r.name ?? '', args: r.args ?? '', argsLength: r.args_length ?? 0, head: r.head ?? '', tail: r.tail ?? '', outLength: r.out_length ?? 0 });
      }
      return work;
    },
    async getMessage(conversationId, id) {
      const r = (await q('SELECT * FROM message WHERE id = $1 AND conversation_id = $2', [id, conversationId]))[0];
      return r ? toMessage(r) : null;
    },

    // ---------- goals ----------
    async createGoal(g) {
      const long = titleRefusal('title', g.title);
      if (long) throw new Error(long);
      const id = randomUUID(), now = Date.now();
      await q(`INSERT INTO goal (id, owner_id, title, detail, priority, chat_id, category, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $7, $8, $6, $6)`,
        [id, g.ownerId, g.title, g.detail ?? '', g.priority ?? 100, now, g.chatId ?? null, g.category ?? 'work']);
      return toGoal(await one(`${GOAL} WHERE g.id = $1`, [id], 'Goal'));
    },
    async updateGoal(id, { notes, ...patch }) {
      const long = patch.title === undefined ? null : titleRefusal('title', patch.title);
      if (long) throw new Error(long);
      const params: unknown[] = [id, Date.now()];
      const sets = assignments(patch, { title: 'title', detail: 'detail', status: 'status', priority: 'priority', chatId: 'chat_id', category: 'category' }, params);
      if (notes) { params.push(notes.kind === 'replace' ? notes.text : datedNote(notes.entry, Date.now())); sets.push(notes.kind === 'replace' ? `notes = $${params.length}` : prependNote(params.length)); }
      await tx(async t => {
        if (!(await t(`UPDATE goal SET ${['updated_at = $2', ...sets].join(', ')} WHERE id = $1 RETURNING id`, params)).length) fail('not_found', 'Goal not found');
        // Attaching a chat moves the goal's running work there: its manager-launched workers and the triggers held for it.
        if (typeof patch.chatId === 'string') {
          await t(`UPDATE agent a SET origin_conversation_id = $2, updated_at = $3 WHERE a.goal_id = $1 AND NOT a.archived
            AND EXISTS (SELECT 1 FROM agent p WHERE p.id = a.parent_agent_id AND p.role = 'manager')`, [id, patch.chatId, Date.now()]);
          await t(`UPDATE wake SET origin_conversation_id = $2 WHERE goal_id = $1 AND status = 'pending'`, [id, patch.chatId]);
        }
      });
      return toGoal(await one(`${GOAL} WHERE g.id = $1`, [id], 'Goal'));
    },
    async getGoal(ownerId, id) {
      const r = (await q(`${GOAL} WHERE g.owner_id = $1 AND g.id::text = $2`, [ownerId, id]))[0];
      return r ? toGoal(r) : null;
    },
    async goalsMatching(ownerId, ref) {
      return (await q(`${GOAL} WHERE g.owner_id = $1 AND (g.id::text = $2 OR (length($2) >= 8 AND starts_with(lower(g.id::text), lower($2))))`, [ownerId, ref])).map(toGoal);
    },
    async goalsWithRecentReport(ownerId, since) {
      return (await q(`${GOAL} WHERE g.owner_id = $1 AND g.status <> 'dropped' AND EXISTS (
        SELECT 1 FROM agent a WHERE a.goal_id = g.id AND a.owner_id = $1 AND a.role = 'worker' AND NOT a.archived
          AND a.last_report->>'status' = 'done' AND (a.last_report->>'at')::bigint >= $2
      ) ORDER BY g.priority, g.created_at`, [ownerId, since])).map(toGoal);
    },
    async goalSummaries(ownerId, ids) {
      return (await q('SELECT id, title, status, category FROM goal WHERE owner_id = $1 AND id = ANY($2::uuid[]) ORDER BY priority, created_at', [ownerId, ids])).map(r => ({ id: r.id, title: r.title, status: r.status, category: r.category }));
    },
    async listGoals(ownerId, status, filter) {
      return (await q(`${GOAL} WHERE g.owner_id = $1 AND ($2::text IS NULL OR g.status = $2)
        ${filter ? 'AND g.created_at >= $3 AND strpos(g.notes, $4) > 0' : ''}
        ORDER BY g.priority, g.created_at`, [ownerId, status ?? null, ...(filter ? [filter.createdSince, filter.notesContaining] : [])])).map(toGoal);
    },

    // ---------- files ----------
    async createFile(f) {
      const id = randomUUID();
      await q('INSERT INTO file (id, owner_id, name, mime, size, path, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)',
        [id, f.ownerId, f.name, f.mime, f.size, f.path, Date.now()]);
      return { id };
    },
    async getFile(id) {
      const r = (await q('SELECT id, owner_id, name, mime, size, path FROM file WHERE id = $1', [id]))[0];
      return r ? toFile(r) : null;
    },
    async fileAt(ownerId, path) {
      const r = (await q('SELECT id, owner_id, name, mime, size, path FROM file WHERE owner_id = $1 AND path = $2 ORDER BY created_at LIMIT 1', [ownerId, path]))[0];
      return r ? toFile(r) : null;
    },
    async visibleFile(personId, id) {
      const r = (await q(`SELECT id, owner_id, name, mime, size, path FROM file f WHERE f.id = $1 AND (f.owner_id = $2 OR EXISTS (
        SELECT 1 FROM conversation_file cf JOIN member mb ON mb.conversation_id = cf.conversation_id AND mb.person_id = $2 WHERE cf.file_id = f.id))`, [id, personId]))[0];
      return r ? toFile(r) : null;
    },

    // ---------- latency ----------
    async recordLatency(r) {
      await q(`INSERT INTO latency (message_id, conversation_id, client_sent_at, received_at, admitted_at) VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (message_id) DO NOTHING`, [r.messageId, r.conversationId, r.clientSentAt, r.receivedAt, r.admittedAt]);
    },
    async markLatency(messageId, field, at) {
      if (!LATENCY_FIELDS.includes(field)) fail('invalid_input', `Unknown latency field ${field}`);
      await q(`UPDATE latency SET ${field} = $2 WHERE message_id = $1 AND ${field} IS NULL`, [messageId, at]);
    },
    async latencyReport(windowMs) {
      const r = (await q(LATENCY_SQL, [Date.now() - windowMs]))[0]!;
      const intervals = Object.fromEntries(Object.keys(LATENCY_INTERVALS).map(k =>
        [k, { p50: r[`${k}_p50`], p90: r[`${k}_p90`], p99: r[`${k}_p99`], max: r[`${k}_max`] }])) as LatencyReport['intervals'];
      return { windowMs, count: r.count, intervals };
    },

    // ---------- usage ----------
    async recordModelCall(c) {
      await q(`INSERT INTO model_call (agent_id, model, input_tokens, output_tokens, cache_read, cache_write, cost_usd, at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, [c.agentId, c.model, c.inputTokens, c.outputTokens, c.cacheRead, c.cacheWrite, c.costUsd, c.at]);
    },
    async personSpend(ownerId, sinceMs) {
      const rows = await q(`SELECT coalesce(sum(m.cost_usd), 0) AS usd FROM model_call m
        JOIN agent a ON a.id = m.agent_id WHERE a.owner_id = $1 AND m.at >= $2`, [ownerId, sinceMs]);
      return Number(rows[0]!.usd);
    },
    async spend(sinceMs) {
      const byAgent = (await q('SELECT agent_id, sum(cost_usd) AS usd FROM model_call WHERE at >= $1 GROUP BY agent_id ORDER BY usd DESC', [sinceMs]))
        .map(r => ({ agentId: r.agent_id as string, usd: r.usd as number }));
      return { totalUsd: byAgent.reduce((s, a) => s + a.usd, 0), byAgent };
    },
    async cacheGroups(sinceMs, dayStart, hourStart, thresholds) {
      const rows = await q(`SELECT agent_id, model, CASE WHEN at >= $3 THEN 0 WHEN at >= $2 THEN 1 ELSE 2 END AS period,
          (SELECT count(*) FROM unnest($4::int8[]) t WHERE input_tokens + cache_read + cache_write > t)::int AS tier,
          count(*)::int AS calls, sum(input_tokens)::float8 AS input, sum(cache_read)::float8 AS cache_read,
          sum(cache_write)::float8 AS cache_write, sum(cost_usd)::float8 AS cost_usd
        FROM model_call WHERE at >= $1 GROUP BY 1, 2, 3, 4`, [sinceMs, dayStart, hourStart, thresholds]);
      return rows.map(r => ({ agentId: r.agent_id, model: r.model, period: r.period, tier: r.tier, calls: r.calls, input: r.input, cacheRead: r.cache_read, cacheWrite: r.cache_write, costUsd: r.cost_usd }));
    },
    async recordUsageSamples(source, samples, keepSinceMs) {
      const column = <K extends keyof UsageSample>(key: K) => samples.map(sample => sample[key]);
      await q(`INSERT INTO usage_sample (source, provider, metric, account, percent_left, reset_at, window_hours, reading_at, at)
        SELECT $1, * FROM unnest($2::text[], $3::text[], $4::text[], $5::float8[], $6::int8[], $7::float8[], $8::int8[], $9::int8[])`,
        [source, column('provider'), column('metric'), column('account'), column('percentLeft'), column('resetAt'), column('windowHours'), column('readingAt'), column('at')]);
      await q('DELETE FROM usage_sample WHERE source = $1 AND at < $2', [source, keepSinceMs]);
    },
    async usageSamples(source, sinceMs) {
      return (await q(`SELECT provider, metric, account, percent_left, reset_at, window_hours, reading_at, at FROM usage_sample WHERE source = $1 AND at >= $2 ORDER BY at, reading_at`,
        [source, sinceMs])).map(r => ({ provider: r.provider, metric: r.metric, account: r.account, percentLeft: r.percent_left, resetAt: r.reset_at, windowHours: r.window_hours, readingAt: r.reading_at, at: r.at }));
    },

    // ---------- phone notifications ----------
    async notificationZoneOf(personId) { return (await q('SELECT coalesce(phone_time_zone, time_zone) AS zone FROM person WHERE id=$1', [personId]))[0]?.zone ?? null; },
    async quietHours(personId) {
      const r = (await q('SELECT quiet_hours FROM person WHERE id=$1', [personId]))[0] ?? fail('not_found', 'Unknown person');
      return r.quiet_hours;
    },
    async setQuietHours(personId, value) { await q('UPDATE person SET quiet_hours=$2 WHERE id=$1', [personId, value]); },
    async holdNotification(personId, id) { await q('UPDATE notification SET quiet_held=true WHERE person_id=$1 AND id=$2', [personId, id]); },
    async claimQuietSummary(personId) {
      const r = (await q(`WITH held AS (UPDATE notification SET quiet_summarized=true WHERE person_id=$1 AND quiet_held AND NOT quiet_summarized RETURNING id, collapse_key, dismissed)
        SELECT count(DISTINCT coalesce(collapse_key, id::text))::integer AS count FROM held WHERE NOT dismissed`, [personId]))[0]!;
      return r.count;
    },
    async createNotification(n) {
      return notificationRow((await q(`INSERT INTO notification (person_id, agent_id, conversation_id, title, body, level, image_file_id, created_at, collapse_key, quiet_held) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
        [n.personId, n.agentId, n.conversationId, n.title, n.body, n.level, n.imageFileId, Date.now(), n.collapseKey ?? null, n.quietHeld ?? false]))[0]!);
    },
    async notificationsAfter(personId, afterId, sinceMs, limit) {
      return (await q('SELECT * FROM notification WHERE person_id = $1 AND NOT dismissed AND NOT quiet_held AND id > $2 AND created_at >= $3 ORDER BY id LIMIT $4', [personId, afterId, sinceMs, limit])).map(notificationRow);
    },

    async dismissNotifications(personId, conversationId) {
      const rows = await q(`WITH cleared AS (UPDATE notification SET dismissed = true WHERE person_id = $1 AND conversation_id = $2 AND NOT dismissed RETURNING id)
        SELECT max(id) AS through_id FROM notification WHERE person_id = $1 AND conversation_id = $2`, [personId, conversationId]);
      return rows[0]!.through_id;
    },
    async dismissedNotifications(personId) {
      return (await q(`SELECT conversation_id, max(id) AS through_id FROM notification WHERE person_id = $1 AND dismissed GROUP BY conversation_id`, [personId]))
        .map(r => ({ conversationId: r.conversation_id, throughId: r.through_id }));
    },

    async savePushSubscription(personId, s) {
      await q(`INSERT INTO push_subscription (endpoint, person_id, p256dh, auth, created_at) VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (endpoint) DO UPDATE SET person_id = EXCLUDED.person_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth, created_at = EXCLUDED.created_at`,
        [s.endpoint, personId, s.keys.p256dh, s.keys.auth, Date.now()]);
    },
    async pushSubscriptions(personId) {
      return (await q('SELECT endpoint, p256dh, auth FROM push_subscription WHERE person_id = $1 ORDER BY created_at', [personId])).map(r => ({ endpoint: r.endpoint, keys: { p256dh: r.p256dh, auth: r.auth } }));
    },
    async deletePushSubscription(endpoint, personId) {
      await q('DELETE FROM push_subscription WHERE endpoint = $1 AND ($2::text IS NULL OR person_id = $2)', [endpoint, personId]);
    },

    // ---------- errors ----------
    async createPeerOutbound(m) {
      const id = m.id ?? randomUUID();
      const row = (await q(`INSERT INTO peer_message (id, owner_id, peer_id, direction, from_agent, to_agent, text, created_at, origin_conversation_id) VALUES ($1, $2, $3, 'out', $4, $5, $6, $7, $8) ON CONFLICT (owner_id, id) DO NOTHING RETURNING *`, [id, m.ownerId, m.peerId, m.fromAgent, m.toAgent, m.text, Date.now(), m.originConversationId]))[0]
        ?? (await q('SELECT * FROM peer_message WHERE owner_id = $1 AND id = $2', [m.ownerId, id]))[0]!;
      const message = toPeer(row);
      if (message.direction !== 'out' || message.peerId !== m.peerId || message.fromAgent !== m.fromAgent || message.toAgent !== m.toAgent || message.text !== m.text) throw new Error('peer_message_conflict: id already used for a different message');
      return message;
    },
    async peerConversationOrigin(ownerId, peerId, agentId) {
      const r = (await q(`SELECT origin_conversation_id FROM peer_message WHERE owner_id = $1 AND peer_id = $2 AND direction = 'out' AND from_agent = $3 ORDER BY created_at DESC, id DESC LIMIT 1`, [ownerId, peerId, agentId]))[0];
      return r?.origin_conversation_id ?? null;
    },
    async receivePeerInbound(m) {
      const row = (await q(`INSERT INTO peer_message (id, owner_id, peer_id, direction, from_agent, to_agent, text, created_at) VALUES ($1, $2, $3, 'in', $4, $5, $6, $7) ON CONFLICT (owner_id, id) DO NOTHING RETURNING *`, [m.id, m.ownerId, m.peerId, m.fromAgent, m.toAgent, m.text, m.createdAt]))[0];
      return row ? toPeer(row) : null;
    },
    async getPeerInbound(ownerId, id) {
      const row = (await q("SELECT * FROM peer_message WHERE owner_id = $1 AND id = $2 AND direction = 'in'", [ownerId, id]))[0];
      return row ? toPeer(row) : null;
    },
    async peerOutbox(ownerId, peerId, limit) {
      return (await q(`SELECT * FROM peer_message WHERE owner_id = $1 AND peer_id = $2 AND direction = 'out' AND relayed_at IS NULL ORDER BY created_at, id LIMIT $3`, [ownerId, peerId, limit])).map(toPeer);
    },
    async ackPeerOutbound(ownerId, peerId, ids) {
      return (await q(`UPDATE peer_message SET relayed_at = $4 WHERE owner_id = $1 AND peer_id = $2 AND direction = 'out' AND relayed_at IS NULL AND id = ANY($3::uuid[]) RETURNING id`, [ownerId, peerId, ids, Date.now()])).map(r => r.id as string);
    },
    async peerHistory(ownerId, peerId, limit) {
      return (await q(`SELECT * FROM peer_message WHERE owner_id = $1 AND peer_id = $2 ORDER BY created_at DESC, id LIMIT $3`, [ownerId, peerId, limit])).map(toPeer);
    },
    async logError(scope, message) { await q('INSERT INTO error_log (scope, message, at) VALUES ($1, $2, $3)', [scope, boundedErrorLog(message), Date.now()]); },
    async errorsAfter(ownerId, afterId, limit) {
      return (await q(`SELECT e.id, e.scope, e.message, e.at FROM error_log e
        WHERE e.id > $2 AND (e.scope NOT LIKE 'agent:%' OR EXISTS (SELECT 1 FROM agent a WHERE a.owner_id = $1 AND e.scope = 'agent:' || a.id))
        ORDER BY e.id DESC LIMIT $3`, [ownerId, afterId, limit])) as LoggedError[];
    },

    // ---------- sessions ----------
    async createSession(s) {
      await q('DELETE FROM session WHERE expires_at < $1', [Date.now()]);
      await q('INSERT INTO session (id, person_id, expires_at, created_at) VALUES ($1, $2, $3, $4)', [s.id, s.personId, s.expiresAt, Date.now()]);
    },
    async getSession(id) {
      const r = (await q('SELECT id, person_id, expires_at FROM session WHERE id = $1', [id]))[0];
      return r ? { id: r.id, personId: r.person_id, expiresAt: r.expires_at } : null;
    },
    async deleteSession(id) { await q('DELETE FROM session WHERE id = $1', [id]); },
    async extendSession(id, expiresAt) { await q('UPDATE session SET expires_at = $2 WHERE id = $1', [id, expiresAt]); },
  };
  return store;
}
