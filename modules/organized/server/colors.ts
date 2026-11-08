// Freezing chat colours (shared/colors.ts): chats from before stable colours, or of a person who has just switched to
// Organized, keep the colour their place in a list gave them, so nothing she sees changes colour.
import { positionColors } from '../../../shared/colors.js';
import type { ChatGroup } from '../../../shared/contract.js';
import type { Bus, Store } from '../../../server/types.js';

/** Saves, for each of her open topics without a colour, the colour the Organized screens show it in now, and pushes the
 *  changed rooms to her. Returns how many it set. */
export async function freezeColors(store: Store, bus: Bus, personId: string, listGroups: (owner: string) => Promise<ChatGroup[]>): Promise<number> {
  const [conversations, groups, agents] = await Promise.all([store.listConversations(personId), listGroups(personId), store.listAgents(personId, { includeArchived: true })]);
  const managers = agents.filter(a => a.role === 'manager'), main = managers.find(a => !a.archived)?.conversationId;
  const topics = conversations.filter(c => (!c.agentId || managers.some(a => a.id === c.agentId)) && c.id !== main);
  const colors = positionColors(topics, groups);
  let set = 0;
  for (const c of topics) {
    if (c.color !== null || c.agentId || c.archived) continue;
    const conversation = await store.updateConversation(c.id, personId, { color: colors.get(c.id)! });
    bus.toPerson(personId, { type: 'conversation', conversation });
    set++;
  }
  return set;
}
