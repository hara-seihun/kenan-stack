import { rewriteChatMessage } from '../message-actions.js';
import { ownersVisible } from '../agents/person-isolation.js';
import { ClaudeNotEnabledForPerson } from '../agents/worker-quota.js';
import { CONTENT_PUBLIC_PATH, type ContentCadenceExtension } from '../extensions/content-cadence.js';
// HTTP API (shared/contract.ts `Api`), SSE stream, extension routes and the static web app.
import { Hono, type Context } from 'hono';
import { androidRoutes } from './android.js';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { streamSSE } from 'hono/streaming';
import { chooseEncoding, compressJson, streamEncoder } from './compress.js';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { serveStatic } from '@hono/node-server/serve-static';
import {
  errorStatus, SSE_HEARTBEAT_MS, SSE_RETRY_MS, type Bootstrap, type StreamEvent, type StartupPage, type ConversationSummary, type Message, type MessagePart, type Person, type Result, type ServerEvent, type ManagerHome, type AgentInfo, type WebPushSubscription, type WebPushTest,
  TRAY_TILES, VIEWER_QUERY, isTray, pdfFile, type TrayTile,
} from '../../shared/contract.js';
import { hostedManager } from '../config.js';
import { parseMemberColors } from '../member-colors.js';
import { sharedChange, soloChatMembers, type Admission, type Deps, type MessageCursor, type RoomPatch } from '../types.js';
import { createAuth, csrfAllowed, SESSION_COOKIE, type SessionStore } from '../auth/auth.js';
import { errorCode, fail } from '../db/errors.js';
import { DEVICES, validDevice, validZone } from '../../shared/zone.js';
import { fileParts, fileResponse, saveUpload } from '../files/files.js';
import { pdfInfo, pdfPage, pdfPageWidth } from '../files/pdf.js';
import { usageReport } from '../metrics/usage.js';
import { gpuUsageReport } from '../metrics/gpus.js';
import { BlankRefused, blankModels, startBlankChat } from '../agents/blank.js';
import { clipMessage } from './clip.js';
import { searchChats } from '../channels/search.js';
import { quietHoursStatus, validQuietHours } from '../quiet-hours.js';
import { clearChatNotifications, openStream } from '../notifications.js';
import { notifyChatMembers, setViewing } from '../chat-notify.js';
import { NOTIFY_OUTBOX_ROOT } from '../notify-outbox.js';
import { parseSubscription, pushOptions, pushPayload } from '../web-push.js';
import { readFile } from 'node:fs/promises';
import { leaveRoom, patchRemoteRoom, relay, remoteRoom, remoteRooms } from '../channels/rooms.js';

/** linked: the request came over the link from another channel, acting as `me` (server/channels/rooms.ts). */
export type AppEnv = { Variables: { receivedAt: number; me: string; linked: boolean } };
/** Person id of the logged-in human; usable from extension routes (they share the request context). */
export const personOf = (c: Context): string => c.get('me' as never);

const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const sessionCookie = (expiresAt: number, now: number) => ({ path: '/', httpOnly: true, secure: true, sameSite: 'Lax' as const, maxAge: Math.ceil((expiresAt - now) / 1000) });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LATENCY_WINDOW_MS = 24 * 3600_000;

// ---- input checks ----
async function jsonBody(c: Context): Promise<Record<string, unknown>> {
  const v = await c.req.json().catch(() => null);
  return v && typeof v === 'object' && !Array.isArray(v) ? v : fail('invalid_input', 'JSON object body required');
}
const str = (v: unknown, name: string, max = 10_000): string => typeof v === 'string' && v.length <= max ? v : fail('invalid_input', `${name} must be a string`);
const strs = (v: unknown, name: string): string[] => Array.isArray(v) && v.every(x => typeof x === 'string') ? v : fail('invalid_input', `${name} must be a string array`);
const optStrs = (v: unknown, name: string) => v === undefined ? undefined : strs(v, name);
const finite = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) ? v : null;
const queryInt = (v: string | undefined): number | undefined => v === undefined || v === '' ? undefined : Number.isSafeInteger(Number(v)) ? Number(v) : fail('invalid_input', `Bad number ${v}`);

export function createApp(deps: Deps, preview = false): Hono<AppEnv> {
  const { config, store, bus } = deps;
  if (typeof (store as Partial<SessionStore>).createSession !== 'function') throw new Error('createApp needs the pg store (session methods)');
  const auth = createAuth({ config, sessions: store as unknown as SessionStore, now: deps.now });
  // strict: false so /api/ext/calendar/ reaches the extension's '/' route (the calendar pages call it with the slash).
  const app = new Hono<AppEnv>({ strict: false });
  let eventId = 0;
  const logError = (scope: string, e: unknown) => {
    console.error(JSON.stringify({ type: 'error', scope, error: String((e as Error)?.stack ?? e) }));
    void store.logError(scope, String((e as Error)?.stack ?? e)).catch(() => {});
  };

  // Preview serves only chat reads. Nginx authenticates its network-restricted visitor.
  if (preview) app.use('*', async (c, next) => {
    const path = c.req.path, method = c.req.method;
    const readApi = path === '/api/accounts' || path === '/api/references' || path === '/api/bootstrap' || path === '/api/events' || path === '/api/search' ||
      /^\/api\/conversations\/[0-9a-f-]+$/i.test(path) ||
      /^\/api\/conversations\/[0-9a-f-]+\/messages(?:\/[0-9a-f-]+)?$/i.test(path) ||
      /^\/api\/files\/[0-9a-f-]+(?:\/pdf(?:\/\d+)?)?$/i.test(path);
    if (path.startsWith('/api/')) {
      if (!(method === 'GET' && readApi) && !(method === 'POST' && (path === '/api/login' || path === '/api/logout'))) return c.json({ ok: false, error: { code: 'forbidden', message: 'Read-only preview' } }, 403);
    } else if ((method !== 'GET' && method !== 'HEAD') || path.startsWith('/hooks/') || path.startsWith('/android/')) {
      return c.text('Read-only preview', 403);
    }
    return next();
  });

  // First middleware: the receive stamp for latency.
  app.use('*', async (c, next) => { c.set('receivedAt', deps.now()); await next(); });

  app.onError((e, c) => {
    const code = errorCode(e);
    if (code === 'internal') logError('http', e);
    return c.json({ ok: false, error: { code, message: e.message } } satisfies Result<never>, errorStatus[code] as ContentfulStatusCode);
  });

  androidRoutes(app, config.channel, undefined, config.origins[0]);

  // ---- provider webhooks: /hooks/<id>/..., outside session auth; each hook authenticates its caller ----
  for (const ext of deps.extensions) {
    if (!ext.hooks) continue;
    const sub = new Hono();
    ext.hooks(sub, deps);
    app.route(`/hooks/${ext.id}`, sub);
  }

  // Only this exact machine endpoint bypasses human session/CSRF auth. The
  // configured extension instance owns lifecycle and native OIDC verification.
  const content = deps.extensions.find((ext): ext is ContentCadenceExtension =>
    ext.id === 'content-cadence' && 'publicRequest' in ext && typeof ext.publicRequest === 'function');
  app.all(CONTENT_PUBLIC_PATH, async c =>
    (await content?.publicRequest(c.req.raw)) ?? new Response(null, { status: 404 }));

  app.use('/api/*', compressJson());
  app.use('/api/*', async (c, next) => {
    // Only the link socket passes linkPerson (server/channels/link.ts); requests through nginx carry Node's bindings.
    // The preview socket is private to nginx. Nginx replaces this header after its mesh IP check.
    const previewPerson = preview ? c.req.header('x-kenan-preview-person') : undefined;
    if (previewPerson && deps.person(previewPerson)) { c.set('me', previewPerson); c.set('linked', false); return next(); }
    const linked = (c.env as { linkPerson?: unknown } | undefined)?.linkPerson;
    if (typeof linked === 'string') {
      if (!deps.person(linked)) fail('unauthenticated', `link_unknown_person: ${linked}`);
      c.set('me', linked); c.set('linked', true);
      return next();
    }
    c.set('linked', false);
    if (!csrfAllowed(c.req.method, c.req.header('origin'), c.req.header('x-kenan-client'), config.origins)) fail('forbidden', 'Origin not allowed');
    const path = c.req.path;
    if ((path === '/api/accounts' && c.req.method === 'GET') || ((path === '/api/login' || path === '/api/account-arrive') && c.req.method === 'POST')) return next();
    const token = getCookie(c, SESSION_COOKIE), session = await auth.authenticate(token);
    // EventSource can't read an HTTP status, so the stream says it in an event.
    if (!session && path === '/api/events') return eventStream(c, out => { out.send({ type: 'unauthenticated' }); out.end(); });
    if (!session) fail('unauthenticated', 'Login required');
    c.set('me', session!.personId);
    await next();
    // After the route, so the renewed cookie reaches streams (their Response is built outside the context) as well.
    if (session!.renewed) setCookie(c, SESSION_COOKIE, token!, sessionCookie(session!.expiresAt, deps.now()));
  });

  // ---- helpers ----
  async function memberConversation(id: string, me: string): Promise<ConversationSummary> {
    const conv = UUID.test(id) ? await store.getConversation(id, me) : null;
    if (!conv) fail('not_found', 'Conversation not found');
    if (!conv!.memberIds.includes(me)) fail('forbidden', 'Not a member of this conversation');
    return conv!;
  }
  async function visibleMembers(ids: string[], me: string): Promise<string[]> {
    const viewer = deps.person(me)!;
    for (const id of ids) {
      const human = deps.person(id), agent = human ? null : await store.getAgent(id);
      const ownerId = human?.id ?? agent?.ownerId;
      if (ownerId && !ownersVisible(viewer, deps.person(ownerId), ownerId)) fail('forbidden', 'That person or agent is not available to this account');
    }
    return ids;
  }
  /** Send each human (configured person) their own summary (readThrough differs per person). */
  function broadcastConversation(id: string, personIds: Iterable<string>) {
    void (async () => {
      for (const pid of new Set(personIds)) {
        if (!deps.person(pid)) continue;
        const conversation = await store.getConversation(id, pid);
        if (conversation) bus.toPerson(pid, { type: 'conversation', conversation });
      }
    })().catch(e => logError('http', e));
  }
  /** Configuration decides where a person's Kenaznia runs; a hosted one the runtime hasn't placed is an error, never "none". */
  async function managerHome(me: string, agents: AgentInfo[]): Promise<ManagerHome> {
    const placement = deps.person(me)?.manager ?? null;
    if (!placement) return { kind: 'none' };
    if ('elsewhere' in placement) return { kind: 'elsewhere', url: placement.elsewhere };
    const managerId = deps.runtime.managerFor(me);
    const manager = managerId ? agents.find(a => a.id === managerId) ?? await store.getAgent(managerId) : null;
    return manager ? { kind: 'here', conversationId: manager.conversationId } : fail('unavailable', `manager_unplaced: ${me}'s Kenaznia is configured on this channel but not running`);
  }
  async function bootstrap(me: string, includeArchived = false): Promise<Bootstrap> {
    const [person, agents, local, remote, layout, zone, seen, tray] = await Promise.all([
      store.getPerson(me), store.listAgents(me, { includeArchived, includeAncestors: true }), store.listConversations(me, { includeArchived }), remoteRooms(deps, me, { includeArchived }), store.layoutOf(me), store.zoneReportOf(me), store.seenOf(me), store.trayOf(me),
    ]);
    const [localPeople, goals] = await Promise.all([
      store.listPeople({ ids: [...new Set([...agents.map(a => a.id), ...local.flatMap(c => c.memberIds)])], includeHumans: true }),
      store.goalSummaries(me, [...new Set(agents.flatMap(a => a.goalId ? [a.goalId] : []))]),
    ]);
    // A chat this database holds is served from here, even if another channel has a copy of it too.
    const localIds = new Set(local.map(c => c.id));
    const conversations = [...local, ...remote.rooms.filter(r => !localIds.has(r.id))].filter(c => !deps.person(me)?.isolated || c.memberIds.every(id => id === me || agents.some(a => a.id === id))).sort((a, b) => b.updatedAt - a.updatedAt);
    // Members of chats held on another channel go by that channel's names ("Alice's Kenaznia"), except this channel's own.
    const ownAgents = new Set(agents.map(a => a.id));
    const remoteIds = new Set(remote.people.map(p => p.id)), keptLocal = new Set(localPeople.filter(p => ownAgents.has(p.id) || p.kind === 'human').map(p => p.id));
    const allPeople = [...localPeople.filter(p => !remoteIds.has(p.id) || keptLocal.has(p.id)), ...remote.people.filter(r => !keptLocal.has(r.id))];
    const viewer = deps.person(me)!;
    const people = allPeople.filter(p => p.kind === 'human' ? ownersVisible(viewer, deps.person(p.id), p.id) :
      ownAgents.has(p.id) || (!viewer.isolated && !deps.config.people.some(owner => owner.isolated && p.id === `manager:${owner.id}`)));
    if (!person) fail('unauthenticated', 'Unknown person');
    const visible = new Set([...agents.map(a => a.id), ...conversations.flatMap(c => c.memberIds)]);
    const home = await managerHome(me, agents);
    const configured = deps.person(me);
    const extensions = deps.extensions.filter(e => configured && (e.enabled ? e.enabled(configured) : configured.extensions.includes(e.id))).map(e => ({ id: e.id, name: e.name }));
    return {
      ...(configured?.clientHome ? { clientHome: configured.clientHome } : {}),
      me: person!, people: people.filter(p => p.kind === 'human' || visible.has(p.id)), agents, goals, conversations,
      activity: Object.fromEntries(conversations.flatMap(c => { const now = bus.activity(c.id); return now ? [[c.id, now]] : []; })),
      manager: home, layout, zone, seen,
      extensions, composerVoice: configured?.composerVoice === true && extensions.some(e => e.id === 'voice'),
      background: configured?.background ?? null, bubbleColor: configured?.bubbleColor ?? null, trayTiles: tray ?? configured?.trayTiles ?? null, waiting: bus.waiting(me),
      serverTime: deps.now(), channel: config.channel,
    };
  }

  // ---- auth ----
  app.get('/api/accounts', c => c.json(ok(config.people.filter(p => !p.isolated).map((p): Person => ({ id: p.id, name: p.name, kind: 'human' })))));
  app.post('/api/login', async c => {
    const b = await jsonBody(c);
    const session = await auth.login(str(b.accountId, 'accountId', 64), str(b.secret, 'secret', 1024));
    setCookie(c, SESSION_COOKIE, session.token, sessionCookie(session.expiresAt, deps.now()));
    return c.json(ok(await bootstrap(session.personId)));
  });
  app.post('/api/logout', async c => {
    await auth.logout(getCookie(c, SESSION_COOKIE));
    deleteCookie(c, SESSION_COOKIE, { path: '/', secure: true, httpOnly: true, sameSite: 'Lax' });
    return c.json(ok(null));
  });
  app.get('/api/bootstrap', async c => c.json(ok(await bootstrap(c.get('me'), c.req.query('includeArchived') === '1'))));
  app.get('/api/references', async c => {
    const refs = [...new Set((c.req.query('ids') ?? '').split(',').filter(Boolean))];
    if (refs.length > 128 || refs.some(id => !/^[\w:-]{1,128}$/.test(id))) fail('invalid_input', 'Expected at most 128 reference IDs');
    const me = c.get('me'), viewer = deps.person(me)!;
    const owners = deps.config.people.filter(p => ownersVisible(viewer, p, p.id)).map(p => p.id);
    const names = await store.referenceNames(me, owners, refs, viewer.isolated === true);
    const missing = refs.filter(id => names[id] === null && UUID.test(id));
    if (missing.length && !viewer.isolated && deps.config.link?.siblings.length) {
      const remote = await remoteRooms(deps, me, { includeArchived: true });
      for (const room of remote.rooms) if (missing.includes(room.id)) names[room.id] = room.title;
    }
    return c.json(ok(names));
  });
  // Only the private link may mint a session for another host's authenticated person.
  app.post('/api/account-ticket', async c => {
    if (!c.get('linked')) fail('forbidden', 'Private link required');
    c.header('Cache-Control', 'no-store');
    const b = await jsonBody(c), person = deps.person(c.get('me'));
    if (!person || !hostedManager(person) || person.clientHome || !config.origins.includes(str(b.origin, 'origin', 2048))) fail('not_found', 'Account is not hosted at this origin');
    return c.json(ok(await auth.issue(person!.id)));
  });
  app.post('/api/account-move', async c => {
    const person = deps.person(c.get('me')), origin = person?.clientHome;
    c.header('Cache-Control', 'no-store');
    if (!origin) return c.json(ok(null));
    const response = await relay(deps, person!.id, 'POST', '/api/account-ticket', { 'content-type': 'application/json' }, json({ origin }));
    const result = response ? await response.json() as Result<{ token: string; personId: string }> : fail('unavailable', 'Account host is not connected');
    if (!result.ok) fail(result.error.code, result.error.message);
    const ticket = (result as { ok: true; value: { token: string; personId: string } }).value;
    return c.json(ok({ origin, token: ticket.token, accountId: ticket.personId }));
  });
  app.post('/api/account-arrive', async c => {
    const isJson = c.req.header('content-type')?.includes('application/json');
    const b = isJson ? await jsonBody(c) : await c.req.parseBody();
    const token = str(b.token, 'token', 256), session = await auth.authenticate(token);
    const person = session ? deps.person(session.personId) : null;
    if (!session || !person || !hostedManager(person) || person.clientHome) fail('unauthenticated', 'Account is not hosted here');
    setCookie(c, SESSION_COOKIE, token, sessionCookie(session!.expiresAt, deps.now()));
    c.header('Cache-Control', 'no-store');
    c.header('Referrer-Policy', 'no-referrer');
    if (isJson) return c.json(ok({ personId: session!.personId }));
    const next = typeof b.next === 'string' && /^\/(?![\\/])/.test(b.next) ? b.next : '/';
    return c.redirect(next, 303);
  });


  // ---- shared chats held on another linked application instance (server/channels/rooms.ts) ----
  // A chat id this database doesn't hold is asked of the other channels, as this person; a request that came over the
  // link is never passed on again. The person's own filing of such a chat (emoji, pin, group…) stays here.
  const relayed = async (c: Context<AppEnv>, body: Buffer | null): Promise<Response | null> => {
    const url = new URL(c.req.url), headers: Record<string, string> = {};
    for (const h of ['content-type', 'range']) { const v = c.req.header(h); if (v) headers[h] = v; }
    return relay(deps, c.get('me'), c.req.method, url.pathname + url.search, headers, body);
  };
  const json = (value: unknown) => Buffer.from(JSON.stringify(value));
  async function remoteJson<T>(me: string, method: string, path: string, body: unknown): Promise<T> {
    const res = await relay(deps, me, method, path, body === undefined ? {} : { 'content-type': 'application/json' }, body === undefined ? null : json(body));
    const r = res ? await res.json() as Result<T> : fail('not_found', 'Conversation not found');
    return r.ok ? r.value : fail(r.error.code, r.error.message);
  }
  /** Attachments for a chat on another channel are copied there first (as the same person) and sent by their new ids. */
  async function carryFiles(me: string, conversationId: string, b: Record<string, unknown>): Promise<Record<string, unknown>> {
    const ids = b.fileIds === undefined ? [] : strs(b.fileIds, 'fileIds');
    const carried: string[] = [];
    for (const id of ids) {
      const f = UUID.test(id) ? await store.getFile(id) : null;
      if (!f || f.ownerId !== me) fail('invalid_input', `Unknown file ${id}`);
      const form = new FormData();
      form.append('file', new Blob([await readFile(f!.path)], { type: f!.mime }), f!.name);
      // Use the chat's route: an unrelated sibling must not accept its attachments.
      const path = `/api/conversations/${conversationId}/files`;
      const upload = new Request(`http://link${path}`, { method: 'POST', body: form });
      const res = await relay(deps, me, 'POST', path, { 'content-type': upload.headers.get('content-type')! }, Buffer.from(await upload.arrayBuffer()));
      const r = res ? await res.json() as Result<{ id: string }> : fail('unavailable', 'No other channel to carry the file to');
      carried.push(r.ok ? r.value.id : fail(r.error.code, `Couldn't carry ${f!.name} to the chat's channel: ${r.error.message}`));
    }
    return ids.length ? { ...b, fileIds: carried } : b;
  }
  const heldElsewhere = async (c: Context<AppEnv>, next: () => Promise<void>) => {
    const id = c.req.param('id') ?? '', path = c.req.path;
    // Posting stays one database statement: its route relays only once admission finds no such chat here.
    if (c.req.method === 'POST' && path === `/api/conversations/${id}/messages`) return next();
    if (preview || c.get('linked') || !UUID.test(id) || (await store.conversationMembers(id)).length) return next();
    const me = c.get('me');
    if (c.req.method === 'PATCH' && path === `/api/conversations/${id}`) return c.json(ok(await patchRemoteRoom(deps, me, id, await parsePatch(await jsonBody(c), me))));
    return await relayed(c, c.req.method === 'GET' || c.req.method === 'HEAD' ? null : Buffer.from(await c.req.arrayBuffer())) ?? next();
  };
  app.use('/api/conversations/:id', heldElsewhere);
  app.use('/api/conversations/:id/*', heldElsewhere);
  const fileElsewhere = async (c: Context<AppEnv>, next: () => Promise<void>) => {
    const id = c.req.param('id')!;
    if (preview || c.get('linked') || !UUID.test(id) || await store.getFile(id)) return next();
    return await relayed(c, null) ?? next();
  };
  app.use('/api/files/:id', fileElsewhere);
  app.use('/api/files/:id/*', fileElsewhere);

  // ---- conversations ----
  app.get('/api/search', async c => {
    return c.json(ok(await searchChats(deps, c.get('me'), {
      q: c.req.query('q') ?? '', chat: c.req.query('chat'), after: c.req.query('after'), before: c.req.query('before'), limit: queryInt(c.req.query('limit')),
    }, c.get('linked') || preview)));
  });
  app.get('/api/conversations/:id', async c => c.json(ok(await memberConversation(c.req.param('id'), c.get('me')))));
  app.get('/api/conversations/:id/messages', async c => {
    const conv = await memberConversation(c.req.param('id'), c.get('me'));
    const limit = Math.min(Math.max(queryInt(c.req.query('limit')) ?? 50, 1), 200);
    const before = queryInt(c.req.query('before')), after = queryInt(c.req.query('after'));
    const around = c.req.query('around');
    if (around !== undefined && (before !== undefined || after !== undefined)) fail('invalid_input', 'Use around, before or after, not together');
    if (around !== undefined && !UUID.test(around) && (!/^\d+$/.test(around) || !Number.isSafeInteger(Number(around)) || Number(around) < 1)) fail('invalid_input', 'around must be a message id or positive sequence');
    const cursor: MessageCursor = around !== undefined ? { kind: 'around', target: UUID.test(around) ? around : Number(around) } : before !== undefined && after !== undefined ? fail('invalid_input', 'Use before or after, not both')
      : before !== undefined ? { kind: 'before', seq: before } : after !== undefined ? { kind: 'after', seq: after } : { kind: 'latest' };
    const page = await store.listMessages(conv.id, cursor, limit);
    return c.json(ok({ ...page, messages: page.messages.map(clipMessage) }));
  });
  app.get('/api/conversations/:id/messages/:messageId', async c => {
    const conv = await memberConversation(c.req.param('id'), c.get('me'));
    const id = c.req.param('messageId');
    const message = UUID.test(id) ? await store.getMessage(conv.id, id) : null;
    return message ? c.json(ok(message)) : fail('not_found', 'Message not found');
  });
  app.patch('/api/conversations/:id/messages/:messageId', async c => {
    const b = await jsonBody(c);
    return c.json(ok({ message: await rewriteChatMessage(deps, c.get('me'), c.req.param('id'), c.req.param('messageId'), str(b.text, 'text', 1_000_000)) }));
  });
  app.delete('/api/conversations/:id/messages/:messageId', async c => c.json(ok({ message: await rewriteChatMessage(deps, c.get('me'), c.req.param('id'), c.req.param('messageId'), null) })));
  // This route is only available to another trusted instance's agent, never to a browser.
  app.post('/api/conversations/:id/messages/:messageId/redact', async c => {
    if (!c.get('linked')) fail('forbidden', 'Agent redaction requires the private link');
    return c.json(ok({ message: await rewriteChatMessage(deps, c.get('me'), c.req.param('id'), c.req.param('messageId'), null, true) }));
  });
  app.post('/api/conversations/:id/leave', async c => {
    const id = c.req.param('id');
    if (!UUID.test(id) || !await store.getConversation(id, c.get('me'))) fail('not_found', 'Conversation not found');
    return c.json(ok(await leaveRoom(deps, c.get('me'), id)));
  });
  app.post('/api/conversations', async c => {
    const me = c.get('me'), b = await jsonBody(c);
    const conv = await store.createConversation({ title: str(b.title, 'title', 200), ownerId: me, memberIds: soloChatMembers(me, await visibleMembers(strs(b.memberIds ?? [], 'memberIds'), me), deps.runtime.managerFor(me), id => !!deps.person(id) && ownersVisible(deps.person(me)!, deps.person(id), id)) });
    broadcastConversation(conv.id, conv.memberIds);
    return c.json(ok(conv));
  });
  async function parsePatch(b: Record<string, unknown>, me: string): Promise<RoomPatch> {
    return {
      title: b.title === undefined ? undefined : str(b.title, 'title', 200),
      titleLocked: b.titleLocked === undefined ? b.title === undefined ? undefined : true : typeof b.titleLocked === 'boolean' ? b.titleLocked : fail('invalid_input', 'titleLocked must be boolean'),
      emoji: b.emoji === undefined || b.emoji === null ? b.emoji as null | undefined : str(b.emoji, 'emoji', 16),
      pinnedAt: b.pinned === undefined ? undefined : typeof b.pinned === 'boolean' ? b.pinned ? deps.now() : null : fail('invalid_input', 'pinned must be boolean'),
      keyDate: b.keyDate === undefined || b.keyDate === null ? b.keyDate as null | undefined : /^\d{4}-\d{2}-\d{2}$/.test(String(b.keyDate)) ? String(b.keyDate) : fail('invalid_input', 'keyDate must be YYYY-MM-DD'),
      keyLabel: b.keyLabel === undefined || b.keyLabel === null ? b.keyLabel as null | undefined : str(b.keyLabel, 'keyLabel', 40),
      project: b.project === undefined ? undefined : typeof b.project === 'boolean' ? b.project : fail('invalid_input', 'project must be boolean'),
      statusLine: b.statusLine === undefined || b.statusLine === null ? b.statusLine as null | undefined : str(b.statusLine, 'statusLine', 500),
      projectId: b.projectId === undefined || b.projectId === null ? b.projectId as null | undefined : (await memberConversation(str(b.projectId, 'projectId', 64), me)).id,
      groupId: b.groupId === undefined || b.groupId === null ? b.groupId as null | undefined : typeof b.groupId === 'string' && UUID.test(b.groupId) ? b.groupId : fail('invalid_input', 'groupId must be a group id or null'),
      archived: b.archived === undefined ? undefined : typeof b.archived === 'boolean' ? b.archived : fail('invalid_input', 'archived must be boolean'),
      color: b.color === undefined || b.color === null ? b.color as null | undefined : str(b.color, 'color', 64),
      memberColors: b.memberColors === undefined ? undefined : parseMemberColors(b.memberColors),
      readThrough: b.readThrough === undefined ? undefined : finite(b.readThrough) ?? fail('invalid_input', 'readThrough must be a number'),
      addMemberIds: b.addMemberIds === undefined ? undefined : await visibleMembers(strs(b.addMemberIds, 'addMemberIds'), me), removeMemberIds: optStrs(b.removeMemberIds, 'removeMemberIds'),
    };
  }
  app.patch('/api/conversations/:id', async c => {
    const me = c.get('me'), b = await jsonBody(c);
    const before = await memberConversation(c.req.param('id'), me);
    const patch = await parsePatch(b, me);
    if (before.agentId && patch.archived !== undefined) {
      if ((await store.getAgent(before.agentId))?.role === 'manager') fail('conflict', 'This is your Kenaznia\'s conversation; it stays open. Stop ends its current turn.');
      await deps.runtime.archiveAgent(before.agentId, patch.archived);
    }
    const conv = await store.updateConversation(before.id, me, patch);
    if (patch.readThrough !== undefined && conv.readThrough >= conv.lastSeq) await clearChatNotifications(deps, me, conv.id);
    const membersChanged = !!(patch.addMemberIds?.length || patch.removeMemberIds?.length);
    if (membersChanged) bus.invalidateMembers(conv.id);
    broadcastConversation(conv.id, sharedChange(patch) ? [...before.memberIds, ...conv.memberIds] : [me]);
    return c.json(ok(conv));
  });

  /** A concurrent send with the same clientId loses the unique-index race; it answers like the duplicate it is. */
  async function admit(conversationId: string, me: string, text: string, parts: MessagePart[], clientId: string): Promise<Admission> {
    try { return await store.admitHumanMessage({ conversationId, authorId: me, text, parts, clientId }); }
    catch (e) {
      const raced = errorCode(e) === 'conflict' ? await store.getMessageByClientId(clientId) : null;
      if (!raced) throw e;
      return raced.conversationId === conversationId ? { kind: 'duplicate', message: raced } : { kind: 'client_id_taken' };
    }
  }
  // Latency-critical: receive → one admission statement (idempotency, membership, archive, seq, insert) → broadcast → respond.
  app.post('/api/conversations/:id/messages', async c => {
    const receivedAt = c.get('receivedAt'), me = c.get('me'), id = c.req.param('id');
    const b = await jsonBody(c);
    const clientId = str(b.clientId, 'clientId', 200), text = str(b.text, 'text', 1_000_000);
    const fileIds = b.fileIds === undefined ? [] : strs(b.fileIds, 'fileIds');
    const clientSentAt = finite(b.clientSentAt);
    const seenFrom = b.seenFrom === undefined ? null : str(b.seenFrom, 'seenFrom', 200).replace(/\s+/g, ' ').trim() || null;
    if (!clientId) fail('invalid_input', 'clientId required');
    if (!text.trim() && !fileIds.length) fail('invalid_input', 'Message is empty');
    // A linked request can pass several unrelated databases before reaching the chat's host.
    // Decide ownership before interpreting file ids, which only exist on that host.
    if (c.get('linked') && fileIds.length && (!UUID.test(id) || !(await store.conversationMembers(id)).length)) fail('not_found', 'Conversation not found');
    const parts = fileIds.length ? await fileParts(deps, me, fileIds) : [];
    const admission = UUID.test(id) ? await admit(id, me, text, parts, clientId) : { kind: 'not_found' as const };
    switch (admission.kind) {
      case 'not_found': {
        const there = c.get('linked') || !UUID.test(id) ? null : await relayed(c, json(await carryFiles(me, id, b)));
        return there ?? fail('not_found', 'Conversation not found');
      }
      case 'forbidden': return fail('forbidden', 'Not a member of this conversation');
      case 'archived': return fail('conflict', 'Restore this archived conversation before sending a message');
      case 'client_id_taken': return fail('conflict', 'clientId already used in another conversation');
      case 'duplicate': return c.json(ok(admission.message));
      case 'admitted': break;
    }
    const { message, conversation } = admission;
    bus.toConversation(conversation.id, { type: 'message', message });
    const admittedAt = deps.now();
    // After the response is written: latency row and agent routing.
    setImmediate(() => {
      store.recordLatency({ messageId: message.id, conversationId: conversation.id, clientSentAt, receivedAt, admittedAt }).catch(e => logError('latency', e));
      try { deps.runtime.onHumanMessage(message, conversation, seenFrom); } catch (e) { logError('runtime', e); }
      notifyChatMembers(deps, NOTIFY_OUTBOX_ROOT, conversation, message).catch(e => logError('chat_notify', e));
    });
    return c.json(ok(message));
  });
  // What one screen shows while visible (a chat id, or null once hidden or elsewhere): a shared chat's new messages don't
  // notify a person on the phone while one of their screens shows that chat.
  app.post('/api/viewing', async c => {
    const b = await jsonBody(c);
    const screen = str(b.screen, 'screen', 100);
    if (!screen) fail('invalid_input', 'screen required');
    if (b.conversationId !== null && (typeof b.conversationId !== 'string' || !UUID.test(b.conversationId))) fail('invalid_input', 'conversationId must be a chat id or null');
    const sequence = typeof b.sequence === 'number' && Number.isSafeInteger(b.sequence) && b.sequence >= 0 ? b.sequence : undefined;
    const accepted = setViewing(c.get('me'), screen, b.conversationId as string | null, deps.now(), sequence);
    if (accepted && typeof b.conversationId === 'string') await clearChatNotifications(deps, c.get('me'), b.conversationId);
    // Notifications for a chat held on another channel come from there, so it hears what this screen shows too.
    if (!c.get('linked')) void relay(deps, c.get('me'), 'POST', '/api/viewing', { 'content-type': 'application/json' }, json({ screen, conversationId: b.conversationId, sequence }))
      .then(res => res?.body?.cancel(), e => logError('viewing_relay', e));
    return c.json(ok({}));
  });
  app.post('/api/conversations/:id/stop', async c => {
    const conv = await memberConversation(c.req.param('id'), c.get('me'));
    await deps.runtime.stop(conv.id);
    return c.json(ok(null));
  });

  // ---- files ----
  const uploadFile = async (c: Context<AppEnv>) => {
    const form = await c.req.parseBody().catch(() => fail('invalid_input', 'multipart body required'));
    const file = form.file;
    if (!(file instanceof File)) fail('invalid_input', 'field `file` required');
    return c.json(ok(await saveUpload(deps, c.get('me'), file as File)));
  };
  app.post('/api/files', uploadFile);
  app.post('/api/conversations/:id/files', async c => {
    await memberConversation(c.req.param('id'), c.get('me'));
    return uploadFile(c);
  });
  app.get('/api/files/:id', async c => {
    const id = c.req.param('id');
    if (!UUID.test(id)) fail('not_found', 'File not found');
    const mode = c.req.query('download') === '1' ? 'download' : c.req.query(VIEWER_QUERY) === '1' ? 'view' : 'inline';
    return fileResponse(deps, c.get('me'), id, mode, c.req.header('range'));
  });
  const visiblePdf = async (personId: string, id: string) => {
    const f = (UUID.test(id) ? await store.visibleFile(personId, id) : null) ?? fail('not_found', 'File not found');
    if (!pdfFile(f.mime, f.name)) fail('invalid_input', `Not a PDF: ${f.mime}`);
    return f;
  };
  app.get('/api/files/:id/pdf', async c => {
    const f = await visiblePdf(c.get('me'), c.req.param('id'));
    c.header('cache-control', 'private, max-age=31536000, immutable');
    return c.json(ok(await pdfInfo(f.path)));
  });
  app.get('/api/files/:id/pdf/:page', async c => {
    const f = await visiblePdf(c.get('me'), c.req.param('id'));
    const jpeg = await pdfPage(f.path, Number(c.req.param('page')), pdfPageWidth(c.req.query('w')));
    return new Response(new Uint8Array(jpeg), { headers: { 'content-type': 'image/jpeg', 'content-length': String(jpeg.length), 'cache-control': 'private, max-age=31536000, immutable' } });
  });

  // ---- agents, goals, usage, metrics ----
  app.put('/api/tray', async c => {
    const me = c.get('me'), b = await jsonBody(c);
    if (b.tiles !== null && !isTray(b.tiles)) fail('invalid_input', `tiles must be distinct names from ${TRAY_TILES.join(', ')}, or null`);
    return c.json(ok({ tiles: await deps.store.setTray(me, b.tiles as TrayTile[] | null) ?? deps.person(me)?.trayTiles ?? null }));
  });
  app.get('/api/quiet-hours', async c => c.json(ok(await quietHoursStatus(deps, c.get('me')))));
  app.put('/api/quiet-hours', async c => {
    const body = await jsonBody(c);
    if (!validQuietHours(body)) fail('invalid_input', 'quietHours needs enabled (boolean), start and end (different HH:mm times)');
    const hours = body as unknown as import('../../shared/contract.js').QuietHours;
    await store.setQuietHours(c.get('me'), { enabled: hours.enabled, start: hours.start, end: hours.end });
    return c.json(ok(await quietHoursStatus(deps, c.get('me'))));
  });
  app.put('/api/zone', async c => {
    const { zone, device } = await jsonBody(c);
    return c.json(ok(await store.setZone(c.get('me'),
      validZone(zone) ? zone : fail('invalid_input', 'zone must be an IANA time zone such as America/Toronto'),
      validDevice(device) ? device : fail('invalid_input', `device must be one of ${DEVICES.join(', ')}`))));
  });
  /** The background art's state, sent by the app while it shows (web/sky/sky.ts report): one journal line each, so a
   *  freeze on someone's phone explains itself (Alice 2026-10-25). */
  app.post('/api/diag/sky', async c => {
    const body = await jsonBody(c), text = JSON.stringify(body);
    if (text.length > 8192) fail('invalid_input', 'sky diagnostics must be at most 8 KiB');
    console.log(JSON.stringify({ type: 'sky-diag', person: c.get('me'), at: new Date(deps.now()).toISOString(), state: body }));
    return c.json(ok(null));
  });
  /** The app replaced a stream that went silent or came back online (web/events.ts): one journal line each. */
  app.post('/api/diag/stream', async c => {
    const body = await jsonBody(c), text = JSON.stringify(body);
    if (text.length > 2048) fail('invalid_input', 'stream diagnostics must be at most 2 KiB');
    console.log(JSON.stringify({ type: 'stream-diag', person: c.get('me'), at: new Date(deps.now()).toISOString(), restart: body }));
    return c.json(ok(null));
  });
  app.get('/api/goals', async c => c.json(ok(await store.listGoals(c.get('me')))));
  app.get('/api/agents', async c => c.json(ok(await store.listAgents(c.get('me'), { includeArchived: c.req.query('includeArchived') === '1' }))));
  app.patch('/api/agents/:id', async c => {
    const agent = await store.getAgent(c.req.param('id'));
    if (!agent || agent.ownerId !== c.get('me')) fail('not_found', 'Agent not found');
    const body = await jsonBody(c);
    if (typeof body.archived !== 'boolean') fail('invalid_input', 'archived must be boolean');
    if (agent!.role === 'manager') fail('conflict', 'Your Kenaznia cannot be archived; Stop ends its current turn.');
    return c.json(ok(await deps.runtime.archiveAgent(agent!.id, body.archived as boolean)));
  });
  // Blank chats (server/agents/blank.ts): a model of her choice with no context; closing one is PATCH /api/agents/:id.
  const blankCall = async <T>(run: () => Promise<T>): Promise<T> => {
    try { return await run(); } catch (e) {
      if (e instanceof ClaudeNotEnabledForPerson) fail('forbidden', e.message);
      if (e instanceof BlankRefused) fail(e.code === 'model_unavailable' ? 'invalid_input' : 'unavailable', e.message);
      throw e;
    }
  };
  app.get('/api/blank-chats/models', async c => c.json(ok(await blankCall(() => blankModels(deps, deps.person(c.get('me'))!)))));
  app.post('/api/blank-chats', async c => {
    const b = await jsonBody(c);
    return c.json(ok(await blankCall(() => startBlankChat(deps, deps.person(c.get('me'))!, str(b.model, 'model', 100), str(b.thinking, 'thinking', 20)))));
  });
  app.get('/api/usage', async c => c.json(ok(await usageReport(deps, c.get('me')))));
  app.get('/api/usage/gpus', async c => c.json(ok(await gpuUsageReport(deps, c.get('me')))));
  app.get('/api/metrics', async c => c.json(ok(await store.latencyReport(LATENCY_WINDOW_MS))));
  app.post('/api/metrics/first-text', async c => {
    const b = await jsonBody(c);
    const messageId = str(b.messageId, 'messageId', 64), at = finite(b.firstTextAt) ?? fail('invalid_input', 'firstTextAt must be a number');
    if (UUID.test(messageId)) await store.markLatency(messageId, 'first_text_at', at);
    return c.json(ok(null));
  });

  // ---- SSE ----
  /** A compressed event stream; every event is flushed as it is written. */
  function eventStream(c: Context, run: (out: { send(e: StreamEvent): void; end(): void; closed: Promise<void> }) => void): Response {
    const encoding = chooseEncoding(c.req.header('accept-encoding'));
    let close!: () => void;
    const closed = new Promise<void>(resolve => { close = resolve; });
    const out = streamEncoder(encoding, () => close());
    c.req.raw.signal.addEventListener('abort', () => close(), { once: true });
    void closed.then(() => out.end());
    // A restart (every Beta deploy) ends the stream; the channel's socket is held by systemd meanwhile, so a quick retry
    // just waits for the new process instead of the browser's default 3 s.
    out.write(`retry: ${SSE_RETRY_MS}\n\n`);
    run({
      send: e => out.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\nid: ${++eventId}\n\n`),
      end: () => close(),
      closed,
    });
    return new Response(out.readable, { headers: {
      'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'x-accel-buffering': 'no', vary: 'Accept-Encoding',
      ...(encoding === 'identity' ? {} : { 'content-encoding': encoding }),
    } });
  }
  /** The first screen: bootstrap plus the newest page of the conversation the app opens on. */
  async function startupPage(me: string, boot: Bootstrap, requested: string | undefined, limit: number, after: number | undefined): Promise<StartupPage | null> {
    const home = boot.manager.kind === 'here' ? boot.manager.conversationId : boot.conversations[0]?.id ?? null;
    const local = requested && UUID.test(requested) ? await store.getConversation(requested, me) : null;
    const wanted = local ?? (requested && UUID.test(requested) ? boot.conversations.find(c => c.id === requested) ?? await remoteRoom(deps, me, requested) : null);
    const conversationId = wanted && wanted.memberIds.includes(me) ? wanted.id : home;
    if (!conversationId) return null;
    const resumeAfter = conversationId === requested ? after : undefined;
    if (wanted && !boot.conversations.some(c => c.id === wanted.id)) boot.conversations.push(wanted);
    if (wanted && !local && wanted.id === conversationId) {
      const answer = await relay(deps, me, 'GET', `/api/conversations/${conversationId}/messages?limit=${limit}${resumeAfter === undefined ? '' : `&after=${resumeAfter}`}`, {}, null);
      const page = answer ? await answer.json() as Result<StartupPage['page']> : null;
      if (page?.ok) return { conversationId, page: page.value };
      logError('startup_remote_page', page ? JSON.stringify(page.error) : 'no other channel');
      return home ? { conversationId: home, page: await store.listMessages(home, { kind: 'latest' }, limit).then(p => ({ ...p, messages: p.messages.map(clipMessage) })) } : null;
    }
    const page = await store.listMessages(conversationId, resumeAfter === undefined ? { kind: 'latest' } : { kind: 'after', seq: resumeAfter }, limit);
    return { conversationId, page: { ...page, messages: page.messages.map(clipMessage) } };
  }
  // One stream per client. Its first event is the startup snapshot, taken after subscribing, and events
  // that arrive meanwhile follow it, so nothing between the snapshot and the live stream is lost.
  app.get('/api/events', c => {
    const me = c.get('me');
    const limit = Math.min(Math.max(queryInt(c.req.query('limit')) ?? 50, 1), 200);
    const after = queryInt(c.req.query('after'));
    if (after !== undefined && after < 0) fail('invalid_input', 'after must be non-negative');
    return eventStream(c, out => {
      type Live = Exclude<ServerEvent, { type: 'notification' | 'phone' | 'phone_settings' }>;
      const held: Live[] = [];
      const wire = (e: Live): StreamEvent => e.type === 'message' ? { ...e, message: clipMessage(e.message) } : e;
      let live = (e: Live) => { held.push(e); };
      const unsubscribe = bus.subscribe(me, e => { if (e.type !== 'notification' && e.type !== 'phone' && e.type !== 'phone_settings') live(e); });
      const beat = setInterval(() => out.send({ type: 'heartbeat', at: deps.now() }), SSE_HEARTBEAT_MS);
      void out.closed.then(() => { clearInterval(beat); unsubscribe(); });
      void (async () => {
        const bootstrapValue = await bootstrap(me);
        const page = await startupPage(me, bootstrapValue, c.req.query('open'), limit, after);
        out.send({ type: 'ready', bootstrap: bootstrapValue, page });
        for (const e of held) out.send(wire(e));
        live = e => out.send(wire(e));
      })().catch(e => {
        if (errorCode(e) === 'unauthenticated') out.send({ type: 'unauthenticated' });
        else logError('events', e);
        out.end();
      });
    });
  });
  // The phone's notification stream. after = the last id the phone holds; the last day after it replays (the phone shows stale ones silently).
  // phone=1: the app's accessibility service is on, so phone-control commands come down this stream too.
  app.get('/api/notifications', async c => {
    const me = c.get('me'), after = queryInt(c.req.query('after')), phoneControl = c.req.query('phone') === '1', phoneSettings = c.req.query('settings') === '1', dismissals = c.req.query('dismissals') === '1';
    const phoneZone = c.req.query('zone');
    if (phoneZone !== undefined) {
      if (!validZone(phoneZone)) fail('invalid_input', 'zone must be an IANA time zone');
      await store.setZone(me, phoneZone, 'phone');
    }
    // New native clients tolerate longer silence; old phones retain their 45-second read timeout.
    const heartbeatSeconds = queryInt(c.req.query('heartbeatSeconds'));
    if (heartbeatSeconds !== undefined && heartbeatSeconds !== 180) fail('invalid_input', 'heartbeatSeconds must be 180 or omitted');
    const heartbeatMs = heartbeatSeconds === 180 ? 180_000 : SSE_HEARTBEAT_MS;
    c.header('x-accel-buffering', 'no');
    return streamSSE(c, async stream => {
      let sent = after ?? 0;
      let sending = Promise.resolve();
      const send = (e: ServerEvent) => { sending = sending.then(async () => {
        if (e.type === 'notification') {
          const quietHours = await quietHoursStatus(deps, me);
          if (e.notification.quietHeld || (e.notification.level !== 'urgent' && quietHours.active)) {
            await store.holdNotification(me, e.notification.id);
            return;
          }
          e = { ...e, notification: { ...e.notification, quietHours } };
        }
        if (e.type === 'notification') { if (e.notification.id <= sent) return; sent = e.notification.id; }
        void stream.writeSSE({ event: e.type, data: JSON.stringify(e), id: e.type === 'notification' ? String(e.notification.id) : undefined }).catch(() => {});
      }).catch(e => logError('notification_stream', e)); };
      const held: ServerEvent[] = [];
      let live: (e: ServerEvent) => void = e => { held.push(e); };
      const unsubscribe = bus.subscribe(me, e => { if (e.type === 'notification' || (dismissals && e.type === 'notifications_cleared') || (phoneControl && e.type === 'phone') || (phoneSettings && e.type === 'phone_settings')) live(e); });
      const release = openStream(me, phoneControl, phoneSettings);
      const beat = setInterval(() => send({ type: 'heartbeat', at: deps.now() }), heartbeatMs);
      const closed = new Promise<void>(resolve => stream.onAbort(() => { clearInterval(beat); unsubscribe(); release(); resolve(); }));
      if (dismissals) for (const cleared of await store.dismissedNotifications(me)) send({ type: 'notifications_cleared', ...cleared });
      for (const notification of await store.notificationsAfter(me, after ?? 0, deps.now() - 24 * 3600_000, 50)) send({ type: 'notification', notification });
      held.forEach(send); live = send;
      send({ type: 'heartbeat', at: deps.now() });
      await closed;
    });
  });

  // ---- Web Push (installed web apps, e.g. an iPhone home-screen app) ----
  const pushSender = () => deps.webPush.kind === 'ready' ? deps.webPush : fail('unavailable', `web_push_unavailable: ${deps.webPush.reason}`);
  app.get('/api/push', c => c.json(ok({ publicKey: pushSender().publicKey })));
  app.post('/api/push/subscriptions', async c => {
    const sender = pushSender(), me = c.get('me'), body = await jsonBody(c);
    if (typeof body.confirm !== 'boolean') fail('invalid_input', 'confirm must be a boolean');
    const parsed = parseSubscription(body.subscription);
    if (!parsed.ok) fail('invalid_input', parsed.error);
    const subscription = (parsed as { value: WebPushSubscription }).value;
    // The endpoint this device registered before (absent from shells cached before the field existed: nothing replaced);
    // a new subscription on the same device makes the old one a duplicate.
    const replaces = body.replaces === undefined || body.replaces === null ? null : str(body.replaces, 'replaces', 2048);
    await store.savePushSubscription(me, subscription);
    if (replaces !== null && replaces !== subscription.endpoint) await store.deletePushSubscription(replaces, me);
    if (!body.confirm) return c.json(ok({ test: null }));
    if ((await quietHoursStatus(deps, me)).active) return c.json(ok({ test: null, held: true, quietHours: await quietHoursStatus(deps, me) }));
    const outcome = await sender.send(subscription, pushPayload({ id: null, title: 'Kenan notifications are on', body: 'Notifications from your agents will appear on this device.', level: 'normal', conversationId: null }), pushOptions('normal'));
    if (outcome.kind === 'gone') await store.deletePushSubscription(subscription.endpoint, me);
    const test: WebPushTest = outcome.kind === 'delivered' ? { kind: 'delivered' } : outcome;
    return c.json(ok({ test }));
  });
  app.delete('/api/push/subscriptions', async c => {
    await store.deletePushSubscription(str((await jsonBody(c)).endpoint, 'endpoint', 2048), c.get('me'));
    return c.json(ok(null));
  });

  // ---- extensions: /api/ext/<id>/..., behind the same auth middleware ----
  for (const ext of deps.extensions) {
    if (!ext.routes) continue;
    const sub = new Hono();
    ext.routes(sub, deps);
    app.route(`/api/ext/${ext.id}`, sub);
  }

  app.all('/api/*', () => fail('not_found', 'No such endpoint'));

  // A saved home-screen app keeps its old origin after an account moves. Redirect
  // document requests only, after checking the session; APIs and other accounts stay here.
  app.use('*', async (c, next) => {
    // The service worker's background shell fetch is not a navigation: keep
    // serving the local shell so a cached installation can still update.
    if ((c.req.method === 'GET' || c.req.method === 'HEAD') &&
      (c.req.header('sec-fetch-dest') === 'document' || c.req.header('accept')?.includes('text/html'))) {
      const session = await auth.authenticate(getCookie(c, SESSION_COOKIE));
      const origin = session && deps.person(session.personId)?.clientHome;
      if (origin) {
        c.header('Cache-Control', 'no-store');
        c.header('Referrer-Policy', 'no-referrer');
        return c.redirect(origin + '/', 302);
      }
    }
    return next();
  });

  // ---- static web app with SPA fallback ----
  const cacheHeaders = (path: string, c: Context) => {
    c.header('cache-control', /\/assets\//.test(path) ? 'public, max-age=31536000, immutable' : 'no-cache');
  };
  app.use('*', serveStatic({ root: config.webRoot, precompressed: true, onFound: cacheHeaders }));
  // A hashed asset that doesn't exist is a 404, never the app page: the service worker keeps assets forever.
  app.get('/assets/*', c => c.text('No such asset', 404));
  app.get('*', serveStatic({ root: config.webRoot, path: 'index.html', onFound: cacheHeaders }));
  return app;
}
