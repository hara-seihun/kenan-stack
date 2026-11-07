import type { Message, MessagePart } from './contract.js';

/** Ordered content is authoritative. Older rows kept only aggregate words; their thinking precedes those words. */
export function messageParts(message: Pick<Message, 'role' | 'text' | 'parts'>): MessagePart[] {
  const { role, text, parts } = message;
  if (role === 'human') return [...(text ? [{ type: 'text' as const, text }] : []), ...parts.filter(p => p.type !== 'text')];
  if (parts.some(p => p.type === 'text')) return parts;
  const toolEcho = role === 'tool' && parts.some(p => p.type === 'tool' && p.name === text);
  return [...parts.filter(p => p.type === 'thinking'), ...(!toolEcho && text ? [{ type: 'text' as const, text }] : []), ...parts.filter(p => p.type !== 'thinking')];
}

/** Partition ordered content by its text slices without moving thinking or calls past the words around them.
 * backgroundPieces removes marker lines and blank edges; each remaining body is an exact slice of sourceText. */
export function splitTextParts(parts: MessagePart[], sourceText: string, pieceTexts: string[]): MessagePart[][] {
  let search = 0;
  const ranges = pieceTexts.map(text => {
    const start = sourceText.indexOf(text, search);
    if (start < 0) throw new Error('message_text_piece_not_in_source');
    search = start + text.length;
    return { start, end: search };
  });
  const rows = ranges.map(() => [] as MessagePart[]);
  let offset = 0;
  for (const part of parts) {
    if (part.type === 'text') {
      const end = offset + part.text.length;
      ranges.forEach((range, index) => {
        const from = Math.max(offset, range.start), to = Math.min(end, range.end);
        if (from < to) rows[index]!.push({ ...part, text: part.text.slice(from - offset, to - offset) });
      });
      offset = end;
    } else if (rows.length) {
      const index = ranges.findIndex(range => offset <= range.end);
      rows[index < 0 ? rows.length - 1 : index]!.push(part);
    }
  }
  return rows;
}

/** Replace the streamed aggregate, retaining content before a marker's corrected tail in its original position. */
export function replacePartsText(parts: MessagePart[], text: string): MessagePart[] {
  const before = parts.flatMap(p => p.type === 'text' ? [p.text] : []).join('');
  let common = 0;
  while (common < before.length && common < text.length && before[common] === text[common]) common++;
  let remaining = common;
  const next = parts.flatMap((p): MessagePart[] => {
    if (p.type !== 'text') return [p];
    const kept = p.text.slice(0, remaining); remaining -= kept.length;
    return kept ? [{ ...p, text: kept }] : [];
  });
  const delta = text.slice(common), last = next.at(-1);
  if (delta) {
    if (last?.type === 'text') next[next.length - 1] = { ...last, text: last.text + delta };
    else next.push({ type: 'text', text: delta });
  }
  return next;
}
