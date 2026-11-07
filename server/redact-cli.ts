// Redacts credentials from records already stored by Kenan Stack: one message row, or a Pi session file in place.
// Never prints content: every output line is ids, credential classes with counts, and hashes.
//
//   node dist/server/redact-cli.js scan --database-url URL [--sessions DIR]...
//   node dist/server/redact-cli.js redact --database-url URL --message ID [--session PATH]... --requested-by WHO --reason WHY
//   node dist/server/redact-cli.js redact-file --database-url URL --path PATH --requested-by WHO --reason WHY
//   node dist/server/redact-cli.js redact-found --database-url URL [--sessions DIR]... --requested-by WHO --reason WHY
import { createHash, randomUUID } from 'node:crypto';
import { open, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import pg from 'pg';
import { redactCredentials, type Found } from './redact.js';

type Failure = { error: 'usage' | 'not_found' | 'invalid_json_after_redaction' | 'not_redacted'; detail: string };
export type Outcome = { ok: true; receipt: Record<string, unknown> } | { ok: false; failure: Failure };
/** Redactions already in a record, by class (a same-length marker may be cut short, so its class is read only when whole). */
const markers = (text: string) => { const seen: Record<string, number> = {}; for (const [, kind] of text.matchAll(/\[redacted(?::([a-z_]+)\])?/g)) seen[kind ?? 'cut'] = (seen[kind ?? 'cut'] ?? 0) + 1; return seen; };
const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
/** Coarse server-side filter; redactCredentials decides. */
const CANDIDATE = String.raw`ya29\.|eyJ[A-Za-z0-9_-]{8}|bearer|basic |PRIVATE KEY|sk-|rk-|gh[pousr]_|github_pat_|xox[abposr]-|AKIA|AIza|glpat-|authorization|api-key|://[^ /@]+:[^ /@]+@|access_token|refresh_token|id_token|client_secret|private_key|api_key|apikey|password|secret|sntry[su]_|(?:pass|passwd|token|key)(?:[[:space:]]|\\t)*=`;
/** Environment-style names, case-sensitive: `max_tokens` is in nearly every message. */
const ENV_CANDIDATE = String.raw`[A-Z0-9]_(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY)|[A-Z]_KEY`;

export async function scan(db: pg.Client, sessionDirs: string[]): Promise<Outcome> {
  const messages = [];
  await db.query('BEGIN READ ONLY');
  await db.query(`DECLARE candidates NO SCROLL CURSOR FOR SELECT id, conversation_id, seq, author_id, text, parts::text AS parts FROM message WHERE (parts::text || text) ~* $1 OR (parts::text || text) ~ $2`, [CANDIDATE, ENV_CANDIDATE]);
  for (let rows = (await db.query('FETCH 200 FROM candidates')).rows; rows.length; rows = (await db.query('FETCH 200 FROM candidates')).rows) {
    for (const row of rows) {
      const { found, count } = redactCredentials(`${row.text}\n${row.parts}`);
      if (count) messages.push({ messageId: row.id, conversationId: row.conversation_id, seq: Number(row.seq), authorId: row.author_id, classes: found });
    }
  }
  await db.query('COMMIT');
  const files = [];
  for (const dir of sessionDirs) for (const name of (await readdir(dir)).filter(n => n.endsWith('.jsonl')).sort()) {
    const { found, count } = redactCredentials((await readFile(join(dir, name))).toString('latin1'), 'same-length');
    if (count) files.push({ path: join(dir, name), classes: found });
  }
  return { ok: true, receipt: { messages, files } };
}

async function audit(db: pg.Client, row: Record<string, unknown>): Promise<string> {
  const id = randomUUID();
  await db.query(`INSERT INTO transcript_redaction (id, target, message_id, conversation_id, seq, author_id, path, classes, before_sha256, after_sha256, requested_by, reason, at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
  [id, row.target, row.messageId ?? null, row.conversationId ?? null, row.seq ?? null, row.authorId ?? null, row.path ?? null, JSON.stringify(row.classes), row.beforeSha256, row.afterSha256, row.requestedBy, row.reason, Date.now()]);
  return id;
}

export async function redactMessage(db: pg.Client, messageId: string, requestedBy: string, reason: string): Promise<Outcome> {
  await db.query('BEGIN');
  const row = (await db.query('SELECT id, conversation_id, seq, author_id, text, parts::text AS parts FROM message WHERE id = $1 FOR UPDATE', [messageId])).rows[0];
  if (!row) { await db.query('ROLLBACK'); return { ok: false, failure: { error: 'not_found', detail: `message ${messageId}` } }; }
  const before = `${row.text}\0${row.parts}`;
  const text = redactCredentials(row.text), parts = redactCredentials(row.parts);
  const found: Found = { ...text.found };
  for (const [kind, n] of Object.entries(parts.found)) found[kind as keyof Found] = (found[kind as keyof Found] ?? 0) + n;
  if (!text.count && !parts.count) { await db.query('ROLLBACK'); return { ok: true, receipt: { target: 'message', messageId, result: 'no_credentials' } }; }
  try { JSON.parse(parts.text); } catch { await db.query('ROLLBACK'); return { ok: false, failure: { error: 'invalid_json_after_redaction', detail: `message ${messageId}` } }; }
  await db.query('UPDATE message SET text = $2, parts = $3::jsonb, updated_at = $4 WHERE id = $1', [messageId, text.text, parts.text, Date.now()]);
  const stored = (await db.query('SELECT text, parts::text AS parts FROM message WHERE id = $1', [messageId])).rows[0];
  const after = `${stored.text}\0${stored.parts}`;
  const left = redactCredentials(`${stored.text}\n${stored.parts}`).count;
  if (left) { await db.query('ROLLBACK'); return { ok: false, failure: { error: 'not_redacted', detail: `${left} credential(s) still match in message ${messageId}` } }; }
  const receipt = { target: 'message', messageId, conversationId: row.conversation_id, seq: Number(row.seq), authorId: row.author_id, classes: found, beforeSha256: sha256(before), afterSha256: sha256(after), requestedBy, reason };
  const auditId = await audit(db, receipt);
  await db.query('COMMIT');
  const verified = (await db.query('SELECT text, parts::text AS parts FROM message WHERE id = $1', [messageId])).rows[0];
  const committed = sha256(`${verified.text}\0${verified.parts}`) === receipt.afterSha256 && !redactCredentials(`${verified.text}\n${verified.parts}`).count;
  return committed ? { ok: true, receipt: { ...receipt, auditId, result: 'redacted', verified: true } } : { ok: false, failure: { error: 'not_redacted', detail: `message ${messageId} changed after commit` } };
}

/** Pi only appends to a session file, so secrets are overwritten in place at the same length: appends keep landing after them. */
export async function redactFile(db: pg.Client, path: string, requestedBy: string, reason: string): Promise<Outcome> {
  const handle = await open(path, 'r+');
  try {
    const bytes = await readFile(handle);
    const { text, found, count } = redactCredentials(bytes.toString('latin1'), 'same-length');
    if (!count) return { ok: true, receipt: { target: 'session_file', path, result: 'no_credentials', markers: markers(bytes.toString('latin1')) } };
    const next = Buffer.from(text, 'latin1');
    if (next.length !== bytes.length) throw new Error('same-length redaction changed the length');
    for (let at = 0; at < bytes.length;) {
      if (bytes[at] === next[at]) { at++; continue; }
      let end = at; while (end < bytes.length && bytes[end] !== next[end]) end++;
      await handle.write(next, at, end - at, at);
      at = end;
    }
    await handle.sync();
    const reread = await readFile(path);
    const head = reread.subarray(0, bytes.length);
    const left = redactCredentials(reread.toString('latin1'), 'same-length').count;
    if (!head.equals(next) || left) return { ok: false, failure: { error: 'not_redacted', detail: `${left} credential(s) still match in ${path}` } };
    const receipt = { target: 'session_file', path, classes: found, beforeSha256: sha256(bytes), afterSha256: sha256(next), requestedBy, reason };
    return { ok: true, receipt: { ...receipt, auditId: await audit(db, receipt), result: 'redacted', verified: true } };
  } finally { await handle.close(); }
}

async function main(argv: string[]): Promise<Outcome[]> {
  const [command, ...rest] = argv;
  const { values } = parseArgs({ args: rest, options: { 'database-url': { type: 'string' }, message: { type: 'string' }, session: { type: 'string', multiple: true }, sessions: { type: 'string', multiple: true }, path: { type: 'string' }, 'requested-by': { type: 'string' }, reason: { type: 'string' } } });
  const url = values['database-url'];
  if (!url) return [{ ok: false, failure: { error: 'usage', detail: '--database-url is required' } }];
  const db = new pg.Client({ connectionString: url });
  await db.connect();
  try {
    if (command === 'scan') return [await scan(db, values.sessions ?? [])];
    const requestedBy = values['requested-by'], reason = values.reason;
    if (!requestedBy || !reason) return [{ ok: false, failure: { error: 'usage', detail: '--requested-by and --reason are required' } }];
    await db.query(await readFile(new URL('./db/schema.sql', import.meta.url), 'utf8').then(sql => { const start = sql.indexOf('CREATE TABLE IF NOT EXISTS transcript_redaction'); return sql.slice(start, sql.indexOf('\n);', start) + 3); }));
    if (command === 'redact' && values.message) {
      const outcomes = [await redactMessage(db, values.message, requestedBy, reason)];
      for (const path of values.session ?? []) outcomes.push(await redactFile(db, path, requestedBy, reason));
      return outcomes;
    }
    if (command === 'redact-file' && values.path) return [await redactFile(db, values.path, requestedBy, reason)];
    if (command === 'redact-found') {
      const found = await scan(db, values.sessions ?? []);
      if (!found.ok) return [found];
      const { messages, files } = found.receipt as { messages: { messageId: string }[]; files: { path: string }[] };
      const outcomes: Outcome[] = [];
      for (const { messageId } of messages) outcomes.push(await redactMessage(db, messageId, requestedBy, reason));
      for (const { path } of files) outcomes.push(await redactFile(db, path, requestedBy, reason));
      return outcomes;
    }
    return [{ ok: false, failure: { error: 'usage', detail: 'commands: scan | redact --message ID [--session PATH] | redact-file --path PATH | redact-found [--sessions DIR]' } }];
  } finally { await db.end(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const outcomes = await main(process.argv.slice(2));
  for (const outcome of outcomes) console.log(JSON.stringify(outcome));
  process.exitCode = outcomes.every(outcome => outcome.ok) ? 0 : 1;
}
