// Any agent can message any agent (Alice, 2026-10-30: "Make it so any agent can message any agent in Kenan stack"), and
// agent messaging works like a group chat (Alice, 2026-11-02 13:24–13:25 PT: "everyone can see everyone that's running and
// they can all message anyone. They can also broadcast a message"; no guards: agents messaged too much reply-all asking
// people to cut it out). Every agent's workers tool lists the host's agents (`find`: the directory, by goal, name, parent
// or person), messages any of them by id or unique prefix, and broadcasts to a group (`to`: all, a goal's agents, a
// worker's subtree, a name match, or everyone a broadcast reached: reply-all). Every message is headed with who sent it
// and the id to reply to; a broadcast also names its id for reply-all. The one rule: an agent never sends its person's
// private context to another person's agents, so a group reaches other people's agents only when it names them.
// Each configured private link exposes the agents owned by that application instance. Linked messages stay in the
// sender's durable outbox until the owner stores an idempotent input. Broadcast records travel with messages so
// reply-all works on any linked host. Local sibling databases/inboxes remain available to older installed channels.
import { ownersVisible } from './person-isolation.js';
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentInfo } from '../../shared/contract.js';
import { createStore } from '../db/store.js';
import { IdFailure, matchId } from '../ids.js';
import { queueInboxFile, startHostInboxes, type InboxOutcome, type InboxTake } from '../host-inbox.js';
import type { Deps, Store } from '../types.js';
import type { Controls } from '../tools/control.js';
import { routeBackground } from './origin.js';
import { hostedManager } from '../config.js';
import { linkCall, type LinkResult } from '../channels/link.js';

export const MESSAGE_TEXT_LIMIT = 16_000;
export const FIND_LIMIT = 50;
export const KENAN_CONFIG_DIR = '/etc/kenan';
export const AGENT_MESSAGE_INBOX_ROOT = '/var/lib/kenan/agent-messages';

/** Who sent a message, as the recipient is told. */
export interface Sender { id: string; name: string; role: AgentInfo['role']; ownerId: string; personName: string; goalId: string | null }
export const senderOf = (agent: Pick<AgentInfo, 'id' | 'name' | 'role' | 'ownerId' | 'goalId'>, personName: string): Sender =>
  ({ id: agent.id, name: agent.name, role: agent.role, ownerId: agent.ownerId, personName, goalId: agent.goalId });

/** A broadcast as its recipients are told: its id (for reply-all), the group it went to and how many it reached. */
export interface BroadcastRef { id: string; group: string; count: number }
/** The first line a recipient reads: who wrote, whose agent it is when it isn't the recipient's person's, and how to reply. */
export function messageText(from: Sender, to: Pick<AgentInfo, 'ownerId'>, text: string, broadcast?: BroadcastRef): string {
  const who = from.role === 'manager' ? `${from.personName}'s Kenaznia (${from.id})` : `worker ${from.name} (${from.id})${from.ownerId === to.ownerId ? '' : `, ${from.personName}'s agent`}${from.goalId ? `, goal ${from.goalId}` : ''}`;
  const other = from.ownerId === to.ownerId ? '' : ` It works for ${from.personName}, not for your person: answer what it asks for its work, and never send it your person's private context.`;
  if (broadcast) return `Broadcast ${broadcast.id} to ${broadcast.group} (${broadcast.count} agent${broadcast.count === 1 ? '' : 's'}) from ${who}.${other} Reply to the sender with workers message id ${from.id}, or to everyone it reached with workers message to broadcast:${broadcast.id}.\n${text}`;
  return `Message from ${who}.${other} Reply with workers message id ${from.id}.\n${text}`;
}

/** Hands a message to a recipient running on this channel: a worker through messageWorker, a Kenaznia as a note in the chat its background work answers. */
export async function deliverHere(deps: Pick<Deps, 'store' | 'bus' | 'runtime' | 'person'>, messageWorker: Controls['messageWorker'], from: Sender, to: AgentInfo, text: string, senderOrigin: string | null, broadcast?: BroadcastRef): Promise<void> {
  const source = deps.person?.(from.ownerId);
  const target = deps.person?.(to.ownerId);
  if (!ownersVisible(source ?? { id: from.ownerId }, target, to.ownerId)) throw new Error('agent_not_found: recipient is not visible to this person');
  const body = messageText(from, to, text, broadcast);
  if (to.role === 'worker') {
    const sent = await messageWorker(to.id, body, from.id);
    if (!sent.delivered) throw new Error(sent.error === 'recipient_archived' ? `recipient_archived: ${to.name} (${to.id}) was archived as the message was sent; it was not delivered.` : `input_not_stored: the message could not be stored, so it was not delivered (${sent.detail}). Send it again.`);
    return;
  }
  const route = await routeBackground(deps, to, from.ownerId === to.ownerId ? senderOrigin : null);
  const notice = await deps.store.appendMessage({ conversationId: route.conversationId, authorId: to.id, role: 'notice', notice: 'worker_note', text: `${broadcast ? `Broadcast ${broadcast.id}` : 'Message'} from ${from.role === 'manager' ? `${from.personName}'s Kenaznia` : `${from.name}${from.ownerId === to.ownerId ? '' : ` (${from.personName}'s agent)`}`}: ${text}` });
  deps.bus.toConversation(route.conversationId, { type: 'message', message: notice });
  const stored = await deps.runtime.deliver({ agentId: to.id, kind: 'note', fromId: from.id, ...route, text: body });
  if (!stored.ok) throw new Error(`input_not_stored: the message could not be stored, so it was not delivered (${stored.detail}). Send it again.`);
}

/** One channel's agents: which people it runs and where to read their agents. */
export interface Channel { channel: string; here: boolean; socket?: string; people: ReadonlyMap<string, string>; store: Pick<Store, 'findAgents' | 'listWorkersPage' | 'listAgents' | 'recentWork' | 'agentPresence'> }
export interface Located { agent: AgentInfo; channel: Channel; personName: string }
export type FindFilters = { id?: string; goal?: string; parent?: string; name?: string; person?: string; includeArchived?: boolean; limit?: number };

type RawConfig = { channel?: unknown; databaseUrl?: unknown; people?: unknown };
/** The people whose agents a channel runs: everyone whose Kenaznia isn't placed elsewhere. */
export function peopleRunning(people: readonly { id: string; name: string; manager?: unknown; isolated?: true }[]): Map<string, string> {
  return new Map(people.filter(p => !(p.manager && typeof p.manager === 'object' && 'elsewhere' in p.manager)).map(p => [p.id, p.name]));
}

/** Every channel on the host: this one, and each other channel config in KENAN_CONFIG_DIR (read once, its database opened on first use). */
export class Directory {
  private others: Promise<Channel[]> | null = null;
  /** inboxRoot: where messages for agents on another channel wait (that channel drains it). */
  constructor(private readonly here: Channel, private readonly loadOthers: () => Promise<Channel[]>, readonly inboxRoot = AGENT_MESSAGE_INBOX_ROOT, private readonly loadRemote: () => Promise<Channel[]> = async () => []) {}
  channels(): Promise<Channel[]> { this.others ??= this.loadOthers().catch(e => { this.others = null; throw e; }); return Promise.all([this.others, this.loadRemote()]).then(([others, remote]) => [this.here, ...others, ...remote]); }
  /** Agents host-wide matching every filter, active first (newest activity first), at most FIND_LIMIT. */
  async find(filters: FindFilters): Promise<Located[]> {
    const found = await Promise.all((await this.channels()).map(async channel => {
      const owners = [...channel.people.keys()].filter(id => filters.person === undefined || id === filters.person);
      if (!owners.length) return [];
      const agents = await channel.store.findAgents({ owners, id: filters.id, goal: filters.goal, parent: filters.parent, name: filters.name, includeArchived: filters.includeArchived ?? false, limit: filters.limit ?? FIND_LIMIT });
      return agents.map(agent => ({ agent, channel, personName: channel.people.get(agent.ownerId) ?? agent.ownerId }));
    }));
    return [...new Map(found.flat().map(l => [l.agent.id, l])).values()].sort((a, b) => Number(a.agent.archived) - Number(b.agent.archived) || b.agent.updatedAt - a.agent.updatedAt).slice(0, filters.limit ?? FIND_LIMIT);
  }
  /** The live (unarchived, unstopped) agents a broadcast group names, the sender left out. persons: whose agents all, goal and name reach (null: everyone's). */
  async group(group: Group, persons: readonly string[] | null, senderId: string): Promise<Located[]> {
    const live = (found: Located[]) => found.filter(l => !l.agent.archived && l.agent.state !== 'stopped' && l.agent.id !== senderId);
    const scoped = async (filters: FindFilters) => (await Promise.all((persons ?? [undefined]).map(person => this.find({ ...filters, person, limit: GROUP_LIMIT })))).flat();
    if (group.kind === 'all') return live(await scoped({}));
    if (group.kind === 'goal') return live(await scoped({ goal: group.ref }));
    if (group.kind === 'name') return live(await scoped({ name: group.ref }));
    if (group.kind === 'subtree') {
      // Naming the root is naming whose agents these are, so a subtree is reached whoever owns it.
      const root = await this.locate(group.ref);
      const everyone = await root.channel.store.listAgents(root.agent.ownerId);
      const below = subtreeOf(everyone, root.agent.id);
      return live([root, ...everyone.filter(a => below.has(a.id)).map(agent => ({ ...root, agent }))]);
    }
    // Reply-all: everyone the broadcast reached and its sender, as they are now.
    const record = await this.broadcastRecord(group.ref);
    const ids = [record.from.id, ...record.to];
    const found = await Promise.all(ids.map(id => this.locate(id).catch(() => null)));
    return live(found.filter((l): l is Located => l !== null));
  }
  async broadcastRecord(ref: string): Promise<BroadcastRecord> {
    try { return await readBroadcast(this.inboxRoot, ref); } catch (e) {
      for (const c of await this.channels()) if (c.socket) {
        const r = await linkCall<BroadcastRecord>(c.socket, '/agents/broadcast', { ref });
        if (r.ok) { await writeBroadcast(this.inboxRoot, r.value); return r.value; }
      }
      throw e;
    }
  }
  /** The one agent an id or unique 8+ character prefix names, on whichever channel runs it. */
  async locate(ref: string, hint = ''): Promise<Located> {
    const candidates = await this.find({ id: ref, includeArchived: true });
    const found = matchId(candidates.map(c => ({ ...c, id: c.agent.id })), ref, 'agent', `${hint}; workers find lists agents by goal, name, parent or person`);
    if (!found.ok) throw new IdFailure(found.code, found.message);
    return found.value;
  }
}

/** Who a broadcast goes to (workers message to): all, goal:ID, subtree:ID, name:TEXT, or broadcast:ID (reply-all). */
export type Group = { kind: 'all' } | { kind: 'goal' | 'subtree' | 'name' | 'broadcast'; ref: string };
export const GROUP_LIMIT = 500;
export function parseGroup(raw: string): Group {
  const text = raw.trim();
  if (text === 'all') return { kind: 'all' };
  const match = /^(goal|subtree|name|broadcast):(.+)$/s.exec(text);
  if (!match || !match[2]!.trim()) throw new Error(`group_invalid: to is "all", "goal:ID", "subtree:ID", "name:TEXT" or "broadcast:ID" (reply-all), not "${raw}"`);
  return { kind: match[1] as Exclude<Group['kind'], 'all'>, ref: match[2]!.trim() };
}
/** The agents below a root: its children, theirs, and so on. */
export function subtreeOf(agents: readonly { id: string; parentAgentId?: string | null }[], rootId: string): Set<string> {
  const below = new Set<string>();
  for (let grew = true; grew;) {
    grew = false;
    for (const a of agents) if (a.parentAgentId && !below.has(a.id) && a.id !== rootId && (a.parentAgentId === rootId || below.has(a.parentAgentId))) { below.add(a.id); grew = true; }
  }
  return below;
}
/** Who a broadcast reached, kept for reply-all. */
export interface BroadcastRecord { id: string; from: Sender; group: string; to: string[]; at: number }
const broadcastPath = (root: string, id: string) => join(root, 'broadcasts', `${id}.json`);
export async function writeBroadcast(root: string, record: BroadcastRecord): Promise<void> {
  await mkdir(join(root, 'broadcasts'), { recursive: true, mode: 0o755 });
  const path = broadcastPath(root, record.id);
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(record), { mode: 0o644 });
  await rename(temporary, path);
}
export async function readBroadcast(root: string, ref: string): Promise<BroadcastRecord> {
  if (!/^[0-9a-f-]{8,36}$/i.test(ref)) throw new Error(`broadcast_not_found: ${ref} is not a broadcast id`);
  const names = (await readdir(join(root, 'broadcasts')).catch(() => [] as string[])).filter(n => n.endsWith('.json') && n.toLowerCase().startsWith(ref.toLowerCase()));
  if (names.length > 1) throw new Error(`broadcast_id_ambiguous: ${ref} names ${names.length} broadcasts; give more of the id`);
  if (!names.length) throw new Error(`broadcast_not_found: no broadcast ${ref}; the id is in the broadcast's first line`);
  return JSON.parse(await readFile(join(root, 'broadcasts', names[0]!), 'utf8')) as BroadcastRecord;
}

export async function otherChannels(dir: string, ownChannel: string): Promise<Channel[]> {
  const names = (await readdir(dir)).filter(n => n.endsWith('.json'));
  const configs = await Promise.all(names.map(async n => { try { return JSON.parse(await readFile(join(dir, n), 'utf8')) as RawConfig; } catch { return null; } }));
  return configs.flatMap(raw => {
    if (!raw || typeof raw.channel !== 'string' || raw.channel === ownChannel || typeof raw.databaseUrl !== 'string' || !Array.isArray(raw.people)) return [];
    const people = peopleRunning(raw.people.filter((p): p is { id: string; name: string } => typeof p?.id === 'string' && typeof p?.name === 'string' && !p?.isolated));
    return [{ channel: raw.channel, here: false, people, store: createStore(raw.databaseUrl, { max: 2 }) }];
  });
}

const directoryKey = Symbol.for('kenan.agent-directories');
const sharedDirectories = globalThis as typeof globalThis & { [directoryKey]?: WeakMap<object, Directory> };
const directories = sharedDirectories[directoryKey] ??= new WeakMap<object, Directory>();
/** The host directory of the channel whose store this is: main installs it at start (tests install their own). */
export function installDirectory(store: object, directory: Directory): Directory { directories.set(store, directory); return directory; }
export function hostDirectory(deps: Pick<Deps, 'config' | 'store'>, dir = KENAN_CONFIG_DIR): Directory {
  return new Directory({ channel: deps.config.channel, here: true, get people() { return peopleRunning(deps.config.people); }, store: deps.store }, () => otherChannels(dir, deps.config.channel), AGENT_MESSAGE_INBOX_ROOT, () => linkedChannels(deps));
}
export function directoryOf(deps: Pick<Deps, 'store'>): Directory {
  const found = directories.get(deps.store);
  if (!found) throw new Error('directory_not_started: this channel has no agent directory yet; it is installed when the channel starts');
  return found;
}

/** A message for an agent another channel runs, waiting in that person's agent-message inbox. */
export interface RemoteMessage { id: string; to: string; from: Sender; text: string; at: number; broadcast?: BroadcastRef }
export function parseRemoteMessage(raw: unknown): { ok: true; value: RemoteMessage } | { ok: false; error: string } {
  const r = raw as Partial<RemoteMessage> | null;
  const f = r?.from as Partial<Sender> | undefined;
  if (!r || typeof r !== 'object' || typeof r.id !== 'string' || typeof r.to !== 'string' || typeof r.text !== 'string' || !r.text.trim() || r.text.length > MESSAGE_TEXT_LIMIT || typeof r.at !== 'number') return { ok: false, error: 'file must be {id, to, from, text, at}' };
  if (!f || typeof f.id !== 'string' || typeof f.name !== 'string' || (f.role !== 'manager' && f.role !== 'worker') || typeof f.ownerId !== 'string' || typeof f.personName !== 'string' || (f.goalId !== null && typeof f.goalId !== 'string')) return { ok: false, error: 'from: {id, name, role, ownerId, personName, goalId}' };
  const b = r.broadcast as Partial<BroadcastRef> | undefined;
  if (b !== undefined && (!b || typeof b.id !== 'string' || typeof b.group !== 'string' || typeof b.count !== 'number')) return { ok: false, error: 'broadcast: {id, group, count}' };
  return { ok: true, value: { id: r.id, to: r.to, from: f as Sender, text: r.text, at: r.at, ...(b ? { broadcast: b as BroadcastRef } : {}) } };
}
export async function queueRemote(root: string, person: { id: string; uid: number; gid: number }, from: Sender, to: AgentInfo, text: string, now: number, broadcast?: BroadcastRef): Promise<void> {
  const message: RemoteMessage = { id: randomUUID(), to: to.id, from, text, at: now, ...(broadcast ? { broadcast } : {}) };
  await queueInboxFile(root, person, message);
}
/** Takes one queued message for an agent this channel runs; one whose recipient has since been archived goes to that person's Kenaznia with the reason. */
export function takeAgentMessage(deps: Deps, messageWorker: Controls['messageWorker']): InboxTake {
  return async (person, raw): Promise<InboxOutcome> => {
    const parsed = parseRemoteMessage(raw);
    if (!parsed.ok) return { kind: 'rejected', error: parsed.error };
    const { to, from, text, broadcast } = parsed.value;
    const recipient = await deps.store.getAgent(to);
    if (!recipient || recipient.ownerId !== person.id) return { kind: 'rejected', error: `no agent ${to} of ${person.id} on this channel` };
    if (!recipient.archived) { await deliverHere(deps, messageWorker, from, recipient, text, null, broadcast); return { kind: 'taken' }; }
    const managerId = deps.runtime.managerFor(person.id);
    const manager = managerId ? await deps.store.getAgent(managerId) : null;
    if (!manager || manager.archived) return { kind: 'rejected', error: `${to} is archived and ${person.id} has no live Kenaznia here` };
    await deliverHere(deps, messageWorker, from, manager, `(This was sent to ${recipient.name} (${recipient.id}), which was archived before it arrived, so it came to you. Pass it on to whoever now does that work, or let it go.)\n${text}`, null, broadcast);
    return { kind: 'taken' };
  };
}
export const startAgentMessages = (deps: Deps, messageWorker: Controls['messageWorker'], root = AGENT_MESSAGE_INBOX_ROOT): Promise<() => void> =>
  startHostInboxes(deps, root, 'agent_message_inbox', takeAgentMessage(deps, messageWorker));

/** Each configured socket is an instance, not a channel name: two hosts may both run Beta. */
export async function linkedChannels(deps: Pick<Deps, 'config'>): Promise<Channel[]> {
  return (await Promise.all((deps.config.link?.siblings ?? []).map(async socket => {
    const answer = await linkCall<{ channel: string; people: [string, string][] }>(socket, '/agents/directory', {}, 3000);
    if (!answer.ok) return [];
    const call = async (method: string, args: unknown[]) => {
      const r = await linkCall<any>(socket, '/agents/query', { method, args });
      if (!r.ok) throw new Error(r.error);
      return r.value;
    };
    const store: Channel['store'] = {
      findAgents: f => call('findAgents', [f]),
      listWorkersPage: (owner, opts) => call('listWorkersPage', [owner, opts]),
      listAgents: (owner, opts) => call('listAgents', [owner, opts]),
      recentWork: async (ids, opts) => new Map(await call('recentWork', [ids, opts])),
      agentPresence: ids => call('agentPresence', [ids]),
    };
    return [{ channel: `${answer.value.channel}@${socket}`, here: false, socket, people: new Map(answer.value.people), store }];
  }))).flat();
}

const linkOutbox = (deps: Pick<Deps, 'config'>) => join(deps.config.dataDir, 'link-outbox');
interface LinkedEnvelope { socket: string; message: RemoteMessage; broadcastRecord?: BroadcastRecord }
/** The sender keeps a durable copy until the destination has stored the input, not merely received HTTP. */
export async function queueLinkedMessage(deps: Deps, located: Located, from: Sender, text: string, broadcast?: BroadcastRef): Promise<void> {
  const socket = located.channel.socket;
  const sender = deps.person(from.ownerId);
  if (!socket || !sender || !hostedManager(sender)) throw new Error('link_sender_not_here');
  const record = broadcast ? await directoryOf(deps).broadcastRecord(broadcast.id) : undefined;
  const envelope: LinkedEnvelope = { socket, message: { id: randomUUID(), to: located.agent.id, from, text, at: deps.now(), ...(broadcast ? { broadcast } : {}) }, ...(record ? { broadcastRecord: record } : {}) };
  await queueInboxFile(linkOutbox(deps), sender, envelope);
}
export async function startLinkedMessages(deps: Deps): Promise<() => void> {
  const { startInboxPlaces } = await import('../host-inbox.js');
  return startInboxPlaces(deps, linkOutbox(deps), 'link_outbox', deps.config.people.filter(hostedManager).map(person => ({ person, name: person.id, uid: person.uid, gid: person.gid })), async (_person, raw) => {
    const envelope = raw as LinkedEnvelope;
    if (!envelope || typeof envelope.socket !== 'string' || !parseRemoteMessage(envelope.message).ok) return { kind: 'rejected', error: 'invalid linked message' };
    const sent = await linkCall(envelope.socket, '/agents/message', envelope);
    return sent.ok ? { kind: 'taken' } : { kind: 'held', error: sent.error };
  }, 2000);
}

/** Only the agents owned by this instance can be queried; no recursion through its other links. */
export async function agentLinkRequest(deps: Deps, path: string, body: Record<string, unknown>): Promise<LinkResult<unknown>> {
  const people = peopleRunning(deps.config.people.filter(p => !p.isolated)), owners = [...people.keys()];
  if (path === '/agents/directory') return { ok: true, value: { channel: deps.config.channel, people: [...people] } };
  if (path === '/agents/broadcast') {
    try { return { ok: true, value: await readBroadcast(directoryOf(deps).inboxRoot, String(body.ref)) }; }
    catch (e) { return { ok: false, error: String(e) }; }
  }
  if (path === '/agents/query') {
    const args = body.args as any[];
    if (!Array.isArray(args)) return { ok: false, error: 'link_invalid_query' };
    switch (body.method) {
      case 'findAgents': return { ok: true, value: await deps.store.findAgents({ ...args[0], owners: owners.filter(o => args[0]?.owners?.includes(o)), limit: Math.min(GROUP_LIMIT, args[0]?.limit ?? FIND_LIMIT) }) };
      case 'listAgents': case 'listWorkersPage': {
        if (!people.has(args[0])) return { ok: false, error: 'not_here: owner' };
        return { ok: true, value: body.method === 'listAgents' ? await deps.store.listAgents(args[0], args[1]) : await deps.store.listWorkersPage(args[0], args[1]) };
      }
      case 'recentWork': {
        if (!Array.isArray(args[0]) || args[0].length > GROUP_LIMIT) return { ok: false, error: 'link_invalid_query' };
        const ids: string[] = [];
        for (const id of args[0]) {
          for (const owner of owners) {
            const room = await deps.store.getConversation(id, owner);
            if (room?.ownerId && people.has(room.ownerId)) { ids.push(id); break; }
          }
        }
        return { ok: true, value: [...await deps.store.recentWork(ids, args[1])] };
      }
      case 'agentPresence': return people.has(args[0]) ? { ok: true, value: await deps.store.agentPresence(args[0]) } : { ok: false, error: 'not_here: owner' };
      default: return { ok: false, error: 'link_invalid_query' };
    }
  }
  if (path === '/agents/message') {
    const parsed = parseRemoteMessage(body.message);
    if (!parsed.ok) return { ok: false, error: `link_invalid_message: ${parsed.error}` };
    const m = parsed.value, target = await deps.store.getAgent(m.to);
    if (!target || !people.has(target.ownerId)) return { ok: false, error: 'not_here: agent' };
    // A queued message follows the work if its worker completed while the hosts were disconnected.
    const recipient = target.archived ? await deps.store.getAgent(deps.runtime.managerFor(target.ownerId) ?? '') : target;
    if (!recipient) return { ok: false, error: 'not_here: recipient' };
    if (body.broadcastRecord) {
      const record = body.broadcastRecord as BroadcastRecord;
      if (!record || typeof record.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(record.id) || record.id !== m.broadcast?.id || !Array.isArray(record.to) || record.to.length > GROUP_LIMIT || record.to.some(id => typeof id !== 'string') || typeof record.group !== 'string' || typeof record.at !== 'number' || record.from?.id !== m.from.id) return { ok: false, error: 'link_invalid_broadcast' };
      await writeBroadcast(directoryOf(deps).inboxRoot, record);
    }
    const route = await routeBackground(deps, recipient, recipient.originConversationId);
    const text = target.archived ? `(Sent to ${target.name} (${target.id}), which has finished; please pass this to whoever handles its work.)\n${m.text}` : m.text;
    const delivery = await deps.runtime.deliver({ agentId: recipient.id, kind: recipient.role === 'worker' ? 'agent' : 'note', fromId: m.from.id, ...route, text: messageText(m.from, recipient, text, m.broadcast), deliveryKey: `agent-link:${m.id}` });
    return delivery.ok ? { ok: true, value: { id: m.id } } : { ok: false, error: `${delivery.error}: ${delivery.detail}` };
  }
  return { ok: false, error: 'link_unknown_agent_path' };
}
