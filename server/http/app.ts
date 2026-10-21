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
  errorStatus, SSE_HEARTBEAT_MS, type Bootstrap, type GoalSummary, type StreamEvent, type StartupPage, type ConversationSummary, type Message, type MessagePart, type Person, type Result, type ServerEvent, type ManagerHome, type WebPushSubscription, type WebPushTest,
  LAYOUTS,
} from '../../shared/contract.js';
import type { Admission, Deps, MessageCursor } from '../types.js';
import { createAuth, csrfAllowed, SESSION_COOKIE, type SessionStore } from '../auth/auth.js';
import { errorCode, fail } from '../db/errors.js';
import { fileParts, fileResponse, saveUpload } from '../files/files.js';
import { usageReport } from '../metrics/usage.js';
import { clipMessage } from './clip.js';
import { openStream } from '../notifications.js';
import { parseSubscription, pushOptions, pushPayload } from '../web-push.js';

export type AppEnv = { Variables: { receivedAt: number; me: string } };
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

export function createApp(deps: Deps): Hono<AppEnv> {
  const { config, store, bus } = deps;
  if (typeof (store as Partial<SessionStore>).createSession !== 'function') throw new Error('createApp needs the pg store (session methods)');
  const auth = createAuth({ config, sessions: store as unknown as SessionStore, now: deps.now });
  const app = new Hono<AppEnv>();
  let eventId = 0;
  const logError = (scope: string, e: unknown) => {
    console.error(JSON.stringify({ type: 'error', scope, error: String((e as Error)?.stack ?? e) }));
    void store.logError(scope, String((e as Error)?.stack ?? e)).catch(() => {});
  };

  // First middleware: the receive stamp for latency.
  app.use('*', async (c, next) => { c.set('receivedAt', deps.now()); await next(); });

  app.onError((e, c) => {
    const code = errorCode(e);
    if (code === 'internal') logError('http', e);
    return c.json({ ok: false, error: { code, message: e.message } } satisfies Result<never>, errorStatus[code] as ContentfulStatusCode);
  });

  androidRoutes(app, config.channel);

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
    if (!csrfAllowed(c.req.method, c.req.header('origin'), c.req.header('x-kenan-client'), config.origins)) fail('forbidden', 'Origin not allowed');
    const path = c.req.path;
    if ((path === '/api/accounts' && c.req.method === 'GET') || (path === '/api/login' && c.req.method === 'POST')) return next();
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
  async function bootstrap(me: string, includeArchived = false): Promise<Bootstrap> {
    const [person, people, agents, conversations, goals, layout] = await Promise.all([
      store.getPerson(me), store.listPeople(), store.listAgents(me, { includeArchived: true }), store.listConversations(me, { includeArchived }), store.listGoals(me), store.layoutOf(me),
    ]);
    if (!person) fail('unauthenticated', 'Unknown person');
    const agentById = new Map(agents.map(agent => [agent.id, agent]));
    const selected = new Set(agents.filter(a => includeArchived || !a.archived).map(a => a.id));
    for (const agent of agents) { let parent = agent.parentAgentId; const visited = new Set<string>(); while (selected.has(agent.id) && parent && !visited.has(parent)) { visited.add(parent); selected.add(parent); parent = agentById.get(parent)?.parentAgentId ?? null; } }
    const shownAgents = agents.filter(a => selected.has(a.id));
    const shownGoals = new Set(shownAgents.flatMap(a => a.goalId ? [a.goalId] : []));
    const visible = new Set([...shownAgents.map(a => a.id), ...conversations.flatMap(c => c.memberIds)]);
    const placement = deps.person(me)?.manager ?? null;
    const managerId = deps.runtime.managerFor(me);
    const manager = managerId ? agents.find(a => a.id === managerId) ?? await store.getAgent(managerId) : null;
    const home: ManagerHome = placement && 'elsewhere' in placement ? { kind: 'elsewhere', url: placement.elsewhere }
      : manager ? { kind: 'here', conversationId: manager.conversationId } : { kind: 'none' };
    const enabled = deps.person(me)?.extensions ?? [];
    return {
      me: person!, people: people.filter(p => p.kind === 'human' || visible.has(p.id)), agents: shownAgents,
      goals: goals.filter(g => shownGoals.has(g.id)).map((g): GoalSummary => ({ id: g.id, title: g.title, status: g.status })), conversations,
      activity: Object.fromEntries(conversations.flatMap(c => { const now = bus.activity(c.id); return now ? [[c.id, now]] : []; })),
      manager: home, layout,
      extensions: deps.extensions.filter(e => enabled.includes(e.id)).map(e => ({ id: e.id, name: e.name })),
      serverTime: deps.now(), channel: config.channel,
    };
  }

  // ---- auth ----
  app.get('/api/accounts', c => c.json(ok(config.people.map((p): Person => ({ id: p.id, name: p.name, kind: 'human' })))));
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

  // ---- conversations ----
  app.get('/api/conversations/:id/messages', async c => {
    const conv = await memberConversation(c.req.param('id'), c.get('me'));
    const limit = Math.min(Math.max(queryInt(c.req.query('limit')) ?? 50, 1), 200);
    const before = queryInt(c.req.query('before')), after = queryInt(c.req.query('after'));
    const cursor: MessageCursor = before !== undefined && after !== undefined ? fail('invalid_input', 'Use before or after, not both')
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
  app.post('/api/conversations', async c => {
    const me = c.get('me'), b = await jsonBody(c);
    const conv = await store.createConversation({ title: str(b.title, 'title', 200), ownerId: me, memberIds: [me, ...strs(b.memberIds ?? [], 'memberIds')] });
    broadcastConversation(conv.id, conv.memberIds);
    return c.json(ok(conv));
  });
  app.patch('/api/conversations/:id', async c => {
    const me = c.get('me'), b = await jsonBody(c);
    const before = await memberConversation(c.req.param('id'), me);
    const patch = {
      title: b.title === undefined ? undefined : str(b.title, 'title', 200),
      titleLocked: b.titleLocked === undefined ? b.title === undefined ? undefined : true : typeof b.titleLocked === 'boolean' ? b.titleLocked : fail('invalid_input', 'titleLocked must be boolean'),
      emoji: b.emoji === undefined || b.emoji === null ? b.emoji as null | undefined : str(b.emoji, 'emoji', 16),
      pinnedAt: b.pinned === undefined ? undefined : typeof b.pinned === 'boolean' ? b.pinned ? deps.now() : null : fail('invalid_input', 'pinned must be boolean'),
      keyDate: b.keyDate === undefined || b.keyDate === null ? b.keyDate as null | undefined : /^\d{4}-\d{2}-\d{2}$/.test(String(b.keyDate)) ? String(b.keyDate) : fail('invalid_input', 'keyDate must be YYYY-MM-DD'),
      keyLabel: b.keyLabel === undefined || b.keyLabel === null ? b.keyLabel as null | undefined : str(b.keyLabel, 'keyLabel', 40),
      project: b.project === undefined ? undefined : typeof b.project === 'boolean' ? b.project : fail('invalid_input', 'project must be boolean'),
      statusLine: b.statusLine === undefined || b.statusLine === null ? b.statusLine as null | undefined : str(b.statusLine, 'statusLine', 500),
      projectId: b.projectId === undefined || b.projectId === null ? b.projectId as null | undefined : (await memberConversation(str(b.projectId, 'projectId', 64), me)).id,
      archived: b.archived === undefined ? undefined : typeof b.archived === 'boolean' ? b.archived : fail('invalid_input', 'archived must be boolean'),
      color: b.color === undefined || b.color === null ? b.color as null | undefined : str(b.color, 'color', 64),
      readThrough: b.readThrough === undefined ? undefined : finite(b.readThrough) ?? fail('invalid_input', 'readThrough must be a number'),
      addMemberIds: optStrs(b.addMemberIds, 'addMemberIds'), removeMemberIds: optStrs(b.removeMemberIds, 'removeMemberIds'),
    };
    if (before.agentId && patch.archived !== undefined) {
      if ((await store.getAgent(before.agentId))?.role === 'manager') fail('conflict', 'This is your Kenaznia\'s conversation; it stays open. Stop ends its current turn.');
      await deps.runtime.archiveAgent(before.agentId, patch.archived);
    }
    const conv = await store.updateConversation(before.id, me, patch);
    const membersChanged = !!(patch.addMemberIds?.length || patch.removeMemberIds?.length);
    if (membersChanged) bus.invalidateMembers(conv.id);
    const shared = membersChanged || patch.title !== undefined || patch.titleLocked !== undefined || patch.archived !== undefined || patch.color !== undefined || patch.emoji !== undefined || patch.pinnedAt !== undefined || patch.keyDate !== undefined || patch.keyLabel !== undefined || patch.project !== undefined || patch.statusLine !== undefined || patch.projectId !== undefined;
    // readThrough alone only matters to my other clients.
    broadcastConversation(conv.id, shared ? [...before.memberIds, ...conv.memberIds] : [me]);
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
    if (!clientId) fail('invalid_input', 'clientId required');
    if (!text.trim() && !fileIds.length) fail('invalid_input', 'Message is empty');
    const parts = fileIds.length ? await fileParts(deps, me, fileIds) : [];
    const admission = UUID.test(id) ? await admit(id, me, text, parts, clientId) : { kind: 'not_found' as const };
    switch (admission.kind) {
      case 'not_found': return fail('not_found', 'Conversation not found');
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
      try { deps.runtime.onHumanMessage(message, conversation); } catch (e) { logError('runtime', e); }
    });
    return c.json(ok(message));
  });
  app.post('/api/conversations/:id/stop', async c => {
    const conv = await memberConversation(c.req.param('id'), c.get('me'));
    await deps.runtime.stop(conv.id);
    return c.json(ok(null));
  });

  // ---- files ----
  app.post('/api/files', async c => {
    const form = await c.req.parseBody().catch(() => fail('invalid_input', 'multipart body required'));
    const file = form.file;
    if (!(file instanceof File)) fail('invalid_input', 'field `file` required');
    return c.json(ok(await saveUpload(deps, c.get('me'), file as File)));
  });
  app.get('/api/files/:id', async c => {
    const id = c.req.param('id');
    if (!UUID.test(id)) fail('not_found', 'File not found');
    return fileResponse(deps, c.get('me'), id, c.req.query('download') === '1');
  });

  // ---- agents, goals, usage, metrics ----
  app.put('/api/layout', async c => {
    const me = c.get('me'), b = await jsonBody(c);
    const layout = await store.setLayout(me, LAYOUTS.find(l => l === b.layout) ?? fail('invalid_input', `layout must be one of ${LAYOUTS.join(', ')}`));
    bus.toPerson(me, { type: 'layout', layout });
    return c.json(ok(layout));
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
  app.get('/api/usage', async c => c.json(ok(await usageReport(deps, c.get('me')))));
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
  async function startupPage(me: string, boot: Bootstrap, requested: string | undefined, limit: number): Promise<StartupPage | null> {
    const home = boot.manager.kind === 'here' ? boot.manager.conversationId : boot.conversations[0]?.id ?? null;
    const wanted = requested && UUID.test(requested) ? await store.getConversation(requested, me) : null;
    const conversationId = wanted && wanted.memberIds.includes(me) ? wanted.id : home;
    if (!conversationId) return null;
    if (wanted && !boot.conversations.some(c => c.id === wanted.id)) boot.conversations.push(wanted);
    const page = await store.listMessages(conversationId, { kind: 'latest' }, limit);
    return { conversationId, page: { ...page, messages: page.messages.map(clipMessage) } };
  }
  // One stream per client. Its first event is the startup snapshot, taken after subscribing, and events
  // that arrive meanwhile follow it, so nothing between the snapshot and the live stream is lost.
  app.get('/api/events', c => {
    const me = c.get('me');
    const limit = Math.min(Math.max(queryInt(c.req.query('limit')) ?? 50, 1), 200);
    return eventStream(c, out => {
      type Live = Exclude<ServerEvent, { type: 'notification' }>;
      const held: Live[] = [];
      const wire = (e: Live): StreamEvent => e.type === 'message' ? { ...e, message: clipMessage(e.message) } : e;
      let live = (e: Live) => { held.push(e); };
      const unsubscribe = bus.subscribe(me, e => { if (e.type !== 'notification') live(e); });
      const beat = setInterval(() => out.send({ type: 'heartbeat', at: deps.now() }), SSE_HEARTBEAT_MS);
      void out.closed.then(() => { clearInterval(beat); unsubscribe(); });
      void (async () => {
        const bootstrapValue = await bootstrap(me);
        const page = await startupPage(me, bootstrapValue, c.req.query('open'), limit);
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
  app.get('/api/notifications', c => {
    const me = c.get('me'), after = queryInt(c.req.query('after'));
    c.header('x-accel-buffering', 'no');
    return streamSSE(c, async stream => {
      let sent = after ?? 0;
      const send = (e: ServerEvent) => {
        if (e.type === 'notification') { if (e.notification.id <= sent) return; sent = e.notification.id; }
        void stream.writeSSE({ event: e.type, data: JSON.stringify(e), id: e.type === 'notification' ? String(e.notification.id) : undefined }).catch(() => {});
      };
      const held: ServerEvent[] = [];
      let live: (e: ServerEvent) => void = e => { held.push(e); };
      const unsubscribe = bus.subscribe(me, e => { if (e.type === 'notification') live(e); });
      const release = openStream(me);
      const beat = setInterval(() => send({ type: 'heartbeat', at: deps.now() }), SSE_HEARTBEAT_MS);
      const closed = new Promise<void>(resolve => stream.onAbort(() => { clearInterval(beat); unsubscribe(); release(); resolve(); }));
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
    await store.savePushSubscription(me, subscription);
    if (!body.confirm) return c.json(ok({ test: null }));
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
