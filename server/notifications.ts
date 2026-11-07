// Phone notifications: an agent's notify call is stored, streamed to the owner's Android app (GET /api/notifications)
// and pushed to every Web Push subscription the owner has (installed web apps, e.g. an iPhone home-screen app).
import type { AgentInfo, NotificationLevel, PhoneNotification } from '../shared/contract.js';
import type { Deps } from './types.js';
import { quietHoursStatus, nextQuietStart } from './quiet-hours.js';
import { hostedManager } from './config.js';
import { pushOptions, pushPayload } from './web-push.js';

const streams = new Map<string, number>();
/** Streams from a phone whose app has Kenan's accessibility service on (GET /api/notifications?phone=1). */
const settings = new Map<string, number>();
const settingsOpened = new Set<(personId: string) => void>();
export function onSettingsPhone(listener: (personId: string) => void): () => void { settingsOpened.add(listener); return () => { settingsOpened.delete(listener); }; }
export const phoneSettingsConnected = (personId: string) => settings.has(personId);
const controllable = new Map<string, number>();
const controllableOpened = new Set<(personId: string) => void>();

function count(map: Map<string, number>, personId: string): () => void {
  map.set(personId, (map.get(personId) ?? 0) + 1);
  let open = true;
  return () => {
    if (!open) return;
    open = false;
    const left = map.get(personId)! - 1;
    if (left) map.set(personId, left); else map.delete(personId);
  };
}

/** Counts an open phone stream for the person until the returned release is called. */
export function openStream(personId: string, phoneControl: boolean, phoneSettings = false): () => void {
  const releaseStream = count(streams, personId);
  const releaseSettings = phoneSettings ? count(settings, personId) : () => {};
  if (phoneSettings) for (const listener of settingsOpened) listener(personId);
  const release = () => { releaseStream(); releaseSettings(); };
  if (!phoneControl) return release;
  const releaseControl = count(controllable, personId);
  for (const listener of controllableOpened) listener(personId);
  return () => { release(); releaseControl(); };
}
export const phoneControllable = (personId: string) => controllable.has(personId);
export function onControllablePhone(listener: (personId: string) => void): () => void {
  controllableOpened.add(listener);
  return () => { controllableOpened.delete(listener); };
}

/** Sends the notification to each of the person's Web Push subscriptions; returns how many push services accepted it. */
export async function pushToDevices(deps: Deps, personId: string, notification: PhoneNotification): Promise<number> {
  const subscriptions = await deps.store.pushSubscriptions(personId);
  if (!subscriptions.length) return 0;
  const sender = deps.webPush;
  if (sender.kind === 'unavailable') { await deps.store.logError('web_push', `web_push_unavailable: ${sender.reason}; ${subscriptions.length} subscription(s) of ${personId} not sent notification ${notification.id}`); return 0; }
  const expiresAt = notification.level === 'normal' && notification.quietHours?.enabled ? nextQuietStart(deps.now(), notification.quietHours) : undefined;
  const payload = pushPayload({ ...notification, expiresAt }), options = pushOptions(notification.level);
  if (expiresAt !== undefined) options.ttlSeconds = Math.max(0, Math.min(options.ttlSeconds, Math.floor((expiresAt - deps.now()) / 1000)));
  const outcomes = await Promise.all(subscriptions.map(async subscription => ({ subscription, outcome: await sender.send(subscription, payload, options) })));
  let delivered = 0;
  for (const { subscription, outcome } of outcomes) {
    switch (outcome.kind) {
      case 'delivered': delivered++; break;
      case 'gone': await deps.store.deletePushSubscription(subscription.endpoint, personId); break;
      case 'rejected': await deps.store.logError('web_push', `web_push_rejected: HTTP ${outcome.status} from ${new URL(subscription.endpoint).origin} for ${personId} notification ${notification.id}: ${outcome.reason}`); break;
      case 'unreachable': await deps.store.logError('web_push', `web_push_unreachable: ${new URL(subscription.endpoint).origin} for ${personId} notification ${notification.id}: ${outcome.reason}`); break;
    }
  }
  return delivered;
}

/** Deliver an existing notification, never replaying an alert held during quiet hours. */
export async function deliverNotification(deps: Deps, personId: string, notification: PhoneNotification) {
  const quietHours = await quietHoursStatus(deps, personId);
  const held = notification.quietHeld || (quietHours.active && notification.level !== 'urgent');
  if (held) {
    await deps.store.holdNotification(personId, notification.id);
    return { notification, held: true, quietHours, connectedPhones: 0, webAppDevices: 0 };
  }
  const delivery = { ...notification, quietHours };
  deps.bus.toPerson(personId, { type: 'notification', notification: delivery });
  return { notification: delivery, held: false, quietHours, connectedPhones: streams.get(personId) ?? 0, webAppDevices: await pushToDevices(deps, personId, delivery) };
}

/** conversationId: the chat tapping it opens. Held alerts remain stored but never enter either push transport. */
const notificationWrites = new Set<Promise<unknown>>();
export async function drainNotificationWrites(): Promise<void> { await Promise.allSettled([...notificationWrites]); }
export async function notify(deps: Deps, personId: string, agent: AgentInfo, conversationId: string, input: { title: string; body: string; level: NotificationLevel; imageFileId: string | null; collapseKey?: string }) {
  const task = notifyNow(deps, personId, agent, conversationId, input);
  notificationWrites.add(task);
  try { return await task; } finally { notificationWrites.delete(task); }
}
async function notifyNow(deps: Deps, personId: string, agent: AgentInfo, conversationId: string, input: { title: string; body: string; level: NotificationLevel; imageFileId: string | null; collapseKey?: string }) {
  const quietHours = await quietHoursStatus(deps, personId);
  const quietHeld = quietHours.active && input.level !== 'urgent';
  const notification = await deps.store.createNotification({ personId, agentId: agent.id, conversationId, ...input, quietHeld });
  return deliverNotification(deps, personId, notification);
}

/** The claim is durable and atomic across restarts and concurrent ticks. Individual alerts stay held forever. */
export async function flushQuietSummary(deps: Deps, personId: string) {
  if ((await quietHoursStatus(deps, personId)).active) return null;
  const manager = await deps.store.getAgent(`manager:${personId}`);
  if (!manager) return null;
  const count = await deps.store.claimQuietSummary(personId);
  if (!count) return null;
  return notify(deps, personId, manager, manager.conversationId, {
    title: `${count} new message${count === 1 ? '' : 's'} overnight`, body: 'Open Kenan to catch up.', level: 'normal', imageFileId: null,
  });
}

export function startQuietSummaries(deps: Deps): () => void {
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      for (const p of deps.config.people) if (hostedManager(p)) await flushQuietSummary(deps, p.id);
    } catch (e) { await deps.store.logError('quiet_hours', String(e)).catch(() => {}); }
    finally { busy = false; }
  };
  void tick();
  const timer = setInterval(() => void tick(), 15_000);
  timer.unref();
  return () => clearInterval(timer);
}

/** A read on any device withdraws the delivered alerts on connected devices and survives a disconnect. */
export async function clearChatNotifications(deps: Deps, personId: string, conversationId: string): Promise<void> {
  const throughId = await deps.store.dismissNotifications(personId, conversationId);
  if (throughId !== null) {
    deps.bus.toPerson(personId, { type: 'notifications_cleared', conversationId, throughId });
    // A sleeping installed web app has no SSE stream. Its service worker can still withdraw previews.
    const sender = deps.webPush;
    if (sender.kind === 'ready') {
      const payload = JSON.stringify({ type: 'notifications_cleared', conversationId, throughId });
      await Promise.all((await deps.store.pushSubscriptions(personId)).map(s => sender.send(s, payload, { ttlSeconds: 86400, urgency: 'high' })));
    }
  }
}
