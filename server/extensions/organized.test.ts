import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { createStore, type PgStore } from '../db/store.js';
import { freshSchema, testDatabaseUrl } from '../db/test-db.js';
import { DONE_SHOWN_MS, createRoomsExtension, parseTodoMarkdown, parseTodoPatch, todoStore } from './organized.js';

const NOW = Date.UTC(2026, 9, 21, 12);

describe('to-do markdown import', () => {
  it('reads levels, tags, reminders and done dates from Kenaznia\'s list, and nothing outside the sections', () => {
    const items = parseTodoMarkdown(`# Carol's to-do list
Levels: Today · This week. Tags: [Candef]
- [ ] not an item, no section yet [Candef]
## Today (Tue Oct 20)
- [ ] Install the Proton Mail app and sign in [Candef] 🔔 2 pm
- [ ] Tap Proton's link [Candef]
## This week
- [ ] 🔔 Thu: tell Kenan your flight time [Berkeley]
## Someday
- [ ] Improve speech-to-text
## Done
- [x] Work email created (Oct 19) [Candef]
`, NOW);
    expect(items.map(i => [i.text, i.level, i.tag, i.remind, i.done?.at ?? null])).toEqual([
      ['Install the Proton Mail app and sign in · 2 pm', 'today', 'Candef', true, null],
      ["Tap Proton's link", 'today', 'Candef', false, null],
      ['Thu: tell Kenan your flight time', 'week', 'Berkeley', true, null],
      ['Improve speech-to-text', 'someday', null, false, null],
      ['Work email created (Oct 19)', 'someday', 'Candef', false, Date.UTC(2026, 9, 19, 12)],
    ]);
  });
  it('refuses an empty patch and unknown levels', () => {
    expect(() => parseTodoPatch({})).toThrow(/Nothing to change/);
    expect(() => parseTodoPatch({ level: 'tomorrow' })).toThrow(/level/);
  });
});

describe.skipIf(!testDatabaseUrl)('to-do store and layout', () => {
  let store: PgStore, pool: pg.Pool;
  beforeAll(async () => {
    const url = await freshSchema('t_todo');
    store = createStore(url); await store.migrate(); await store.migrate();
    await store.upsertPerson({ id: 'm', name: 'M', kind: 'human' });
    pool = new pg.Pool({ connectionString: url, max: 1 });
  });
  afterAll(async () => { await pool?.end(); await store?.close(); });

  it('keeps level order, moves to the end of a level, hides old done and deleted items, and undoes', async () => {
    const todos = todoStore(pool);
    const a = await todos.add('m', { text: 'a', level: 'week', tag: null, dueAt: null, remind: false, conversationId: null }, NOW);
    const b = await todos.add('m', { text: 'b', level: 'today', tag: 'Candef', dueAt: null, remind: true, conversationId: null }, NOW);
    const c = await todos.add('m', { text: 'c', level: 'today', tag: null, dueAt: null, remind: false, conversationId: null }, NOW);
    await todos.add('m', { text: 'old', level: 'today', tag: null, dueAt: null, remind: false, conversationId: null }, NOW, NOW - DONE_SHOWN_MS - 1);
    expect((await todos.list('m', NOW)).map(t => t.text)).toEqual(['b', 'c', 'a']);
    await todos.update('m', a.id, { level: 'today' }, NOW);
    await todos.update('m', b.id, { done: true }, NOW);
    expect((await todos.list('m', NOW)).map(t => [t.text, t.doneAt !== null])).toEqual([['b', true], ['c', false], ['a', false]]);
    await todos.update('m', c.id, { deleted: true }, NOW);
    expect((await todos.update('m', c.id, { deleted: false }, NOW)).deletedAt).toBeNull();
    await expect(todos.update('other', a.id, { done: true }, NOW)).rejects.toThrow(/not found/);
  });

  it('stores the layout per person, classic until chosen, and refuses other values', async () => {
    expect(await store.layoutOf('m')).toBe('classic');
    expect(await store.setLayout('m', 'organized')).toBe('organized');
    await expect(store.setLayout('m', 'fancy' as never)).rejects.toThrow();
  });

  it('a renamed topic is locked; pins carry an optional key date', async () => {
    const conv = await store.createConversation({ title: 'Auto', ownerId: 'm', memberIds: ['m'] });
    expect(conv).toMatchObject({ titleLocked: false, pinnedAt: null, emoji: null, keyDate: null });
    const pinned = await store.updateConversation(conv.id, 'm', { title: 'Mine', titleLocked: true, pinnedAt: NOW, emoji: '💼', keyDate: '2026-10-29', keyLabel: 'Due' });
    expect(pinned).toMatchObject({ title: 'Mine', titleLocked: true, pinnedAt: NOW, emoji: '💼', keyDate: '2026-10-29', keyLabel: 'Due' });
    await expect(store.updateConversation(conv.id, 'm', { keyDate: 'Oct 29' })).rejects.toThrow();
  });

  it('the rooms tool creates rooms and never renames a title she set, unless she asks', async () => {
    const deps = { store, bus: { toPerson() {} }, runtime: { managerFor: () => null } };
    const tool = createRoomsExtension().tool!({ person: { id: 'm' }, deps } as never);
    const run = async (args: object) => JSON.parse(((await tool.execute('t', args as never, undefined, undefined, undefined as never)).content[0] as { text: string }).text);
    const room = await run({ action: 'create', title: 'Ocean Beach', emoji: '🏖️' });
    expect(room).toMatchObject({ title: 'Ocean Beach', emoji: '🏖️', titleLocked: false });
    expect(await run({ action: 'rename', id: room.id, title: 'Beach safety' })).toMatchObject({ title: 'Beach safety', titleLocked: false });
    await store.updateConversation(room.id, 'm', { title: 'My beach', titleLocked: true });
    await expect(run({ action: 'rename', id: room.id, title: 'Auto' })).rejects.toThrow(/title_locked/);
    expect(await run({ action: 'rename', id: room.id, title: 'Her new name', herRequest: true })).toMatchObject({ title: 'Her new name', titleLocked: true });
  });
});
