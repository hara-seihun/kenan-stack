// The to-do list (table `todo` in schema.sql), its HTTP API under /api/ext/todos, the question cards, the To buy list and the
// agents' `todos` and `question` tools. Shared by both app layouts; people with the `organized` module get this extension too.
import { postApproval } from './post-approval.js';
import { IdFailure, matchId, resolveId } from '../ids.js';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';
import { Type } from 'typebox';
import { TODO_LEVELS, type ConversationSummary, type Todo, type TodoChat, type TodoLevel } from '../../shared/contract.js';
import type { Deps, Extension, KenanTool, Store, ToolContext } from '../types.js';
import type { PersonConfig } from '../config.js';
import { withModule } from '../modules.js';
import { personOf } from '../http/app.js';
import { todoEmoji, todoSection, urgentFirst } from '../../shared/todo.js';
import { todayIn, zoneOrHome } from '../../shared/zone.js';
import { fail } from '../db/errors.js';
import { answeringChat } from '../agents/origin.js';
import { notifyChatMembers } from '../chat-notify.js';
import { NOTIFY_OUTBOX_ROOT } from '../notify-outbox.js';
import { announceRoom } from './rooms.js';
import { BUY_ACTIONS, BUY_TOOL_TEXT, buyAction, buyRoutes, buyService, buyStore, type BuyAction } from './shopping.js';

/** Done items stay listed (the Done tab, Undo) for this long. */
export const DONE_SHOWN_MS = 30 * 86_400_000;

export interface TodoInput { text: string; details: string | null; level: TodoLevel; tag: string | null; dueAt: number | null; onDate: string | null; remind: boolean; onHome: boolean; conversationId: string | null }
export interface TodoPatch { text?: string; details?: string | null; level?: TodoLevel; tag?: string | null; dueAt?: number | null; onDate?: string | null; remind?: boolean; onHome?: boolean; conversationId?: string | null; position?: number; done?: boolean; deleted?: boolean }

const toTodo = (r: Record<string, unknown>): Todo => ({
  id: r.id as string, text: r.text as string, details: r.details as string | null, level: r.level as TodoLevel, tag: r.tag as string | null, dueAt: r.due_at === null ? null : Number(r.due_at), onDate: r.on_date as string | null,
  remind: r.remind as boolean, onHome: r.on_home as boolean, position: r.position as number, conversationId: r.conversation_id as string | null, ownRoom: r.own_room as boolean,
  doneAt: r.done_at === null ? null : Number(r.done_at), deletedAt: r.deleted_at === null ? null : Number(r.deleted_at),
  createdAt: Number(r.created_at), updatedAt: Number(r.updated_at),
  options: (r.options as string[] | null) ?? null, answer: (r.answer as string | null) ?? null, dismissedAt: r.dismissed_at == null ? null : Number(r.dismissed_at), postProposalId: (r.post_proposal_id as string | undefined) ?? undefined,
});

/** 'week' is the old "This week": an alias for 'soon', so older callers keep working. */
export const LEVEL_ALIASES = { week: 'soon' } as const satisfies Record<string, TodoLevel>;
const level = (v: unknown): TodoLevel => TODO_LEVELS.find(l => l === v) ?? (v === 'week' ? LEVEL_ALIASES.week : fail('invalid_input', `level must be one of ${TODO_LEVELS.join(', ')} ('week' means soon)`));
const day = (v: unknown): string | null => v === null ? null
  : typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && new Date(`${v}T12:00:00Z`).toISOString().startsWith(v) ? v : fail('invalid_input', 'onDate must be YYYY-MM-DD or null');
const text = (v: unknown): string => typeof v === 'string' && v.trim() && v.length <= 2000 ? v.trim() : fail('invalid_input', 'text must be 1–2000 characters');
const details = (v: unknown): string | null => v === null ? null : typeof v === 'string' && v.length <= 20_000 ? v.trim() || null : fail('invalid_input', 'details must be a string up to 20000 characters or null');
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
    text: text(b.text), details: b.details === undefined ? null : details(b.details), level: level(b.level), tag: b.tag === undefined ? null : nullableText(b.tag, 'tag'),
    dueAt: b.dueAt === undefined ? null : instant(b.dueAt, 'dueAt'), onDate: b.onDate === undefined ? null : day(b.onDate), remind: b.remind === undefined ? false : bool(b.remind, 'remind'),
    onHome: b.onHome === undefined ? false : bool(b.onHome, 'onHome'),
    conversationId: b.conversationId === undefined ? null : uuidOrNull(b.conversationId, 'conversationId'),
  };
}
export function parseTodoPatch(b: Record<string, unknown>): TodoPatch {
  const patch: TodoPatch = {};
  if (b.text !== undefined) patch.text = text(b.text);
  if (b.details !== undefined) patch.details = details(b.details);
  if (b.level !== undefined) patch.level = level(b.level);
  if (b.tag !== undefined) patch.tag = nullableText(b.tag, 'tag');
  if (b.dueAt !== undefined) patch.dueAt = instant(b.dueAt, 'dueAt');
  if (b.onDate !== undefined) patch.onDate = day(b.onDate);
  if (b.remind !== undefined) patch.remind = bool(b.remind, 'remind');
  if (b.onHome !== undefined) patch.onHome = bool(b.onHome, 'onHome');
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
      const r = await pool.query(`SELECT todo.*, (SELECT id FROM ResearchCo_post_proposal p WHERE p.todo_id=todo.id) AS post_proposal_id FROM todo WHERE owner_id = $1 AND (deleted_at IS NULL OR deleted_at > $2) AND (done_at IS NULL OR done_at > $2)
        ORDER BY array_position($3::text[], level), position, created_at`, [owner, now - DONE_SHOWN_MS, TODO_LEVELS]);
      return r.rows.map(toTodo);
    },
    /** New items go to the end of their level. */
    async add(owner: string, input: TodoInput, now: number, doneAt: number | null = null): Promise<Todo> {
      const r = await pool.query(`INSERT INTO todo (id, owner_id, text, level, tag, due_at, on_date, remind, on_home, position, conversation_id, done_at, created_at, updated_at, details)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, (SELECT coalesce(max(position), 0) + 1 FROM todo WHERE owner_id = $2 AND level = $4), $10, $11, $12, $12, $13) RETURNING *, (SELECT id FROM ResearchCo_post_proposal p WHERE p.todo_id=todo.id) AS post_proposal_id`,
        [randomUUID(), owner, input.text, input.level, input.tag, input.dueAt, input.onDate, input.remind, input.onHome, input.conversationId, doneAt, now, input.details]);
      return toTodo(r.rows[0]);
    },
    /** A question for her: a Today item on Home with 2–4 answers she taps, linked to the chat it was asked in. */
    async ask(owner: string, q: { text: string; details: string | null; options: string[]; conversationId: string | null }, now: number): Promise<Todo> {
      const r = await pool.query(`INSERT INTO todo (id, owner_id, text, details, level, on_home, options, conversation_id, position, created_at, updated_at)
        VALUES ($1, $2, $3, $4, 'today', true, $5, $6, (SELECT coalesce(min(position), 1) - 1 FROM todo WHERE owner_id = $2 AND level = 'today'), $7, $7) RETURNING *, (SELECT id FROM ResearchCo_post_proposal p WHERE p.todo_id=todo.id) AS post_proposal_id`,
        [randomUUID(), owner, q.text, q.details, q.options, q.conversationId, now]);
      return toTodo(r.rows[0]);
    },
    /** Her tap: records one of the options as the answer and ticks the question done, once. Null when it isn't open or the choice isn't one of its options. */
    async answer(owner: string, id: string, choice: string, now: number): Promise<Todo | null> {
      const r = await pool.query(`UPDATE todo SET answer = $3, done_at = $4, updated_at = $4 WHERE id = $1 AND owner_id = $2 AND options IS NOT NULL
        AND answer IS NULL AND done_at IS NULL AND deleted_at IS NULL AND $3 = ANY(options) RETURNING *, (SELECT id FROM ResearchCo_post_proposal p WHERE p.todo_id=todo.id) AS post_proposal_id`, [id, owner, choice, now]);
      return r.rows[0] ? toTodo(r.rows[0]) : null;
    },
    /** Her Dismiss on an open question: it leaves Home and counts as withdrawn, marked dismissed; no message is posted. Null when it isn't open. */
    async dismiss(owner: string, id: string, now: number): Promise<Todo | null> {
      const r = await pool.query(`UPDATE todo SET deleted_at = $3, dismissed_at = $3, updated_at = $3 WHERE id = $1 AND owner_id = $2 AND options IS NOT NULL
        AND answer IS NULL AND done_at IS NULL AND deleted_at IS NULL RETURNING *, (SELECT id FROM ResearchCo_post_proposal p WHERE p.todo_id=todo.id) AS post_proposal_id`, [id, owner, now]);
      return r.rows[0] ? toTodo(r.rows[0]) : null;
    },
    async get(owner: string, id: string): Promise<Todo> {
      const r = await pool.query('SELECT todo.*, (SELECT id FROM ResearchCo_post_proposal p WHERE p.todo_id=todo.id) AS post_proposal_id FROM todo WHERE id = $1 AND owner_id = $2', [id, owner]);
      return r.rows[0] ? toTodo(r.rows[0]) : fail('not_found', 'To-do item not found');
    },
    /** Links an unlinked item to the chat just made for it; null when it was linked meanwhile. */
    async attachRoom(owner: string, id: string, conversationId: string, now: number): Promise<Todo | null> {
      const r = await pool.query('UPDATE todo SET conversation_id = $3, own_room = true, updated_at = $4 WHERE id = $1 AND owner_id = $2 AND conversation_id IS NULL RETURNING *, (SELECT id FROM ResearchCo_post_proposal p WHERE p.todo_id=todo.id) AS post_proposal_id', [id, owner, conversationId, now]);
      return r.rows[0] ? toTodo(r.rows[0]) : null;
    },
    async update(owner: string, id: string, patch: TodoPatch, now: number): Promise<Todo> {
      if ((await pool.query('SELECT id FROM ResearchCo_post_proposal WHERE todo_id=$1', [id])).rowCount && (patch.text !== undefined || patch.details !== undefined || patch.done !== undefined || patch.deleted === false)) fail('forbidden', 'post_proposal_is_immutable: submit a new proposal');
      const params: unknown[] = [id, owner, now], sets = ['updated_at = $3'];
      const set = (column: string, value: unknown) => { params.push(value); sets.push(`${column} = $${params.length}`); };
      if (patch.text !== undefined) set('text', patch.text);
      if (patch.details !== undefined) set('details', patch.details);
      if (patch.level !== undefined) set('level', patch.level);
      if (patch.tag !== undefined) set('tag', patch.tag);
      if (patch.dueAt !== undefined) set('due_at', patch.dueAt);
      if (patch.onDate !== undefined) set('on_date', patch.onDate);
      if (patch.remind !== undefined) set('remind', patch.remind);
      if (patch.onHome !== undefined) set('on_home', patch.onHome);
      if (patch.conversationId !== undefined) { set('conversation_id', patch.conversationId); set('own_room', false); }
      if (patch.done !== undefined) set('done_at', patch.done ? now : null);
      if (patch.deleted !== undefined) { set('deleted_at', patch.deleted ? now : null); if (!patch.deleted) set('dismissed_at', null); }
      if (patch.position !== undefined) set('position', patch.position);
      else if (patch.level !== undefined) sets.push(`position = (SELECT coalesce(max(position), 0) + 1 FROM todo WHERE owner_id = $2 AND level = '${patch.level}' AND id <> $1)`);
      const r = await pool.query(`UPDATE todo SET ${sets.join(', ')} WHERE id = $1 AND owner_id = $2 RETURNING *, (SELECT id FROM ResearchCo_post_proposal p WHERE p.todo_id=todo.id) AS post_proposal_id`, params);
      return r.rows[0] ? toTodo(r.rows[0]) : fail('not_found', 'To-do item not found');
    },
  };
}
export type Todos = ReturnType<typeof todoStore>;
/** A DATE column (on_date) reads as its YYYY-MM-DD text, never as a JS Date at the server's midnight. */
export const DATE_AS_TEXT = { getTypeParser: ((oid: number, format?: 'text' | 'binary') => oid === 1082 ? (v: string) => v : pg.types.getTypeParser(oid, format as 'text')) as typeof pg.types.getTypeParser };

const HEADINGS: Record<string, TodoLevel | 'done'> = { today: 'today', soon: 'soon', 'this week': 'soon', later: 'later', 'this month': 'later', someday: 'someday', done: 'done' };
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
export type SeedItem = TodoInput & { done: { at: number } | null };
/** Kenaznia's markdown list (memory/todo.md): "- [ ] text [Tag] 🔔 2 pm" lines under ## Today / ## Soon (or This week) / ## Later / ## Someday,
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
    items.push({ text: body, details: null, level: section === 'done' ? 'someday' : section, tag, dueAt: null, onDate: null, remind, onHome: false, conversationId: null, done });
  }
  return items;
}

/** A person's list starts from their markdown list (HOME/ID/memory/todo.md) the first time the to-do list starts for them:
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

/** A to-do links only to a room its owner is in (a chat or a project page). */
export async function linkedTo<T extends { conversationId?: string | null }>(store: { getConversation(id: string, viewer: string): Promise<{ memberIds: string[] } | null> }, owner: string, v: T): Promise<T> {
  if (v.conversationId && !(await store.getConversation(v.conversationId, owner))?.memberIds.includes(owner)) fail('not_found', 'Chat not found');
  return v;
}

/** What Kenaznia gets in a to-do's new chat, so she opens it without waiting for the person to type. */
export const todoOpener = (t: Todo, room: string) => `She tapped the to-do "${t.text}"${t.tag ? ` [${t.tag}]` : ''} in the Kenan app, which opened this new chat for it (conversation ${room}, made for the to-do ${t.id}). `
  + (t.details ? `Its details, which she sees pinned at the top of this chat: ${t.details}\n` : '')
  + `Start the conversation here now with a short opener, like "Let's do this: ${t.text}. Where are you at?", then help her get it done. `
  + 'When it is done, tick the to-do done with the todos tool: that closes this chat.';

/** The to-do side: changes that keep an item's own chat open or closed with it, and the chat a tap opens. */
export function todoService(deps: Pick<Deps, 'store' | 'bus' | 'runtime' | 'now'>, todos: () => Todos) {
  const opening = new Map<string, Promise<TodoChat>>();
  const changed = (owner: string, todo: Todo) => { deps.bus.toPerson(owner, { type: 'todo', todo }); return todo; };
  /** An item's own chat is closed exactly while the item is done or deleted. */
  const syncRoom = async (owner: string, t: Todo) => {
    if (!t.ownRoom || !t.conversationId) return;
    const room = await deps.store.getConversation(t.conversationId, owner), closed = t.doneAt !== null || t.deletedAt !== null;
    if (room && room.archived !== closed) await announceRoom(deps.store, deps.bus, owner, await deps.store.updateConversation(room.id, owner, { archived: closed }), true);
  };
  const create = async (owner: string, t: Todo): Promise<TodoChat> => {
    const manager = deps.runtime.managerFor(owner);
    const made = await deps.store.createConversation({ title: t.text.slice(0, 200), ownerId: owner, memberIds: [owner, ...(manager ? [manager] : [])] });
    const room = await deps.store.updateConversation(made.id, owner, { emoji: todoEmoji(t.text, t.tag) });
    const todo = await todos().attachRoom(owner, t.id, room.id, deps.now());
    if (!todo) { await deps.store.updateConversation(room.id, owner, { archived: true }); return chat(owner, t.id); }
    await announceRoom(deps.store, deps.bus, owner, room, true); changed(owner, todo);
    if (manager) deps.runtime.deliver({ agentId: manager, kind: 'room', fromId: 'system', conversationId: room.id, text: todoOpener(todo, room.id) });
    return { conversation: room, todo, opener: manager ? 'asked' : 'no_manager' };
  };
  /** The chat to do an item in: its linked chat (a project's own chat for a project), or a new one made for it. */
  const chat = async (owner: string, id: string): Promise<TodoChat> => {
    const t = await todos().get(owner, id);
    if (t.deletedAt !== null) fail('not_found', 'To-do item not found');
    const linked = t.conversationId ? await deps.store.getConversation(t.conversationId, owner) : null;
    if (linked?.memberIds.includes(owner)) return { conversation: linked, todo: t, opener: 'none' };
    if (t.conversationId) fail('not_found', 'Chat not found');
    if (t.doneAt !== null) fail('conflict', 'todo_done: reopen the to-do to start a chat for it');
    return create(owner, t);
  };
  return {
    changed,
    async update(owner: string, id: string, patch: TodoPatch): Promise<Todo> {
      const t = await todos().update(owner, id, await linkedTo(deps.store, owner, patch), deps.now());
      if (patch.done !== undefined || patch.deleted !== undefined) await syncRoom(owner, t);
      return changed(owner, t);
    },
    chat(owner: string, id: string): Promise<TodoChat> {
      const running = opening.get(id); if (running) return running;
      const next = chat(owner, id).finally(() => opening.delete(id));
      opening.set(id, next); return next;
    },
  };
}


/** Her tap on a question's option: the answer is recorded once, and posted as her own message in the chat the question was
 *  asked from (her Kenaznia's own chat when that one is closed or gone), quoting the question, so Kenaznia hears question
 *  and choice there like anything she types. */
export async function answerQuestion(deps: Deps, todos: () => Todos, owner: string, id: string, choice: string, postClient = false): Promise<Todo> {
  if (!postClient && (await todos().get(owner, id)).postProposalId) fail('forbidden', 'post_approval_requires_client_card');
  const answered = await todos().answer(owner, id, choice, deps.now());
  if (!answered) {
    const now = await todos().get(owner, id);
    if (now.options === null) return fail('invalid_input', 'not_a_question: this to-do has no options to answer');
    if (now.deletedAt !== null) fail('conflict', 'question_withdrawn: Kenaznia withdrew this question');
    if (now.answer !== null) fail('conflict', `question_answered: already answered "${now.answer}"`);
    if (now.doneAt !== null) fail('conflict', 'question_closed: this question was closed without an answer');
    return fail('invalid_input', `choice must be one of: ${now.options.join(' / ')}`);
  }
  const t = answered;
  deps.bus.toPerson(owner, { type: 'todo', todo: t });
  const text = `> ${t.text.replace(/\n/g, '\n> ')}\n\n${t.answer}`, clientId = `answer:${t.id}`;
  const post = (conversationId: string) => deps.store.admitHumanMessage({ conversationId, authorId: owner, text, parts: [], clientId });
  let admitted = t.conversationId ? await post(t.conversationId) : null;
  if (!admitted || (admitted.kind !== 'admitted' && admitted.kind !== 'duplicate')) {
    const manager = deps.runtime.managerFor(owner), agent = manager ? await deps.store.getAgent(manager) : null;
    if (agent) admitted = await post(agent.conversationId);
  }
  if (admitted?.kind === 'admitted') {
    const { message, conversation } = admitted;
    deps.bus.toConversation(conversation.id, { type: 'message', message });
    void deps.runtime.onHumanMessage(message, conversation, null);
    notifyChatMembers(deps, NOTIFY_OUTBOX_ROOT, conversation, message).catch(e => console.log(JSON.stringify({ type: 'chat_notify_failed', error: String(e) })));
  } else if (admitted?.kind !== 'duplicate') console.log(JSON.stringify({ type: 'question_answer_not_posted', todoId: t.id, admission: admitted?.kind ?? 'no_chat' }));
  return t;
}

/** Her Dismiss on a question card: she will write a fuller answer in the chat instead. No message is posted and no turn starts. */
export async function dismissQuestion(deps: Deps, todos: () => Todos, owner: string, id: string): Promise<Todo> {
  const t = await todos().dismiss(owner, id, deps.now());
  if (!t) {
    const now = await todos().get(owner, id);
    if (now.options === null) return fail('invalid_input', 'not_a_question: this to-do has no options');
    if (now.dismissedAt !== null) return now;
    return fail('conflict', now.answer !== null ? `question_answered: already answered "${now.answer}"` : 'question_closed: this question is already closed');
  }
  deps.bus.toPerson(owner, { type: 'todo', todo: t });
  return t;
}

const QUESTION_DESCRIPTION = (name: string) => `Ask ${name} a question she answers with one tap. ask: text (the question, one short line, e.g. "Allianz travel insurance, CA$678?"), options (2–4 short answers, e.g. ["Yes", "No", "Later"]), optional details (markdown) and chatId (default: the chat your turn answers). It shows as a card in that chat, and in the To-do screen, until she answers. Her tap posts her choice there as her own message, quoting the question, which starts your turn in that chat. She can also just write an answer in the chat; then withdraw the question, or she taps Dismiss on the card to write a fuller answer (no message is posted; the question shows as dismissed). list: her open questions, then those she dismissed (status "dismissed"). withdraw: id (the full id or an 8+ character prefix) takes the card away.`;

/** The question tool (extension "questions", Kenaznia only): questions are to-dos with options, so the To-do list shows them. */
function questionTool(ctx: ToolContext, todos: () => Todos): KenanTool {
  const { deps, person, agent } = ctx;
  return {
    name: 'question', files: 'none', records: 'writes', label: 'Question', description: QUESTION_DESCRIPTION(person.name),
    parameters: Type.Object({
      action: Type.Union([Type.Literal('ask'), Type.Literal('list'), Type.Literal('withdraw')]),
      text: Type.Optional(Type.String({ minLength: 1, maxLength: 300 })), options: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 40 }), { minItems: 2, maxItems: 4 })),
      details: Type.Optional(Type.String({ maxLength: 20_000 })), chatId: Type.Optional(Type.String()), id: Type.Optional(Type.String()),
    }),
    execute: async (_id, raw: unknown) => {
      const args = raw as { action: 'ask' | 'list' | 'withdraw'; text?: string; options?: string[]; details?: string; chatId?: string; id?: string };
      const owner = person.id, now = deps.now();
      const open = async () => (await todos().list(owner, now)).filter(t => t.options !== null && t.answer === null && t.doneAt === null && t.deletedAt === null);
      const view = (t: Todo) => ({ id: t.id, text: t.text, options: t.options, chatId: t.conversationId, askedAt: new Date(t.createdAt).toISOString(), ...(t.dismissedAt !== null && { status: 'dismissed' as const }) });
      let value: unknown;
      if (args.action === 'list') value = { items: [...(await open()), ...(await todos().list(owner, now)).filter(t => t.dismissedAt !== null)].map(view) };
      else if (args.action === 'withdraw') {
        const found = resolveId(await open(), args.id ?? fail('invalid_input', 'withdraw needs id'), 'question');
        value = { withdrawn: view(await todoService(deps, todos).update(owner, found.id, { deleted: true })) };
      } else {
        const question = text(args.text ?? fail('invalid_input', 'ask needs text: the question'));
        const options = (args.options ?? fail('invalid_input', 'ask needs options: 2–4 short answers')).map(o => o.trim());
        if (options.some(o => !o) || new Set(options.map(o => o.toLowerCase())).size !== options.length) fail('invalid_input', 'options must be 2–4 different, non-empty answers');
        const conversationId = args.chatId ?? answeringChat(agent, deps.runtime.turnOf(agent.id));
        const room = await deps.store.getConversation(conversationId, owner);
        if (!room?.memberIds.includes(owner) || !room.memberIds.includes(agent.id)) fail('not_found', `chat_not_found: ${conversationId} is not a chat ${person.name} and you are both in`);
        const t = await todos().ask(owner, { text: question, details: args.details?.trim() || null, options, conversationId }, now);
        deps.bus.toPerson(owner, { type: 'todo', todo: t });
        const message = await deps.store.appendMessage({ conversationId, authorId: agent.id, role: 'assistant', display: 'shown', text: question + (t.details ? `\n\n${t.details}` : ''), parts: [{ type: 'question', todoId: t.id, options }] });
        deps.bus.toConversation(conversationId, { type: 'message', message });
        value = { asked: view(t) };
      }
      return { content: [{ type: 'text', text: JSON.stringify(value) }], details: {} };
    },
  };
}

/** The to-do pool is the todos extension's; the questions extension (Kenaznia's question tool) reads through it. */
let sharedTodos: (() => Todos) | undefined;
export const questionsExtension: Extension = {
  id: 'questions', name: 'Questions', roles: ['manager'],
  tool: ctx => questionTool(ctx, () => (sharedTodos ?? fail('unavailable', 'questions needs the todos extension'))()),
};


const TOOL_DESCRIPTION = `Read and change the person's to-do list (the To-do screen of the Kenan app).
Levels: today | soon (next few days, no set day) | later (this month) | someday. 'week' is accepted and means soon.
onDate (YYYY-MM-DD, her local day in her current time zone, which follows her phone; no time) is the day an item is for ("Tuesday"): from that day on, while open, it shows in Today whatever its level, and it shows on that day in her calendar. Use dueAt only for a real time.
text is a short title (fits in 2 lines: what to do, nothing else); put background, links, steps and notes in details (markdown), shown at the top of the to-do's chat.
list: open items plus those done in the last 30 days, in the order her lists show them (by section, ❗ items first in each); section is where each shows now (today when onDate has come). add: text, optional details, level, optional tag (e.g. Business, Kenan app, Career, Exampletown, Phone, Personal), onDate, dueAt (ISO), remind (true = a reminder is set; schedule the wake yourself), conversationId (a chat of hers).
Every id is the full id or a unique 8+ character prefix of it. update: id plus any of text, details, level, tag, onDate, dueAt, remind, conversationId (null clears). done / reopen: id. move: id + level (goes to the end of that level). delete: id (undoable with update deleted=false).
conversationId links an item to one of her chats: tapping the item in the app opens that chat.
Tapping an unlinked item makes a chat for it (ownRoom: true) and asks you to open it; done or delete closes that chat, reopen reopens it.
${BUY_TOOL_TEXT}`;
const zoneOf = async (store: Store, person: string) => zoneOrHome(await store.zoneOf(person));
const TODO_PROPERTIES = {
  id: Type.Optional(Type.String()), text: Type.Optional(Type.String()), details: Type.Optional(Type.Union([Type.String(), Type.Null()])), level: Type.Optional(Type.Union([...TODO_LEVELS, ...Object.keys(LEVEL_ALIASES)].map(v => Type.Literal(v)))),
  onDate: Type.Optional(Type.Union([Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' }), Type.Null()])),
  tag: Type.Optional(Type.Union([Type.String(), Type.Null()])), dueAt: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  remind: Type.Optional(Type.Boolean()), conversationId: Type.Optional(Type.Union([Type.String(), Type.Null()])), deleted: Type.Optional(Type.Boolean()),
  section: Type.Optional(Type.String()),
  place: Type.Optional(Type.Union([Type.Literal('top'), Type.Literal('bottom'), Type.Object({ before: Type.String() }), Type.Object({ after: Type.String() })])),
  name: Type.Optional(Type.String()), emoji: Type.Optional(Type.Union([Type.String(), Type.Null()])), color: Type.Optional(Type.String()),
};

export function createTodosExtension(): Extension {
  let pool: pg.Pool | undefined;
  let posts: ReturnType<typeof postApproval> | undefined;
  const todos = (): Todos => pool ? todoStore(pool) : fail('unavailable', 'To-do list is not started');
  sharedTodos = todos;
  const buy = (deps: Pick<Deps, 'bus' | 'now'>) => buyService(buyStore(pool ?? fail('unavailable', 'To buy list is not started')), deps.bus, deps.now);
  const enabled = (person: PersonConfig) => person.extensions.includes('todos') || person.extensions.includes('organized');
  return {
    id: 'todos', name: 'To-do', enabled,
    async start(deps) {
      pool = new pg.Pool({ connectionString: deps.config.databaseUrl, max: 2, types: DATE_AS_TEXT });
      if (deps.config.people.some(p => p.id === 'alice' && enabled(p) && p.manager && !('elsewhere' in p.manager))) {
        posts = postApproval(deps, pool, todos, (id, choice) => answerQuestion(deps, todos, 'alice', id, choice, true));
        await posts.start();
      }
      for (const person of deps.config.people.filter(enabled)) {
        const count = await seed(pool, person.id, join(person.home, person.id, 'memory', 'todo.md'), deps.now());
        if (count) console.log(JSON.stringify({ type: 'todo_seeded', person: person.id, count }));
      }
    },
    async stop() { await posts?.stop(); posts = undefined; await pool?.end(); pool = undefined; },
    routes(app, deps) {
      app.use('*', async (c, next) => { if (!enabled(deps.person(personOf(c)) ?? fail('forbidden', 'To-do list is not enabled'))) fail('forbidden', 'To-do list is not enabled'); await next(); });
      app.all('/post-proposals/*', c => posts ? posts.request(c) : fail('unavailable', 'Post approval is not started'));
      const service = todoService(deps, todos);
      app.get('/todos', async c => c.json({ ok: true, value: await todos().list(personOf(c), deps.now()) }));
      app.post('/todos', async c => c.json({ ok: true, value: service.changed(personOf(c), await todos().add(personOf(c), await linkedTo(deps.store, personOf(c), parseTodoInput(await c.req.json())), deps.now())) }));
      app.patch('/todos/:id', async c => c.json({ ok: true, value: await service.update(personOf(c), c.req.param('id'), parseTodoPatch(await c.req.json())) }));
      app.delete('/todos/:id', async c => c.json({ ok: true, value: await service.update(personOf(c), c.req.param('id'), { deleted: true }) }));
      buyRoutes(app, () => buy(deps), c => personOf(c as never), deps.now);
      app.post('/todos/:id/answer', async c => {
        const b = await c.req.json() as Record<string, unknown>;
        return c.json({ ok: true, value: await answerQuestion(deps, todos, personOf(c), c.req.param('id'), typeof b.choice === 'string' ? b.choice : fail('invalid_input', 'choice required')) });
      });
      app.post('/todos/:id/dismiss', async c => c.json({ ok: true, value: await dismissQuestion(deps, todos, personOf(c), c.req.param('id')) }));
      app.post('/todos/:id/chat', async c => c.json({ ok: true, value: await service.chat(personOf(c), c.req.param('id')) }));
    },
    tool: ctx => {
      const added = withModule(ctx.person).flatMap(m => m.additions?.todos ?? []);
      return {
        name: 'todos', files: 'none', records: 'none', label: 'To-do', description: [TOOL_DESCRIPTION, ...added.map(a => a.description)].join('\n'),
        parameters: Type.Object({
          action: Type.Union([...['list', 'add', 'update', 'done', 'reopen', 'move', 'delete'], ...BUY_ACTIONS, ...added.flatMap(a => a.actions)].map(v => Type.Literal(v))),
          ...TODO_PROPERTIES, ...Object.assign({}, ...added.map(a => a.properties)),
        }),
        execute: async (_id, raw: unknown) => {
          const { action, id, ...rest } = raw as Record<string, unknown> & { action: string; id?: string };
          const owner = ctx.person.id, now = ctx.deps.now(), need = () => id ?? fail('invalid_input', `${action} needs id`), service = todoService(ctx.deps, todos);
          const apply = async (patch: TodoPatch) => {
            const found = matchId(await todos().list(owner, now), need(), 'todo');
            if (!found.ok && found.code === 'todo_id_ambiguous') throw new IdFailure(found.code, found.message);
            return service.update(owner, found.ok ? found.value.id : need(), patch);
          };
          let value: unknown;
          const extra = added.find(a => a.actions.includes(action));
          if (extra) value = await extra.run(action, { id, ...rest }, ctx, undefined);
          else if (BUY_ACTIONS.includes(action as BuyAction)) value = await buyAction(buy(ctx.deps), owner, action as BuyAction, { id, ...rest }, now);
          else switch (action) {
            case 'list': { const today = todayIn(now, await zoneOf(ctx.deps.store, owner)), rows = (await todos().list(owner, now)).filter(t => !t.deletedAt).map(({ createdAt: _c, updatedAt: _u, deletedAt: _d, ...t }) => ({ ...t, section: todoSection(t, today) }));
              value = TODO_LEVELS.flatMap(l => urgentFirst(rows.filter(t => t.section === l))); break; }
            case 'add': value = service.changed(owner, await todos().add(owner, await linkedTo(ctx.deps.store, owner, parseTodoInput(rest)), now)); break;
            case 'update': value = await apply(parseTodoPatch(rest)); break;
            case 'done': value = await apply({ done: true }); break;
            case 'reopen': value = await apply({ done: false }); break;
            case 'move': value = await apply({ level: level(rest.level) }); break;
            case 'delete': value = await apply({ deleted: true }); break;
            default: fail('invalid_input', `Unknown action ${action}`);
          }
          return { content: [{ type: 'text', text: JSON.stringify(value) }], details: {} };
        },
      };
    },
  };
}
export const todosExtension = createTodosExtension();
/** The pool of to-dos for modules that read them (the morning check). */
export { zoneOf };
