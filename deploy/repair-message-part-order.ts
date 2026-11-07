/** One-time repair from Pi's ordered assistant content. Dry run unless --apply.
 * sudo node node_modules/tsx/dist/cli.mjs deploy/repair-message-part-order.ts \
 *   --database-url 'postgresql:///kenan_beta?host=/run/kenan/pg&user=root' \
 *   --conversation UUID [--session FILE]... [--apply --backup FILE]
 * Only parts change. Text, row order, background splitting and timestamps remain untouched.
 * A backup contains the original parts of changed rows (0600), for a direct rollback if needed.
 */
import { createReadStream } from 'node:fs';
import { open, readdir } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { basename, dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import pg from 'pg';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { displayContent } from '../server/agents/anthropic-narration.js';
import { backgroundPieces, stripNoReply, type MessagePart } from '../shared/contract.js';
import { splitTextParts } from '../shared/message-parts.js';

type Row = { id: string; text: string; parts: MessagePart[]; display: string; state: string; seq: string; updated_at: string };
type Entry = { id: string; timestamp: string; message: AssistantMessage };
const canonical = (value: unknown): string => JSON.stringify(value, (_key, v) => v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v);
const nonText = (parts: MessagePart[]) => parts.filter(p => p.type !== 'text');
const key = (text: string, parts: MessagePart[]) => canonical([text, nonText(parts)]);
const { values } = parseArgs({ options: {
  'database-url': { type: 'string' }, conversation: { type: 'string' },
  session: { type: 'string', multiple: true }, apply: { type: 'boolean' }, backup: { type: 'string' },
} });
if (!values.conversation || !(values['database-url'] || process.env.DATABASE_URL) || (values.apply && !values.backup)) {
  throw new Error('Provide --conversation, --database-url (or DATABASE_URL), and --backup FILE with --apply');
}
const db = new pg.Client({ connectionString: values['database-url'] ?? process.env.DATABASE_URL });
await db.connect();
try {
  if (values.apply && !(await db.query("SELECT has_table_privilege('message', 'UPDATE') AS allowed")).rows[0].allowed) {
    throw new Error('Database role is read-only; run this maintenance script as the database owner (sudo and user=root on ResearchCo)');
  }
  const agent = (await db.query(`SELECT a.id, a.session_path FROM conversation c JOIN agent a ON a.id = c.agent_id
    WHERE c.id = $1 AND c.owner_id = 'alice'`, [values.conversation])).rows[0];
  if (!agent) throw new Error('Alice conversation with an agent required');
  let paths = values.session;
  if (!paths?.length) {
    const sessionDirectory = dirname(agent.session_path);
    const dataDirectory = basename(sessionDirectory) === 'sessions' ? dirname(sessionDirectory) : dirname(dirname(sessionDirectory));
    const directory = join(dataDirectory, 'transcripts');
    let copies: string[] = [];
    try { copies = (await readdir(directory)).filter(p => p.startsWith(`${values.conversation}.`) && p.endsWith('.jsonl')).sort().map(p => join(directory, p)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    paths = [...copies, agent.session_path];
  }
  const entries = new Map<string, Entry>();
  for (const path of paths) {
    for await (const line of createInterface({ input: createReadStream(path), crlfDelay: Infinity })) {
      if (!line.trim()) continue;
      const entry = JSON.parse(line);
      if (entry.type === 'message' && entry.message?.role === 'assistant') entries.set(`${entry.id}:${entry.timestamp}`, entry);
    }
  }
  if (!entries.size) throw new Error('No assistant messages in the supplied Pi transcripts');
  const oldest = Math.min(...[...entries.values()].map(e => e.message.timestamp));
  const rows: Row[] = (await db.query(`SELECT id, text, parts, display, state, seq, updated_at FROM message
    WHERE conversation_id = $1 AND author_id = $2 AND role = 'assistant' AND created_at >= $3
    ORDER BY seq`, [values.conversation, agent.id, oldest - 60_000])).rows;
  const candidates = new Map<string, number[]>();
  for (const [index, row] of rows.entries()) {
    const k = key(row.text, row.parts); const group = candidates.get(k) ?? [];
    group.push(index); candidates.set(k, group);
  }
  const changes = new Map<string, { before: Row; parts: MessagePart[] }>();
  let matched = 0, unmatched = 0, ambiguous = 0, unsupported = 0;
  for (const entry of entries.values()) {
    const message = entry.message;
    // Failed calls can append a separate error string; do not infer where it belongs.
    if (message.stopReason === 'error' || message.stopReason === 'aborted') { unsupported++; continue; }
    const content = displayContent(message);
    const source = content.flatMap(p => p.type === 'text' ? [p.text] : []).join('');
    const parts = content.flatMap((p): MessagePart[] => p.type === 'text' ? [{ type: 'text', text: p.text }]
      : p.type === 'thinking' ? [{ type: 'thinking', text: p.thinking }]
      : p.type === 'toolCall' ? [{ type: 'tool', callId: p.id, name: p.name, args: p.arguments, result: null, isError: false }] : []);
    const pieces = backgroundPieces(source);
    const split = pieces.some(p => p.background);
    const bodies = split ? pieces.map(p => p.text) : [source];
    const first = bodies[0] ?? '';
    const possible = [...new Set([key(first, parts), key(stripNoReply(first), parts)])]
      .flatMap(k => candidates.get(k) ?? [])
      // Pi writes message_end at the same time that runtime settles the first row.
      .filter(index => Math.abs(Number(rows[index]!.updated_at) - Date.parse(entry.timestamp)) <= 2_000);
    if (!possible.length) { unmatched++; continue; }
    if (possible.length !== 1) { ambiguous++; continue; }
    const index = possible[0]!;
    const targets = rows.slice(index, index + bodies.length);
    if (targets.length !== bodies.length || targets.some((row, at) => row.state === 'streaming'
      || row.text !== (row.display === 'shown' ? stripNoReply(bodies[at]!) : bodies[at])
      || (at > 0 && row.parts.length !== 0)
      || Math.abs(Number(row.updated_at) - Date.parse(entry.timestamp)) > 2_000
      || (split && pieces[at]!.background && row.display !== 'background'))) { unmatched++; continue; }
    let projected: MessagePart[][];
    try { projected = splitTextParts(parts, source, targets.map(row => row.text)); }
    catch { unsupported++; continue; }
    // No words can be added from a transcript or leak out of a background row.
    if (projected.some((p, at) => p.flatMap(x => x.type === 'text' ? [x.text] : []).join('') !== targets[at]!.text)) {
      unsupported++; continue;
    }
    matched++;
    for (const [at, row] of targets.entries()) {
      const next = projected[at]!;
      if (canonical(row.parts) === canonical(next)) continue;
      const previous = changes.get(row.id);
      if (previous && canonical(previous.parts) !== canonical(next)) throw new Error(`Conflicting Pi matches for ${row.id}`);
      changes.set(row.id, { before: row, parts: next });
    }
  }
  console.log(JSON.stringify({ conversation: values.conversation, files: paths.length, transcriptMessages: entries.size,
    databaseMessages: rows.length, matched, unmatched, ambiguous, unsupported, changedRows: changes.size, apply: !!values.apply }));
  if (values.apply && changes.size) {
    const backup = await open(values.backup!, 'wx', 0o600);
    try { for (const { before } of changes.values()) await backup.write(`${JSON.stringify({ id: before.id, text: before.text, parts: before.parts })}\n`); }
    finally { await backup.close(); }
    await db.query('BEGIN');
    try {
      for (const { before, parts } of changes.values()) {
        const result = await db.query(`UPDATE message SET parts = $2::jsonb
          WHERE id = $1 AND parts = $3::jsonb AND text = $4 AND state = $5 AND updated_at = $6`,
        [before.id, JSON.stringify(parts), JSON.stringify(before.parts), before.text, before.state, before.updated_at]);
        if (result.rowCount !== 1) throw new Error(`Message changed during repair: ${before.id}`);
      }
      await db.query('COMMIT');
      console.log(JSON.stringify({ repaired: changes.size, backup: values.backup }));
    } catch (error) { await db.query('ROLLBACK'); throw error; }
  }
} finally { await db.end(); }
