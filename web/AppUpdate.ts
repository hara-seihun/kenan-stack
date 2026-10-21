// Android app updates from inside the app, through the KenanNext bridge its WebView injects (every installed build has it).
import { useCallback, useEffect, useState } from 'react';
import { apiPath } from './path.js';

type Outcome = { ok: true; value: Record<string, unknown> } | { ok: false; error: { code: string; message: string } };
type Bridge = { postMessage(data: string): void; addEventListener(type: 'message', listener: (event: { data: string }) => void): void };
type Release = { url: string; size: number; sha256: string; versionCode: number };
export type AppUpdate =
  | { state: 'web' }
  | { state: 'checking' }
  | { state: 'quiet' }
  | { state: 'current'; versionCode: number }
  | { state: 'available'; installed: number; release: Release }
  | { state: 'installing'; release: Release }
  | { state: 'needs-permission' }
  | { state: 'prompt-pending' }
  | { state: 'failed'; message: string };

const dismissedKey = 'kenan-app-update-dismissed';
const bridge = (): Bridge | null => (window as unknown as { KenanNext?: Bridge }).KenanNext ?? null;
const pending = new Map<string, (outcome: Outcome) => void>();
let listening = false;

function call(name: string, args: Record<string, unknown>): Promise<Outcome> {
  const native = bridge();
  if (!native) return Promise.resolve({ ok: false, error: { code: 'unsupported', message: 'Not running in the Android app' } });
  if (!listening) {
    listening = true;
    native.addEventListener('message', event => {
      const reply = JSON.parse(event.data) as { id: string | null; result: Outcome };
      if (reply.id) { pending.get(reply.id)?.(reply.result); pending.delete(reply.id); }
    });
  }
  const id = crypto.randomUUID();
  return new Promise(resolve => { pending.set(id, resolve); native.postMessage(JSON.stringify({ id, name, args })); });
}

async function latest(): Promise<Release> {
  const response = await fetch(apiPath('/api/android/update'), { cache: 'no-store' });
  if (!response.ok) throw new Error(`Update feed HTTP ${response.status}`);
  return response.json() as Promise<Release>;
}

export function useAppUpdate(): { update: AppUpdate; bannerHidden: boolean; check: () => Promise<void>; install: () => Promise<void>; dismiss: () => void } {
  const [update, setUpdate] = useState<AppUpdate>(() => bridge() ? { state: 'quiet' } : { state: 'web' });
  const [dismissed, setDismissed] = useState(false);
  const [dismissedVersion, setDismissedVersion] = useState(() => Number(localStorage.getItem(dismissedKey) ?? 0));

  /** Automatic checks only surface an available update; a requested check also reports "up to date" or its failure. */
  const run = useCallback(async (requested: boolean) => {
    if (!bridge()) { setUpdate({ state: 'web' }); return; }
    if (requested) { setUpdate({ state: 'checking' }); setDismissed(false); setDismissedVersion(0); localStorage.removeItem(dismissedKey); }
    const settled = (result: AppUpdate) => setUpdate(result.state === 'available' || requested ? result : { state: 'quiet' });
    try {
      const [status, release] = await Promise.all([call('status', {}), latest()]);
      if (!status.ok) { settled({ state: 'failed', message: status.error.message }); return; }
      const installed = Number(status.value.versionCode);
      settled(release.versionCode > installed ? { state: 'available', installed, release } : { state: 'current', versionCode: installed });
    } catch (e) { settled({ state: 'failed', message: String((e as Error).message ?? e) }); }
  }, []);
  const check = useCallback(() => run(true), [run]);

  const install = useCallback(async () => {
    if (update.state !== 'available') return;
    const release = update.release;
    setUpdate({ state: 'installing', release });
    const outcome = await call('apkUpdate', { operationId: crypto.randomUUID(), ...release });
    if (outcome.ok) { if (outcome.value.state === 'current') setUpdate({ state: 'current', versionCode: Number(outcome.value.versionCode) }); return; }
    // Builds from 11675/53 open Android's permission page themselves and answer permission_missing.
    if (outcome.error.code === 'permission_missing') { setUpdate({ state: 'needs-permission' }); return; }
    if (/package installation/i.test(outcome.error.message)) { setUpdate({ state: 'needs-permission' }); void call('openSettings', { section: 'updates' }); return; }
    if (/in progress/i.test(outcome.error.message)) { setUpdate({ state: 'prompt-pending' }); void call('openSettings', { section: 'updates' }); return; }
    setUpdate({ state: 'failed', message: outcome.error.message });
  }, [update]);

  useEffect(() => {
    if (!bridge()) return;
    void run(false);
    const resumed = () => { if (document.visibilityState === 'visible') void run(false); };
    document.addEventListener('visibilitychange', resumed);
    return () => document.removeEventListener('visibilitychange', resumed);
  }, [run]);

  /** Dismissing an available update hides it until a newer version; other banners are dismissed until the next check. */
  const dismiss = () => {
    if (update.state === 'available') { localStorage.setItem(dismissedKey, String(update.release.versionCode)); setDismissedVersion(update.release.versionCode); }
    else setDismissed(true);
  };
  const hidden = dismissed || (update.state === 'available' && update.release.versionCode <= dismissedVersion);
  return { update, bannerHidden: hidden, check, install, dismiss };
}
