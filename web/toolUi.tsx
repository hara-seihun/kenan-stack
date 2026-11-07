// The pieces tool cards are built from (toolBodies.tsx puts them together per tool): folded text, prose, rows, a
// message transcript, an email list and view, calendar lines, a diff and a tidied fallback for anything else.
// The look is quiet type on her wallpaper: no fills, pills, chips, avatars or boxes; hierarchy comes from weight and
// dimmed text only (Alice, 2026-11-02: "kill the backgrounds", and the pill-and-bubble version read as "a very GPT UI").
import type { ReactNode } from 'react';
import { MessageMarkdown } from './MessageMarkdown.js';
import { firstLine, home, object, person, shortId, text, when, words, type Data } from './toolData.js';
import { formatDate } from './dates.js';
import './toolBody.css';

/** A moment as a Date: epoch ms, an ISO time, or a Signal history stamp ("Oct 21, 00:03", this year's wall clock). Null when it is none. */
export function dateOf(v: unknown): Date | null {
  if (typeof v === 'number') return new Date(v);
  const s = text(v); if (!s) return null;
  const stamp = /^([A-Z][a-z]{2}) (\d{1,2}), (\d{1,2}):(\d{2})$/.exec(s);
  if (stamp) {
    const month = 'JanFebMarAprMayJunJulAugSepOctNovDec'.indexOf(stamp[1]!) / 3; if (month < 0) return null;
    const now = new Date(), d = new Date(now.getFullYear(), month, Number(stamp[2]), Number(stamp[3]), Number(stamp[4]));
    if (d.getTime() > now.getTime() + 86_400_000) d.setFullYear(d.getFullYear() - 1);
    return d;
  }
  // A wall-clock time without a zone ("2026-11-03T09:00", how events are stored) reads as that clock time here.
  const d = new Date(s); return Number.isNaN(d.getTime()) ? null : d;
}
/** "1:27 PM". */
export const clock = (d: Date) => formatDate(d, { hour: 'numeric', minute: '2-digit' });
/** "Today", "Yesterday", "Sat, Oct 31", or with the year when it isn't this year. */
export function dayLabel(d: Date): string {
  const now = new Date(), y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === now.toDateString()) return 'Today';
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  return formatDate(d, d.getFullYear() === now.getFullYear() ? { weekday: 'short', month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' });
}
/** A byte count: 840 B, 12 KB, 1.2 MB. */
export const bytes = (n: unknown) => typeof n !== 'number' ? '' : n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`;

/** Expanded tool cards show all received text immediately. */
export function Fold({ value, mono = true, className = '' }: { value: string; lines?: number; mode?: 'head' | 'ends'; mono?: boolean; className?: string }) {
  return <pre className={`tb-text${mono ? '' : ' prose'} ${className}`}>{value.replace(/\n+$/, '')}</pre>;
}

export function Prose({ value }: { value: string; height?: number }) {
  return value.trim() ? <div className="tb-prose-wrap"><div className="tb-prose message-body"><MessageMarkdown source="agent" text={value}/></div></div> : null;
}

export type Tone = 'good' | 'bad' | 'warn' | 'info' | 'dim';
/** A fact: a string, { text, tone }, or anything falsy for none (so `cond && 'label'` works). */
export type FactSpec = unknown;
/** A status, a model or a tag as dim words joined by " · "; only a failure ("bad") is coloured, and only its text. */
export function Facts({ items, after = '' }: { items: FactSpec[]; after?: string }) {
  const shown = items.flatMap(p => typeof p === 'string' && p ? [{ text: p }] : p && typeof p === 'object' && typeof (p as { text?: unknown }).text === 'string' && (p as { text: string }).text ? [p as { text: string; tone?: Tone }] : []);
  if (after) shown.push({ text: after });
  return shown.length ? <span className="tb-facts">{shown.map((p, i) => <span key={i}>{i > 0 && ' · '}<span className={p.tone === 'bad' ? 'bad' : undefined}>{p.text}</span></span>)}</span> : null;
}
/** The tone a worker, goal or wake state reads as. */
export const toneOf = (state: string): Tone => /^(running|open|pending|sent|scheduled|placed|succeeded|edited|done|delivered|queued|answered)$/.test(state) ? (state === 'done' ? 'dim' : 'good')
  : /^(error|failed|dropped|interrupted|cancelled|rejected|not sent)$/.test(state) ? 'bad' : /^(waiting|blocked|held)$/.test(state) ? 'warn' : 'dim';

export type Row = { key: string; title: ReactNode; meta?: ReactNode; body?: string; href?: string; tone?: string; facts?: FactSpec[]; aside?: string; lead?: ReactNode };
/** A list of results as rows: a title with a time on the right, a dim line of facts under it and its complete text. */
export function Rows({ rows, total, empty = 'Nothing found.' }: { rows: Row[]; total?: number; empty?: string; first?: number }) {
  if (!rows.length) return <p className="tb-muted">{empty}</p>;
  const shown = rows;
  return <>
    <ul className="tb-rows">{shown.map(r => <li key={r.key} className={r.tone}>
      {r.lead}
      <div className="tb-row-main">
        <div className="tb-row-top"><strong>{r.href ? <a href={r.href} target="_blank" rel="noopener noreferrer">{r.title}</a> : r.title}</strong>{r.aside && <time>{r.aside}</time>}</div>
        {(r.meta || r.facts?.some(Boolean)) && <small><Facts items={r.facts ?? []} after={typeof r.meta === 'string' ? r.meta : ''}/>{typeof r.meta === 'string' ? null : r.meta}</small>}
        {r.body && <p>{r.body}</p>}
      </div>
    </li>)}</ul>
    {total !== undefined && total > rows.length && <p className="tb-muted">{(total - rows.length).toLocaleString()} more not loaded by this call.</p>}
  </>;
}

export const Meta = ({ items }: { items: unknown[] }) => { const shown = items.filter((v): v is string => typeof v === 'string' && v !== ''); return shown.length ? <p className="tb-meta">{shown.join(' · ')}</p> : null; };
export const Label = ({ children }: { children: ReactNode }) => <p className="tb-label">{children}</p>;
export const Path = ({ value }: { value: unknown }) => text(value) ? <p className="tb-path">{home(text(value))}</p> : null;
export const clip = (v: unknown, _n = 280) => text(v).trim();
const SOURCE_NAMES: Record<string, string> = { signal: 'Signal', texts: 'Texts', mail: 'Mail', discord: 'Discord', kenan: 'Kenan' };
export const sourceName = (s: string) => SOURCE_NAMES[s] ?? (s ? s.charAt(0).toUpperCase() + s.slice(1) : 'Inbox');

export type ChatMsg = { key: string; from: string; text: string; at: Date | null; mine: boolean; note?: boolean };
export type ChatGroup = { key: string; title: string; source: string; msgs: ChatMsg[] };
/** Messages as a transcript: one thread per conversation, oldest at the top, with a dim day line, then each speaker's
 * name and time over what they said (repeated only when the speaker changes or ten minutes pass). */
export function Chat({ groups, empty = 'No messages.' }: { groups: ChatGroup[]; empty?: string }) {
  if (!groups.some(g => g.msgs.length)) return <p className="tb-muted">{empty}</p>;
  return <>{groups.map(g => <section className="tb-chat" key={g.key}>
    {groups.length > 1 && <p className="tb-label">{g.title || sourceName(g.source)}<span className="tb-dim"> · {g.msgs.length === 1 ? '1 message' : `${g.msgs.length} messages`}</span></p>}
    <Thread msgs={g.msgs}/>
  </section>)}</>;
}
function Thread({ msgs }: { msgs: ChatMsg[] }) {
  const shown = msgs;
  return <div className="tb-thread">
    {shown.map((m, i) => {
      const prev = shown[i - 1];
      const day = m.at && (!prev?.at || prev.at.toDateString() !== m.at.toDateString()) ? dayLabel(m.at) : null;
      const head = !m.note && (!prev || prev.note || prev.from !== m.from || !!day || !m.at || !prev.at || m.at.getTime() - prev.at.getTime() > 600_000);
      return <div key={m.key}>
        {day && <p className="tb-day">{day}</p>}
        {m.note ? <p className="tb-note">{m.text}{m.at && <> · {clock(m.at)}</>}</p> : <Said msg={m} head={head}/>}
      </div>;
    })}
  </div>;
}
function Said({ msg, head }: { msg: ChatMsg; head: boolean }) {
  const reply = /^([\s\S]*?)\s*\[replying to ([^:\]]+): "([\s\S]*)"\]\s*$/.exec(msg.text);
  let body = reply ? reply[1]! : msg.text;
  const files: string[] = [];
  body = body.replace(/\s*\[attachments?: ([^\]]*)\]/g, (_m, list: string) => { files.push(...list.split(/;\s*/).map(f => f.split('/').pop() ?? f)); return ''; }).trim();
  return <div className={`tb-msg${msg.mine ? ' mine' : ''}${head ? ' head' : ''}`}>
    {head && <p className="tb-from"><b>{msg.from || (msg.mine ? 'You' : 'Them')}</b>{msg.at && <time>{clock(msg.at)}</time>}</p>}
    {reply && <p className="tb-reply">↳ {reply[2]}: {clip(reply[3], 120)}</p>}
    {body && <p className="tb-btext">{body}</p>}
    {files.map((f, i) => <p key={i} className="tb-file">{f}</p>)}
  </div>;
}

/** Inbox-like items ({source, at, from, where, text}) as chat threads, one per conversation, newest conversation first. */
export function chatGroups(list: Data[], viewer: (from: string, where: string, source: string) => boolean): ChatGroup[] {
  const groups = new Map<string, ChatGroup>();
  for (const [n, it] of list.entries()) {
    const source = text(it.source) || 'signal', where = text(it.where ?? it.chat), key = `${source}\n${where}`;
    const g = groups.get(key) ?? { key, title: where.replace(/^group "(.*)"$/, '$1').replace(/^phone, .*$/, ''), source, msgs: [] };
    const from = person(it.from ?? it.sender ?? it.author);
    g.msgs.push({ key: `${n}`, from, text: text(it.text ?? it.body ?? it.content), at: dateOf(it.sentAt ?? it.at), mine: viewer(from, where, source) });
    groups.set(key, g);
  }
  for (const g of groups.values()) g.msgs.sort((a, b) => (a.at?.getTime() ?? 0) - (b.at?.getTime() ?? 0));
  return [...groups.values()];
}

const GREETING = /^(hi|hello|hey|thanks|thank you|good (morning|afternoon|evening))\b[^.!?]{0,40}[.!?]+$/i;
/** A brief's first real sentence: greetings skipped, cut at the first full stop, at most 280 characters. */
export function firstSentence(value: string): string {
  const sentences = value.trim().replace(/\s+/g, ' ').split(/(?<=[.!?]["”')\]]?) (?=["“(\p{Lu}\d])/u);
  const s = sentences.find(x => !GREETING.test(x.trim())) ?? sentences[0] ?? '';
  return s.length > 280 ? `${s.slice(0, 279).replace(/\s+\S*$/, '')}…` : s;
}
/** The complete brief. */
export function Brief({ value }: { value: string }) {
  return <Prose value={value}/>;
}

/** Mail search results: sender, time, subject, and the folder when it isn't the inbox. */
export function MailList({ items, empty = 'No messages.' }: { items: Data[]; empty?: string }) {
  return <Rows empty={empty} rows={items.map((m, n) => {
    const from = person(m.from), d = dateOf(m.date);
    const folder = text(m.folder) && text(m.folder) !== 'INBOX' ? text(m.folder).replace(/^Folders\//, '') : '';
    return { key: text(m.reference) || `${n}`, title: from || '(unknown sender)', aside: [folder, d ? (d.toDateString() === new Date().toDateString() ? clock(d) : dayLabel(d)) : ''].filter(Boolean).join(' · '), body: text(m.subject) || '(no subject)' };
  })}/>;
}

const QUOTE = /\n(?=On [^\n]{6,240}wrote:\s*\n|Le [^\n]{6,240}a écrit\s*:\s*\n|-----\s*Original Message\s*-----|>[^\n]*\n>)/;
/** One email: who and when on top, the subject (when the card's title doesn't already say it), the body, and earlier quoted mail. */
export function MailView({ from, to, date, subject, body }: { from: string; to?: string; date?: string; subject: string; body: string }) {
  // Plain-text mail is hard-wrapped near 72 columns: a line break before a lowercase word is a wrap, not a new line.
  const clean = body.replace(/\r/g, '').replace(/\n\s*\n(\s*\n)+/g, '\n\n').replace(/([^\n>])\n(?=[a-z(])/g, '$1 ').trim();
  const cut = clean.search(QUOTE), main = cut > 0 ? clean.slice(0, cut).trim() : clean, rest = cut > 0 ? clean.slice(cut).trim() : '';
  const d = date ? dateOf(date) : null;
  return <div className="tb-mail">
    <div className="tb-mail-head"><div><strong>{from || '(unknown sender)'}</strong>{to && <small>to {to}</small>}</div>{d && <time>{when(d.getTime())}</time>}</div>
    {subject && <p className="tb-mail-subject">{subject}</p>}
    <Fold value={main} lines={18} mono={false}/>
    {rest && <Fold value={rest} mono={false} className="quoted"/>}
  </div>;
}

/** An event's wall-clock time ("2026-11-03T09:00") in its zone, as the instant it is. */
function inZone(wall: unknown, zone: string): Date | null {
  const d = dateOf(wall); if (!d || !zone || /[zZ]|[+-]\d\d:\d\d$/.test(text(wall))) return d;
  try {
    const guess = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes());
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' }).formatToParts(guess).map(x => [x.type, Number(x.value)]));
    const shown = Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!);
    return new Date(guess - (shown - guess));
  } catch { return d; }
}
/** Calendar events as lines of time, title and place under a line per day, in the reader's own time (and notes for one event). */
export function Events({ items, empty = 'No events.', notes = false }: { items: Data[]; empty?: string; notes?: boolean }) {
  if (!items.length) return <p className="tb-muted">{empty}</p>;
  let last = '';
  return <div className="tb-events">{items.map((e, n) => {
    const s = inZone(e.start, text(e.zone)), en = inZone(e.end, text(e.zone)), day = s ? dayLabel(s) : '';
    const head = day !== last ? (last = day, <p className="tb-label" key={`d${n}`}>{day}</p>) : null;
    return <div key={text(e.id) || n}>{head}<div className="tb-event">
      <time>{e.allDay ? 'All day' : s ? clock(s) : ''}</time>
      <div className="tb-event-main"><span>{text(e.title) || '(untitled)'}</span>
        {(text(e.location) || (notes && en && !e.allDay)) && <small>{[notes && en && !e.allDay ? `until ${clock(en)}` : '', text(e.location)].filter(Boolean).join(' · ')}</small>}
        {notes && text(e.notes) && <p>{clip(e.notes, 300)}</p>}
      </div>
    </div></div>;
  })}</div>;
}

export function Diff({ value }: { value: string }) {
  const shown = value.split('\n');
  return <div className="tb-fold"><pre className="tb-text tb-unified">{shown.map((l, i) => <span key={i} className={/^\s*\+\d/.test(l) || l.startsWith('+') ? 'added' : /^\s*-\d/.test(l) || l.startsWith('-') ? 'removed' : ''}>{l}{'\n'}</span>)}</pre>
    </div>;
}

/** All returned blocks. */
export function More({ items }: { items: ReactNode[]; first: number }) {
  return <>{items}</>;
}

// The tidied fallback: what a reader needs, without ids, cursors, zones, page sizes or empty values, and with
// friendly times and numbers.
const HIDDEN_KEY = /^(id|ids|cursor|nextCursor|zone|limit|diagnostics|search_id|requestId|config_path|messageId|chatId|conversationId|ownerId|position|createdAt|updatedAt|storedAt|more|window|parentAgentId|originConversationId|kind)$|Id$|Ids$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
const shown = (k: string, v: unknown) => v !== undefined && v !== null && v !== '' && v !== false && !HIDDEN_KEY.test(k) && !(typeof v === 'string' && UUID.test(v)) && !(Array.isArray(v) && !v.length) && !(typeof v === 'object' && !Array.isArray(v) && !Object.keys(v as object).length);
/** Label/value lines; nested values sit under their label at full width, never squeezed into a column. */
export function Fields({ data, skip = [] }: { data: Data; skip?: string[] }) {
  const entries = Object.entries(data).filter(([k, v]) => shown(k, v) && !skip.includes(k));
  if (!entries.length) return null;
  return <dl className="tb-fields">{entries.map(([k, v]) => {
    const nested = typeof v === 'object' || (typeof v === 'string' && (v.length > 60 || v.includes('\n')));
    return <div key={k} className={nested ? 'wide' : ''}><dt>{words(k)}</dt><dd><Value name={k} value={v}/></dd></div>;
  })}</dl>;
}
function Value({ name, value }: { name: string; value: unknown }): ReactNode {
  if (Array.isArray(value)) {
    if (value.every(v => typeof v !== 'object' || v === null)) return <span>{value.map(text).join(', ')}</span>;
    const objects = value.filter(v => v && typeof v === 'object').map(object);
    const title = (o: Data) => text(o.title ?? o.name ?? o.subject ?? o.text ?? o.label ?? o.path) || firstLine(text(Object.values(o).find(v => typeof v === 'string' && !UUID.test(v))));
    if (objects.length && objects.every(o => title(o))) return <Rows first={6} rows={objects.map((o, i) => ({ key: `${i}`, title: clip(title(o), 120), meta: Object.entries(o).filter(([k, v]) => shown(k, v) && typeof v !== 'object' && clip(title(o), 120) !== clip(v, 120)).map(([k, v]) => `${words(k)} ${friendly(k, v)}`).join(' · ') }))}/>;
    return <ol className="tb-items">{value.map((v, i) => <li key={i}><Value name={name} value={v}/></li>)}</ol>;
  }
  if (value !== null && typeof value === 'object') return <Fields data={value as Data}/>;
  if (typeof value === 'string' && value.length > 60 && !ISO.test(value)) return <Fold value={value} lines={8} mono={false}/>;
  if (typeof value === 'string' && /^https?:\/\//.test(value)) return <a href={value} target="_blank" rel="noopener noreferrer">{value.replace(/^https?:\/\/(www\.)?/, '')}</a>;
  return <span>{friendly(name, value)}</span>;
}
/** A value as a person reads it: times as times, big numbers with separators, yes/no, short ids, ~ for home. */
export function friendly(name: string, value: unknown): string {
  if (typeof value === 'number') return /At$|^at$|^date$/.test(name) && value > 1e12 ? when(value) : value.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  const s = text(value);
  if (ISO.test(s)) return when(s);
  return home(shortId(s));
}
