// Shared chats across linked application instances. Each chat lives in exactly one database. Members' home instances
// list it remotely and send requests to its owning instance as that person over the private link. Several unrelated
// instances may be linked: requests about files must identify the chat too, so they reach the same owner as messages.
// The owner sends live events back to members' homes. Only each person's filing (emoji, colour, pin, project, group)
// lives at home (table remote_member), next to their groups and projects.
import { request, type IncomingMessage } from 'node:http';
import { Readable } from 'node:stream';
import type { ConversationSummary, Person, Result, ServerEvent } from '../../shared/contract.js';
import { hostedManager, type PersonConfig } from '../config.js';
import type { Deps, RoomOrganisation, RoomPatch } from '../types.js';
import { fail } from '../db/errors.js';
import { linkCall, toSiblings, type LinkResult } from './link.js';
import { managerIdOf, remoteKenazniaName } from './kenan.js';

/** The header naming the person a request relayed over the link acts as (honoured only on the link socket). */
export const LINK_PERSON = 'x-kenan-link-person';
export interface RoomsAnswer { rooms: ConversationSummary[]; people: Person[] }
export interface RoomEvent { personId: string; event: ServerEvent }

const LIST_TIMEOUT_MS = 3_000;
const UNFILED: RoomOrganisation = { color: null, memberColors: {}, emoji: null, pinnedAt: null, keyDate: null, keyLabel: null, project: false, statusLine: null, projectId: null, groupId: null };

/** A person whose Kenaznia runs on another channel of this host. */
export const homedElsewhere = (p: PersonConfig): boolean => !!p.manager && 'elsewhere' in p.manager;
/** Plain chats remain available remotely even when only one person remains. */
export const sharedRoom = (deps: Pick<Deps, 'person'>, c: Pick<ConversationSummary, 'agentId' | 'memberIds'>): boolean =>
  !c.agentId;
/** A remote room as its member files it at home. */
export const filed = (c: ConversationSummary, o: RoomOrganisation | undefined): ConversationSummary => ({ ...c, ...(o ?? UNFILED) });

export function roomOf(e: ServerEvent): string | null {
  switch (e.type) {
    case 'message': return e.message.conversationId;
    case 'delta': case 'thinking': case 'tool_draft': case 'activity': return e.conversationId;
    case 'conversation': return e.conversation.id;
    default: return null;
  }
}

// ---------------- host side ----------------

/** The shared chats held here that a person homed on another channel is in (or just chat `id`), and the names this
 *  channel gives their members: a Kenaznia running here is "Alice's Kenaznia" to the other channel's people. */
export async function sharedRoomsFor(deps: Deps, personId: string, opts: { includeArchived: boolean; id: string | null }): Promise<LinkResult<RoomsAnswer>> {
  const person = deps.person(personId);
  if (!person || !homedElsewhere(person)) return { ok: false, error: `not_here: ${personId} is at home on ${deps.config.channel}` };
  const found = opts.id ? [await deps.store.getConversation(opts.id, personId)].filter((c): c is ConversationSummary => !!c && c.memberIds.includes(personId))
    : await deps.store.sharedConversations(personId, { includeArchived: opts.includeArchived });
  const rooms = found.filter(c => sharedRoom(deps, c));
  const ids = new Set(rooms.flatMap(c => c.memberIds));
  const kenaznias = new Map(deps.config.people.filter(p => hostedManager(p)).map(p => [managerIdOf(p.id), remoteKenazniaName(p)]));
  const people = (await deps.store.listPeople({ ids: [...ids] })).map(p => ({ ...p, name: kenaznias.get(p.id) ?? p.name }));
  return { ok: true, value: { rooms: rooms.map(c => filed(c, undefined)), people } };
}

/** Passes every live event about a shared chat held here to the channels where its members are at home, in order. */
export function passRoomEvents(deps: Deps): () => void {
  const shared = new Map<string, boolean>();
  let chain = Promise.resolve();
  return deps.bus.tap((personId, event) => {
    const room = roomOf(event), person = deps.person(personId);
    if (!room || !person || !homedElsewhere(person)) return;
    chain = chain.then(async () => {
      if (event.type === 'conversation') shared.set(room, sharedRoom(deps, event.conversation));
      if (!shared.has(room)) { const c = await deps.store.getConversation(room, personId); shared.set(room, !!c && sharedRoom(deps, c)); }
      if (!shared.get(room)) return;
      const sent = await toSiblings<null>(deps, '/events', { events: [{ personId, event }] satisfies RoomEvent[] });
      // A home that is restarting misses the event; its app reloads every chat when its stream reconnects.
      if (!sent.ok) console.error(JSON.stringify({ type: 'room_event_not_passed', personId, room, error: sent.error }));
    }).catch(e => console.error(JSON.stringify({ type: 'room_event_failed', personId, room, error: String(e) })));
  });
}

/** Leave is decided by the owning database, never by the caller's local room filing. */
export async function leaveRoom(deps: Deps, personId: string, id: string): Promise<{ id: string }> {
  const before = await deps.store.getConversation(id, personId);
  if (!before) {
    const res = await relay(deps, personId, 'POST', `/api/conversations/${id}/leave`, { 'content-type': 'application/json' }, Buffer.from('{}'));
    const answer = res ? await res.json() as Result<{ id: string }> : fail('not_found', 'Conversation not found');
    return answer.ok ? answer.value : fail(answer.error.code, answer.error.message);
  }
  const message = await deps.store.leaveConversation(id, personId);
  if (message) {
    deps.bus.invalidateMembers(id);
    for (const member of before.memberIds) {
      if (!deps.person(member)) continue;
      const conversation = await deps.store.getConversation(id, member);
      if (conversation) deps.bus.toPerson(member, { type: 'conversation', conversation });
      if (member !== personId) deps.bus.toPerson(member, { type: 'message', message });
    }
  }
  return { id };
}

// ---------------- home side ----------------

/** The shared chats a person at home here is in on the other channels, filed the way they file them. A channel that
 *  doesn't answer within LIST_TIMEOUT_MS (restarting) is logged and its chats are left out of this listing. */
export async function remoteRooms(deps: Deps, personId: string, opts: { includeArchived: boolean; id?: string }): Promise<RoomsAnswer> {
  const person = deps.person(personId), siblings = deps.config.link?.siblings ?? [];
  if (!person || !hostedManager(person) || !siblings.length) return { rooms: [], people: [] };
  const [answers, organisation] = await Promise.all([
    Promise.all(siblings.map(s => linkCall<RoomsAnswer>(s, '/rooms', { personId, includeArchived: opts.includeArchived, id: opts.id ?? null }, LIST_TIMEOUT_MS))),
    deps.store.remoteOrganisation(personId),
  ]);
  const rooms: ConversationSummary[] = [], people = new Map<string, Person>();
  for (const a of answers) {
    if (!a.ok) { if (!a.error.startsWith('not_here')) await deps.store.logError(`rooms:${personId}`, `shared chats from the other channel left out: ${a.error}`); continue; }
    for (const c of a.value.rooms) rooms.push(filed(c, organisation.get(c.id)));
    for (const p of a.value.people) people.set(p.id, p);
  }
  return { rooms, people: [...people.values()] };
}

/** One remote chat as this person sees it, or null when no other channel holds it for them. */
export async function remoteRoom(deps: Deps, personId: string, id: string): Promise<ConversationSummary | null> {
  return (await remoteRooms(deps, personId, { includeArchived: true, id })).rooms[0] ?? null;
}

/** Live events about remote chats, for people at home here: delivered to their streams, filed their way. */
export async function deliverRoomEvents(deps: Deps, events: RoomEvent[]): Promise<LinkResult<null>> {
  if (!events.some(({ personId }) => { const person = deps.person(personId); return person && hostedManager(person); }))
    return { ok: false, error: 'not_here: no event recipient is hosted on this instance' };
  for (const { personId, event } of events) {
    const person = deps.person(personId);
    if (!person || !hostedManager(person)) continue;
    deps.bus.toPerson(personId, event.type === 'conversation'
      ? { type: 'conversation', conversation: filed(event.conversation, (await deps.store.remoteOrganisation(personId)).get(event.conversation.id)) }
      : event);
  }
  return { ok: true, value: null };
}

/** Changes a chat held on another channel as this person: shared changes (title, members, closing, read marks) go to
 *  the chat's channel, their own filing stays here in remote_member. Announced to their app; null when no other channel holds it. */
export async function patchRemoteRoom(deps: Deps, personId: string, id: string, patch: RoomPatch): Promise<ConversationSummary> {
  const { title, titleLocked, archived, readThrough, addMemberIds, removeMemberIds, ...filing } = patch;
  const shared = { title, titleLocked, archived, readThrough, addMemberIds, removeMemberIds };
  if (Object.values(shared).some(v => v !== undefined)) {
    const res = await relay(deps, personId, 'PATCH', `/api/conversations/${id}`, { 'content-type': 'application/json' }, Buffer.from(JSON.stringify(shared)));
    const r = res ? await res.json() as Result<unknown> : fail('not_found', 'Conversation not found');
    if (!r.ok) fail(r.error.code, r.error.message);
  }
  if (Object.values(filing).some(v => v !== undefined)) await deps.store.organiseRemote(personId, id, filing);
  const conversation = await remoteRoom(deps, personId, id) ?? fail('not_found', 'Conversation not found');
  deps.bus.toPerson(personId, { type: 'conversation', conversation });
  return conversation;
}

function rawCall(socketPath: string, method: string, path: string, headers: Record<string, string>, body: Buffer | null): Promise<IncomingMessage | Error> {
  return new Promise(resolve => {
    const req = request({ socketPath, path, method, headers: { ...headers, ...(body ? { 'content-length': String(body.length) } : {}) } }, resolve);
    req.on('error', e => resolve(new Error(`link_unreachable: ${socketPath}: ${e.message}`)));
    req.end(body ?? undefined);
  });
}
const HOP = new Set(['connection', 'keep-alive', 'transfer-encoding']);

/** Sends one API request about a chat held on another channel there, as this person; the answer streams back as is.
 *  With several other channels, the first answer that isn't a 404 wins. Null when this channel has no others. */
export async function relay(deps: Pick<Deps, 'config'>, personId: string, method: string, path: string, headers: Record<string, string>, body: Buffer | null): Promise<Response | null> {
  const siblings = deps.config.link?.siblings ?? [];
  let last: Error | null = null;
  for (const [i, socketPath] of siblings.entries()) {
    const res = await rawCall(socketPath, method, path, { ...headers, [LINK_PERSON]: personId }, body);
    if (res instanceof Error) { last = res; continue; }
    if (res.statusCode === 404 && i < siblings.length - 1) { res.resume(); continue; }
    const out = new Headers();
    for (const [k, v] of Object.entries(res.headers)) if (v !== undefined && !HOP.has(k)) for (const one of [v].flat()) out.append(k, one);
    const status = res.statusCode ?? 502, empty = status === 204 || status === 304 || method === 'HEAD';
    if (empty) res.resume();
    return new Response(empty ? null : Readable.toWeb(res) as ReadableStream, { status, headers: out });
  }
  if (last) return new Response(JSON.stringify({ ok: false, error: { code: 'unavailable', message: `The other channel holding this chat isn't answering (${last.message}); try again in a moment.` } }), { status: 503, headers: { 'content-type': 'application/json' } });
  return null;
}
