import type { SearchQuery } from '../../shared/contract.js';
// The link between this host's Kenan channels (Beta and production). A shared chat lives in one channel's database while
// a member's Kenaznia may run on the other: the chat's channel hands that member's items to the Kenaznia's channel, and
// the Kenaznia's posts go back to the chat's channel. Each channel listens on its own unix socket (config.link.listen,
// root only, mode 0600: both channels run as root, so only they can call it) and calls its siblings' sockets.
import { receiveLinkedEvent } from '../event-inbox.js';
import { agentLinkRequest } from '../agents/messaging.js';
import { receive as receivePeer, parseInbound } from '../peers.js';
import { chmod, unlink } from 'node:fs/promises';
import { createServer, request, type IncomingMessage, type Server } from 'node:http';
import { getRequestListener } from '@hono/node-server';
import type { Hono } from 'hono';
import type { PersonConfig } from '../config.js';
import type { Deps } from '../types.js';
import type { ChannelItem } from './inbound.js';
import { receive } from './inbound.js';
import { MESSAGE_REWRITE_PATH, receiveMessageRewrite } from './message-rewrite.js';
import { postLocal, type PostRequest, type Posted } from './kenan.js';
import { deliverRoomEvents, LINK_PERSON, passRoomEvents, sharedRoomsFor, type RoomEvent } from './rooms.js';

export interface LinkConfig { listen: string; siblings: string[]; forwardEvents?: string[] }
export type LinkResult<T> = { ok: true; value: T } | { ok: false; error: string };

const MAX_BODY = 4 * 1024 * 1024;
const CALL_TIMEOUT_MS = 20_000;

export function linkCall<T>(socketPath: string, path: string, body: unknown, timeoutMs = CALL_TIMEOUT_MS): Promise<LinkResult<T>> {
  return new Promise(resolve => {
    const data = Buffer.from(JSON.stringify(body));
    const req = request({ socketPath, path, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': data.length }, timeout: timeoutMs }, res => {
      const chunks: Buffer[] = [];
      res.on('data', c => chunks.push(c));
      res.on('error', e => resolve({ ok: false, error: `link_unreachable: ${socketPath}: ${e.message}` }));
      res.on('aborted', () => resolve({ ok: false, error: `link_unreachable: ${socketPath}: response aborted` }));
      res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as LinkResult<T>); } catch (e) { resolve({ ok: false, error: `link_bad_answer: ${e}` }); } });
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', e => resolve({ ok: false, error: `link_unreachable: ${socketPath}: ${e.message}` }));
    req.end(data);
  });
}

/** Calls siblings until the owner answers. An unreachable sibling must not hide a later owner. */
export async function toSiblings<T>(deps: Pick<Deps, 'config'>, path: string, body: unknown): Promise<LinkResult<T>> {
  const siblings = deps.config.link?.siblings ?? [];
  if (!siblings.length) return { ok: false, error: 'link_none: this channel has no sibling channels (config.link)' };
  let unreachable: LinkResult<T> | undefined;
  let last: LinkResult<T> = { ok: false, error: 'not_here' };
  for (const socket of siblings) {
    last = await linkCall<T>(socket, path, body);
    if (last.ok) return last;
    if (last.error.startsWith('link_unreachable:')) { unreachable = last; continue; }
    if (!last.error.startsWith('not_here')) return last;
  }
  return unreachable ?? last;
}

const RETRIES_MS = [1_000, 3_000, 10_000, 30_000, 90_000];
/** Hands a person's items to the channel hosting their Kenaznia, retrying while that channel restarts. */
export async function forward(deps: Deps, person: PersonConfig, items: ChannelItem[]): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    const sent = await toSiblings<null>(deps, '/receive', { personId: person.id, items });
    if (sent.ok) return;
    if (attempt >= RETRIES_MS.length || sent.error.startsWith('not_here')) { await deps.store.logError(`channels:${person.id}`, `link forward of ${items.length} item(s) failed: ${sent.error}`); return; }
    await new Promise(r => setTimeout(r, RETRIES_MS[attempt]));
  }
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const c of req) { size += (c as Buffer).length; if (size > MAX_BODY) throw new Error('body too large'); chunks.push(c as Buffer); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/** Serves the link socket and passes shared-chat events to the other channels; returns a stop function. Paths under
 *  /api/ are the app's own API, run as the person the LINK_PERSON header names (server/channels/rooms.ts relay). */
export async function startLink(deps: Deps, app: Pick<Hono<any>, 'fetch'>): Promise<() => void> {
  const link = deps.config.link;
  if (!link) return () => {};
  const api = getRequestListener(request => app.fetch(request, { linkPerson: request.headers.get(LINK_PERSON) }));
  const hosted = (id: unknown): PersonConfig | null => { const p = typeof id === 'string' ? deps.person(id) : undefined; return p && deps.runtime.managerFor(p.id) ? p : null; };
  const server: Server = createServer(async (req, res) => {
    if (req.url?.startsWith('/api/')) return api(req, res);
    const answer = (value: LinkResult<unknown>) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
    try {
      const body = await readBody(req) as Record<string, unknown>;
      if (req.url === MESSAGE_REWRITE_PATH) return answer(req.method === 'POST' ? await receiveMessageRewrite(deps, body) : { ok: false, error: 'invalid_message_rewrite_method' });
      if (req.url === '/host-event') return answer(await receiveLinkedEvent(deps, String(body.personId), body.event));
      if (req.url === '/agents/peer-inbox') {
        const person = hosted(body.personId);
        if (!person) return answer({ ok: false, error: 'not_here: peer owner' });
        const parsed = parseInbound(body.inbound, person.peers);
        return answer(parsed.ok ? await receivePeer(deps, person, parsed.value) : { ok: false, error: parsed.error });
      }
      if (req.url?.startsWith('/agents/')) return answer(await agentLinkRequest(deps, req.url, body));
      switch (req.url) {
        case '/receive': {
          const person = hosted(body.personId);
          if (!person) return answer({ ok: false, error: `not_here: ${String(body.personId)}'s Kenaznia is not on ${deps.config.channel}` });
          await receive(deps, person, body.items as ChannelItem[], { linked: true });
          return answer({ ok: true, value: null });
        }
        case '/post': return answer(await postLocal(deps, body as unknown as PostRequest) as LinkResult<Posted>);
        case '/search': {
          const personId = String(body.personId);
          if (!deps.person(personId)) return answer({ ok: false, error: 'not_here: search person' });
          return answer({ ok: true, value: await deps.store.searchMessages(personId, body.query as SearchQuery) });
        }
        case '/rooms': return answer(await sharedRoomsFor(deps, String(body.personId), { includeArchived: body.includeArchived === true, id: typeof body.id === 'string' ? body.id : null }));
        case '/events': return answer(await deliverRoomEvents(deps, body.events as RoomEvent[]));
        default: return answer({ ok: false, error: `link_unknown_path: ${req.url}` });
      }
    } catch (e) { answer({ ok: false, error: req.url === MESSAGE_REWRITE_PATH ? 'message_rewrite_failed' : `link_failed: ${String(e)}` }); }
  });
  await unlink(link.listen).catch(e => { if (e.code !== 'ENOENT') throw e; });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(link.listen, resolve); });
  await chmod(link.listen, 0o600);
  const untap = passRoomEvents(deps);
  return () => { untap(); server.close(); };
}
