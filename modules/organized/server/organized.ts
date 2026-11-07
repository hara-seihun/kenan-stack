// The Organized layout's server side (opt-in per person with the `organized` extension): chat groups, project files, new
// chats, the layout and tip routes, the morning check and the manager's Organized defaults. The to-do list itself is core's
// `todos` extension (server/extensions/todos.ts); this module adds its `morning` and `onHome` to the todos tool.
import { join } from 'node:path';
import pg from 'pg';
import { BUSY_LINE, LAYOUTS, MARKS } from '../../../shared/contract.js';
import type { Extension } from '../../../server/types.js';
import { personOf } from '../../../server/http/app.js';
import { fail } from '../../../server/db/errors.js';
import { parseNewChat, startChat } from '../../../server/extensions/rooms.js';
import { DATE_AS_TEXT } from '../../../server/extensions/todos.js';
import { freezeColors } from './colors.js';
import { chatGroups, groupStore, parseGroupInput, parseGroupPatch, uuidOrNull } from './groups.js';
import { MORNING_DESCRIPTION, runMorningChecks } from './morning.js';
import { chooseLayout, tipSeen } from './onboarding.js';
import { hasOrganized, organizedPeople } from './people.js';

/** Manager defaults on the Organized layout: Carol's organising habits (2026-10-22), which anyone may change. */
export const ORGANIZED_DEFAULTS = `Organized defaults (when the person is on the Organized layout). These are starting habits: what they tell you, and their own memory and preferences, win; when they change one, record it in their preferences and follow that.
1. File work in its topic chat: create goals with the chatId of the existing chat they belong to, and pass chatId on spawns, messages and wakes. Where they asked from another chat, leave one pointer line linking it ("On it: results will go to [📁 Business](chat:<id>)"); say nothing when already in that chat. Unsure which chat: ask. Quick answers stay where asked.
2. To-dos: text is a short title (2 lines at most); background, steps and links go in details. Home shows Today plus only the items they asked to have there (onHome).
3. A daily morning to-do check (todos action morning turns it off or moves it): quietly delete done or obsolete to-dos, re-order by priority, and write only when something needs them today, listing deletions briefly.
4. Chats: give each chat its own fitting emoji (the emoji field, never in the title). Group chats where several share a theme; no single-chat groups. Suggest a new chat when the topic changes. Rename chats as they evolve unless the title is locked. When a topic grows into several chats, files or to-dos, ask "want this to be a project?" (a project gathers them around one bigger thing, ongoing or with a due date). Related projects (e.g. two bids for one client): one project each, in a chat group named for the umbrella, once there are 2+.`;

export function createOrganizedExtension(): Extension {
  let pool: pg.Pool | undefined, timer: ReturnType<typeof setInterval> | undefined;
  const groups = () => groupStore(pool ?? fail('unavailable', 'Organized is not started'));
  return {
    id: 'organized', name: 'Organized', promptSnippet: { manager: ORGANIZED_DEFAULTS },
    async start(deps) {
      pool = new pg.Pool({ connectionString: deps.config.databaseUrl, max: 2, types: DATE_AS_TEXT });
      for (const person of organizedPeople(deps.config)) {
        if (await deps.store.layoutOf(person.id) === 'organized') {
          // Freezing colours is cosmetic: one person's failure must not take her rooms down with it.
          await freezeColors(deps.store, deps.bus, person.id, groups().list).then(
            frozen => { if (frozen) console.log(JSON.stringify({ type: 'chat_colors_frozen', person: person.id, count: frozen })); },
            e => console.log(JSON.stringify({ type: 'chat_colors_freeze_failed', person: person.id, error: String(e) })));
        }
      }
      const morning = () => { if (pool) runMorningChecks(deps, pool).then(sent => { if (sent.length) console.log(JSON.stringify({ type: 'morning_check_sent', people: sent })); }, e => console.log(JSON.stringify({ type: 'morning_check_failed', error: String(e) }))); };
      timer = setInterval(morning, 60_000);
      timer.unref();
    },
    async stop() { if (timer) clearInterval(timer); timer = undefined; await pool?.end(); pool = undefined; },
    routes(app, deps) {
      app.use('*', async (c, next) => { if (!hasOrganized(deps.person(personOf(c)) ?? fail('forbidden', 'Organized is not enabled'))) fail('forbidden', 'Organized is not enabled'); await next(); });
      app.put('/layout', async c => {
        const b = await c.req.json() as Record<string, unknown>;
        return c.json({ ok: true, value: await chooseLayout(deps, personOf(c), LAYOUTS.find(l => l === b.layout) ?? fail('invalid_input', `layout must be one of ${LAYOUTS.join(', ')}`), groups().list) });
      });
      app.post('/seen', async c => {
        const b = await c.req.json() as Record<string, unknown>;
        return c.json({ ok: true, value: await tipSeen(deps, personOf(c), MARKS.find(t => t === b.tip) ?? fail('invalid_input', `tip must be one of ${MARKS.join(', ')}`)) });
      });
      app.get('/projects/:id/files', async c => {
        const me = personOf(c), project = await deps.store.getConversation(c.req.param('id'), me);
        if (!project?.memberIds.includes(me)) fail('not_found', 'Project not found');
        const rooms = (await deps.store.listConversations(me, { includeArchived: true })).filter(r => r.id === project!.id || r.projectId === project!.id).map(r => r.id);
        const r = await (pool ?? fail('unavailable', 'Organized is not started')).query(`SELECT DISTINCT ON (f.id) f.id, f.name, f.mime, f.size, f.created_at, cf.conversation_id
          FROM conversation_file cf JOIN file f ON f.id = cf.file_id WHERE cf.conversation_id = ANY($1::uuid[]) ORDER BY f.id, f.created_at DESC`, [rooms]);
        const files = r.rows.map(x => ({ id: x.id as string, name: x.name as string, mime: x.mime as string, size: Number(x.size), at: Number(x.created_at), conversationId: x.conversation_id as string }));
        return c.json({ ok: true, value: files.sort((a, b) => b.at - a.at).slice(0, 100) });
      });
      const service = () => chatGroups(deps.store, deps.bus, groups()), groupId = (c: { req: { param(k: string): string } }) => uuidOrNull(c.req.param('id'), 'id') ?? fail('invalid_input', 'id required');
      app.get('/groups', async c => c.json({ ok: true, value: await service().list(personOf(c)) }));
      app.post('/groups', async c => c.json({ ok: true, value: await service().create(personOf(c), parseGroupInput(await c.req.json())) }));
      app.patch('/groups/:id', async c => c.json({ ok: true, value: await service().update(personOf(c), groupId(c), parseGroupPatch(await c.req.json())) }));
      app.delete('/groups/:id', async c => c.json({ ok: true, value: await service().remove(personOf(c), groupId(c)) }));
      app.post('/chats', async c => c.json({ ok: true, value: await startChat(deps, personOf(c), parseNewChat(await c.req.json(), id => deps.config.people.some(p => p.id === id))) }));
    },
  };
}
export const organizedExtension = createOrganizedExtension();

/** The floating 🌀 bubble and quick panel of the Organized layout (web/organized/Bubble.tsx), per person while it rolls out. */
export const bubbleExtension: Extension = {
  id: 'bubble', name: 'Quick panel', roles: ['manager'],
  promptSnippet: 'Quick panel: she can talk or type to you from a floating 🌀 bubble on her Home, To-do, Calendar, Chats and project screens; it opens a small panel on this chat. Those messages end with a line like "[seen from: To-do, By urgency]": the screen she was looking at, added by the app. She never sees it, so never quote it; use it to understand "this", "here" or "that one". Keep answers there short: the panel shows two or three lines at first.',
};

/** The busy line (Transcript's BusyLine): under a message of hers that waits while her Kenaznia answers another chat,
 *  where it is and that it will answer soon. Per person while it rolls out; the runtime publishes `waiting` only for her. */
export const busyLineExtension: Extension = { id: BUSY_LINE, name: 'Busy line', roles: ['manager'] };
