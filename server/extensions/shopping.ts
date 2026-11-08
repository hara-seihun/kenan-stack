// The 🛒 To buy list (Carol 2026-10-22): a permanent shopping list per person, apart from to-dos.
// Tables buy_section and buy_item (schema.sql); API under /api/ext/todos/buy; the agents reach it through the todos
// tool's buy_* actions. Every change answers and pushes (`buy` event) the person's whole list.
import { randomUUID } from 'node:crypto';
import type { Hono } from 'hono';
import type pg from 'pg';
import type { BuyItem, BuyList, BuySection } from '../../shared/contract.js';
import { SWATCHES } from '../../shared/colors.js';
import type { Bus } from '../types.js';
import { fail } from '../db/errors.js';
import { positionAt } from '../../shared/order.js';

/** The sections a person's list starts with, the first time it is read. */
export const STARTING_SECTIONS = [
  { name: 'Groceries', emoji: '🥕', color: '#9bc53d' },
  { name: 'Things', emoji: '🧰', color: '#5b7fd0' },
  { name: 'Amazon', emoji: '📦', color: '#c03b8f' },
] as const;

export interface SectionInput { name: string; emoji: string | null; color: string | null }
export interface SectionPatch { name?: string; emoji?: string | null; color?: string; position?: number }
export interface ItemPatch { text?: string; sectionId?: string; bought?: boolean; position?: number }
/** Where buy_edit puts an item: first or last in its section (its new one, when it moves), or just above/below another item, in that item's section. */
export type Place = { at: 'top' | 'bottom' } | { before: string } | { after: string };
export function parsePlace(v: unknown): Place {
  if (v === 'top' || v === 'bottom') return { at: v };
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>, keys = Object.keys(o);
    if (keys.length === 1 && keys[0] === 'before') return { before: uuid(o.before, 'place.before') };
    if (keys.length === 1 && keys[0] === 'after') return { after: uuid(o.after, 'place.after') };
  }
  return fail('invalid_input', 'place must be "top", "bottom", {"before": itemId} or {"after": itemId}');
}

const itemText = (v: unknown): string => typeof v === 'string' && v.trim() && v.trim().length <= 200 ? v.trim() : fail('invalid_input', 'text must be 1–200 characters');
const sectionName = (v: unknown): string => typeof v === 'string' && v.trim() && v.trim().length <= 40 ? v.trim() : fail('invalid_input', 'name must be 1–40 characters');
const emoji = (v: unknown): string | null => v === null ? null : typeof v === 'string' && v.trim().length <= 16 ? v.trim() || null : fail('invalid_input', 'emoji must be one emoji or null');
const color = (v: unknown): string => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : fail('invalid_input', 'color must be #RRGGBB');
const uuid = (v: unknown, name: string): string => typeof v === 'string' && /^[0-9a-f-]{36}$/i.test(v) ? v : fail('invalid_input', `${name} must be an id`);
const position = (v: unknown): number => typeof v === 'number' && Number.isFinite(v) ? v : fail('invalid_input', 'position must be a number');
const bool = (v: unknown, name: string): boolean => typeof v === 'boolean' ? v : fail('invalid_input', `${name} must be boolean`);

export function parseSectionInput(b: Record<string, unknown>): SectionInput {
  return { name: sectionName(b.name), emoji: b.emoji === undefined ? null : emoji(b.emoji), color: b.color === undefined || b.color === null ? null : color(b.color) };
}
export function parseSectionPatch(b: Record<string, unknown>): SectionPatch {
  const patch: SectionPatch = {};
  if (b.name !== undefined) patch.name = sectionName(b.name);
  if (b.emoji !== undefined) patch.emoji = emoji(b.emoji);
  if (b.color !== undefined) patch.color = color(b.color);
  if (b.position !== undefined) patch.position = position(b.position);
  if (!Object.keys(patch).length) fail('invalid_input', 'Nothing to change');
  return patch;
}
export function parseItemPatch(b: Record<string, unknown>): ItemPatch {
  const patch: ItemPatch = {};
  if (b.text !== undefined) patch.text = itemText(b.text);
  if (b.sectionId !== undefined) patch.sectionId = uuid(b.sectionId, 'sectionId');
  if (b.bought !== undefined) patch.bought = bool(b.bought, 'bought');
  if (b.position !== undefined) patch.position = position(b.position);
  if (!Object.keys(patch).length) fail('invalid_input', 'Nothing to change');
  return patch;
}

/** A new section's colour when none is given: the first swatch no section of hers uses yet, else the least used one. */
export function nextColor(used: readonly string[]): string {
  const count = (c: string) => used.filter(u => u === c).length;
  return SWATCHES.map(([c]) => c).reduce((best, c) => count(c) < count(best) ? c : best, SWATCHES[0][0]);
}

/** The section a name or id means: its id, or its name without case, spaces or a leading emoji ("groceries", "🥕 Groceries"). */
export function findSection(sections: readonly BuySection[], ref: string): BuySection {
  const key = (s: string) => s.replace(/^[^\p{L}\p{N}]+/u, '').trim().toLowerCase();
  return sections.find(s => s.id === ref) ?? sections.find(s => key(s.name) === key(ref))
    ?? fail('not_found', `No To buy section "${ref}"; her sections: ${sections.map(s => s.name).join(', ')}`);
}

const toSection = (r: Record<string, unknown>): BuySection => ({ id: r.id as string, name: r.name as string, emoji: r.emoji as string | null, color: r.color as string, position: Number(r.position) });
const toItem = (r: Record<string, unknown>): BuyItem => ({ id: r.id as string, sectionId: r.section_id as string, text: r.text as string, position: Number(r.position), boughtAt: r.bought_at === null ? null : Number(r.bought_at) });

export function buyStore(pool: pg.Pool) {
  const sections = async (owner: string): Promise<BuySection[]> => (await pool.query('SELECT * FROM buy_section WHERE owner_id = $1 ORDER BY position, created_at', [owner])).rows.map(toSection);
  const endOf = (owner: string, section: string) => pool.query('SELECT coalesce(max(position), 0) + 1 AS p FROM buy_item WHERE owner_id = $1 AND section_id = $2', [owner, section]).then(r => Number(r.rows[0].p));
  const mine = async (owner: string, section: string) => (await sections(owner)).find(s => s.id === section) ?? fail('not_found', 'Section not found');
  return {
    /** Her sections in order and her open items, after creating the starting sections if she has none yet. */
    async list(owner: string, now: number): Promise<BuyList> {
      if (!(await pool.query('SELECT 1 FROM buy_section WHERE owner_id = $1 LIMIT 1', [owner])).rowCount) {
        for (const [i, s] of STARTING_SECTIONS.entries()) {
          await pool.query('INSERT INTO buy_section (id, owner_id, name, emoji, color, position, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING',
            [randomUUID(), owner, s.name, s.emoji, s.color, i + 1, now]);
        }
      }
      const items = await pool.query('SELECT * FROM buy_item WHERE owner_id = $1 AND bought_at IS NULL ORDER BY position, created_at', [owner]);
      return { sections: await sections(owner), items: items.rows.map(toItem) };
    },
    /** A new item goes to the end of its section. */
    async addItem(owner: string, section: string, text: string, now: number): Promise<BuyItem> {
      await mine(owner, section);
      const r = await pool.query('INSERT INTO buy_item (id, owner_id, section_id, text, position, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $6) RETURNING *',
        [randomUUID(), owner, section, itemText(text), await endOf(owner, section), now]);
      return toItem(r.rows[0]);
    },
    /** Moving an item to another section without a position puts it at the end there. */
    async updateItem(owner: string, id: string, patch: ItemPatch, now: number): Promise<BuyItem> {
      const params: unknown[] = [id, owner, now], sets = ['updated_at = $3'];
      const set = (column: string, value: unknown) => { params.push(value); sets.push(`${column} = $${params.length}`); };
      if (patch.text !== undefined) set('text', patch.text);
      if (patch.sectionId !== undefined) { await mine(owner, patch.sectionId); set('section_id', patch.sectionId); }
      if (patch.bought !== undefined) set('bought_at', patch.bought ? now : null);
      if (patch.position !== undefined) set('position', patch.position);
      else if (patch.sectionId !== undefined) set('position', await endOf(owner, patch.sectionId));
      const r = await pool.query(`UPDATE buy_item SET ${sets.join(', ')} WHERE id = $1 AND owner_id = $2 RETURNING *`, params);
      return r.rows[0] ? toItem(r.rows[0]) : fail('not_found', 'To buy item not found');
    },
    /** The section and position that put an item at a place among her open items (the item itself left out). */
    async placeOf(owner: string, id: string, place: Place, sectionId: string | null): Promise<{ sectionId: string; position: number }> {
      const open = (await pool.query('SELECT * FROM buy_item WHERE owner_id = $1 AND bought_at IS NULL ORDER BY position, created_at', [owner])).rows.map(toItem);
      const item = (await pool.query('SELECT * FROM buy_item WHERE id = $1 AND owner_id = $2', [id, owner])).rows.map(toItem)[0] ?? fail('not_found', 'To buy item not found');
      const anchorId = 'before' in place ? place.before : 'after' in place ? place.after : null;
      const anchor = anchorId === null ? null : open.find(i => i.id === anchorId) ?? fail('not_found', `No open To buy item ${anchorId}`);
      if (anchor && anchor.id === id) fail('invalid_input', 'place cannot be relative to the item itself');
      if (anchor && sectionId !== null && sectionId !== anchor.sectionId) fail('invalid_input', 'place before/after puts it in that item\'s section; leave out section');
      const target = anchor?.sectionId ?? sectionId ?? item.sectionId;
      const rows = open.filter(i => i.sectionId === target && i.id !== id);
      const index = 'at' in place ? (place.at === 'top' ? 0 : rows.length) : rows.findIndex(i => i.id === anchor!.id) + ('after' in place ? 1 : 0);
      return { sectionId: target, position: positionAt(rows.map(i => i.position), index) };
    },
    async removeItem(owner: string, id: string): Promise<BuyItem> {
      const r = await pool.query('DELETE FROM buy_item WHERE id = $1 AND owner_id = $2 RETURNING *', [id, owner]);
      return r.rows[0] ? toItem(r.rows[0]) : fail('not_found', 'To buy item not found');
    },
    /** A new section goes last; a name she already has is refused (conflict). */
    async addSection(owner: string, input: SectionInput, now: number): Promise<BuySection> {
      const current = await sections(owner);
      if (current.some(s => s.name.toLowerCase() === input.name.toLowerCase())) fail('conflict', `section_exists: she already has a section "${input.name}"`);
      const r = await pool.query('INSERT INTO buy_section (id, owner_id, name, emoji, color, position, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *',
        [randomUUID(), owner, input.name, input.emoji, input.color ?? nextColor(current.map(s => s.color)), Math.max(0, ...current.map(s => s.position)) + 1, now]);
      return toSection(r.rows[0]);
    },
    async updateSection(owner: string, id: string, patch: SectionPatch): Promise<BuySection> {
      const current = await mine(owner, id);
      if (patch.name !== undefined && patch.name.toLowerCase() !== current.name.toLowerCase() && (await sections(owner)).some(s => s.name.toLowerCase() === patch.name!.toLowerCase())) fail('conflict', `section_exists: she already has a section "${patch.name}"`);
      const r = await pool.query('UPDATE buy_section SET name = $3, emoji = $4, color = $5, position = $6 WHERE id = $1 AND owner_id = $2 RETURNING *',
        [id, owner, patch.name ?? current.name, patch.emoji !== undefined ? patch.emoji : current.emoji, patch.color ?? current.color, patch.position ?? current.position]);
      return toSection(r.rows[0]);
    },
    /** Only an empty section goes, and never her last one. */
    async removeSection(owner: string, id: string): Promise<BuySection> {
      const all = await sections(owner), section = all.find(s => s.id === id) ?? fail('not_found', 'Section not found');
      if (all.length === 1) fail('conflict', 'last_section: the list keeps at least one section');
      if ((await pool.query('SELECT 1 FROM buy_item WHERE owner_id = $1 AND section_id = $2 AND bought_at IS NULL LIMIT 1', [owner, id])).rowCount) fail('conflict', `section_not_empty: "${section.name}" still has items; remove or move them first`);
      await pool.query('DELETE FROM buy_section WHERE id = $1 AND owner_id = $2', [id, owner]);
      return section;
    },
  };
}
export type BuyStore = ReturnType<typeof buyStore>;

/** Runs a change and pushes the person's whole list after it; answers the list. */
export function buyService(store: BuyStore, bus: Pick<Bus, 'toPerson'>, now: () => number) {
  const publish = async (owner: string) => { const list = await store.list(owner, now()); bus.toPerson(owner, { type: 'buy', list }); return list; };
  return { store, publish, async change<T>(owner: string, run: () => Promise<T>): Promise<{ value: T; list: BuyList }> { const value = await run(); return { value, list: await publish(owner) }; } };
}

/** HTTP routes under /api/ext/todos/buy; each change answers the whole list. */
export function buyRoutes(app: Hono, service: () => ReturnType<typeof buyService>, owner: (c: unknown) => string, now: () => number) {
  const body = async (c: { req: { json(): Promise<unknown> } }) => { const b = await c.req.json(); return b && typeof b === 'object' ? b as Record<string, unknown> : fail('invalid_input', 'body must be an object'); };
  const id = (c: { req: { param(k: string): string } }) => uuid(c.req.param('id'), 'id');
  app.get('/buy', async c => c.json({ ok: true, value: await service().store.list(owner(c), now()) }));
  app.post('/buy/items', async c => { const b = await body(c), me = owner(c); return c.json({ ok: true, value: (await service().change(me, () => service().store.addItem(me, uuid(b.sectionId, 'sectionId'), itemText(b.text), now()))).list }); });
  app.patch('/buy/items/:id', async c => { const me = owner(c), patch = parseItemPatch(await body(c)); return c.json({ ok: true, value: (await service().change(me, () => service().store.updateItem(me, id(c), patch, now()))).list }); });
  app.delete('/buy/items/:id', async c => { const me = owner(c); return c.json({ ok: true, value: (await service().change(me, () => service().store.removeItem(me, id(c)))).list }); });
  app.post('/buy/sections', async c => { const me = owner(c), input = parseSectionInput(await body(c)); return c.json({ ok: true, value: (await service().change(me, () => service().store.addSection(me, input, now()))).list }); });
  app.patch('/buy/sections/:id', async c => { const me = owner(c), patch = parseSectionPatch(await body(c)); return c.json({ ok: true, value: (await service().change(me, () => service().store.updateSection(me, id(c), patch))).list }); });
  app.delete('/buy/sections/:id', async c => { const me = owner(c); return c.json({ ok: true, value: (await service().change(me, () => service().store.removeSection(me, id(c)))).list }); });
}

export const BUY_ACTIONS = ['buy_list', 'buy_add', 'buy_check', 'buy_uncheck', 'buy_edit', 'buy_remove', 'buy_section_add', 'buy_section_edit', 'buy_section_remove'] as const;
export type BuyAction = typeof BUY_ACTIONS[number];
export const BUY_TOOL_TEXT = `To buy list (her 🛒 shopping list, the To buy tab of the To-do screen; NOT to-dos: never add groceries or things to buy as to-dos, and these never show on Home or in the morning check). section is a section's name ("groceries", any case) or id; her starting sections are Groceries, Things and Amazon.
buy_list: sections and open items. buy_add: text + section ("add milk to groceries"; call once per item). buy_check: id (bought: it leaves the list; buy_uncheck brings it back). buy_edit: id + any of text, section (moves it, to the end), place ("top" or "bottom" of its section, or {"before": itemId} / {"after": itemId}: just above/below that item, in its section; "most important first" = top). buy_remove: id.
buy_section_add: name, optional emoji and color (#RRGGBB). buy_section_edit: section + any of name, emoji, color. buy_section_remove: section (only an empty one, never the last).`;

/** One buy_* action of the todos tool. */
export async function buyAction(service: ReturnType<typeof buyService>, owner: string, action: BuyAction, a: Record<string, unknown>, now: number): Promise<unknown> {
  const { store } = service;
  const section = async () => findSection((await store.list(owner, now)).sections, typeof a.section === 'string' && a.section.trim() ? a.section.trim() : fail('invalid_input', `${action} needs section (a name or id)`));
  const id = () => uuid(a.id, 'id');
  const brief = (list: BuyList) => list.sections.map(s => ({ section: s.name, sectionId: s.id, emoji: s.emoji, color: s.color, items: list.items.filter(i => i.sectionId === s.id).map(i => ({ id: i.id, text: i.text })) }));
  switch (action) {
    case 'buy_list': return brief(await store.list(owner, now));
    case 'buy_add': { const s = await section(); return (await service.change(owner, () => store.addItem(owner, s.id, itemText(a.text), now))).value; }
    case 'buy_check': return (await service.change(owner, () => store.updateItem(owner, id(), { bought: true }, now))).value;
    case 'buy_uncheck': return (await service.change(owner, () => store.updateItem(owner, id(), { bought: false }, now))).value;
    case 'buy_edit': {
      const patch: ItemPatch = { ...(a.text !== undefined ? { text: itemText(a.text) } : {}), ...(a.section !== undefined ? { sectionId: (await section()).id } : {}) };
      if (a.place !== undefined) Object.assign(patch, await store.placeOf(owner, id(), parsePlace(a.place), patch.sectionId ?? null));
      if (!Object.keys(patch).length) fail('invalid_input', 'buy_edit needs text, section and/or place');
      return (await service.change(owner, () => store.updateItem(owner, id(), patch, now))).value;
    }
    case 'buy_remove': return (await service.change(owner, () => store.removeItem(owner, id()))).value;
    case 'buy_section_add': { const input = parseSectionInput({ name: a.name, emoji: a.emoji, color: a.color }); return (await service.change(owner, () => store.addSection(owner, input, now))).value; }
    case 'buy_section_edit': { const s = await section(), patch = parseSectionPatch({ name: a.name, emoji: a.emoji, color: a.color }); return (await service.change(owner, () => store.updateSection(owner, s.id, patch))).value; }
    case 'buy_section_remove': { const s = await section(); return (await service.change(owner, () => store.removeSection(owner, s.id))).value; }
  }
}
