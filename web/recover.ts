// When this build can't read what the server sends, or can't draw its screen, the build or its saved state is wrong for
// this server (typically a cached shell older than the server's contract). The saved screen and the cached shell are
// dropped and the newest build loads, at most once a minute, so a broken newest build ends in a visible error, not a loop.
import { dropShellCache } from './newest.js';
import { clearSnapshot } from './snapshot.js';

const RECOVERED_AT = 'kenan-recovered-at';
const RECOVERY_INTERVAL_MS = 60_000;

export type Recovery = { kind: 'reloading' } | { kind: 'exhausted'; reason: string };

export function recoverApp(reason: string, session: Storage = sessionStorage, now = Date.now()): Recovery {
  console.error('Kenan is reloading to recover:', reason);
  const last = Number(session.getItem(RECOVERED_AT));
  if (last > 0 && now - last < RECOVERY_INTERVAL_MS) return { kind: 'exhausted', reason };
  session.setItem(RECOVERED_AT, String(now));
  clearSnapshot(localStorage);
  void dropShellCache().catch(e => console.warn('Could not drop the cached app shell:', e)).finally(() => location.reload());
  return { kind: 'reloading' };
}
