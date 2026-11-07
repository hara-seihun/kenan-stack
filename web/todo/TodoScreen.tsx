// The To-do screen (Alice, 2026-11-06: "monumentally simpler"): Today, then Later, each item a title to open or tick; 🛒 swaps to
// the To buy list. Kenaznia adds, moves and edits items; there is nothing to configure here.
import { lazy, Suspense, useRef, useState, type ReactNode } from 'react';
import type { Bootstrap, BuyList, ConversationSummary, Todo, TodoLevel } from '../../shared/contract.js';
import { todoSections } from '../../shared/todo.js';
import { formatDate, localDate } from '../dates.js';
import { checkStyle, rowBackground } from './colors.js';
import { AskSheet, type Ask } from './sheets.js';
import type { TodoChange } from './todo.js';
import './todo.css';

const ToBuy = lazy(() => import('./ToBuy.js'));
export interface TodoActions {
  change(id: string, patch: TodoChange): Promise<void>;
  /** The chat to do the item in (its linked chat or a new one made for it), or null when that failed. */
  chat(id: string): Promise<ConversationSummary | null>;
  /** Her tap on one of a question's answers: recorded and posted in the chat it was asked from. */
  answer(id: string, choice: string): Promise<void>;
  /** Her Dismiss on a question: it leaves the list, nothing is posted, and its chat opens with the composer focused. */
  dismiss(id: string): Promise<void>;
}
/** What a to-do row needs from the screen around it. */
export interface TodoView { boot: Bootstrap; todo: TodoActions; open(id: string): void; say(text: string, undo?: (() => void) | null): void }
export type Toast = { text: string; undo: (() => void) | null };
const DAY = 86_400_000;
/** Open to-dos in list order: Today, then everything later (soon, later, someday). */
export const LEVELS: readonly TodoLevel[] = ['today', 'soon', 'later', 'someday'];
/** Today's date on this device: the zone it reports to the server (web/zone.ts), so Today here and in her agents' tools agree. */
export const todayDate = () => localDate(Date.now());
/** A to-do's day as its row shows it: nothing for today, Tomorrow, a weekday this week, else the date ("since" once past). */
export function dayLabel(day: string, today: string): string | null {
  const n = Math.round((Date.parse(`${day}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / DAY), d = new Date(`${day}T12:00:00`);
  return n === 0 ? null : n === 1 ? 'Tomorrow' : n > 1 && n < 7 ? formatDate(d, { weekday: 'short' }) : `${n < 0 ? 'since ' : ''}${formatDate(d, { month: 'short', day: 'numeric' })}`;
}

/** A due time today shows as a time; any other day (tomorrow, overdue) as a date. */
const dueLabel = (at: number, now: number) => new Date(at).toLocaleString([], daysUntil(at, now) === 0 ? { hour: 'numeric', minute: '2-digit' } : { month: 'short', day: 'numeric' });
/** Days from today to the trip's day, counted on calendar days. */
export function daysUntil(at: number, now: number): number {
  const day = (t: number) => { const d = new Date(t); return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()); };
  return Math.round((day(at) - day(now)) / DAY);
}

export function TodoRows(p: TodoView & { items: Todo[]; colors?: Map<string, string> }) {
  return <ul className="org-rows">{p.items.map(t => <TodoRow key={t.id} t={t} color={p.colors?.get(t.id) ?? null} {...p}/>)}</ul>;
}
/** What tapping does wherever a to-do shows (rows, calendar chips): tick it done with Undo, or open the chat to do it in. */
export function todoHandlers(p: TodoView, t: Todo) {
  const done = t.doneAt !== null;
  const link = t.conversationId === null ? null : p.boot.conversations.find(c => c.id === t.conversationId) ?? null;
  const tick = () => { void p.todo.change(t.id, { done: !done }); if (!done) p.say(`Done: ${t.text}`, () => void p.todo.change(t.id, { done: false })); };
  const doIt = () => { if (link) p.open(link.id); else void p.todo.chat(t.id).then(c => { if (c) p.open(c.id); }); };
  return { done, link, tick, doIt };
}
/** A to-do is its title: the circle ticks it off (with Undo), the words open the chat to do it in. Questions answer in that chat. */
function TodoRow(p: TodoView & { t: Todo; color: string | null }) {
  const { t } = p, { done, link, tick, doIt } = todoHandlers(p, t);
  const day = t.onDate === null ? null : dayLabel(t.onDate, todayDate());
  const due = t.dueAt === null ? null : t.onDate !== null && localDate(t.dueAt) === t.onDate ? formatDate(new Date(t.dueAt), { hour: 'numeric', minute: '2-digit' }) : dueLabel(t.dueAt, Date.now());
  const when = [day, due].filter(Boolean).join(' ');
  return <li className={done ? 'org-row done' : 'org-row'} style={p.color ? { background: rowBackground(p.color) } : undefined}>
    <button className="org-check" role="checkbox" aria-checked={done} aria-label={done ? `Reopen ${t.text}` : `Done: ${t.text}`} onClick={tick}><span style={checkStyle(p.color ?? '#6f7871')}>{done ? '✓' : ''}</span></button>
    <button className="org-text" onClick={doIt} aria-label={link ? `${t.text}, open ${link.title}` : `${t.text}, start a chat for it`}>{t.options && !done ? `❓ ${t.text}` : t.text}</button>
    {when && <span className="when">{when}</span>}
  </li>;
}


/** The to-do list and, behind 🛒, the To buy list. `header` replaces the plain swap button (a module's own title bar). */
let lastTodoView: 'todo' | 'buy' = 'todo';
export function TodoScreen(p: TodoView & { todos: Todo[] | null; buy: BuyList | null; setBuy(list: BuyList): void; demo: boolean; ask(a: Ask): void; header?: (swap: ReactNode, view: 'todo' | 'buy') => ReactNode }) {
  const [view, setViewState] = useState(lastTodoView);
  const setView = (v: typeof view) => { lastTodoView = v; setViewState(v); };
  const scroll = useRef<HTMLDivElement>(null);
  const by = todoSections((p.todos ?? []).filter(t => !t.deletedAt && !t.doneAt), todayDate());
  const groups = [{ heading: 'Today', items: by.today }, { heading: 'Later', items: LEVELS.slice(1).flatMap(l => by[l]) }].filter(g => g.items.length);
  const swap = <button className="org-grey" onClick={() => setView(view === 'todo' ? 'buy' : 'todo')}>{view === 'todo' ? '🛒 To buy' : '✓ To-do'}</button>;
  return <div className="org-dense org-todo">
    {p.header ? p.header(swap, view) : <div className="org-todo-swap">{swap}</div>}
    <div className="org-scroll" ref={scroll}>
      {view === 'todo' ? groups.map(g => <section key={g.heading}><h2 className="org-h">{g.heading}</h2><TodoRows items={g.items} {...p}/></section>)
        : <Suspense fallback={null}><ToBuy scroll={scroll} list={p.buy} setList={p.setBuy} demo={p.demo} say={p.say} ask={p.ask}/></Suspense>}
    </div>
  </div>;
}

/** The To-do page of the app (its ☰ footer opens it): the list, To buy tab included (Alice, 2026-10-30). */
export function ClassicTodo({ boot, todos, todo, buy, setBuy, open }: { boot: Bootstrap; todos: Todo[] | null; todo: TodoActions; buy: BuyList | null; setBuy(list: BuyList): void; open(id: string): void }) {
  const [toast, setToast] = useState<Toast | null>(null), [ask, setAsk] = useState<Ask | null>(null);
  const say = (text: string, undo: (() => void) | null = null) => { setToast({ text, undo }); setTimeout(() => setToast(current => current?.text === text ? null : current), 6000); };
  return <div className="todo-page"><TodoScreen boot={boot} todos={todos} todo={todo} buy={buy} setBuy={setBuy} demo={false} say={say} ask={setAsk} open={open}/>{ask && <AskSheet ask={ask} close={() => setAsk(null)}/>}{toast && <div className="org-toast" role="status"><span>{toast.text}</span>{toast.undo && <button onClick={() => { toast.undo!(); setToast(null); }}>Undo</button>}</div>}</div>;
}
