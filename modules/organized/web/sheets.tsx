// In-app bottom sheets for Organized (instead of the browser's prompt boxes): text, a tappable month date picker,
// pin with a key date, a to-do's day, an emoji grid, colour swatches, a short choice list, an action list, and chat groups (choose one, make one, edit one). Back closes an open sheet (useOverlay).
import { useState, type FormEvent, type ReactNode } from 'react';
import { useOverlay } from '../../../web/overlay.js';
import { AskSheet as CoreAskSheet, Sheet, type Ask as CoreAsk, type SheetAction } from '../../../web/todo/sheets.js';
import { useAboveKeyboard, useFocusInside } from '../../../web/menuPlacement.js';
import { startOfWeek } from '../../../web/extensions/calendarMath.js';
import { GROUP_FAMILIES, type ChatGroup, type ChatGroupInput, type GroupFamily } from '../../../shared/contract.js';
import { FAMILIES, SWATCHES } from '../../../shared/colors.js';
import { FAMILY_NAMES } from './colors.js';
import { formatDate } from '../../../web/dates.js';
import { MemberColor } from '../../../web/MemberColors.js';

export { Sheet };

const pad = (n: number) => String(n).padStart(2, '0');
export const ymd = (t: Date) => `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`;

/** A small month to tap a day in (YYYY-MM-DD); ‹ › change the month. */
export function DatePicker({ value, pick }: { value: string | null; pick(date: string): void }) {
  const base = value ? new Date(`${value}T12:00:00`) : new Date();
  const [month, setMonth] = useState(() => new Date(base.getFullYear(), base.getMonth(), 1));
  const start = startOfWeek(month);
  const days = Array.from({ length: 42 }, (_, i) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
  const today = ymd(new Date());
  return <div className="org-dp">
    <div className="org-dp-nav"><button type="button" className="org-icon" aria-label="Previous month" onClick={() => setMonth(m => new Date(m.getFullYear(), m.getMonth() - 1, 1))}>‹</button><strong>{formatDate(month, { month: 'long', year: 'numeric' })}</strong><button type="button" className="org-icon" aria-label="Next month" onClick={() => setMonth(m => new Date(m.getFullYear(), m.getMonth() + 1, 1))}>›</button></div>
    <div className="org-dp-grid">
      {days.slice(0, 7).map((d, i) => <span key={i} aria-hidden="true">{formatDate(d, { weekday: 'narrow' })}</span>)}
      {days.map(d => { const k = ymd(d); return <button type="button" key={k} className={`${d.getMonth() !== month.getMonth() ? 'o' : ''}${k === today ? ' t' : ''}`} aria-pressed={k === value} aria-label={d.toDateString()} onClick={() => pick(k)}>{d.getDate()}</button>; })}
    </div>
  </div>;
}
/** A date field that opens the picker in place. */
export function DateField({ label, value, change }: { label: string; value: string; change(date: string): void }) {
  const [open, setOpen] = useState(false);
  useOverlay(open, () => setOpen(false));
  return <>
    <button type="button" className="org-date" aria-label={label} aria-expanded={open} onClick={() => setOpen(!open)}>{(d => formatDate(d, { weekday: 'short', month: 'short', day: 'numeric', ...(d.getFullYear() === new Date().getFullYear() ? {} : { year: 'numeric' }) }))(new Date(`${value}T12:00:00`))}</button>
    {open && <div className="org-dp-pop" role="dialog" aria-label={label}><DatePicker value={value} pick={d => { change(d); setOpen(false); }}/></div>}
  </>;
}

export type Ask =
  | CoreAsk
  | { kind: 'pin'; title: string; save(date: string | null, label: string | null): void }
  | { kind: 'day'; title: string; value: string | null; save(date: string | null): void }
  | { kind: 'emoji'; title: string; value: string | null; save(emoji: string | null): void }
  | { kind: 'color'; title: string; value: string | null; save(color: string | null): void }
  /** Each person's message colour in this chat; every tap saves at once and the sheet stays open until Done. */
  | { kind: 'memberColors'; title: string; people: { id: string; name: string }[]; value: Record<string, string>; save(patch: Record<string, string | null>): void }
  | { kind: 'choose'; title: string; options: { label: string; value: string | null }[]; value: string | null; save(value: string | null): void }
  | { kind: 'group'; title: string; groups: ChatGroup[]; value: string | null; save(groupId: string | null): void; create(input: ChatGroupInput): Promise<ChatGroup | null> }
  | { kind: 'groupEdit'; title: string; group: ChatGroup; save(input: ChatGroupInput): void; remove(): void }
  /** start answers null once the chat is open, or what went wrong (shown in the sheet, which stays open). */
  | { kind: 'newChat'; people: { id: string; name: string }[]; start(title: string | null, people: string[]): Promise<string | null> };
export type { SheetAction };

export function AskSheet({ ask, close }: { ask: Ask; close(): void }) {
  const done = (f: () => void) => { close(); f(); };
  switch (ask.kind) {
    case 'text': case 'actions': return <CoreAskSheet ask={ask} close={close}/>;
    case 'pin': return <PinSheet ask={ask} close={close}/>;
    case 'day': return <Sheet label={ask.title} close={close}><h2 className="org-sheet-h org-sheet-title">{ask.title}</h2>
      <p className="org-quiet">On this day it moves into Today by itself, and it shows in your calendar.</p>
      <DatePicker value={ask.value} pick={date => done(() => ask.save(date))}/>
      <div className="org-sheet-actions">{ask.value !== null && <button className="org-grey" onClick={() => done(() => ask.save(null))}>No day</button>}<button className="org-grey" onClick={close}>Cancel</button></div></Sheet>;
    case 'group': return <GroupSheet ask={ask} close={close}/>;
    case 'newChat': return <NewChatSheet ask={ask} close={close}/>;
    case 'groupEdit': return <Sheet label={ask.title} close={close}><h2 className="org-sheet-h">{ask.title}</h2>
      <GroupForm start={ask.group} submit={input => done(() => ask.save(input))} cancel={close} extra={<button type="button" className="org-grey org-danger" onClick={() => done(ask.remove)}>Delete group</button>}/></Sheet>;
    case 'emoji': return <Sheet label={ask.title} close={close}><h2 className="org-sheet-h">{ask.title}</h2>
      <div className="org-emoji" role="radiogroup" aria-label="Emoji">{EMOJIS.map(e => <button key={e} role="radio" aria-checked={ask.value === e} onClick={() => done(() => ask.save(e))}>{e}</button>)}</div>
      <div className="org-sheet-actions"><button className="org-grey" onClick={() => done(() => ask.save(null))}>No emoji</button><button className="org-grey" onClick={close}>Cancel</button></div></Sheet>;
    case 'color': return <Sheet label={ask.title} close={close}><h2 className="org-sheet-h">{ask.title}</h2>
      <div className="org-ev-colors org-swatches" role="radiogroup" aria-label="Colour">{SWATCHES.map(([c, name]) => <button key={c} role="radio" aria-checked={ask.value === c} aria-label={name} title={name} style={{ background: c }} onClick={() => done(() => ask.save(c))}/>)}</div>
      <div className="org-sheet-actions"><button className="org-grey" onClick={() => done(() => ask.save(null))}>Pick automatically</button><button className="org-grey" onClick={close}>Cancel</button></div></Sheet>;
    case 'memberColors': return <MemberColorsSheet ask={ask} close={close}/>;
    case 'choose': return <Sheet label={ask.title} close={close}><h2 className="org-sheet-h">{ask.title}</h2>
      <div className="org-choose" role="radiogroup">{ask.options.map(o => <button key={o.value ?? ''} role="radio" aria-checked={ask.value === o.value} onClick={() => done(() => ask.save(o.value))}>{o.label}</button>)}</div>
      <div className="org-sheet-actions"><button className="org-grey" onClick={close}>Cancel</button></div></Sheet>;
  }
}
function MemberColorsSheet({ ask, close }: { ask: Extract<Ask, { kind: 'memberColors' }>; close(): void }) {
  const [colors, setColors] = useState(ask.value);
  const set = (id: string, color: string | null) => {
    setColors(({ [id]: _old, ...rest }) => color === null ? rest : { ...rest, [id]: color });
    ask.save({ [id]: color });
  };
  return <Sheet label={ask.title} close={close}><h2 className="org-sheet-h">{ask.title}</h2>
    <p className="org-quiet">Only you see these colours.</p>
    {ask.people.map(x => <div key={x.id} className="org-member-color"><strong>{x.name}</strong><MemberColor name={x.name} value={colors[x.id] ?? null} change={color => set(x.id, color)}/></div>)}
    <div className="org-sheet-actions"><button className="org-grey org-save" onClick={close}>Done</button></div>
  </Sheet>;
}
function NewChatSheet({ ask, close }: { ask: Extract<Ask, { kind: 'newChat' }>; close(): void }) {
  const [title, setTitle] = useState(''), [ticked, setTicked] = useState<string[]>([]), [busy, setBusy] = useState(false), [problem, setProblem] = useState('');
  const submit = (e: FormEvent) => {
    e.preventDefault(); if (busy) return;
    setBusy(true); setProblem('');
    void ask.start(title.trim() || null, ticked).then(failed => { if (failed === null) close(); else { setProblem(failed); setBusy(false); } });
  };
  return <Sheet label="New chat" close={close}><form className="org-ev-form org-newchat-form" onSubmit={submit}>
    <h2 className="org-sheet-h">New chat</h2>
    <input aria-label="What's it about? (optional)" placeholder="What's it about? (optional)" value={title} onChange={e => setTitle(e.target.value)} maxLength={200} enterKeyHint="done"/>
    <p className="org-quiet">Kenan names it for you if you leave it blank.</p>
    {ask.people.length > 0 && <>
      <h3 className="org-newchat-h" id="org-newchat-people">Add people (optional)</h3>
      <div className="org-newchat-people" role="group" aria-labelledby="org-newchat-people">{ask.people.map(x => <label key={x.id} className="org-newchat-person">
        <input type="checkbox" checked={ticked.includes(x.id)} onChange={e => setTicked(t => e.target.checked ? [...t, x.id] : t.filter(id => id !== x.id))}/><span>{x.name}</span></label>)}</div>
      <p className="org-quiet">🌀 Nobody ticked = a chat with just you and Kenan.</p>
    </>}
    {problem && <p className="org-quiet" role="alert">{problem}</p>}
    <div className="org-sheet-actions org-newchat-actions"><button type="button" className="org-grey" onClick={close}>Cancel</button><button type="submit" className="org-start" disabled={busy}>Start chat</button></div>
  </form></Sheet>;
}
const KEY_LABELS = ['Due', 'Opens', 'Starts', 'Trip'] as const;
function PinSheet({ ask, close }: { ask: Extract<Ask, { kind: 'pin' }>; close(): void }) {
  const [label, setLabel] = useState<string | null>('Due');
  return <Sheet label={ask.title} close={close}>
    <h2 className="org-sheet-h">{ask.title}</h2>
    <p className="org-quiet">Tap the key date, or pin it without one.</p>
    <div className="org-chips" role="radiogroup" aria-label="Date label">{[...KEY_LABELS, null].map(l => <button key={l ?? 'none'} role="radio" aria-checked={label === l} onClick={() => setLabel(l)}>{l ?? 'No label'}</button>)}</div>
    <DatePicker value={null} pick={date => { close(); ask.save(date, label); }}/>
    <div className="org-sheet-actions"><button className="org-grey" onClick={() => { close(); ask.save(null, null); }}>No date</button><button className="org-grey" onClick={close}>Cancel</button></div>
  </Sheet>;
}
const EMOJIS = ['💬', '🧠', '🎼', '🏡', '✨', '🏛️', '💼', '📄', '🎓', '🎻', '🎨', '💡', '🧮', '📬', '❓', '✈️', '🌊', '🏠', '📱', '💻', '🛠️', '📚', '🍲', '🌱', '🧾', '💰', '❤️', '🎉', '📅', '🔔', '⭐', '🔵', '🟢', '🟣', '🟠', '🌞', '🌙', '🚗', '🏃', '🧘', '🐱', '🎵', '📷'];

function GroupSheet({ ask, close }: { ask: Extract<Ask, { kind: 'group' }>; close(): void }) {
  const [making, setMaking] = useState(false), [problem, setProblem] = useState('');
  const pick = (id: string | null) => { close(); ask.save(id); };
  const make = (input: ChatGroupInput) => { setProblem(''); ask.create(input).then(g => { if (g) pick(g.id); else setProblem('Couldn\'t make the group.'); }, e => setProblem(String(e))); };
  return <Sheet label={ask.title} close={close}>
    <h2 className="org-sheet-h">{making ? 'New group' : ask.title}</h2>
    {making ? <GroupForm start={null} submit={make} cancel={() => setMaking(false)}/> : <>
      <div className="org-choose" role="radiogroup">
        {ask.groups.map(g => <button key={g.id} role="radio" aria-checked={ask.value === g.id} onClick={() => pick(g.id)}><span className="org-fam" style={{ background: FAMILIES[g.family][1] }} aria-hidden="true"/>{g.emoji ?? '💬'} {g.name}</button>)}
        <button role="radio" aria-checked={ask.value === null} onClick={() => pick(null)}>No group</button>
      </div>
      <div className="org-sheet-actions"><button className="org-grey" onClick={() => setMaking(true)}>＋ New group</button><button className="org-grey" onClick={close}>Cancel</button></div>
    </>}
    {problem && <p className="org-quiet" role="alert">{problem}</p>}
  </Sheet>;
}
/** Name, emoji and colour family of a chat group. */
function GroupForm({ start, submit, cancel, extra }: { start: ChatGroup | null; submit(input: ChatGroupInput): void; cancel(): void; extra?: ReactNode }) {
  const [name, setName] = useState(start?.name ?? ''), [emoji, setEmoji] = useState<string | null>(start?.emoji ?? null), [family, setFamily] = useState<GroupFamily | null>(start?.family ?? null);
  const [problem, setProblem] = useState('');
  const go = (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) { setProblem('Give the group a name.'); return; }
    if (!family) { setProblem('Pick a colour family.'); return; }
    submit({ name: name.trim(), emoji, family });
  };
  return <form className="org-ev-form" onSubmit={go}>
    <input aria-label="Group name" placeholder="Group name (e.g. Music)" autoFocus={!start} value={name} onChange={e => setName(e.target.value)} enterKeyHint="done"/>
    <div className="org-ev-colors" role="radiogroup" aria-label="Colour family">{GROUP_FAMILIES.map(f => <button type="button" key={f} role="radio" aria-checked={family === f} aria-label={FAMILY_NAMES[f]} title={FAMILY_NAMES[f]} style={{ background: `linear-gradient(135deg, ${FAMILIES[f][0]}, ${FAMILIES[f].at(-1)})` }} onClick={() => setFamily(f)}/>)}</div>
    <div className="org-emoji org-emoji-small" role="radiogroup" aria-label="Emoji">{EMOJIS.map(x => <button type="button" key={x} role="radio" aria-checked={emoji === x} onClick={() => setEmoji(emoji === x ? null : x)}>{x}</button>)}</div>
    {problem && <p className="org-quiet" role="alert">{problem}</p>}
    <div className="org-sheet-actions">{extra}<button type="button" className="org-grey" onClick={cancel}>Cancel</button><button type="submit" className="org-grey org-save">Save</button></div>
  </form>;
}
