import { sync } from './sync.js';
import { SyncIndicator } from './SyncIndicator.js';
import { NavDrawer, type DrawerControl } from './NavDrawer.js';
import { ClassicRoomRow, useLeaveChat } from './RoomMenu.js';
import { apiPath } from './path.js';
import { adoptEarlyStream, connectEvents, eventBatch } from './events.js';
import { clearSnapshot, OPEN_KEY, readSnapshot, writeSnapshot, type Snapshot } from './snapshot.js';
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Search, emptySearch } from './Search.js';
import { MessageMarkdown } from './MessageMarkdown.js';
import { plainPreview, previewable, unread, type Bootstrap, type ConversationSummary, type FileInfo, type Goal, type GoalSummary, type Message, type MessagePage, type Person, type StreamEvent, type UsageReport, type LatencyReport, type ManagerHome } from '../shared/contract.js';
import { api, ApiError, isUnreachable } from './client.js';
import { Composer } from './Composer.js';
import { createDrafts } from './drafts.js';
import { QuestionContext } from './Question.js';
import { Transcript, type Paging } from './Transcript.js';
import { viewer } from './toolData.js';
import { seedReferences } from './toolReferences.js';
import { activityText, withActivity } from './activity.js';
import { acceptLatest, appendDelta, appendNewer, appendThinking, applyToolDraft, firstGap, PAGE_SIZE, prependOlder, trimForFollowing, upsert, type History } from './history.js';
import { AgentTree, agentTree, agentTreeContains, waitingCount } from './AgentTree.js';
import { blankAgentOf, closeBlankChat, openBlankChats, type BlankStarted } from './blank.js';
import { BlankButton } from './BlankButton.js';
import { mentionNames } from './mention.js';
import { useAppUpdate, type AppUpdate } from './AppUpdate.js';
import { runningEntry, useWebUpdate } from './WebUpdate.js';
import { captureUpdateScroll, saveUpdateResume, takeUpdateResume } from './updateResume.js';
import { recoverApp } from './recover.js';
import { clearDeliveredNotifications, useWebPush, type PushState } from './push.js';
import { useOverlay } from './overlay.js';
import { arrive, ChatLinkContext, follow, NO_TRAIL, retrace, type ChatLinks, type Place, type Trail } from './chatLinks.js';
import { sidebarHiddenPref, skyMotionPref } from './devicePrefs.js';
import { carriesFiles, transferFiles } from './clipboard.js';
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { bridge, call } from './native.js';
import { CompactMenu, type Place as MenuPlace } from './CompactMenu.js';
import type { FooterIconId } from './FooterIcon.js';
import { replyTarget, withReply, type ReplyTarget } from './reply.js';
import type { Page } from './screens.js';
import type { TodoActions } from './todo/TodoScreen.js';
import { loadWebModule, moduleOf, type WebModule } from './modules.js';
import type { Dictation } from './MicButton.js';
import type { Upload } from './share.js';
import { applyTodoChange } from './todo/todo.js';
import { focusedZone, zoneReporter } from './zone.js';
import { useViewing } from './viewing.js';
import type { ZoneReport } from '../shared/zone.js';
type UsageModule = typeof import('./Usage.js');
import type { BuyList, ConversationPatch, Todo, TodoChat, TrayTile } from '../shared/contract.js';
/** The core pages that make up the app without a module. */
const CORE_PAGES: readonly Page[] = ['chat', 'goals', 'calendar', 'todo', 'search', 'usage'];
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
/** A failure shown to her. `unreachable` (Kenan didn't answer) clears itself once the stream is live again. */
/** A message on its way; `queued` once Kenan was unreachable for it. */
type PendingSend = { conversationId: string; text: string; files: string[]; clientId: string; draft: string; ownIds: string[]; queued: boolean };
const RETRY_MS = 3000;
/** This build's identity; a saved screen from any other build is discarded. */
const BUILD = runningEntry();
type Shown = { kind: 'failed' | 'unreachable'; text: string };
const shown = (error: unknown): Shown => ({ kind: isUnreachable(error) ? 'unreachable' : 'failed', text: errorText(error) });
const summary = (goal: Goal): GoalSummary => ({ id: goal.id, title: goal.title, status: goal.status, category: goal.category });
const eventsPath = (open: string | null) => apiPath(`/api/events${open ? `?open=${encodeURIComponent(open)}` : ''}`);
/** A notification opens the app on its conversation (the Android app adds it to the URL). */
const Calendar = lazy(() => import('./extensions/calendar.js').then(m => ({ default: m.Calendar })));
const ManagerBanner = lazy(() => import('./AccountMove.js').then(m => ({ default: m.ManagerBanner })));
const MemberColorsMenu = lazy(() => import('./MemberColors.js').then(m => ({ default: m.MemberColorsMenu })));
const Goals = lazy(() => import('./Goals.js'));
const ClassicTodo = lazy(() => import('./todo/TodoScreen.js').then(m => ({ default: m.ClassicTodo })));
const Settings = lazy(() => import('./Settings.js'));
const SkyOnly = lazy(() => import('./SkyOnly.js'));
const linkedConversation = () => new URLSearchParams(location.search).get('conversationId');
const linkedMessage = () => { const q = new URLSearchParams(location.search); return q.get('messageId') ?? q.get('seq') ?? (location.hash ? location.hash.slice(1) : null); };
type MessageTarget = { conversationId: string; message: string; token: number };
/** What the previous open showed; drawn at once and replaced when the stream's snapshot arrives. */
function initialScreen(): Snapshot | null {
  const read = readSnapshot(localStorage, BUILD);
  if (read.kind === 'invalid') console.warn('Discarded the saved startup screen:', read.reason);
  return read.kind === 'found' ? read.snapshot : null;
}

export function App() {
  const [cached] = useState(initialScreen);
  const [resume] = useState(takeUpdateResume);
  const resumeRange = useRef(resume?.range ?? null);
  const resumeScroll = useRef(resume?.scroll ?? null);
  const [skyFollowsSystem, setSkyFollowsSystem] = useState(() => skyMotionPref.read());
  const toggleSkyMotion = () => { skyMotionPref.save(!skyFollowsSystem); setSkyFollowsSystem(!skyFollowsSystem); };
  const [skyOnly, setSkyOnly] = useState(false);
  const [boot, setBoot] = useState<Bootstrap | null>(cached?.bootstrap ?? null);
  /** Whether `boot` comes from the live stream (or login) rather than the saved screen. */
  const [live, setLive] = useState(false);
  /** The stream has delivered a snapshot at least once: from then on, opening a conversation loads its history. */
  const [streamed, setStreamed] = useState(false);
  /** Bumped by login: a new session needs a new stream. */
  const [session, setSession] = useState(0);
  const [accounts, setAccounts] = useState<Person[]>([]);
  const [account, setAccount] = useState('');
  const [secret, setSecret] = useState('');
  const [ready, setReady] = useState(cached !== null);
  const [error, setError] = useState<Shown | null>(null);
  const [active, setActive] = useState<string | null>(() => resume?.active ?? linkedConversation() ?? cached?.page?.conversationId ?? null);
  const [search, setSearch] = useState(emptySearch);
  const [trail, setTrail] = useState<Trail>(NO_TRAIL);
  const [messageTarget, setMessageTarget] = useState<MessageTarget | null>(() => linkedConversation() && linkedMessage() ? { conversationId: linkedConversation()!, message: linkedMessage()!, token: 0 } : null);
  const messageTargetRef = useRef(messageTarget); messageTargetRef.current = messageTarget;
  const targetSerial = useRef(0);
  const restoredHistory = useRef<string | null>(null);
  const chatOpenRef = useRef<(id: string, message?: string) => void>(() => {});
  const [page, setPage] = useState<Page>(resume?.page ?? 'chat');
  const [history, setHistory] = useState<Record<string, History>>(() => cached?.page ? { [cached.page.conversationId]: cached.page.page } : {});
  const [connected, setConnected] = useState(false);
  const appUpdate = useAppUpdate();
  const push = useWebPush(live);
  const [drafts] = useState(() => createDrafts(resume?.drafts ?? {}));
  const setDrafts = drafts.set;
  const [attachments, setAttachments] = useState<Record<string, FileInfo[]>>(resume?.attachments ?? {});
  const [sending, setSending] = useState(false);
  /** Per conversation: a dictation filling its box, or the one that failed (shown under the box with Try again). */
  const [dictations, setDictations] = useState<Record<string, Dictation>>({});
  /** While the composer's mic records: what Send calls to send the clip instead of the typed text. */
  const [micSend, setMicSend] = useState<(() => void) | null>(null);
  const [uploading, setUploading] = useState(false);
  const [roomEditor, setRoomEditor] = useState(false);
  const [roomTitle, setRoomTitle] = useState('');
  const [members, setMembers] = useState<string[]>([]);
  const [goals, setGoals] = useState<GoalSummary[]>(cached?.bootstrap.goals ?? []);
  const [fullGoals, setFullGoals] = useState<Goal[] | null>(null);
  const [usage, setUsage] = useState<UsageReport | null>(null);
  const [metrics, setMetrics] = useState<LatencyReport | null>(null);
  const [usageModule, setUsageModule] = useState<UsageModule | null>(null);
  const sidebarControl: DrawerControl = useRef(null);
  const setSidebar: NonNullable<DrawerControl['current']> = value => sidebarControl.current?.(value);
  const [sidebarHidden, setSidebarHidden] = useState(() => sidebarHiddenPref.read());
  const [dropping, setDropping] = useState(false);
  const [todos, setTodos] = useState<Todo[] | null>(null);
  const [buy, setBuy] = useState<BuyList | null>(null);
  /** A module that can replace the app's screens (modules/NAME/web), loaded only when this person's extensions name it. */
  const [webModule, setWebModule] = useState<WebModule | null>(null);
  const wide = useMedia('(min-width: 900px)'), narrow = useMedia('(max-width: 700px)');
  const [settings, setSettings] = useState(false);
  const settingsSummary = useRef<HTMLElement>(null);
  const [includeArchived, setIncludeArchived] = useState(false);
  const [archiveLoading, setArchiveLoading] = useState(false);
  const includeArchivedRef = useRef(includeArchived); includeArchivedRef.current = includeArchived;
  const activeRef = useRef(active); activeRef.current = active;
  const composerInput = useRef<HTMLTextAreaElement>(null);
  /** Bumped by a question's Dismiss: once its chat is showing, the composer takes focus. */
  const [focusComposer, setFocusComposer] = useState(0);
  const focusPending = useRef(0);
  useEffect(() => { if (focusComposer === focusPending.current) return; requestAnimationFrame(() => { if (composerInput.current) focusPending.current = focusComposer; composerInput.current?.focus(); }); }, [focusComposer, active]);
  const roomDialog = useRef<HTMLFormElement>(null);
  const nearBottom = useRef(true);
  const observedText = useRef(new Set<string>());
  const pendingSend = useRef<PendingSend | null>(null);
  const resendRef = useRef(() => {});
  resendRef.current = () => { const pending = pendingSend.current; if (pending?.queued) void deliver(pending); };
  const [loading, setLoading] = useState<string | null>(null);
  const [paging, setPaging] = useState<Paging>(null);
  const pagingRef = useRef(false);
  const historyEpoch = useRef(0);
  const gapLoads = useRef(new Set<string>());
  const historyRef = useRef(history); historyRef.current = history;
  const latestLoads = useRef(new Map<string, Promise<MessagePage | null>>());
  /** Conversations whose loaded history the current stream keeps up to date. */
  const fresh = useRef(new Set<string>());
  const bootRef = useRef(boot); bootRef.current = boot;
  const stopStream = useRef<(() => void) | null>(null);
  useEffect(() => { document.documentElement.dataset.appStarted = ready ? 'true' : 'false'; }, [ready]);
  useEffect(() => { if (active) localStorage.setItem(OPEN_KEY, active); else localStorage.removeItem(OPEN_KEY); }, [active]);

  function acceptBootstrap(value: Bootstrap) {
    // The server includes an authorized open archived chat in its ready snapshot. Never keep a cached room
    // absent from that snapshot: she may have left it while this device was disconnected.
    if (resume && resume.owner !== value.me.id) {
      setDrafts({}); setAttachments({}); setReplies({}); resumeRange.current = null; resumeScroll.current = null;
    }
    setBoot(value);
    if (activeRef.current && !value.conversations.some(c => c.id === activeRef.current && c.memberIds.includes(value.me.id))) {
      setPage('chat'); setTrail(NO_TRAIL);
    }
    setGoals(value.goals);
    seedReferences(value); viewer.name = value.me.name;
    setActive(current => current && value.conversations.some(c => c.id === current && c.memberIds.includes(value.me.id)) ? current : (value.manager.kind === 'here' ? value.manager.conversationId : null) ?? value.conversations[0]?.id ?? null);
    document.title = value.channel === 'beta' ? 'Kenan Beta' : 'Kenan';
  }
  const messagesPath = (id: string, query = '') => `/conversations/${encodeURIComponent(id)}/messages?limit=${PAGE_SIZE}${query}`;
  /** Refresh replaces every retained row: an edit can also change quotes in other messages. */
  function loadMessages(id: string, mode: 'open' | 'refresh'): Promise<MessagePage | null> {
    setLoading(id);
    const restoring = resumeRange.current?.conversationId === id ? resumeRange.current : null;
    const target = messageTargetRef.current?.conversationId === id ? messageTargetRef.current : null;
    const load = api<MessagePage>(target ? messagesPath(id, `&around=${encodeURIComponent(target.message)}`) : restoring ? `/conversations/${encodeURIComponent(id)}/messages?before=${restoring.before}&limit=${restoring.limit}` : messagesPath(id)).then(async page => {
      if (restoring && restoring.limit > 200 && page.messages.length === 200) {
        const older = await api<MessagePage>(`/conversations/${encodeURIComponent(id)}/messages?before=${page.messages[0]!.seq}&limit=${restoring.limit - 200}`);
        page = { ...page, hasOlder: older.hasOlder, messages: [...older.messages, ...page.messages] };
      }
      return page;
    }).then(page => {
      if (latestLoads.current.get(id) !== load) return page;
      if (restoring) resumeRange.current = null;
      setHistory(all => ({ ...all, [id]: mode === 'refresh' || target || restoring || all[id]?.hasNewer ? page : acceptLatest(all[id], page) }));
      fresh.current.add(id);
      return page;
    }, e => { showError(e); return null; }).finally(() => {
      if (latestLoads.current.get(id) === load) { latestLoads.current.delete(id); setLoading(current => current === id ? null : current); }
    });
    latestLoads.current.set(id, load);
    return load;
  }
  // A send response or a live event can arrive ahead of messages missed during sleep or reconnect.
  // Never use its high sequence as proof we received the intervening rows. Repair all holes, including
  // ones in a saved screen, a restored navigation window or a merged history page.
  useEffect(() => {
    if (!live) return;
    for (const [id, window] of Object.entries(history)) {
      const after = firstGap(window);
      if (after === null || gapLoads.current.has(id)) continue;
      const epoch = historyEpoch.current;
      gapLoads.current.add(id); setLoading(id);
      void api<MessagePage>(`/conversations/${encodeURIComponent(id)}/messages?after=${after}&limit=200`).then(page => {
        if (epoch !== historyEpoch.current) return;
        // An authoritative page must include the next sequence; otherwise replace the stale window.
        if (page.messages[0]?.seq !== after + 1) { void loadMessages(id, 'refresh'); return; }
        setHistory(all => {
          const current = all[id];
          if (!current || firstGap(current) !== after) return all;
          const last = current.messages.at(-1)!.seq;
          const repaired = page.messages.filter(m => m.seq <= last).reduce(upsert, current);
          return { ...all, [id]: trimForFollowing(repaired) };
        });
      }).catch(showError).finally(() => {
        gapLoads.current.delete(id);
        setLoading(current => current === id ? null : current);
        // A reconnect may have replaced history while this older read was outstanding.
        if (epoch !== historyEpoch.current) setHistory(all => ({ ...all }));
      });
    }
  }, [history, live]);
  /** Saves what is on screen for the next open. */
  function saveScreen() {
    const current = bootRef.current, id = activeRef.current;
    if (!current) return;
    const window = id ? historyRef.current[id] : undefined;
    const saved = writeSnapshot(localStorage, BUILD, { bootstrap: current, page: id && window ? { conversationId: id, page: window } : null });
    if (!saved.ok) console.warn('Could not save the startup screen:', saved.reason);
  }
  const pageHistory = useCallback(async (direction: 'older' | 'newer') => {
    const id = activeRef.current, window = id ? historyRef.current[id] : undefined;
    const edge = direction === 'older' ? window?.messages[0]?.seq : window?.messages.at(-1)?.seq;
    if (!id || edge === undefined || pagingRef.current) return;
    const epoch = historyEpoch.current;
    pagingRef.current = true; setPaging(direction);
    try {
      const page = await api<MessagePage>(messagesPath(id, direction === 'older' ? `&before=${edge}` : `&after=${edge}`));
      if (epoch !== historyEpoch.current) return;
      setHistory(all => {
        const current = all[id];
        // A page only extends the window it was requested from.
        if (!current || (direction === 'older' ? current.messages[0]?.seq : current.messages.at(-1)?.seq) !== edge) return all;
        return { ...all, [id]: direction === 'older' ? prependOlder(current, page) : appendNewer(current, page) };
      });
    } catch (e) { showError(e); }
    finally { pagingRef.current = false; setPaging(null); }
  }, []);
  const loadOlder = useCallback(() => void pageHistory('older'), [pageHistory]);
  const loadNewer = useCallback(() => void pageHistory('newer'), [pageHistory]);
  const jumpToLatest = useCallback(() => {
    const id = activeRef.current; if (!id) return;
    void api<MessagePage>(messagesPath(id)).then(page => { messageTargetRef.current = null; setMessageTarget(null); nearBottom.current = true; setHistory(all => ({ ...all, [id]: page })); }).catch(e => showError(e));
  }, []);
  const [replies, setReplies] = useState<Record<string, ReplyTarget | null>>(resume?.replies ?? {});
  const replyTo = useCallback((message: Message, author: string) => {
    setReplies(all => ({ ...all, [message.conversationId]: replyTarget(message, author) }));
    requestAnimationFrame(() => composerInput.current?.focus());
  }, []);
  /** An edit also scrubs quotes in other chats, so none of our older copies may be restored. */
  const messageChanged = useCallback((_message: Message) => {
    historyEpoch.current++;
    latestLoads.current.clear();
    historyRef.current = {}; setHistory({});
    const withoutPreviews = bootRef.current && { ...bootRef.current, conversations: bootRef.current.conversations.map(c => ({ ...c, lastMessage: null })) };
    bootRef.current = withoutPreviews; setBoot(withoutPreviews);
    setTrail(current => ({ at: current.at && { ...current.at, history: undefined }, back: current.back.map(place => ({ ...place, history: undefined })) }));
    setSearch(current => ({ ...current, items: null, revision: current.revision + 1 }));
    setReplies({});
    clearSnapshot(localStorage);
    const id = activeRef.current;
    if (id) void loadMessages(id, 'refresh');
    void api<Bootstrap>(`/bootstrap${includeArchivedRef.current ? '?includeArchived=1' : ''}`).then(acceptBootstrap).catch(showError);
  }, []);
  const expandMessage = useCallback((messageId: string) => {
    const id = activeRef.current; if (!id) return;
    const epoch = historyEpoch.current;
    void api<Message>(`/conversations/${encodeURIComponent(id)}/messages/${encodeURIComponent(messageId)}`).then(message => { if (epoch === historyEpoch.current) setHistory(all => all[id] ? { ...all, [id]: upsert(all[id], message) } : all); }).catch(e => showError(e));
  }, []);
  /** No valid session: the sign-in form replaces whatever was shown. */
  function signedOut() {
    stopStream.current?.(); stopStream.current = null;
    setDrafts({}); setAttachments({}); setReplies({}); resumeRange.current = null; resumeScroll.current = null;
    clearSnapshot(localStorage); setBoot(null); setLive(false); setHistory({}); setActive(null); fresh.current.clear();
    loadAccounts();
  }
  function loadAccounts() {
    api<Person[]>('/accounts').then(value => { setAccounts(value); setAccount(value[0]?.id ?? ''); setError(null); }, e => {
      setError(shown(e));
      if (isUnreachable(e)) setTimeout(loadAccounts, RETRY_MS);
    }).finally(() => setReady(true));
  }
  /** An expired or revoked session anywhere means signing in again; anything else is shown. */
  function showError(e: unknown) {
    if (e instanceof ApiError && e.code === 'unauthenticated') signedOut();
    else setError(shown(e));
  }
  useEffect(() => {
    if (restoredHistory.current === active) { restoredHistory.current = null; return; }
    if (streamed && active && (messageTarget?.conversationId === active || !(fresh.current.has(active) && !historyRef.current[active]?.hasNewer))) void loadMessages(active, 'open');
  }, [streamed, boot?.me.id, active, messageTarget?.token]);
  const zones = useRef(zoneReporter(report => api<ZoneReport>('/zone', 'PUT', report).then(({ zone, device }) => { setBoot(current => current && ({ ...current, zone: { zone, device } })); return { zone, device }; }), focusedZone, 800));
  useEffect(() => { if (live && boot) zones.current.known(boot.zone); }, [live, boot?.me.id, boot?.zone?.zone, boot?.zone?.device]);
  useEffect(() => {
    const check = () => { if (document.visibilityState === 'visible') zones.current.check(); };
    document.addEventListener('visibilitychange', check); window.addEventListener('focus', check);
    const every = setInterval(check, 10 * 60_000);
    return () => { document.removeEventListener('visibilitychange', check); window.removeEventListener('focus', check); clearInterval(every); };
  }, []);
  useEffect(() => {
    const save = () => { if (document.visibilityState === 'hidden') saveScreen(); };
    document.addEventListener('visibilitychange', save); window.addEventListener('pagehide', saveScreen);
    return () => { document.removeEventListener('visibilitychange', save); window.removeEventListener('pagehide', saveScreen); };
  }, []);
  useEffect(() => {
    const open = (event: Event) => {
      const detail = (event as CustomEvent<{ conversationId?: unknown; messageId?: unknown; seq?: unknown }>).detail;
      const id = detail?.conversationId;
      if (typeof id !== 'string' || !bootRef.current) return;
      event.preventDefault(); const message = detail?.messageId ?? detail?.seq; chatOpenRef.current(id, typeof message === 'string' || typeof message === 'number' ? String(message) : undefined);
    };
    window.addEventListener('kenan-open-conversation', open);
    return () => window.removeEventListener('kenan-open-conversation', open);
  }, []);
  useEffect(() => {
    let receivedSnapshot = false, refreshedForConnection = false;
    // Sequence-only catch-up misses edits to older rows. Always request a fresh page.
    const streamUrl = () => eventsPath(activeRef.current);
    const refreshViews = (value: Bootstrap) => {
      if (value.extensions.some(e => e.id === 'todos')) void loadTodos();
      window.dispatchEvent(new Event('kenan-refresh'));
      refreshedForConnection = true;
    };
    const receive = (raw: Event) => {
      const event = JSON.parse((raw as MessageEvent<string>).data) as StreamEvent;
      if (event.type === 'ready') {
        const opened = event.page, current = activeRef.current ?? opened?.conversationId ?? null;
        fresh.current = new Set(opened && resumeRange.current?.conversationId !== opened.conversationId ? [opened.conversationId] : []);
        historyEpoch.current++;
        latestLoads.current.clear();
        const freshHistory = opened ? { [opened.conversationId]: opened.page } : {};
        historyRef.current = freshHistory; setHistory(freshHistory);
        bootRef.current = event.bootstrap;
        setTrail(current => ({ at: current.at && { ...current.at, history: undefined }, back: current.back.map(place => ({ ...place, history: undefined })) }));
        setSearch(current => ({ ...current, items: null, revision: current.revision + 1 }));
        setReplies({});
        clearSnapshot(localStorage);
        acceptBootstrap(event.bootstrap);
        if (current && current !== opened?.conversationId && event.bootstrap.conversations.some(c => c.id === current)) void loadMessages(current, 'refresh');
        if (includeArchivedRef.current) void api<Bootstrap>('/bootstrap?includeArchived=1').then(acceptBootstrap).catch(e => showError(e));
        if (!refreshedForConnection) refreshViews(event.bootstrap);
        receivedSnapshot = true;
        sync.ready();
        setLive(true); setStreamed(true); setReady(true);
        setError(current => current?.kind === 'unreachable' ? null : current);
        resendRef.current();
        document.documentElement.dataset.live = 'true';
        writeSnapshot(localStorage, BUILD, { bootstrap: event.bootstrap, page: opened });
      } else if (event.type === 'unauthenticated') signedOut();
      else if (event.type === 'message') {
        const message = event.message;
        if (message.editedAt || message.deletedAt) { messageChanged(message); return; }
        setHistory(all => {
          const current = all[message.conversationId];
          if (!current) return all;
          const next = upsert(current, message);
          return { ...all, [message.conversationId]: message.conversationId !== activeRef.current || nearBottom.current ? trimForFollowing(next) : next };
        });
        const shown = previewable(message);
        setBoot(current => current && ({ ...current, conversations: current.conversations.map(c => c.id !== message.conversationId ? c : {
          ...c, lastSeq: Math.max(c.lastSeq, message.seq), updatedAt: message.updatedAt,
          lastMessage: shown && message.seq >= (c.lastMessage?.seq ?? 0) ? { authorId: message.authorId, preview: message.text.slice(0, 140), at: message.createdAt, seq: message.seq } : c.lastMessage,
        }) }));
      } else if (event.type === 'delta') {
        setHistory(all => {
          const current = all[event.conversationId];
          return current ? { ...all, [event.conversationId]: appendDelta(current, event.messageId, event.text) } : all;
        });
      } else if (event.type === 'thinking') {
        setHistory(all => {
          const current = all[event.conversationId];
          return current ? { ...all, [event.conversationId]: appendThinking(current, event.messageId, event.block, event.text) } : all;
        });
      } else if (event.type === 'tool_draft') {
        setHistory(all => {
          const current = all[event.conversationId];
          return current ? { ...all, [event.conversationId]: applyToolDraft(current, event.messageId, event.part) } : all;
        });
      } else if (event.type === 'conversation') {
        if (bootRef.current && !event.conversation.memberIds.includes(bootRef.current.me.id)) removeRoom(event.conversation.id);
        else setBoot(current => current && ({ ...current, conversations: [...current.conversations.filter(c => c.id !== event.conversation.id), ...(!event.conversation.archived || includeArchivedRef.current || event.conversation.id === activeRef.current ? [event.conversation] : [])] }));
      }
      else if (event.type === 'waiting') setBoot(current => current && ({ ...current, waiting: event.waiting }));
      else if (event.type === 'activity') setBoot(current => current && ({ ...current, activity: withActivity(current.activity, event.conversationId, event.activity) }));
      else if (event.type === 'agent') setBoot(current => current && ({ ...current, agents: [...current.agents.filter(a => a.id !== event.agent.id), event.agent], people: [...current.people.filter(p => p.id !== event.agent.id), event.agent] }));
      else if (event.type === 'chat_groups') window.dispatchEvent(new CustomEvent('kenan-chat-groups', { detail: event.groups }));
      else if (event.type === 'buy') setBuy(event.list);
      else if (event.type === 'todo') setTodos(current => current && byPosition([...current.filter(t => t.id !== event.todo.id), event.todo]));
      else if (event.type === 'layout') setBoot(current => current && ({ ...current, layout: event.layout }));
      else if (event.type === 'notifications_cleared') void clearDeliveredNotifications(event.conversationId, event.throughId).catch(error => console.warn('Notification clearing failed:', error));
      else if (event.type === 'seen') setBoot(current => current && ({ ...current, seen: event.seen }));
      else if (event.type === 'goal') {
        setGoals(current => [...current.filter(g => g.id !== event.goal.id), summary(event.goal)]);
        setFullGoals(current => current && [...current.filter(g => g.id !== event.goal.id), event.goal]);
      }
    };
    const batch = eventBatch(raw => {
      try { receive(raw); }
      catch (e) {
        const recovery = recoverApp(`stream event ${raw.type}: ${errorText(e)}`);
        if (recovery.kind === 'exhausted') setError({ kind: 'failed', text: `This version of Kenan can't read the server's ${raw.type} update (${errorText(e)}). Reload to get the newest version.` });
      }
    });
    const stop = connectEvents(streamUrl, {
      onConnect: () => { if (receivedSnapshot && bootRef.current) refreshViews(bootRef.current); },
      onOpen: () => { sync.opened(); setConnected(true); },
      onStale: () => { refreshedForConnection = false; batch.drop(); sync.stale(); setLive(false); fresh.current.clear(); },
      onError: () => { refreshedForConnection = false; sync.stale(true); setConnected(false); setLive(false); fresh.current.clear(); },
      onEvent: raw => batch.add(raw),
      onRestart: restart => { void api('/diag/stream', 'POST', { ...restart, online: navigator.onLine, hidden: document.visibilityState !== 'visible' }).catch(() => {}); },
    }, session === 0 ? adoptEarlyStream() : null);
    const end = () => { batch.drop(); stop(); };
    stopStream.current = end;
    return () => { end(); if (stopStream.current === end) stopStream.current = null; };
  }, [session]);
  const activeHistory = active ? history[active] : undefined;
  const messages = activeHistory?.messages;
  const conversation = boot?.conversations.find(c => c.id === active);
  const files = active ? attachments[active] ?? [] : [];
  useEffect(() => {
    if (!messages || page !== 'chat' || document.visibilityState !== 'visible') return;
    for (const message of messages) {
      if (message.role !== 'assistant' || !message.text || observedText.current.has(message.id) || message.state !== 'streaming') continue;
      observedText.current.add(message.id);
      requestAnimationFrame(() => requestAnimationFrame(() => { void api('/metrics/first-text', 'POST', { messageId: message.id, firstTextAt: Date.now() }).catch(() => {}); }));
    }
  }, [messages, page]);
  // Read means seen: a chat left open while the app is in the background stays unread until she comes back to it.
  useEffect(() => {
    if (!active || !conversation || page !== 'chat') return;
    const markRead = () => {
      if (document.visibilityState !== 'visible' || conversation.readThrough >= conversation.lastSeq) return;
      void api<ConversationSummary>(`/conversations/${active}`, 'PATCH', { readThrough: conversation.lastSeq }).then(updated => setBoot(current => current && ({ ...current, conversations: current.conversations.map(c => c.id === updated.id ? { ...c, readThrough: updated.readThrough } : c) }))).catch(() => {});
    };
    markRead();
    document.addEventListener('visibilitychange', markRead);
    return () => document.removeEventListener('visibilitychange', markRead);
  }, [active, conversation?.lastSeq, conversation?.readThrough, page]);
  useEffect(() => {
    if (!boot || (page !== 'goals' && page !== 'usage')) return;
    const refresh = () => {
      if (page === 'goals') void api<Goal[]>('/goals').then(setFullGoals).catch(e => showError(e));
      else {
        void api<UsageReport>('/usage').then(setUsage).catch(e => showError(e));
        void api<LatencyReport>('/metrics').then(setMetrics).catch(e => showError(e));
      }
    };
    refresh(); const timer = setInterval(refresh, 30_000); window.addEventListener('kenan-refresh', refresh); return () => { clearInterval(timer); window.removeEventListener('kenan-refresh', refresh); };
  }, [boot?.me.id, page]);
  async function archiveVisibility(include: boolean) {
    setIncludeArchived(include); includeArchivedRef.current = include; setArchiveLoading(true);
    try { const value = await api<Bootstrap>(`/bootstrap${include ? '?includeArchived=1' : ''}`); if (includeArchivedRef.current === include) acceptBootstrap(value); }
    catch (e) { showError(e); } finally { if (includeArchivedRef.current === include) setArchiveLoading(false); }
  }
  const moduleId = boot ? moduleOf(boot.extensions) : null;
  const todosOn = !!boot?.extensions.some(e => e.id === 'todos');
  const moduleShown = !!boot && !!webModule && webModule.takesOver(boot);
  // A module may keep the selected chat beside its list pages on desktop.
  const chatShown = page === 'chat' || (moduleShown && webModule!.chatBeside(page, wide));
  useViewing(!skyOnly && chatShown ? conversation?.id ?? null : null);
  const dictationOn = !!boot?.extensions.some(e => e.id === 'dictation');
  const voiceOn = !!boot?.composerVoice;
  const classicShown = !!boot && !moduleShown;
  const toggleNav = useRef<(() => void) | null>(null);
  toggleNav.current = !classicShown ? null : narrow ? () => setSidebar(open => !open) : () => setSidebarHidden(hidden => { sidebarHiddenPref.save(!hidden); return !hidden; });
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      const modifier = onMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
      if (!modifier || event.altKey || event.shiftKey || event.isComposing || !(event.code === 'Backslash' || event.key === '\\' || event.key.toLowerCase() === 'b') || !toggleNav.current) return;
      event.preventDefault(); toggleNav.current();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);
  const uploadRef = useRef<Upload | null>(null);
  useEffect(() => {
    let clear: ReturnType<typeof setTimeout> | undefined;
    const over = (event: DragEvent) => {
      if (!event.dataTransfer || !carriesFiles(event.dataTransfer)) return;
      event.preventDefault();
      const target = !!composerInput.current;
      event.dataTransfer.dropEffect = target ? 'copy' : 'none';
      setDropping(target); clearTimeout(clear); clear = setTimeout(() => setDropping(false), 200);
    };
    const drop = (event: DragEvent) => {
      if (!event.dataTransfer || !carriesFiles(event.dataTransfer)) return;
      event.preventDefault(); clearTimeout(clear); setDropping(false);
      if (composerInput.current && uploadRef.current) void uploadRef.current(transferFiles(event.dataTransfer));
    };
    window.addEventListener('dragover', over); window.addEventListener('drop', drop);
    return () => { clearTimeout(clear); window.removeEventListener('dragover', over); window.removeEventListener('drop', drop); };
  }, []);
  useEffect(() => { if (page === 'usage' && !usageModule) void import('./Usage.js').then(setUsageModule, e => setError({ kind: 'failed', text: `Couldn't load Usage: ${errorText(e)}` })); }, [page, usageModule]);
  const bubbleColor = boot?.bubbleColor ?? null;
  useEffect(() => {
    if (!bubbleColor) return;
    let gone = false, undo: (() => void) | null = null;
    void import('./mine.js').then(m => { if (!gone) undo = m.paintMine(bubbleColor); });
    return () => { gone = true; undo?.(); };
  }, [bubbleColor]);
  const background = boot?.background ?? null;
  const sky = useRef<import('./sky/sky.js').Sky | null>(null);
  const skyFollows = useRef(skyFollowsSystem);
  skyFollows.current = skyFollowsSystem;
  useEffect(() => {
    if (!background) return;
    let gone = false;
    void import('./sky/sky.js').then(m => m.mountSky(background, skyFollows.current, e => setError({ kind: 'failed', text: `The background stopped: ${errorText(e)}` }))).then(mounted => { if (gone) mounted.unmount(); else { sky.current = mounted; mounted.followSystem(skyFollows.current); } }).catch(e => setError({ kind: 'failed', text: `Couldn't draw the background: ${errorText(e)}` }));
    return () => { gone = true; sky.current?.unmount(); sky.current = null; };
  }, [background]);
  useEffect(() => { sky.current?.followSystem(skyFollowsSystem); }, [skyFollowsSystem]);
  useEffect(() => { if (boot && 'KenanNext' in window) void import('./share.js').then(m => m.listen(bootRef, uploadRef, setDrafts)); }, [!boot]);
  useEffect(() => { if (moduleId && !webModule) void loadWebModule(moduleId).then(setWebModule, e => setError({ kind: 'failed', text: `Couldn't load the ${moduleId} layout: ${errorText(e)}` })); }, [moduleId]);
  // Without a module's screens, only the app's own pages exist.
  useEffect(() => { if (!moduleShown && !CORE_PAGES.includes(page)) setPage('chat'); }, [moduleShown, page]);
  const placeRef = useRef<Place>({ page, active }); placeRef.current = { page, active };
  useEffect(() => setTrail(current => arrive(current, { page, active })), [page, active]);
  const capturePlace = (): Place => {
    const place = placeRef.current;
    return { ...place, scroll: captureUpdateScroll(nearBottom.current), history: place.active ? historyRef.current[place.active] : undefined };
  };
  const goTo = (place: Place) => {
    // A pending fetch from the place we left must not replace a restored window.
    if (place.active) latestLoads.current.delete(place.active);
    restoredHistory.current = place.history ? place.active : null;
    if (place.history && place.active) {
      setHistory(all => ({ ...all, [place.active!]: place.history! }));
      fresh.current.add(place.active);
    }
    if (place.history) setLoading(null);
    resumeScroll.current = place.scroll ?? null;
    const target = place.message && place.active ? { conversationId: place.active, message: place.message, token: ++targetSerial.current } : null;
    messageTargetRef.current = target; setMessageTarget(target);
    setActive(place.active); setPage(place.page); setSidebar(false); setError(null);
  };
  const backAlongTrail = () => { const step = retrace(trail); if (step) { setTrail(step.trail); goTo(step.to); } };
  useOverlay(trail.back.length > 0, backAlongTrail, trail.back.length);
  // Unknown links may name archived chats absent from bootstrap. The server authorizes them when opened.
  const chatLinks = useMemo<ChatLinks>(() => ({
    back: trail.back.length ? backAlongTrail : null,
    canOpen: () => true,
    open: (id, message) => {
      const from = capturePlace();
      const navigate = () => {
        const to: Place = { page: 'chat', active: id, ...(message ? { message } : {}) };
        if (!message && to.page === from.page && to.active === from.active) return;
        setTrail(current => follow(current, from, to)); goTo(to);
      };
      if (bootRef.current?.conversations.some(c => c.id === id)) navigate();
      else void api<ConversationSummary>(`/conversations/${encodeURIComponent(id)}`).then(conversation => {
        setBoot(current => current && ({ ...current, conversations: [...current.conversations.filter(c => c.id !== id), conversation] }));
        navigate();
      }).catch(showError);
    },
  }), [trail]);
  chatOpenRef.current = chatLinks.open;
  useOverlay(roomEditor, () => setRoomEditor(false));
  useOverlay(settings && page === 'chat' && !!conversation, () => { setSettings(false); settingsSummary.current?.focus(); });
  useEffect(() => {
    if (!roomEditor) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusable = () => Array.from(roomDialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]') ?? []);
    focusable()[0]?.focus();
    const trap = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const controls = focusable(), first = controls[0], last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', trap);
    return () => { document.removeEventListener('keydown', trap); previous?.focus(); };
  }, [roomEditor]);
  useWebUpdate(connected, !live || sending || uploading || !!loading || !!paging || !!pendingSend.current || Object.keys(dictations).length > 0, () => {
    const current = bootRef.current, id = activeRef.current;
    if (!current) return false;
    const messages = id ? historyRef.current[id]?.messages : null;
    return saveUpdateResume({ owner: current.me.id, active: id, page, drafts: drafts.get(), attachments, replies,
      range: id && messages?.length && !nearBottom.current ? { conversationId: id, before: messages.at(-1)!.seq + 1, limit: messages.length } : null,
      scroll: captureUpdateScroll(nearBottom.current),
    });
  });
  async function changeArchive(archived: boolean) {
    if (!conversation) return;
    try {
      if (conversation.agentId) await api(`/agents/${encodeURIComponent(conversation.agentId)}`, 'PATCH', { archived });
      else await api(`/conversations/${encodeURIComponent(conversation.id)}`, 'PATCH', { archived });
      setBoot(current => current && ({ ...current, conversations: current.conversations.map(c => c.id === conversation.id ? { ...c, archived } : c) }));
      acceptBootstrap(await api<Bootstrap>(`/bootstrap${includeArchivedRef.current ? '?includeArchived=1' : ''}`));
    } catch (e) { showError(e); }
  }
  async function login(e: FormEvent) {
    e.preventDefault(); setError(null);
    try { acceptBootstrap(await api<Bootstrap>('/login', 'POST', { accountId: account, secret })); setSecret(''); setSession(n => n + 1); }
    catch (error) { setError(shown(error)); }
  }
  async function send(e: FormEvent) {
    e.preventDefault(); if (micSend) { micSend(); return; }
    const held = active ? dictations[active] : undefined;
    if (!active || held?.state === 'live' || sending || uploading) return;
    const draft = drafts.get()[active] ?? '';
    const body = held ? held.box.sent(null) ?? draft : draft;
    if (!body.trim() && !files.length) return;
    await submit(active, body);
  }
  async function submit(id: string, body: string, draft = body, extra: FileInfo[] = []) {
    const reply = replies[id] ?? null, text = withReply(body, reply), ownIds = [...(attachments[id] ?? []), ...extra].map(f => f.id), fileIds = [...new Set([...ownIds, ...(reply?.files.map(f => f.id) ?? [])])];
    const old = pendingSend.current;
    const pending = old && old.conversationId === id && old.text === text && old.files.join() === fileIds.join() ? old : { conversationId: id, text, files: fileIds, clientId: crypto.randomUUID(), draft, ownIds, queued: false };
    pendingSend.current = pending; setError(null); nearBottom.current = true;
    setDrafts(all => ({ ...all, [id]: '' }));
    await deliver(pending);
  }
  /** Sends once per clientId (the server answers a repeat with the same message). When Kenan can't be reached the
   *  message waits, its draft kept, and goes out as soon as the stream is live again. */
  async function deliver(pending: PendingSend) {
    const id = pending.conversationId;
    pending.queued = false; setSending(true);
    try {
      const message = await api<Message>(`/conversations/${id}/messages`, 'POST', { clientId: pending.clientId, text: pending.text, fileIds: pending.files, clientSentAt: Date.now() });
      if (historyRef.current[id]?.hasNewer) jumpToLatest();
      else setHistory(all => all[id] ? { ...all, [id]: upsert(all[id], message) } : all);
      setDrafts(all => ({ ...all, [id]: all[id] === pending.draft ? '' : all[id] ?? '' })); setAttachments(all => ({ ...all, [id]: (all[id] ?? []).filter(f => !pending.ownIds.includes(f.id)) })); setReplies(all => ({ ...all, [id]: null }));
      if (pendingSend.current === pending) pendingSend.current = null;
    } catch (e) {
      setDrafts(all => all[id] ? all : { ...all, [id]: pending.draft });
      if (isUnreachable(e) && pendingSend.current === pending) { pending.queued = true; setError({ kind: 'unreachable', text: 'Not sent yet: Kenan can\'t be reached right now. Your message sends by itself when it reconnects.' }); }
      else showError(e);
    } finally { setSending(false); }
  }
  async function upload(selected: File[], id = active) {
    if (!id || !selected.length) return;
    setUploading(true); setError(null);
    try { for (const file of selected) { const form = new FormData(); form.append('file', file); const result = await api<FileInfo>('/files', 'POST', form); setAttachments(all => ({ ...all, [id]: [...all[id] ?? [], result] })); } }
    catch (e) { showError(e); } finally { setUploading(false); }
  }
  uploadRef.current = upload;
  /** A finished drawing goes out at once, with whatever is already in the composer. */
  async function sendDrawing(file: File, id = active): Promise<boolean> {
    if (!id) return false;
    try { const form = new FormData(); form.append('file', file); const drawing = await api<FileInfo>('/files', 'POST', form); await submit(id, drafts.get()[id] ?? '', drafts.get()[id] ?? '', [drawing]); return true; }
    catch (e) { showError(e); return false; }
  }
  async function saveRoom(e: FormEvent) {
    e.preventDefault(); if (!boot) return;
    try {
      const value = await api<ConversationSummary>('/conversations', 'POST', { title: roomTitle, memberIds: [...new Set([boot.me.id, ...members])] });
      setBoot(current => current && ({ ...current, conversations: [...current.conversations, value] })); setActive(value.id); setPage('chat'); setRoomEditor(false); setSidebar(false);
    } catch (e) { showError(e); }
  }
  async function updateRoom(changes: Record<string, unknown>) {
    if (!active) return;
    try { const value = await api<ConversationSummary>(`/conversations/${active}`, 'PATCH', changes); setBoot(current => current && ({ ...current, conversations: [...current.conversations.filter(c => c.id !== value.id), ...(value.archived ? [] : [value])] })); if (value.archived) setActive(boot?.manager.kind === 'here' ? boot.manager.conversationId : null); }
    catch (e) { showError(e); }
  }
  /** Leaving (or being removed on another device) must also forget any Back links into this room. */
  function removeRoom(id: string) {
    setBoot(current => current && ({ ...current, conversations: current.conversations.filter(c => c.id !== id) }));
    setTrail(current => ({ back: current.back.filter(p => p.active !== id), at: current.at?.active === id ? null : current.at }));
    if (activeRef.current === id) {
      const value = bootRef.current, home = value?.manager.kind === 'here' ? value.manager.conversationId : null;
      setActive(home !== id ? home : value?.conversations.find(c => c.id !== id && !c.archived)?.id ?? null);
      setPage('chat'); setSidebar(false); setSettings(false);
    }
  }
  async function leaveRoom(id: string): Promise<void> {
    await api<{ id: string }>(`/conversations/${encodeURIComponent(id)}/leave`, 'POST', {});
    removeRoom(id);
  }
  const { requestLeave, confirmation: leaveConfirmation } = useLeaveChat(leaveRoom);
  async function closeRoom(id: string, archived: boolean) {
    if (await updateTopic(id, { archived }) && archived && activeRef.current === id) {
      setActive(bootRef.current?.manager.kind === 'here' ? bootRef.current.manager.conversationId : null);
      setPage('chat'); setSidebar(false);
    }
  }
  /** A new blank chat opens at once; the server's agent and conversation events arrive too and replace these. */
  function blankStarted({ agent, conversation }: BlankStarted) {
    setBoot(current => current && ({ ...current, agents: [...current.agents.filter(a => a.id !== agent.id), agent], people: [...current.people.filter(p => p.id !== agent.id), agent], conversations: [conversation, ...current.conversations.filter(c => c.id !== conversation.id)] }));
    setActive(conversation.id); setPage('chat'); setSidebar(false);
  }
  async function closeBlank(agentId: string) {
    try {
      const agent = await closeBlankChat(agentId);
      setBoot(current => current && ({ ...current, agents: current.agents.map(a => a.id === agent.id ? agent : a), conversations: current.conversations.filter(c => c.id !== agent.conversationId) }));
      if (active === agent.conversationId) setActive(boot?.manager.kind === 'here' ? boot.manager.conversationId : null);
    } catch (e) { showError(e); }
  }
  /** The to-do list (the todos extension). */
  async function loadTodos() { void api<Todo[]>('/ext/todos/todos').then(value => setTodos(byPosition(value))).catch(showError); }
  const todoActions: TodoActions = {
    async change(id, patch) {
      setTodos(c => c && c.map(t => t.id !== id ? t : applyTodoChange(t, patch, Date.now())));
      try { const t = await api<Todo>(`/ext/todos/todos/${encodeURIComponent(id)}`, 'PATCH', patch); setTodos(c => c && byPosition([...c.filter(x => x.id !== t.id), t])); } catch (e) { showError(e); }
    },
    async chat(id) {
      try {
        const r = await api<TodoChat>(`/ext/todos/todos/${encodeURIComponent(id)}/chat`, 'POST', {});
        setTodos(c => c && byPosition([...c.filter(x => x.id !== r.todo.id), r.todo]));
        setBoot(current => current && ({ ...current, conversations: [r.conversation, ...current.conversations.filter(c => c.id !== r.conversation.id)] }));
        return r.conversation;
      } catch (e) { showError(e); return null; }
    },
    async dismiss(id) {
      try {
        const t = await api<Todo>(`/ext/todos/todos/${encodeURIComponent(id)}/dismiss`, 'POST', {});
        setTodos(c => c && byPosition([...c.filter(x => x.id !== t.id), t]));
        if (t.conversationId && boot?.conversations.some(c => c.id === t.conversationId)) choose(t.conversationId);
        setFocusComposer(n => n + 1);
      } catch (e) { showError(e); }
    },
    async answer(id, choice) {
      try { const proposal = todos?.find(t => t.id === id)?.postProposalId; const path = proposal ? `/ext/todos/post-proposals/${encodeURIComponent(proposal)}/decision` : `/ext/todos/todos/${encodeURIComponent(id)}/answer`; const t = await api<Todo>(path, 'POST', { choice }); setTodos(c => c && byPosition([...c.filter(x => x.id !== t.id), t])); } catch (e) { showError(e); }
    },
  };
  const questions = { todos, answer: todoActions.answer, dismiss: todoActions.dismiss };
  /** Saves which footer tiles show (PUT /api/tray); the tray changes at once and returns to the saved choice if the save fails. */
  async function chooseTray(tiles: TrayTile[] | null) {
    const before = boot?.trayTiles ?? null;
    setBoot(current => current && ({ ...current, trayTiles: tiles }));
    try { const saved = await api<{ tiles: TrayTile[] | null }>('/tray', 'PUT', { tiles }); setBoot(current => current && ({ ...current, trayTiles: saved.tiles })); }
    catch (e) { setBoot(current => current && ({ ...current, trayTiles: before })); showError(e); }
  }
  async function updateTopic(id: string, patch: ConversationPatch): Promise<ConversationSummary | null> {
    try {
      const value = await api<ConversationSummary>(`/conversations/${encodeURIComponent(id)}`, 'PATCH', patch);
      setBoot(current => current && ({ ...current, conversations: [...current.conversations.filter(c => c.id !== value.id), value] }));
      return value;
    } catch (e) { showError(e); return null; }
  }
  const agents = boot?.agents;
  // Blank chats aren't workers: they have their own list, never the agent tree.
  const tree = useMemo(() => agents ? agentTree(agents.filter(a => a.role !== 'blank'), includeArchived) : [], [agents, includeArchived]);
  const choose = (id: string) => { restoredHistory.current = null; messageTargetRef.current = null; setMessageTarget(null); setTrail(NO_TRAIL); resumeScroll.current = null; setActive(id); setPage('chat'); setSidebar(false); setError(null); };
  // A different detail page does not change the room or agent list. Keep its rows and icons out of that render.
  const sidebarNav = useMemo(() => boot && <nav aria-label="Conversations">
        {openBlankChats(boot.agents).length > 0 && <><div className="nav-heading"><h2>Blank chats</h2></div>
          {openBlankChats(boot.agents).map(a => <div key={a.id} className="agent-row"><button className={page === 'chat' && a.conversationId === active ? 'agent-link selected' : 'agent-link'} aria-current={page === 'chat' && a.conversationId === active ? 'page' : undefined} onClick={() => choose(a.conversationId)}><span>{boot.conversations.find(c => c.id === a.conversationId)?.title ?? a.name}</span><small>{boot.activity[a.conversationId] ? activityText(boot.activity[a.conversationId]!) : 'No context · close when done'}</small></button><button className="tree-disclosure" aria-label={`Close ${a.name}`} title="Close this blank chat" onClick={() => void closeBlank(a.id)}>✕</button></div>)}</>}
        <div className="nav-heading"><h2>{includeArchived ? 'All agents' : 'Agents'}</h2><span>{boot.agents.filter(a => !a.archived && a.category !== 'upkeep').length} active · {boot.agents.filter(a => !a.archived && a.category !== 'upkeep' && a.state === 'running').length} running{waitingCount(boot.agents.filter(a => a.category !== 'upkeep'), boot.agents) ? <b className="waiting-count"> · ⚠ {waitingCount(boot.agents.filter(a => a.category !== 'upkeep'), boot.agents)} waiting</b> : null}</span></div>
        {archiveLoading && <p className="sidebar-empty" role="status">Loading agents…</p>}
        <AgentTree agents={boot.agents} nodes={tree} goals={goals} conversations={boot.conversations} activity={boot.activity} active={page === 'chat' ? active : null} choose={choose}/>
        {conversation && !agentTreeContains(tree, active) && conversation.agentId && !blankAgentOf(conversation, boot.agents) && <div className="current-chat"><h2>Current conversation</h2><button className="selected" aria-current={page === 'chat' ? 'page' : undefined} onClick={() => choose(conversation.id)}><span>{conversation.title}</span><small>{conversation.archived ? 'Archived' : 'Ready for a message'}</small></button></div>}
        <div className="nav-heading"><h2>Rooms</h2></div>
        {[...boot.conversations].filter(c => !c.agentId && (includeArchived || !c.archived)).sort((a, b) => b.updatedAt - a.updatedAt).map(c => <ClassicRoomRow key={c.id} c={c} boot={boot} selected={page === 'chat' && c.id === active} open={() => choose(c.id)} closeRoom={archived => void closeRoom(c.id, archived)} requestLeave={requestLeave}><span>{c.title || 'Conversation'} {unread(c) && c.id !== active && <b aria-label="Unread">●</b>}</span><small>{c.archived ? 'Archived' : boot.activity[c.id] ? activityText(boot.activity[c.id]!) : (c.lastMessage ? plainPreview(c.lastMessage.preview) : '') || 'No messages yet'}</small></ClassicRoomRow>)}
        <button type="button" className="archive-toggle" aria-pressed={includeArchived} onClick={() => void archiveVisibility(!includeArchived)}>{includeArchived ? 'Hide archived agents and rooms' : 'Show archived agents and rooms'}</button>
      </nav>, [boot, page === 'chat', active, conversation, tree, goals, includeArchived, archiveLoading]);
  if (!ready) return <main className="login"><p>Opening Kenan…</p></main>;
  if (!boot) return <main className="login"><form onSubmit={login}><h1>Kenan</h1><label>Account<select value={account} onChange={e => setAccount(e.target.value)}>{accounts.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label><label>Password<input autoComplete="current-password" type="password" value={secret} onChange={e => setSecret(e.target.value)} required autoFocus /></label>{error && <p role="alert">{error.text}</p>}<button type="submit" disabled={!account}>Sign in</button></form></main>;
  const signOut = () => { void api('/logout', 'POST', {}).then(() => { clearSnapshot(localStorage); location.reload(); }).catch(e => showError(e)); };
  const updates = <>
    {push.banner && <div className="update-banner" role={push.state.kind === 'failed' ? 'alert' : 'status'}><span>{push.state.kind === 'failed' ? `Notifications on this device failed: ${push.state.message}` : 'Get notifications from your agents on this device.'}</span><button className="primary" onClick={push.enable}>Turn on</button><button aria-label="Dismiss" onClick={push.dismiss}>×</button></div>}
    {!appUpdate.bannerHidden && <UpdateBanner channel={boot.channel} update={appUpdate.update} install={() => void appUpdate.install()} dismiss={appUpdate.dismiss}/>}
    {error && <div className={error.kind === 'unreachable' ? 'error unreachable' : 'error'} role="alert">{error.text}<button aria-label="Dismiss error" onClick={() => setError(null)}>×</button></div>}
  </>;
  const banners = <>
    <Suspense fallback={null}>{(boot.manager.kind !== 'here' || boot.clientHome) && <ManagerBanner home={boot.manager} origin={live ? boot.clientHome : undefined} accountId={boot.me.id}/>}</Suspense>
    {page === 'chat' && conversation?.archived && <div className="archive-banner"><span>This conversation is archived.</span><button onClick={() => void changeArchive(false)}>Restore to message</button></div>}
    {updates}
  </>;
  const sharedBanners = <>
    <Suspense fallback={null}>{(boot.manager.kind !== 'here' || boot.clientHome) && <ManagerBanner home={boot.manager} origin={live ? boot.clientHome : undefined} accountId={boot.me.id}/>}</Suspense>
    {updates}
  </>;
  const personName = (id: string) => boot.people.find(p => p.id === id)?.name ?? id;
  const viewOf = (pg: Page) => pg === 'search' ? <Search state={search} change={setSearch} conversations={boot.conversations} open={chatLinks.open}/> : pg === 'calendar' ? <Suspense fallback={<p className="panel">Loading…</p>}><Calendar/></Suspense> : pg === 'todo' ? <Suspense fallback={<p className="panel">Loading…</p>}><ClassicTodo boot={boot} todos={todos} todo={todoActions} buy={buy} setBuy={setBuy} open={choose}/></Suspense> : pg === 'chat' ? <><Transcript target={messageTarget?.conversationId === active ? messageTarget : null} restoreScroll={resumeScroll} key={active ?? ''} me={boot.me.id} conversation={conversation} activity={active ? boot.activity[active] ?? null : null} waiting={boot.extensions.some(e => e.id === 'busyline') ? boot.waiting : null} conversations={boot.conversations} history={activeHistory} loading={loading === active} paging={paging} people={boot.people} agents={boot.agents} follow={nearBottom} older={loadOlder} newer={loadNewer} latest={jumpToLatest} expand={expandMessage} reply={replyTo} changed={messageChanged}/>
        {active && !conversation?.archived && <Composer active={active} drafts={drafts} composerInput={composerInput} field={id => activeRef.current === id ? composerInput.current : null} dropping={dropping}
          reply={replies[active] ?? null} cancelReply={() => setReplies(all => ({ ...all, [active]: null }))}
          files={files} removeFile={id => setAttachments(all => ({ ...all, [active]: files.filter(f => f.id !== id) }))}
          dictations={dictations} setDictations={setDictations} dismissProblem={() => setDictations(({ [active]: _gone, ...rest }) => rest)}
          uploading={uploading} upload={upload} sendDrawing={sendDrawing} dictationOn={dictationOn} voiceOn={voiceOn} agentId={conversation?.agentId}
          micSend={micSend} setMicSend={setMicSend} sending={sending} send={send} submit={(id, body) => void submit(id, body)}
          onError={text => setError({ kind: 'failed', text })} working={!!boot.activity[active]}
          stop={() => void api(`/conversations/${active}/stop`, 'POST', {}).catch(e => showError(e))}
          mentions={mentionNames(boot.me, boot.people, conversation)}/>}</> : pg === 'goals' ? <Suspense fallback={<p className="panel">Loading…</p>}><Goals goals={fullGoals} agents={boot.agents} people={boot.people} includeArchived={includeArchived} showArchived={include => void archiveVisibility(include)} choose={choose}/></Suspense> : usageModule ? <usageModule.Usage usage={usage} metrics={metrics}/> : <div className="panel"><p>Loading…</p></div>;
  const skyOnlyView = skyOnly && boot.background && <Suspense fallback={null}><SkyOnly close={() => setSkyOnly(false)}/></Suspense>;
  const roomModal = roomEditor && <div className="modal-backdrop"><form ref={roomDialog} className="modal" role="dialog" aria-modal="true" aria-labelledby="room-title" onSubmit={saveRoom}><h2 id="room-title">New room</h2><label>Title<input value={roomTitle} onChange={e => setRoomTitle(e.target.value)} required autoFocus/></label><fieldset><legend>Members</legend>{boot.people.filter(p => p.id !== boot.me.id).map(person => <label className="checkbox" key={person.id}><input type="checkbox" checked={members.includes(person.id)} onChange={e => setMembers(current => e.target.checked ? [...current, person.id] : current.filter(id => id !== person.id))}/>{person.name}</label>)}</fieldset><div className="actions"><button type="button" onClick={() => setRoomEditor(false)}>Cancel</button><button type="submit">Create room</button></div></form></div>;
  if (moduleId && boot.layout !== 'classic' && !webModule) return <main className="login"><p>Opening Kenan…</p></main>;
  if (moduleShown) return <ChatLinkContext.Provider value={chatLinks}><QuestionContext.Provider value={questions}>
    <webModule.Host boot={boot} setBoot={setBoot} showError={showError} goals={goals} todos={todos} todo={todoActions} buy={buy} setBuy={setBuy}
      page={page} setPage={setPage} go={next => { setPage(next); setError(null); }} active={active} open={choose}
      detail={viewOf} openProject={id => { const from = placeRef.current, to: Place = { page: 'project', active: id }; if (from.page === 'chat') setTrail(current => follow(current, from, to)); goTo(to); }} banners={sharedBanners} push={push} wide={wide} connected={connected && live}
      skyMotion={boot.background ? { followsSystem: skyFollowsSystem, toggle: toggleSkyMotion } : null} showSky={boot.background ? () => setSkyOnly(true) : null}
      checkUpdate={appUpdate.update.state !== 'web' ? () => void appUpdate.check() : null} chooseTray={chooseTray} signOut={signOut}
      weeklyLeft={usage?.plans.find(plan => plan.metric === 'weekly')?.percentLeft ?? null} refreshUsage={() => void api<UsageReport>('/usage').then(setUsage).catch(e => showError(e))}
      added={value => setBoot(current => current && ({ ...current, conversations: [...current.conversations.filter(c => c.id !== value.id), value] }))} update={updateTopic} leave={leaveRoom}
      showClosed={include => { if (include !== includeArchivedRef.current) void archiveVisibility(include); }} closedLoaded={includeArchived && !archiveLoading}
      blank={{ started: blankStarted, close: id => void closeBlank(id) }}
      history={history} setHistory={setHistory} loadMessages={loadMessages} drafts={drafts} keepPlace={!!(linkedConversation() || resume)}/>
    <SyncIndicator/>
    {skyOnlyView}
  </QuestionContext.Provider></ChatLinkContext.Provider>;
  return <ChatLinkContext.Provider value={chatLinks}><QuestionContext.Provider value={questions}><div className={sidebarHidden ? 'app sidebar-hidden' : 'app'}>
    <NavDrawer control={sidebarControl} narrow={narrow} skyOnly={skyOnly}>
      <div className="new-row"><button onClick={() => { setRoomTitle(''); setMembers([]); setRoomEditor(true); }}>＋ New room</button><BlankButton started={blankStarted}/></div>
      {sidebarNav}
      <footer><CompactMenu mode="toggle" tray={boot.trayTiles} places={([
        ...(boot.extensions.some(e => e.id === 'calendar') ? [['calendar', 'calendar', 'Calendar']] : []),
        ...(todosOn ? [['todo', 'todo', 'To-do']] : []),
        ['search', 'search', 'Search'], ['goals', 'goals', 'Goals', 'Goals & workers'], ['usage', 'usage', 'Usage'],
      ] as [Page, FooterIconId, string, string?][]).map((([id, icon, label, title = label]): MenuPlace => ({ id, icon, label, title, current: page === id, dot: false, go: () => { setPage(id); setSidebar(false); } }))).concat((bridge() ? [{ id: 'finder', icon: 'finder' as const, label: 'forest', title: 'forest', current: false, dot: false, go: () => { setSidebar(false); void call('openFinder', {}); } }] : [])).concat(boot.background ? [{ id: 'sky', icon: 'sky', label: 'Sky', title: 'Show just the background', current: false, dot: false, go: () => { setSidebar(false); setSkyOnly(true); } }] : [])} settings={<Suspense fallback={null}><Settings name={boot.me.name} signOut={signOut}         skyMotion={boot.background ? { followsSystem: skyFollowsSystem, toggle: toggleSkyMotion } : null}
        push={push} checkUpdate={appUpdate.update.state === 'web' ? null : () => { setSidebar(false); void appUpdate.check(); }} tray={{ tiles: boot.trayTiles, choose: chooseTray }}/></Suspense>}/></footer>
    </NavDrawer>
    <main className="main"><header className="topbar">{trail.back.length > 0 && <button aria-label="Back to previous place" onClick={backAlongTrail}>←</button>}<button className="mobile" aria-label="Open navigation" onClick={() => setSidebar(true)}>☰</button><button className="desktop nav-toggle" aria-label={sidebarHidden ? 'Show sidebar' : 'Hide sidebar'} aria-pressed={!sidebarHidden} title={`${sidebarHidden ? 'Show' : 'Hide'} sidebar (${shortcutLabel})`} onClick={() => toggleNav.current?.()}>{sidebarHidden ? <PanelLeftOpen size={18}/> : <PanelLeftClose size={18}/>}</button><h1>{page === 'chat' ? conversation?.title || 'Conversations' : page === 'goals' ? 'Goals & workers' : page === 'calendar' ? 'Calendar' : page === 'todo' ? 'To-do' : page === 'search' ? 'Search' : 'Usage'}</h1>{page === 'chat' && (blank => blank && !blank.archived && <button title="End this blank chat; it leaves your lists" onClick={() => void closeBlank(blank.id)}>✕ Close</button>)(blankAgentOf(conversation, boot.agents))}{page === 'chat' && conversation && <details className="menu" open={settings} onToggle={e => setSettings(e.currentTarget.open)}><summary ref={settingsSummary} aria-label="Conversation settings">•••</summary><div><button onClick={() => { const title = prompt('Conversation title', conversation.title); if (title?.trim()) void updateRoom({ title }); }}>Rename</button><button onClick={() => void changeArchive(!conversation.archived)}>{conversation.archived ? 'Restore conversation' : 'Archive conversation'}</button><strong>Members</strong>{conversation.memberIds.map(id => <div key={id}>{personName(id)}{id !== boot.me.id && <button aria-label={`Remove ${personName(id)}`} onClick={() => void updateRoom({ removeMemberIds: [id] })}>×</button>}</div>)}<Suspense fallback={null}><MemberColorsMenu conversation={conversation} people={boot.people} change={memberColors => void updateRoom({ memberColors })}/></Suspense><select aria-label="Add member" value="" onChange={e => { if (e.target.value) void updateRoom({ addMemberIds: [e.target.value] }); }}><option value="">Add member…</option>{boot.people.filter(p => !conversation.memberIds.includes(p.id)).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></div></details>}</header>
      {banners}
      {viewOf(page)}
    </main>
    <SyncIndicator/>
    {roomModal}
    {leaveConfirmation}
    {skyOnlyView}
  </div></QuestionContext.Provider></ChatLinkContext.Provider>;
}

const onMac = /Mac|iPhone|iPad/.test(navigator.platform);
const shortcutLabel = onMac ? '⌘B or ⌘\\' : 'Ctrl+B or Ctrl+\\';
const appName = (channel: string) => channel === 'beta' ? 'Kenan Beta' : 'Kenan';

function UpdateBanner({ channel, update, install, dismiss }: { channel: string; update: AppUpdate; install: () => void; dismiss: () => void }) {
  const close = <button aria-label="Dismiss" onClick={dismiss}>×</button>;
  switch (update.state) {
    case 'web': case 'quiet': return null;
    case 'checking': return <div className="update-banner" role="status"><span>Checking for an app update…</span></div>;
    case 'available': return <div className="update-banner" role="status"><span>{appName(channel)} update ready (version {update.release.versionCode}).</span><button className="primary" onClick={install}>Install update</button>{close}</div>;
    case 'installing': return <div className="update-banner" role="status"><span>Downloading version {update.release.versionCode}… then tap <b>Update</b> (or Install) in the Android prompt.</span>{close}</div>;
    case 'current': return <div className="update-banner" role="status"><span>{appName(channel)} is up to date (version {update.versionCode}).</span>{close}</div>;
    case 'needs-permission': return <div className="update-banner" role="status"><span>Android needs permission first: in the settings page that opened (or Settings › Apps › Special app access › Install unknown apps › {appName(channel)}), switch on <b>Allow from this source</b>, come back, and tap <b>Install update</b> again.</span>{close}</div>;
    case 'prompt-pending': return <div className="update-banner" role="status"><span>An earlier install prompt is still open. On the screen that opened, tap <b>Check / retry app update</b> to show it again.</span>{close}</div>;
    case 'failed': return <div className="update-banner" role="alert"><span>App update check failed: {update.message}</span>{close}</div>;
  }
}

const byPosition = (todos: Todo[]) => [...todos].sort((a, b) => a.position - b.position || a.createdAt - b.createdAt);
function useMedia(query: string) {
  const [wide, setWide] = useState(() => matchMedia(query).matches);
  useEffect(() => { const list = matchMedia(query), change = () => setWide(list.matches); list.addEventListener('change', change); return () => list.removeEventListener('change', change); }, []);
  return wide;
}
