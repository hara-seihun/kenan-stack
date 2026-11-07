// Test helper: a full HTTP app over a fresh database schema, logged in as Alice, with a recording runtime and push service.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes, scryptSync } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConversationSummary, Message, Result } from '../../shared/contract.js';
import type { PersonConfig, ServerConfig } from '../config.js';
import type { Deps, Extension, Runtime } from '../types.js';
import { createStore, type PgStore } from '../db/store.js';
import { freshSchema } from '../db/test-db.js';
import { createBus } from '../events/bus.js';
import { createWebPush, loadVapidKeys } from '../web-push.js';
import { createApp } from './app.js';

export const ORIGIN = 'https://kenan.test';
export const SECRET = 'correct horse battery staple, long enough';

/** A push service: records each request and answers with the status set for its endpoint (201 when none is set). */
export function pushService() {
  const received: { url: string; headers: Record<string, string>; body: Buffer }[] = [];
  const status = new Map<string, number>();
  const fetch = async (url: string, init: { headers: Record<string, string>; body: Buffer }) => {
    received.push({ url, headers: init.headers, body: init.body });
    return { status: status.get(url) ?? 201, text: async () => status.get(url) === 400 ? 'BadJwtToken' : '' };
  };
  return { received, status, fetch };
}

export function person(id: string, name: string, brokerPort: number): PersonConfig {
  const profile = { name: 'Kenaznia', provider: 'anthropic' as const, model: 'm', thinking: 'off' as const, systemPrompt: '', contextFiles: [], refusalFallbackModels: [] };
  return { id, name, unixUser: id, uid: 1000, gid: 1000, home: '/tmp', brokerPort, heartbeatFile: null, alertDir: null, signalStore: null, pronouns: null, phones: [], peers: [], extensions: ['demo'], manager: profile, worker: profile };
}

export type TestApp = Awaited<ReturnType<typeof startTestApp>>;

/** Two channels of one host (server/channels/rooms.ts tests): `as` logs in that person, whose Kenaznia runs here
 *  ('kenaznia-<id>'); `other`'s runs elsewhere. Use ids no real person has: shared-chat notifications for people at home
 *  elsewhere go to the host's notify outbox. */
export interface Channel { name: 'beta' | 'production'; as: string; other: string; link: ServerConfig['link'] }

export async function startTestApp(schemaPrefix: string, sessionSettings: Readonly<Record<string, string>> = {}, extensions: Extension[] = [], channel: Channel | null = null) {
  const me = channel?.as ?? 'alice';
  const dir = mkdtempSync(join(tmpdir(), 'kenan-core-app-'));
  mkdirSync(join(dir, 'verifiers')); mkdirSync(join(dir, 'web'));
  const salt = randomBytes(32).toString('hex');
  writeFileSync(join(dir, 'verifiers', `${me}.json`), JSON.stringify({ version: 1, salt, digest: scryptSync(SECRET, salt, 32).toString('hex') }));
  writeFileSync(join(dir, 'session.key'), randomBytes(32));
  writeFileSync(join(dir, 'web', 'index.html'), '<!doctype html><title>Kenan</title>');
  // A mounted Settings menu reads usage even when closed. Keep the fixture's catalog valid.
  writeFileSync(join(dir, 'models.json'), JSON.stringify({ providers: {} }));
  const config: ServerConfig = {
    allowedProviders: ['anthropic'],
    channel: channel?.name ?? 'beta', listen: '127.0.0.1:0', databaseUrl: await freshSchema(schemaPrefix, sessionSettings), dataDir: dir, origins: [ORIGIN],
    sessionKeyPath: join(dir, 'session.key'), verifierDir: join(dir, 'verifiers'), modelsPath: join(dir, 'models.json'), heartbeatMinutes: 30,
    webRoot: join(dir, 'web'), webSearch: null, link: channel?.link,
    people: channel ? [person(me, `Person ${me}`, 1), { ...person(channel.other, `Person ${channel.other}`, 1), manager: { elsewhere: 'https://elsewhere.test' } }] : [person('alice', 'Alice', 1), person('robin', 'Robin', 1)],
  };
  const store: PgStore = createStore(config.databaseUrl);
  await store.migrate();
  for (const p of config.people) await store.upsertPerson({ id: p.id, name: p.name, kind: 'human' });
  const manager = await store.createAgent({ originConversationId: null, id: `kenaznia-${me}`, name: 'Kenaznia', ownerId: me, role: 'manager', goalId: null, model: 'm', sessionPath: '/tmp/x', conversationTitle: 'Kenaznia' });
  const humanMessages: { message: Message; conversation: ConversationSummary; seenFrom: string | null }[] = [];
  const stopped: string[] = [];
  const runtime: Runtime = {
    async start() {}, async shutdown() {}, async rewriteMessageCopies(_message, _replacement, commit) { await commit?.(); }, async deliver() { return { ok: true }; },
    onHumanMessage(message, conversation, seenFrom) { humanMessages.push({ message, conversation, seenFrom }); },
    async stop(id) { stopped.push(id); },
    async archiveAgent(id, archived) { return store.updateAgent(id, { archived }); },
    managerFor: id => id === me ? `kenaznia-${me}` : null,
    turnOf: () => null,
    reportBasis: () => ({ next: [], later: [], assigned: { next: [], later: [] } }), lateReportWork: () => [],
  };
  const people = new Map(config.people.map(p => [p.id, p]));
  const push = pushService();
  const deps: Deps = {
    config, placement: { kind: 'callerCgroup' }, store, bus: createBus(store), runtime, jobs: async () => [], person: id => people.get(id), now: () => Date.now(),
    webPush: createWebPush(loadVapidKeys(join(dir, 'web-push-vapid.json')), ORIGIN, push.fetch),
    extensions: [{ id: 'demo', name: 'Demo', routes: sub => { sub.get('/ping', c => c.json({ ok: true, value: c.get('me' as never) })); } }, ...extensions],
  };
  const app = createApp(deps);
  const login = await app.request('/api/login', { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify({ accountId: me, secret: SECRET }) });
  const fx = {
    dir, store, app, deps, push, humanMessages, stopped, managerConversationId: manager.conversationId,
    cookie: login.headers.get('set-cookie')!.split(';')[0]!,
    async call<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
      const res = await app.request(path, {
        method, headers: { origin: ORIGIN, cookie: fx.cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: res.status, res, json: await res.json() as Result<T> };
    },
    async close() { await store.close(); rmSync(dir, { recursive: true, force: true }); },
  };
  return fx;
}

export const value = <T>(r: { json: Result<T> }): T => { if (!r.json.ok) throw new Error(JSON.stringify(r.json.error)); return r.json.value; };
