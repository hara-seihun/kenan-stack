/** Freshness is confirmed by a stream snapshot and its follow-up reads, never by elapsed time. */
export type SyncState = 'current' | 'syncing' | 'offline' | 'failed';
let state: SyncState = 'syncing', generation = 0, snapshot = false, disconnected = false;
let pending = 0, checking = true;
const failed = new Set<string>();
const listeners = new Set<() => void>();
function publish() {
  if (snapshot && pending === 0 && failed.size === 0) checking = false;
  const next: SyncState = disconnected ? 'offline' : !snapshot || (checking && pending > 0) ? 'syncing' : failed.size ? 'failed' : 'current';
  if (next === state) return;
  state = next; for (const listener of listeners) listener();
}
export const sync = {
  read: () => state,
  subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  stale(offline = false) {
    generation++; checking = true; snapshot = false; disconnected = offline; pending = 0; failed.clear(); publish();
  },
  opened() { disconnected = false; publish(); },
  ready() { snapshot = true; disconnected = false; publish(); },
  /** Old requests may finish after resume; they cannot confirm the new connection. */
  request(path: string) {
    const at = generation;
    pending++; if (state !== 'current') publish();
    return (ok: boolean) => {
      if (at !== generation) return;
      pending--; if (ok) failed.delete(path); else failed.add(path);
      // The caller applies the response in the same promise turn before subscribers render.
      queueMicrotask(publish);
    };
  },
};
