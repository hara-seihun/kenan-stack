import type pg from 'pg';
import type { SearchPage, SearchQuery } from '../../shared/contract.js';
import { fail } from './errors.js';
import { LONG_MESSAGE, WORD_MESSAGE } from './search-indexes.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function parseSearchQuery(query: SearchQuery): Required<Omit<SearchQuery, 'chat' | 'after' | 'before'>> & { chat: string | null; after: number | null; before: number | null } {
  const q = typeof query.q === 'string' ? query.q.trim() : '';
  if (!q || q.length > 500) fail('invalid_input', 'Search needs 1–500 characters');
  if (query.chat !== undefined && !UUID.test(query.chat)) fail('invalid_input', 'chat must be a conversation id');
  const date = (value: string | number | undefined): number | null => {
    if (value === undefined) return null;
    const at = typeof value === 'number' || /^\d+$/.test(value) ? Number(value) : Date.parse(value);
    return Number.isSafeInteger(at) && at >= 0 ? at : fail('invalid_input', 'Dates must be ISO dates or epoch milliseconds');
  };
  const after = date(query.after), before = date(query.before);
  if (after !== null && before !== null && after >= before) fail('invalid_input', 'after must precede before');
  const limit = query.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) fail('invalid_input', 'limit must be 1–100');
  return { q, chat: query.chat ?? null, after, before, limit };
}

/** Every branch checks membership in SQL, including archived manager/worker chats. Never owner-wide search. */
export async function searchMessages(pool: pg.Pool, personId: string, query: SearchQuery): Promise<SearchPage> {
  const { q, chat, after, before, limit } = parseSearchQuery(query);
  const literal = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
  const allowed = `JOIN member access ON access.conversation_id = c.id AND access.person_id = $1`;
  const dates = (column: string) => `($4::bigint IS NULL OR ${column} >= $4) AND ($5::bigint IS NULL OR ${column} < $5)`;
  const room = `($3::uuid IS NULL OR c.id = $3)`;
  const { rows } = await pool.query(`WITH
    words AS MATERIALIZED (
      SELECT m.conversation_id, m.id, m.seq, m.created_at FROM message m
      JOIN conversation c ON c.id = m.conversation_id ${allowed}
      WHERE ${WORD_MESSAGE.replace(/\b(display|role|text)\b/g, 'm.$1')}
        AND to_tsvector('simple', left(m.text, 100000)) @@ plainto_tsquery('simple', $2)
        AND ${room} AND ${dates('m.created_at')} ORDER BY m.created_at DESC, m.id DESC LIMIT $6),
    long_words AS MATERIALIZED (
      SELECT m.conversation_id, m.id, m.seq, m.created_at FROM message m
      JOIN conversation c ON c.id = m.conversation_id ${allowed}
      WHERE ${LONG_MESSAGE.replace(/\b(display|role|text)\b/g, 'm.$1')}
        AND m.created_at >= CASE WHEN (SELECT count(*) FROM words) = $6 THEN (SELECT min(created_at) FROM words) ELSE 0 END
        AND cardinality(message_search_terms($2)) > 0 AND message_search_terms(m.text) @> message_search_terms($2) AND ${room} AND ${dates('m.created_at')} ORDER BY m.created_at DESC, m.id DESC LIMIT $6),
    message_hits AS MATERIALIZED (
      SELECT * FROM (SELECT * FROM words UNION ALL SELECT * FROM long_words) all_words ORDER BY created_at DESC, id DESC LIMIT $6),
    hits AS (
      SELECT c.id AS conversation_id, c.title, m.id AS message_id, m.seq, m.created_at,
        left(m.text, 4000) AS text,
        CASE WHEN length(m.text) <= 100000 THEN ts_headline('simple', m.text, plainto_tsquery('simple', $2),
          'StartSel="", StopSel="", MaxFragments=1, MaxWords=40, MinWords=15')
          ELSE substring(m.text FROM greatest(1, position((message_search_terms($2))[1] IN lower(m.text)) - 100) FOR 400) END AS snippet,
        1 AS source
      FROM message_hits h JOIN message m ON m.id = h.id JOIN conversation c ON c.id = h.conversation_id
      UNION ALL
      (SELECT c.id, c.title, NULL::uuid, NULL::bigint, c.updated_at, c.title, c.title, 0
        FROM conversation c ${allowed} WHERE c.title ILIKE $7 AND ${room} AND ${dates('c.updated_at')}
        ORDER BY c.updated_at DESC, c.id DESC LIMIT $6)
      UNION ALL
      (SELECT c.id, c.title, NULL::uuid, NULL::bigint, f.created_at, f.name, f.name, 2
        FROM file f JOIN conversation_file cf ON cf.file_id = f.id JOIN conversation c ON c.id = cf.conversation_id ${allowed}
        WHERE f.name ILIKE $7 AND ${room} AND ${dates('f.created_at')}
        ORDER BY f.created_at DESC, f.id DESC LIMIT $6)
    ) SELECT * FROM hits ORDER BY source, created_at DESC, conversation_id DESC, seq DESC LIMIT $6`,
  [personId, q, chat, after, before, limit, literal]);
  return { items: rows.map(r => ({
    conversationId: r.conversation_id, conversationTitle: r.title, messageId: r.message_id, seq: r.seq === null ? null : Number(r.seq),
    text: r.text, snippet: r.snippet, createdAt: Number(r.created_at),
    link: `chat:${r.conversation_id}${r.seq === null ? '' : `#${r.seq}`}`,
  })) };
}
