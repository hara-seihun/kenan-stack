import type { Message } from '../shared/contract.js';

/** What she is replying to: shown above the composer and quoted into the sent message. */
export interface ReplyTarget { messageId: string; author: string; excerpt: string; files: { id: string; name: string; image: boolean }[] }

const EXCERPT = 160;

/** The message's words, flattened to one line and shortened; empty when it is only files. */
export function excerptOf(text: string): string {
  const flat = text.replace(/```[\s\S]*?```/g, ' [code] ').replace(/^>.*$/gm, '').replace(/[*_`#]/g, '').replace(/\s+/g, ' ').trim();
  return flat.length > EXCERPT ? `${flat.slice(0, EXCERPT - 1).trimEnd()}…` : flat;
}

/** Whether a message can be replied to: shown words or files. */
export const canReply = (m: Message): boolean =>
  m.display === 'shown' && m.role !== 'tool' && m.role !== 'notice' && (m.text.trim() !== '' || m.parts.some(p => p.type === 'image' || p.type === 'file'));

export function replyTarget(m: Message, author: string): ReplyTarget {
  const files = m.parts.flatMap(p => p.type === 'image' ? [{ id: p.fileId, name: 'picture', image: true }] : p.type === 'file' ? [{ id: p.fileId, name: p.name, image: p.mime.startsWith('image/') }] : []);
  return { messageId: m.id, author, excerpt: excerptOf(m.text), files };
}

/** One line for the composer chip: "Kenaznia: the words…" or "Kenaznia: 🖼 picture". */
export function replyLabel(r: ReplyTarget): string {
  const what = r.excerpt || r.files.map(f => `${f.image ? '🖼' : '📎'} ${f.name}`).join(', ');
  return `${r.author}: ${what}`;
}

/**
 * The text actually sent: a Markdown quote of what she replies to, then her words. Agents read it as plain Markdown;
 * the quoted files are attached again (see App send) so an agent sees the very picture she means.
 */
export function withReply(text: string, r: ReplyTarget | null): string {
  if (!r) return text;
  const lines = [`> **${r.author}:** ${r.excerpt || ''}`.trimEnd()];
  for (const f of r.files) lines.push(`> ${f.image ? '🖼' : '📎'} ${f.name}`);
  return `${lines.join('\n')}\n\n${text}`;
}
