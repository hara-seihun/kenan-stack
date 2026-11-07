// Origin routing (server/agents/origin.ts): a person on the Organized layout works in topic chats rather than one main
// Kenaznia chat, so background answers about work go back to the chat where the work was asked.
import type { PersonConfig } from '../../../server/config.js';
import type { Deps } from '../../../server/types.js';
import { hasOrganized } from './people.js';

/** Routing is on for a person with the module whose saved layout is Organized. */
export async function organizedRoutesByChat(deps: Pick<Deps, 'store'>, person: PersonConfig): Promise<boolean> {
  return hasOrganized(person) && await deps.store.layoutOf(person.id) === 'organized';
}
