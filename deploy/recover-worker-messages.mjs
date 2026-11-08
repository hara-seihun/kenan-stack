#!/usr/bin/env node
// Restore direct inputs that older builds delivered to Pi without recording chat rows.
// Run: sudo node deploy/recover-worker-messages.mjs /etc/kenan/beta.json AGENT_ID
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const [configPath, agentId] = process.argv.slice(2);
if (!configPath || !agentId) throw new Error('usage: recover-worker-messages.mjs CONFIG AGENT_ID');
const config = JSON.parse(await readFile(configPath, 'utf8'));
const db = new pg.Client({ connectionString: config.databaseUrl });
await db.connect();
try {
  const agent = (await db.query("SELECT * FROM agent WHERE id = $1 AND role = 'worker'", [agentId])).rows[0];
  if (!agent) throw new Error('worker_not_found');
  const entries = (await readFile(agent.session_path, 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line));
  const inputs = [];
  for (const entry of entries) {
    if (entry.type !== 'message' || entry.message?.role !== 'user') continue;
    const content = entry.message.content;
    const text = typeof content === 'string' ? content : content.filter(p => p.type === 'text').map(p => p.text).join('\n');
    const envelopes = [...text.matchAll(/(?:^|\n\n)\[([a-z_]+) from ([^\]\n]+)\]\n/g)];
    envelopes.forEach((envelope, index) => {
      if (envelope[1] !== 'agent') return;
      const body = text.slice(envelope.index + envelope[0].length, envelopes[index + 1]?.index ?? text.length).trimEnd();
      if (!body) return;
      inputs.push({ key: `recovered-agent-input:${agentId}:${entry.id}:${index}`, from: envelope[2], body, at: Date.parse(entry.timestamp) });
    });
  }
  await db.query('BEGIN');
  const conversation = (await db.query('SELECT * FROM conversation WHERE id = $1 FOR UPDATE', [agent.conversation_id])).rows[0];
  const oldMessages = (await db.query('SELECT id, seq FROM message WHERE conversation_id = $1 ORDER BY seq', [conversation.id])).rows;
  const members = (await db.query('SELECT person_id, read_through FROM member WHERE conversation_id = $1', [conversation.id])).rows;
  let seq = Number(conversation.last_seq), inserted = 0;
  for (const input of inputs) {
    // New builds may have already shown an input; never duplicate one of those rows.
    const exists = (await db.query("SELECT 1 FROM message WHERE conversation_id = $1 AND (client_id = $2 OR (notice = 'agent_message' AND author_id = $3 AND text = $4)) LIMIT 1", [conversation.id, input.key, input.from, input.body])).rowCount;
    if (exists) continue;
    await db.query(`INSERT INTO message (id, conversation_id, seq, author_id, role, notice, display, text, client_id, created_at, updated_at)
      VALUES ($1, $2, $3, $4, 'notice', 'agent_message', 'shown', $5, $6, $7, $7)`, [randomUUID(), conversation.id, ++seq, input.from, input.body, input.key, input.at]);
    inserted++;
  }
  if (inserted) {
    // Reinsert recovered inputs at their original times. Existing row IDs and members' read positions survive.
    const ordered = (await db.query('SELECT id FROM message WHERE conversation_id = $1 ORDER BY created_at, seq', [conversation.id])).rows;
    await db.query('UPDATE message SET seq = -seq WHERE conversation_id = $1', [conversation.id]);
    const ids = ordered.map(row => row.id);
    await db.query('UPDATE message m SET seq = r.seq FROM unnest($1::uuid[]) WITH ORDINALITY AS r(id, seq) WHERE m.id = r.id', [ids]);
    const newSeq = new Map(ids.map((id, index) => [id, index + 1]));
    for (const member of members) {
      const lastRead = oldMessages.findLast(m => Number(m.seq) <= Number(member.read_through));
      await db.query('UPDATE member SET read_through = $3 WHERE conversation_id = $1 AND person_id = $2', [conversation.id, member.person_id, lastRead ? newSeq.get(lastRead.id) : 0]);
    }
    await db.query('UPDATE conversation SET last_seq = $2 WHERE id = $1', [conversation.id, ordered.length]);
  }
  await db.query('COMMIT');
  console.log(`Restored ${inserted} direct messages to ${agentId}.`);
} catch (error) {
  await db.query('ROLLBACK');
  throw error;
} finally { await db.end(); }
