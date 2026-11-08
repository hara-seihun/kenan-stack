// Reading tool calls for their cards: a result's text blocks, images and JSON, lists in it, and the friendly time and
// number formats every card uses. The cards themselves are in toolViews.tsx.
import type { ToolPart } from '../shared/contract.js';
import { formatDate } from './dates.js';

export type { ToolPart };
export type Data = Record<string, unknown>;
export const object = (v: unknown): Data => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Data : {};
export const text = (v: unknown): string => typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : '';
export const words = (v: string) => v.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]/g, ' ');
export const cap = (v: string) => v.charAt(0).toUpperCase() + v.slice(1);

/** A tool result as tools send it: text blocks, images and the tool's own details. A result that isn't the usual envelope is one text block. */
export type Outcome = { texts: string[]; images: { data: string; mime: string }[]; details: Data };
export function outcome(result: string): Outcome {
  let v: unknown; try { v = JSON.parse(result); } catch { return { texts: [result], images: [], details: {} }; }
  const e = object(v);
  if (!Array.isArray(e.content)) return { texts: [typeof v === 'string' ? v : result], images: [], details: {} };
  const blocks = e.content.map(object);
  return {
    texts: blocks.filter(b => b.type === 'text').map(b => text(b.text)),
    images: blocks.filter(b => b.type === 'image' && typeof b.data === 'string').map(b => ({ data: text(b.data), mime: text(b.mimeType) || 'image/png' })),
    details: { ...object(e.structuredContent), ...object(e.details) },
  };
}
/** The JSON a text block holds, also after a leading comment line (mail sends begin with "# from: …"); null when it holds none. */
export function json(t: string | undefined): unknown {
  if (!t) return null;
  const at = t.search(/^[[{]/m); if (at < 0) return null;
  try { return JSON.parse(t.slice(at)); } catch { return null; }
}
const MORE = /^… ([\d,]+) more items not shown$/;
/** Items in a list, counting the ones a clipped list stands in for. */
export const countOf = (list: unknown[]) => list.reduce<number>((n, item) => { const m = typeof item === 'string' && MORE.exec(item); return n + (m ? Number(m[1]!.replace(/,/g, '')) : 1); }, 0);
/** The list a result holds: the result itself, or its first list field (items, results, pending…). */
export function listIn(v: unknown): unknown[] | null {
  if (Array.isArray(v)) return v;
  return Object.values(object(v)).find(Array.isArray) as unknown[] | undefined ?? null;
}
export const firstLine = (t: string) => t.split('\n').map(l => l.trim()).find(l => l && !/^[#*_>`-]+$/.test(l))?.replace(/^[#>*\-\s]+/, '').replace(/\*\*|__|`/g, '') ?? '';
export const home = (p: string) => p.replace(/^\/home\/[^/]+(?=\/|$)/, '~');
export const shortId = (id: string) => /^[0-9a-f]{8}-[0-9a-f-]{27}$/.test(id) ? id.slice(0, 8) : id;
export const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
/** A moment: the time alone today, else the day and time. */
export function when(v: unknown): string {
  const d = typeof v === 'number' ? new Date(v) : new Date(text(v)); if (Number.isNaN(d.getTime())) return text(v);
  const today = new Date().toDateString() === d.toDateString();
  return formatDate(d, today ? { hour: 'numeric', minute: '2-digit' } : { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}


/** An IMAP search said in words: FROM "x" → from x, SUBJECT "x" → “x”, SINCE 2-Nov-2026 → since Nov 2; other keys dropped. */
export function criteriaWords(criteria: string): string {
  const out: string[] = [];
  for (const m of criteria.matchAll(/\b(FROM|TO|CC|SUBJECT|TEXT|BODY|SINCE|BEFORE|ON)\s+("([^"]*)"|\S+)/gi)) {
    const key = m[1]!.toUpperCase(), value = m[3] ?? m[2]!;
    out.push(key === 'SUBJECT' || key === 'TEXT' || key === 'BODY' ? `“${value}”` : `${key.toLowerCase()} ${/^\d{1,2}-[A-Za-z]{3}-\d{4}$/.test(value) ? value.replace(/^(\d+)-(\w+)-\d+$/, '$2 $1') : value}`);
  }
  return out.join(' ') || (criteria.trim() === 'ALL' || !criteria.trim() ? '' : criteria.trim());
}
/** A sender as a name: "Example Agent (Provider)" <support@…> → Example Agent (Provider); <person30@example.com> → person30@example.com. */
export const person = (v: unknown) => text(v).replace(/^"?([^"<]*?)"?\s*<([^>]+)>$/, (_m, n: string, a: string) => n.trim() || a).replace(/\\"/g, '"');

export type Channel = { app: 'Signal' | 'Mail' | 'Discord' | 'Kenan' | 'Texts' | 'Telegram' | string; who: string };
/** Where a send went, from its `to` ("signal:Morgan", "signal:group:ID", "mail:a@b,c@d", "discord:user:ID", "kenan:CHAT", "texts:+1…"). */
export function channelOf(to: string): Channel {
  const [kind = '', ...rest] = to.split(':'), target = rest.join(':');
  const app = ({ signal: 'Signal', mail: 'Mail', discord: 'Discord', kenan: 'Kenan', texts: 'Texts' } as Record<string, string>)[kind] ?? cap(kind);
  if (kind === 'signal' && target.startsWith('group:')) return { app, who: 'a group' };
  if (kind === 'discord') return { app, who: target.startsWith('user:') ? 'a DM' : 'a channel' };
  if (kind === 'kenan') return { app, who: 'a chat' };
  if (kind === 'mail') { const all = target.split(',').filter(Boolean); return { app, who: all.length > 1 ? `${all[0]} +${all.length - 1}` : all[0] ?? '' }; }
  return { app, who: target };
}
/** Who is reading: chat cards show this person's own messages on the right. App sets it from the bootstrap. */
export const viewer = { name: '' };
