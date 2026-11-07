// Loading the newest build. web/public/sw.js serves the app document from its cache, so a plain reload opens whatever
// shell it cached last, which after a deploy is still the old build. Before reloading, the worker is asked to fetch the
// newest shell; if the shell it then holds isn't the wanted build (no worker, no answer in 10 s, or the refresh failed),
// the cached shell is dropped so the reload goes to the server.

/** web/public/sw.js keeps the app shell in caches named from this prefix. */
const SHELL_CACHE_PREFIX = 'kenan-shell-';
const ANSWER_MS = 10_000;

type Refreshed = { kind: 'cached'; entry: string | null } | { kind: 'no-worker' } | { kind: 'no-answer' };

function refreshShell(): Promise<Refreshed> {
  const worker = 'serviceWorker' in navigator ? navigator.serviceWorker.controller : null;
  if (!worker) return Promise.resolve({ kind: 'no-worker' });
  return new Promise(resolve => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => { channel.port1.close(); resolve({ kind: 'no-answer' }); }, ANSWER_MS);
    channel.port1.onmessage = (event: MessageEvent<{ entry: string | null }>) => { clearTimeout(timer); channel.port1.close(); resolve({ kind: 'cached', entry: event.data.entry }); };
    worker.postMessage({ type: 'kenan-refresh-shell' }, [channel.port2]);
  });
}

export async function dropShellCache(): Promise<void> {
  if (!('caches' in window)) return;
  const keys = await caches.keys();
  await Promise.all(keys.filter(key => key.startsWith(SHELL_CACHE_PREFIX)).map(key => caches.delete(key)));
}

/** Reloads into the build whose entry script is `entry`. */
export async function reloadInto(entry: string, beforeReload: () => Promise<boolean> = async () => true): Promise<void> {
  const refreshed = await refreshShell();
  if (refreshed.kind !== 'cached' || refreshed.entry !== entry) await dropShellCache().catch(e => console.warn('Could not drop the cached app shell:', e));
  if (await beforeReload()) location.reload();
}
