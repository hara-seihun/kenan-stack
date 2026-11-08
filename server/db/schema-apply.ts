import { createHash } from 'node:crypto';
import type pg from 'pg';
import { MESSAGE_COPY_INDEX } from './search-indexes.js';

// Startup re-ran every schema statement, and ALTER TABLE needs a table to itself even when it changes nothing, so a
// stalled export holding a read on `message` kept Beta from starting for everyone (2026-11-03 11:10 PT). Now a part
// whose statements were already applied is skipped. Lock contention aborts a changed part within 50 ms.
// Skipping on the statements' digest alone also skipped every repair those statements make on each start: a migration
// whose schema_migration row was removed, a constraint or column that drifted, the baseline refusal. So a part is
// skipped only when its statements AND the schema they left (catalog plus schema_migration ids) are unchanged since it
// last ran. The fingerprint reads catalogs only, which never waits behind a reader's lock on a table.

export async function applySchema(pool: pg.Pool, part: string, statements: readonly string[]): Promise<void> {
  const digest = createHash('sha256').update(statements.join('\n;\n')).digest('hex');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Queued AccessExclusive locks also block new chat reads/writes. A busy database must reject this
    // migration promptly; the live generation keeps serving. LOCAL prevents the limit leaking to app queries.
    await client.query("SET LOCAL lock_timeout = '50ms'");
    // Even ALTER ... IF NOT EXISTS takes AccessExclusive on an unchanged table. Read the catalog first.
    const { rows: columns } = await client.query<{ attname: string }>(`SELECT attname FROM pg_attribute
      WHERE attrelid = to_regclass('schema_applied') AND attnum > 0 AND NOT attisdropped`);
    if (!columns.length) {
      await client.query('CREATE TABLE IF NOT EXISTS schema_applied(part text PRIMARY KEY, digest text NOT NULL, applied_at bigint NOT NULL, fingerprint text)');
    } else if (!columns.some(column => column.attname === 'fingerprint')) {
      await client.query('ALTER TABLE schema_applied ADD COLUMN IF NOT EXISTS fingerprint text');
    }
    const { rows } = await client.query<{ digest: string; fingerprint: string | null }>('SELECT digest, fingerprint FROM schema_applied WHERE part = $1', [part]);
    if (rows[0]?.digest !== digest || rows[0].fingerprint !== await schemaFingerprint(client)) {
      for (const statement of statements) await client.query(statement);
      await client.query(`INSERT INTO schema_applied(part, digest, fingerprint, applied_at) VALUES ($1, $2, $3, $4)
        ON CONFLICT (part) DO UPDATE SET digest = EXCLUDED.digest, fingerprint = EXCLUDED.fingerprint, applied_at = EXCLUDED.applied_at`,
        [part, digest, await schemaFingerprint(client), Date.now()]);
    }
    await client.query('COMMIT');
  } catch (error) {
    try { await client.query('ROLLBACK'); }
    catch { client.release(true); throw error; }
    client.release();
    throw error;
  }
  client.release();
}

/** A hash of the current schema's tables, columns, constraints, indexes, triggers and functions, and of the
 * schema_migration ids: anything a schema part creates, repairs or records. Names and definitions only, never OIDs.
 * The independently built message-copy index is not part of schema.sql; its concurrent creation must not
 * force unchanged ALTER TABLE statements to wait behind that same index build during a live upgrade. */
export async function schemaFingerprint(pool: pg.Pool | pg.PoolClient): Promise<string> {
  const { rows } = await pool.query<{ item: string }>(`
    WITH ns AS (SELECT oid FROM pg_namespace WHERE nspname = current_schema())
    SELECT 'r ' || c.relname || ' ' || c.relkind::text AS item FROM pg_class c WHERE c.relnamespace IN (SELECT oid FROM ns) AND c.relkind IN ('r', 'p', 'v', 'm', 'S')
    UNION ALL SELECT 'a ' || c.relname || '.' || a.attname || ' ' || format_type(a.atttypid, a.atttypmod) || ' ' || a.attnotnull::text || ' ' || coalesce(pg_get_expr(d.adbin, d.adrelid), '')
      FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      WHERE c.relnamespace IN (SELECT oid FROM ns) AND c.relkind IN ('r', 'p') AND a.attnum > 0 AND NOT a.attisdropped
    UNION ALL SELECT 'c ' || c.relname || '.' || k.conname || ' ' || pg_get_constraintdef(k.oid)
      FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid WHERE c.relnamespace IN (SELECT oid FROM ns)
    UNION ALL SELECT 'i ' || pg_get_indexdef(i.indexrelid) FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid WHERE c.relnamespace IN (SELECT oid FROM ns) AND i.indexrelid <> coalesce(to_regclass($1), 0::oid)
    UNION ALL SELECT 't ' || pg_get_triggerdef(t.oid) FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE c.relnamespace IN (SELECT oid FROM ns) AND NOT t.tgisinternal
    UNION ALL SELECT 'f ' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ') ' || md5(p.prosrc) FROM pg_proc p WHERE p.pronamespace IN (SELECT oid FROM ns)
    ORDER BY 1`, [MESSAGE_COPY_INDEX]);
  const ledger = (await pool.query<{ found: string | null }>(`SELECT to_regclass('schema_migration')::text AS found`)).rows[0]?.found
    ? (await pool.query<{ id: string }>('SELECT id FROM schema_migration ORDER BY id')).rows.map(r => `m ${r.id}`) : [];
  return createHash('sha256').update([...rows.map(r => r.item), ...ledger].join('\n')).digest('hex');
}
