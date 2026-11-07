import { publicToolArgs } from '../tools/seal-guess.js';
// A tool call the model is still writing (Alice 2026-11-01: a long Write showed nothing for a minute, so the agent looked
// halted). The app draws it as a live card from `tool_draft` events, at most one per call every TOOL_DRAFT_MS; nothing
// is stored, and the settled message replaces it (an aborted or failed message drops the calls that never ran).
import type { ToolPart } from '../../shared/contract.js';

export const TOOL_DRAFT_MS = 250;
/** Long strings travel as their newest text, so a big file's preview stays a few KB however long it grows. */
export const DRAFT_TAIL_CHARS = 3000;

function tail(value: string): string {
  if (value.length <= DRAFT_TAIL_CHARS) return value;
  const start = value.length - DRAFT_TAIL_CHARS, line = value.indexOf('\n', start);
  return `…\n${value.slice(line >= 0 && line < value.length - 1 ? line + 1 : start)}`;
}

/** The partial call as the app draws it: long strings cut to their end, with the size of the arguments so far. */
export function toolDraft(callId: string, name: string, args: unknown): ToolPart {
  let chars = 0, longest = '';
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') { chars += v.length; if (v.length > longest.length) longest = v; return tail(v); }
    if (Array.isArray(v)) return v.map(walk);
    if (v !== null && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, item]) => [k, walk(item)]));
    return v;
  };
  const shown = walk(publicToolArgs(name, args));
  const lines = longest ? longest.split('\n').length : 0;
  return { type: 'tool', callId, name, args: shown, result: null, isError: false, draft: { chars, lines } };
}

const base = (p: unknown) => typeof p === 'string' ? p.replace(/\/+$/, '').split('/').pop() ?? '' : '';
/** The activity line while a call is being written: "Writing lib.rs (312 lines)". */
export function draftLabel(part: ToolPart): string {
  const a = (part.args ?? {}) as Record<string, unknown>;
  const what = part.name === 'write' ? `Writing ${base(a.path) || 'a file'}` : part.name === 'edit' ? `Editing ${base(a.path) || 'a file'}` : part.name === 'bash' ? 'Writing a command' : `Preparing ${part.name.replace(/_/g, ' ')}`;
  const lines = part.draft?.lines ?? 0;
  return lines > 1 ? `${what} (${lines.toLocaleString('en')} lines)` : what;
}
