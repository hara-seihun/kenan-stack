// Test helper: an isolated schema per test file in the throwaway database named by KENAN_TEST_DATABASE_URL.
// e.g. KENAN_TEST_DATABASE_URL='postgresql:///kenan_test?host=/tmp/kenan-core-pg'. Tests skip when it is unset.
import pg from 'pg';
import { randomUUID } from 'node:crypto';

export const testDatabaseUrl = process.env.KENAN_TEST_DATABASE_URL;

/** `settings` are Postgres session settings every connection of the returned URL starts with. */
export async function freshSchema(name: string, settings: Readonly<Record<string, string>> = {}): Promise<string> {
  if (!testDatabaseUrl) throw new Error('KENAN_TEST_DATABASE_URL not set');
  if (!/^[a-z][a-z0-9_]{0,29}$/.test(name)) throw new Error('Invalid test schema prefix');
  const client = new pg.Client({ connectionString: testDatabaseUrl });
  await client.connect();
  // Concurrent runs, possibly by different database users, share this database: each run owns its own schema
  // and never removes another active run's schema.
  const schema = `${name}_${randomUUID().replaceAll('-','')}`;
  try {
    await client.query(`CREATE SCHEMA ${schema}`);
  } finally { await client.end(); }
  const options = Object.entries({ search_path: schema, ...settings }).map(([k, v]) => `-c ${k}=${v}`).join(' ');
  return `${testDatabaseUrl}${testDatabaseUrl.includes('?') ? '&' : '?'}options=${encodeURIComponent(options)}`;
}
