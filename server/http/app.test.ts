import { createDecipheriv, createECDH, createPublicKey, hkdfSync, randomBytes, verify } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brotliDecompressSync, createBrotliDecompress } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Bootstrap, ConversationSummary, FileInfo, Message, MessagePage, MessagePart, Result, StreamEvent } from '../../shared/contract.js';
import type { Deps } from '../types.js';
import type { PgStore } from '../db/store.js';
import { testDatabaseUrl } from '../db/test-db.js';
import { createApp } from './app.js';
import { createContentCadenceExtension, CONTENT_PUBLIC_PATH } from '../extensions/content-cadence.js';
import { notify } from '../notifications.js';
import { loadVapidKeys } from '../web-push.js';
import { ORIGIN, SECRET, startTestApp, value, type TestApp } from './test-app.js';

/** A browser's push subscription: decrypts what it receives as RFC 8291 says. */
function pushDevice(endpoint: string) {
  const ecdh = createECDH('prime256v1'); ecdh.generateKeys();
  const auth = randomBytes(16);
  const subscription = { endpoint, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } };
  const decrypt = (body: Buffer) => {
    const salt = body.subarray(0, 16), idlen = body[20]!, asPublic = body.subarray(21, 21 + idlen), sealed = body.subarray(21 + idlen);
    const ikm = Buffer.from(hkdfSync('sha256', ecdh.computeSecret(asPublic), auth, Buffer.concat([Buffer.from('WebPush: info\0'), ecdh.getPublicKey(), asPublic]), 32));
    const decipher = createDecipheriv('aes-128-gcm', Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16)), Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12)));
    decipher.setAuthTag(sealed.subarray(sealed.length - 16));
    const plain = Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - 16)), decipher.final()]);
    expect(plain[plain.length - 1]).toBe(2);
    return JSON.parse(plain.subarray(0, -1).toString());
  };
  return { subscription, decrypt };
}
/** Checks a VAPID Authorization header against the server's public key; returns its claims. */
function vapidClaims(header: string, publicKey: string) {
  const [, token, key] = /^vapid t=([^,]+), k=(.+)$/.exec(header)!;
  expect(key).toBe(publicKey);
  const [head, claims, signature] = token!.split('.');
  const point = Buffer.from(publicKey, 'base64url');
  const jwk = { kty: 'EC', crv: 'P-256', x: point.subarray(1, 33).toString('base64url'), y: point.subarray(33).toString('base64url') };
  expect(verify('sha256', Buffer.from(`${head}.${claims}`), { key: createPublicKey({ key: jwk, format: 'jwk' }), dsaEncoding: 'ieee-p1363' }, Buffer.from(signature!, 'base64url'))).toBe(true);
  return JSON.parse(Buffer.from(claims!, 'base64url').toString());
}

describe.skipIf(!testDatabaseUrl)('http app', () => {
  let fx: TestApp, store: PgStore, app: TestApp['app'], deps: Deps, push: TestApp['push'], call: TestApp['call'];
  let dir = '', managerConversationId = '';
  let humanMessages: TestApp['humanMessages'] = [], stopped: string[] = [];

  beforeAll(async () => {
    fx = await startTestApp('t_app');
    ({ store, app, deps, push, humanMessages, stopped, dir, managerConversationId } = fx);
    call = fx.call.bind(fx);
  });
  afterAll(async () => { await fx?.close(); });

  it('rejects unauthenticated and cross-origin requests', async () => {
    expect((await call('GET', '/api/bootstrap', undefined, { cookie: '' })).status).toBe(401);
    expect((await call('POST', '/api/login', { accountId: 'alice', secret: SECRET }, { origin: 'https://evil.test' })).status).toBe(403);
    expect((await call('POST', '/api/login', { accountId: 'alice', secret: 'wrong secret, still long enough' })).json).toMatchObject({ ok: false, error: { code: 'unauthenticated' } });
    expect((await call('POST', '/api/login', { accountId: '../alice', secret: SECRET })).status).toBe(401);
    expect(value(await call<{ id: string }[]>('GET', '/api/accounts')).map(p => p.id)).toEqual(['alice', 'robin']);
  });

  it('login → bootstrap → send → SSE receives the message; runtime notified; idempotent resend', async () => {
    const login = await call<Bootstrap>('POST', '/api/login', { accountId: 'alice', secret: SECRET }, { origin: '', 'x-kenan-client': 'native' });
    const setCookie = login.res.headers.get('set-cookie')!;
    for (const attr of ['Max-Age=2592000', 'Path=/', 'HttpOnly', 'Secure', 'SameSite=Lax']) expect(setCookie.split('; ')).toContain(attr);
    expect(setCookie).toMatch(/^kenan_session=[\w-]+\.[\w-]{43};/);
    fx.cookie = setCookie.split(';')[0]!;
    expect(value(login).me).toEqual({ id: 'alice', name: 'Alice', kind: 'human' });

    const boot = value(await call<Bootstrap>('GET', '/api/bootstrap'));
    expect(boot).toMatchObject({ manager: { kind: 'here', conversationId: managerConversationId }, channel: 'beta', extensions: [{ id: 'demo', name: 'Demo' }] });
    expect(boot.agents.map(a => a.id)).toEqual(['kenaznia-alice']);
    expect(boot.people.map(p => p.id).sort()).toEqual(['alice', 'kenaznia-alice', 'robin']);
    expect(boot.conversations.map(c => c.id)).toEqual([managerConversationId]);

    const events = await app.request('/api/events', { headers: { cookie: fx.cookie } });
    expect(events.headers.get('content-type')).toBe('text/event-stream');
    const reader = events.body!.getReader();
    let buffer = '';
    const until = async (needle: string) => {
      while (!buffer.includes(needle)) {
        const { value: chunk, done } = await reader.read();
        if (done) throw new Error('stream ended');
        buffer += new TextDecoder().decode(chunk);
      }
    };
    await until('event: ready');
    await until('\n\n');
    const ready = JSON.parse(buffer.split('\n')[1]!.slice(6)) as Extract<StreamEvent, { type: 'ready' }>;
    expect(ready).toMatchObject({ type: 'ready', bootstrap: { manager: { kind: 'here', conversationId: managerConversationId } }, page: { conversationId: managerConversationId, page: { messages: [], hasOlder: false, hasNewer: false } } });

    const sent = value(await call<Message>('POST', `/api/conversations/${managerConversationId}/messages`, { clientId: 'client-1', text: 'Hello Kenaznia', fileIds: [], clientSentAt: Date.now() - 5 }));
    expect(sent).toMatchObject({ conversationId: managerConversationId, seq: 1, authorId: 'alice', role: 'human', text: 'Hello Kenaznia', clientId: 'client-1' });
    await until('client-1');
    const block = buffer.split('\n\n').find(b => b.includes('client-1'))!;
    expect(block).toMatch(/^event: message\ndata: /);
    expect(JSON.parse(block.split('\n')[1]!.slice(6))).toEqual({ type: 'message', message: sent });
    await reader.cancel();

    await new Promise(r => setTimeout(r, 20));
    expect(humanMessages.map(h => [h.message.id, h.conversation.id, h.conversation.lastSeq])).toEqual([[sent.id, managerConversationId, 1]]);
    const again = value(await call<Message>('POST', `/api/conversations/${managerConversationId}/messages`, { clientId: 'client-1', text: 'Hello Kenaznia', fileIds: [], clientSentAt: Date.now() }));
    expect(again.id).toBe(sent.id);
    expect(humanMessages).toHaveLength(1);
    const page = value(await call<MessagePage>('GET', `/api/conversations/${managerConversationId}/messages?limit=10`));
    expect(page).toEqual({ messages: [sent], hasOlder: false, hasNewer: false });
    const output = 'line\n'.repeat(200_000);
    const tool = await store.appendMessage({ conversationId: managerConversationId, authorId: 'alice', role: 'tool', display: 'shown', text: 'bash', parts: [{ type: 'tool', callId: 'c', name: 'bash', args: { command: 'yes line' }, result: JSON.stringify({ content: [{ type: 'text', text: output }] }), isError: false }] });
    const clipped = value(await call<MessagePage>('GET', `/api/conversations/${managerConversationId}/messages?after=1`)).messages[0]!;
    const part = clipped.parts[0] as Extract<MessagePart, { type: 'tool' }>;
    expect([clipped.clipped, part.result!.length < 5_000, JSON.parse(part.result!).content[0].text.startsWith('line\nline')]).toEqual([true, true, true]);
    expect(value(await call<Message>('GET', `/api/conversations/${managerConversationId}/messages/${tool.id}`))).toEqual(tool);
    const list = Array.from({ length: 12 }, (_, i) => `${i + 1}. ${'word '.repeat(80)}`).join('\n');
    const prose = await store.appendMessage({ conversationId: managerConversationId, authorId: 'kenaznia-alice', role: 'assistant', display: 'shown', text: list, parts: [{ type: 'thinking', text: list }] });
    expect(value(await call<MessagePage>('GET', `/api/conversations/${managerConversationId}/messages?after=2`)).messages).toEqual([prose]);
    expect((await call('GET', `/api/conversations/${managerConversationId}/messages?before=2&after=1`)).status).toBe(400);
    const metrics = value(await call<{ count: number }>('GET', '/api/metrics'));
    expect(metrics.count).toBe(1);
  });

  it('compresses JSON and the event stream for clients that accept it; an unauthenticated stream says so', async () => {
    const plain = await call<Bootstrap>('GET', '/api/bootstrap');
    const br = await app.request('/api/bootstrap', { headers: { cookie: fx.cookie, 'accept-encoding': 'gzip, deflate, br' } });
    expect([br.headers.get('content-encoding'), br.headers.get('vary')]).toEqual(['br', 'Accept-Encoding']);
    const decoded = JSON.parse(brotliDecompressSync(Buffer.from(await br.arrayBuffer())).toString()) as Result<Bootstrap>;
    const timeless = (r: Result<Bootstrap>) => r.ok ? { ...r.value, serverTime: 0 } : r;
    expect(timeless(decoded)).toEqual(timeless(plain.json));

    const stream = await app.request(`/api/events?open=${managerConversationId}`, { headers: { cookie: fx.cookie, 'accept-encoding': 'br' } });
    expect([stream.headers.get('content-type'), stream.headers.get('content-encoding')]).toEqual(['text/event-stream', 'br']);
    const decoder = createBrotliDecompress(), reader = stream.body!.getReader();
    let text = '';
    decoder.on('data', (chunk: Buffer) => { text += chunk.toString(); });
    // Each event is flushed whole: the first one decodes before the stream has anything else to say.
    while (!text.includes('\n\n')) {
      const { value: chunk } = await reader.read();
      await new Promise(r => decoder.write(chunk!, r));
      for (let i = 0; i < 5 && !text.includes('\n\n'); i++) await new Promise(r => setTimeout(r, 5));
    }
    expect(text).toMatch(/^event: ready\ndata: \{"type":"ready"/);
    await reader.cancel(); decoder.destroy();

    const anonymous = await app.request('/api/events');
    expect([anonymous.status, anonymous.headers.get('content-type'), await anonymous.text()]).toEqual([200, 'text/event-stream', expect.stringMatching(/^event: unauthenticated\ndata: \{"type":"unauthenticated"\}/)]);
  });

  it('rooms, membership, stop, files, extensions, static fallback, logout', async () => {
    const room = value(await call<ConversationSummary>('POST', '/api/conversations', { title: 'Room', memberIds: ['kenaznia-alice'] }));
    expect(room.memberIds).toEqual(['alice', 'kenaznia-alice']);
    const patched = value(await call<ConversationSummary>('PATCH', `/api/conversations/${room.id}`, { title: 'Ops', addMemberIds: ['robin'], readThrough: 0, color: null }));
    expect(patched).toMatchObject({ title: 'Ops', memberIds: ['alice', 'kenaznia-alice', 'robin'], color: null });
    expect((await call('POST', `/api/conversations/${room.id}/stop`, {})).status).toBe(200);
    expect(stopped).toEqual([room.id]);
    expect((await call('PATCH', `/api/conversations/${room.id}`, { removeMemberIds: ['alice'] })).status).toBe(200);
    expect((await call('POST', `/api/conversations/${room.id}/messages`, { clientId: 'c-x', text: 'hi', fileIds: [], clientSentAt: 1 })).status).toBe(403);
    expect((await call('GET', '/api/conversations/not-a-uuid/messages')).status).toBe(404);

    const form = new FormData();
    form.append('file', new File(['hello file'], 'note.txt', { type: 'text/plain' }));
    const upload = await app.request('/api/files', { method: 'POST', headers: { origin: ORIGIN, cookie: fx.cookie }, body: form });
    const info = value({ json: await upload.json() as Result<FileInfo> });
    expect(info).toMatchObject({ name: 'note.txt', mime: 'text/plain', size: 10, url: `/api/files/${info.id}` });
    const download = await app.request(info.url, { headers: { cookie: fx.cookie } });
    expect([download.status, download.headers.get('content-type'), await download.text()]).toEqual([200, 'text/plain', 'hello file']);
    const withFile = value(await call<Message>('POST', `/api/conversations/${managerConversationId}/messages`, { clientId: 'client-file', text: '', fileIds: [info.id], clientSentAt: 1 }));
    expect(withFile.parts).toEqual([{ type: 'file', fileId: info.id, name: 'note.txt', mime: 'text/plain', size: 10 }]);

    expect(value(await call<string>('GET', '/api/ext/demo/ping'))).toBe('alice');
    expect((await call('GET', '/api/nope')).status).toBe(404);
    const page = await app.request('/some/deep/link');
    expect([page.status, await page.text()]).toEqual([200, '<!doctype html><title>Kenan</title>']);
    // The service worker keeps assets forever, so a missing one must never come back as the app page.
    expect((await app.request('/assets/index-gone.js')).status).toBe(404);

    expect((await call('POST', '/api/logout', {})).status).toBe(200);
    expect((await call('GET', '/api/bootstrap')).status).toBe(401);
    fx.cookie = (await call<Bootstrap>('POST', '/api/login', { accountId: 'alice', secret: SECRET })).res.headers.get('set-cookie')!.split(';')[0]!;
  });

  it('streams phone notifications: replays after the phone cursor, then live, counting the phone', async () => {
    const manager = (await store.getAgent('kenaznia-alice'))!;
    const missed = await notify(deps, 'alice', manager, { title: 'Missed', body: 'while offline', level: 'normal', imageFileId: null });
    expect(missed.connectedPhones).toBe(0);
    const stream = await app.request(`/api/notifications?after=${missed.notification.id - 1}`, { headers: { cookie: fx.cookie } });
    const reader = stream.body!.getReader();
    let buffer = '';
    const next = async (): Promise<Record<string, any>> => {
      for (;;) {
        const end = buffer.indexOf('\n\n');
        if (end >= 0) {
          const block = buffer.slice(0, end); buffer = buffer.slice(end + 2);
          const data = JSON.parse(block.split('\n').find(l => l.startsWith('data: '))!.slice(6));
          if (data.type === 'notification') return data.notification;
          continue;
        }
        buffer += new TextDecoder().decode((await reader.read()).value);
      }
    };
    expect(await next()).toMatchObject({ id: missed.notification.id, title: 'Missed', level: 'normal', agentId: manager.id });
    const live = await notify(deps, 'alice', manager, { title: 'Now', body: 'urgent thing', level: 'urgent', imageFileId: null });
    expect(live.connectedPhones).toBe(1);
    expect(await next()).toMatchObject({ id: live.notification.id, level: 'urgent', imageFileId: null });
    await reader.cancel();
  });

  it('web push: a device subscribes, gets a confirmation and every notification encrypted, and is dropped once its push service says gone', async () => {
    const { publicKey } = value(await call<{ publicKey: string }>('GET', '/api/push'));
    expect(loadVapidKeys(join(dir, 'web-push-vapid.json')).publicKey.toString('base64url')).toBe(publicKey);
    expect((await call('POST', '/api/push/subscriptions', { subscription: { endpoint: 'http://push.test/x', keys: { p256dh: 'AA', auth: 'AA' } }, confirm: true })).status).toBe(400);
    const iphone = pushDevice('https://web.push.apple.com/test-endpoint');
    expect(value(await call('POST', '/api/push/subscriptions', { subscription: iphone.subscription, confirm: true }))).toEqual({ test: { kind: 'delivered' } });
    const confirmation = push.received.at(-1)!;
    expect(confirmation.url).toBe(iphone.subscription.endpoint);
    expect(confirmation.headers).toMatchObject({ 'content-encoding': 'aes128gcm', ttl: '86400', urgency: 'normal' });
    expect(vapidClaims(confirmation.headers.authorization!, publicKey)).toMatchObject({ aud: 'https://web.push.apple.com', sub: ORIGIN });
    expect(iphone.decrypt(confirmation.body)).toMatchObject({ id: null, title: 'Kenan notifications are on', conversationId: null });
    expect(value(await call('POST', '/api/push/subscriptions', { subscription: iphone.subscription, confirm: false }))).toEqual({ test: null });
    expect(push.received.at(-1)).toBe(confirmation);

    const manager = (await store.getAgent('kenaznia-alice'))!;
    const urgent = await notify(deps, 'alice', manager, { title: 'Door', body: 'Courier is outside', level: 'urgent', imageFileId: null });
    expect(urgent.webAppDevices).toBe(1);
    expect(push.received.at(-1)!.headers.urgency).toBe('high');
    expect(iphone.decrypt(push.received.at(-1)!.body)).toEqual({ id: urgent.notification.id, title: 'Door', body: 'Courier is outside', level: 'urgent', conversationId: manager.conversationId });
    expect(await store.pushSubscriptions('robin')).toEqual([]);

    push.status.set(iphone.subscription.endpoint, 400);
    expect((await notify(deps, 'alice', manager, { title: 'Refused', body: 'b', level: 'normal', imageFileId: null })).webAppDevices).toBe(0);
    expect(await store.pushSubscriptions('alice')).toEqual([iphone.subscription]);
    push.status.set(iphone.subscription.endpoint, 410);
    expect((await notify(deps, 'alice', manager, { title: 'Gone', body: 'b', level: 'normal', imageFileId: null })).webAppDevices).toBe(0);
    expect(await store.pushSubscriptions('alice')).toEqual([]);

    const tablet = pushDevice('https://fcm.googleapis.com/fcm/send/abc');
    value(await call('POST', '/api/push/subscriptions', { subscription: tablet.subscription, confirm: false }));
    value(await call('DELETE', '/api/push/subscriptions', { endpoint: tablet.subscription.endpoint }));
    expect(await store.pushSubscriptions('alice')).toEqual([]);
  });

  it('owns archive changes, hides history by default, preserves lineage and restores without sending', async () => {
    const parent = await store.createAgent({ id: 'archive-parent', name: 'Parent', ownerId: 'alice', parentAgentId: 'kenaznia-alice', role: 'worker', goalId: null, model: 'm', sessionPath: '/tmp/parent', conversationTitle: 'Parent' });
    const child = await store.createAgent({ id: 'archive-child', name: 'Child', ownerId: 'alice', parentAgentId: parent.id, role: 'worker', goalId: null, model: 'm', sessionPath: '/tmp/child', conversationTitle: 'Child' });
    const stored = await store.appendMessage({ conversationId: parent.conversationId, authorId: 'alice', role: 'human', text: 'Original retained history' });
    expect((await call('PATCH', `/api/agents/${parent.id}`, { archived: true })).status).toBe(200);
    const beforeCount = humanMessages.length;
    const boot = value(await call<Bootstrap>('GET', '/api/bootstrap'));
    expect(boot.agents.find(a => a.id === child.id)?.parentAgentId).toBe(parent.id);
    expect(boot.agents.find(a => a.id === parent.id)?.archived).toBe(true);
    expect(boot.conversations.some(c => c.id === parent.conversationId)).toBe(false);
    const all = value(await call<Bootstrap>('GET', '/api/bootstrap?includeArchived=1'));
    expect(all.conversations.find(c => c.id === parent.conversationId)?.archived).toBe(true);
    expect((await call('POST', `/api/conversations/${parent.conversationId}/messages`, { clientId: 'archive-no-send', text: 'No', fileIds: [] })).status).toBe(409);
    expect((await call('PATCH', '/api/agents/unknown', { archived: true })).status).toBe(404);
    expect((await call('PATCH', `/api/conversations/${managerConversationId}`, { archived: true })).status).toBe(409);
    expect(value(await call<Bootstrap>('GET', '/api/bootstrap')).manager).toEqual({ kind: 'here', conversationId: managerConversationId });
    expect((await call('PATCH', `/api/agents/${parent.id}`, { archived: 'yes' })).status).toBe(400);
    const foreign = await store.createAgent({ id: 'foreign-archive', name: 'Foreign', ownerId: 'robin', role: 'worker', goalId: null, model: 'm', sessionPath: '/tmp/foreign', conversationTitle: 'Foreign' });
    expect((await call('PATCH', `/api/agents/${foreign.id}`, { archived: true })).status).toBe(404);
    expect((await call('PATCH', `/api/agents/${parent.id}`, { archived: false })).status).toBe(200);
    expect(humanMessages.length).toBe(beforeCount);
    expect((await store.listMessages(parent.conversationId, { kind: 'latest' }, 10)).messages).toEqual([stored]);
  });

});

// These route regressions need neither a database nor a provider grant.
describe('CONTENT exact machine endpoint', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kenan-content-http-'));
  writeFileSync(join(dir, 'session.key'), randomBytes(32));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  async function setup(channel: 'beta' | 'production' = 'beta', enabled = true) {
    let calls = 0;
    const extension = createContentCadenceExtension(async () => ({ binding: null as never, ports: {
      handler: async () => { calls++; return new Response(null, { status: 403 }); }, recover: async () => [],
    } }));
    const deps = {
      config: { channel, sessionKeyPath: join(dir, 'session.key'), origins: [], people: [], webRoot: dir },
      store: { createSession: async () => {}, logError: async () => {} },
      now: Date.now, extensions: enabled ? [extension] : [],
    } as unknown as Deps;
    if (enabled) await extension.start!(deps);
    return { app: createApp(deps), stop: () => extension.stop!(), calls: () => calls };
  }
  it('mounts the configured extension before human auth but preserves native rejection', async () => {
    const f = await setup();
    try {
      expect((await f.app.request(CONTENT_PUBLIC_PATH, { method: 'POST' })).status).toBe(401);
      expect((await f.app.request(CONTENT_PUBLIC_PATH, { method: 'POST', headers: { authorization: 'Bearer fixture' } })).status).toBe(403);
      expect(f.calls()).toBe(1);
      expect((await f.app.request(CONTENT_PUBLIC_PATH)).status).toBe(405);
      expect((await f.app.request(CONTENT_PUBLIC_PATH + '?unexpected=1', { method: 'POST' })).status).toBe(400);
      for (const path of [CONTENT_PUBLIC_PATH + '/child', '/api/bootstrap', '/api/ext/content-cadence']) {
        expect((await f.app.request(path)).status).toBe(401);
        expect((await f.app.request(path, { method: 'POST' })).status).toBe(403);
      }
      expect(f.calls()).toBe(1);
    } finally { await f.stop(); }
  });
  it('has no singleton fallback when absent and never dispatches on production', async () => {
    for (const [channel, enabled, status] of [['beta', false, 404], ['production', true, 503]] as const) {
      const f = await setup(channel, enabled);
      try {
        expect((await f.app.request(CONTENT_PUBLIC_PATH, { method: 'POST', headers: { authorization: 'Bearer fixture' } })).status).toBe(status);
        expect(f.calls()).toBe(0);
      } finally { await f.stop(); }
    }
  });
});
