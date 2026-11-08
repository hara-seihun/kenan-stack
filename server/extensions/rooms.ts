// The rooms tool: her chats (list, create, rename, lock, style, member colours, leave, close, search, redact). A module can add
// actions for the people who have it (server/modules.ts `additions.rooms`).
import { rewriteChatMessage } from '../message-actions.js';
import { relay, leaveRoom, patchRemoteRoom, remoteRooms } from '../channels/rooms.js';
import { resolveId } from '../ids.js';
import { Type, type TSchema } from 'typebox';
import { chatLink, type ConversationSummary } from '../../shared/contract.js';
import { sharedChange, soloChatMembers, type Bus, type Deps, type Extension, type RoomPatch, type Store } from '../types.js';
import { fail } from '../db/errors.js';
import { parseMemberColors } from '../member-colors.js';
import { searchChats } from '../channels/search.js';
import { withModule, type RoomHelpers } from '../modules.js';

/** The room's new state goes to every member, or only to the owner when what changed is her own organisation of it. */
export async function announceRoom(store: Store, bus: Bus, owner: string, c: ConversationSummary, everyone: boolean): Promise<ConversationSummary> {
  for (const id of everyone ? c.memberIds : [owner]) { const theirs = id === owner ? c : await store.getConversation(c.id, id); if (theirs) bus.toPerson(id, { type: 'conversation', conversation: theirs }); }
  return c;
}


/** A chat she starts from Chats' ＋ New chat: herself and the people she ticked, and her Kenaznia when it is just her (a
 *  chat with other people is a channel each person's Kenaznia hears from outside: server/channels/kenan.ts). No title:
 *  "New chat", left unlocked for Kenaznia to name from the conversation; her own title is locked. */
export const NEW_CHAT_TITLE = 'New chat';
export function parseNewChat(b: Record<string, unknown>, isPerson: (id: string) => boolean): { title: string | null; people: string[] } {
  const title = b.title === undefined || b.title === null ? null : typeof b.title === 'string' && b.title.length <= 200 ? b.title.trim() || null : fail('invalid_input', 'title must be a string of at most 200 characters');
  const people = b.people === undefined ? [] : Array.isArray(b.people) && b.people.every(id => typeof id === 'string') ? [...new Set(b.people as string[])] : fail('invalid_input', 'people must be a list of person ids');
  const unknown = people.find(id => !isPerson(id));
  if (unknown !== undefined) fail('invalid_input', `${unknown} is not a person on Kenan`);
  return { title, people };
}
export async function startChat(deps: Pick<Deps, 'store' | 'bus' | 'runtime'>, owner: string, input: { title: string | null; people: string[] }): Promise<ConversationSummary> {
  const manager = deps.runtime.managerFor(owner);
  const made = await deps.store.createConversation({ title: input.title ?? NEW_CHAT_TITLE, ownerId: owner, memberIds: soloChatMembers(owner, input.people, manager, () => true) });
  const room = input.title ? await deps.store.updateConversation(made.id, owner, { titleLocked: true }) : made;
  return announceRoom(deps.store, deps.bus, owner, room, true);
}

const ROOMS_DESCRIPTION = `Manage her chats. On her request ("close the violin chat", "rename this chat"). Ids come from list.
A chat she shares with other people is a channel (kenan:CHAT_ID): you aren't in it; what its settings pass reaches you in your own chat,
and you answer there with send. A chat she starts untitled is "New chat" (unlocked): rename it once its topic is clear.
redact: chat (conversation id) + id (message id) permanently deletes a pasted human message, scrubbing agent transcripts, summaries, search and notification previews. Returns scheduled; it stops affected turns to erase their old context.
search: q searches message words (all words must match; no boolean or phrase syntax), chat titles and filenames across all her member chats (including closed chats and her manager/worker chats). Optional chat is a conversation id; after/before are ISO dates or epoch milliseconds; limit is 1–100 (default 50). Returns snippets and direct chat:<id>#<seq> links. Quote those links so she can jump to the exact message.
list: her chats with title, emoji, color, titleLocked, archived and lastActivity (epoch ms); includeArchived: true adds closed chats. In a chat she shares, her emoji and color are hers alone; title, members and closing are the same for everyone.
create: title, optional emoji, opening (your first message in the new chat, posted as you: e.g. a short summary of what you two discussed so far, so she lands in a chat that already has the context).
Room ids (id) may be a unique 8+ character prefix. rename: id + title (+ optional emoji). A title she set herself is locked: rename refuses it (title_locked) unless she asked for this
rename now (herRequest: true). Pass lock: true when she asks you to keep the new name.
lock: id + locked (true keeps the current name; false lets you rename it later, and needs herRequest: true when she had locked it).
style: id + emoji and/or color (#RRGGBB); null clears the emoji, or gives the chat a newly picked colour.
member_colors: id + memberColors {personId: colour or null} (red, orange, yellow, green, teal, blue, violet, pink, or its #rrggbb; null clears): her own colour for
each person's messages in a chat she shares ("make Alice's texts red"); only the people named change, and only she sees them. A person's id is their account id (alice, dave).
leave: id + herRequest: true, only when she asks. Removes only her membership, preserves all content and other members, and posts a small "Name left" line. Use this, never close, when she wants to leave a shared room.
close / reopen: id (a closed chat leaves her lists; worker chats close with the workers tool, and your own chat stays open).
To put something in one of her chats (she asks, in one chat, for something to land in another: "send it to Business"), use send to kenan:CHAT_ID.
Chat links: every chat in a result has link, the Markdown [emoji title](chat:<id>); put it in your messages wherever you name a chat
(pointers included): she taps it to open that chat, and Back returns her to where she was. Opening a link checks her membership; inaccessible chats show an error.`;


const ROOM_ACTIONS = ['redact', 'search', 'list', 'create', 'rename', 'lock', 'style', 'member_colors', 'leave', 'close', 'reopen'] as const;
type RoomArgs = {
  q?: string; chat?: string; after?: string | number; before?: string | number; limit?: number;
  action: typeof ROOM_ACTIONS[number]; id?: string; title?: string; emoji?: string | null; color?: string | null; herRequest?: boolean; lock?: boolean; locked?: boolean;
  memberColors?: Record<string, string | null>; includeArchived?: boolean; opening?: string;
};
const nullable = <T extends TSchema>(t: T) => Type.Optional(Type.Union([t, Type.Null()]));
const hexColor = (v: string | null): string | null => v === null || /^#[0-9a-f]{6}$/i.test(v) ? v : fail('invalid_input', 'color must be #RRGGBB or null');

/** The rooms tool. */
export function createRoomsExtension(): Extension {
  return {
    id: 'rooms', name: 'Rooms',
    tool: ctx => {
     const added = withModule(ctx.person).flatMap(m => m.additions?.rooms ?? []);
     return {
      name: 'rooms', files: 'none', records: 'writes', label: 'Rooms', description: [ROOMS_DESCRIPTION, ...added.map(a => a.description)].join('\n'),
      parameters: Type.Object({
        action: Type.Union([...ROOM_ACTIONS, ...added.flatMap(a => a.actions)].map(v => Type.Literal(v))), id: Type.Optional(Type.String()),
        q: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })), chat: Type.Optional(Type.String()),
        after: Type.Optional(Type.Union([Type.String(), Type.Number()])), before: Type.Optional(Type.Union([Type.String(), Type.Number()])),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
        title: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })), emoji: nullable(Type.String({ maxLength: 16 })), color: nullable(Type.String()),
        herRequest: Type.Optional(Type.Boolean()), lock: Type.Optional(Type.Boolean()), locked: Type.Optional(Type.Boolean()),
        includeArchived: Type.Optional(Type.Boolean()),
        opening: Type.Optional(Type.String({ minLength: 1, maxLength: 20_000 })),
        memberColors: Type.Optional(Type.Record(Type.String(), Type.Union([Type.String(), Type.Null()]))),
        ...Object.assign({}, ...added.map(a => a.properties)),
      }),
      execute: async (_id, raw: unknown) => {
        const args = raw as RoomArgs;
        const { store, bus, runtime } = ctx.deps, owner = ctx.person.id;
        const announce = (c: ConversationSummary) => announceRoom(store, bus, owner, c, true);
        const brief = (c: ConversationSummary) => ({
          id: c.id, title: c.title, emoji: c.emoji, color: c.color, titleLocked: c.titleLocked,
          memberColors: c.memberColors, archived: c.archived, lastActivity: c.lastMessage?.at ?? c.updatedAt, link: chatLink(c),
          ...Object.assign({}, ...added.map(a => a.summary(c))),
        });
        // Shared chats held on the other channel are hers too: listed from there, filed here (server/channels/rooms.ts).
        const remote = new Set<string>();
        const held = async (includeArchived: boolean) => (await remoteRooms(ctx.deps, owner, { includeArchived })).rooms.map(c => (remote.add(c.id), c));
        const mine = async (ref: string | null | undefined) => {
          const exact = ref ? await store.getConversation(ref, owner).catch(() => null) : null;
          if (exact) return exact.memberIds.includes(owner) ? exact : fail('not_found', 'Room not found');
          const local = (await store.listConversations(owner, { includeArchived: true })).filter(c => !c.agentId);
          const found = resolveId([...local, ...await held(true)], ref, 'room');
          const c = remote.has(found.id) ? found : await store.getConversation(found.id, owner);
          return c?.memberIds.includes(owner) ? c : fail('not_found', 'Room not found');
        };
        const change = async (room: ConversationSummary, patch: RoomPatch) => brief(remote.has(room.id) ? await patchRemoteRoom(ctx.deps, owner, room.id, patch)
          : await announceRoom(store, bus, owner, await store.updateConversation(room.id, owner, patch), sharedChange(patch)));
        const edit = async (patch: RoomPatch) => change(await mine(args.id), patch);
        const helpers: RoomHelpers = { owner, room: mine, change };
        let value: unknown;
        switch (args.action) {
          case 'redact': {
            if (!args.chat || !args.id || !/^[0-9a-f-]{36}$/i.test(args.id)) fail('invalid_input', 'redact needs chat and message id');
            const room = await mine(args.chat);
            const id = args.id!;
            // Return the tool result before stopping its own model turn. The rewrite awaits that turn's exit.
            setImmediate(() => { void (async () => {
              if (remote.has(room.id)) {
                const response = await relay(ctx.deps, owner, 'POST', `/api/conversations/${room.id}/messages/${id}/redact`, {}, null);
                const result = response ? await response.json() as { ok: boolean } : null;
                if (!result?.ok) throw new Error('Linked message redaction failed');
              } else await rewriteChatMessage(ctx.deps, owner, room.id, id, null, true);
              await ctx.deps.runtime.deliver({ agentId: ctx.agent.id, kind: 'note', fromId: 'system', conversationId: room.id,
                text: `Message ${id} was redacted: live stored, linked, notification and transcript copies were scrubbed.` });
            })().catch(async () => {
              await store.logError(`agent:${ctx.agent.id}`, 'Message redaction did not finish; retry the same message id.');
              await ctx.deps.runtime.deliver({ agentId: ctx.agent.id, kind: 'note', fromId: 'system', conversationId: room.id,
                text: `Message redaction did not finish for ${id}. Retry the same message id; do not claim it was scrubbed.` });
            }); });
            value = { status: 'scheduled', messageId: id, chat: room.id };
            break;
          }
          case 'search': value = await searchChats(ctx.deps, owner, { q: args.q ?? '', chat: args.chat, after: args.after, before: args.before, limit: args.limit }); break;
          case 'list': value = [...(await store.listConversations(owner, { includeArchived: args.includeArchived === true })).filter(c => !c.agentId), ...await held(args.includeArchived === true)].map(brief); break;
          case 'create': {
            const title = args.title?.trim() || fail('invalid_input', 'create needs title');
            const extras = await Promise.all(added.map(a => a.create(args, helpers)));
            const groupId = extras.map(e => e.groupId).find(g => g !== null) ?? null;
            const opening = args.opening === undefined ? null : args.opening.trim() || fail('invalid_input', 'opening must not be empty');
            const manager = runtime.managerFor(owner);
            if (opening !== null && !manager) fail('conflict', 'no_manager: an opening message needs her Kenaznia');
            const created = await store.createConversation({ title, ownerId: owner, memberIds: [owner, ...(manager ? [manager] : [])], groupId });
            const patch: RoomPatch = { ...(args.emoji ? { emoji: args.emoji } : {}), ...Object.assign({}, ...extras.map(e => e.patch)) };
            const room = Object.keys(patch).length ? await store.updateConversation(created.id, owner, patch) : created;
            if (opening === null) { value = brief(await announce(room)); break; }
            const message = await store.appendMessage({ conversationId: room.id, authorId: manager!, role: 'assistant', display: 'shown', text: opening });
            value = { ...brief(await announce(await store.getConversation(room.id, owner) ?? fail('not_found', 'Room not found'))), openingMessageId: message.id };
            bus.toConversation(room.id, { type: 'message', message });
            break;
          }
          case 'rename': {
            const title = args.title?.trim() || fail('invalid_input', 'rename needs title'), current = await mine(args.id);
            if (current.titleLocked && !args.herRequest) fail('conflict', `title_locked: "${current.title}" is a name she chose; rename it only when she asks (herRequest: true)`);
            value = await edit({ title, titleLocked: args.lock ?? (current.titleLocked && !!args.herRequest), ...(args.emoji !== undefined ? { emoji: args.emoji } : {}) });
            break;
          }
          case 'lock': {
            const current = await mine(args.id);
            if (args.locked === undefined) fail('invalid_input', 'lock needs locked (true or false)');
            if (current.titleLocked && !args.locked && !args.herRequest) fail('conflict', `title_locked: "${current.title}" is a name she chose; unlock it only when she asks (herRequest: true)`);
            value = await edit({ titleLocked: args.locked });
            break;
          }
          case 'style':
            if (args.emoji === undefined && args.color === undefined) fail('invalid_input', 'style needs emoji and/or color');
            value = await edit({ ...(args.emoji !== undefined ? { emoji: args.emoji?.trim() || null } : {}), ...(args.color !== undefined ? { color: hexColor(args.color) } : {}) });
            break;
          case 'member_colors':
            if (args.memberColors === undefined) fail('invalid_input', 'member_colors needs memberColors');
            value = await edit({ memberColors: parseMemberColors(args.memberColors) });
            break;
          case 'leave': {
            if (!args.herRequest) fail('conflict', 'leave needs herRequest: true because she asked to leave');
            value = await leaveRoom(ctx.deps, owner, (await mine(args.id)).id);
            break;
          }
          case 'close': case 'reopen': {
            const room = await mine(args.id);
            if (room.agentId) fail('conflict', 'This is an agent\'s chat: close a worker with the workers tool; your own chat stays open');
            value = await edit({ archived: args.action === 'close' });
            break;
          }
          default: {
            const action = (args as { action: string }).action, extra = added.find(a => a.actions.includes(action));
            if (!extra) return fail('invalid_input', `Unknown action ${action}`);
            value = await extra.run(action, args as Record<string, unknown>, ctx, helpers);
          }
        }
        return { content: [{ type: 'text', text: JSON.stringify(value) }], details: {} };
      },
     };
    },
  };
}
export const roomsExtension = createRoomsExtension();
