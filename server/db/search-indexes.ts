import type pg from 'pg';

/** Large imports can exceed PostgreSQL's 1 MiB tsvector limit. Those use a deduplicated word-array index;
 * ordinary messages use full-text words. Both cover the entire message, without a text cutoff. */
export const WORD_MESSAGE = `display <> 'silent' AND role <> 'tool' AND length(text) <= 100000`;
export const LONG_MESSAGE = `display <> 'silent' AND role <> 'tool' AND length(text) > 100000`;

/** Small function installation is awaited so reads are ready while the large indexes build concurrently. */
export async function ensureSearchFunctions(pool: pg.Pool): Promise<void> {
  const { rows } = await pool.query(`SELECT to_regprocedure('message_search_terms(text)') AS found`);
  if (rows[0]?.found) return;
  await pool.query(`CREATE OR REPLACE FUNCTION message_search_terms(value text) RETURNS text[] LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $body$
    SELECT coalesce(array_agg(DISTINCT word), ARRAY[]::text[]) FROM regexp_split_to_table(lower(value), '[^[:alnum:]_]+') word
    WHERE octet_length(word) BETWEEN 1 AND 2000
  $body$`);
}

/** Concurrent builds never block chat writes or server startup. A cancelled build is repaired on the next start.
 * Also callable directly with a pool to prepare a deployment before restarting the server. */
export async function ensureSearchIndexes(pool: pg.Pool): Promise<void> {
  await ensureSearchFunctions(pool);
  const client = await pool.connect();
  try {
    const { rows } = await client.query(`SELECT pg_try_advisory_lock(hashtext(current_database() || ':' || current_schema() || ':message-search')) AS acquired`);
    if (!rows[0]?.acquired) return;
    try {
      await client.query('CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public');
      const extension = (await client.query(`SELECT n.nspname FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = 'pg_trgm'`)).rows[0];
      if (extension?.nspname !== 'public') await client.query('ALTER EXTENSION pg_trgm SET SCHEMA public');
      const indexes = [
        ['message_search_words', `ON message USING gin(to_tsvector('simple', left(text, 100000))) WHERE ${WORD_MESSAGE}`],
        ['message_search_long', `ON message USING gin(message_search_terms(text)) WHERE ${LONG_MESSAGE}`],
        ['message_search_words_recent', `ON message (created_at DESC, id DESC) WHERE ${WORD_MESSAGE}`],
        ['conversation_search_title', 'ON conversation USING gin(title public.gin_trgm_ops)'],
        ['file_search_name', 'ON file USING gin(name public.gin_trgm_ops)'],
      ];
      let changed = false;
      for (const [name, definition] of indexes) {
        const found = (await client.query(`SELECT i.indisvalid FROM pg_index i WHERE i.indexrelid = to_regclass($1)`, [name])).rows[0];
        if (found?.indisvalid) continue;
        changed = true;
        if (found) await client.query(`DROP INDEX CONCURRENTLY ${name}`);
        await client.query(`CREATE INDEX CONCURRENTLY IF NOT EXISTS ${name} ${definition}`);
      }
      // Partial expression-index statistics do not tell the planner how common a word is in the whole table.
      // Without this, 'the' is estimated as rare and reads every matching message instead of the newest fifty.
      const stats = (await client.query(`SELECT 1 FROM pg_statistic_ext WHERE stxnamespace = current_schema()::regnamespace AND stxname = 'message_search_word_frequency'`)).rows[0];
      if (!stats) {
        await client.query(`CREATE STATISTICS message_search_word_frequency ON (to_tsvector('simple', left(text, 100000))) FROM message`);
        changed = true;
      }
      if (changed) await client.query('ANALYZE message');
    } finally {
      await client.query(`SELECT pg_advisory_unlock(hashtext(current_database() || ':' || current_schema() || ':message-search'))`);
    }
  } finally { client.release(); }
}
