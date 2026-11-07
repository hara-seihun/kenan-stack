// The process, sockets and running Pi sessions survive deployments. Only future work changes code.
import { realpath, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { importLiveGeneration } from './live-modules.js';
import type { LiveGeneration, LiveHost } from './live-host.js';

const configPath = process.argv[2] ?? process.env.KENAN_CONFIG;
if (!configPath) throw new Error('usage: main.js <config.json>');
const initialRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
let host: LiveHost;
const loaded = (root: string) => writeFile(`/run/kenan/${host.deps.config.channel}-live-release.json`, JSON.stringify({ pid: process.pid, root }) + '\n');
let loading: Promise<{ ok: true; liveReload: true }> | undefined;
const reload = () => loading ??= (async () => {
  const root = initialRoot.includes('/releases/') ? await realpath(resolve(initialRoot, '../../current')) : initialRoot;
  const loader: typeof import('./live-modules.js') = await import(pathToFileURL(resolve(root, 'dist/server/live-modules.js')).href);
  const generation = await loader.importLiveGeneration<LiveGeneration>(root);
  await generation.upgrade(host);
  await loaded(root);
  console.log(JSON.stringify({ type: 'live_reloaded', channel: host.deps.config.channel, pid: process.pid }));
  return { ok: true, liveReload: true } as const;
})().finally(() => { loading = undefined; });
const generation = await importLiveGeneration<LiveGeneration>(initialRoot);
host = await generation.start(configPath, reload);
await loaded(initialRoot);
process.on('SIGHUP', () => { void reload().catch(error => console.error(JSON.stringify({ type: 'live_reload_failed', error: String(error) }))); });
