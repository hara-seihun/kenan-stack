import { isBackgroundQuotaPause } from '../shared/contract.js';
import { messageParts } from '../shared/message-parts.js';
import { backgroundFallback, type Message, type MessagePart, type ToolPart } from '../shared/contract.js';

/** Hydrated calls still open the original result message when its output was clipped. */
const toolMessages = new WeakMap<ToolPart, Message>();
export const toolMessage = (part: ToolPart, message: Message): Message => toolMessages.get(part) ?? message;

/** Keep calls where the assistant made them, filling their output from the later tool message.
 * A result without its declaration in this page still stands on its own. */
function visibleMessages(messages: Message[]): Message[] {
  const shown = messages.filter(m => m.display !== 'silent' && !(m.role === 'assistant' && m.state === 'error' && isBackgroundQuotaPause(m.text) && /^\s*429\b/.test(m.text))).map(m => m.role === 'assistant' && m.state === 'error' && isBackgroundQuotaPause(m.text) ? { ...m, display: 'background' as const } : m);
  const declarations = new Set(shown.flatMap(m => m.role === 'assistant' ? m.parts.flatMap(p => p.type === 'tool' ? [p.callId] : []) : []));
  const results = new Map(shown.flatMap(m => m.role === 'tool' ? m.parts.flatMap(p => p.type === 'tool' ? [[p.callId, { message: m, part: p }] as const] : []) : []));
  return shown.flatMap(m => {
    let message = m;
    if (m.role === 'assistant') {
      message = { ...m, parts: m.parts.map(p => {
        const result = p.type === 'tool' ? results.get(p.callId) : undefined;
        if (!result) return p;
        const part = result.part;
        toolMessages.set(part, result.message);
        return part;
      }) };
    } else if (m.role === 'tool' && m.parts.some(p => p.type === 'tool' && declarations.has(p.callId))) {
      const toolEcho = m.parts.some(p => p.type === 'tool' && p.name === m.text);
      message = { ...m, text: toolEcho ? '' : m.text, parts: m.parts.filter(p => p.type !== 'tool' || !declarations.has(p.callId)) };
    }
    return message.deletedAt || message.text || message.parts.length ? [message] : [];
  });
}

/** Each input, narration and action stands alone. No work is copied into an input's card. */
export type Row = { kind: 'message'; message: Message } | { kind: 'background'; id: string; messages: Message[] } | { kind: 'work'; id: string; messages: Message[] };

/** A shown agent message that carries only work (tool calls or thinking), no words or files for the person. */
export function isWorkOnly(message: Message): boolean {
  if (message.role === 'human' || message.role === 'notice') return false;
  const parts = messageParts(message);
  return parts.length > 0 && parts.every(p => p.type === 'tool' || p.type === 'thinking');
}

export function transcriptRows(messages: Message[]): Row[] {
  const rows: Row[] = [];
  for (const message of visibleMessages(messages)) {
    if (message.display === 'shown' && !isWorkOnly(message)) {
      rows.push({ kind: 'message', message });
      continue;
    }
    if (message.role === 'notice') {
      rows.push({ kind: 'background', id: message.id, messages: [message] });
      continue;
    }
    const parts = messageParts(message);
    let content: MessagePart[] = [];
    let contentStart = 0;
    let groups = 0;
    const flush = () => {
      if (!content.length) return;
      rows.push({
        kind: 'background', id: groups++ === 0 ? message.id : `${message.id}:content:${contentStart}`,
        messages: [{ ...message, text: content.flatMap(p => p.type === 'text' ? [p.text] : []).join(''), parts: content }],
      });
      content = [];
    };
    parts.forEach((part, index) => {
      if (part.type === 'tool' || part.type === 'thinking') {
        flush();
        rows.push({
          kind: 'work', id: `${message.id}:${part.type === 'tool' ? part.callId : index}`,
          messages: [{ ...message, text: '', parts: [part] }],
        });
      } else {
        if (!content.length) contentStart = index;
        content.push(part);
      }
    });
    flush();
  }
  return rows;
}

/** Saved notice summaries are summary-only; older inputs and orphan narration use their first words. */
export function backgroundLabel(row: Extract<Row, { kind: 'background' }>, names?: Map<string, string>): string {
  const input = row.messages[0]!;
  return input.backgroundSummary?.trim() || backgroundFallback(input, names?.get(input.authorId));
}

/** A single action's short summary, including thinking that has finished streaming. */
export function workLabel(row: Extract<Row, { kind: 'work' }>, title: (name: string) => string): string {
  const part = row.messages[0]?.parts[0];
  return part?.type === 'thinking' ? part.text : part?.type === 'tool' ? title(part.name) : '';
}
