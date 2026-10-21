import { apiPath } from './path.js';
import { adoptEarlyStream, connectEvents } from './events.js';
import { clearSnapshot, OPEN_KEY, readSnapshot, writeSnapshot, type Snapshot } from './snapshot.js';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { MessageMarkdown } from './MessageMarkdown.js';
import { previewable, unread, type Bootstrap, type ConversationSummary, type FileInfo, type Goal, type GoalSummary, type Message, type MessagePage, type Person, type StreamEvent, type UsageReport, type LatencyReport, type ManagerHome } from '../shared/contract.js';
import { api, ApiError, isUnreachable } from './client.js';
import { Attachments } from './Attachments.js';
import { Transcript, type Paging } from './Transcript.js';
import { activityText, withActivity } from './activity.js';
import { acceptLatest, appendDelta, appendNewer, PAGE_SIZE, prependOlder, trimForFollowing, upsert, type History } from './history.js';
import { AgentTree, agentTree, agentTreeContains, waitingCount } from './AgentTree.js';
import { Calendar } from './extensions/calendar.js';
import { useEnterAction } from './enterKey.js';
import { useAppUpdate, type AppUpdate } from './AppUpdate.js';
import { runningEntry, useWebUpdate } from './WebUpdate.js';
import { recoverApp } from './recover.js';
import { useWebPush, type PushState } from './push.js';
import { useOverlay } from './overlay.js';
import { readFoldWork, saveFoldWork } from './workSteps.js';
import { metricName, planSummary } from './usageSummary.js';
import { replyLabel, replyTarget, withReply, type ReplyTarget } from './reply.js';
import { isList, type Screen, type Trip } from './organized/screens.js';
import type { TodoActions } from './organized/Organized.js';
/** Organized is its own chunk, loaded only for people who have it, so Classic's startup download is unchanged. */
type OrganizedModule = typeof import('./organized/Organized.js');
import type { ConversationPatch, Layout, Todo } from '../shared/contract.js';

type Page = Screen;
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
/** A failure shown to her. `unreachable` (Kenan didn't answer) clears itself once the stream is live again. */
/** A message on its way; `queued` once Kenan was unreachable for it. */
type PendingSend = { conversationId: string; text: string; files: string[]; clientId: string; draft: string; ownIds: string[]; queued: boolean };
const RETRY_MS = 3000;
/** This build's identity; a saved screen from any other build is discarded. */
const BUILD = runningEntry();
type Shown = { kind: 'failed' | 'unreachable'; text: string };
const shown = (error: unknown): Shown => ({ kind: isUnreachable(error) ? 'unreachable' : 'failed', text: errorText(error) });
const date = (value: number | null) => value === null ? '—' : new Date(value).toLocaleString();
const summary = (goal: Goal): GoalSummary => ({ id: goal.id, title: goal.title, status: goal.status });
const eventsPath = (open: string | null) => apiPath(`/api/events${open ? `?open=${encodeURIComponent(open)}` : ''}`);
/** A notification opens the app on its conversation (the Android app adds it to the URL). */
const linkedConversation = () => new URLSearchParams(location.search).get('conversationId');
/** What the previous open showed; drawn at once and replaced when the stream's snapshot arrives. */
function initialScreen(): Snapshot | null {
  const read = readSnapshot(localStorage, BUILD);
  if (read.kind === 'invalid') console.warn('Discarded the saved startup screen:', read.reason);
  return read.kind === 'found' ? read.snapshot : null;
}

export function App() {
  const [cached] = useState(initialScreen);
  const [foldWork, setFoldWork] = useState(readFoldWork);
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
  const [active, setActive] = useState<string | null>(() => linkedConversation() ?? cached?.page?.conversationId ?? null);
  const [page, setPage] = useState<Page>('chat');
  const [history, setHistory] = useState<Record<string, History>>(() => cached?.page ? { [cached.page.conversationId]: cached.page.page } : {});
  const [connected, setConnected] = useState(false);
  const webUpdate = useWebUpdate(connected);
  const appUpdate = useAppUpdate();
  const push = useWebPush(live);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [attachments, setAttachments] = useState<Record<string, FileInfo[]>>({});
  const [sending, setSending] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [roomEditor, setRoomEditor] = useState(false);
  const [roomTitle, setRoomTitle] = useState('');
  const [members, setMembers] = useState<string[]>([]);
  const [goals, setGoals] = useState<GoalSummary[]>(cached?.bootstrap.goals ?? []);
  const [fullGoals, setFullGoals] = useState<Goal[] | null>(null);
  const [usage, setUsage] = useState<UsageReport | null>(null);
  const [metrics, setMetrics] = useState<LatencyReport | null>(null);
  const [sidebar, setSidebar] = useState(false);
  const [todos, setTodos] = useState<Todo[] | null>(null);
  const [nextTrip, setNextTrip] = useState<Trip | null>(null);
  const [organizedModule, setOrganizedModule] = useState<OrganizedModule | null>(null);
  const wide = useMedia('(min-width: 900px)'), narrow = useMedia('(max-width: 700px)');
  const [settings, setSettings] = useState(false);
  const settingsSummary = useRef<HTMLElement>(null);
  const [includeArchived, setIncludeArchived] = useState(false);
  const [archiveLoading, setArchiveLoading] = useState(false);
  const includeArchivedRef = useRef(includeArchived); includeArchivedRef.current = includeArchived;
  const activeRef = useRef(active); activeRef.current = active;
  const composerInput = useRef<HTMLTextAreaElement>(null);
  const enterAction = useEnterAction();
  const roomDialog = useRef<HTMLFormElement>(null);
  const nearBottom = useRef(true);
  const observedText = useRef(new Set<string>());
  const pendingSend = useRef<PendingSend | null>(null);
  const resendRef = useRef(() => {});
  resendRef.current = () => { const pending = pendingSend.current; if (pending?.queued) void deliver(pending); };
  const [loading, setLoading] = useState<string | null>(null);
  const [paging, setPaging] = useState<Paging>(null);
  const pagingRef = useRef(false);
  const historyRef = useRef(history); historyRef.current = history;
  const latestLoads = useRef(new Map<string, Promise<MessagePage | null>>());
  /** Conversations whose loaded history the current stream keeps up to date. */
  const fresh = useRef(new Set<string>());
  const bootRef = useRef(boot); bootRef.current = boot;
  const stopStream = useRef<(() => void) | null>(null);
  useEffect(() => { document.documentElement.dataset.appStarted = ready ? 'true' : 'false'; }, [ready]);
  useEffect(() => { if (active) localStorage.setItem(OPEN_KEY, active); }, [active]);

  function acceptBootstrap(value: Bootstrap) {
    setBoot(current => {
      const opened = current?.conversations.find(c => c.id === activeRef.current);
      return opened && !value.conversations.some(c => c.id === opened.id) ? { ...value, conversations: [...value.conversations, opened] } : value;
    });
    setGoals(value.goals);
    setActive(current => current ?? (value.manager.kind === 'here' ? value.manager.conversationId : null) ?? value.conversations[0]?.id ?? null);
    document.title = value.channel === 'beta' ? 'Kenan Beta' : 'Kenan';
  }
  const messagesPath = (id: string, query = '') => `/conversations/${encodeURIComponent(id)}/messages?limit=${PAGE_SIZE}${query}`;
  /** `open` shows the newest messages; `catch-up` (after reconnecting) keeps a window she scrolled back to. */
  function loadMessages(id: string, mode: 'open' | 'catch-up'): Promise<MessagePage | null> {
    setLoading(id);
    const load = api<MessagePage>(messagesPath(id)).then(page => {
      setHistory(all => ({ ...all, [id]: mode === 'open' && all[id]?.hasNewer ? page : acceptLatest(all[id], page) }));
      fresh.current.add(id);
      return page;
    }, e => { showError(e); return null; }).finally(() => {
      setLoading(current => current === id ? null : current);
      if (latestLoads.current.get(id) === load) latestLoads.current.delete(id);
    });
    latestLoads.current.set(id, load);
    return load;
  }
  /** After the event stream (re)connects: fetch what it may have missed, from the oldest still-streaming message on. */
  async function catchUp(id: string) {
    const pending = latestLoads.current.get(id);
    const base = pending ? await pending : historyRef.current[id];
    if (!base) { await loadMessages(id, 'catch-up'); return; }
    if (base.hasNewer) return;
    const streaming = base.messages.find(m => m.state === 'streaming'), last = base.messages.at(-1);
    const after = streaming ? streaming.seq - 1 : last ? last.seq : 0;
    try {
      const page = await api<MessagePage>(messagesPath(id, `&after=${after}`));
      if (page.hasNewer) { await loadMessages(id, 'catch-up'); return; }
      setHistory(all => { const current = all[id]; return current && !current.hasNewer ? { ...all, [id]: trimForFollowing(page.messages.reduce(upsert, current)) } : all; });
      fresh.current.add(id);
    } catch (e) { showError(e); }
  }
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
    pagingRef.current = true; setPaging(direction);
    try {
      const page = await api<MessagePage>(messagesPath(id, direction === 'older' ? `&before=${edge}` : `&after=${edge}`));
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
    void api<MessagePage>(messagesPath(id)).then(page => { nearBottom.current = true; setHistory(all => ({ ...all, [id]: page })); }).catch(e => showError(e));
  }, []);
  const [replies, setReplies] = useState<Record<string, ReplyTarget | null>>({});
  const replyTo = useCallback((message: Message, author: string) => {
    setReplies(all => ({ ...all, [message.conversationId]: replyTarget(message, author) }));
    requestAnimationFrame(() => composerInput.current?.focus());
  }, []);
  const expandMessage = useCallback((messageId: string) => {
    const id = activeRef.current; if (!id) return;
    void api<Message>(`/conversations/${encodeURIComponent(id)}/messages/${encodeURIComponent(messageId)}`).then(message => setHistory(all => all[id] ? { ...all, [id]: upsert(all[id], message) } : all)).catch(e => showError(e));
  }, []);
  /** No valid session: the sign-in form replaces whatever was shown. */
  function signedOut() {
    stopStream.current?.(); stopStream.current = null;
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
    if (streamed && active && !(fresh.current.has(active) && !historyRef.current[active]?.hasNewer)) void loadMessages(active, 'open');
  }, [streamed, boot?.me.id, active]);
  useEffect(() => {
    const save = () => { if (document.visibilityState === 'hidden') saveScreen(); };
    document.addEventListener('visibilitychange', save); window.addEventListener('pagehide', saveScreen);
    return () => { document.removeEventListener('visibilitychange', save); window.removeEventListener('pagehide', saveScreen); };
  }, []);
  useEffect(() => {
    const open = (event: Event) => {
      const id = (event as CustomEvent<{ conversationId?: unknown }>).detail?.conversationId;
      if (typeof id !== 'string' || !bootRef.current) return;
      event.preventDefault(); setActive(id); setPage('chat'); setSidebar(false);
    };
    window.addEventListener('kenan-open-conversation', open);
    return () => window.removeEventListener('kenan-open-conversation', open);
  }, []);
  useEffect(() => {
    const receive = (raw: Event) => {
      const event = JSON.parse((raw as MessageEvent<string>).data) as StreamEvent;
      if (event.type === 'ready') {
        const opened = event.page, current = activeRef.current ?? opened?.conversationId ?? null;
        fresh.current = new Set(opened ? [opened.conversationId] : []);
        if (opened) {
          setActive(id => id ?? opened.conversationId);
          setHistory(all => ({ ...all, [opened.conversationId]: acceptLatest(all[opened.conversationId], opened.page) }));
        }
        acceptBootstrap(event.bootstrap);
        if (current && current !== opened?.conversationId && historyRef.current[current]) void catchUp(current);
        if (includeArchivedRef.current) void api<Bootstrap>('/bootstrap?includeArchived=1').then(acceptBootstrap).catch(e => showError(e));
        if (event.bootstrap.extensions.some(e => e.id === 'organized')) void loadOrganized(event.bootstrap);
        setLive(true); setStreamed(true); setReady(true);
        setError(current => current?.kind === 'unreachable' ? null : current);
        resendRef.current();
        document.documentElement.dataset.live = 'true';
        writeSnapshot(localStorage, BUILD, { bootstrap: event.bootstrap, page: opened });
      } else if (event.type === 'unauthenticated') signedOut();
      else if (event.type === 'message') {
        const message = event.message;
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
      } else if (event.type === 'conversation') setBoot(current => current && ({ ...current, conversations: [...current.conversations.filter(c => c.id !== event.conversation.id), ...(!event.conversation.archived || includeArchivedRef.current || event.conversation.id === activeRef.current ? [event.conversation] : [])] }));
      else if (event.type === 'activity') setBoot(current => current && ({ ...current, activity: withActivity(current.activity, event.conversationId, event.activity) }));
      else if (event.type === 'agent') setBoot(current => current && ({ ...current, agents: [...current.agents.filter(a => a.id !== event.agent.id), event.agent], people: [...current.people.filter(p => p.id !== event.agent.id), event.agent] }));
      else if (event.type === 'todo') setTodos(current => current && byPosition([...current.filter(t => t.id !== event.todo.id), event.todo]));
      else if (event.type === 'layout') setBoot(current => current && ({ ...current, layout: event.layout }));
      else if (event.type === 'goal') {
        setGoals(current => [...current.filter(g => g.id !== event.goal.id), summary(event.goal)]);
        setFullGoals(current => current && [...current.filter(g => g.id !== event.goal.id), event.goal]);
      }
    };
    const stop = connectEvents(() => eventsPath(activeRef.current), {
      onOpen: () => setConnected(true),
      onError: () => { setConnected(false); setLive(false); fresh.current.clear(); },
      onEvent: raw => {
        try { receive(raw); }
        catch (e) {
          const recovery = recoverApp(`stream event ${raw.type}: ${errorText(e)}`);
          if (recovery.kind === 'exhausted') setError({ kind: 'failed', text: `This version of Kenan can't read the server's ${raw.type} update (${errorText(e)}). Reload to get the newest version.` });
        }
      },
    }, session === 0 ? adoptEarlyStream() : null);
    stopStream.current = stop;
    return () => { stop(); if (stopStream.current === stop) stopStream.current = null; };
  }, [session]);
  const activeHistory = active ? history[active] : undefined;
  const messages = activeHistory?.messages;
  const conversation = boot?.conversations.find(c => c.id === active);
  const draft = active ? drafts[active] ?? '' : '';
  const files = active ? attachments[active] ?? [] : [];
  useLayoutEffect(() => {
    const input = composerInput.current; if (!input) return;
    const resize = () => { input.style.height = 'auto'; input.style.height = `${input.scrollHeight}px`; };
    resize(); const observer = new ResizeObserver(() => { if (input.clientWidth !== width) { width = input.clientWidth; resize(); } });
    let width = input.clientWidth; observer.observe(input); return () => observer.disconnect();
  }, [draft, active, page, ready, boot?.me.id]);
  useEffect(() => {
    if (!messages || page !== 'chat' || document.visibilityState !== 'visible') return;
    for (const message of messages) {
      if (message.role !== 'assistant' || !message.text || observedText.current.has(message.id) || message.state !== 'streaming') continue;
      observedText.current.add(message.id);
      requestAnimationFrame(() => requestAnimationFrame(() => { void api('/metrics/first-text', 'POST', { messageId: message.id, firstTextAt: Date.now() }).catch(() => {}); }));
    }
  }, [messages, page]);
  useEffect(() => {
    if (active && conversation && page === 'chat' && conversation.readThrough < conversation.lastSeq) {
      void api<ConversationSummary>(`/conversations/${active}`, 'PATCH', { readThrough: conversation.lastSeq }).then(updated => setBoot(current => current && ({ ...current, conversations: current.conversations.map(c => c.id === updated.id ? { ...c, readThrough: updated.readThrough } : c) }))).catch(() => {});
    }
  }, [active, conversation?.lastSeq, page]);
  useEffect(() => {
    if (!boot || (page !== 'goals' && page !== 'usage')) return;
    const refresh = () => {
      if (page === 'goals') void api<Goal[]>('/goals').then(setFullGoals).catch(e => showError(e));
      else void Promise.all([api<UsageReport>('/usage'), api<LatencyReport>('/metrics')]).then(([u, m]) => { setUsage(u); setMetrics(m); }).catch(e => showError(e));
    };
    refresh(); const timer = setInterval(refresh, 30_000); return () => clearInterval(timer);
  }, [boot?.me.id, page]);
  async function archiveVisibility(include: boolean) {
    setIncludeArchived(include); includeArchivedRef.current = include; setArchiveLoading(true);
    try { const value = await api<Bootstrap>(`/bootstrap${include ? '?includeArchived=1' : ''}`); if (includeArchivedRef.current === include) acceptBootstrap(value); }
    catch (e) { showError(e); } finally { if (includeArchivedRef.current === include) setArchiveLoading(false); }
  }
  const organizedOn = !!boot?.extensions.some(e => e.id === 'organized');
  /** Classic with Organized enabled: on a phone, Back from any page returns to the conversation list first. */
  const classicBack = organizedOn && boot?.layout === 'classic' && narrow;
  useOverlay(sidebar && !classicBack, () => setSidebar(false));
  useOverlay(classicBack && !sidebar, () => setSidebar(true));
  useEffect(() => { if (organizedOn && !organizedModule) void import('./organized/Organized.js').then(setOrganizedModule, e => setError({ kind: 'failed', text: `Could not load the Organized layout: ${errorText(e)}` })); }, [organizedOn]);
  const layoutSeen = useRef<Layout | null>(null);
  useEffect(() => {
    const layout = boot?.layout ?? null, first = layoutSeen.current === null;
    if (!layout || layout === layoutSeen.current) return;
    layoutSeen.current = layout;
    if (layout === 'organized' && organizedOn && !(first && linkedConversation())) setPage('home');
    else if (layout === 'classic') setPage(current => isList(current) && current !== 'todo' ? 'chat' : current);
  }, [boot?.layout, organizedOn]);
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
    e.preventDefault(); if (!active || sending || uploading || (!draft.trim() && !files.length)) return;
    const id = active, reply = replies[id] ?? null, text = withReply(draft, reply), ownIds = files.map(f => f.id), fileIds = [...new Set([...ownIds, ...(reply?.files.map(f => f.id) ?? [])])];
    const old = pendingSend.current;
    const pending = old && old.conversationId === id && old.text === text && old.files.join() === fileIds.join() ? old : { conversationId: id, text, files: fileIds, clientId: crypto.randomUUID(), draft, ownIds, queued: false };
    pendingSend.current = pending; setError(null); nearBottom.current = true;
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
      if (isUnreachable(e) && pendingSend.current === pending) { pending.queued = true; setError({ kind: 'unreachable', text: 'Not sent yet: Kenan can\'t be reached right now. Your message sends by itself when it reconnects.' }); }
      else showError(e);
    } finally { setSending(false); }
  }
  async function upload(selected: FileList | null) {
    if (!active || !selected?.length) return;
    const id = active; setUploading(true); setError(null);
    try { for (const file of Array.from(selected)) { const form = new FormData(); form.append('file', file); const result = await api<FileInfo>('/files', 'POST', form); setAttachments(all => ({ ...all, [id]: [...all[id] ?? [], result] })); } }
    catch (e) { showError(e); } finally { setUploading(false); }
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
  /** The Organized extension's data: the to-do list and the next ✈️ trip for Home's footer line. */
  async function loadOrganized(value: Bootstrap) {
    try { setTodos(byPosition(await api<Todo[]>('/ext/organized/todos'))); } catch (e) { showError(e); }
    if (!value.extensions.some(e => e.id === 'calendar')) return;
    const from = new Date().toISOString(), to = new Date(Date.now() + 120 * 86_400_000).toISOString();
    try { setNextTrip(nextTripOf(await api<{ title: string; start: string }[]>(`/ext/calendar/?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`))); }
    catch (e) { showError(e); }
  }
  const todoActions: TodoActions = {
    async add(text, level, conversationId = null) { try { const t = await api<Todo>('/ext/organized/todos', 'POST', { text, level, conversationId }); setTodos(c => c && byPosition([...c.filter(x => x.id !== t.id), t])); } catch (e) { showError(e); } },
    async change(id, patch) {
      setTodos(c => c && c.map(t => t.id !== id ? t : { ...t, ...(patch.text !== undefined ? { text: patch.text } : {}), ...(patch.level ? { level: patch.level } : {}), ...(patch.done !== undefined ? { doneAt: patch.done ? Date.now() : null } : {}), ...(patch.deleted !== undefined ? { deletedAt: patch.deleted ? Date.now() : null } : {}) }));
      try { const t = await api<Todo>(`/ext/organized/todos/${encodeURIComponent(id)}`, 'PATCH', patch); setTodos(c => c && byPosition([...c.filter(x => x.id !== t.id), t])); } catch (e) { showError(e); }
    },
  };
  async function chooseLayout(layout: Layout) {
    try { const value = await api<Layout>('/layout', 'PUT', { layout }); setBoot(current => current && ({ ...current, layout: value })); setPage(value === 'organized' ? 'home' : 'chat'); }
    catch (e) { showError(e); }
  }
  async function updateTopic(id: string, patch: ConversationPatch): Promise<ConversationSummary | null> {
    try {
      const value = await api<ConversationSummary>(`/conversations/${encodeURIComponent(id)}`, 'PATCH', patch);
      setBoot(current => current && ({ ...current, conversations: [...current.conversations.filter(c => c.id !== value.id), value] }));
      return value;
    } catch (e) { showError(e); return null; }
  }
  if (!ready) return <main className="login"><p>Opening Kenan…</p></main>;
  if (!boot) return <main className="login"><form onSubmit={login}><h1>Kenan</h1><label>Account<select value={account} onChange={e => setAccount(e.target.value)}>{accounts.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label><label>Password<input autoComplete="current-password" type="password" value={secret} onChange={e => setSecret(e.target.value)} required autoFocus /></label>{error && <p role="alert">{error.text}</p>}<button type="submit" disabled={!account}>Sign in</button></form></main>;
  const tree = agentTree(boot.agents, includeArchived);
  const personName = (id: string) => boot.people.find(p => p.id === id)?.name ?? id;
  const signOut = () => { void api('/logout', 'POST', {}).then(() => { clearSnapshot(localStorage); location.reload(); }).catch(e => showError(e)); };
  const choose = (id: string) => { setActive(id); setPage('chat'); setSidebar(false); setError(null); };
  const updates = <>
    {webUpdate.shown && <div className="update-banner" role="status"><span>A new version of {appName(boot.channel)} is ready.</span><button className="primary" onClick={webUpdate.reload}>Reload</button><button aria-label="Dismiss" onClick={webUpdate.dismiss}>×</button></div>}
    {push.banner && <div className="update-banner" role={push.state.kind === 'failed' ? 'alert' : 'status'}><span>{push.state.kind === 'failed' ? `Notifications on this device failed: ${push.state.message}` : 'Get notifications from your agents on this device.'}</span><button className="primary" onClick={push.enable}>Turn on</button><button aria-label="Dismiss" onClick={push.dismiss}>×</button></div>}
    {!appUpdate.bannerHidden && <UpdateBanner channel={boot.channel} update={appUpdate.update} install={() => void appUpdate.install()} dismiss={appUpdate.dismiss}/>}
    {error && <div className={error.kind === 'unreachable' ? 'error unreachable' : 'error'} role="alert">{error.text}<button aria-label="Dismiss error" onClick={() => setError(null)}>×</button></div>}
  </>;
  const banners = <>
    <ManagerBanner home={boot.manager}/>
    {page === 'chat' && conversation?.archived && <div className="archive-banner"><span>This conversation is archived.</span><button onClick={() => void changeArchive(false)}>Restore to message</button></div>}
    {updates}
  </>;
  const sharedBanners = <>
    <ManagerBanner home={boot.manager}/>
    {updates}
  </>;
  const viewOf = (pg: Page) => pg === 'calendar' ? <Calendar/> : pg === 'todo' ? organizedModule ? <organizedModule.ClassicTodo todos={todos} todo={todoActions}/> : <p className="panel">Loading…</p> : pg === 'chat' ? <><Transcript key={active ?? ''} foldWork={foldWork} conversation={conversation} activity={active ? boot.activity[active] ?? null : null} history={activeHistory} loading={loading === active} paging={paging} people={boot.people} follow={nearBottom} older={loadOlder} newer={loadNewer} latest={jumpToLatest} expand={expandMessage} reply={replyTo}/>
        {active && !conversation?.archived && <form className="composer" onSubmit={send}>{replies[active] && <div className="replying"><span>↩ {replyLabel(replies[active]!)}</span><button type="button" aria-label="Cancel reply" onClick={() => setReplies(all => ({ ...all, [active]: null }))}>×</button></div>}<div className="attachments">{files.map(file => <span key={file.id}>{file.name}<button type="button" aria-label={`Remove ${file.name}`} onClick={() => setAttachments(all => ({ ...all, [active]: files.filter(f => f.id !== file.id) }))}>×</button></span>)}</div><textarea ref={composerInput} aria-label="Message" aria-describedby="composer-help" placeholder="Message…" value={draft} onChange={e => setDrafts(all => ({ ...all, [active]: e.target.value }))} enterKeyHint={enterAction === 'send' ? 'send' : 'enter'} onKeyDown={e => { if (enterAction === 'send' && e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); e.currentTarget.form?.requestSubmit(); } }} rows={1}/><div className="composer-controls"><Attachments uploading={uploading} upload={upload}/><span/>{boot.activity[active] && <button type="button" onClick={() => void api(`/conversations/${active}/stop`, 'POST', {}).catch(e => showError(e))}>Stop</button>}<button className="send" type="submit" disabled={sending || uploading || (!draft.trim() && !files.length)}>{sending ? 'Sending…' : 'Send ↑'}</button></div><small id="composer-help" className="composer-help">Enter to send · Shift + Enter for a new line</small></form>}</> : pg === 'goals' ? <div className="panel"><h2>Goals</h2>{!fullGoals && <p>Loading…</p>}{fullGoals && !fullGoals.length && <p>No goals yet. Ask Kenaznia to create one.</p>}{[...fullGoals ?? []].sort((a,b) => a.priority-b.priority).map(g => <section key={g.id}><h3>{g.title} <small>{g.status}</small></h3><MessageMarkdown source="agent" text={g.detail}/>{g.notes && <MessageMarkdown source="agent" text={g.notes}/>}<small>{g.workerIds.map(personName).join(', ')}</small></section>)}<h2>{includeArchived ? 'All agents' : 'Active agents'}</h2><label className="archive-filter"><input type="checkbox" checked={includeArchived} onChange={e => void archiveVisibility(e.target.checked)}/>Include archived</label>{boot.agents.filter(agent => includeArchived || !agent.archived).map(agent => <section key={agent.id}><button onClick={() => choose(agent.conversationId)}>{agent.name}</button><p>{agent.role} · {agent.state} · {agent.model}</p>{agent.lastReport && <MessageMarkdown source="agent" text={agent.lastReport.text}/>}</section>)}</div> : <div className="panel"><h2>Subscription usage</h2>{!usage && <p>Loading…</p>}{usage?.plans.map((plan, i) => <section key={i}><h3>{metricName(plan.metric)} · {plan.provider}</h3><p className="usage-summary">{planSummary(plan, Date.now(), t => new Date(t).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }))}</p>{plan.percentLeft !== null && <progress value={plan.percentLeft} max="100"/>}<p>{plan.projection.state === 'stale' ? `Drain unknown: no fresh reading since ${date(plan.projection.latestReadingAt)}` : plan.projection.state === 'unmeasured' ? 'Drain not measured yet' : `Pool drain: ${plan.projection.drainPercentPerHour.toFixed(1)}% per hour · Every account out: ${date(plan.projection.exhaustionAt)}${plan.projection.unknownDrain.length ? ` · uncertain, no current drain for ${plan.projection.unknownDrain.join(', ')}` : ''}`}</p><table><thead><tr><th>Account</th><th>Left</th><th>Drain</th><th>Runs out</th><th>Resets</th></tr></thead><tbody>{plan.accounts.map(account => <tr key={account.accountId}><th>{account.accountId}</th><td>{account.percentLeft === null ? '—' : `${Math.round(account.percentLeft)}%`}</td><td>{account.drain.state === 'measured' ? `${account.drain.percentPerHour.toFixed(1)}%/h` : account.drain.state === 'stale' ? `stale since ${date(account.drain.readingAt)}` : '—'}</td><td>{date(account.projectedExhaustionAt)}</td><td>{date(account.resetAt)}</td></tr>)}</tbody></table></section>)}{usage && !usage.plans.length && <p>No subscription usage reported yet.</p>}<h2>Latency</h2>{metrics && <><p>{metrics.count} messages in the last {Math.round(metrics.windowMs / 3600000)} hours</p><table><thead><tr><th>Interval</th><th>p50</th><th>p90</th><th>p99</th></tr></thead><tbody>{Object.entries(metrics.intervals).map(([name, values]) => <tr key={name}><th>{name}</th>{[values.p50, values.p90, values.p99].map((v, i) => <td key={i}>{v === null ? '—' : `${Math.round(v)} ms`}</td>)}</tr>)}</tbody></table></>}</div>;
  const roomModal = roomEditor && <div className="modal-backdrop"><form ref={roomDialog} className="modal" role="dialog" aria-modal="true" aria-labelledby="room-title" onSubmit={saveRoom}><h2 id="room-title">New room</h2><label>Title<input value={roomTitle} onChange={e => setRoomTitle(e.target.value)} required autoFocus/></label><fieldset><legend>Members</legend>{boot.people.filter(p => p.id !== boot.me.id).map(person => <label className="checkbox" key={person.id}><input type="checkbox" checked={members.includes(person.id)} onChange={e => setMembers(current => e.target.checked ? [...current, person.id] : current.filter(id => id !== person.id))}/>{person.name}</label>)}</fieldset><div className="actions"><button type="button" onClick={() => setRoomEditor(false)}>Cancel</button><button type="submit">Create room</button></div></form></div>;
  if (organizedOn && boot.layout === 'organized') return !organizedModule ? <main className="login"><p>Opening Kenan…</p></main> : <>
    <organizedModule.Organized boot={boot} goals={goals} todos={todos} todo={todoActions} screen={page} go={next => { setPage(next); setError(null); }} active={active} open={choose}
      detail={viewOf} openProject={id => { setActive(id); setPage('project'); setError(null); }} banners={sharedBanners} push={<PushButton state={push.state} enable={push.enable} disable={push.disable}/>} wide={wide} connected={connected && live}
      setLayout={layout => void chooseLayout(layout)} foldWork={foldWork} toggleFoldWork={() => { saveFoldWork(!foldWork); setFoldWork(!foldWork); }}
      checkUpdate={appUpdate.update.state !== 'web' ? () => void appUpdate.check() : null} signOut={signOut}
      weeklyLeft={usage?.plans.find(plan => plan.metric === 'weekly')?.percentLeft ?? null} refreshUsage={() => void api<UsageReport>('/usage').then(setUsage).catch(e => showError(e))}
      newChat={() => { setRoomTitle(''); setMembers([]); setRoomEditor(true); }} update={updateTopic}
      showClosed={include => { if (include !== includeArchivedRef.current) void archiveVisibility(include); }} closedLoaded={includeArchived && !archiveLoading} nextTrip={nextTrip}/>
    {roomModal}
  </>;
  return <div className="app">
    {sidebar && <button className="nav-scrim" aria-label="Close navigation" onClick={() => setSidebar(false)}/>}
    <aside className={sidebar ? 'sidebar open' : 'sidebar'}><header><strong>{boot.channel === 'beta' ? 'Kenan Beta' : 'Kenan'}</strong><button className="mobile" onClick={() => setSidebar(false)} aria-label="Close navigation">×</button></header>
      <button onClick={() => { setRoomTitle(''); setMembers([]); setRoomEditor(true); }}>＋ New room</button>
      <nav aria-label="Conversations">
        <div className="nav-heading"><h2>{includeArchived ? 'All agents' : 'Agents'}</h2><span>{boot.agents.filter(a => !a.archived).length} active · {boot.agents.filter(a => !a.archived && a.state === 'running').length} running{waitingCount(boot.agents) ? <b className="waiting-count"> · ⚠ {waitingCount(boot.agents)} waiting</b> : null}</span></div>
        {archiveLoading && <p className="sidebar-empty" role="status">Loading agents…</p>}
        <AgentTree agents={boot.agents} nodes={tree} goals={goals} conversations={boot.conversations} activity={boot.activity} active={page === 'chat' ? active : null} choose={choose}/>
        {conversation && !agentTreeContains(tree, active) && conversation.agentId && <div className="current-chat"><h2>Current conversation</h2><button className="selected" aria-current={page === 'chat' ? 'page' : undefined} onClick={() => choose(conversation.id)}><span>{conversation.title}</span><small>{conversation.archived ? 'Archived' : 'Ready for a message'}</small></button></div>}
        <div className="nav-heading"><h2>Rooms</h2></div>
        {[...boot.conversations].filter(c => !c.agentId && (includeArchived || !c.archived)).sort((a, b) => b.updatedAt - a.updatedAt).map(c => <button key={c.id} className={page === 'chat' && c.id === active ? 'selected' : ''} aria-current={page === 'chat' && c.id === active ? 'page' : undefined} onClick={() => choose(c.id)}><span>{c.title || 'Conversation'} {unread(c) && c.id !== active && <b aria-label="Unread">●</b>}</span><small>{c.archived ? 'Archived' : boot.activity[c.id] ? activityText(boot.activity[c.id]!) : c.lastMessage?.preview || 'No messages yet'}</small></button>)}
        <button type="button" className="archive-toggle" aria-pressed={includeArchived} onClick={() => void archiveVisibility(!includeArchived)}>{includeArchived ? 'Hide archived agents and rooms' : 'Show archived agents and rooms'}</button>
      </nav>
      <footer>{boot.extensions.some(e => e.id === 'calendar') && <button onClick={() => { setPage('calendar'); setSidebar(false); }}>Calendar</button>}<button onClick={() => { setPage('goals'); setSidebar(false); }}>Goals & workers</button><button onClick={() => { setPage('usage'); setSidebar(false); }}>Usage & latency</button><button onClick={() => { saveFoldWork(!foldWork); setFoldWork(!foldWork); }}>Work steps: {foldWork ? 'Folded' : 'Shown'}</button>{organizedOn && <button onClick={() => { setPage('todo'); setSidebar(false); }}>To-do</button>}{organizedOn && <div className="layout-line" role="radiogroup" aria-label="Layout"><span>Layout</span><button role="radio" aria-checked="true">Classic</button><button role="radio" aria-checked="false" onClick={() => void chooseLayout('organized')}>Organized</button></div>}<PushButton state={push.state} enable={push.enable} disable={push.disable}/>{appUpdate.update.state !== 'web' && <button onClick={() => { setSidebar(false); void appUpdate.check(); }}>Check for app update</button>}<div className="identity"><span>{boot.me.name}</span><button onClick={signOut}>Sign out</button></div></footer>
    </aside>
    <main className="main"><header className="topbar"><button className="mobile" aria-label="Open navigation" onClick={() => setSidebar(true)}>☰</button><h1>{page === 'chat' ? conversation?.title || 'Conversations' : page === 'goals' ? 'Goals & workers' : page === 'calendar' ? 'Calendar' : page === 'todo' ? 'To-do' : 'Usage & latency'}</h1><span className={connected ? 'connection online' : 'connection'} title={connected && live ? 'Live' : 'Connecting'}>{connected && live ? '●' : live || !ready ? 'Reconnecting…' : 'Connecting…'}</span>{page === 'chat' && conversation && <details className="menu" open={settings} onToggle={e => setSettings(e.currentTarget.open)}><summary ref={settingsSummary} aria-label="Conversation settings">•••</summary><div><button onClick={() => { const title = prompt('Conversation title', conversation.title); if (title?.trim()) void updateRoom({ title }); }}>Rename</button><button onClick={() => void changeArchive(!conversation.archived)}>{conversation.archived ? 'Restore conversation' : 'Archive conversation'}</button><strong>Members</strong>{conversation.memberIds.map(id => <div key={id}>{personName(id)}{id !== boot.me.id && <button aria-label={`Remove ${personName(id)}`} onClick={() => void updateRoom({ removeMemberIds: [id] })}>×</button>}</div>)}<select aria-label="Add member" value="" onChange={e => { if (e.target.value) void updateRoom({ addMemberIds: [e.target.value] }); }}><option value="">Add member…</option>{boot.people.filter(p => !conversation.memberIds.includes(p.id)).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></div></details>}</header>
      {banners}
      {viewOf(page)}
    </main>
    {roomModal}
  </div>;
}

function ManagerBanner({ home }: { home: ManagerHome }) {
  switch (home.kind) {
    case 'here': return null;
    case 'elsewhere': return <div className="update-banner" role="status"><span>Your Kenaznia answers in the other Kenan app.</span><a className="primary" href={home.url}>Open it</a></div>;
    case 'none': return <div className="update-banner" role="status"><span>No Kenaznia is set up for you yet. Ask whoever runs this server to add one.</span></div>;
  }
}
const appName = (channel: string) => channel === 'beta' ? 'Kenan Beta' : 'Kenan';
/** Sidebar control for this device's Web Push; the Android app (no Push API) shows nothing. */
function PushButton({ state, enable, disable }: { state: PushState; enable: () => void; disable: () => void }) {
  switch (state.kind) {
    case 'unsupported': return null;
    case 'install-first': return <button onClick={() => alert('To get notifications on this iPhone: tap Share, then Add to Home Screen, open Kenan from the home screen, sign in, and tap Notifications here: Off.')}>Notifications: add to Home Screen first</button>;
    case 'denied': return <button onClick={() => alert('Notifications are blocked for Kenan. Allow them in Settings › Notifications › Kenan, then reopen the app.')}>Notifications here: blocked</button>;
    case 'off': return <button onClick={enable}>Notifications here: Off</button>;
    case 'working': return <button disabled>Notifications here: …</button>;
    case 'on': return <button onClick={disable}>Notifications here: On</button>;
    case 'failed': return <button title={state.message} onClick={enable}>Notifications here: failed, retry</button>;
  }
}

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
/** The next calendar event whose title starts with ✈️; its place is what follows the last " to " (or the rest of the title). */
export function nextTripOf(events: { title: string; start: string }[]): Trip | null {
  const trip = events.filter(e => e.title.trim().startsWith('✈️')).map(e => ({ at: Date.parse(e.start), title: e.title.trim().slice(2).trim() })).filter(e => Number.isFinite(e.at)).sort((a, b) => a.at - b.at)[0];
  if (!trip) return null;
  const to = trip.title.lastIndexOf(' to ');
  return { at: trip.at, place: to >= 0 ? trip.title.slice(to + 4).trim() : trip.title };
}
function useMedia(query: string) {
  const [wide, setWide] = useState(() => matchMedia(query).matches);
  useEffect(() => { const list = matchMedia(query), change = () => setWide(list.matches); list.addEventListener('change', change); return () => list.removeEventListener('change', change); }, []);
  return wide;
}
