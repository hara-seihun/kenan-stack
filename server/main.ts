// Kenan Stack server entry point. Owned by lead. Usage: node dist/server/main.js /etc/kenan/<channel>.json
import { startUsagePolling } from './metrics/usage.js';
import { loadConfig } from './config.js';
import { createStore } from './db/store.js';
import { createBus } from './events/bus.js';
import { createRuntime } from './agents/runtime.js';
import { loadExtensions } from './extensions/index.js';
import { createApp } from './http/app.js';
import { listen, listenerFor } from './http/listen.js';
import { NOTIFY_OUTBOX_ROOT, startNotifyOutboxes } from './notify-outbox.js';
import { EVENT_INBOX_ROOT, startEventInboxes } from './event-inbox.js';
import { startPeerSockets } from './peers.js';
import { channelPlacement } from './tools/owner.js';
import { WakeScheduler } from './agents/wakes.js';
import type { Deps } from './types.js';
import { webPushFor } from './web-push.js';
import { dirname, join } from 'node:path';

const configPath = process.argv[2] ?? process.env.KENAN_CONFIG;
if (!configPath) throw new Error('usage: main.js <config.json>');
const config = loadConfig(configPath);
const store = createStore(config.databaseUrl);
await store.migrate();
const bus = createBus(store);
const people = new Map(config.people.map(p => [p.id, p]));
const deps = { config, placement: channelPlacement(config), store, bus, extensions: loadExtensions(), webPush: webPushFor(join(dirname(config.sessionKeyPath), 'web-push-vapid.json'), config.origins), person: (id: string) => people.get(id), now: () => Date.now() } as Omit<Deps, 'runtime'> as Deps;
deps.runtime = createRuntime(deps);

for (const p of config.people) await store.upsertPerson({ id: p.id, name: p.name, kind: 'human' });
for (const ext of deps.extensions) await ext.start?.(deps);

const app = createApp(deps);
const server = await listen(app, listenerFor(config.listen, process.env, process.pid));
for (const ext of deps.extensions) ext.publicSockets?.(server);
await deps.runtime.start();
const wakes = new WakeScheduler(deps);
wakes.start();
const stopNotifyOutboxes = await startNotifyOutboxes(deps, NOTIFY_OUTBOX_ROOT);
const stopEventInboxes = await startEventInboxes(deps, EVENT_INBOX_ROOT, () => void wakes.tick());
const stopPeerSockets = await startPeerSockets(deps);
const stopUsagePolling = startUsagePolling(deps);
console.log(JSON.stringify({ type: 'started', channel: config.channel, listen: config.listen, people: config.people.map(p => p.id) }));

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return; stopping = true;
  console.log(JSON.stringify({ type: 'stopping', signal }));
  server.close();
  stopNotifyOutboxes();
  stopEventInboxes();
  stopPeerSockets();
  stopUsagePolling();
  await wakes.stop();
  await deps.runtime.shutdown();
  for (const ext of deps.extensions) await ext.stop?.().catch(() => {});
  await store.close();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('unhandledRejection', e => { console.error(JSON.stringify({ type: 'unhandledRejection', error: String((e as Error)?.stack ?? e) })); void store.logError('process', String(e)).catch(() => {}); });
