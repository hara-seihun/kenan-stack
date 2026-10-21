// Phone notifications: an agent's notify call is stored, streamed to the owner's Android app (GET /api/notifications)
// and pushed to every Web Push subscription the owner has (installed web apps, e.g. an iPhone home-screen app).
import type { AgentInfo, NotificationLevel, PhoneNotification } from '../shared/contract.js';
import type { Deps } from './types.js';
import { pushOptions, pushPayload } from './web-push.js';

const streams = new Map<string, number>();

/** Counts an open phone stream for the person until the returned release is called. */
export function openStream(personId: string): () => void {
  streams.set(personId, (streams.get(personId) ?? 0) + 1);
  let open = true;
  return () => {
    if (!open) return;
    open = false;
    const left = streams.get(personId)! - 1;
    if (left) streams.set(personId, left); else streams.delete(personId);
  };
}

/** Sends the notification to each of the person's Web Push subscriptions; returns how many push services accepted it. */
export async function pushToDevices(deps: Deps, personId: string, notification: PhoneNotification): Promise<number> {
  const subscriptions = await deps.store.pushSubscriptions(personId);
  if (!subscriptions.length) return 0;
  const sender = deps.webPush;
  if (sender.kind === 'unavailable') { await deps.store.logError('web_push', `web_push_unavailable: ${sender.reason}; ${subscriptions.length} subscription(s) of ${personId} not sent notification ${notification.id}`); return 0; }
  const payload = pushPayload(notification), options = pushOptions(notification.level);
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

export async function notify(deps: Deps, personId: string, agent: AgentInfo, input: { title: string; body: string; level: NotificationLevel; imageFileId: string | null }): Promise<{ notification: PhoneNotification; connectedPhones: number; webAppDevices: number }> {
  const notification = await deps.store.createNotification({ personId, agentId: agent.id, conversationId: agent.conversationId, ...input });
  deps.bus.toPerson(personId, { type: 'notification', notification });
  return { notification, connectedPhones: streams.get(personId) ?? 0, webAppDevices: await pushToDevices(deps, personId, notification) };
}
