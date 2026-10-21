// Web Push on this device: an installed web app (on iPhone, Safari's Share → Add to Home Screen; iOS 16.4+) subscribes
// with the server's VAPID key, and the service worker (public/sw.js) shows each agent notification.
// The Android app's WebView has no Push API; its notifications come through the native app.
import { useCallback, useEffect, useState } from 'react';
import type { WebPushSubscription, WebPushTest } from '../shared/contract.js';
import { api } from './client.js';

export type PushState =
  | { kind: 'unsupported' }       // no Push API here (Android app WebView, older browsers)
  | { kind: 'install-first' }     // iPhone/iPad Safari tab: push exists only in the home-screen app
  | { kind: 'denied' }            // notifications blocked for this app in the system settings
  | { kind: 'off' }
  | { kind: 'working' }
  | { kind: 'on' }
  | { kind: 'failed'; message: string };

const DISMISS_KEY = 'kenan-push-banner-dismissed';
const appleMobile = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
export const installedApp = () => window.matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
const pushAvailable = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

function initialState(): PushState {
  if (!pushAvailable()) return appleMobile() && !installedApp() ? { kind: 'install-first' } : { kind: 'unsupported' };
  if (Notification.permission === 'denied') return { kind: 'denied' };
  return { kind: 'off' };
}

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

/** This device's push state; on open, an existing subscription is re-registered so the server always has it. */
export function useWebPush(signedIn: boolean) {
  const [state, setState] = useState<PushState>(initialState);
  const [dismissed, setDismissed] = useState(() => localStorage.getItem(DISMISS_KEY) === '1');

  useEffect(() => {
    if (!signedIn || !pushAvailable()) return;
    let cancelled = false;
    void (async () => {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      if (!subscription || cancelled) return;
      if (Notification.permission !== 'granted') return;
      await api('/push/subscriptions', 'POST', { subscription: subscriptionBody(subscription), confirm: false });
      if (!cancelled) setState({ kind: 'on' });
    })().catch(e => { if (!cancelled) setState({ kind: 'failed', message: String((e as Error)?.message ?? e) }); });
    return () => { cancelled = true; };
  }, [signedIn]);

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
      const existing = await registration.pushManager.getSubscription();
      const subscription = existing ?? await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) });
      const { test } = await api<{ test: WebPushTest | null }>('/push/subscriptions', 'POST', { subscription: subscriptionBody(subscription), confirm: true });
      const problem = test ? testText(test) : null;
      setState(problem ? { kind: 'failed', message: problem } : { kind: 'on' });
    })().catch(e => setState({ kind: 'failed', message: String((e as Error)?.message ?? e) }));
  }, []);

  const disable = useCallback(() => {
    setState({ kind: 'working' });
    void (async () => {
      const subscription = await (await navigator.serviceWorker.ready).pushManager.getSubscription();
      if (subscription) { await api('/push/subscriptions', 'DELETE', { endpoint: subscription.endpoint }); await subscription.unsubscribe(); }
      setState({ kind: 'off' });
    })().catch(e => setState({ kind: 'failed', message: String((e as Error)?.message ?? e) }));
  }, []);

  const dismiss = () => { localStorage.setItem(DISMISS_KEY, '1'); setDismissed(true); };
  /** The banner offers notifications in an installed app that has none yet, until dismissed. */
  const banner = !dismissed && installedApp() && (state.kind === 'off' || state.kind === 'failed');
  return { state, enable, disable, banner, dismiss };
}
