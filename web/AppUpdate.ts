// Android app updates from inside the app, through the KenanNext bridge its WebView injects (every installed build has it).
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiPath } from './path.js';
import { bridge, call } from './native.js';

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
async function latest(): Promise<Release> {
  const response = await fetch(apiPath('/api/android/update'), { cache: 'no-store' });
  if (!response.ok) throw new Error(`Update feed HTTP ${response.status}`);
  return response.json() as Promise<Release>;
}

export function useAppUpdate(): { update: AppUpdate; bannerHidden: boolean; check: () => Promise<void>; install: () => Promise<void>; dismiss: () => void } {
  const [update, setUpdate] = useState<AppUpdate>(() => bridge() ? { state: 'quiet' } : { state: 'web' });
  const [dismissed, setDismissed] = useState(false);
  const submitted = useRef(0);
  const [dismissedVersion, setDismissedVersion] = useState(() => Number(localStorage.getItem(dismissedKey) ?? 0));

  /** Requested checks also report "up to date" or their failure; automatic checks stay quiet otherwise. */
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
    const timer = window.setInterval(resumed, 120_000);
    return () => { document.removeEventListener('visibilitychange', resumed); window.clearInterval(timer); };
  }, [run]);

  // The signed native installer owns Android consent. A detected release should
  // install itself rather than wait for the person to press a web banner button.
  useEffect(() => {
    if (update.state !== 'available' || submitted.current >= update.release.versionCode) return;
    submitted.current = update.release.versionCode;
    void install();
  }, [update, install]);

  /** Dismissing an available update hides it until a newer version; other banners are dismissed until the next check. */
  const dismiss = () => {
    if (update.state === 'available') { localStorage.setItem(dismissedKey, String(update.release.versionCode)); setDismissedVersion(update.release.versionCode); }
    else setDismissed(true);
  };
  const hidden = dismissed || (update.state === 'available' && update.release.versionCode <= dismissedVersion);
  return { update, bannerHidden: hidden, check, install, dismiss };
}
