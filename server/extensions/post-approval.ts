// Client-only accidental-use guard, not a sandbox against this host's operators.
import { createHmac, createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { createReadStream } from 'node:fs';
import { chmod, chown, copyFile, mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { execFile } from 'node:child_process';
import type pg from 'pg';
import type { Context } from 'hono';
import type { Deps } from '../types.js';
import type { SocialPostProposal, Todo } from '../../shared/contract.js';
import { fail, errorCode } from '../db/errors.js';
import { personOf } from '../http/app.js';

type Proposal = SocialPostProposal;
type Row = { id: string; todo_id: string; payload: string; seal: string; test: boolean; decision: string | null; decided_at: string | null; signature: string | null; claimed_at: string | null; superseded_at: string | null };
type Todos = { ask(owner: string, q: { text: string; details: string | null; options: string[]; conversationId: string | null }, now: number): Promise<Todo>; get(owner: string, id: string): Promise<Todo> };
const choices = ['Yes', 'No', 'Edit'];
const equal = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
async function digest(path: string): Promise<string> { const hash = createHash('sha256'); for await (const chunk of createReadStream(path)) hash.update(chunk); return hash.digest('hex'); }
function proposalInput(value: unknown): Proposal {
  if (!value || typeof value !== 'object') return fail('invalid_input', 'proposal required');
  const p = value as Proposal;
  if (typeof p.title !== 'string' || !p.title || typeof p.source_file !== 'string' || !Array.isArray(p.posts) || !p.posts.length || p.posts.length > 30 || !Array.isArray(p.media)) fail('invalid_input', 'proposal needs source_file, title, posts and media');
  if (JSON.stringify(p).length > 256_000) fail('invalid_input', 'proposal too large');
  for (const m of p.media) if (!m || typeof m.path !== 'string' || !m.path.startsWith('/') || !/^[a-f0-9]{64}$/.test(m.sha256) || !Number.isSafeInteger(m.size) || m.size < 0) fail('invalid_input', 'media needs absolute path, sha256 and size');
  if (new Set(p.media.map(m => m.path)).size !== p.media.length) fail('invalid_input', 'duplicate media paths');
  for (const post of p.posts) {
    if (!post || typeof post.platform !== 'string' || typeof post.text !== 'string' || (post.destination !== undefined && typeof post.destination !== 'string') || (post.link !== undefined && typeof post.link !== 'string') || (post.images !== undefined && !Array.isArray(post.images))) fail('invalid_input', 'invalid post');
    const paths = [...(post.images ?? []).map(m => m.path), ...(post.video ? [typeof post.video === 'string' ? post.video : post.video.path] : [])];
    if (paths.some(path => !p.media.some(m => m.path === path))) fail('invalid_input', 'every post media path needs an exact media entry');
  }
  return p;
}

export function postApproval(deps: Deps, pool: pg.Pool, todos: () => Todos, answer: (id: string, choice: string) => Promise<Todo>) {
  let server: Server | undefined, key: Buffer;
  const root = join(deps.config.dataDir, 'post-proposals'), socket = join(deps.config.dataDir, 'ResearchCo-post.sock');
  const sign = (value: string) => createHmac('sha256', key).update(value).digest('hex');
  const seal = (r: Pick<Row, 'id' | 'payload' | 'test'>) => sign(JSON.stringify([r.id, r.payload, r.test]));
  const decisionSignature = (r: Row) => sign(JSON.stringify([r.id, r.seal, r.decision, String(r.decided_at)]));
  const checked = (r: Row | undefined): Row => {
    if (!r) return fail('not_found', 'proposal_not_found');
    if (!equal(r.seal, seal(r))) fail('conflict', 'proposal_modified');
    return r;
  };
  const get = async (id: string) => checked((await pool.query('SELECT * FROM ResearchCo_post_proposal WHERE id=$1', [id])).rows[0]);
  const result = (r: Row) => ({ id: r.id, todoId: r.todo_id, proposal: JSON.parse(r.payload) as Proposal, test: r.test,
    status: r.superseded_at !== null ? 'superseded' : r.decision === null ? 'pending' : r.signature && equal(r.signature, decisionSignature(r)) ? r.decision === 'Yes' ? 'approved' : r.decision === 'Edit' ? 'edit' : 'rejected' : 'invalid',
    decision: r.decision, approvedAt: r.decision === 'Yes' && r.signature && equal(r.signature, decisionSignature(r)) ? Number(r.decided_at) : null, claimedAt: r.claimed_at === null ? null : Number(r.claimed_at), claimId: r.claimed_at === null ? null : r.id });
  const mediaCheck = async (p: Proposal) => { for (const m of p.media) { if ((await stat(m.path)).size !== m.size || await digest(m.path) !== m.sha256) fail('conflict', `media_changed: ${m.path}`); } };
  const snapshot = (id: string, index: number) => join(root, id, String(index));
  async function submit(body: { proposal?: unknown; chatId?: unknown; test?: unknown }) {
    const proposal = proposalInput(body.proposal), id = randomUUID(), test = body.test === true;
    const manager = deps.runtime.managerFor('alice'), agent = manager ? await deps.store.getAgent(manager) : null;
    if (!agent) fail('unavailable', 'alice_manager_unavailable');
    const chatId = typeof body.chatId === 'string' ? body.chatId : agent!.conversationId;
    const chat = await deps.store.getConversation(chatId, 'alice');
    if (!chat?.memberIds.includes('alice')) fail('invalid_input', 'chatId must be a Alice chat');
    await mkdir(join(root, id), { recursive: true, mode: 0o700 });
    for (const [index, m] of proposal.media.entries()) {
      await copyFile(m.path, snapshot(id, index));
      if ((await stat(snapshot(id, index))).size !== m.size || await digest(snapshot(id, index)) !== m.sha256) fail('conflict', `media_changed: ${m.path}`);
      await chmod(snapshot(id, index), 0o400);
    }
    const details = [test ? '**PRIVATE TEST — never publishes.**' : '', proposal.title, ...proposal.posts.map(post => [
      `### ${post.platform} → ${post.destination || 'Not configured — will not post'}`, post.text, post.link ? `Link: ${post.link}` : '',
      ...(post.images ?? []).map(image => { const index = proposal.media.findIndex(m => m.path === image.path); return `![${(image.alt ?? basename(image.path)).replace(/[\[\]]/g, '')}](/api/ext/todos/post-proposals/${id}/media/${index})\n\nMedia: ${basename(image.path)}; alt text: ${image.alt ?? '(none)'}`; }),
      post.video ? `Video: ${typeof post.video === 'string' ? post.video : post.video.path}` : '',
    ].filter(Boolean).join('\n\n'))].filter(Boolean).join('\n\n');
    // Replacing any text, destination or media starts a new review for the same source.
    const superseded = await pool.query("UPDATE ResearchCo_post_proposal SET superseded_at=$2 WHERE payload::jsonb->>'source_file'=$1 AND superseded_at IS NULL AND claimed_at IS NULL RETURNING todo_id", [proposal.source_file, deps.now()]);
    for (const previous of superseded.rows) { await pool.query('UPDATE todo SET deleted_at=$2,updated_at=$2 WHERE id=$1', [previous.todo_id, deps.now()]); deps.bus.toPerson('alice', { type: 'todo', todo: await todos().get('alice', previous.todo_id) }); }
    const todo = await todos().ask('alice', { text: 'Post this everywhere?', details, options: choices, conversationId: chatId }, deps.now());
    const r = { id, todo_id: todo.id, payload: JSON.stringify(proposal), test, decision: null, decided_at: null, signature: null, claimed_at: null, superseded_at: null } as Row;
    await pool.query('INSERT INTO ResearchCo_post_proposal(id,todo_id,payload,seal,test,created_at) VALUES($1,$2,$3,$4,$5,$6)', [id, todo.id, r.payload, seal(r), test, deps.now()]);
    r.seal = seal(r);
    const shown = { ...todo, postProposalId: id };
    deps.bus.toPerson('alice', { type: 'todo', todo: shown });
    const message = await deps.store.appendMessage({ conversationId: chatId, authorId: agent!.id, role: 'assistant', display: 'shown', text: `${todo.text}\n\n${details}`, parts: [{ type: 'question', todoId: todo.id, options: choices }] });
    deps.bus.toConversation(chatId, { type: 'message', message });
    return result(r);
  }
  async function claim(id: string) {
    const r = await get(id), view = result(r);
    if (r.test) fail('forbidden', 'test_proposal_cannot_publish');
    if (view.status !== 'approved') fail('forbidden', 'human_approval_required');
    await mediaCheck(view.proposal);
    // Repeated claims are the same publication. The publisher resumes its per-destination records, never a new send.
    const updated = checked((await pool.query('UPDATE ResearchCo_post_proposal SET claimed_at=coalesce(claimed_at,$2) WHERE id=$1 AND payload=$3 AND signature=$4 AND superseded_at IS NULL RETURNING *', [id, deps.now(), r.payload, r.signature])).rows[0]);
    return result(updated);
  }
  async function decide(id: string, choice: string) {
    if (!choices.includes(choice)) fail('invalid_input', 'choice must be Yes, No or Edit');
    const r = await get(id);
    if (r.superseded_at !== null) fail('conflict', 'proposal_superseded');
    if (r.decision !== null) fail('conflict', 'proposal_already_decided');
    const todo = await todos().get('alice', r.todo_id);
    if (todo.doneAt !== null || todo.deletedAt !== null || todo.answer !== null) fail('conflict', 'proposal_question_closed');
    if (choice === 'Yes') await mediaCheck(JSON.parse(r.payload) as Proposal);
    r.decision = choice; r.decided_at = String(deps.now());
    const answered = await answer(r.todo_id, choice);
    const changed = await pool.query('UPDATE ResearchCo_post_proposal SET decision=$2,decided_at=$3,signature=$4 WHERE id=$1 AND decision IS NULL AND payload=$5 AND superseded_at IS NULL RETURNING id', [id, choice, r.decided_at, decisionSignature(r), r.payload]);
    if (!changed.rowCount) fail('conflict', 'proposal_already_decided');
    if (choice === 'Yes' && !r.test) launch(id);
    return { ...answered, postProposalId: id };
  }
  function launch(id: string) {
    // Throwaway UI/test servers never start the real publisher.
    if (!['/var/lib/kenan/beta', '/var/lib/kenan/production'].includes(deps.config.dataDir)) return;
    // Fixed program and UUID only: no proposal text ever becomes a command.
    execFile('/usr/bin/systemd-run', ['--collect', `--unit=ResearchCo-post-${id}`, '--property=User=kenan', '--property=WorkingDirectory=/home/kenan', '--property=Slice=user-agents.slice', '--setenv=HOME=/home/kenan', '--setenv=PATH=/home/kenan/.local/bin:/usr/local/bin:/usr/bin:/bin', '--', '/home/kenan/.local/bin/ResearchCo-post', 'publish', id], error => {
      if (error) void deps.store.logError('ResearchCo_post', `Could not start approved publication ${id}: ${String(error)}`);
    });
  }
  return {
    async start() {
      await mkdir(root, { recursive: true, mode: 0o700 });
      const keyPath = join(root, 'decision.key');
      try { await writeFile(keyPath, randomBytes(32), { flag: 'wx', mode: 0o600 }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
      key = await readFile(keyPath);
      await unlink(socket).catch(e => { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; });
      server = createServer(async (req, res) => {
        res.setHeader('content-type', 'application/json');
        try {
          const path = new URL(req.url ?? '/', 'http://localhost').pathname;
          const match = /^\/proposals\/([0-9a-f-]{36})(\/claim)?$/.exec(path);
          let value: unknown;
          if (req.method === 'POST' && path === '/proposals') {
            let body = ''; for await (const chunk of req) { body += chunk; if (body.length > 300_000) fail('invalid_input', 'body too large'); }
            value = await submit(JSON.parse(body));
          } else if (match && req.method === 'GET' && !match[2]) value = result(await get(match[1]!));
          else if (match && req.method === 'POST' && match[2]) value = await claim(match[1]!);
          else fail('not_found', 'No approval operation exists on the local API');
          res.end(JSON.stringify({ ok: true, value }));
        } catch (e) { res.statusCode = errorCode(e) === 'not_found' ? 404 : 400; res.end(JSON.stringify({ ok: false, error: { code: errorCode(e), message: String(e instanceof Error ? e.message : e) } })); }
      });
      await new Promise<void>((resolve, reject) => { server!.once('error', reject); server!.listen(socket, resolve); });
      await chmod(socket, 0o600);
      const owner = deps.person('alice')!;
      if (process.getuid?.() === 0) await chown(socket, owner.uid, owner.gid);
      // A restart between Yes and the publisher's first claim must not lose that action.
      for (const r of (await pool.query("SELECT * FROM ResearchCo_post_proposal WHERE decision='Yes' AND test=false AND claimed_at IS NULL AND superseded_at IS NULL")).rows as Row[]) {
        try { if (result(checked(r)).status === 'approved') launch(r.id); } catch (e) { await deps.store.logError('ResearchCo_post', String(e)); }
      }
    },
    async stop() { if (server) await new Promise<void>(resolve => server!.close(() => resolve())); await unlink(socket).catch(() => {}); },
    async request(c: Context) {
      const match = /\/post-proposals\/([0-9a-f-]{36})(?:\/(decision|media\/(\d+)))?$/.exec(c.req.path);
      if (!match) return fail('not_found', 'proposal_not_found');
      const id = match[1]!;
      if (c.req.method === 'GET' && !match[2]) {
        if (personOf(c) !== 'alice') fail('forbidden', 'alice_client_required');
        return c.json({ ok: true, value: result(await get(id)) });
      }
      if (c.req.method === 'POST' && match[2] === 'decision') {
        // Private host-link calls and preview sessions are not client approvals. Normal Alice cookie auth is required.
        if (personOf(c) !== 'alice' || c.get('linked' as never) || !c.req.header('cookie') || c.req.header('x-kenan-preview-person')) fail('forbidden', 'alice_client_required');
        const body = await c.req.json() as { choice?: unknown };
        return c.json({ ok: true, value: await decide(id, typeof body.choice === 'string' ? body.choice : '') });
      }
      if (c.req.method === 'GET' && match[3] !== undefined) {
        if (personOf(c) !== 'alice') fail('forbidden', 'alice_client_required');
        const r = await get(id), index = Number(match[3]), p = JSON.parse(r.payload) as Proposal;
        const media = Number.isInteger(index) && index >= 0 ? p.media[index] : undefined;
        if (!media) fail('not_found', 'media_not_found');
        if (await digest(snapshot(r.id, index)) !== media!.sha256) fail('conflict', 'media_modified');
        const ext = media!.path.toLowerCase().split('.').pop();
        const mime = ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', mp4: 'video/mp4', webm: 'video/webm' } as Record<string, string>)[ext ?? ''] ?? 'application/octet-stream';
        return new Response(new Uint8Array(await readFile(snapshot(r.id, index))), { headers: { 'content-type': mime, 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' } });
      }
      return fail('not_found', 'proposal_operation_not_found');
    },
  };
}
