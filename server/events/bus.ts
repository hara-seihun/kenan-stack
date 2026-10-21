// In-memory pub/sub per person. Conversation fan-out uses a cached member list; once cached,
// delivery is synchronous. While a lookup is pending, later events chain on the same promise,
// so per-conversation order is preserved.
import type { Activity, ServerEvent } from '../../shared/contract.js';
import type { Bus, Store } from '../types.js';

type Send = (event: ServerEvent) => void;

export function createBus(store: Pick<Store, 'conversationMembers'>): Bus {
  const subscribers = new Map<string, Set<Send>>();
  const activity = new Map<string, Activity>();
  const members = new Map<string, string[] | Promise<string[]>>();

  const toPerson = (personId: string, event: ServerEvent) => {
    for (const send of subscribers.get(personId) ?? []) {
      try { send(event); } catch (e) { console.error(JSON.stringify({ type: 'bus_send_error', personId, error: String(e) })); }
    }
  };
  const fanOut = (ids: string[], event: ServerEvent) => { for (const id of ids) toPerson(id, event); };

  return {
    toPerson,
    toConversation(conversationId, event) {
      if (event.type === 'activity') {
        if (event.activity) activity.set(conversationId, event.activity); else activity.delete(conversationId);
      }
      const cached = members.get(conversationId);
      if (Array.isArray(cached)) return fanOut(cached, event);
      let pending = cached;
      if (!pending) {
        pending = store.conversationMembers(conversationId);
        members.set(conversationId, pending);
        pending.then(ids => { if (members.get(conversationId) === pending) members.set(conversationId, ids); },
          () => { if (members.get(conversationId) === pending) members.delete(conversationId); });
      }
      pending.then(ids => fanOut(ids, event),
        e => console.error(JSON.stringify({ type: 'bus_members_error', conversationId, error: String(e) })));
    },
    subscribe(personId, send) {
      let set = subscribers.get(personId);
      if (!set) subscribers.set(personId, set = new Set());
      set.add(send);
      return () => { set.delete(send); if (!set.size) subscribers.delete(personId); };
    },
    invalidateMembers(conversationId) { members.delete(conversationId); },
    activity: conversationId => activity.get(conversationId) ?? null,
  };
}
