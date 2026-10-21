// Transport projection for history pages and SSE: tool-call arguments and results are shortened to what a
// closed tool card shows (its title line), so a page stays small however large a tool call was. Opening a
// card fetches the whole message. What people and agents wrote (message text, text and thinking parts)
// always travels whole. The stored message is unchanged and served whole by
// GET /api/conversations/:id/messages/:messageId.
import type { Message, MessagePart } from '../../shared/contract.js';

export const CLIP_STRING_CHARS = 320;
const HEAD_CHARS = 240, TAIL_CHARS = 60, LIST_ITEMS = 8;

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
    if (value.length > LIST_ITEMS) items.push(`… ${value.length - LIST_ITEMS} more items not shown`);
    return { value: items, clipped };
  }
  if (value !== null && typeof value === 'object') {
    let clipped = false;
    const entries = Object.entries(value).map(([key, item]) => { const c = clipValue(item); clipped ||= c.clipped; return [key, c.value] as const; });
    return clipped ? { value: Object.fromEntries(entries), clipped } : { value, clipped };
  }
  return { value, clipped: false };
}

/** Tool results are JSON text; clip inside the JSON so the client can still parse it. */
function clipResult(result: string | null): Clipped<string | null> {
  if (result === null || result.length <= CLIP_STRING_CHARS) return { value: result, clipped: false };
  let parsed: unknown;
  try { parsed = JSON.parse(result); } catch { return clipString(result); }
  const c = clipValue(parsed);
  return { value: JSON.stringify(c.value), clipped: c.clipped };
}

function clipPart(part: MessagePart): Clipped<MessagePart> {
  switch (part.type) {
    case 'text': case 'thinking': case 'image': case 'file': return { value: part, clipped: false };
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
