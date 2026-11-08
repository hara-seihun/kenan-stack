// Web Push on this device: an installed web app (on iPhone, Safari's Share → Add to Home Screen; iOS 16.4+) subscribes
// with the server's VAPID key, and the service worker (public/sw.js) shows each agent notification.
// The Android app's WebView has no Push API; its notifications come through the native app.
import { useCallback, useEffect, useState } from 'react';
import type { WebPushSubscription, WebPushTest } from '../shared/contract.js';
import { api } from './client.js';

/** Close delivered system notifications, without changing unread state or the push subscription. */
export async function clearDeliveredNotifications(conversationId?: string, throughId?: number): Promise<void> {
  if (!('serviceWorker' in navigator)) return;
  const registration = await navigator.serviceWorker.getRegistration();
  if (!registration) return;
  // Ask the worker too, so it can finish the operation if this page closes. Direct closure also works
  // during an update while the previous worker (which does not handle this message) is still active.
  registration.active?.postMessage({ type: 'kenan-clear-notifications', conversationId, throughId });
  for (const notification of await registration.getNotifications()) {
    const data = notification.data;
    if (conversationId === undefined || (data?.conversationId === conversationId &&
      (typeof data.id !== 'number' || (throughId !== undefined && data.id <= throughId)))) notification.close();
  }
}

/** Opening or returning to the app clears this device's delivered alerts, including while offline. */
export function installNotificationClearing(): void {
  const clear = () => {
    if (document.visibilityState !== 'hidden') void clearDeliveredNotifications().catch(error => console.warn('Notification clearing failed:', error));
  };
  clear();
  for (const type of ['pageshow', 'focus']) window.addEventListener(type, clear);
  for (const type of ['visibilitychange', 'resume']) document.addEventListener(type, clear);
  navigator.serviceWorker?.addEventListener('controllerchange', clear);
}

export type PushState =
  | { kind: 'unsupported' }       // no Push API here (Android app WebView, older browsers)
  | { kind: 'install-first' }     // iPhone/iPad Safari tab: push exists only in the home-screen app
  | { kind: 'denied' }            // notifications blocked for this app in the system settings
  | { kind: 'checking' }          // reading whether this device already has a subscription
  | { kind: 'off' }
  | { kind: 'working' }
  | { kind: 'on' }
  | { kind: 'failed'; message: string; origin: 'tap' | 'open' };

const DISMISS_KEY = 'kenan-push-banner-dismissed';
/** The endpoint this device last registered with the server, so a newer subscription replaces it there. */
const ENDPOINT_KEY = 'kenan-push-endpoint';
const appleMobile = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
export const installedApp = () => window.matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
const pushAvailable = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

function initialState(): PushState {
  if (!pushAvailable()) return appleMobile() && !installedApp() ? { kind: 'install-first' } : { kind: 'unsupported' };
  if (Notification.permission === 'denied') return { kind: 'denied' };
  return { kind: 'checking' };
}

/** A device with a subscription is on: it exists only once permission was granted, and revoking that reads as "denied". */
export const openedState = (subscribed: boolean): PushState => subscribed ? { kind: 'on' } : { kind: 'off' };

/** The banner offers notifications in an installed app only once this device is known to have none (never while checking
 *  or after a failed background re-registration on open), and shows what went wrong after a tap, until dismissed. */
export const pushBanner = (state: PushState, dismissed: boolean, installed: boolean): boolean =>
  !dismissed && installed && (state.kind === 'off' || (state.kind === 'failed' && state.origin === 'tap'));

const subscriptionBody = (subscription: PushSubscription): WebPushSubscription => {
  const json = subscription.toJSON();
  if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) throw new Error('The browser returned an incomplete push subscription');
  return { endpoint: json.endpoint, keys: { p256dh: json.keys.p256dh, auth: json.keys.auth } };
};
const testText = (test: WebPushTest): string | null => {
  switch (test.kind) {
    case 'delivered': return null;
    case 'gone': return `The push service says this subscription no longer exists (HTTP ${test.status}). Try again.`;
    case 'rejected': return `The push service refused the test notification (HTTP ${test.status}): ${test.reason}`;
    case 'unreachable': return `The push service could not be reached: ${test.reason}`;
  }
};
const keyBytes = (base64url: string) => Uint8Array.from(atob(base64url.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));

const failure = (e: unknown, origin: 'tap' | 'open'): PushState => ({ kind: 'failed', message: String((e as Error)?.message ?? e), origin });

/** Registers this device's subscription with the server, retiring the endpoint it registered before if that changed. */
async function register(subscription: PushSubscription, confirm: boolean): Promise<WebPushTest | null> {
  const previous = localStorage.getItem(ENDPOINT_KEY);
  const { test } = await api<{ test: WebPushTest | null }>('/push/subscriptions', 'POST', { subscription: subscriptionBody(subscription), confirm, replaces: previous === subscription.endpoint ? null : previous });
  localStorage.setItem(ENDPOINT_KEY, subscription.endpoint);
  return test;
}

/** This device's push state; on open, an existing subscription is re-registered so the server always has it. */
export function useWebPush(signedIn: boolean) {
  const [state, setState] = useState<PushState>(initialState);
  const [dismissed, setDismissed] = useState(() => localStorage.getItem(DISMISS_KEY) === '1');
  const [existing, setExisting] = useState<PushSubscription | null>(null);

  // getRegistration answers at once (undefined before the service worker is first registered); ready would wait for it.
  useEffect(() => {
    if (initialState().kind !== 'checking') return;
    let cancelled = false;
    void (async () => {
      const subscription = await (await navigator.serviceWorker.getRegistration())?.pushManager.getSubscription() ?? null;
      if (cancelled) return;
      setExisting(subscription);
      setState(current => current.kind === 'checking' ? openedState(subscription !== null) : current);
    })().catch(e => { if (!cancelled) setState(failure(e, 'open')); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!signedIn || !existing) return;
    let cancelled = false;
    register(existing, false).catch(e => { if (!cancelled) setState(current => current.kind === 'on' ? failure(e, 'open') : current); });
    return () => { cancelled = true; };
  }, [signedIn, existing]);

  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    const open = (event: MessageEvent) => {
      if (event.data?.type === 'kenan-open-conversation') window.dispatchEvent(new CustomEvent('kenan-open-conversation', { detail: { conversationId: event.data.conversationId }, cancelable: true }));
    };
    navigator.serviceWorker.addEventListener('message', open);
    return () => navigator.serviceWorker.removeEventListener('message', open);
  }, []);

  /** Must run straight from a tap: iOS only asks for permission inside a user gesture. */
  const enable = useCallback(() => {
    setState({ kind: 'working' });
    const permission = Notification.requestPermission();
    void (async () => {
      if (await permission !== 'granted') { setState(Notification.permission === 'denied' ? { kind: 'denied' } : { kind: 'off' }); return; }
      const { publicKey } = await api<{ publicKey: string }>('/push');
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription() ?? await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) });
      const test = await register(subscription, true);
      const problem = test ? testText(test) : null;
      setState(problem ? { kind: 'failed', message: problem, origin: 'tap' } : { kind: 'on' });
    })().catch(e => setState(failure(e, 'tap')));
  }, []);

  const dismiss = () => { localStorage.setItem(DISMISS_KEY, '1'); setDismissed(true); };

  /** Turning notifications off in Settings is a choice, so the banner doesn't ask again. */
  const disable = useCallback(() => {
    setState({ kind: 'working' });
    void (async () => {
      const subscription = await (await navigator.serviceWorker.ready).pushManager.getSubscription();
      if (subscription) { await api('/push/subscriptions', 'DELETE', { endpoint: subscription.endpoint }); await subscription.unsubscribe(); }
      localStorage.removeItem(ENDPOINT_KEY);
      dismiss();
      setState({ kind: 'off' });
    })().catch(e => setState(failure(e, 'tap')));
  }, []);

  return { state, enable, disable, banner: pushBanner(state, dismissed, installedApp()), dismiss };
}
