import type { Message } from '../shared/contract.js';

/** Silent messages are never drawn; assistant tool declarations are hidden once their tool message carries the call. */
function visibleMessages(messages: Message[]): Message[] {
  const completed = new Set(messages.flatMap(m => m.role === 'tool' ? m.parts.flatMap(p => p.type === 'tool' ? [p.callId] : []) : []));
  return messages.flatMap(m => {
    if (m.display === 'silent') return [];
    const shown = m.role === 'assistant' && m.parts.some(p => p.type === 'tool' && completed.has(p.callId)) ? { ...m, parts: m.parts.filter(p => p.type !== 'tool' || !completed.has(p.callId)) } : m;
    return shown.text || shown.parts.length ? [shown] : [];
  });
}

/** A transcript row: a message, or a run of consecutive background messages drawn as one collapsed line. `updates` counts the background inputs (notices) in the run. */
export type Row = { kind: 'message'; message: Message } | { kind: 'background'; id: string; messages: Message[]; updates: number } | { kind: 'work'; id: string; messages: Message[] };

/** A shown agent message that carries only work (tool calls or thinking), no words or files for the person. */
export function isWorkOnly(message: Message): boolean {
  if (message.role === 'human' || message.role === 'notice') return false;
  const toolEcho = message.role === 'tool' && message.parts.some(p => p.type === 'tool' && p.name === message.text);
  if (message.text.trim() && !toolEcho) return false;
  return message.parts.length > 0 && message.parts.every(p => p.type === 'tool' || p.type === 'thinking');
}

/** With `foldWork`, each run of consecutive work-only messages becomes one small expandable "work" row. */
export function transcriptRows(messages: Message[], options: { foldWork?: boolean } = {}): Row[] {
  const rows: Row[] = [];
  for (const message of visibleMessages(messages)) {
    const last = rows.at(-1);
    const update = message.role === 'notice' ? 1 : 0;
    if (message.display === 'shown' && options.foldWork && isWorkOnly(message)) {
      if (last?.kind === 'work') last.messages.push(message);
      else rows.push({ kind: 'work', id: message.id, messages: [message] });
    }
    else if (message.display === 'shown') rows.push({ kind: 'message', message });
    else if (last?.kind === 'background') { last.messages.push(message); last.updates += update; }
    else rows.push({ kind: 'background', id: message.id, messages: [message], updates: update });
  }
  return rows;
}

/** "3 background updates", or "Background work" for a run of an agent's work whose inputs left no notice (history from before notices recorded every input). */
export function backgroundLabel(row: Extract<Row, { kind: 'background' }>): string {
  if (!row.updates) return 'Background work';
  return row.updates === 1 ? '1 background update' : `${row.updates} background updates`;
}

/** "6 steps · Shell, Browser, Read file" for a folded run of work. Thinking counts as a step but is not named. */
export function workLabel(row: Extract<Row, { kind: 'work' }>, title: (name: string) => string): string {
  const parts = row.messages.flatMap(m => m.parts);
  const tools = parts.flatMap(p => p.type === 'tool' ? [p] : []);
  const steps = new Set(tools.map(p => p.callId)).size + parts.filter(p => p.type === 'thinking').length;
  const names = [...new Set(tools.map(p => title(p.name)))];
  const shown = names.slice(0, 3).join(', ') + (names.length > 3 ? '…' : '');
  return `${steps === 1 ? '1 step' : `${steps} steps`}${shown ? ` · ${shown}` : ''}`;
}
