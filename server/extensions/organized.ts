// The Organized layout's server side (opt-in per person with the `organized` extension): the to-do list
// (table `todo` in schema.sql), its HTTP API under /api/ext/organized/todos and the agents' `todos` tool.
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';
import { Type } from 'typebox';
import { TODO_LEVELS, type ConversationSummary, type Todo, type TodoLevel } from '../../shared/contract.js';
import type { Bus, Extension } from '../types.js';
import { personOf } from '../http/app.js';
import { fail } from '../db/errors.js';

/** Done items stay listed (the Done tab, Undo) for this long. */
export const DONE_SHOWN_MS = 30 * 86_400_000;

export interface TodoInput { text: string; level: TodoLevel; tag: string | null; dueAt: number | null; remind: boolean; conversationId: string | null }
export interface TodoPatch { text?: string; level?: TodoLevel; tag?: string | null; dueAt?: number | null; remind?: boolean; conversationId?: string | null; position?: number; done?: boolean; deleted?: boolean }

const toTodo = (r: Record<string, unknown>): Todo => ({
  id: r.id as string, text: r.text as string, level: r.level as TodoLevel, tag: r.tag as string | null, dueAt: r.due_at === null ? null : Number(r.due_at),
  remind: r.remind as boolean, position: r.position as number, conversationId: r.conversation_id as string | null,
  doneAt: r.done_at === null ? null : Number(r.done_at), deletedAt: r.deleted_at === null ? null : Number(r.deleted_at),
  createdAt: Number(r.created_at), updatedAt: Number(r.updated_at),
});

const level = (v: unknown): TodoLevel => TODO_LEVELS.find(l => l === v) ?? fail('invalid_input', `level must be one of ${TODO_LEVELS.join(', ')}`);
const text = (v: unknown): string => typeof v === 'string' && v.trim() && v.length <= 2000 ? v.trim() : fail('invalid_input', 'text must be 1–2000 characters');
const nullableText = (v: unknown, name: string): string | null => v === null ? null : typeof v === 'string' && v.trim() && v.length <= 80 ? v.trim() : fail('invalid_input', `${name} must be a short string or null`);
const instant = (v: unknown, name: string): number | null => {
  if (v === null) return null;
  const at = typeof v === 'number' ? v : typeof v === 'string' ? Date.parse(v) : NaN;
  return Number.isFinite(at) ? at : fail('invalid_input', `${name} must be an ISO time, epoch ms or null`);
};
const bool = (v: unknown, name: string): boolean => typeof v === 'boolean' ? v : fail('invalid_input', `${name} must be boolean`);
const uuidOrNull = (v: unknown, name: string): string | null => v === null ? null : typeof v === 'string' && /^[0-9a-f-]{36}$/i.test(v) ? v : fail('invalid_input', `${name} must be a conversation id or null`);

/** Validates a new item; level is required, everything else may be absent (meaning: no tag, no due time, no reminder, no project). */
export function parseTodoInput(b: Record<string, unknown>): TodoInput {
  return {
    text: text(b.text), level: level(b.level), tag: b.tag === undefined ? null : nullableText(b.tag, 'tag'),
    dueAt: b.dueAt === undefined ? null : instant(b.dueAt, 'dueAt'), remind: b.remind === undefined ? false : bool(b.remind, 'remind'),
    conversationId: b.conversationId === undefined ? null : uuidOrNull(b.conversationId, 'conversationId'),
  };
}
export function parseTodoPatch(b: Record<string, unknown>): TodoPatch {
  const patch: TodoPatch = {};
  if (b.text !== undefined) patch.text = text(b.text);
  if (b.level !== undefined) patch.level = level(b.level);
  if (b.tag !== undefined) patch.tag = nullableText(b.tag, 'tag');
  if (b.dueAt !== undefined) patch.dueAt = instant(b.dueAt, 'dueAt');
  if (b.remind !== undefined) patch.remind = bool(b.remind, 'remind');
  if (b.conversationId !== undefined) patch.conversationId = uuidOrNull(b.conversationId, 'conversationId');
  if (b.position !== undefined) patch.position = typeof b.position === 'number' && Number.isFinite(b.position) ? b.position : fail('invalid_input', 'position must be a number');
  if (b.done !== undefined) patch.done = bool(b.done, 'done');
  if (b.deleted !== undefined) patch.deleted = bool(b.deleted, 'deleted');
  if (!Object.keys(patch).length) fail('invalid_input', 'Nothing to change');
  return patch;
}

export function todoStore(pool: pg.Pool) {
  return {
    /** Open items, and items done or deleted in the last DONE_SHOWN_MS, by level then position. */
    async list(owner: string, now: number): Promise<Todo[]> {
      const r = await pool.query(`SELECT * FROM todo WHERE owner_id = $1 AND (deleted_at IS NULL OR deleted_at > $2) AND (done_at IS NULL OR done_at > $2)
        ORDER BY array_position(ARRAY['today','week','someday'], level), position, created_at`, [owner, now - DONE_SHOWN_MS]);
      return r.rows.map(toTodo);
    },
    /** New items go to the end of their level. */
    async add(owner: string, input: TodoInput, now: number, doneAt: number | null = null): Promise<Todo> {
      const r = await pool.query(`INSERT INTO todo (id, owner_id, text, level, tag, due_at, remind, position, conversation_id, done_at, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, (SELECT coalesce(max(position), 0) + 1 FROM todo WHERE owner_id = $2 AND level = $4), $8, $9, $10, $10) RETURNING *`,
        [randomUUID(), owner, input.text, input.level, input.tag, input.dueAt, input.remind, input.conversationId, doneAt, now]);
      return toTodo(r.rows[0]);
    },
    async update(owner: string, id: string, patch: TodoPatch, now: number): Promise<Todo> {
      const params: unknown[] = [id, owner, now], sets = ['updated_at = $3'];
      const set = (column: string, value: unknown) => { params.push(value); sets.push(`${column} = $${params.length}`); };
      if (patch.text !== undefined) set('text', patch.text);
      if (patch.level !== undefined) set('level', patch.level);
      if (patch.tag !== undefined) set('tag', patch.tag);
      if (patch.dueAt !== undefined) set('due_at', patch.dueAt);
      if (patch.remind !== undefined) set('remind', patch.remind);
      if (patch.conversationId !== undefined) set('conversation_id', patch.conversationId);
      if (patch.done !== undefined) set('done_at', patch.done ? now : null);
      if (patch.deleted !== undefined) set('deleted_at', patch.deleted ? now : null);
      if (patch.position !== undefined) set('position', patch.position);
      else if (patch.level !== undefined) sets.push(`position = (SELECT coalesce(max(position), 0) + 1 FROM todo WHERE owner_id = $2 AND level = '${patch.level}' AND id <> $1)`);
      const r = await pool.query(`UPDATE todo SET ${sets.join(', ')} WHERE id = $1 AND owner_id = $2 RETURNING *`, params);
      return r.rows[0] ? toTodo(r.rows[0]) : fail('not_found', 'To-do item not found');
    },
  };
}
type Todos = ReturnType<typeof todoStore>;

const HEADINGS: Record<string, TodoLevel | 'done'> = { today: 'today', 'this week': 'week', someday: 'someday', done: 'done' };
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
export type SeedItem = TodoInput & { done: { at: number } | null };
/** Kenaznia's markdown list (memory/todo.md): "- [ ] text [Tag] 🔔 2 pm" lines under ## Today / ## This week / ## Someday,
 *  "- [x] text (Oct 20) [Tag]" under ## Done. Lines outside those sections are not items. */
export function parseTodoMarkdown(markdown: string, now: number): SeedItem[] {
  const items: SeedItem[] = [];
  let section: TodoLevel | 'done' | null = null;
  for (const line of markdown.split('\n')) {
    const heading = /^##\s+([^(]+?)\s*(\(.*\))?\s*$/.exec(line);
    if (heading) { section = HEADINGS[heading[1]!.toLowerCase()] ?? null; continue; }
    const item = /^- \[( |x)\]\s+(.+)$/.exec(line.trim());
    if (!item || !section) continue;
    let body = item[2]!;
    const remind = body.includes('🔔');
    const tagMatch = /\s*\[([^\]]+)\]/.exec(body);
    const tag = tagMatch ? tagMatch[1]!.trim() : null;
    const [before, after] = tagMatch ? [body.slice(0, tagMatch.index), body.slice(tagMatch.index + tagMatch[0].length)] : [body, ''];
    const clean = (s: string) => s.replace(/🔔/g, '').replace(/\s+/g, ' ').trim();
    body = [clean(before), clean(after)].filter(Boolean).join(' · ');
    if (!body) continue;
    let done: SeedItem['done'] = null;
    if (section === 'done') {
      const when = /\((jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.? (\d{1,2})\)/i.exec(body);
      const year = new Date(now).getFullYear();
      done = { at: when ? Date.UTC(year, MONTHS.indexOf(when[1]!.toLowerCase()), Number(when[2]), 12) : now };
    }
    items.push({ text: body, level: section === 'done' ? 'someday' : section, tag, dueAt: null, remind, conversationId: null, done });
  }
  return items;
}

/** A person's list starts from their markdown list (HOME/ID/memory/todo.md) the first time Organized runs for them:
 *  only while they have no to-do rows at all, so it happens once and never duplicates. */
async function seed(pool: pg.Pool, owner: string, file: string, now: number): Promise<number> {
  if ((await pool.query('SELECT 1 FROM todo WHERE owner_id = $1 LIMIT 1', [owner])).rowCount) return 0;
  let markdown: string;
  try { markdown = await readFile(file, 'utf8'); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return 0; throw e; }
  const items = parseTodoMarkdown(markdown, now), store = todoStore(pool);
  for (const item of items) await store.add(owner, item, now, item.done?.at ?? null);
  return items.length;
}

const TOOL_DESCRIPTION = `Read and change the person's to-do list (shown in the Kenan app: Home "Waiting on you" = level today; the To-do screen).
list: open items plus those done in the last 30 days. add: text, level (today|week|someday), optional tag (e.g. Candef, Kenan app, Career, Berkeley, Phone, Personal), dueAt (ISO), remind (true = a reminder is set; schedule the wake yourself), conversationId (a project's conversation).
update: id plus any of text, level, tag, dueAt, remind, conversationId (null clears). done / reopen: id. move: id + level (goes to the end of that level). delete: id (undoable with update deleted=false).`;

export function createOrganizedExtension(): Extension {
  let pool: pg.Pool | undefined;
  const todos = (): Todos => pool ? todoStore(pool) : fail('unavailable', 'To-do list is not started');
  const changed = (bus: Bus, owner: string, todo: Todo) => { bus.toPerson(owner, { type: 'todo', todo }); return todo; };
  return {
    id: 'organized', name: 'Organized',
    async start(deps) {
      pool = new pg.Pool({ connectionString: deps.config.databaseUrl, max: 2 });
      for (const person of deps.config.people.filter(p => p.extensions.includes('organized'))) {
        const count = await seed(pool, person.id, join(person.home, person.id, 'memory', 'todo.md'), deps.now());
        if (count) console.log(JSON.stringify({ type: 'todo_seeded', person: person.id, count }));
      }
    },
    async stop() { await pool?.end(); pool = undefined; },
    routes(app, deps) {
      app.use('*', async (c, next) => { if (!deps.person(personOf(c))?.extensions.includes('organized')) fail('forbidden', 'Organized is not enabled'); await next(); });
      app.get('/projects/:id/files', async c => {
        const me = personOf(c), project = await deps.store.getConversation(c.req.param('id'), me);
        if (!project?.memberIds.includes(me)) fail('not_found', 'Project not found');
        const rooms = (await deps.store.listConversations(me, { includeArchived: true })).filter(r => r.id === project!.id || r.projectId === project!.id).map(r => r.id);
        const r = await (pool ?? fail('unavailable', 'Organized is not started')).query(`SELECT DISTINCT ON (f.id) f.id, f.name, f.mime, f.size, f.created_at, cf.conversation_id
          FROM conversation_file cf JOIN file f ON f.id = cf.file_id WHERE cf.conversation_id = ANY($1::uuid[]) ORDER BY f.id, f.created_at DESC`, [rooms]);
        const files = r.rows.map(x => ({ id: x.id as string, name: x.name as string, mime: x.mime as string, size: Number(x.size), at: Number(x.created_at), conversationId: x.conversation_id as string }));
        return c.json({ ok: true, value: files.sort((a, b) => b.at - a.at).slice(0, 100) });
      });
      app.get('/todos', async c => c.json({ ok: true, value: await todos().list(personOf(c), deps.now()) }));
      app.post('/todos', async c => c.json({ ok: true, value: changed(deps.bus, personOf(c), await todos().add(personOf(c), parseTodoInput(await c.req.json()), deps.now())) }));
      app.patch('/todos/:id', async c => c.json({ ok: true, value: changed(deps.bus, personOf(c), await todos().update(personOf(c), c.req.param('id'), parseTodoPatch(await c.req.json()), deps.now())) }));
      app.delete('/todos/:id', async c => c.json({ ok: true, value: changed(deps.bus, personOf(c), await todos().update(personOf(c), c.req.param('id'), { deleted: true }, deps.now())) }));
    },
    tool: ctx => ({
      name: 'todos', files: 'none', label: 'To-do', description: TOOL_DESCRIPTION,
      parameters: Type.Object({
        action: Type.Union(['list', 'add', 'update', 'done', 'reopen', 'move', 'delete'].map(v => Type.Literal(v))),
        id: Type.Optional(Type.String()), text: Type.Optional(Type.String()), level: Type.Optional(Type.Union(TODO_LEVELS.map(v => Type.Literal(v)))),
        tag: Type.Optional(Type.Union([Type.String(), Type.Null()])), dueAt: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        remind: Type.Optional(Type.Boolean()), conversationId: Type.Optional(Type.Union([Type.String(), Type.Null()])), deleted: Type.Optional(Type.Boolean()),
      }),
      execute: async (_id, raw: unknown) => {
        const { action, id, ...rest } = raw as Record<string, unknown> & { action: string; id?: string };
        const owner = ctx.person.id, now = ctx.deps.now(), need = () => id ?? fail('invalid_input', `${action} needs id`);
        const apply = async (patch: TodoPatch) => changed(ctx.deps.bus, owner, await todos().update(owner, need(), patch, now));
        let value: unknown;
        switch (action) {
          case 'list': value = (await todos().list(owner, now)).filter(t => !t.deletedAt).map(({ createdAt: _c, updatedAt: _u, deletedAt: _d, ...t }) => t); break;
          case 'add': value = changed(ctx.deps.bus, owner, await todos().add(owner, parseTodoInput(rest), now)); break;
          case 'update': value = await apply(parseTodoPatch(rest)); break;
          case 'done': value = await apply({ done: true }); break;
          case 'reopen': value = await apply({ done: false }); break;
          case 'move': value = await apply({ level: level(rest.level) }); break;
          case 'delete': value = await apply({ deleted: true }); break;
          default: fail('invalid_input', `Unknown action ${action}`);
        }
        return { content: [{ type: 'text', text: JSON.stringify(value) }], details: {} };
      },
    }),
  };
}
export const organizedExtension = createOrganizedExtension();

const ROOMS_DESCRIPTION = `Open and name topic rooms (the Organized layout's chats). Suggest a new room when the subject changes, then create it.
list: open rooms (id, title, emoji, titleLocked). create: title, optional emoji; the room's members are the person and their Kenaznia.
rename: id + title (+ optional emoji). A title the person set herself is locked: rename refuses it (title_locked) unless she asked you
to rename it now (herRequest: true). Pass lock: true when she asks you to keep the new name.
project: id + project (true makes the room a project page, false undoes it) and/or status (the page's one-line status, null clears).
group: id + projectId (put a room under a project page; null takes it out). To-dos belong to a project through the todos tool's conversationId.`;

/** The `rooms` tool (extension `rooms`, for people trying Organized): Kenaznia creates and names topic rooms. */
export function createRoomsExtension(): Extension {
  return {
    id: 'rooms', name: 'Rooms',
    tool: ctx => ({
      name: 'rooms', files: 'none', label: 'Rooms', description: ROOMS_DESCRIPTION,
      parameters: Type.Object({
        action: Type.Union(['list', 'create', 'rename', 'project', 'group'].map(v => Type.Literal(v))), id: Type.Optional(Type.String()),
        project: Type.Optional(Type.Boolean()), status: Type.Optional(Type.Union([Type.String({ maxLength: 500 }), Type.Null()])), projectId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        title: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })), emoji: Type.Optional(Type.String({ maxLength: 16 })),
        herRequest: Type.Optional(Type.Boolean()), lock: Type.Optional(Type.Boolean()),
      }),
      execute: async (_id, raw: unknown) => {
        const args = raw as { action: string; id?: string; title?: string; emoji?: string; herRequest?: boolean; lock?: boolean; project?: boolean; status?: string | null; projectId?: string | null };
        const { store, bus, runtime } = ctx.deps, owner = ctx.person.id;
        const announce = (c: ConversationSummary) => { for (const id of c.memberIds) bus.toPerson(id, { type: 'conversation', conversation: c }); return c; };
        const brief = (c: ConversationSummary) => ({ id: c.id, title: c.title, emoji: c.emoji, titleLocked: c.titleLocked, pinned: c.pinnedAt !== null, project: c.project, status: c.statusLine, projectId: c.projectId });
        const mine = async (id: string | undefined) => { const c = id ? await store.getConversation(id, owner) : null; return c?.memberIds.includes(owner) ? c : fail('not_found', 'Room not found'); };
        let value: unknown;
        switch (args.action) {
          case 'list': value = (await store.listConversations(owner, { includeArchived: false })).filter(c => !c.agentId).map(brief); break;
          case 'create': {
            const manager = runtime.managerFor(owner);
            const created = await store.createConversation({ title: args.title?.trim() || fail('invalid_input', 'create needs title'), ownerId: owner, memberIds: [owner, ...(manager ? [manager] : [])] });
            value = brief(announce(args.emoji ? await store.updateConversation(created.id, owner, { emoji: args.emoji }) : created));
            break;
          }
          case 'rename': {
            const id = args.id ?? fail('invalid_input', 'rename needs id'), title = args.title?.trim() || fail('invalid_input', 'rename needs title');
            const current = await store.getConversation(id, owner) ?? fail('not_found', 'Room not found');
            if (current.titleLocked && !args.herRequest) fail('conflict', `title_locked: "${current.title}" is a name she chose; rename it only when she asks (herRequest: true)`);
            value = brief(announce(await store.updateConversation(id, owner, { title, titleLocked: args.lock ?? (current.titleLocked && !!args.herRequest), ...(args.emoji !== undefined ? { emoji: args.emoji } : {}) })));
            break;
          }
          case 'project': {
            const room = await mine(args.id);
            if (args.project === undefined && args.status === undefined) fail('invalid_input', 'project needs project and/or status');
            value = brief(announce(await store.updateConversation(room.id, owner, { ...(args.project !== undefined ? { project: args.project } : {}), ...(args.status !== undefined ? { statusLine: args.status } : {}) })));
            break;
          }
          case 'group': {
            const room = await mine(args.id);
            if (args.projectId === undefined) fail('invalid_input', 'group needs projectId (or null)');
            if (args.projectId !== null && !(await mine(args.projectId)).project) fail('invalid_input', 'projectId is not a project page');
            value = brief(announce(await store.updateConversation(room.id, owner, { projectId: args.projectId })));
            break;
          }
          default: fail('invalid_input', `Unknown action ${args.action}`);
        }
        return { content: [{ type: 'text', text: JSON.stringify(value) }], details: {} };
      },
    }),
  };
}
export const roomsExtension = createRoomsExtension();
