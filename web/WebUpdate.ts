// Both browser tabs and Android's WebView run this update policy.
import { useEffect, useRef } from 'react';
import { reloadInto } from './newest.js';
import { apiPath } from './path.js';
import { bridge } from './native.js';
import { updateActivityBusy } from './updateActivity.js';

const CHECK_MS = 30_000, IDLE_MS = 15_000, SETTLE_MS = 8_000, COOLDOWN_MS = 60_000;
const ATTEMPTS = 'kenan-web-update-attempts';
type Attempts = { entries: string[]; at: number };
export function entryScript(text: string): string | null {
  return /assets\/(index-[\w-]+\.js)/.exec(text)?.[1] ?? null;
}
export function runningEntry(): string | null {
  const script = document.querySelector<HTMLScriptElement>('script[type="module"][src*="assets/index-"]');
  return script ? entryScript(script.src) : null;
}
const editable = (el: Element | null) => el instanceof HTMLElement && (el.isContentEditable || el.matches('textarea, select, input:not([type=checkbox], [type=radio], [type=file], [type=button], [type=submit], [type=hidden])'));
const hidden = () => document.visibilityState === 'hidden' || bridge()?.foreground === false;

/** A pending update never interrupts editing, recording, sending, an upload or an open editor. */
export function useWebUpdate(connected: boolean, busy: boolean, save: () => boolean): void {
  const current = useRef({ busy, save }); current.current = { busy, save };
  const checkNow = useRef<() => void>(() => {});
  useEffect(() => { if (connected) checkNow.current(); }, [connected]);
  useEffect(() => {
    const entry = runningEntry();
    if (!entry) return;
    let attempts: Attempts;
    try { attempts = JSON.parse(sessionStorage.getItem(ATTEMPTS) ?? 'null') as Attempts ?? { entries: [], at: 0 }; }
    catch { attempts = { entries: [], at: 0 }; }
    if (!Array.isArray(attempts.entries)) attempts = { entries: [], at: 0 };
    if (!attempts.entries.includes(entry)) attempts.entries.push(entry);
    let candidate: { entry: string; since: number } | null = null;
    let lastInput = Date.now(), composing = false, working = false, stopped = false;
    const safe = () => !stopped && !current.current.busy && !updateActivityBusy() && !composing
      && !document.querySelector('[role="dialog"], dialog[open]') && window.getSelection()?.isCollapsed !== false
      // Other editors aren't part of the saved chat draft. Wait until they have been closed or cleared.
      && ![...document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input:not([type=checkbox], [type=radio], [type=file], [type=button], [type=submit], [type=range], [type=color], [type=hidden]), textarea, [contenteditable="true"]')].some(el => !el.hasAttribute('data-update-draft') && (el.isContentEditable || !!el.value))
      && (hidden() || (!editable(document.activeElement) && Date.now() - lastInput >= IDLE_MS));
    const servedEntry = async () => {
      const response = await fetch(apiPath('/'), { cache: 'no-store', credentials: 'same-origin', signal: AbortSignal.timeout(8_000) }).catch(() => null);
      return response?.ok ? entryScript(await response.text().catch(() => '')) : null;
    };
    const check = async () => {
      if (working || stopped || !navigator.onLine) return;
      working = true;
      try {
        const served = await servedEntry();
        if (!served || served === entry) { candidate = null; return; }
        if (candidate?.entry !== served) candidate = { entry: served, since: Date.now() };
        if (attempts.entries.includes(served) || Date.now() - attempts.at < COOLDOWN_MS || Date.now() - candidate.since < SETTLE_MS || !safe()) return;
        // Refreshing the service-worker shell is asynchronous: check safety again at the actual reload,
        // and save the latest draft then, not the draft from before the network request.
        await reloadInto(served, async () => {
          if (await servedEntry() !== served || !safe()) return false;
          const next = { entries: [...attempts.entries, served].slice(-30), at: Date.now() };
          try { sessionStorage.setItem(ATTEMPTS, JSON.stringify(next)); } catch { return false; }
          if (!current.current.save()) return false;
          attempts = next;
          return true;
        });
      } catch (error) { console.warn('App update deferred:', error); }
      finally { working = false; }
    };
    checkNow.current = () => { void check(); };
    const input = () => { lastInput = Date.now(); };
    const start = () => { composing = true; input(); };
    const end = () => { composing = false; input(); };
    const visibility = () => { void check(); };
    const activity = ['input', 'keydown', 'pointerdown', 'wheel', 'touchmove'];
    for (const event of activity) document.addEventListener(event, input, true);
    document.addEventListener('compositionstart', start, true); document.addEventListener('compositionend', end, true);
    document.addEventListener('visibilitychange', visibility); window.addEventListener('kenan-app-visibility', visibility);
    window.addEventListener('online', visibility); window.addEventListener('focus', visibility);
    const poll = setInterval(() => void check(), CHECK_MS);
    // The short timer only runs the pending update; it makes no requests while there is no candidate.
    const idle = setInterval(() => { if (candidate && !attempts.entries.includes(candidate.entry) && Date.now() - attempts.at >= COOLDOWN_MS && safe()) void check(); }, 2000);
    void check();
    return () => {
      stopped = true; clearInterval(poll); clearInterval(idle); checkNow.current = () => {};
      for (const event of activity) document.removeEventListener(event, input, true);
      document.removeEventListener('compositionstart', start, true); document.removeEventListener('compositionend', end, true);
      document.removeEventListener('visibilitychange', visibility); window.removeEventListener('kenan-app-visibility', visibility);
      window.removeEventListener('online', visibility); window.removeEventListener('focus', visibility);
    };
  }, []);
}
