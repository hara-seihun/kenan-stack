import { pageSize, pageKey, finishPage } from '../tools/pagination.js';
// Postgres implementation of Store. One pool, plain SQL, no triggers.
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { NOTICE_DISPLAY, type AgentInfo, type AgentState, type AgentWake, type ConversationSummary, type Goal, type LatencyReport, type Message, type MessageDisplay, type MessagePart, type Layout, type Person, type PhoneNotification } from '../../shared/contract.js';
import type { Admission, AgentInput, HostEvent, LatencyField, NewMessage, LoggedError, PeerMessage, RecentWork, Store, UsageSample, Wake } from '../types.js';
import { fail } from './errors.js';

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


/** shared/contract.ts `previewable` in SQL; schema.sql's message_preview index has the same predicate. */
const PREVIEWABLE = `display = 'shown' AND role <> 'tool' AND (btrim(text, E' \\t\\n\\r') <> '' OR parts @> '[{"type":"file"}]' OR parts @> '[{"type":"image"}]')`;
const SUMMARY = `
SELECT c.id, c.title, c.owner_id, c.agent_id, c.archived, c.color, c.emoji, c.pinned_at, c.key_date, c.key_label, c.title_locked, c.project, c.status_line, c.project_id, c.last_seq, c.updated_at,
  coalesce(me.read_through, 0) AS read_through,
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

const AGENT = `SELECT a.*, p.name, (SELECT coalesce(json_agg(json_build_object('at', w.at, 'on', coalesce(w.event->>'source', CASE w.listen WHEN 'addressed' THEN 'any' END), 'since', w.created_at, 'goalId', w.goal_id) ORDER BY w.at NULLS LAST, w.created_at), '[]')
  FROM wake w WHERE w.agent_id = a.id AND w.status = 'pending') AS wakes FROM agent a JOIN person p ON p.id = a.id`;
const GOAL = `SELECT g.*, (SELECT coalesce(array_agg(a.id ORDER BY a.created_at, a.id), '{}') FROM agent a WHERE a.goal_id = g.id) AS worker_ids FROM goal g`;

const toSummary = (r: Row): ConversationSummary => ({
  id: r.id, title: r.title, ownerId: r.owner_id, memberIds: r.member_ids, agentId: r.agent_id, archived: r.archived,
  color: r.color, emoji: r.emoji, pinnedAt: r.pinned_at, keyDate: r.key_date, keyLabel: r.key_label, titleLocked: r.title_locked, project: r.project, statusLine: r.status_line, projectId: r.project_id, lastSeq: r.last_seq, readThrough: r.read_through,
  lastMessage: r.lm_at == null ? null : { authorId: r.lm_author, preview: r.lm_preview, at: r.lm_at, seq: r.lm_seq },
  updatedAt: r.updated_at,
});
const displayOf = (m: NewMessage): MessageDisplay => {
  switch (m.role) {
    case 'human': return 'shown';
    case 'notice': return NOTICE_DISPLAY[m.notice];
    case 'assistant': case 'tool': return m.display;
  }
};
const toMessage = (r: Row): Message => ({
  id: r.id, conversationId: r.conversation_id, seq: r.seq, authorId: r.author_id, role: r.role, notice: r.notice, display: r.display, text: r.text,
  parts: r.parts, state: r.state, clientId: r.client_id, createdAt: r.created_at, updatedAt: r.updated_at, clipped: false,
});
const toAgent = (r: Row): AgentInfo => ({
  id: r.id, name: r.name, kind: 'agent', ownerId: r.owner_id, role: r.role, conversationId: r.conversation_id,
  parentAgentId: r.parent_agent_id, archived: r.archived, goalId: r.goal_id, state: r.state, model: r.model, thinking: r.thinking ?? null, createdAt: r.created_at, updatedAt: r.updated_at, lastReport: r.last_report,
  wakes: (r.wakes as { at: string | number | null; on: AgentWake['on']; since: string | number; goalId: string | null }[]).map(w => ({ at: w.at === null ? null : Number(w.at), on: w.on, since: Number(w.since), goalId: w.goalId }) as AgentWake),
});
const notificationRow = (r: Row): PhoneNotification => ({ id: r.id, title: r.title, body: r.body, level: r.level, imageFileId: r.image_file_id, agentId: r.agent_id, conversationId: r.conversation_id, createdAt: r.created_at });
const toWake = (r: Row): Wake => {
  const held = r.goal_id === null ? null : { goalId: r.goal_id, workerId: r.held_for, handoff: r.handoff };
  const base = { id: r.id, agentId: r.agent_id, ownerId: r.owner_id, message: r.message, createdAt: Number(r.created_at), held };
  const listen = r.listen === 'addressed' ? { kind: 'addressed' } : r.listen === 'clock' ? { kind: 'clock', reason: r.clock_reason } : { kind: 'own' };
  const trigger = { at: r.at === null ? null : Number(r.at), event: r.event, listen };
  if (r.status === 'pending') return { ...base, ...trigger, status: 'pending' } as Wake;
  return { ...base, ...trigger, status: r.status, reason: r.reason, detail: r.detail, settledAt: r.settled_at } as Wake;
};
const toHostEvent = (r: Row): HostEvent => ({ id: r.id, topic: r.topic, body: r.body, arrivedAt: Number(r.arrived_at), consumedAt: r.consumed_at === null ? null : Number(r.consumed_at) });
/** Host events of owner $1 addressed to ids $2 or goals $3 that arrived from $4 on and no wake has carried. */
const ADDRESSED = `owner_id = $1 AND consumed_at IS NULL AND arrived_at >= $4 AND strpos(topic, ':') > 0
  AND (split_part(topic, ':', 1) = ANY (SELECT 'goal-' || g FROM unnest($3::text[]) g)
    OR EXISTS (SELECT 1 FROM unnest($2::text[]) i WHERE strpos(':' || substr(topic, strpos(topic, ':') + 1) || ':', ':' || i || ':') > 0))`;
const toGoal = (r: Row): Goal => ({
  id: r.id, ownerId: r.owner_id, title: r.title, detail: r.detail, status: r.status, priority: r.priority,
  workerIds: r.worker_ids, notes: r.notes, createdAt: r.created_at, updatedAt: r.updated_at,
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
    params.push(col === 'last_report' || col === 'parts' ? JSON.stringify(v) : v);
    out.push(`${col} = $${params.length}`);
  }
  return out;
}

/** Peeks look only this far back in a conversation, so a long run's older work never costs a scan. */
const RECENT_WINDOW = 400;
const RESULT_TEXT = `CASE WHEN parts->0->>'result' IS JSON OBJECT THEN (SELECT string_agg(c->>'text', E'\\n') FROM jsonb_array_elements(
  CASE WHEN jsonb_typeof((parts->0->>'result')::jsonb->'content') = 'array' THEN (parts->0->>'result')::jsonb->'content' ELSE '[]'::jsonb END) c WHERE c->>'type' = 'text')
  ELSE coalesce(parts->0->>'result', '') END`;
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

export function createStore(databaseUrl: string): PgStore {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 20, types });
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

  const store: PgStore = {
    async migrate() { await pool.query(await readFile(new URL('./schema.sql', import.meta.url), 'utf8')); },
    async close() { await pool.end(); },

    // ---------- people ----------
    async upsertPerson(p) {
      await q(`INSERT INTO person (id, name, kind, created_at) VALUES ($1, $2, $3, $4)
        ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, kind = EXCLUDED.kind`, [p.id, p.name, p.kind, Date.now()]);
    },
    async getPerson(id) { return ((await q('SELECT id, name, kind FROM person WHERE id = $1', [id]))[0] as Person | undefined) ?? null; },
    async layoutOf(id) { return ((await q('SELECT layout FROM person WHERE id = $1', [id]))[0]?.layout as Layout | undefined) ?? fail('not_found', 'Unknown person'); },
    async setLayout(id, layout) { return ((await q('UPDATE person SET layout = $2 WHERE id = $1 RETURNING layout', [id, layout]))[0]?.layout as Layout | undefined) ?? fail('not_found', 'Unknown person'); },
    async listPeople() { return (await q('SELECT id, name, kind FROM person ORDER BY kind DESC, name')) as Person[]; },

    // ---------- agents ----------
    async createAgent(a) {
      const now = Date.now(), conversationId = randomUUID();
      await tx(async t => {
        if (a.parentAgentId && !(await t('SELECT 1 FROM agent WHERE id=$1 AND owner_id=$2', [a.parentAgentId, a.ownerId])).length) fail('invalid_input', 'Parent agent must belong to the same owner');
        await t(`INSERT INTO person (id, name, kind, created_at) VALUES ($1, $2, 'agent', $3)`, [a.id, a.name, now]);
        await t(`INSERT INTO conversation (id, title, owner_id, agent_id, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $5)`,
          [conversationId, a.conversationTitle, a.ownerId, a.id, now]);
        await t('INSERT INTO member (conversation_id, person_id) VALUES ($1, $2), ($1, $3)', [conversationId, a.ownerId, a.id]);
        await t(`INSERT INTO agent (id, owner_id, role, conversation_id, goal_id, model, session_path, created_at, updated_at, parent_agent_id, thinking)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, $9, $10)`, [a.id, a.ownerId, a.role, conversationId, a.goalId, a.model, a.sessionPath, now, a.parentAgentId ?? null, a.thinking ?? null]);
      });
      return (await store.getAgent(a.id))!;
    },
    async getAgent(id) { const r = (await q(`${AGENT} WHERE a.id = $1`, [id]))[0]; return r ? toAgent(r) : null; },
    async agentSessionPath(id) { return (await q('SELECT session_path FROM agent WHERE id = $1', [id]))[0]?.session_path ?? null; },
    async listAgents(ownerId, opts = {}) {
      const rows = await q(`${AGENT} WHERE ($1::text IS NULL OR a.owner_id=$1) AND ($2 OR NOT a.archived) ORDER BY a.created_at,a.id`, [ownerId ?? null, opts.includeArchived === true]);
      return rows.map(toAgent);
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
      return finishPage(rows.map(toAgent), limit, scope, row => [ranks[row.state], -row.createdAt, row.id]);
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
        const sets = assignments(patch, { state: 'state', goalId: 'goal_id', model: 'model', lastReport: 'last_report', archived: 'archived' }, params);
        const rows = await t(`UPDATE agent SET ${['updated_at = $2', ...sets].join(', ')} WHERE id = $1 RETURNING id`, params);
        if (!rows.length) fail('not_found', `Agent ${id} not found`);
        if (patch.archived !== undefined) await t('UPDATE conversation SET archived=$2,updated_at=$3 WHERE agent_id=$1',[id,patch.archived,Date.now()]);
      });
      return (await store.getAgent(id))!;
    },
    async handOff({ worker, managerId, message, trigger, handoff, summary }) {
      const now = Date.now();
      const wake = await tx(async t => {
        const rows = await t(`INSERT INTO wake (id, agent_id, owner_id, message, at, event, status, created_at, listen, clock_reason, listen_since, goal_id, held_for, handoff)
          VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, $8, $9, CASE WHEN $8 = 'addressed' THEN $10::bigint END, $11, $12, $13) RETURNING *`,
          [randomUUID(), managerId, worker.ownerId, message, trigger.at, trigger.event === null ? null : JSON.stringify(trigger.event), now,
            trigger.listen.kind, trigger.listen.kind === 'clock' ? trigger.listen.reason : null, worker.createdAt, worker.goalId, worker.id, handoff]);
        await t(`UPDATE goal SET ${prependNote(2)}, updated_at = $3 WHERE id = $1`,
          [worker.goalId, datedNote(`Handoff from worker ${worker.id.slice(0, 8)} (held trigger ${rows[0]!.id.slice(0, 8)}, ${summary}):\n${handoff}`, now), now]);
        await t(`UPDATE agent SET last_report = $2, updated_at = $3 WHERE id = $1`, [worker.id, JSON.stringify({ status: 'handed_off', text: `Handed off to ${managerId}: ${summary}.\n${handoff}`, at: now }), now]);
        return toWake(rows[0]!);
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
      return (await q(`SELECT id FROM agent WHERE state = 'interrupted' AND NOT archived ORDER BY updated_at`)).map(r => r.id);
    },
    async savePendingInputs(inputs) {
      if (!inputs.length) return;
      const now = Date.now();
      await tx(async t => { for (const input of inputs) await t('INSERT INTO agent_pending_input (agent_id, input, created_at) VALUES ($1, $2, $3)', [input.agentId, JSON.stringify(input), now]); });
    },
    async takePendingInputs() {
      return (await q('DELETE FROM agent_pending_input RETURNING id, input')).sort((a, b) => Number(a.id) - Number(b.id)).map(r => r.input as AgentInput);
    },
    async createWake(w) {
      const { listen } = w.trigger;
      return toWake((await q(`INSERT INTO wake (id, agent_id, owner_id, message, at, event, status, created_at, listen, clock_reason, listen_since, goal_id, held_for, handoff)
        VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, $8, $9, CASE WHEN $8 = 'addressed' THEN coalesce((SELECT created_at FROM agent WHERE id = $2), $7) END, $10, $11, $12) RETURNING *`,
        [randomUUID(), w.agentId, w.ownerId, w.message, w.trigger.at, w.trigger.event === null ? null : JSON.stringify(w.trigger.event), Date.now(),
          listen.kind, listen.kind === 'clock' ? listen.reason : null, w.held?.goalId ?? null, w.held?.workerId ?? null, w.held?.handoff ?? null]))[0]!);
    },
    async pendingWakes(ownerId) {
      return (await q(`SELECT * FROM wake WHERE status = 'pending' AND ($1::text IS NULL OR owner_id = $1) ORDER BY created_at, id`, [ownerId])).map(toWake);
    },
    async settledWakes(ownerId, since, limit, agentId) {
      return (await q(`SELECT * FROM wake WHERE owner_id = $1 AND status <> 'pending' AND settled_at > $2 AND ($4::text IS NULL OR agent_id = $4) ORDER BY settled_at DESC LIMIT $3`, [ownerId, since, limit, agentId ?? null])).map(toWake);
    },
    async recordHostEvent(e) {
      return (await q(`INSERT INTO host_event (owner_id, id, topic, body, arrived_at) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING RETURNING id`,
        [e.ownerId, e.id, e.topic, JSON.stringify(e.body), Date.now()])).length === 1;
    },
    async hostEventsFor(ownerId, { topic, prefix }, since, limit) {
      return (await q(`SELECT * FROM host_event WHERE owner_id = $1 AND (topic = $2 OR ($3 AND starts_with(topic, $2))) AND (arrived_at >= $4 OR consumed_at IS NULL)
        ORDER BY arrived_at, id LIMIT $5`, [ownerId, topic, prefix, since, limit]))
        .map(toHostEvent);
    },
    async addressedEventsFor(ownerId, address, since, limit) {
      return (await q(`SELECT * FROM host_event WHERE ${ADDRESSED} ORDER BY arrived_at, id LIMIT $5`, [ownerId, address.ids, address.goals, since, limit])).map(toHostEvent);
    },
    async fireWake(id, carry, describe) {
      return tx(async t => {
        const wake = (await t(`SELECT owner_id FROM wake WHERE id = $1 AND status = 'pending' FOR UPDATE`, [id]))[0];
        if (!wake) return null;
        const own = carry.own.map(e => e.id), room = Math.max(carry.limit - own.length, 0);
        const params = [wake.owner_id, carry.addressed.address.ids, carry.addressed.address.goals, carry.addressed.since, room, own];
        const addressed = (await t(`SELECT * FROM host_event WHERE ${ADDRESSED} AND NOT (id = ANY($6::text[])) ORDER BY arrived_at, id LIMIT $5 FOR UPDATE`, params)).map(toHostEvent);
        const taken = [...own, ...addressed.map(e => e.id)];
        const waiting = Number((await t(`SELECT count(*) AS n FROM host_event WHERE ${ADDRESSED} AND NOT (id = ANY($5::text[]))`, [...params.slice(0, 4), taken]))[0]!.n);
        const s = describe({ own: carry.own, addressed, waiting });
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
      const r = (await q('SELECT at, checked_at, error_id, goals, workers, alerts, checklist FROM agent_heartbeat WHERE agent_id = $1', [agentId]))[0];
      return r ? { at: Number(r.at), checkedAt: Number(r.checked_at), errorId: Number(r.error_id), goals: r.goals, workers: r.workers, alerts: r.alerts, checklist: r.checklist } : null;
    },
    async saveHeartbeat(agentId, state) {
      await q(`INSERT INTO agent_heartbeat (agent_id, at, checked_at, error_id, goals, workers, alerts, checklist) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (agent_id) DO UPDATE SET at = EXCLUDED.at, checked_at = EXCLUDED.checked_at, error_id = EXCLUDED.error_id, goals = EXCLUDED.goals,
          workers = EXCLUDED.workers, alerts = EXCLUDED.alerts, checklist = EXCLUDED.checklist`,
        [agentId, state.at, state.checkedAt, state.errorId, JSON.stringify(state.goals), JSON.stringify(state.workers), JSON.stringify(state.alerts), state.checklist]);
    },

    // ---------- conversations ----------
    async createConversation(c) {
      const id = randomUUID(), now = Date.now();
      const members = [...new Set([c.ownerId, ...c.memberIds])];
      await tx(async t => {
        await t(`INSERT INTO conversation (id, title, owner_id, agent_id, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $5)`,
          [id, c.title, c.ownerId, c.agentId ?? null, now]);
        await t('INSERT INTO member (conversation_id, person_id) SELECT $1, unnest($2::text[])', [id, members]);
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
    async updateConversation(id, forPersonId, patch) {
      await tx(async t => {
        if (!(await t('SELECT 1 FROM conversation WHERE id = $1 FOR UPDATE', [id])).length) fail('not_found', 'Conversation not found');
        const params: unknown[] = [id, Date.now()];
        const sets = assignments(patch, { title: 'title', titleLocked: 'title_locked', archived: 'archived', color: 'color', emoji: 'emoji', pinnedAt: 'pinned_at', keyDate: 'key_date', keyLabel: 'key_label', project: 'project', statusLine: 'status_line', projectId: 'project_id' }, params);
        const membersChange = !!(patch.addMemberIds?.length || patch.removeMemberIds?.length);
        if (sets.length || membersChange) await t(`UPDATE conversation SET ${['updated_at = $2', ...sets].join(', ')} WHERE id = $1`, params);
        if (patch.archived !== undefined) await t('UPDATE agent SET archived=$2,updated_at=$3 WHERE conversation_id=$1',[id,patch.archived,Date.now()]);
        if (patch.addMemberIds?.length)
          await t('INSERT INTO member (conversation_id, person_id) SELECT $1, unnest($2::text[]) ON CONFLICT DO NOTHING', [id, patch.addMemberIds]);
        if (patch.removeMemberIds?.length)
          await t('DELETE FROM member WHERE conversation_id = $1 AND person_id = ANY($2::text[])', [id, patch.removeMemberIds]);
        if (patch.readThrough !== undefined)
          await t('UPDATE member SET read_through = $3 WHERE conversation_id = $1 AND person_id = $2', [id, forPersonId, patch.readThrough]);
      });
      return (await store.getConversation(id, forPersonId))!;
    },

    // ---------- messages ----------
    async appendMessage(m) {
      // One statement: bump last_seq (row lock serialises concurrent appends) and insert with that seq.
      const now = Date.now();
      const files = shownFiles(m.parts ?? []);
      const params: unknown[] = [m.id ?? randomUUID(), m.conversationId, m.authorId, m.role, m.text, JSON.stringify(m.parts ?? []), m.state ?? 'done', m.clientId ?? null, now, m.role === 'notice' ? m.notice : null, displayOf(m)];
      const insert = `WITH c AS (UPDATE conversation SET last_seq = last_seq + 1, updated_at = $9 WHERE id = $2 RETURNING last_seq),
        m AS (INSERT INTO message (id, conversation_id, seq, author_id, role, notice, display, text, parts, state, client_id, created_at, updated_at)
        SELECT $1, $2, c.last_seq, $3, $4, $10, $11, $5, $6, $7, $8, $9, $9 FROM c RETURNING *)`;
      const rows = files.length
        ? await q(`${insert}, f AS (${linkFiles(12)}) SELECT * FROM m`, [...params, files])
        : await q(`${insert} SELECT * FROM m`, params);
      return toMessage(rows[0] ?? fail('not_found', 'Conversation not found'));
    },
    async admitHumanMessage(a) {
      const now = Date.now(), files = shownFiles(a.parts);
      const sql = `WITH conv AS (
          SELECT c.id, c.title, c.owner_id, c.agent_id, c.archived, c.color, c.emoji, c.pinned_at, c.key_date, c.key_label, c.title_locked, c.project, c.status_line, c.project_id, coalesce(me.read_through, 0) AS read_through, me.person_id IS NOT NULL AS member,
            (SELECT coalesce(array_agg(p.person_id ORDER BY p.person_id), '{}') FROM member p WHERE p.conversation_id = c.id) AS member_ids
          FROM conversation c LEFT JOIN member me ON me.conversation_id = c.id AND me.person_id = $3 WHERE c.id = $2),
        existing AS (SELECT * FROM message WHERE client_id = $6),
        c AS (UPDATE conversation SET last_seq = last_seq + 1, updated_at = $7 WHERE id = $2
          AND EXISTS (SELECT 1 FROM conv WHERE member AND NOT archived) AND NOT EXISTS (SELECT 1 FROM existing) RETURNING last_seq),
        m AS (INSERT INTO message (id, conversation_id, seq, author_id, role, notice, display, text, parts, state, client_id, created_at, updated_at)
          SELECT $1, $2, c.last_seq, $3, 'human', NULL, 'shown', $4, $5, 'done', $6, $7, $7 FROM c RETURNING *)
        ${files.length ? `, f AS (${linkFiles(8)})` : ''}
        SELECT (SELECT to_jsonb(conv) FROM conv) AS conv, (SELECT to_jsonb(existing) FROM existing) AS existing, (SELECT to_jsonb(m) FROM m) AS inserted`;
      const r = (await q(sql, [randomUUID(), a.conversationId, a.authorId, a.text, JSON.stringify(a.parts), a.clientId, now, ...(files.length ? [files] : [])]))[0]!;
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
      const sets = assignments(patch, { text: 'text', parts: 'parts', state: 'state', display: 'display' }, params);
      const files = shownFiles(patch.parts ?? []);
      const update = `WITH m AS (UPDATE message SET ${['updated_at = $2', ...sets].join(', ')} WHERE id = $1 RETURNING *)`;
      const rows = files.length
        ? await q(`${update}, f AS (${linkFiles(params.length + 1)}) SELECT * FROM m`, [...params, files])
        : await q(`${update} SELECT * FROM m`, params);
      return toMessage(rows[0] ?? fail('not_found', 'Message not found'));
    },
    async getMessageByClientId(clientId) {
      const r = (await q('SELECT * FROM message WHERE client_id = $1', [clientId]))[0];
      return r ? toMessage(r) : null;
    },
    async listMessages(conversationId, cursor, limit) {
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
      const id = randomUUID(), now = Date.now();
      await q(`INSERT INTO goal (id, owner_id, title, detail, priority, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $6)`,
        [id, g.ownerId, g.title, g.detail ?? '', g.priority ?? 100, now]);
      return toGoal(await one(`${GOAL} WHERE g.id = $1`, [id], 'Goal'));
    },
    async updateGoal(id, { notes, ...patch }) {
      const params: unknown[] = [id, Date.now()];
      const sets = assignments(patch, { title: 'title', detail: 'detail', status: 'status', priority: 'priority' }, params);
      if (notes) { params.push(notes.kind === 'replace' ? notes.text : datedNote(notes.entry, Date.now())); sets.push(notes.kind === 'replace' ? `notes = $${params.length}` : prependNote(params.length)); }
      await one(`UPDATE goal SET ${['updated_at = $2', ...sets].join(', ')} WHERE id = $1 RETURNING id`, params, 'Goal');
      return toGoal(await one(`${GOAL} WHERE g.id = $1`, [id], 'Goal'));
    },
    async getGoal(ownerId, id) {
      const r = (await q(`${GOAL} WHERE g.owner_id = $1 AND g.id::text = $2`, [ownerId, id]))[0];
      return r ? toGoal(r) : null;
    },
    async listGoals(ownerId, status) {
      return (await q(`${GOAL} WHERE g.owner_id = $1 AND ($2::text IS NULL OR g.status = $2) ORDER BY g.priority, g.created_at`, [ownerId, status ?? null])).map(toGoal);
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
    async spend(sinceMs) {
      const byAgent = (await q('SELECT agent_id, sum(cost_usd) AS usd FROM model_call WHERE at >= $1 GROUP BY agent_id ORDER BY usd DESC', [sinceMs]))
        .map(r => ({ agentId: r.agent_id as string, usd: r.usd as number }));
      return { totalUsd: byAgent.reduce((s, a) => s + a.usd, 0), byAgent };
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
    async createNotification(n) {
      return notificationRow((await q(`INSERT INTO notification (person_id, agent_id, conversation_id, title, body, level, image_file_id, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [n.personId, n.agentId, n.conversationId, n.title, n.body, n.level, n.imageFileId, Date.now()]))[0]!);
    },
    async notificationsAfter(personId, afterId, sinceMs, limit) {
      return (await q('SELECT * FROM notification WHERE person_id = $1 AND id > $2 AND created_at >= $3 ORDER BY id LIMIT $4', [personId, afterId, sinceMs, limit])).map(notificationRow);
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
      return toPeer((await q(`INSERT INTO peer_message (id, owner_id, peer_id, direction, from_agent, to_agent, text, created_at) VALUES ($1, $2, $3, 'out', $4, $5, $6, $7) RETURNING *`, [randomUUID(), m.ownerId, m.peerId, m.fromAgent, m.toAgent, m.text, Date.now()]))[0]!);
    },
    async receivePeerInbound(m) {
      const row = (await q(`INSERT INTO peer_message (id, owner_id, peer_id, direction, from_agent, to_agent, text, created_at) VALUES ($1, $2, $3, 'in', $4, $5, $6, $7) ON CONFLICT (id) DO NOTHING RETURNING *`, [m.id, m.ownerId, m.peerId, m.fromAgent, m.toAgent, m.text, m.createdAt]))[0];
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
    async logError(scope, message) { await q('INSERT INTO error_log (scope, message, at) VALUES ($1, $2, $3)', [scope, message.slice(0, 4000), Date.now()]); },
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
