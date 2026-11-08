// What the Organized module adds to core's tools: the todos tool's `morning` action and `onHome`, and the rooms tool's
// projects, groups, pins and layout.
import pg from 'pg';
import { Type } from 'typebox';
import { GROUP_FAMILIES, LAYOUTS } from '../../../shared/contract.js';
import type { RoomPatch } from '../../../server/types.js';
import { fail } from '../../../server/db/errors.js';
import type { RoomHelpers, RoomsAddition, ToolAddition } from '../../../server/modules.js';
import { DATE_AS_TEXT } from '../../../server/extensions/todos.js';
import { chatGroups, groupStore, parseGroupInput, parseGroupPatch, uuidOrNull } from './groups.js';
import { MORNING_DESCRIPTION, morningAction } from './morning.js';
import { chooseLayout } from './onboarding.js';

let pool: pg.Pool | undefined;
/** The tools share one small pool (created on first use, for the life of the process). */
const db = (databaseUrl: string): pg.Pool => pool ??= new pg.Pool({ connectionString: databaseUrl, max: 2, types: DATE_AS_TEXT });

export const todosAddition: ToolAddition = {
  description: MORNING_DESCRIPTION,
  actions: ['morning'],
  properties: { enabled: Type.Optional(Type.Boolean()), at: Type.Optional(Type.String({ pattern: '^\\d{2}:\\d{2}$' })), onHome: Type.Optional(Type.Boolean()) },
  run: async (_action, args, ctx) => morningAction(db(ctx.deps.config.databaseUrl), ctx.deps.store, ctx.person.id, args, ctx.deps.now()),
};

const nullable = <T extends ReturnType<typeof Type.String>>(t: T) => Type.Optional(Type.Union([t, Type.Null()]));
const keyDate = (v: unknown): string | null => v === undefined || v === null ? null : typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(v)) ? v : fail('invalid_input', 'keyDate must be YYYY-MM-DD');

const ROOMS_DESCRIPTION = `Projects, groups and pins (Organized). On her request ("make this a project", "pin Business with the due date Nov 3", "put these three chats under the B2b project"). Organise without being asked too: sort every
new chat into one of her chat groups (create a fitting group when none fits), and when a topic grows into several chats, files or to-dos,
ask her "want this to be a project?" before making it one (a project gathers them around one bigger thing, ongoing or with a due date).
Several projects that belong together (e.g. two bids for the same client): one project each, gathered in a chat group named for the umbrella (only once there are 2 or more).
Chats also carry pinned/keyDate/keyLabel, project/status, projectId (the project it sits under) and groupId; in a chat she shares, her pin, key date, project page, status, projectId and group are hers alone. create also takes groupId and projectId (a new chat inside that project). A chat keeps its colour when it is pinned, regrouped, moved or made a project; only style changes it.
pin: id + pinned (true/false) + optional keyDate (YYYY-MM-DD) and keyLabel (e.g. "Due", needs keyDate); unpinning clears both.
project: id + project (true makes the chat a project page, false undoes it) and/or status (the page's one-line status, null clears).
group: id + projectId (put a chat under a project page; null takes it out). To-dos join a project through the todos tool's conversationId.
Chat groups are her Chats sections (e.g. 💼 Business, 🎻 Music), each a colour family (amber, garnet = pink, plum, blue, teal, lime); a chat
without one shows under "Other". groups: her groups. group_create: name, family, optional emoji. group_update: groupId + any of name,
emoji, family, position. group_delete: groupId (its chats become ungrouped). set_group: id + groupId (null: no group).
layout: layout (classic | organized) switches her app's layout.
When she asks, in one chat, for something to land in another, give workers spawn/message or wake chatId so the report and your answer appear there on Organized; on Classic answers appear in your own chat.`;

export const roomsAddition: RoomsAddition = {
  description: ROOMS_DESCRIPTION,
  actions: ['pin', 'project', 'group', 'groups', 'group_create', 'group_update', 'group_delete', 'set_group', 'layout'],
  properties: {
    groupId: nullable(Type.String()), name: Type.Optional(Type.String({ minLength: 1, maxLength: 60 })),
    family: Type.Optional(Type.Union(GROUP_FAMILIES.map(v => Type.Literal(v)))), position: Type.Optional(Type.Number()),
    project: Type.Optional(Type.Boolean()), status: nullable(Type.String({ maxLength: 500 })), projectId: nullable(Type.String()),
    pinned: Type.Optional(Type.Boolean()), keyDate: nullable(Type.String()), keyLabel: nullable(Type.String({ minLength: 1, maxLength: 40 })),
    layout: Type.Optional(Type.Union(LAYOUTS.map(v => Type.Literal(v)))),
  },
  summary: c => ({ pinned: c.pinnedAt !== null, keyDate: c.keyDate, keyLabel: c.keyLabel, project: c.project, status: c.statusLine, projectId: c.projectId, groupId: c.groupId }),
  async create(args, h) {
    const groupId = args.groupId === undefined ? null : uuidOrNull(args.groupId, 'groupId');
    const projectId = args.projectId === undefined || args.projectId === null ? null : await projectPage(h, String(args.projectId), null);
    return { groupId, patch: projectId ? { projectId } : {} };
  },
  async run(action, args, ctx, h) {
    const { store, bus } = ctx.deps, owner = ctx.person.id, groups = chatGroups(store, bus, groupStore(db(ctx.deps.config.databaseUrl)));
    const ref = args.id as string | undefined, edit = async (patch: RoomPatch) => h.change(await h.room(ref), patch);
    const needGroup = () => uuidOrNull((args.groupId as string | null | undefined) ?? null, 'groupId') ?? fail('invalid_input', `${action} needs groupId`);
    const { action: _a, id: _i, groupId: _g, ...fields } = args;
    switch (action) {
      case 'pin': {
        if (args.pinned === undefined) fail('invalid_input', 'pin needs pinned (true or false)');
        const date = args.pinned ? keyDate(args.keyDate) : null, label = date && (args.keyLabel as string | null | undefined)?.trim() || null;
        if (args.keyLabel && !date && args.pinned) fail('invalid_input', 'keyLabel needs keyDate');
        const current = await h.room(ref);
        return h.change(current, { pinnedAt: args.pinned ? current.pinnedAt ?? ctx.deps.now() : null, keyDate: date, keyLabel: label });
      }
      case 'project':
        if (args.project === undefined && args.status === undefined) fail('invalid_input', 'project needs project and/or status');
        return edit({ ...(args.project !== undefined ? { project: args.project as boolean } : {}), ...(args.status !== undefined ? { statusLine: (args.status as string | null)?.trim() || null } : {}) });
      case 'group': {
        const room = await h.room(ref);
        const target = args.projectId === undefined ? fail('invalid_input', 'group needs projectId (or null)') : args.projectId as string | null;
        if (target !== null && room.project) fail('invalid_input', 'A project page cannot sit under another project');
        return h.change(room, { projectId: target === null ? null : await projectPage(h, target, room.id) });
      }
      case 'groups': return groups.list(owner);
      case 'group_create': return groups.create(owner, parseGroupInput(fields));
      case 'group_update': return groups.update(owner, needGroup(), parseGroupPatch(fields));
      case 'group_delete': return groups.remove(owner, needGroup());
      case 'set_group': {
        const room = await h.room(ref);
        if (args.groupId === undefined) fail('invalid_input', 'set_group needs groupId (or null)');
        return h.change(room, { groupId: uuidOrNull(args.groupId, 'groupId') });
      }
      case 'layout': return { layout: await chooseLayout(ctx.deps, owner, LAYOUTS.find(l => l === args.layout) ?? fail('invalid_input', `layout must be one of ${LAYOUTS.join(', ')}`), groups.list) };
      default: return fail('invalid_input', `Unknown action ${action}`);
    }
  },
};

async function projectPage(h: RoomHelpers, id: string, room: string | null): Promise<string> {
  const p = await h.room(id);
  if (!p.project) fail('invalid_input', 'projectId is not a project page');
  if (p.id === room) fail('invalid_input', 'A room cannot sit under itself');
  return p.id;
}
