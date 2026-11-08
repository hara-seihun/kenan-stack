// Transport projection for history pages and SSE: tool-call arguments and results are shortened to what a
// closed tool card shows (its title line), so a page stays small however large a tool call was. Opening a
// card fetches the whole message. What people and agents wrote (message text, text and thinking parts)
// always travels whole. The stored message is unchanged and served whole by
// GET /api/conversations/:id/messages/:messageId.
// A result's text block that is itself JSON (most tools answer that way) is cut to an outline that still parses: short
// strings and numbers kept, long strings cut, every list replaced by its count marker, objects two levels deep. That is
// what a closed card's line reads (a goal's title, how many items a search found) at about the size of a cut string.
import type { Message, MessagePart } from '../../shared/contract.js';

export const CLIP_STRING_CHARS = 320;
const HEAD_CHARS = 240, TAIL_CHARS = 60, LIST_ITEMS = 8, OUTLINE_CHARS = 120, OUTLINE_DEPTH = 2;
/** The marker standing for list items that were left out; web/toolData.ts counts lists through it. */
const more = (n: number) => `… ${n} more items not shown`;

type Clipped<T> = { value: T; clipped: boolean };

function clipString(value: string): Clipped<string> {
  if (value.length <= CLIP_STRING_CHARS) return { value, clipped: false };
  const omitted = value.length - HEAD_CHARS - TAIL_CHARS;
  return { value: `${value.slice(0, HEAD_CHARS)}\n… ${omitted.toLocaleString('en')} characters not shown …\n${value.slice(-TAIL_CHARS)}`, clipped: true };
}

function clipValue(value: unknown): Clipped<unknown> {
  if (typeof value === 'string') return clipString(value);
  if (Array.isArray(value)) {
    let clipped = value.length > LIST_ITEMS;
    const items = value.slice(0, LIST_ITEMS).map(item => { const c = clipValue(item); clipped ||= c.clipped; return c.value; });
    if (value.length > LIST_ITEMS) items.push(more(value.length - LIST_ITEMS));
    return { value: items, clipped };
  }
  if (value !== null && typeof value === 'object') {
    let clipped = false;
    const entries = Object.entries(value).map(([key, item]) => { const c = clipValue(item); clipped ||= c.clipped; return [key, c.value] as const; });
    return clipped ? { value: Object.fromEntries(entries), clipped } : { value, clipped };
  }
  return { value, clipped: false };
}

function outline(value: unknown, depth: number): unknown {
  if (typeof value === 'string') return value.length <= OUTLINE_CHARS ? value : `${value.slice(0, OUTLINE_CHARS - 1)}…`;
  if (Array.isArray(value)) return value.length ? [more(value.length)] : [];
  if (value !== null && typeof value === 'object') return depth >= OUTLINE_DEPTH ? '…' : Object.fromEntries(Object.entries(value).map(([k, v]) => [k, outline(v, depth + 1)]));
  return value;
}

function jsonOf(text: string): object | null {
  if (!/^\s*[[{]/.test(text)) return null;
  try { const v: unknown = JSON.parse(text); return v !== null && typeof v === 'object' ? v : null; } catch { return null; }
}

/** A content block: a long text block holding JSON becomes its outline; anything else is clipped like any value. */
function clipBlock(block: unknown): Clipped<unknown> {
  const b = block as { type?: unknown; text?: unknown } | null;
  if (b && b.type === 'text' && typeof b.text === 'string' && b.text.length > CLIP_STRING_CHARS) {
    const json = jsonOf(b.text);
    if (json) return { value: { ...b, text: JSON.stringify(outline(json, 0)) }, clipped: true };
  }
  return clipValue(block);
}

/** Tool results are JSON text; clip inside the JSON so the client can still parse it. */
function clipResult(result: string | null): Clipped<string | null> {
  if (result === null || result.length <= CLIP_STRING_CHARS) return { value: result, clipped: false };
  let parsed: unknown;
  try { parsed = JSON.parse(result); } catch { return clipString(result); }
  const envelope = parsed as { content?: unknown } | null;
  if (envelope && typeof envelope === 'object' && !Array.isArray(envelope) && Array.isArray(envelope.content)) {
    let clipped = false;
    const entries = Object.entries(envelope).map(([key, item]) => {
      const c: Clipped<unknown> = key === 'content'
        ? (() => { const blocks = (item as unknown[]).map(clipBlock); return { value: blocks.map(b => b.value), clipped: blocks.some(b => b.clipped) }; })()
        : clipValue(item);
      clipped ||= c.clipped;
      return [key, c.value] as const;
    });
    return { value: JSON.stringify(Object.fromEntries(entries)), clipped };
  }
  const c = clipValue(parsed);
  return { value: JSON.stringify(c.value), clipped: c.clipped };
}

function clipPart(part: MessagePart): Clipped<MessagePart> {
  switch (part.type) {
    case 'text': case 'thinking': case 'image': case 'file': case 'question': case 'seal': return { value: part, clipped: false };
    case 'tool': {
      const args = clipValue(part.args), result = clipResult(part.result);
      return args.clipped || result.clipped ? { value: { ...part, args: args.value, result: result.value }, clipped: true } : { value: part, clipped: false };
    }
  }
}

export function clipMessage(message: Message): Message {
  const parts = message.parts.map(clipPart);
  if (!parts.some(p => p.clipped)) return message;
  return { ...message, parts: parts.map(p => p.value), clipped: true };
}
