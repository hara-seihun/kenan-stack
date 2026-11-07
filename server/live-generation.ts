// Kenan Stack server entry point. Owned by lead. Usage: node dist/server/main.js /etc/kenan/<channel>.json
import { startBackgroundSummaries } from './background-summaries.js';
import { startUsagePolling } from './metrics/usage.js';
import { startCacheWatch } from './metrics/cache-watch.js';
import { loadConfig, validatePerson } from './config.js';
import { createStore } from './db/store.js';
import { liveStore } from './live-store.js';
import { createBus } from './events/bus.js';
import { createRuntime, type AgentRuntime } from './agents/runtime.js';
import { keepRouteSnapshots } from './agents/model-route.js';
import { monitorEventLoopDelay, PerformanceObserver } from 'node:perf_hooks';
import { getHeapStatistics } from 'node:v8';
import { loadExtensions } from './extensions/index.js';
import { raiseFailedExtensions, startExtensions } from './extensions/start.js';
import { createApp } from './http/app.js';
import { listen, listenerFor } from './http/listen.js';
import { startQuietSummaries } from './notifications.js';
import { NOTIFY_OUTBOX_ROOT, startNotifyOutboxes } from './notify-outbox.js';
import { EVENT_INBOX_ROOT, startEventInboxes } from './event-inbox.js';
import { startPeerSockets, startLinkedPeers } from './peers.js';
import { hostDirectory, installDirectory, startAgentMessages, startLinkedMessages } from './agents/messaging.js';
import { startLink } from './channels/link.js';
import { LINE_TEXT_INBOX_ROOT, startRoutedTexts, stopPersonLines } from './extensions/texts-line.js';
import { refreshPhoneLines } from './extensions/phone.js';
import { channelPlacement } from './tools/owner.js';
import { WakeScheduler } from './agents/wakes.js';
import { startCalendarReminders } from './extensions/calendar-reminders.js';
import type { Deps } from './types.js';
import { updateLiveExtensions } from './live-extensions.js';
import type { LiveHost, LiveServices, Reload } from './live-host.js';
import { webPushFor } from './web-push.js';
import { dirname, join } from 'node:path';
import { createServer as createSocketServer } from 'node:net';
import { chmodSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { stopChannelsPerson } from './extensions/channels.js';
import { stopDiscordPerson } from './extensions/discord.js';
import { stopAsksPerson } from './extensions/asks.js';
import { stopPersonInboxes } from './host-inbox.js';
import { GPURUN_JOBS_ROOT, hostJobCensus, observeAgentJobs } from './agents/pending-work.js';

export async function start(configPath: string, reload: Reload): Promise<LiveHost> {
const startupAt = Date.now();
const startupPhase = (phase: string) => console.log(JSON.stringify({ type: 'startup', phase, ms: Date.now() - startupAt }));
startupPhase('config');
const config = loadConfig(configPath);
const jobs = hostJobCensus(GPURUN_JOBS_ROOT);
const { store, replaceStore } = liveStore(createStore(config.databaseUrl, { observeAgent: observeAgentJobs(jobs) }));
await store.migrate();
startupPhase('schema_ready');
// Chats made before every way of starting one added her Kenaznia (Business stuff, 2026-10-21) never reached it.
for (const joined of await store.joinManagersToOwnChats()) console.log(`joined ${joined.managerId} to its owner's chat ${joined.conversationId}`);
const bus = createBus({ conversationMembers: id => deps.store.conversationMembers(id) });
const people = new Map(config.people.map(p => [p.id, p]));
const deps = { config, placement: channelPlacement(config), store, bus, extensions: await loadExtensions(), jobs, webPush: webPushFor(join(dirname(config.sessionKeyPath), 'web-push-vapid.json'), config.origins), person: (id: string) => people.get(id), now: () => Date.now() } as Omit<Deps, 'runtime'> as Deps;
keepRouteSnapshots(join(deps.config.dataDir, 'route-snapshots'));
// The whole channel (every agent's tools, the app's requests) runs on this one event loop; when it falls behind, every
// small tool call waits with it. Logged each minute it does (2026-10-28: workers messages took 16–34 s under load).
// Each line says how much of the stall was garbage collection and how full the heap was (2026-10-29: Beta stalled for
// minutes at a time, 17:24–17:36Z, with its heap near V8's default 4 GiB limit).
const loopDelay = monitorEventLoopDelay({ resolution: 50 });
loopDelay.enable();
let gcMs = 0, gcMaxMs = 0;
new PerformanceObserver(list => { for (const entry of list.getEntries()) { gcMs += entry.duration; gcMaxMs = Math.max(gcMaxMs, entry.duration); } }).observe({ entryTypes: ['gc'] });
setInterval(() => {
  const p99 = loopDelay.percentile(99) / 1e6, max = loopDelay.max / 1e6;
  if (max > 1_000) {
    const heap = getHeapStatistics(), mib = (bytes: number) => Math.round(bytes / 2 ** 20);
    console.log(JSON.stringify({ type: 'event_loop_lag', p50Ms: Math.round(loopDelay.percentile(50) / 1e6), p99Ms: Math.round(p99), maxMs: Math.round(max), gcMs: Math.round(gcMs), gcMaxMs: Math.round(gcMaxMs), heapUsedMiB: mib(heap.used_heap_size), heapLimitMiB: mib(heap.heap_size_limit), rssMiB: mib(process.memoryUsage.rss()) }));
  }
  loopDelay.reset(); gcMs = 0; gcMaxMs = 0;
}, 60_000).unref();
installDirectory(store, hostDirectory(deps));
let runtime = createRuntime(deps);
deps.runtime = runtime;

for (const p of config.people) await store.upsertPerson({ id: p.id, name: p.name, kind: 'human' });
startupPhase('extensions');
const extensionStarts = await startExtensions(deps, deps.extensions);

// Managers are placed before the first request: a bootstrap answered earlier showed a hosted person "no Kenaznia".
startupPhase('runtime');
await deps.runtime.start();
startupPhase('runtime_ready');
await raiseFailedExtensions(deps, extensionStarts);
let app = createApp(deps);
const httpApp = { fetch: (...args: Parameters<typeof app.fetch>) => app.fetch(...args) };
const server = await listen(httpApp as typeof app, listenerFor(config.listen, process.env, process.pid));
startupPhase('listening');
for (const ext of deps.extensions) ext.publicSockets?.(server);
let services = await startServices(deps, httpApp);
// Root-only local ownership change. Acknowledgement follows the person's shutdown, not just the config write.
const ownerSocketPath = `/run/kenan/${config.channel}-owner-control.sock`;
try { unlinkSync(ownerSocketPath); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
let changingOwner = false;
const ownerSocket = createSocketServer(socket => {
  let input = '';
  socket.on('data', chunk => {
    input += chunk.toString();
    if (input.length > 8192) { socket.destroy(); return; }
    if (!input.includes('\n')) return;
    socket.pause();
    void (async () => {
      if (changingOwner) throw new Error('ownership_change_in_progress');
      changingOwner = true;
      try {
        const request = JSON.parse(input.split('\n')[0]!);
        if (request.reload === true) { socket.end(JSON.stringify(await reload()) + '\n'); return; }
        if ('addPerson' in request) {
          if (typeof request.addPerson !== 'string') throw new Error('invalid_person_id');
          if (people.has(request.addPerson)) { socket.end(JSON.stringify({ ok: true, already: true }) + '\n'); return; }
          const raw = JSON.parse(readFileSync(configPath, 'utf8'));
          const entry = raw.people?.find((p: { id: string }) => p.id === request.addPerson);
          if (!entry) throw new Error('person_not_in_config');
          const added = validatePerson(config, entry, configPath);
          config.people.push(added); people.set(added.id, added);
          try { await runtime.addPerson(added); }
          catch (e) { config.people.splice(config.people.indexOf(added), 1); people.delete(added.id); throw e; }
          socket.end(JSON.stringify({ ok: true }) + '\n'); return;
        }
        const person = people.get(request.person);
        if (!person || typeof request.elsewhere !== 'string' || !/^https?:\/\/[^\s/]+/.test(request.elsewhere)) throw new Error('invalid_person_or_url');
        const raw = JSON.parse(readFileSync(configPath, 'utf8'));
        const entry = raw.people.find((p: { id: string }) => p.id === person.id);
        if (!entry) throw new Error('person_not_in_config');
        entry.manager = { elsewhere: request.elsewhere };
        const tmp = `${configPath}.${process.pid}.tmp`;
        writeFileSync(tmp, `${JSON.stringify(raw, null, 2)}\n`, { mode: statSync(configPath).mode & 0o777 });
        renameSync(tmp, configPath);
        person.manager = entry.manager;
        refreshPhoneLines(deps);
        await Promise.all([stopChannelsPerson(person.id), stopDiscordPerson(person.id), stopAsksPerson(person.id), stopPersonLines(person.id), stopPersonInboxes(person.id), runtime.pausePerson(person.id)]);
        await services.wakes.pauseOwner(person.id);
        socket.end(JSON.stringify({ ok: true }) + '\n');
      } finally { changingOwner = false; }
    })().catch(error => socket.end(JSON.stringify({ ok: false, error: String(error) }) + '\n'));
  });
});
const previousUmask = process.umask(0o077);
try { await new Promise<void>((resolve, reject) => { ownerSocket.once('error', reject); ownerSocket.listen(ownerSocketPath, () => { chmodSync(ownerSocketPath, 0o600); resolve(); }); }); }
finally { process.umask(previousUmask); }
console.log(JSON.stringify({ type: 'started', channel: config.channel, listen: config.listen, people: config.people.map(p => p.id) }));

/** Each shutdown step waits at most STEP_MS (the runtime's own turn wait is 5 s); the whole stop ends by SHUTDOWN_CAP_MS, well inside systemd's 90 s. */
const STEP_MS = 10_000, SHUTDOWN_CAP_MS = 45_000;
let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return; stopping = true;
  console.log(JSON.stringify({ type: 'stopping', signal }));
  // A step that never settles must not run into systemd's SIGKILL (2026-10-26 05:06Z Beta ran 90 s after SIGTERM and
  // was killed with nothing saved): each waits at most STEP_MS, a slow one is named, and the whole stop is capped.
  let phase = 'close';
  const cap = setTimeout(() => { console.log(JSON.stringify({ type: 'shutdown_stuck', phase })); process.exit(1); }, SHUTDOWN_CAP_MS);
  const step = async (name: string, work: () => Promise<unknown>) => {
    phase = name;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const slow = new Promise<'slow'>(resolve => { timer = setTimeout(() => resolve('slow'), STEP_MS); });
    if (await Promise.race([work().catch(() => undefined), slow]) === 'slow') console.log(JSON.stringify({ type: 'shutdown_slow_step', step: name, waitedMs: STEP_MS }));
    clearTimeout(timer);
  };
  server.close();
  ownerSocket.close();
  await step('background_services', () => services.stop());
  await step('runtime', () => deps.runtime.shutdown());
  for (const ext of deps.extensions) await step(`extension:${ext.id}`, async () => ext.stop?.());
  await step('store', () => deps.store.close());
  clearTimeout(cap);
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('unhandledRejection', e => { console.error(JSON.stringify({ type: 'unhandledRejection', error: String((e as Error)?.stack ?? e) })); void store.logError('process', String(e)).catch(() => {}); });

return {
  deps, configPath, server, replaceStore,
  fetch: httpApp.fetch,
  get services() { return services; },
  setServices(next) { services = next; },
  get runtime() { return runtime; },
  setRuntime(next) { runtime = next; deps.runtime = next; },
  setApp(next) { app = next; },
  setPeople(next) { people.clear(); for (const person of next) people.set(person.id, person); },
};
}

/** HTTP and future turns move to this code; the old Pi sessions keep running. */
export async function upgrade(host: LiveHost): Promise<void> {
  const { deps } = host;
  const config = loadConfig(host.configPath);
  if (config.channel !== deps.config.channel || config.databaseUrl !== deps.config.databaseUrl || config.listen !== deps.config.listen || config.dataDir !== deps.config.dataDir) {
    throw new Error('live_reload_address_changed: channel, database, listening address and data directory require an explicit service replacement');
  }
  const nextStore = createStore(config.databaseUrl, { observeAgent: observeAgentJobs(deps.jobs) });
  try { await nextStore.migrate(); } catch (error) { await nextStore.close(); throw error; }
  Object.assign(deps.config, config);
  host.setPeople(config.people);
  void host.replaceStore(nextStore).catch(error => deps.store.logError('live_reload_store', String(error)));
  installDirectory(deps.store, hostDirectory(deps));
  keepRouteSnapshots(join(deps.config.dataDir, 'route-snapshots'));
  const previous = host.runtime;
  const next = createRuntime(deps);
  await next.upgrade(previous);
  host.setRuntime(next);
  host.setApp(createApp(deps));
  await host.services.stop();
  host.setServices(await startServices(deps, host));
  // Each changed service keeps one owner and waits only for its own in-flight tool calls.
  updateLiveExtensions(deps, await loadExtensions(), () => host.setApp(createApp(deps)));
}

/** Background intake has one owner; swapping it never stops the runtime or its tools. */
async function startServices(deps: Deps, app: Pick<ReturnType<typeof createApp>, 'fetch'>): Promise<LiveServices> {
  const wakes = new WakeScheduler(deps);
  wakes.start();
  const stops: (() => void | Promise<void>)[] = [startBackgroundSummaries(deps)];
  try {
    stops.push(await startNotifyOutboxes(deps, NOTIFY_OUTBOX_ROOT), startQuietSummaries(deps));
    stops.push(await startCalendarReminders(deps));
    stops.push(await startEventInboxes(deps, EVENT_INBOX_ROOT, () => void wakes.tick()));
    stops.push(await startPeerSockets(deps));
    stops.push(await startLink(deps, app));
    stops.push(await startRoutedTexts(deps, LINE_TEXT_INBOX_ROOT));
    stops.push(await startLinkedMessages(deps), startLinkedPeers(deps));
    stops.push(await startAgentMessages(deps, (id, text, fromId, target) => (deps.runtime as AgentRuntime).messageWorker(id, text, fromId, target)));
    stops.push(startUsagePolling(deps), startCacheWatch(deps));
  } catch (error) {
    await Promise.allSettled(stops.map(stop => Promise.resolve().then(stop)));
    await wakes.stop();
    throw error;
  }
  return { wakes, async stop() { await Promise.all(stops.map(stop => Promise.resolve().then(stop))); await wakes.stop(); } };
}
