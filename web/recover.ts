// When this build can't read what the server sends, or can't draw its screen, the build or its saved state is wrong for
// this server (typically a cached shell older than the server's contract). The saved screen and the cached shell are
// dropped and the newest build loads, at most once a minute, so a broken newest build ends in a visible error, not a loop.
import { clearSnapshot } from './snapshot.js';

const RECOVERED_AT = 'kenan-recovered-at';
const RECOVERY_INTERVAL_MS = 60_000;
/** web/public/sw.js keeps the app shell in caches named from this prefix. */
const SHELL_CACHE_PREFIX = 'kenan-shell-';

export type Recovery = { kind: 'reloading' } | { kind: 'exhausted'; reason: string };

export function recoverApp(reason: string, session: Storage = sessionStorage, now = Date.now()): Recovery {
  console.error('Kenan is reloading to recover:', reason);
  const last = Number(session.getItem(RECOVERED_AT));
  if (last > 0 && now - last < RECOVERY_INTERVAL_MS) return { kind: 'exhausted', reason };
  session.setItem(RECOVERED_AT, String(now));
  clearSnapshot(localStorage);
  const dropShell = 'caches' in window
    ? caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith(SHELL_CACHE_PREFIX)).map(key => caches.delete(key))))
    : Promise.resolve();
  void dropShell.catch(e => console.warn('Could not drop the cached app shell:', e)).finally(() => location.reload());
  return { kind: 'reloading' };
}
