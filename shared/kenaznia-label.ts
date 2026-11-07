// In a chat with two or more people, every Kenaznia is named for its owner ("Alice's Kenaznia") and has its owner's colour,
// whichever channel's database names it, so two people's Kenaznias never look alike. Pure: server and web agree here.
import { MEMBER_COLORS } from './colors.js';

interface Named { id: string; name: string; kind: string }

const MANAGER = 'manager:';

/** Names for a chat's authors: the people as given, with each Kenaznia renamed after its owner when the chat has several humans. */
export function authorNames(people: readonly Named[], memberIds: readonly string[] | undefined): Map<string, string> {
  const names = new Map(people.map(p => [p.id, p.name]));
  const humans = (memberIds ?? []).filter(id => people.find(p => p.id === id)?.kind === 'human').length;
  if (humans < 2) return names;
  for (const p of people) {
    if (p.kind !== 'agent' || !p.id.startsWith(MANAGER)) continue;
    const owner = people.find(o => o.id === p.id.slice(MANAGER.length) && o.kind === 'human');
    if (owner) names.set(p.id, `${owner.name}'s Kenaznia`);
  }
  return names;
}

/** Each person's Kenaznia's own colour in shared chats, set by its owner's choice. A Kenaznia not listed gets a stable colour
 *  from the palette below, which has no silver, so it never matches a chosen one; owners' own colours are the readers' to set. */
export const KENAZNIA_COLORS: Readonly<Record<string, string>> = {
  alice: '#C0C0C8',
};

/** The colour of a Kenaznia's messages in a shared chat, the same on every channel; none for anyone else. */
export function kenazniaTint(authorId: string): string | undefined {
  if (!authorId.startsWith(MANAGER)) return undefined;
  const owner = authorId.slice(MANAGER.length);
  const chosen = KENAZNIA_COLORS[owner];
  if (chosen) return chosen;
  let h = 0;
  for (const ch of owner) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const taken = new Set(Object.values(KENAZNIA_COLORS).map(c => c.toLowerCase()));
  const free = MEMBER_COLORS.map(([c]) => c as string).filter(c => !taken.has(c.toLowerCase()));
  return free[h % free.length];
}
