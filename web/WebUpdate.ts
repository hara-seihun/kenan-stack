// Open tabs and the Android WebView keep running the frontend they loaded; a deploy publishes a new hashed entry script.
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiPath } from './path.js';

export type WebUpdate = { state: 'untracked' } | { state: 'current'; entry: string } | { state: 'available'; entry: string; served: string };

const CHECK_MS = 5 * 60_000;

export function entryScript(text: string): string | null {
  return /assets\/(index-[\w-]+\.js)/.exec(text)?.[1] ?? null;
}

export function runningEntry(): string | null {
  const script = document.querySelector<HTMLScriptElement>('script[type="module"][src*="assets/index-"]');
  return script ? entryScript(script.src) : null;
}

/** Checks after every reconnect, on return to the app and every five minutes. A failed check leaves the last known state. */
export function useWebUpdate(connected: boolean): { update: WebUpdate; shown: boolean; dismiss: () => void; reload: () => void } {
  const [update, setUpdate] = useState<WebUpdate>(() => { const entry = runningEntry(); return entry ? { state: 'current', entry } : { state: 'untracked' }; });
  const [dismissed, setDismissed] = useState<string | null>(null);
  const running = useRef(update.state === 'untracked' ? null : update.entry);

  const check = useCallback(async () => {
    const entry = running.current;
    if (!entry) return;
    const response = await fetch(apiPath('/'), { cache: 'no-store', credentials: 'same-origin' }).catch(() => null);
    if (!response?.ok) return;
    const served = entryScript(await response.text().catch(() => ''));
    if (!served) return;
    setUpdate(served === entry ? { state: 'current', entry } : { state: 'available', entry, served });
  }, []);

  useEffect(() => { if (connected) void check(); }, [connected, check]);
  useEffect(() => {
    if (!running.current) return;
    const visible = () => { if (document.visibilityState === 'visible') void check(); };
    document.addEventListener('visibilitychange', visible);
    const timer = setInterval(() => void check(), CHECK_MS);
    return () => { document.removeEventListener('visibilitychange', visible); clearInterval(timer); };
  }, [check]);

  const shown = update.state === 'available' && dismissed !== update.served;
  return { update, shown, dismiss: () => { if (update.state === 'available') setDismissed(update.served); }, reload: () => location.reload() };
}
