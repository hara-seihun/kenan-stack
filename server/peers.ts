// Messages between a person's Kenaznia and Kenaznias on other hosts (people[].peers).
// Agents queue outbound messages with the `peer` tool. Each person with peers gets a unix socket
// /run/kenan/<channel>-peer/<person>.sock (owned by their unix user, mode 0600); a relay that person runs
// moves messages between hosts through it: GET /outbox (long poll), POST /ack, POST /inbox.
// An inbound message joins the current turn of the agent it is addressed to (`to`: one of the person's live agents, so a
// worker talking to a peer gets the replies itself) or else of the person's manager, like a worker note, and is shown in
// that agent's conversation.
import { EventEmitter } from 'node:events';
import { chmod, chown, mkdir, unlink } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { Type } from 'typebox';
import { hostedManager, type PeerConfig, type PersonConfig } from './config.js';
import type { AgentInfo } from '../shared/contract.js';
import type { Deps, KenanTool, PeerMessage, ToolContext } from './types.js';

export const PEER_TEXT_LIMIT = 16_000;
const OUTBOX_BATCH = 20;
const MAX_WAIT_SECONDS = 50;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const peerSocketPath = (channel: string, personId: string) => join('/run/kenan', `${channel}-peer`, `${personId}.sock`);

/** Wakes long-polling relays when an outbound message is queued. */
const queued = new EventEmitter().setMaxListeners(0);
const queueKey = (ownerId: string, peerId: string) => `${ownerId}\u0000${peerId}`;

type Inbound = { id: string; peer: string; from: string; to: string | null; text: string; createdAt: number };
type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

export function parseInbound(raw: unknown, peers: PeerConfig[]): Parsed<Inbound> {
  const r = raw as Record<string, unknown> | null;
  if (!r || typeof r !== 'object') return { ok: false, error: 'body must be a JSON object' };
  const { id, peer, from, to, text, createdAt } = r;
  if (typeof id !== 'string' || !UUID.test(id)) return { ok: false, error: 'id: the sender\'s message uuid' };
  if (typeof peer !== 'string' || !peers.some(p => p.id === peer)) return { ok: false, error: `peer: one of ${peers.map(p => p.id).join(', ')}` };
  if (typeof from !== 'string' || !from.trim() || from.length > 200) return { ok: false, error: 'from: the sending agent id' };
  if (to !== undefined && to !== null && (typeof to !== 'string' || !to.trim() || to.length > 200)) return { ok: false, error: 'to: the receiving agent id, or null for its Kenaznia' };
  if (typeof text !== 'string' || !text.trim() || text.length > PEER_TEXT_LIMIT) return { ok: false, error: `text: 1–${PEER_TEXT_LIMIT} characters` };
  if (typeof createdAt !== 'number' || !Number.isSafeInteger(createdAt) || createdAt <= 0) return { ok: false, error: 'createdAt: epoch milliseconds' };
  return { ok: true, value: { id, peer, from, to: typeof to === 'string' ? to : null, text, createdAt } };
}

export function peerNoteText(peer: PeerConfig, message: Pick<PeerMessage, 'fromAgent' | 'text'>, misaddressed: string | null): string {
  const redirect = misaddressed ? ` It was addressed to ${misaddressed}, which is no longer running, so it came to you.` : '';
  return `Message from ${peer.name} (peer ${peer.id}, sent by its agent ${message.fromAgent}).${redirect} It is another Kenaznia (another person's, or on another host), not a person; reply with peer send peer ${peer.id} to ${message.fromAgent}, which delivers straight to that agent.\n${message.text}`;
}

/** The agent an inbound message goes to: the addressed agent while it is one of the person's live (unarchived, not stopped) agents, otherwise the person's manager. */
async function recipient(deps: Deps, person: PersonConfig, to: string | null): Promise<{ agent: AgentInfo; misaddressed: string | null } | null> {
  const manager = await deps.store.getAgent(`manager:${person.id}`);
  const live = (a: AgentInfo | null): a is AgentInfo => !!a && a.ownerId === person.id && !a.archived && a.state !== 'stopped';
  if (to !== null && to !== manager?.id) {
    const addressed = await deps.store.getAgent(to);
    if (live(addressed)) return { agent: addressed, misaddressed: null };
    return live(manager) ? { agent: manager, misaddressed: to } : null;
  }
  return live(manager) ? { agent: manager, misaddressed: null } : null;
}

/** Stores an inbound message once and hands it to its recipient; a repeated id is acknowledged without a second delivery. */
export async function receive(deps: Deps, person: PersonConfig, inbound: Inbound): Promise<{ ok: true; value: { id: string; duplicate: boolean } } | { ok: false; error: string }> {
  const peer = person.peers.find(p => p.id === inbound.peer);
  if (!peer) return { ok: false, error: `unknown peer ${inbound.peer}` };
  const target = await recipient(deps, person, inbound.to);
  if (!target) return { ok: false, error: `no live manager for ${person.id}` };
  const stored = await deps.store.receivePeerInbound({ id: inbound.id, ownerId: person.id, peerId: peer.id, fromAgent: inbound.from, toAgent: inbound.to, text: inbound.text, createdAt: inbound.createdAt });
  if (!stored) return { ok: true, value: { id: inbound.id, duplicate: true } };
  const { agent, misaddressed } = target;
  const notice = await deps.store.appendMessage({ conversationId: agent.conversationId, authorId: agent.id, role: 'notice', notice: 'peer_message', text: `Message from ${peer.name}: ${stored.text}` });
  deps.bus.toConversation(agent.conversationId, { type: 'message', message: notice });
  deps.runtime.deliver({ agentId: agent.id, kind: 'note', fromId: `peer:${peer.id}`, conversationId: agent.conversationId, text: peerNoteText(peer, stored, misaddressed) });
  return { ok: true, value: { id: stored.id, duplicate: false } };
}

async function waitForOutbox(deps: Deps, ownerId: string, peerId: string, waitSeconds: number, closed: () => boolean): Promise<PeerMessage[]> {
  const deadline = Date.now() + waitSeconds * 1000;
  for (;;) {
    const items = await deps.store.peerOutbox(ownerId, peerId, OUTBOX_BATCH);
    const left = deadline - Date.now();
    if (items.length || left <= 0 || closed()) return items;
    await new Promise<void>(resolve => {
      const done = () => { clearTimeout(timer); queued.off(queueKey(ownerId, peerId), done); resolve(); };
      const timer = setTimeout(done, Math.min(left, 5000));
      queued.once(queueKey(ownerId, peerId), done);
    });
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', chunk => { data += chunk; if (data.length > 256 * 1024) req.destroy(new Error('body too large')); });
    req.on('end', () => resolve(data)); req.on('error', reject);
  });
}

async function handle(deps: Deps, person: PersonConfig, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const reply = (status: number, value: unknown) => { if (!res.writableEnded) { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); } };
  const invalid = (message: string) => reply(400, { ok: false, error: { code: 'invalid', message } });
  const url = new URL(req.url ?? '/', 'http://localhost');
  const route = `${req.method} ${url.pathname}`;
  switch (route) {
    case 'GET /outbox': {
      const peer = url.searchParams.get('peer') ?? '';
      if (!person.peers.some(p => p.id === peer)) return invalid(`peer: one of ${person.peers.map(p => p.id).join(', ')}`);
      const wait = Number(url.searchParams.get('wait') ?? '0');
      if (!Number.isFinite(wait) || wait < 0 || wait > MAX_WAIT_SECONDS) return invalid(`wait: 0–${MAX_WAIT_SECONDS} seconds`);
      let closed = false; res.on('close', () => { closed = true; });
      const items = await waitForOutbox(deps, person.id, peer, wait, () => closed);
      return reply(200, { ok: true, value: { items: items.map(m => ({ id: m.id, from: m.fromAgent, to: m.toAgent, text: m.text, createdAt: m.createdAt })) } });
    }
    case 'POST /ack': {
      let raw: { peer?: unknown; ids?: unknown };
      try { raw = JSON.parse(await readBody(req)); } catch { return invalid('body is not JSON'); }
      if (typeof raw.peer !== 'string' || !person.peers.some(p => p.id === raw.peer)) return invalid(`peer: one of ${person.peers.map(p => p.id).join(', ')}`);
      if (!Array.isArray(raw.ids) || !raw.ids.length || raw.ids.length > 100 || raw.ids.some(id => typeof id !== 'string' || !UUID.test(id))) return invalid('ids: 1–100 message uuids');
      return reply(200, { ok: true, value: { acked: await deps.store.ackPeerOutbound(person.id, raw.peer, raw.ids as string[]) } });
    }
    case 'POST /inbox': {
      let raw: unknown;
      try { raw = JSON.parse(await readBody(req)); } catch { return invalid('body is not JSON'); }
      const parsed = parseInbound(raw, person.peers);
      if (!parsed.ok) return invalid(parsed.error);
      const received = await receive(deps, person, parsed.value);
      return received.ok ? reply(200, received) : reply(409, { ok: false, error: { code: 'unavailable', message: received.error } });
    }
    default: return reply(404, { ok: false, error: { code: 'route', message: 'GET /outbox?peer=ID&wait=SECONDS, POST /ack {peer, ids}, POST /inbox {id, peer, from, to?, text, createdAt}' } });
  }
}

export async function servePeerSocket(deps: Deps, person: PersonConfig, path: string): Promise<Server> {
  await unlink(path).catch(e => { if (e.code !== 'ENOENT') throw e; });
  const server = createServer((req, res) => {
    handle(deps, person, req, res).catch(e => { if (!res.writableEnded) { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: { code: 'internal', message: String(e) } })); } });
  });
  server.requestTimeout = 0;
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(path, resolve); });
  await chown(path, person.uid, person.gid);
  await chmod(path, 0o600);
  return server;
}

/** Starts a peer socket for each person whose Kenaznia runs on this channel and has peers; returns a closer. */
export async function startPeerSockets(deps: Deps): Promise<() => void> {
  const people = deps.config.people.filter(p => hostedManager(p) && p.peers.length);
  if (!people.length) return () => {};
  await mkdir(join('/run/kenan', `${deps.config.channel}-peer`), { recursive: true, mode: 0o755 });
  const servers = await Promise.all(people.map(p => servePeerSocket(deps, p, peerSocketPath(deps.config.channel, p.id))));
  return () => { for (const s of servers) { s.close(); s.closeAllConnections(); } };
}

const result = (value: unknown) => ({ content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value) }], details: {} });

/** Only for people with peers: send to, or read recent history with, another Kenaznia (another person's on this host, or one on another host). */
export function peerTool({ deps, person, agent }: ToolContext): KenanTool | null {
  if (!person.peers.length) return null;
  const known = person.peers.map(p => `${p.id}: ${p.name}. ${p.about}`).join(' ');
  return {
    name: 'peer', files: 'none', label: 'Peer', description: `Message another Kenaznia directly (another person's Kenaznia on this host, or one on another host). Peers: ${known} action "send" (peer, text, optional to) queues the message; a relay delivers it within seconds into the live conversation of that Kenaznia, or of the agent on its side named by to (the "sent by its agent" id of a message you answer, so its worker gets your reply directly), joining its current turn like a worker note. Replies addressed to you arrive in your own conversation as notes from peer:ID; others go to your manager. Messages are kept and delivered after outages, once each. Write to it as an equally capable agent without your context. action "history" (peer, limit) lists recent messages both ways with relay state.`,
    parameters: Type.Object({ action: Type.Union([Type.Literal('send'), Type.Literal('history')]), peer: Type.Union(person.peers.map(p => Type.Literal(p.id))), text: Type.Optional(Type.String()), to: Type.Optional(Type.String({ description: 'The other side\'s agent id to deliver to directly; omit to reach that Kenaznia' })), limit: Type.Optional(Type.Number({ minimum: 1, maximum: 50 })) }),
    execute: async (_id, args: { action: 'send' | 'history'; peer: string; text?: string; to?: string; limit?: number }) => {
      const peer = person.peers.find(p => p.id === args.peer);
      if (!peer) throw new Error(`unknown_peer: ${args.peer}; peers are ${person.peers.map(p => p.id).join(', ')}`);
      switch (args.action) {
        case 'send': {
          if (!args.text?.trim() || args.text.length > PEER_TEXT_LIMIT) throw new Error(`text: 1–${PEER_TEXT_LIMIT} characters`);
          if (args.to !== undefined && (!args.to.trim() || args.to.length > 200)) throw new Error('to: the other side\'s agent id (1–200 characters), or omit it for its Kenaznia');
          const message = await deps.store.createPeerOutbound({ ownerId: person.id, peerId: peer.id, fromAgent: agent.id, toAgent: args.to ?? null, text: args.text });
          queued.emit(queueKey(person.id, peer.id));
          return result({ queued: message.id, peer: peer.id, note: 'The relay delivers it within seconds; check history for relayedAt.' });
        }
        case 'history': {
          const items = await deps.store.peerHistory(person.id, peer.id, args.limit ?? 20);
          return result({ items: items.map(m => ({ id: m.id, direction: m.direction, from: m.fromAgent, to: m.toAgent, at: new Date(m.createdAt).toISOString(), relayedAt: m.direction === 'out' ? (m.relayedAt === null ? null : new Date(m.relayedAt).toISOString()) : undefined, text: m.text.slice(0, 2000) })) });
        }
      }
    },
  };
}
