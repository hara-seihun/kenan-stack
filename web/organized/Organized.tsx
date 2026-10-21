// The Organized layout (opt-in per person, PUT /api/layout): Home, Chats, Activity and To-do screens around the same
// conversation, calendar, goals and usage views the Classic layout shows. Phones get one screen at a time with a tab bar;
// wide screens get three panes (menu, list, open conversation). Mockups: Carol's design/final.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { unread, type Activity, type AgentInfo, type Bootstrap, type ConversationPatch, type ConversationSummary, type GoalSummary, type Layout, type Todo, type TodoLevel } from '../../shared/contract.js';
import { COOL, PINNED, WARM, checkStyle, rowBackground, spread, tileStyle } from './colors.js';
import { activityText } from '../activity.js';
import { agentStatus, statusText } from '../AgentTree.js';
import { useOverlay } from '../overlay.js';
import { swipeDirection } from '../gallery.js';
import { CalendarViews } from './CalendarViews.js';
import { api } from '../client.js';
import { apiPath } from '../path.js';

import { isList, type DetailScreen, type ListScreen, type Screen, type Trip } from './screens.js';
import './organized.css';

export type { Screen };
export interface TodoActions {
  /** conversationId: the project page the item belongs to, or null. */
  add(text: string, level: TodoLevel, conversationId?: string | null): Promise<void>;
  change(id: string, patch: Partial<{ text: string; level: TodoLevel; done: boolean; deleted: boolean }>): Promise<void>;
}
export interface OrganizedProps {
  boot: Bootstrap; goals: GoalSummary[]; todos: Todo[] | null; todo: TodoActions;
  screen: Screen; go(screen: Screen): void; active: string | null; open(id: string): void; openProject(id: string): void;
  detail(screen: Exclude<DetailScreen, 'project'>): ReactNode; banners: ReactNode; push: ReactNode;
  wide: boolean; connected: boolean;
  setLayout(layout: Layout): void; foldWork: boolean; toggleFoldWork(): void;
  checkUpdate: (() => void) | null; signOut(): void; weeklyLeft: number | null; refreshUsage(): void;
  newChat(): void; update(id: string, patch: ConversationPatch): Promise<ConversationSummary | null>;
  showClosed(include: boolean): void; closedLoaded: boolean; nextTrip: Trip | null;
}

type Toast = { text: string; undo: (() => void) | null };
const DAY = 86_400_000;
const LEVELS: { level: TodoLevel; label: string }[] = [{ level: 'today', label: 'Today' }, { level: 'week', label: 'This week' }, { level: 'someday', label: 'Someday' }];
const shortDate = (iso: string) => new Date(`${iso}T12:00:00`).toLocaleDateString([], { month: 'short', day: 'numeric' });
const when = (at: number, now = Date.now()) => now - at < DAY && new Date(at).getDate() === new Date(now).getDate()
  ? new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  : now - at < 6 * DAY ? new Date(at).toLocaleDateString([], { weekday: 'short' }) : new Date(at).toLocaleDateString([], { month: 'short', day: 'numeric' });
const emojiOf = (c: ConversationSummary) => c.emoji ?? '💬';
/** Days from today to the trip's day, counted on calendar days. */
export function daysUntil(at: number, now: number): number {
  const day = (t: number) => { const d = new Date(t); return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()); };
  return Math.round((day(at) - day(now)) / DAY);
}
export function footerLine(now: number, trip: Trip | null): string {
  const date = new Date(now).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
  if (!trip) return date;
  const days = daysUntil(trip.at, now);
  return `${date} · ✈️ ${days === 0 ? `today to ${trip.place}` : days === 1 ? `1 day until ${trip.place}` : `${days} days until ${trip.place}`}`;
}
/** The topic list: the person's own Kenaznia chat and rooms; workers' chats live in the Workers tab. */
export const isTopic = (c: ConversationSummary, agents: AgentInfo[]) => !c.agentId || agents.find(a => a.id === c.agentId)?.role === 'manager';
const byRecent = (a: ConversationSummary, b: ConversationSummary) => (b.lastMessage?.at ?? b.updatedAt) - (a.lastMessage?.at ?? a.updatedAt);

export function Organized(p: OrganizedProps) {
  const [menu, setMenu] = useState(false);
  const [toast, setToast] = useState<Toast | null>(null);
  const [pane, setPane] = useState<ListScreen>('home');
  const [calendarList, setCalendarList] = useState(false);
  useEffect(() => { if (p.screen !== 'calendar') setCalendarList(false); }, [p.screen]);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useOverlay(menu, () => setMenu(false));
  useOverlay(!p.wide && p.screen !== 'home', () => p.go('home'));
  useEffect(() => { if (menu) p.refreshUsage(); }, [menu]);
  useEffect(() => { if (isList(p.screen)) setPane(p.screen); }, [p.screen]);
  const say = (text: string, undo: (() => void) | null = null) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ text, undo }); toastTimer.current = setTimeout(() => setToast(null), 6000);
  };
  const shared = { ...p, say, openMenu: () => setMenu(true) };
  const list = p.wide ? pane : isList(p.screen) ? p.screen : null;
  const projectView = p.screen === 'project' ? <ProjectPage {...shared}/> : null;
  const listView = p.wide && projectView ? projectView : list === 'home' ? <Home {...shared}/> : list === 'chats' ? <Chats {...shared}/> : list === 'activity' ? <ActivityList {...shared}/> : list === 'todo' ? <TodoScreen {...shared}/> : null;
  const shown: DetailScreen | null = p.wide ? (isList(p.screen) ? 'chat' : p.screen) : isList(p.screen) ? null : p.screen;
  const titles = { calendar: 'Calendar', goals: 'Goals & workers', usage: 'Usage & latency' } as const;
  const body = (s: Exclude<DetailScreen, 'chat' | 'project'>) => s === 'calendar' && !calendarList ? <CalendarViews fullList={() => setCalendarList(true)}/> : p.detail(s);
  const detail = shown === null ? null : shown === 'project' ? (p.wide ? <TopicView {...shared}>{p.detail('chat')}</TopicView> : <section className="org-screen org-full">{projectView}</section>) : shown === 'chat' ? <TopicView {...shared}>{p.detail('chat')}</TopicView>
    : p.wide ? <section className="org-screen org-full"><Head title={titles[shown]}/>{body(shown)}</section>
    : <Screenful title={titles[shown]} back={() => p.go('home')}>{body(shown)}</Screenful>;
  const goList = (s: ListScreen) => { setPane(s); p.go(s); };
  return <div className={p.wide ? 'organized wide' : 'organized'}>
    {p.wide && <nav className="org-nav" aria-label="Menu">
      <strong className="org-brand">{p.boot.channel === 'beta' ? 'Kenan Beta' : 'Kenan'}</strong>
      {(['home', 'chats', 'activity', 'todo'] as const).map(s => <button key={s} aria-current={pane === s ? 'page' : undefined} onClick={() => goList(s)}>{{ home: '🏠 Home', chats: '💬 Chats', activity: '🔔 Activity', todo: '✓ To-do' }[s]}</button>)}
      {p.boot.extensions.some(e => e.id === 'calendar') && <button aria-current={p.screen === 'calendar' ? 'page' : undefined} onClick={() => p.go('calendar')}>📅 Calendar</button>}
      {pinned(p.boot).length > 0 && <h2 className="org-h">Pinned</h2>}
      {pinned(p.boot).map(c => <button key={c.id} aria-current={p.screen === 'chat' && p.active === c.id ? 'page' : undefined} onClick={() => (c.project ? p.openProject : p.open)(c.id)}>{emojiOf(c)} {c.title}</button>)}
      <div className="org-nav-menu"><MenuItems {...shared} close={() => {}}/></div>
    </nav>}
    {p.wide ? <><section className="org-list">{listView}</section><section className="org-detail">{p.banners}{detail}</section></>
      : <>{!list && p.banners}{list ? <section className="org-screen">{list === 'home' && p.banners}{listView}</section> : detail}
        {list && <nav className="org-tabs" aria-label="Sections">{(['home', 'chats', 'activity'] as const).map(s => <button key={s} aria-current={list === s ? 'page' : undefined} onClick={() => p.go(s)}>{{ home: 'Home', chats: 'Chats', activity: 'Activity' }[s]}{s === 'activity' && running(p.boot) > 0 && <span className="org-n" aria-label={`${running(p.boot)} running`}>{running(p.boot)}</span>}</button>)}</nav>}</>}
    {menu && <><button className="org-scrim" aria-label="Close menu" onClick={() => setMenu(false)}/><MenuPanel {...shared} close={() => setMenu(false)}/></>}
    {toast && <div className="org-toast" role="status"><span>{toast.text}</span>{toast.undo && <button onClick={() => { toast.undo!(); setToast(null); }}>Undo</button>}</div>}
  </div>;
}
type Shared = OrganizedProps & { say(text: string, undo?: (() => void) | null): void; openMenu(): void };
const projects = (boot: Bootstrap) => boot.conversations.filter(c => c.project && !c.archived);
const pinned = (boot: Bootstrap) => boot.conversations.filter(c => c.pinnedAt !== null && !c.archived).sort((a, b) => a.pinnedAt! - b.pinnedAt!);
const running = (boot: Bootstrap) => boot.agents.filter(a => !a.archived && a.role === 'worker' && a.state === 'running').length;

function Head({ title, back, children, count }: { title: ReactNode; back?: () => void; children?: ReactNode; count?: number }) {
  return <header className="org-head">{back && <button className="org-back" aria-label="Back" onClick={back}>‹</button>}<h1>{title}</h1>{count !== undefined && <span className="org-count" aria-label={`${count} open`}>{count}</span>}{children}</header>;
}
function Screenful({ title, back, children }: { title: string; back: () => void; children: ReactNode }) {
  return <section className="org-screen org-full"><Head title={title} back={back}/>{children}</section>;
}

function Home(p: Shared) {
  const pins = pinned(p.boot), today = (p.todos ?? []).filter(t => t.level === 'today' && !t.doneAt && !t.deletedAt);
  const recent = p.boot.conversations.filter(c => !c.archived && c.pinnedAt === null && isTopic(c, p.boot.agents)).sort(byRecent).slice(0, 3);
  const open = (p.todos ?? []).filter(t => !t.doneAt && !t.deletedAt).length;
  return <>
    <Head title="Home"><button className="org-icon" aria-label="Menu" onClick={p.openMenu}>☰</button></Head>
    <div className="org-scroll">
      {pins.length > 0 && <><h2 className="org-h">Pinned</h2><div className="org-pins">{pins.map((c, i) => { const color = c.color ?? PINNED[i % PINNED.length]!; return <button key={c.id} className="org-pin" style={{ background: rowBackground(color), borderLeftColor: color }} onClick={() => (c.project ? p.openProject : p.open)(c.id)}><span className="t">{emojiOf(c)} {c.title}</span>{c.keyDate && <span className="m">{c.keyLabel ? `${c.keyLabel} ` : ''}{shortDate(c.keyDate)}</span>}</button>; })}</div></>}
      <h2 className="org-h">Waiting on you</h2>
      {p.todos === null ? <p className="org-quiet">Loading your list…</p> : today.length ? <TodoRows items={today} colors={spread(WARM, today.length)} {...p}/> : <p className="org-quiet">Nothing for today. 🌿</p>}
      <h2 className="org-h">Recent <button className="org-link" onClick={() => p.go('chats')}>All ›</button></h2>
      {recent.length ? <TopicRows items={recent} colors={spread(COOL, recent.length)} {...p}/> : <p className="org-quiet">No conversations yet.</p>}
    </div>
    <div className="org-home-foot">
      <div className="org-quick"><button onClick={() => p.go('todo')}>✓ To-do <b>{p.todos === null ? '' : open}</b></button>{p.boot.extensions.some(e => e.id === 'calendar') && <button onClick={() => p.go('calendar')}>📅 Calendar</button>}<button className="org-fab" aria-label="New chat" onClick={p.newChat}>＋</button></div>
      <p className="org-footline">{footerLine(Date.now(), p.nextTrip)}</p>
    </div>
  </>;
}

function TodoRows(p: Shared & { items: Todo[]; colors: string[] }) {
  return <ul className="org-rows">{p.items.map((t, i) => <TodoRow key={t.id} t={t} color={p.colors[i]!} {...p}/>)}</ul>;
}
function TodoRow(p: Shared & { t: Todo; color: string | null }) {
  const { t } = p, [editing, setEditing] = useState(false), [text, setText] = useState(t.text), [moving, setMoving] = useState(false);
  const done = t.doneAt !== null;
  const tick = () => { void p.todo.change(t.id, { done: !done }); if (!done) p.say(`Done: ${t.text}`, () => void p.todo.change(t.id, { done: false })); };
  const save = () => { setEditing(false); if (text.trim() && text.trim() !== t.text) void p.todo.change(t.id, { text: text.trim() }); else setText(t.text); };
  const due = t.dueAt === null ? null : new Date(t.dueAt).toLocaleString([], t.dueAt - Date.now() < DAY ? { hour: 'numeric', minute: '2-digit' } : { month: 'short', day: 'numeric' });
  return <li className={done ? 'org-row done' : 'org-row'} style={p.color ? { background: rowBackground(p.color) } : undefined}>
    <button className="org-check" role="checkbox" aria-checked={done} aria-label={done ? `Reopen ${t.text}` : `Done: ${t.text}`} onClick={tick}><span style={checkStyle(p.color ?? '#6f7871')}>{done ? '✓' : ''}</span></button>
    {editing ? <input className="org-edit" aria-label="Edit to-do" autoFocus value={text} onChange={e => setText(e.target.value)} onBlur={save} onKeyDown={e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') { setText(t.text); setEditing(false); } }}/>
      : <button className="org-text" onClick={() => setEditing(true)} aria-label={`Edit: ${t.text}`}>{t.text}{t.tag && <span className="org-tag">{t.tag}</span>}</button>}
    {(t.remind || due) && <span className="when">{t.remind ? '🔔 ' : ''}{due ?? ''}</span>}
    <button className="org-more" aria-label={`Move or delete ${t.text}`} aria-expanded={moving} onClick={() => setMoving(!moving)}>⋯</button>
    {moving && <div className="org-pop" role="menu">{LEVELS.filter(l => l.level !== t.level || done).map(l => <button role="menuitem" key={l.level} onClick={() => { setMoving(false); void p.todo.change(t.id, done ? { level: l.level, done: false } : { level: l.level }); }}>{done ? 'Reopen in ' : 'Move to '}{l.label}</button>)}<button role="menuitem" className="org-danger" onClick={() => { setMoving(false); void p.todo.change(t.id, { deleted: true }); p.say(`Deleted: ${t.text}`, () => void p.todo.change(t.id, { deleted: false })); }}>Delete</button></div>}
  </li>;
}

function TodoScreen(p: Shared) {
  const [tab, setTab] = useState<'urgency' | 'list' | 'done'>('urgency');
  const items = (p.todos ?? []).filter(t => !t.deletedAt), open = items.filter(t => !t.doneAt).sort((a, b) => LEVELS.findIndex(l => l.level === a.level) - LEVELS.findIndex(l => l.level === b.level) || a.position - b.position), done = items.filter(t => t.doneAt).sort((a, b) => b.doneAt! - a.doneAt!);
  const colors = new Map(open.map((t, i) => [t.id, spread(WARM, open.length)[i]!]));
  const tags = [...new Set(open.map(t => t.tag ?? ''))].sort((a, b) => a === '' ? 1 : b === '' ? -1 : a.localeCompare(b));
  return <>
    <Head title="To-do" back={p.wide ? undefined : () => p.go('home')} count={open.length}/>
    <div className="org-seg" role="tablist">{([['urgency', 'By urgency'], ['list', 'By list'], ['done', 'Done']] as const).map(([k, label]) => <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>{label}</button>)}</div>
    <div className="org-scroll">
      {p.todos === null && <p className="org-quiet">Loading your list…</p>}
      {p.todos !== null && tab === 'urgency' && LEVELS.map(l => { const rows = open.filter(t => t.level === l.level); return <section key={l.level}><h2 className="org-h">{l.label}</h2>{rows.length ? <TodoRows items={rows} colors={rows.map(t => colors.get(t.id)!)} {...p}/> : <p className="org-quiet">Nothing here.</p>}<AddTodo level={l.level} label={l.label} {...p}/></section>; })}
      {p.todos !== null && tab === 'list' && (tags.length ? tags.map(tag => { const rows = open.filter(t => (t.tag ?? '') === tag); return <section key={tag}><h2 className="org-h">{tag || 'No list'}</h2><TodoRows items={rows} colors={rows.map(t => colors.get(t.id)!)} {...p}/></section>; }) : <p className="org-quiet">Nothing open. 🌿</p>)}
      {p.todos !== null && tab === 'done' && (done.length ? <ul className="org-rows">{done.map(t => <TodoRow key={t.id} t={t} color={null} {...p}/>)}</ul> : <p className="org-quiet">Nothing done in the last 30 days yet.</p>)}
    </div>
  </>;
}
function AddTodo(p: Shared & { level: TodoLevel; label: string; projectId?: string }) {
  const [text, setText] = useState('');
  return <form className="org-add" onSubmit={e => { e.preventDefault(); if (text.trim()) { void p.todo.add(text.trim(), p.level, p.projectId ?? null); setText(''); } }}><span aria-hidden="true">＋</span><input aria-label={`Add to ${p.label}`} placeholder={`Add to ${p.label.toLowerCase()}`} value={text} onChange={e => setText(e.target.value)} enterKeyHint="done"/></form>;
}

function TopicRows(p: Shared & { items: ConversationSummary[]; colors: (string | null)[]; closed?: boolean; inProject?: boolean }) {
  return <ul className="org-rows">{p.items.map((c, i) => <TopicRow key={c.id} c={c} color={p.colors[i] ?? null} closed={!!p.closed} {...p}/>)}</ul>;
}
function memberLine(p: Shared, c: ConversationSummary) {
  const others = c.memberIds.filter(id => id !== p.boot.me.id && p.boot.people.find(x => x.id === id)?.kind === 'human');
  return others.length ? `Shared · ${others.map(id => p.boot.people.find(x => x.id === id)?.name ?? id).join(', ')}` : null;
}
function TopicRow(p: Shared & { c: ConversationSummary; color: string | null; closed: boolean; inProject?: boolean }) {
  const { c } = p, [menu, setMenu] = useState(false), start = useRef<{ x: number; y: number } | null>(null);
  const activity: Activity | undefined = p.boot.activity[c.id];
  const meta = activity ? activityText(activity) : memberLine(p, c) ?? c.lastMessage?.preview ?? 'No messages yet';
  return <li className={p.closed ? 'org-row topic closed' : 'org-row topic'} style={p.color ? { background: rowBackground(p.color) } : undefined}
    onTouchStart={e => { const t = e.touches[0]!; start.current = { x: t.clientX, y: t.clientY }; }}
    onTouchEnd={e => { const s = start.current, t = e.changedTouches[0]!; start.current = null; if (s && swipeDirection(t.clientX - s.x, t.clientY - s.y) === 1) setMenu(true); }}>
    <button className="org-open" onClick={() => (c.project && !p.inProject ? p.openProject : p.open)(c.id)}>
      <span className="org-tile" style={tileStyle(p.color ?? '#8b948d')} aria-hidden="true">{emojiOf(c)}</span>
      <span className="org-body"><span className="t">{c.title || 'Conversation'}{unread(c) && <b className="org-unread" aria-label="Unread"> ●</b>}</span><span className="m">{meta}</span></span>
      <span className="when">{p.closed ? '↺' : when(c.lastMessage?.at ?? c.updatedAt)}</span>
    </button>
    <button className="org-more" aria-label={`Actions for ${c.title}`} aria-expanded={menu} onClick={() => setMenu(!menu)}>⋯</button>
    {menu && <TopicMenu {...p} close={() => setMenu(false)}/>}
  </li>;
}
/** Pin/unpin (with an optional key date), rename, emoji, close/reopen: the visible alternative to swiping a topic. */
function TopicMenu(p: Shared & { c: ConversationSummary; close(): void }) {
  const { c } = p, mine = isTopic(c, p.boot.agents) && !c.agentId;
  const act = (f: () => void) => () => { p.close(); f(); };
  return <div className="org-pop" role="menu">
    {c.pinnedAt === null ? <button role="menuitem" onClick={act(() => {
      const raw = prompt('Pin with a key date? (e.g. "Due 2026-10-29", or leave empty)', '');
      if (raw === null) return;
      const m = /^\s*(.*?)\s*(\d{4}-\d{2}-\d{2})\s*$/.exec(raw);
      void p.update(c.id, m ? { pinned: true, keyDate: m[2]!, keyLabel: m[1] || null } : { pinned: true });
    })}>📌 Pin</button> : <button role="menuitem" onClick={act(() => void p.update(c.id, { pinned: false, keyDate: null, keyLabel: null }))}>Unpin</button>}
    <button role="menuitem" onClick={act(() => { const t = prompt('Topic name (Kenan won\'t rename it after this)', c.title); if (t?.trim()) void p.update(c.id, { title: t.trim() }); })}>Rename</button>
    {c.titleLocked && <button role="menuitem" onClick={act(() => void p.update(c.id, { titleLocked: false }))}>Let Kenan rename it</button>}
    {mine && <button role="menuitem" onClick={act(() => void p.update(c.id, { project: !c.project }))}>{c.project ? 'Not a project page' : '🗂️ Make it a project page'}</button>}
    {mine && !c.project && projects(p.boot).length > 0 && <button role="menuitem" onClick={act(() => {
      const list = projects(p.boot), raw = prompt(`Put under which project?\n${list.map((x, i) => `${i + 1}. ${x.title}`).join('\n')}\n(0 = none)`, c.projectId ? String(list.findIndex(x => x.id === c.projectId) + 1) : '');
      if (raw === null) return;
      const n = Number(raw);
      if (Number.isInteger(n) && n >= 0 && n <= list.length) void p.update(c.id, { projectId: n === 0 ? null : list[n - 1]!.id });
    })}>Put under a project…</button>}
    <button role="menuitem" onClick={act(() => { const e = prompt('Emoji for this topic', c.emoji ?? ''); if (e !== null) void p.update(c.id, { emoji: e.trim() || null }); })}>Emoji</button>
    {mine && (c.archived ? <button role="menuitem" onClick={act(() => void p.update(c.id, { archived: false }))}>Reopen</button>
      : <button role="menuitem" onClick={act(() => closeTopic(p, c))}>✓ Close</button>)}
  </div>;
}
function closeTopic(p: Shared, c: ConversationSummary) {
  void p.update(c.id, { archived: true }).then(done => { if (done) p.say(`Closed: ${c.title}`, () => void p.update(c.id, { archived: false })); });
}

function Chats(p: Shared) {
  const [tab, setTab] = useState<'open' | 'pinned' | 'workers' | 'closed'>('open');
  useEffect(() => { if (tab === 'closed') p.showClosed(true); }, [tab]);
  const topics = p.boot.conversations.filter(c => isTopic(c, p.boot.agents));
  const pins = pinned(p.boot), open = topics.filter(c => !c.archived && c.pinnedAt === null).sort(byRecent);
  const workers = p.boot.agents.filter(a => a.role === 'worker' && !a.archived).sort((a, b) => b.updatedAt - a.updatedAt);
  const closed = topics.filter(c => c.archived && !c.agentId).sort(byRecent);
  return <>
    <Head title="Chats"><button className="org-icon" aria-label="New chat" onClick={p.newChat}>＋</button></Head>
    <div className="org-seg" role="tablist">{([['open', 'Open'], ['pinned', 'Pinned'], ['workers', 'Workers'], ['closed', 'Closed']] as const).map(([k, label]) => <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>{label}</button>)}</div>
    <div className="org-scroll">
      {(tab === 'open' || tab === 'pinned') && pins.length > 0 && <><h2 className="org-h">Pinned</h2><TopicRows items={pins} colors={pins.map((c, i) => c.color ?? PINNED[i % PINNED.length]!)} {...p}/></>}
      {tab === 'pinned' && !pins.length && <p className="org-quiet">Nothing pinned. Use ⋯ on a topic to pin it.</p>}
      {tab === 'open' && <><h2 className="org-h">Topics</h2>{open.length ? <><p className="org-hint">Swipe a topic left, or tap ⋯, to close or pin it.</p><TopicRows items={open} colors={spread(COOL, open.length)} {...p}/></> : <p className="org-quiet">No open topics.</p>}</>}
      {tab === 'workers' && (workers.length ? <ul className="org-rows">{workers.map(a => <li key={a.id} className="org-row topic"><button className="org-open" onClick={() => p.open(a.conversationId)}><span className="org-tile" style={tileStyle('#8b948d')} aria-hidden="true">🧑‍🔧</span><span className="org-body"><span className="t">{a.name}</span><span className="m">{p.boot.activity[a.conversationId] ? activityText(p.boot.activity[a.conversationId]!) : agentStatus(a).kind === 'waiting' ? `⚠ ${statusText(agentStatus(a), undefined, Date.now())}` : a.lastReport ? `${a.lastReport.status === 'done' ? 'Done' : a.lastReport.status === 'handed_off' ? 'Handed off' : 'Blocked'}: ${a.lastReport.text.slice(0, 80)}` : a.state}</span></span><span className="when">{when(a.updatedAt)}</span></button></li>)}</ul> : <p className="org-quiet">No workers right now.</p>)}
      {tab === 'closed' && <><h2 className="org-h">Closed topics</h2><p className="org-hint">Nothing is deleted. Tap ⋯ to reopen.</p>{!p.closedLoaded ? <p className="org-quiet">Loading…</p> : closed.length ? <TopicRows items={closed} colors={closed.map(() => null)} closed {...p}/> : <p className="org-quiet">No closed topics.</p>}</>}
    </div>
  </>;
}

function ActivityList(p: Shared) {
  const items = p.boot.agents.filter(a => a.role === 'worker' && (a.lastReport || p.boot.activity[a.conversationId])).sort((a, b) => (b.lastReport?.at ?? b.updatedAt) - (a.lastReport?.at ?? a.updatedAt)).slice(0, 40);
  return <>
    <Head title="Activity"/>
    <div className="org-scroll">
      {items.length ? <ul className="org-rows">{items.map(a => { const live = p.boot.activity[a.conversationId]; return <li key={a.id} className="org-row topic"><button className="org-open" onClick={() => p.open(a.conversationId)}><span className="org-tile" style={tileStyle(a.lastReport?.status === 'blocked' && !live ? '#e83a3a' : '#8b948d')} aria-hidden="true">{live ? '⏳' : a.lastReport?.status === 'blocked' ? '⚠️' : '✓'}</span><span className="org-body"><span className="t">{a.name}</span><span className="m">{live ? activityText(live) : `${a.lastReport!.status === 'blocked' ? 'Blocked: ' : ''}${a.lastReport!.text.replace(/\s+/g, ' ').slice(0, 100)}`}</span></span><span className="when">{when(a.lastReport?.at ?? a.updatedAt)}</span></button></li>; })}</ul> : <p className="org-quiet">Nothing has happened in the background yet.</p>}
    </div>
  </>;
}

function TopicView(p: Shared & { children: ReactNode }) {
  const c = p.boot.conversations.find(x => x.id === p.active);
  const closable = !!c && !c.archived && isTopic(c, p.boot.agents) && !c.agentId;
  const [menu, setMenu] = useState(false);
  return <section className="org-screen org-full org-topic">
    <Head title={c ? <>{emojiOf(c)} {c.title}</> : 'Conversation'} back={p.wide ? undefined : () => p.go('home')}>
      {c && memberLine(p, c) && <span className="org-shared">Shared</span>}
      {closable && <button className="org-grey" onClick={() => { closeTopic(p, c!); if (!p.wide) p.go('chats'); }}>✓ Close</button>}
      {c && <span className="org-menu-anchor"><button className="org-icon" aria-label="Topic actions" aria-expanded={menu} onClick={() => setMenu(!menu)}>⋯</button>{menu && <TopicMenu {...p} c={c} close={() => setMenu(false)}/>}</span>}
    </Head>
    {c?.archived && <div className="archive-banner"><span>This topic is closed.</span><button className="org-grey" onClick={() => void p.update(c.id, { archived: false })}>Reopen</button></div>}
    {p.children}
  </section>;
}

function MenuItems(p: Shared & { close(): void }) {
  const go = (s: Screen) => () => { p.close(); p.go(s); };
  const openGoals = p.goals.filter(g => g.status === 'open').length;
  return <>
    <h2 className="org-label" id="layout-label">Layout</h2>
    <div className="org-switch" role="radiogroup" aria-labelledby="layout-label">{(['classic', 'organized'] as const).map(l => <button key={l} role="radio" aria-checked={p.boot.layout === l} onClick={() => { p.close(); p.setLayout(l); }}>{l === 'classic' ? 'Classic' : 'Organized'}</button>)}</div>
    {p.boot.extensions.some(e => e.id === 'calendar') && !p.wide && <button className="org-item" onClick={go('calendar')}>📅 Calendar</button>}
    <button className="org-item" onClick={go('usage')}>📊 Usage & latency {p.weeklyLeft !== null && <small>{Math.round(p.weeklyLeft)}% week</small>}</button>
    <button className="org-item" onClick={go('goals')}>🧑‍🔧 Goals & workers <small>{openGoals} {openGoals === 1 ? 'goal' : 'goals'}</small></button>
    <button className="org-item" onClick={p.toggleFoldWork}>🧩 Work steps <small>{p.foldWork ? 'Folded' : 'Shown'}</small></button>
    {p.push}
    <hr/>
    {p.checkUpdate && <button className="org-item" onClick={() => { p.close(); p.checkUpdate!(); }}>⬇️ Check for app update</button>}
    <button className="org-item org-danger" onClick={p.signOut}>↪ Sign out</button>
  </>;
}
function MenuPanel(p: Shared & { close(): void }) {
  const start = useRef<{ x: number; y: number } | null>(null);
  return <aside className="org-sheet" aria-label="Menu" onTouchStart={e => { const t = e.touches[0]!; start.current = { x: t.clientX, y: t.clientY }; }}
    onTouchEnd={e => { const s = start.current, t = e.changedTouches[0]!; start.current = null; if (s && swipeDirection(t.clientX - s.x, t.clientY - s.y) === -1) p.close(); }}>
    <div className="org-who"><span className="org-avatar" aria-hidden="true">{p.boot.me.name.slice(0, 1)}</span><div><strong>{p.boot.me.name}</strong><small>Kenan · {p.boot.channel}</small></div></div>
    <MenuItems {...p}/>
  </aside>;
}

/** The To-do screen inside the Classic layout (its ☰ footer opens it). */
export function ClassicTodo({ todos, todo }: { todos: Todo[] | null; todo: TodoActions }) {
  const [toast, setToast] = useState<Toast | null>(null);
  const say = (text: string, undo: (() => void) | null = null) => { setToast({ text, undo }); setTimeout(() => setToast(current => current?.text === text ? null : current), 6000); };
  const p = { todos, todo, say, wide: true, go: () => {} } as unknown as Shared;
  return <div className="organized classic-todo"><TodoScreen {...p}/>{toast && <div className="org-toast" role="status"><span>{toast.text}</span>{toast.undo && <button onClick={() => { toast.undo!(); setToast(null); }}>Undo</button>}</div>}</div>;
}

/** A pinned topic as a project page (mockup 4-candef): status line, its to-dos, its chats and its files. */
function ProjectPage(p: Shared) {
  const c = p.boot.conversations.find(x => x.id === p.active);
  const [files, setFiles] = useState<{ id: string; name: string; mime: string }[] | null>(null);
  const [failed, setFailed] = useState('');
  useEffect(() => {
    if (!c) return;
    let current = true; setFiles(null); setFailed('');
    api<{ id: string; name: string; mime: string }[]>(`/ext/organized/projects/${encodeURIComponent(c.id)}/files`).then(v => { if (current) setFiles(v); }, e => { if (current) setFailed(String(e)); });
    return () => { current = false; };
  }, [c?.id]);
  if (!c) return <><Head title="Project" back={() => p.go('home')}/><p className="org-quiet">This project isn't available.</p></>;
  const color = c.color ?? PINNED[Math.max(0, pinned(p.boot).findIndex(x => x.id === c.id)) % PINNED.length]!;
  const todos = (p.todos ?? []).filter(t => t.conversationId === c.id && !t.doneAt && !t.deletedAt);
  const rooms = p.boot.conversations.filter(x => x.projectId === c.id && !x.archived).sort(byRecent);
  const newChat = async () => {
    const title = prompt('New chat in this project'); if (!title?.trim()) return;
    const room = await api<ConversationSummary>('/conversations', 'POST', { title: title.trim(), memberIds: [p.boot.me.id] });
    await p.update(room.id, { projectId: c.id }); p.open(room.id);
  };
  return <>
    <Head title={<>{emojiOf(c)} {c.title}</>} back={p.wide ? undefined : () => p.go('home')}><button className="org-grey" onClick={() => p.open(c.id)}>Open chat</button></Head>
    <div className="org-scroll">
      <button className="org-status" style={{ borderLeftColor: color }} aria-label="Edit the project status" onClick={() => { const s = prompt('Project status (one line)', c.statusLine ?? ''); if (s !== null) void p.update(c.id, { statusLine: s.trim() || null }); }}>
        {c.statusLine ?? 'No status yet. Tap to write one, or ask Kenan to keep it updated.'}{c.keyDate && <small>{c.keyLabel ? `${c.keyLabel} ` : ''}{shortDate(c.keyDate)}</small>}
      </button>
      <h2 className="org-h">Waiting on you</h2>
      {todos.length ? <TodoRows items={todos} colors={spread(WARM, todos.length)} {...p}/> : <p className="org-quiet">Nothing waiting for this project.</p>}
      <AddTodo level="week" label="This week" projectId={c.id} {...p}/>
      <h2 className="org-h">Chats <button className="org-link" onClick={() => void newChat().catch(e => p.say(`Couldn't create the chat: ${String(e)}`))}>＋ New</button></h2>
      <TopicRows items={[c, ...rooms]} colors={spread(COOL, rooms.length + 1)} inProject {...p}/>
      <h2 className="org-h">Files</h2>
      {failed ? <p className="org-quiet" role="alert">Couldn't load the files: {failed}</p> : files === null ? <p className="org-quiet">Loading…</p> : files.length ? <ul className="org-rows">{files.map(f => <li key={f.id} className="org-row topic"><a className="org-open" href={apiPath(`/api/files/${encodeURIComponent(f.id)}`)} target="_blank" rel="noreferrer"><span className="org-tile" style={tileStyle('#8b948d')} aria-hidden="true">{f.mime.startsWith('image/') ? '🖼️' : f.mime === 'application/pdf' ? '📄' : '📎'}</span><span className="org-body"><span className="t">{f.name}</span></span></a></li>)}</ul> : <p className="org-quiet">No files in this project's chats yet.</p>}
    </div>
  </>;
}
