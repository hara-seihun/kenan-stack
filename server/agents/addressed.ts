// Shared chats (two or more people): which person's Kenaznia a message is addressed to, decided here without a model
// call. Solo chats (one person and her agents) are not filtered.
import type { Message } from '../../shared/contract.js';

/** What every Kenan agent answers to besides its own name and id. */
export const KENAN_NAMES = ['Kenan', 'Kenaznia'] as const;

const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[’`]/g, "'");
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const word = (phrase: string) => new RegExp(`(?<![\\p{L}\\p{N}_])@?${escape(fold(phrase)).replace(/ /g, '\\s+')}(?![\\p{L}\\p{N}_])`, 'u');

/** Words for the whole group; with a question mark they make the message a question to everyone. */
const GROUP = ['everyone', 'everybody', 'anyone', 'anybody', 'all of you', 'you all', "y'all", 'you guys', 'tout le monde', 'vous tous', 'vous toutes', "quelqu'un", 'qqn'].map(word);
/** Asking everyone's opinion, question mark or not. */
const ASKS_ALL = [
  /\bwhat do (?:you all|y'all|you guys|all of you|we all) think\b/, /\bwhat does every(?:one|body) think\b/, /\b(?:any )?thoughts,? (?:every(?:one|body)|all|guys)\b/,
  /\bqu'en pensez[- ]vous\b/, /\bvous en pensez quoi\b/, /\bqu'est[- ]ce que vous en pensez\b/, /\bvos avis\b/, /\bvotre avis a tous\b/, /\bqu'en dites[- ]vous\b/,
];
/** The quote web/reply.ts puts first when she swipe-replies: "> **Author:** excerpt". */
const REPLY_HEAD = /^> \*\*(.+?):\*\*/;

export type Addressed = 'reply' | 'mention' | 'everyone';

/** A person's Kenaznia as a shared chat knows it: `shown` is the name its messages carry there; `own` are names that
 *  can only mean it ("Dave's Kenaznia", "Kenaznia Dave", its id). */
export interface ChatKenaznia { personId: string; shown: string; own: string[] }
export function chatKenaznia(person: { id: string; name: string }, shown: string): ChatKenaznia {
  return { personId: person.id, shown, own: [`${person.name}'s Kenaznia`, `${person.name}'s Kenan`, `Kenaznia ${person.name}`, `Kenaznia de ${person.name}`, `manager:${person.id}`] };
}

/**
 * Which Kenaznias in a shared chat a message is addressed to, and why. A reply to a Kenaznia's message, or a name only
 * it has, reaches that one. Otherwise "Kenan"/"Kenaznia"/"@kenaznia", or a question to everyone, reaches the writer's
 * own Kenaznia; when the writer has none, every Kenaznia there. Each Kenaznia acts for its own person only.
 */
export function chatTargets(text: string, authorId: string, kenaznias: readonly ChatKenaznia[]): Map<string, Addressed> {
  const out = new Map<string, Addressed>();
  const lines = text.split('\n');
  const quoted = REPLY_HEAD.exec(lines[0] ?? '')?.[1];
  const body = fold(lines.filter(l => !l.startsWith('>')).join('\n'));
  if (quoted !== undefined) for (const k of kenaznias) if ([k.shown, ...k.own].map(fold).includes(fold(quoted.trim()))) out.set(k.personId, 'reply');
  for (const k of kenaznias) if (!out.has(k.personId) && k.own.some(n => word(n).test(body))) out.set(k.personId, 'mention');
  if (out.size) return out;
  const generic: Addressed | null = KENAN_NAMES.some(n => word(n).test(body)) ? 'mention'
    : ASKS_ALL.some(r => r.test(body)) || (body.includes('?') && GROUP.some(r => r.test(body))) ? 'everyone' : null;
  if (!generic) return out;
  const own = kenaznias.filter(k => k.personId === authorId);
  for (const k of own.length ? own : kenaznias) out.set(k.personId, generic);
  return out;
}

/** What the people and the other Kenaznias said after the agent's newest message, before `before`, oldest first (from the newest page of the chat). */
export function sinceAgentSpoke(messages: Message[], agentId: string, before: string): Message[] {
  const upTo = messages.findIndex(m => m.id === before);
  const page = upTo < 0 ? messages : messages.slice(0, upTo);
  let last = -1;
  page.forEach((m, i) => { if (m.authorId === agentId && m.role === 'assistant') last = i; });
  return page.slice(last + 1).filter(m => m.role === 'human' || (m.role === 'assistant' && m.authorId !== agentId));
}
