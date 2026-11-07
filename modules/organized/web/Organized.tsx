import { NavDrawer, type DrawerControl, type DrawerSkin } from '../../../web/NavDrawer.js';
import { roomActionsAllowed, sharedRoom, useLeaveChat } from '../../../web/RoomMenu.js';
import { useRoomPress } from '../../../web/roomPress.js';
// The Organized layout (opt-in per person, PUT /api/layout): Home, Chats, Activity and To-do screens around the same
// conversation, calendar, goals and usage views the Classic layout shows. Phones get one screen at a time with a tab bar;
// wide screens get three panes (menu, list, open conversation). Mockups: Carol's design/final.
import { createContext, lazy, Suspense, useContext, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { plainPreview, unread, type Activity, type AgentInfo, type Bootstrap, type BuyList, type ChatGroup, type ChatGroupInput, type ConversationPatch, type ConversationSummary, type GoalSummary, type Layout, type Mark, type TrayTile, type Tip, type Todo, type TodoLevel } from '../../../shared/contract.js';
import { byRecent, positionColors } from '../../../shared/colors.js';
import { checkStyle, rowBackground, tileStyle, todoColors } from './colors.js';
import { activityText } from '../../../web/activity.js';
import { agentStatus, statusText } from '../../../web/AgentTree.js';
import { dismissTop, useOverlay } from '../../../web/overlay.js';
import { FilePart, useImageViewer } from '../../../web/FilePart.js';
import { swipeDirection } from '../../../web/gallery.js';
import { CalendarViews, type CalEvent, type CalSource } from './CalendarViews.js';
import { AskSheet, type Ask } from './sheets.js';
import { SystemSection } from '../../../web/SystemSection.js';
import { BlankButton } from '../../../web/BlankButton.js';
import { blankAgentOf, openBlankChats, type BlankStarted } from '../../../web/blank.js';
import { api } from '../../../web/client.js';
import { ChatLinkContext } from '../../../web/chatLinks.js';
import { apiPath } from '../../../web/path.js';
import { chatTodo, type TodoChange } from '../../../web/todo/todo.js';
import { TodoRows, TodoScreen, daysUntil, dayLabel, todayDate, todoHandlers, LEVELS, type TodoActions, type Toast } from '../../../web/todo/TodoScreen.js';
import { setAppMinimum } from '../../../web/FileViewer.js';
import { MessageMarkdown } from '../../../web/MessageMarkdown.js';
import { CompactMenu, type Place } from '../../../web/CompactMenu.js';
import Settings, { type Push } from '../../../web/Settings.js';
import { MAIN_EMOJI, isMainChat, mainChat, type MainChat } from './home.js';
import { homeWaiting, todoSections, urgentFirst } from '../../../shared/todo.js';

import { isList, type DetailScreen, type ListScreen, type Screen, type Trip } from './screens.js';
import { seenFromText, type QuickChat } from './quick.js';
export { quickChat } from './quick.js';
import { useAnchoredMenu, useFocusInside } from '../../../web/menuPlacement.js';
import { DETAIL_MIN, clampPane, PANES, paneWidths, readChosen, saveChosen, UNCHOSEN, type Chosen, type Pane } from './panes.js';
import { Divider } from '../../../web/Divider.js';
import './organized.css';
import { bridge, call } from '../../../web/native.js';
import { formatDate, localDate } from '../../../web/dates.js';

const ToBuy = lazy(() => import('../../../web/todo/ToBuy.js'));
/** 📰 What's new is its own chunk, fetched when she opens it. */
const WhatsNew = lazy(() => import('./WhatsNew.js'));

const MENU_SKIN: DrawerSkin = { scrim: 'org-scrim', panel: 'org-sheet', closeLabel: 'Close menu', label: 'Menu', swipeClose: true };
export type { Screen, TodoActions };
export { dayLabel, daysUntil };
/** The person's chat groups (Chats sections). remove answers the rooms it left ungrouped (for Undo), null when it failed. */
export interface GroupActions {
  create(input: ChatGroupInput): Promise<ChatGroup | null>;
  change(id: string, patch: Partial<ChatGroupInput>): Promise<void>;
  remove(id: string): Promise<string[] | null>;
}
export interface OrganizedProps {
  boot: Bootstrap; goals: GoalSummary[]; todos: Todo[] | null; todo: TodoActions;
  /** The 🛒 To buy list (null until the tab first loads it) and where a fresh copy goes. */
  buy: BuyList | null; setBuy(list: BuyList): void; groups: ChatGroup[] | null; groupsApi: GroupActions;
  screen: Screen; go(screen: Screen): void; active: string | null; open(id: string): void; openProject(id: string): void;
  detail(screen: Exclude<DetailScreen, 'project'>): ReactNode; banners: ReactNode; push: Push;
  wide: boolean; connected: boolean;
  setLayout(layout: Layout): void; seeTip(tip: Mark): void;
  /** Set when the person has background art: whether it stands still under the system's reduced motion, and the switch. */
  skyMotion: { followsSystem: boolean; toggle(): void } | null;
  /** Set when the person has background art: shows the art alone, full screen (the 🌌 Sky tile). */
  showSky: (() => void) | null;
  checkUpdate: (() => void) | null; chooseTray(tiles: TrayTile[] | null): void; signOut(): void; weeklyLeft: number | null; refreshUsage(): void;
  /** A chat she just started, kept until its stream event lands. */
  added(c: ConversationSummary): void; update(id: string, patch: ConversationPatch): Promise<ConversationSummary | null>;
  leave(id: string): Promise<void>;
  showClosed(include: boolean): void; closedLoaded: boolean; nextTrip: Trip | null;
  /** Demo mode: made-up data held in memory only (?demo=1); switching layout leaves it. */
  demo: boolean; leaveDemo(): void;
  /** Her Kenaznia chat for the 🌀 bubble's quick panel; null when her Kenaznia answers elsewhere or not at all. */
  quick: QuickChat | null;
  /** Blank chats (web/BlankChat.tsx): one just started, and closing one. */
  blank: { started(chat: BlankStarted): void; close(agentId: string): void };
}
/** The 🌀 bubble is its own chunk, fetched only for people with the `bubble` extension. */
const Bubble = lazy(() => import('./Bubble.js'));
type FileRef = { id: string; name: string; mime: string };
/** Where the screens read and write what isn't in the props: the server, or the in-memory demo. */
interface Source {
  calendar: CalSource;
  files(projectId: string): Promise<FileRef[]>;
  fileHref(id: string): string | null;
  /** A new chat with her Kenaznia and these people; no title: Kenaznia names it later. */
  startChat(title: string | null, people: string[]): Promise<ConversationSummary>;
}
const serverSource: Source = {
  calendar: {
    list: (from, to) => api<CalEvent[]>(`/ext/calendar?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`),
    update: (id, input) => api(`/ext/calendar/${encodeURIComponent(id)}`, 'PATCH', input),
    remove: id => api(`/ext/calendar/${encodeURIComponent(id)}`, 'DELETE'),
    restore: id => api(`/ext/calendar/${encodeURIComponent(id)}/restore`, 'POST', {}),
  },
  files: id => api<FileRef[]>(`/ext/organized/projects/${encodeURIComponent(id)}/files`),
  fileHref: id => apiPath(`/api/files/${encodeURIComponent(id)}`),
  startChat: (title, people) => api<ConversationSummary>('/ext/organized/chats', 'POST', { title, people }),
};
export type ViewProps = OrganizedProps & { source: Source };

/** Each screen's first-visit tip (Carol 2026-10-22), shown until its OK, once per person on any device. */
export const TIP_TEXT: Record<Mark, string> = {
  home: "Home: what's waiting on you today, what you've pinned, and your Kenaznia chat.",
  chats: 'Every chat here is the same Kenaznia, with one memory. Chats just keep topics apart.',
  bubble: "Tap me to talk to Kenaznia from any page. Drop me on ✕ to hide me: I'll wait as a small 🌀 on the tab bar, and you can drag me back out anytime.",
};
/** The tip the list screen in view still owes, or null; a toast showing holds it back, so two bubbles never stack. */
export const tipFor = (list: ListScreen | null, seen: readonly string[], toast: boolean): Tip | null =>
  !toast && (list === 'home' || list === 'chats') && !seen.includes(list) ? list : null;
const DAY = 86_400_000;
const shortDate = (iso: string) => formatDate(new Date(`${iso}T12:00:00`), { month: 'short', day: 'numeric' });
const when = (at: number, now = Date.now()) => now - at < DAY && new Date(at).getDate() === new Date(now).getDate()
  ? formatDate(new Date(at), { hour: 'numeric', minute: '2-digit' })
  : now - at < 6 * DAY ? formatDate(new Date(at), { weekday: 'short' }) : formatDate(new Date(at), { month: 'short', day: 'numeric' });
/** A chat's own emoji; without one her Kenaznia chat is 🌀, a chat shared with other people 👥, others borrow their group's
 *  (Carol 2026-10-21: a wall of 💬 looks dull), then 📄: never 💬, which is the unread mark here (Carol 2026-10-28).
 *  groupEmoji, mainId and humans are refreshed from what OrganizedView renders with, so every call site agrees. */
let groupEmoji = new Map<string, string>(), mainId: string | null = null, humans = new Set<string>();
const emojiOf = (c: ConversationSummary) => c.emoji ?? (c.id === mainId ? MAIN_EMOJI : undefined)
  ?? (c.memberIds.filter(id => humans.has(id)).length >= 2 ? '👥' : undefined) ?? (c.groupId ? groupEmoji.get(c.groupId) : undefined) ?? '📄';
export function footerLine(now: number, trip: Trip | null): string {
  const date = formatDate(new Date(now), { weekday: 'short', month: 'short', day: 'numeric' });
  if (!trip) return date;
  const days = daysUntil(trip.at, now);
  return `${date} · ✈️ ${days === 0 ? `today to ${trip.place}` : days === 1 ? `1 day until ${trip.place}` : `${days} days until ${trip.place}`}`;
}
/** The topic list: the person's own Kenaznia chat and rooms; workers' chats live in the Workers tab. */
export const isTopic = (c: ConversationSummary, agents: AgentInfo[]) => !c.agentId || agents.find(a => a.id === c.agentId)?.role === 'manager';

/** Demo mode is its own chunk, fetched only with ?demo=1. */
const DemoOrganized = lazy(() => import('./DemoOrganized.js'));
export function Organized(p: OrganizedProps) {
  return p.demo ? <Suspense fallback={<p className="org-quiet">Opening the demo…</p>}><DemoOrganized {...p}/></Suspense> : <OrganizedView {...p} source={serverSource}/>;
}

export function OrganizedView(p: ViewProps) {
  const back = useContext(ChatLinkContext)?.back ?? undefined;
  groupEmoji = new Map((p.groups ?? []).flatMap(g => g.emoji ? [[g.id, g.emoji] as [string, string]] : []));
  mainId = mainChat(p.boot)?.conversation.id ?? null;
  humans = new Set(p.boot.people.filter(x => x.kind === 'human').map(x => x.id));
  const menuControl: DrawerControl = useRef(null);
  const setMenu = (open: boolean) => menuControl.current?.(open);
  const [toast, setToast] = useState<Toast | null>(null);
  const [pane, setPane] = useState<ListScreen>('home');
  const [ask, setAsk] = useState<Ask | null>(null);
  // 📰 What's new's dot: a change newer than her last visit (Carol 2026-10-27); demo mode has no changelog.
  const newsOn = !p.demo && p.boot.extensions.some(e => e.id === 'changelog');
  const [newsDot, setNewsDot] = useState(false);
  useEffect(() => {
    if (!newsOn) return;
    const refresh = () => { void api<boolean>('/ext/changelog/unseen', 'GET', undefined, { background: true }).then(setNewsDot, () => {}); };
    refresh();
    window.addEventListener('kenan-refresh', refresh);
    return () => window.removeEventListener('kenan-refresh', refresh);
  }, [newsOn]);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The docked file panel leaves the menu and list as she sized them plus a readable chat.
  useEffect(() => {
    setAppMinimum(() => {
      const wide = document.querySelector('.organized.wide');
      if (!wide) return 380;
      const width = (selector: string) => wide.querySelector<HTMLElement>(selector)?.offsetWidth ?? 0;
      return width('.org-nav') + width('.org-list') + DETAIL_MIN;
    });
    return () => setAppMinimum(null);
  }, []);
  useOverlay(!p.wide && p.screen !== 'home', () => p.go('home'));
  // The secondary pane only exists on desktop. Updating it on a phone rendered each tab twice.
  useEffect(() => { if (p.wide && isList(p.screen)) setPane(p.screen); }, [p.wide, p.screen]);
  const say = (text: string, undo: (() => void) | null = null) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ text, undo }); toastTimer.current = setTimeout(() => setToast(null), 6000);
  };
  const { requestLeave, confirmation } = useLeaveChat(p.leave);
  const shared = { ...p, back, requestLeave, say, openMenu: () => setMenu(true), ask: setAsk, newsOn, newsDot };
  const list = p.wide ? pane : isList(p.screen) ? p.screen : null;
  const projectView = p.screen === 'project' ? <ProjectPage {...shared}/> : null;
  const listView = p.wide && projectView ? projectView : list === 'home' ? <Home {...shared}/> : list === 'chats' ? <Chats {...shared}/> : list === 'activity' ? <ActivityList {...shared}/> : list === 'todo' ? <TodoScreen {...shared} header={(swap, view) => <Head title={view === 'todo' ? 'To-do' : 'To buy'} back={shared.back ?? (shared.wide ? undefined : () => shared.go('home'))}>{swap}</Head>}/> : null;
  const shown: DetailScreen | null = p.wide ? (isList(p.screen) ? 'chat' : p.screen) : isList(p.screen) ? null : p.screen;
  const titles = { search: 'Search', calendar: 'Calendar', goals: 'Goals & workers', usage: 'Usage', news: "📰 What's new" } as const;
  const body = (s: Exclude<DetailScreen, 'chat' | 'project'>) => s === 'calendar'
    ? <CalendarViews key={p.demo ? 'demo' : 'server'} source={p.source.calendar} say={say} todos={{ items: (p.todos ?? []).filter(t => t.onDate !== null && !t.deletedAt), tick: t => todoHandlers(shared, t).tick(), open: t => todoHandlers(shared, t).doIt() }}/>
    : s === 'news' ? <Suspense fallback={<p className="org-quiet">Loading…</p>}><WhatsNew seen={() => setNewsDot(false)}/></Suspense>
    : p.detail(s);
  const detail = shown === null ? null : shown === 'project' ? (p.wide ? <TopicView {...shared}>{p.detail('chat')}</TopicView> : <section className="org-screen org-full">{projectView}</section>) : shown === 'chat' ? <TopicView {...shared}>{p.detail('chat')}</TopicView>
    : p.wide ? <section className="org-screen org-full"><Head title={titles[shown]} back={back}/>{body(shown)}</section>
    : <Screenful title={titles[shown]} back={back ?? (() => p.go('home'))}>{body(shown)}</Screenful>;
  const goList = (s: ListScreen) => { setPane(s); p.go(s); };
  // The 🌀 bubble (Carol 2026-10-22): on Home, To-do, Chats, Calendar and project pages, never over a chat or its
  // composer; on wide screens only while the main pane shows something other than a chat (mockup H).
  const bubbleHere = p.quick !== null && p.boot.extensions.some(e => e.id === 'bubble')
    && (p.wide ? shown === 'calendar' || shown === 'goals' || shown === 'usage' || shown === 'news' : (list !== null && list !== 'activity') || p.screen === 'calendar' || p.screen === 'project');
  const seenFrom = () => {
    const root = document.querySelector('.organized'), text = (selector: string) => root?.querySelector(selector)?.textContent ?? null;
    const project = p.screen === 'project' ? p.boot.conversations.find(c => c.id === p.active) : undefined;
    const main = p.screen === 'calendar' ? ['Calendar', `${text('.org-cal-switch [aria-checked="true"]') ?? ''} view`, text('.org-cal-nav strong')]
      : project ? [`Project page: ${project.title}`] : p.wide && shown !== 'chat' && shown !== null && shown !== 'project' ? [titles[shown]] : [];
    const listName = list === null || projectView ? null : { home: 'Home', chats: 'Chats', activity: 'Activity', todo: 'To-do' }[list];
    const side = listName ? [listName, list === 'chats' ? text('.org-seg [aria-selected="true"]') : null] : [];
    return main.length && side.length ? seenFromText([...main, `beside ${seenFromText(side)}`]) : seenFromText([...main, ...side]);
  };
  const listTip = tipFor(projectView ? null : list, p.boot.seen, toast !== null);
  // The 🌀 tip (Carol 2026-10-25): once, the first time the bubble shows, after the screen's own tip.
  const tip: Mark | null = listTip ?? (bubbleHere && toast === null && !p.boot.seen.includes('bubble') ? 'bubble' : null);
  const panes = usePanes(p.wide, p.boot.me.id);
  return <DemoBadge.Provider value={p.demo}><div className={p.wide ? 'organized wide' : 'organized'} ref={panes.shell}>
    {!p.wide && <NavDrawer control={menuControl} skin={MENU_SKIN}><MenuPanel {...shared} close={() => setMenu(false)}/></NavDrawer>}
    {p.wide && <nav className="org-nav" aria-label="Menu" ref={panes.nav} style={{ width: panes.widths.nav }}>
      {(['home', 'usage', 'chats', 'activity', 'todo'] as const).map(s => <button key={s} aria-current={(s === 'usage' ? p.screen === s : pane === s && p.screen !== 'usage' && !projectView) ? 'page' : undefined} onClick={() => s === 'usage' ? p.go(s) : goList(s)}>{{ home: '🏠 Home', usage: '◴ Usage', chats: '💬 Chats', activity: '🔔 Activity', todo: '✓ To-do' }[s]}{s === 'chats' && anyUnread(p.boot) && <UnreadMark/>}</button>)}
      <button aria-current={p.screen === 'search' ? 'page' : undefined} onClick={() => p.go('search')}>⌕ Search</button>
      {p.boot.extensions.some(e => e.id === 'calendar') && <button aria-current={p.screen === 'calendar' ? 'page' : undefined} onClick={() => p.go('calendar')}>📅 Calendar</button>}
      {pinned(p.boot).length > 0 && <h2 className="org-h">Pinned</h2>}
      {pinned(p.boot).map(c => <TopicPin key={c.id} {...shared} c={c} nav/>)}
      <div className="org-nav-menu"><MenuItems {...shared} close={() => {}} mode="toggle"/></div>
    </nav>}
    {p.wide ? <>{panes.divider('nav', 'Resize the menu')}<section className="org-list" ref={panes.list} style={{ width: panes.widths.list }}>{listView}</section>{panes.divider('list', 'Resize the list')}<section className="org-detail">{p.banners}{detail}</section></>
      : <>{!list && p.banners}{list ? <section className="org-screen">{list === 'home' && p.banners}{listView}</section> : detail}
        {list && <nav className="org-tabs" aria-label="Sections">{(['home', 'chats', 'activity'] as const).map(s => <button key={s} aria-current={list === s ? 'page' : undefined} onClick={() => p.go(s)}>{{ home: 'Home', chats: 'Chats', activity: 'Activity' }[s]}{s === 'chats' && anyUnread(p.boot) && <UnreadMark/>}{s === 'activity' && running(p.boot) > 0 && <span className="org-n" aria-label={`${running(p.boot)} running`}>{running(p.boot)}</span>}</button>)}</nav>}</>}
    {confirmation}
    {ask && <AskSheet ask={ask} close={() => setAsk(null)}/>}
    {toast && <div className="org-toast" role="status"><span>{toast.text}</span>{toast.undo && <button onClick={() => { toast.undo!(); setToast(null); }}>Undo</button>}</div>}
    {tip && <div className="org-toast org-tip" role="status"><span>{TIP_TEXT[tip]}</span><button onClick={() => p.seeTip(tip)}>OK</button></div>}
    {bubbleHere && <Suspense fallback={null}><Bubble FilePart={FilePart} chat={p.quick!} wide={p.wide} where={`${p.screen}:${list}:${pane}`} seenFrom={seenFrom} openChat={() => p.open(p.quick!.conversationId)}/></Suspense>}
  </div></DemoBadge.Provider>;
}
type Shared = ViewProps & { back?: () => void; requestLeave(c: ConversationSummary): void; say(text: string, undo?: (() => void) | null): void; openMenu(): void; ask(a: Ask): void; newsOn: boolean; newsDot: boolean };
/** Chats' ＋ New chat (Carol 2026-10-22, mockup design/newchat/newchat-B.png): an optional title and the people to add. */
function newChatSheet(p: Shared) {
  const people = p.boot.people.filter(x => x.kind === 'human' && x.id !== p.boot.me.id).map(x => ({ id: x.id, name: x.name }));
  p.ask({ kind: 'newChat', people, start: async (title, ids) => {
    try { const room = await p.source.startChat(title, ids); p.added(room); p.open(room.id); return null; }
    catch (e) { return `Couldn't start the chat: ${e instanceof Error ? e.message : String(e)}`; }
  } });
}
const projects = (boot: Bootstrap) => boot.conversations.filter(c => c.project && !c.archived);
/** Whether any open topic other than her Kenaznia chat (which has its own row on Home) has a message she hasn't read: the 💬 on the Chats tab,
 *  so a chat that isn't pinned still shows from Home that something new came in (Carol 2026-10-30). */
const anyUnread = (boot: Bootstrap) => boot.conversations.some(c => !c.archived && isTopic(c, boot.agents) && !isMainChat(boot, c) && unread(c));
const pinned = (boot: Bootstrap) => boot.conversations.filter(c => c.pinnedAt !== null && !c.archived && !isMainChat(boot, c) && !boot.agents.some(a => a.conversationId === c.id && a.category === 'upkeep')).sort((a, b) => (a.pinnedAt ?? 0) - (b.pinnedAt ?? 0));
/** Each open topic's own colour (the server sets one for every topic; positionColors only covers the moment before it lands). */
const topicColors = (p: Shared) => positionColors(p.boot.conversations.filter(c => isTopic(c, p.boot.agents) && !isMainChat(p.boot, c)), p.groups ?? []);
const running = (boot: Bootstrap) => boot.agents.filter(a => !a.archived && a.role === 'worker' && a.category !== 'upkeep' && a.state === 'running').length;

/** Whether every screen's header shows the Demo pill (in the header row, so it never covers other text). */
const DemoBadge = createContext(false);
function Head({ title, back, children, count }: { title: ReactNode; back?: () => void; children?: ReactNode; count?: number }) {
  const demo = useContext(DemoBadge);
  return <header className="org-head">{back && <button className="org-back" aria-label="Back" onClick={back}>‹</button>}<h1>{title}</h1>{demo && <span className="org-demo" role="status">Demo</span>}{count !== undefined && <span className="org-count" aria-label={`${count} open`}>{count}</span>}{children}</header>;
}
/** The wide layout's menu and list widths: dragged dividers, kept per person on this device (Erin 2026-10-28). */
function usePanes(wide: boolean, personId: string) {
  const shell = useRef<HTMLDivElement>(null), nav = useRef<HTMLElement>(null), list = useRef<HTMLElement>(null);
  const [chosen, setChosen] = useState<Chosen>(() => readChosen(personId));
  const [total, setTotal] = useState(Number.POSITIVE_INFINITY);
  useEffect(() => {
    const el = shell.current;
    if (!wide || !el) return;
    const seen = new ResizeObserver(() => setTotal(el.clientWidth));
    seen.observe(el);
    return () => seen.disconnect();
  }, [wide]);
  const widths = paneWidths(chosen, total); // total is unmeasured (infinite) only until the first layout
  const keep = (next: Chosen, done: boolean) => { setChosen(next); if (done) saveChosen(personId, next); };
  const divider = (pane: Pane, label: string) => <Divider className="org-divider" label={label} width={widths[pane]} min={PANES[pane].min} max={PANES[pane].max}
    widthAt={x => x - ((pane === 'nav' ? nav : list).current?.getBoundingClientRect().left ?? 0)} grows="ArrowRight"
    resize={(width, done) => keep({ ...chosen, [pane]: clampPane(pane, width) }, done)}
    reset={() => keep({ ...chosen, [pane]: UNCHOSEN[pane] }, true)}/>;
  return { shell, nav, list, widths, divider };
}

/** A chat with messages she hasn't read (Chats rows, Home's pinned cards, the wide sidebar's pins). */
const UnreadMark = () => <span className="org-unread" role="img" aria-label="unread">💬</span>;
function Screenful({ title, back, children }: { title: string; back: () => void; children: ReactNode }) {
  return <section className="org-screen org-full"><Head title={title} back={back}/>{children}</section>;
}

function Home(p: Shared) {
  const systemWorkers = p.boot.agents.filter(a => a.role === 'worker' && !a.archived && a.category === 'upkeep');
  const pins = pinned(p.boot), waiting = homeWaiting(p.todos ?? [], todayDate());
  const open = (p.todos ?? []).filter(t => !t.doneAt && !t.deletedAt).length, main = mainChat(p.boot), colors = topicColors(p);
  return <div className="org-home org-dense">
    <Head title="Home"><button className="org-grey" onClick={() => p.go('usage')}>Usage</button><button className="org-icon" aria-label={p.newsDot ? "Menu: something new in What's new" : 'Menu'} onClick={p.openMenu}>☰{p.newsDot && <i className="cm-dot" aria-hidden="true"/>}</button></Head>
    <div className="org-scroll">
      {pins.length > 0 && <><h2 className="org-h">Pinned</h2><div className="org-pins">{pins.map(c => <TopicPin key={c.id} {...p} c={c} color={colors.get(c.id) ?? c.color ?? '#8b948d'}/>)}</div></>}
      <h2 className="org-h">Waiting on you</h2>
      {p.todos === null ? <p className="org-quiet">Loading your list…</p> : waiting.length ? <TodoRows items={waiting} colors={todoColors(p.todos ?? [], todayDate())} {...p}/> : <p className="org-quiet">Nothing for today. 🌿</p>}
      <SystemSection count={systemWorkers.length}><WorkerRows {...p} workers={systemWorkers}/></SystemSection>
    </div>
    <div className="org-home-foot">
      {main && <KenazniaRow main={main} open={p.open}/>}
      <div className="org-quick"><button onClick={() => p.go('todo')}>✓ To-do <b>{p.todos === null ? '' : open}</b></button>{p.boot.extensions.some(e => e.id === 'calendar') && <button onClick={() => p.go('calendar')}>📅 Calendar</button>}</div>
      <p className="org-footline">{footerLine(Date.now(), p.nextTrip)}</p>
    </div>
  </div>;
}

/** Her Kenaznia chat as one calm row: the default home for anything without its own chat. */
function KenazniaRow({ main, open }: { main: MainChat; open(id: string): void }) {
  const c = main.conversation;
  return <ul className="org-rows org-main"><li className="org-row topic"><button className="org-open" aria-label={`${main.name}${unread(c) ? ', unread' : ''}`} onClick={() => open(c.id)}>
    <span className="org-tile" style={tileStyle('#8b948d')} aria-hidden="true">{main.emoji}</span>
    <span className="org-body"><span className={unread(c) ? 't ur' : 't'}><span className="tt">{main.name}</span>{unread(c) && <span className="org-unread" aria-hidden="true">💬</span>}</span><span className="m">{c.lastMessage ? plainPreview(c.lastMessage.preview) : 'Ask anything here.'}</span></span>
    {c.lastMessage && <span className="when">{when(c.lastMessage.at)}</span>}
  </button></li></ul>;
}

/** Home and wide navigation pins have the same actions as a row in Chats. */
function TopicPin(p: Shared & { c: ConversationSummary; nav?: boolean; color?: string }) {
  const { c } = p, [menu, setMenu] = useState(false), anchor = useRef<HTMLButtonElement>(null), allowed = roomActionsAllowed(c);
  const hold = useRoomPress(allowed, () => setMenu(true));
  return <><button {...hold} ref={anchor} className={`${p.nav ? 'org-nav-pin' : 'org-pin'}${allowed ? ' room-press' : ''}`}
    aria-current={(p.screen === 'chat' || p.screen === 'project') && p.active === c.id ? 'page' : undefined}
    aria-haspopup={allowed ? 'menu' : undefined} aria-expanded={allowed ? menu : undefined}
    style={p.nav ? undefined : { background: rowBackground(p.color ?? '#8b948d'), borderLeftColor: p.color }} onClick={() => p.open(c.id)}>
    {p.nav ? <><span className="tt">{emojiOf(c)} {c.title}</span>{unread(c) && <UnreadMark/>}</>
      : <><span className="t"><span className="tt">{emojiOf(c)} {c.title}</span>{unread(c) && <UnreadMark/>}</span>{c.keyDate && <span className="m">{c.keyLabel ? `${c.keyLabel} ` : ''}{shortDate(c.keyDate)}</span>}</>}
  </button>{menu && allowed && <TopicMenu {...p} anchor={anchor} close={() => setMenu(false)}/>}</>;
}

function TopicRows(p: Shared & { items: ConversationSummary[]; colors: (string | null)[]; closed?: boolean; asProject?: boolean }) {
  return <ul className="org-rows">{p.items.map((c, i) => <TopicRow key={c.id} c={c} color={p.colors[i] ?? null} closed={!!p.closed} {...p}/>)}</ul>;
}
function memberLine(p: Shared, c: ConversationSummary) {
  const others = c.memberIds.filter(id => id !== p.boot.me.id && p.boot.people.find(x => x.id === id)?.kind === 'human');
  return others.length ? `Shared · ${others.map(id => p.boot.people.find(x => x.id === id)?.name ?? id).join(', ')}` : null;
}
/** A chat with another person in it. */
const hasOthers = (p: Shared, c: ConversationSummary) => memberLine(p, c) !== null || Object.keys(c.memberColors).length > 0;
/** The people whose messages can be coloured here: its people, whoever wrote last, and anyone already coloured. */
const speakers = (p: Shared, c: ConversationSummary) => [...new Set([...c.memberIds, ...Object.keys(c.memberColors), ...(c.lastMessage ? [c.lastMessage.authorId] : [])])]
  .flatMap(id => { const x = p.boot.people.find(y => y.id === id); return x?.kind === 'human' ? [{ id, name: x.id === p.boot.me.id ? `${x.name} (you)` : x.name }] : []; });
function TopicRow(p: Shared & { c: ConversationSummary; color: string | null; closed: boolean; asProject?: boolean }) {
  const { c } = p, [menu, setMenu] = useState(false), start = useRef<{ x: number; y: number } | null>(null), more = useRef<HTMLButtonElement>(null);
  const allowed = roomActionsAllowed(c), hold = useRoomPress(allowed, () => setMenu(true));
  const activity: Activity | undefined = p.boot.activity[c.id];
  const meta = activity ? activityText(activity) : p.asProject && c.statusLine ? c.statusLine : memberLine(p, c) ?? (c.lastMessage ? plainPreview(c.lastMessage.preview) : 'No messages yet');
  const open = p.wide && p.active === c.id;
  return <li {...hold} className={`org-row topic${allowed ? ' room-press' : ''}${p.closed ? ' closed' : ''}${open ? ' on' : ''}`} style={p.color ? { background: rowBackground(p.color) } : undefined}
    onTouchStart={e => { const t = e.touches[0]!; start.current = { x: t.clientX, y: t.clientY }; }}
    onTouchEnd={e => { const s = start.current, t = e.changedTouches[0]!; start.current = null; if (allowed && s && swipeDirection(t.clientX - s.x, t.clientY - s.y) === 1) setMenu(true); }}>
    <button className="org-open" aria-current={open ? 'true' : undefined} onClick={() => p.open(c.id)}>
      <span className="org-tile" style={tileStyle(p.color ?? '#8b948d')} aria-hidden="true">{emojiOf(c)}</span>
      <span className="org-body"><span className={unread(c) ? 't ur' : 't'}><span className="tt">{c.title || 'Conversation'}</span>{unread(c) && <UnreadMark/>}</span><span className="m">{meta}</span></span>
      {p.closed ? <span className="when">↺</span> : p.asProject ? c.keyDate && <span className="when">{c.keyLabel ? `${c.keyLabel} ` : ''}{shortDate(c.keyDate)}</span> : <span className="when">{when(c.lastMessage?.at ?? c.updatedAt)}</span>}
    </button>
    {allowed && <button className="org-more" ref={more} aria-label={`Actions for ${c.title}`} aria-expanded={menu} onClick={() => setMenu(!menu)}>⋯</button>}
    {menu && allowed && <TopicMenu {...p} anchor={more} close={() => setMenu(false)}/>}
  </li>;
}
/** Pin/unpin (with an optional key date), rename, colour, emoji, close/reopen: the visible alternative to swiping a topic. */
function TopicMenu(p: Shared & { c: ConversationSummary; anchor: RefObject<HTMLButtonElement | null>; close(): void }) {
  const { c } = p, mine = isTopic(c, p.boot.agents) && !c.agentId && !isMainChat(p.boot, c);
  const act = (f: () => void) => () => { p.close(); f(); };
  // A tap anywhere outside the menu closes it, and that tap does nothing else (Carol 2026-10-21: she kept having
  // to hit ⋯ again to dismiss it). Taps on a ⋯ toggle are left to the toggle itself.
  const ref = useAnchoredMenu<HTMLDivElement>(p.anchor);
  useFocusInside(ref, p.anchor);
  useOverlay(true, p.close);
  useEffect(() => {
    const swallow = (e: Event) => { e.preventDefault(); e.stopPropagation(); };
    const down = (e: PointerEvent) => {
      const t = e.target as Element | null;
      if (!t || ref.current?.contains(t) || t.closest('.org-more, .org-menu-anchor > .org-icon')) return;
      p.close();
      document.addEventListener('click', swallow, { capture: true, once: true });
      setTimeout(() => document.removeEventListener('click', swallow, { capture: true }), 400);
    };
    document.addEventListener('pointerdown', down, true);
    return () => document.removeEventListener('pointerdown', down, true);
  }, []);
  return <div className="org-pop" role="menu" ref={ref} tabIndex={-1}>
    {c.pinnedAt === null ? <button role="menuitem" onClick={act(() => p.ask({ kind: 'pin', title: `Pin ${c.title}`, save: (keyDate, keyLabel) => void p.update(c.id, { pinned: true, keyDate, keyLabel: keyDate ? keyLabel : null }) }))}>📌 Pin</button> : <button role="menuitem" onClick={act(() => void p.update(c.id, { pinned: false, keyDate: null, keyLabel: null }))}>Unpin</button>}
    <button role="menuitem" onClick={act(() => p.ask({ kind: 'text', title: 'Rename', label: 'Topic name', value: c.title, hint: 'Kenan won\'t rename it after this.', save: t => { if (t) void p.update(c.id, { title: t }); } }))}>Rename</button>
    {c.titleLocked && <button role="menuitem" onClick={act(() => void p.update(c.id, { titleLocked: false }))}>Let Kenan rename it</button>}
    {mine && <button role="menuitem" onClick={act(() => void p.update(c.id, { project: !c.project }))}>{c.project ? 'Not a project page' : '🗂️ Make it a project page'}</button>}
    {mine && !c.project && projects(p.boot).length > 0 && <button role="menuitem" onClick={act(() => p.ask({ kind: 'choose', title: 'Put under a project', value: c.projectId, options: [...projects(p.boot).map(x => ({ label: `${emojiOf(x)} ${x.title}`, value: x.id as string | null })), { label: 'No project', value: null }], save: projectId => void p.update(c.id, { projectId }) }))}>Put under a project…</button>}
    {p.groups && <button role="menuitem" onClick={act(() => p.ask({ kind: 'group', title: 'Change group', groups: p.groups!, value: c.groupId, save: groupId => void p.update(c.id, { groupId }), create: p.groupsApi.create }))}>🗂️ Change group</button>}
    <button role="menuitem" onClick={act(() => p.ask({ kind: 'color', title: `Colour for ${c.title}`, value: c.color, save: color => void p.update(c.id, { color }) }))}>🎨 Change colour</button>
    {hasOthers(p, c) && <button role="menuitem" onClick={act(() => p.ask({ kind: 'memberColors', title: `Message colours in ${c.title}`, people: speakers(p, c), value: c.memberColors, save: memberColors => void p.update(c.id, { memberColors }) }))}>🖍️ Message colours</button>}
    <button role="menuitem" onClick={act(() => p.ask({ kind: 'emoji', title: 'Emoji for this topic', value: c.emoji, save: emoji => void p.update(c.id, { emoji }) }))}>Emoji</button>
    {mine && sharedRoom(p.boot, c) && <button role="menuitem" className="room-danger" onClick={act(() => p.requestLeave(c))}>Leave chat</button>}
    {mine && !sharedRoom(p.boot, c) && (c.archived ? <button role="menuitem" onClick={act(() => void p.update(c.id, { archived: false }))}>Reopen</button>
      : <button role="menuitem" onClick={act(() => { closeTopic(p, c); if (p.active === c.id && !p.wide) p.go('chats'); })}>🗄️ Close chat</button>)}
  </div>;
}
function closeTopic(p: Shared, c: ConversationSummary) {
  void p.update(c.id, { archived: true }).then(done => { if (done) p.say(`Closed: ${c.title}`, () => void p.update(c.id, { archived: false })); });
}

function Chats(p: Shared) {
  const [tab, setTab] = useState<'open' | 'pinned' | 'workers' | 'closed'>('open');
  useEffect(() => { if (tab === 'closed') p.showClosed(true); }, [tab]);
  const topics = p.boot.conversations.filter(c => isTopic(c, p.boot.agents) && !isMainChat(p.boot, c));
  const pins = pinned(p.boot), open = topics.filter(c => !c.archived && !c.project).sort(byRecent);
  const projectList = projects(p.boot).sort((a, b) => (a.pinnedAt ?? Infinity) - (b.pinnedAt ?? Infinity) || byRecent(a, b));
  const colors = topicColors(p), colorOf = (c: ConversationSummary) => colors.get(c.id) ?? c.color;
  const workers = p.boot.agents.filter(a => a.role === 'worker' && !a.archived).sort((a, b) => b.updatedAt - a.updatedAt), blanks = openBlankChats(p.boot.agents);
  const closed = topics.filter(c => c.archived && !c.agentId).sort(byRecent);
  // Same density as Home (Carol 2026-10-21: "make the size of the chats the same"). org-dense is display:contents, which also
  // keeps the list scrolling inside the screen above the tab bar instead of running off the bottom.
  return <div className="org-dense">
    <Head title="Chats"><button className="org-newchat" onClick={() => newChatSheet(p)}>＋ New chat</button><BlankButton className="org-blank" started={p.blank.started}/></Head>
    <div className="org-seg" role="tablist">{([['open', 'Open'], ['pinned', 'Pinned'], ['workers', 'Workers'], ['closed', 'Closed']] as const).map(([k, label]) => <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>{label}</button>)}</div>
    <div className="org-scroll">
      {tab === 'open' && blanks.length > 0 && <><h2 className="org-h">🧪 Blank chats</h2><ul className="org-rows">{blanks.map(a => <li key={a.id} className="org-row topic"><button className="org-open" onClick={() => p.open(a.conversationId)}><span className="org-tile" style={tileStyle('#8b948d')} aria-hidden="true">🧪</span><span className="org-body"><span className="t">{p.boot.conversations.find(c => c.id === a.conversationId)?.title ?? a.name}</span><span className="m">{p.boot.activity[a.conversationId] ? activityText(p.boot.activity[a.conversationId]!) : 'No context · close it when done'}</span></span><span className="when">{when(a.updatedAt)}</span></button><button className="org-more" aria-label={`Close ${a.name}`} onClick={() => p.blank.close(a.id)}>✕</button></li>)}</ul></>}
      {tab === 'open' && projectList.length > 0 && <><h2 className="org-h">Projects</h2><TopicRows items={projectList} colors={projectList.map(colorOf)} asProject {...p}/></>}
      {tab === 'pinned' && pins.length > 0 && <><h2 className="org-h">Pinned</h2><TopicRows items={pins} colors={pins.map(colorOf)} {...p}/></>}
      {tab === 'pinned' && !pins.length && <p className="org-quiet">Nothing pinned. Use ⋯ on a topic to pin it.</p>}
      {tab === 'open' && (open.length ? <><p className="org-hint">Swipe a topic left, or tap ⋯, to close, pin or regroup it.</p><ChatSections {...p} topics={open}/></> : projectList.length === 0 && <p className="org-quiet">No open topics.</p>)}
      {tab === 'workers' && (workers.length ? <>{workers.some(a => a.category !== 'upkeep') && <WorkerRows {...p} workers={workers.filter(a => a.category !== 'upkeep')}/>}<SystemSection count={workers.filter(a => a.category === 'upkeep').length}><WorkerRows {...p} workers={workers.filter(a => a.category === 'upkeep')}/></SystemSection></> : <p className="org-quiet">No workers right now.</p>)}
      {tab === 'closed' && <><h2 className="org-h">Closed topics</h2><p className="org-hint">Nothing is deleted. Tap ⋯ to reopen.</p>{!p.closedLoaded ? <p className="org-quiet">Loading…</p> : closed.length ? <TopicRows items={closed} colors={closed.map(() => null)} closed {...p}/> : <p className="org-quiet">No closed topics.</p>}</>}
    </div>
  </div>;
}

function WorkerRows(p: Shared & { workers: AgentInfo[] }) {
  return <ul className="org-rows">{p.workers.map(a => <li key={a.id} className="org-row topic"><button className="org-open" onClick={() => p.open(a.conversationId)}><span className="org-tile" style={tileStyle('#8b948d')} aria-hidden="true">🧑‍🔧</span><span className="org-body"><span className="t">{a.name}</span><span className="m">{p.boot.activity[a.conversationId] ? activityText(p.boot.activity[a.conversationId]!) : agentStatus(a).kind === 'waiting' ? `⚠ ${statusText(agentStatus(a), undefined, Date.now())}` : a.lastReport ? `${a.lastReport.status === 'done' ? 'Done' : a.lastReport.status === 'handed_off' ? 'Handed off' : 'Blocked'}: ${a.lastReport.text.slice(0, 80)}` : a.state}</span></span><span className="when">{when(a.updatedAt)}</span></button></li>)}</ul>;
}

/** Chats' topics in her groups' sections (each a colour family), "Other" last; empty groups are hidden. */
function ChatSections(p: Shared & { topics: ConversationSummary[] }) {
  if (p.groups === null) return <p className="org-quiet">Loading your groups…</p>;
  const groups = [...p.groups].sort((a, b) => a.position - b.position), known = new Set(groups.map(g => g.id)), colors = topicColors(p);
  const sections = [
    ...groups.map(g => ({ key: g.id, group: g as ChatGroup | null, title: `${g.emoji ?? '💬'} ${g.name}`, items: p.topics.filter(c => c.groupId === g.id) })),
    { key: 'other', group: null, title: '💬 Other', items: p.topics.filter(c => c.groupId === null || !known.has(c.groupId)) },
  ].filter(s => s.items.length);
  return <>{sections.map(s => <ChatSection key={s.key} title={s.title} count={s.items.length} edit={s.group && (() => editGroup(p, s.group!))}>
    <TopicRows items={s.items} colors={s.items.map(c => colors.get(c.id) ?? c.color)} {...p}/>
  </ChatSection>)}</>;
}
/** One titled section; the place a collapsed state will live. */
function ChatSection({ title, count, edit, children }: { title: string; count: number; edit: (() => void) | null; children: ReactNode }) {
  return <section className="org-section"><h2 className="org-h org-gh">{title} <span className="org-hn">({count})</span>{edit && <button className="org-link" aria-label={`Edit group ${title}`} onClick={edit}>⋯</button>}</h2>{children}</section>;
}
function editGroup(p: Shared, g: ChatGroup) {
  p.ask({ kind: 'groupEdit', title: `Edit ${g.name}`, group: g, save: input => void p.groupsApi.change(g.id, input), remove: () => void p.groupsApi.remove(g.id).then(rooms => {
    if (rooms) p.say(`Deleted group: ${g.name}`, () => void p.groupsApi.create({ name: g.name, emoji: g.emoji, family: g.family }).then(back => { if (back) for (const id of rooms) void p.update(id, { groupId: back.id }); }));
  }) });
}

function ActivityList(p: Shared) {
  const items = p.boot.agents.filter(a => a.role === 'worker' && (a.lastReport || p.boot.activity[a.conversationId])).sort((a, b) => (b.lastReport?.at ?? b.updatedAt) - (a.lastReport?.at ?? a.updatedAt));
  const work = items.filter(a => a.category !== 'upkeep').slice(0, 40), system = items.filter(a => a.category === 'upkeep');
  const rows = (agents: AgentInfo[]) => <ul className="org-rows">{agents.map(a => { const live = p.boot.activity[a.conversationId]; return <li key={a.id} className="org-row topic"><button className="org-open" onClick={() => p.open(a.conversationId)}><span className="org-tile" style={tileStyle(a.lastReport?.status === 'blocked' && !live ? '#e83a3a' : '#8b948d')} aria-hidden="true">{live ? '⏳' : a.lastReport?.status === 'blocked' ? '⚠️' : '✓'}</span><span className="org-body"><span className="t">{a.name}</span><span className="m">{live ? activityText(live) : `${a.lastReport!.status === 'blocked' ? 'Blocked: ' : ''}${a.lastReport!.text.replace(/\s+/g, ' ').slice(0, 100)}`}</span></span><span className="when">{when(a.lastReport?.at ?? a.updatedAt)}</span></button></li>; })}</ul>;
  return <>
    <Head title="Activity"/>
    <div className="org-scroll">
      {work.length ? rows(work) : !system.length && <p className="org-quiet">Nothing has happened in the background yet.</p>}
      <SystemSection count={items.filter(a => a.category === 'upkeep').length}>{rows(system)}</SystemSection>
    </div>
  </>;
}

function TopicView(p: Shared & { children: ReactNode }) {
  const c = p.boot.conversations.find(x => x.id === p.active);
  const [menu, setMenu] = useState(false), more = useRef<HTMLButtonElement>(null);
  const blank = blankAgentOf(c, p.boot.agents);
  if (c && blank) return <section className="org-screen org-full org-topic">
    <Head title={c.title} back={p.back ?? (p.wide ? undefined : () => p.go('chats'))}>
      {!blank.archived && <button className="org-grey" title="End this blank chat; it leaves your lists" onClick={() => { p.blank.close(blank.id); if (!p.wide) p.go('chats'); }}>✕ Close</button>}
    </Head>
    {p.children}
  </section>;
  return <section className="org-screen org-full org-topic">
    <Head title={c ? <>{emojiOf(c)} {c.title}</> : 'Conversation'} back={p.back ?? (p.wide ? undefined : () => p.go('home'))}>
      {c && memberLine(p, c) && <span className="org-shared">Shared</span>}
      {c?.project && <button className="org-grey" aria-label="Open project page" onClick={() => p.openProject(c.id)}>🗂️ Page</button>}
      {c && <span className="org-menu-anchor"><button className="org-icon" ref={more} aria-label="Topic actions" aria-expanded={menu} onClick={() => setMenu(!menu)}>⋯</button>{menu && <TopicMenu {...p} c={c} anchor={more} close={() => setMenu(false)}/>}</span>}
    </Head>
    {c?.archived && <div className="archive-banner"><span>This topic is closed.</span><button className="org-grey" onClick={() => void p.update(c.id, { archived: false })}>Reopen</button></div>}
    {c && (t => t && <TodoCard key={t.id} t={t} color={todoColors(p.todos ?? [], todayDate()).get(t.id) ?? null}/>)(chatTodo(p.todos ?? [], c.id))}
    {p.children}
  </section>;
}
/** The chat's own to-do as one line (📌 title · day), collapsed by default; tapping it shows the details. */
function TodoCard({ t, color }: { t: Todo; color: string | null }) {
  const [open, setOpen] = useState(false);
  const day = t.onDate === null ? null : dayLabel(t.onDate, todayDate());
  return <aside className={['org-todo-card', open && 'open'].filter(Boolean).join(' ')} style={color ? { background: rowBackground(color) } : undefined} aria-label="To-do">
    <button className="org-todo-card-head" aria-expanded={open} disabled={t.details === null} onClick={() => setOpen(!open)}><span aria-hidden="true">📌</span><strong>{t.text}</strong>{day && <span className="when">· {day}</span>}{t.details !== null && <span className="chev" aria-hidden="true">{open ? '▴' : '▾'}</span>}</button>
    {open && t.details !== null && <div className="org-todo-card-body"><MessageMarkdown text={t.details} source="agent"/></div>}
  </aside>;
}

/** The menu's places as tiles and its settings: folded behind ⚙ at the foot of the wide nav, listed in the ☰ sheet. */
function MenuItems(p: Shared & { close(): void; mode: 'toggle' | 'shown' }) {
  const go = (s: Screen) => () => { p.close(); p.go(s); };
  const openGoals = p.goals.filter(g => g.status === 'open').length;
  const tile = (t: Place) => t;
  const places: Place[] = [
    tile({ id: 'search', icon: 'search', label: 'Search', title: 'Search messages, chats and files', current: p.screen === 'search', dot: false, go: go('search') }),
    ...(p.boot.extensions.some(e => e.id === 'calendar') && !p.wide ? [tile({ id: 'calendar', icon: 'calendar', label: 'Calendar', title: 'Calendar', current: p.screen === 'calendar', dot: false, go: go('calendar') })] : []),
    tile({ id: 'goals', icon: 'goals', label: 'Goals', title: `Goals & workers: ${openGoals} open ${openGoals === 1 ? 'goal' : 'goals'}`, current: p.screen === 'goals', dot: false, go: go('goals') }),
    tile({ id: 'usage', icon: 'usage', label: 'Usage', title: p.weeklyLeft === null ? 'Usage' : `Usage: ${Math.round(p.weeklyLeft)}% of the week left`, current: p.screen === 'usage', dot: false, go: go('usage') }),
    ...(p.newsOn ? [tile({ id: 'news', icon: 'news', label: "What's new", title: p.newsDot ? "What's new: something changed since you last looked" : "What's new", current: p.screen === 'news', dot: p.newsDot, go: go('news') })] : []),
    ...(bridge() ? [tile({ id: 'finder', icon: 'finder', label: 'forest', title: 'forest', current: false, dot: false, go: () => { p.close(); void call('openFinder', {}); } })] : []),
    ...(p.showSky ? [tile({ id: 'sky', icon: 'sky', label: 'Sky', title: 'Show just the background', current: false, dot: false, go: () => { p.close(); p.showSky!(); } })] : []),
  ];
  return <CompactMenu mode={p.mode} places={places} tray={p.boot.trayTiles} settings={<Settings name={p.mode === 'toggle' ? p.boot.me.name : null} signOut={p.signOut} extra={<div className="cm-line"><span id="cm-layout">Layout</span><div className="cm-switch" role="radiogroup" aria-labelledby="cm-layout">{(['classic', 'organized'] as const).map(l => <button key={l} role="radio" aria-checked={p.boot.layout === l} onClick={() => { if (p.boot.layout !== l) { p.close(); p.setLayout(l); } }}>{l === 'classic' ? 'Classic' : 'Organized'}</button>)}</div></div>}
    skyMotion={p.skyMotion} push={p.push} checkUpdate={p.checkUpdate ? () => { p.close(); p.checkUpdate!(); } : null} tray={{ tiles: p.boot.trayTiles, choose: p.chooseTray }}/>}/>;
}
function MenuPanel(p: Shared & { close(): void }) {
  useEffect(() => {
    const refresh = () => p.refreshUsage();
    refresh();
    window.addEventListener('kenan-refresh', refresh);
    return () => window.removeEventListener('kenan-refresh', refresh);
  }, []);
  return <>
    <div className="org-who"><span className="org-avatar" aria-hidden="true">{p.boot.me.name.slice(0, 1)}</span><div><strong>{p.boot.me.name}</strong><small>Kenan · {p.boot.channel}</small></div><button className="org-grey" onClick={p.signOut}>Sign out</button></div>
    <MenuItems {...p} mode="shown"/>
  </>;
}

/** A project's files: images open in the swipeable viewer (an overlay, so Back closes it and the page stays put);
 * other files open in a new tab, or download in the Android app (web/links.ts). */
function ProjectFiles(p: Shared & { files: FileRef[] }) {
  const { show, failed, viewer } = useImageViewer();
  const images = p.files.filter(f => f.mime.startsWith('image/') && p.source.fileHref(f.id) !== null);
  return <><ul className="org-rows">{p.files.map(f => {
    const href = p.source.fileHref(f.id), image = images.indexOf(f), inner = <><span className="org-tile" style={tileStyle('#8b948d')} aria-hidden="true">{f.mime.startsWith('image/') ? '🖼️' : f.mime === 'application/pdf' ? '📄' : '📎'}</span><span className="org-body"><span className="t">{f.name}</span></span></>;
    return <li key={f.id} className="org-row topic">{image >= 0 ? <button className="org-open" aria-label={`Open ${f.name}`} onClick={() => void show({ items: images.map(i => ({ fileId: i.id, caption: i.name })), start: image })}>{inner}</button>
      : href ? <a className="org-open" href={href} target="_blank" rel="noopener noreferrer">{inner}</a> : <button className="org-open" onClick={() => p.say('Demo file: there is nothing to open.')}>{inner}</button>}</li>;
  })}</ul>{failed && <p className="org-quiet" role="alert">{failed}</p>}{viewer}</>;
}

/** A pinned topic as a project page (mockup 4-Business): status line, its to-dos, its chats and its files. */
function ProjectPage(p: Shared) {
  const c = p.boot.conversations.find(x => x.id === p.active);
  const [files, setFiles] = useState<FileRef[] | null>(null);
  const [failed, setFailed] = useState('');
  const [menu, setMenu] = useState(false), more = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!c) return;
    let current = true, request = 0; setFiles(null); setFailed('');
    const refresh = () => {
      const latest = ++request;
      p.source.files(c.id).then(v => { if (current && latest === request) { setFiles(v); setFailed(''); } }, e => { if (current && latest === request) setFailed(String(e)); });
    };
    refresh();
    window.addEventListener('kenan-refresh', refresh);
    return () => { current = false; window.removeEventListener('kenan-refresh', refresh); };
  }, [c?.id]);
  if (!c) return <><Head title="Project" back={() => p.go('home')}/><p className="org-quiet">This project isn't available.</p></>;
  const colors = topicColors(p), color = colors.get(c.id) ?? c.color ?? '#8b948d';
  const todos = urgentFirst((by => LEVELS.flatMap(l => by[l]))(todoSections((p.todos ?? []).filter(t => t.conversationId === c.id), todayDate())));
  const rooms = p.boot.conversations.filter(x => x.projectId === c.id && !x.archived).sort(byRecent);
  const newChat = async (title: string) => {
    const room = await p.source.startChat(title, []);
    p.added(room); await p.update(room.id, { projectId: c.id }); p.open(room.id);
  };
  return <>
    <Head title={<>{emojiOf(c)} {c.title}</>} back={p.wide ? undefined : () => { if (!dismissTop()) p.go('home'); }}><button className="org-grey" onClick={() => p.open(c.id)}>Open chat</button>
      <span className="org-menu-anchor"><button className="org-icon" ref={more} aria-label="Project actions" aria-expanded={menu} onClick={() => setMenu(!menu)}>⋯</button>{menu && <TopicMenu {...p} c={c} anchor={more} close={() => setMenu(false)}/>}</span></Head>
    <div className="org-scroll">
      <button className="org-status" style={{ borderLeftColor: color }} aria-label="Edit the project status" onClick={() => p.ask({ kind: 'text', title: 'Project status', label: 'One line', value: c.statusLine ?? '', multiline: true, save: s => void p.update(c.id, { statusLine: s || null }) })}>
        {c.statusLine ?? 'No status yet. Tap to write one, or ask Kenan to keep it updated.'}{c.keyDate && <small>{c.keyLabel ? `${c.keyLabel} ` : ''}{shortDate(c.keyDate)}</small>}
      </button>
      <h2 className="org-h">Waiting on you</h2>
      {todos.length ? <TodoRows items={todos} colors={todoColors(p.todos ?? [], todayDate())} {...p}/> : <p className="org-quiet">Nothing waiting for this project.</p>}
      <h2 className="org-h">Chats <button className="org-link" onClick={() => p.ask({ kind: 'text', title: 'New chat in this project', label: 'Title', value: '', save: t => { if (t) void newChat(t).catch(e => p.say(`Couldn't create the chat: ${String(e)}`)); } })}>＋ New</button></h2>
      <TopicRows items={[c, ...rooms]} colors={[c, ...rooms].map(x => colors.get(x.id) ?? x.color)} {...p}/>
      <h2 className="org-h">Files</h2>
      {failed ? <p className="org-quiet" role="alert">Couldn't load the files: {failed}</p> : files === null ? <p className="org-quiet">Loading…</p> : files.length ? <ProjectFiles files={files} {...p}/> : <p className="org-quiet">No files in this project's chats yet.</p>}
    </div>
  </>;
}
