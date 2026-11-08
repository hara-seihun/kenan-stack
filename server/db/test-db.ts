// Test helper: an isolated schema per test file in the throwaway database named by KENAN_TEST_DATABASE_URL.
// e.g. KENAN_TEST_DATABASE_URL='postgresql:///kenan_test?host=/tmp/kenan-core-pg'; unset, the Kenan host's kenan_test
// database (bench/ui/serve.ts runs outside vitest). Tests skip when neither exists.
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { hostTestDatabaseUrl } from './host-test-database.js';

export const testDatabaseUrl = process.env.KENAN_TEST_DATABASE_URL ?? hostTestDatabaseUrl() ?? undefined;

/** `settings` are Postgres session settings every connection of the returned URL starts with. */
export async function freshSchema(name: string, settings: Readonly<Record<string, string>> = {}): Promise<string> {
  if (!testDatabaseUrl) throw new Error('KENAN_TEST_DATABASE_URL not set');
  if (!/^[a-z][a-z0-9_]{0,29}$/.test(name)) throw new Error('Invalid test schema prefix');
  const client = new pg.Client({ connectionString: testDatabaseUrl });
  await client.connect();
  // Concurrent runs, possibly by different database users, share this database: each run owns its own schema
  // and never removes another active run's schema.
  // The name carries its creation time, so any run can drop schemas abandoned for a day (test files never drop
  // their own: 6,956 had piled up, 6 GB of catalog).
  const schema = `${name}_${Date.now().toString(36)}_${randomUUID().replaceAll('-','').slice(0, 16)}`;
  try {
    await client.query(`CREATE SCHEMA ${schema}`);
    // Bounded: on 2026-11-04 the first database suites of a run spent their whole 10 s hook dropping a day's worth of
    // schemas (about 80 ms each). Vitest's suites project drops the full backlog once in its global setup instead.
    await dropAbandonedSchemas(client, { budgetMs: 500 });
  } finally { await client.end(); }
  const options = Object.entries({ search_path: schema, ...settings }).map(([k, v]) => `-c ${k}=${v}`).join(' ');
  return `${testDatabaseUrl}${testDatabaseUrl.includes('?') ? '&' : '?'}options=${encodeURIComponent(options)}`;
}

const ABANDONED_MS = 24 * 3600_000;

/** Drops this database's test schemas created over a day ago, oldest first. With `budgetMs` it stops starting
 *  drops once that much time has passed, leaving the rest to the next call; returns how many it dropped. */
export async function dropAbandonedSchemas(client: pg.Client, { budgetMs = Infinity }: { budgetMs?: number } = {}): Promise<number> {
  const { rows } = await client.query<{ nspname: string }>(
    "SELECT nspname FROM pg_namespace WHERE nspname ~ '^[a-z][a-z0-9_]*_[0-9a-z]{8,9}_[0-9a-f]{16}$' AND pg_has_role(nspowner, 'USAGE')");
  const started = Date.now(), cutoff = started - ABANDONED_MS;
  const created = (nspname: string) => parseInt(nspname.split('_').at(-2)!, 36);
  const abandoned = rows.map(r => r.nspname).filter(n => created(n) < cutoff).sort((a, b) => created(a) - created(b));
  let dropped = 0;
  for (const nspname of abandoned) {
    if (Date.now() - started >= budgetMs) break;
    if (await client.query(`DROP SCHEMA IF EXISTS ${nspname} CASCADE`).then(() => true, () => false)) dropped++;
  }
  return dropped;
}

/** Vitest global setup for the suites project: clear the whole backlog once, outside any test's hook timeout. */
export async function dropAllAbandonedSchemas(): Promise<void> {
  if (!testDatabaseUrl) return;
  const client = new pg.Client({ connectionString: testDatabaseUrl });
  await client.connect();
  try { await dropAbandonedSchemas(client); } finally { await client.end(); }
}
