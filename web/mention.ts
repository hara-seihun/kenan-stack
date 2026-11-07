// The composer's "@" completion: who a message can be addressed to. The server decides what a mention does
// (server/agents/addressed.ts chatTargets): "@kenaznia" is the writer's own Kenaznia, "@Dave's Kenaznia" is that person's.
import type { ConversationSummary, Person } from '../shared/contract.js';

const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[’`]/g, "'");

/** What can be mentioned in a chat, most useful first: your own Kenaznia, the other people's Kenaznias, then the people. Names are as inserted after the "@". */
export function mentionNames(me: Person, people: readonly Person[], chat: Pick<ConversationSummary, 'memberIds'> | undefined): string[] {
  const humans = (chat?.memberIds ?? []).flatMap(id => { const p = people.find(x => x.id === id); return p && p.kind === 'human' && p.id !== me.id ? [p] : []; });
  return ['kenaznia', ...humans.map(p => `${p.name}'s Kenaznia`), ...humans.map(p => p.name)];
}

export type MentionHit = { start: number; matches: string[] };

/** The "@do" being typed just before the caret, with the names it could become. Only after a space or the start, so "person7@example.com" never matches; a bare "@" lists everything. */
export function suggestMention(text: string, caret: number, names: readonly string[]): MentionHit | null {
  const typed = /(?:^|\s)@([^\s@]*)$/.exec(text.slice(0, caret));
  if (!typed) return null;
  const query = fold(typed[1]!);
  const matches = names.filter(n => fold(n).split(/\s+/).some(w => w.startsWith(query)) || fold(n).startsWith(query));
  return matches.length ? { start: caret - typed[1]!.length - 1, matches } : null;
}
