// 📰 What's new (extension `changelog`, its own lazy chunk): the changes live on this channel in plain words, newest first,
// one section per day on this device's calendar; each day's behind-the-scenes changes fold into one line. Opening it marks
// everything shown as seen, which takes the menu's dot away.
import { useEffect, useState } from 'react';
import type { Changelog, ChangelogEntry } from '../../../shared/contract.js';
import { api } from '../../../web/client.js';
import { formatDate } from '../../../web/dates.js';

export interface Day { key: string; label: string; lines: { hash: string; at: number; text: string }[]; behind: number }

const dayKey = (at: number) => { const d = new Date(at); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

/** Entries (newest first) as days, newest first: their written lines in order and how many were behind the scenes. */
export function days(entries: readonly ChangelogEntry[], now: number): Day[] {
  const out: Day[] = [], today = dayKey(now), yesterday = dayKey(now - 86_400_000);
  for (const e of entries) {
    const key = dayKey(e.at);
    let day = out.at(-1);
    if (day?.key !== key) {
      day = { key, label: key === today ? 'Today' : key === yesterday ? 'Yesterday' : formatDate(new Date(e.at), { weekday: 'long', month: 'long', day: 'numeric' }), lines: [], behind: 0 };
      out.push(day);
    }
    if (e.text === null) day.behind++; else day.lines.push({ hash: e.hash, at: e.at, text: e.text });
  }
  return out;
}

/** "Fixed: …" with its kind in bold, so the list skims by kind. */
const Line = ({ text }: { text: string }) => { const at = text.indexOf(': '); return at > 0 ? <><b>{text.slice(0, at + 1)}</b>{text.slice(at + 1)}</> : <>{text}</>; };

export const behindText = (n: number) => `Behind the scenes: ${n} ${n === 1 ? 'improvement' : 'improvements'}.`;

type State = { kind: 'loading' } | { kind: 'failed'; error: string } | { kind: 'loaded'; log: Changelog };

export default function WhatsNew({ seen }: { seen(): void }) {
  const [state, setState] = useState<State>({ kind: 'loading' });
  useEffect(() => {
    let current = true;
    api<Changelog>('/ext/changelog').then(log => {
      if (!current) return;
      setState({ kind: 'loaded', log });
      const newest = log.kind === 'ready' ? log.entries[0]?.at : undefined;
      if (newest !== undefined) void api('/ext/changelog/seen', 'POST', { through: newest }).then(seen, () => {});
    }, e => { if (current) setState({ kind: 'failed', error: e instanceof Error ? e.message : String(e) }); });
    return () => { current = false; };
  }, []);
  if (state.kind === 'loading') return <p className="org-quiet">Loading…</p>;
  if (state.kind === 'failed') return <p className="org-quiet" role="alert">Couldn't load what's new: {state.error}</p>;
  const log = state.log;
  if (log.kind === 'unavailable') return <p className="org-quiet">The list of changes isn't available on this version yet.</p>;
  const list = days(log.entries, Date.now());
  return <div className="org-scroll org-news">
    {log.pending > 0 && <p className="org-quiet">Writing up {log.pending} more {log.pending === 1 ? 'change' : 'changes'}… check back in a minute.</p>}
    {list.length === 0 && log.pending === 0 && <p className="org-quiet">Nothing new in the last two weeks.</p>}
    {list.map(day => <section key={day.key}>
      <h2 className="org-h">{day.label}</h2>
      <ul>
        {day.lines.map(l => <li key={l.hash} className={log.seenThrough !== null && l.at > log.seenThrough ? 'fresh' : undefined}><Line text={l.text}/></li>)}
        {day.behind > 0 && <li className="behind">{behindText(day.behind)}</li>}
      </ul>
    </section>)}
  </div>;
}
