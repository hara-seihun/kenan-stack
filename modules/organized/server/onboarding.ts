// Organized onboarding (Carol 2026-10-22): switching to Organized the first time posts a welcome from the person's
// Kenaznia in its chat, a plain message that starts no turn; the three first-visit tips and the 🌀 tip are marked seen with OK.
import type { Layout, Mark, Onboarding } from '../../../shared/contract.js';
import type { Deps } from '../../../server/types.js';
import { freezeColors } from './colors.js';
import type { ChatGroup } from '../../../shared/contract.js';

export const WELCOME = `👋 **Welcome to Organized!**

**The idea:** all your chats are **me, the same Kenaznia**, with the same memory. Chats just keep topics apart so things stay tidy. You can ask me anything from any chat, including here in Kenaznia, and I'll put my answer in the right chat and leave you a line saying where.

**Where things are:**
- **Home:** what's waiting on you today, what you've pinned, and this chat (Kenaznia).
- **Chats:** one chat per topic. **Projects** sit at the top: a project gathers several chats, to-dos and files around one bigger thing, ongoing or with a due date.
- **To-do:** your list. Say "add that to my to-dos" and I'll do it. Every morning, I clean out to-dos that no longer make sense.
- **🌀 The floating bubble** lets you talk or type to me from any page, without leaving what you're doing.

Everything is set up the way it works for Carol, but **you can change anything**: just tell me. To go back to the old layout: ☰ → Classic.`;

type LayoutDeps = Pick<Deps, 'store' | 'bus' | 'runtime' | 'person'>;

/** Saves the person's layout (the app's PUT /api/layout and the rooms tool). The first switch to Organized of a person with
 *  the extension and a Kenaznia here also welcomes them; without a Kenaznia the welcome waits for a later switch. */
export async function chooseLayout(deps: LayoutDeps, personId: string, layout: Layout, listGroups: (owner: string) => Promise<ChatGroup[]>): Promise<Layout> {
  const saved = await deps.store.setLayout(personId, layout);
  if (saved === 'organized') await freezeColors(deps.store, deps.bus, personId, listGroups);
  if (saved === 'organized' && deps.person(personId)?.extensions.includes('organized')) await welcome(deps, personId);
  deps.bus.toPerson(personId, { type: 'layout', layout: saved });
  return saved;
}

async function welcome(deps: LayoutDeps, personId: string): Promise<void> {
  if ((await deps.store.seenOf(personId)).includes('welcome')) return;
  const managerId = deps.runtime.managerFor(personId), manager = managerId ? await deps.store.getAgent(managerId) : null;
  if (!manager) return;
  const marked = await deps.store.markSeen(personId, 'welcome');
  if (!marked.added) return;
  const message = await deps.store.appendMessage({ conversationId: manager.conversationId, authorId: manager.id, role: 'assistant', display: 'shown', text: WELCOME });
  deps.bus.toConversation(manager.conversationId, { type: 'message', message });
  const conversation = await deps.store.getConversation(manager.conversationId, personId);
  if (conversation) deps.bus.toPerson(personId, { type: 'conversation', conversation });
  deps.bus.toPerson(personId, { type: 'seen', seen: marked.seen });
}

/** OK on a first-visit tip: it never shows again, on any of their devices. */
export async function tipSeen(deps: Pick<Deps, 'store' | 'bus'>, personId: string, tip: Mark): Promise<Onboarding[]> {
  const marked = await deps.store.markSeen(personId, tip);
  if (marked.added) deps.bus.toPerson(personId, { type: 'seen', seen: marked.seen });
  return marked.seen;
}
