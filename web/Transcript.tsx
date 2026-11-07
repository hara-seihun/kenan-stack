import { authorNames, kenazniaTint } from '../shared/kenaznia-label.js';
import './sharedChat.css';
import type React from 'react';
import { lazy, memo, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState, type MutableRefObject, type ReactNode } from 'react';
import { MessageMarkdown } from './MessageMarkdown.js';
import { messageParts } from '../shared/message-parts.js';
import { backgroundSource, type Activity, type ConversationSummary, type Message, type Person, type Waiting } from '../shared/contract.js';
import { backgroundLabel, transcriptRows, toolMessage, workLabel, type Row } from './transcriptRows.js';
import { activityText } from './activity.js';
import { FilePart } from './FilePart.js';
import { SealCard } from './SealCard.js';
import { QuestionButtons } from './Question.js';
import { formatDate } from './dates.js';
import { ToolCall, toolTitle } from './ToolCall.js';
import { PAGE_SIZE, WINDOW_SIZE, type History } from './history.js';
import { canReply } from './reply.js';
import { SWIPE_REPLY_PX, swipeOffset, swipeReplies, swiping } from './swipe.js';
import { followBottom } from './stick.js';
import type { UpdateScroll } from './updateResume.js';
import { writeClipboard } from './clipboard.js';
import { Check, Copy, MessageCircle, Brain, MoreHorizontal } from 'lucide-react';
import { FoldCard } from './FoldCard.js';
import { MessageActions } from './MessageActions.js';
import { useRoomPress } from './roomPress.js';
import { TranscriptSpace, useTranscriptWindow } from './TranscriptWindow.js';
import { transcriptGalleries } from './gallery.js';
import type { AgentInfo } from '../shared/contract.js';

/** Start fetching the next page when the viewport is this close to the window's edge. */
const EDGE_PX = 1500;

export type Paging = 'older' | 'newer' | null;

const sameMessage = (a: Message, b: Message) => a === b ||
  (a.id === b.id && a.updatedAt === b.updatedAt && a.editedAt === b.editedAt && a.deletedAt === b.deletedAt && a.state === b.state && a.clipped === b.clipped && a.parts.length === b.parts.length && a.text === b.text && a.backgroundSummary === b.backgroundSummary && a.parts.every((part, i) => part === b.parts[i]));

/** Thinking streams in open, showing its newest lines, until the answer starts or the message settles; then it folds to a "Thinking" line. */
function Thinking({ text, live }: { text: string; live: boolean }) {
  return live
    ? <div className="thinking-live"><small>Thinking…</small><div className="thinking-tail"><p className="plain-text">{text}</p></div></div>
    : <FoldCard category="Thinking" summary={text} icon={<Brain size={15} className="tool-icon"/>}><div className="fold-body"><p className="plain-text">{text}</p></div></FoldCard>;
}

/** Copies a message's text as written, Markdown included (Dave 2026-10-28: "a little button to easily copy a Kenaznia msg").
 * Shown on hover with a mouse, always on touch; the icon says how it went for a moment. */
export function CopyText({ text }: { text: string }) {
  const [outcome, setOutcome] = useState<'copied' | 'failed' | null>(null);
  useEffect(() => { if (!outcome) return; const t = setTimeout(() => setOutcome(null), 1600); return () => clearTimeout(t); }, [outcome]);
  return <button type="button" className="message-copy" aria-label={outcome === 'copied' ? 'Copied' : outcome === 'failed' ? 'Copy failed' : 'Copy message'}
    onClick={() => void writeClipboard(text).then(ok => setOutcome(ok ? 'copied' : 'failed'))}>{outcome === 'copied' ? <Check size={15}/> : outcome === 'failed' ? '!' : <Copy size={15}/>}</button>;
}

/** A hydrated tool retains the result row's state and expansion target. */
function MessageTool({ part, message, expand }: { part: Extract<Message['parts'][number], { type: 'tool' }>; message: Message; expand: (id: string) => void }) {
  const source = toolMessage(part, message);
  return <ToolCall part={part} messageState={source.state} clipped={!!source.clipped} onOpen={source.clipped ? () => expand(source.id) : undefined}/>;
}

const MessageRow = memo(function MessageRow({ message, author, mine = false, tint, continued = false, expand, reply, changed }: { message: Message; author: string; mine?: boolean; /** The reader's colour for this author in this chat (shared/colors.ts MEMBER_COLORS). */ tint?: string; continued?: boolean; expand: (id: string) => void; reply?: (m: Message, author: string) => void; changed?: (m: Message) => void }) {
  const parts = messageParts(message).map((part, i) => message.role === 'notice' && message.notice === 'agent_message' && i === 0 && part.type === 'text'
    ? { ...part, text: part.text.replace(/^(?:Message from |Broadcast )[^\n]*\n/, '') } : part);
  const repliable = !!reply && !message.deletedAt && message.state !== 'streaming' && canReply(message);
  const editable = mine && message.role === 'human' && !message.deletedAt && !!changed;
  const [actions, setActions] = useState(false);
  const row = useRef<HTMLElement>(null);
  const touch = useRef<{ x: number; y: number; dx: number; dy: number; active: boolean } | null>(null);
  const hold = useRoomPress(editable, () => { window.getSelection()?.removeAllRanges(); setActions(true); });
  // Holding opens message actions; moving cancels the hold and keeps swipe-to-reply and vertical scrolling.
  /** Swipe right to reply, like Signal. */
  const move = (dx: number) => { const el = row.current; if (el) el.style.transform = dx ? `translateX(${swipeOffset(dx)}px)` : ''; el?.classList.toggle('swipe-ready', dx >= SWIPE_REPLY_PX); };
  const swipe = repliable ? {
    onTouchStart: (e: React.TouchEvent) => {
      const t = e.touches[0];
      const inside = (e.target as HTMLElement).closest('.table-scroll, pre, .image-viewer, .media-attachment');
      touch.current = e.touches.length === 1 && t && !inside ? { x: t.clientX, y: t.clientY, dx: 0, dy: 0, active: false } : null;
    },
    onTouchMove: (e: React.TouchEvent) => {
      const s = touch.current, t = e.touches[0]; if (!s || !t) return;
      s.dx = t.clientX - s.x; s.dy = t.clientY - s.y;
      if (!s.active && swiping(s.dx, s.dy) && !String(window.getSelection() ?? '')) s.active = true;
      if (s.active) move(s.dx);
    },
    onTouchEnd: () => { const s = touch.current; touch.current = null; if (!s?.active) return; move(0); if (swipeReplies(s.dx, s.dy)) reply!(message, author); },
    onTouchCancel: () => { touch.current = null; move(0); },
  } : {};
  return <><article ref={row} data-id={message.id} className={`message ${message.role}${mine ? ' mine' : ''}${editable ? ' message-editable' : ''}${continued ? ' continued' : ''}${tint ? ' tinted' : ''}`} style={tint ? { '--tint': tint } as React.CSSProperties : undefined} {...swipe} {...hold} onPointerDown={e => { hold.onPointerDown(e); if ((e.target as HTMLElement).closest('a, button, input, textarea, video, audio')) hold.onPointerCancel(); }}>
    {editable && <button type="button" className="message-actions-trigger" aria-label="Message actions" aria-haspopup="menu" aria-expanded={actions} onClick={() => setActions(true)}><MoreHorizontal size={18}/></button>}
    {repliable && <span className="swipe-icon" aria-hidden="true">↩</span>}
    {!continued && <div className="message-meta"><strong>{message.role === 'notice' && message.notice === 'agent_message' ? `From ${author}` : author}</strong><time dateTime={new Date(message.createdAt).toISOString()}>{formatDate(message.createdAt, { hour: '2-digit', minute: '2-digit' })}</time>{(message.state === 'error' || message.state === 'stopped') && <small>{message.state}</small>}{repliable && <button type="button" className="reply-hover" aria-label={`Reply to ${author}`} onClick={() => reply!(message, author)}>↩</button>}{message.role === 'assistant' && message.state !== 'streaming' && message.text.trim() && <CopyText text={message.text}/>}</div>}
    {continued && message.role === 'assistant' && message.state !== 'streaming' && message.text.trim() && <span className="continued-copy"><CopyText text={message.text}/></span>}
    <div className="message-body">
      {message.deletedAt ? <p className="message-deleted">message deleted</p> : <>{parts.map((part, i) => part.type === 'text' ? <MessageMarkdown key={i} source={message.role === 'human' ? 'human' : 'agent'} text={part.text}/> : part.type === 'tool' ? <MessageTool key={i} part={part} message={message} expand={expand}/> : part.type === 'thinking' ? <Thinking key={i} text={part.text} live={message.state === 'streaming' && i === parts.length - 1}/> : part.type === 'question' ? <Suspense key={i} fallback={null}><QuestionButtons todoId={part.todoId} options={part.options}/></Suspense> : part.type === 'seal' ? <SealCard key={i} part={part}/> : <FilePart key={i} part={part}/>)}{message.editedAt && <small className="message-edited">edited</small>}</>}
    </div>
  </article>{actions && editable && <MessageActions message={message} anchor={row} changed={changed!} close={() => setActions(false)}/>}</>;
}, (a, b) => a.author === b.author && a.mine === b.mine && a.tint === b.tint && a.continued === b.continued && a.expand === b.expand && a.reply === b.reply && a.changed === b.changed && sameMessage(a.message, b.message));

const BackgroundRow = memo(function BackgroundRow({ row, names, mine, tint, continued, expand, reply }: { row: Extract<Row, { kind: 'background' }>; names: Map<string, string>; mine: boolean; tint?: string; continued: boolean; expand: (id: string) => void; reply?: (m: Message, author: string) => void }) {
  const message = row.messages[0]!;
  return <article data-id={row.id} className="folded-row background-updates">
    {!continued && message.role !== 'notice' && <div className="message-meta"><strong>{names.get(message.authorId) ?? message.authorName ?? message.authorId}</strong><time dateTime={new Date(message.createdAt).toISOString()}>{formatDate(message.createdAt, { hour: '2-digit', minute: '2-digit' })}</time></div>}
    <FoldCard category={backgroundSource(message, names.get(message.authorId))} summary={backgroundLabel(row, names)} icon={<MessageCircle size={15} className="tool-icon"/>}>
      <div className="fold-body"><MessageRow message={message} author={names.get(message.authorId) ?? message.authorName ?? message.authorId} mine={mine} tint={tint} expand={expand} reply={reply}/></div>
    </FoldCard>
  </article>;
}, (a, b) => a.row.id === b.row.id && a.names === b.names && a.mine === b.mine && a.tint === b.tint && a.continued === b.continued && a.expand === b.expand && a.reply === b.reply && sameMessage(a.row.messages[0]!, b.row.messages[0]!));

const WorkRow = memo(function WorkRow({ row, author, continued, expand }: { row: Extract<Row, { kind: 'work' }>; author: string; continued: boolean; expand: (id: string) => void }) {
  const message = row.messages[0]!;
  const part = message.parts[0]!;
  return <article data-id={row.id} className="folded-row work-steps">
    {!continued && <div className="message-meta"><strong>{author}</strong><time dateTime={new Date(message.createdAt).toISOString()}>{formatDate(message.createdAt, { hour: '2-digit', minute: '2-digit' })}</time></div>}
    {part.type === 'tool' ? <MessageTool part={part} message={message} expand={expand}/>
      : part.type === 'thinking' ? <FoldCard category="Thinking" summary={workLabel(row, toolTitle)} icon={<Brain size={15} className="tool-icon"/>}><div className="fold-body"><p className="plain-text">{part.text}</p></div></FoldCard> : null}
  </article>;
}, (a, b) => a.row.id === b.row.id && a.author === b.author && a.continued === b.continued && a.expand === b.expand && sameMessage(a.row.messages[0]!, b.row.messages[0]!));

const BusyLine = lazy(() => import('./BusyLine.js'));

export const Transcript = memo(function Transcript({ target, restoreScroll, me, conversation, activity, waiting = null, conversations = [], history, loading, paging, people, agents = [], follow, older, newer, latest, expand, reply, changed, trailing }: {
  target?: { message: string; token: number } | null;
  restoreScroll?: MutableRefObject<UpdateScroll | null>;
  /** The signed-in person: their own messages are drawn as theirs (`mine`). */
  me: string;
  conversation: ConversationSummary | undefined; activity: Activity | null; history: History | undefined; loading: boolean; paging: Paging; people: Person[]; agents?: AgentInfo[];
  /** Her Kenaznia's queue, for the busy line under a message of hers that waits, and her chats to name where it is. */
  waiting?: Waiting | null; conversations?: ConversationSummary[];
  follow: MutableRefObject<boolean>; older: () => void; newer: () => void; latest: () => void; expand: (id: string) => void; reply?: (m: Message, author: string) => void;
  changed?: (m: Message) => void;
  /** Rows of hers still on their way (dictated clips being written down), after the last message. */
  trailing?: ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const programmaticTop = useRef<number | null>(null);
  const anchor = useRef<{ id: string; top: number }[]>([]);
  const opened = useRef(false);
  if (!opened.current) { opened.current = true; follow.current = true; }
  const [away, setAway] = useState(false);
  const stick = useMemo(() => followBottom(follow, following => setAway(!following)), [follow]);
  const messages = history?.messages;
  const visible = useMemo(() => transcriptRows((messages ?? []).map(m => target && (m.id === target.message || String(m.seq) === target.message) && m.display === 'silent' ? { ...m, display: 'shown' } : m)), [messages, target?.message]);
  // Background notices do not start a speaker run. All of an author's consecutive words and actions share one header.
  const runs = useMemo(() => {
    let author: string | undefined;
    return visible.map(row => {
      const message = row.kind === 'message' ? row.message : row.messages[0]!;
      const continued = message.role !== 'notice' && author === message.authorId;
      if (message.role !== 'notice') author = message.authorId;
      return { row, continued };
    });
  }, [visible]);
  const coloured = !!conversation && Object.keys(conversation.memberColors).length > 0;
  useEffect(() => { if (coloured) void import('./MemberColors.js'); }, [coloured]);
  const names = useMemo(() => new Map([...(messages ?? []).flatMap(m => {
    if (m.role !== 'notice' || m.notice !== 'agent_message') return [];
    const sender = m.text.match(/^(?:Message from |Broadcast [^\n]*? from )(?:worker )?(.+?) \(/)?.[1];
    return sender ? [[m.authorId, sender] as const] : [];
  }), ...agents.map(agent => [agent.id, agent.name] as const), ...authorNames(people, conversation?.memberIds)]), [messages, agents, people, conversation?.memberIds]);
  const shared = names.size > 0 && (conversation?.memberIds ?? []).filter(id => people.find(p => p.id === id)?.kind === 'human').length > 1;
  const busy = conversation && !activity && waiting?.queued[conversation.id] !== undefined ? waiting : null;

  /** Remember the first row in view so content added or removed above it doesn't move what she is reading. */
  function capture() {
    const el = box.current; if (!el) return;
    const rows = el.querySelectorAll<HTMLElement>(':scope > .transcript-row');
    let low = 0, high = rows.length - 1, found: HTMLElement | null = null;
    while (low <= high) {
      const mid = (low + high) >> 1, row = rows[mid]!;
      if (row.offsetTop + row.offsetHeight > el.scrollTop) { found = row; high = mid - 1; } else low = mid + 1;
    }
    // An older page can absorb an orphan tool result into its earlier declaration. Keep
    // nearby alternatives so removing that first row does not discard the reading position.
    const start = found ? [...rows].indexOf(found) : -1;
    const top = el.getBoundingClientRect().top;
    anchor.current = start < 0 ? [] : [...rows].slice(start, start + 16).map(row => ({ id: row.dataset.id!, top: row.getBoundingClientRect().top - top }));
  }
  function reachEdges() {
    const el = box.current; if (!el || paging || !history) return;
    const below = el.scrollHeight - el.scrollTop - el.clientHeight;
    // Folded work can put both edges within the prefetch distance. Prefer the edge she is
    // actually at, and never let prefetch evict the latest messages while following them.
    if (history.hasNewer && below < EDGE_PX && (follow.current || below <= el.scrollTop)) newer();
    else if (!follow.current && history.hasOlder && el.scrollTop < EDGE_PX &&
      (history.messages.length + PAGE_SIZE <= WINDOW_SIZE || (!follow.current && el.scrollTop < below))) older();
  }
  function settle() {
    const el = box.current; if (!el) return;
    const before = el.scrollTop;
    if (!follow.current) {
      for (const saved of anchor.current) {
        const row = el.querySelector<HTMLElement>(`:scope > .transcript-row[data-id="${saved.id}"]`);
        if (!row) continue;
        el.scrollTop += row.getBoundingClientRect().top - el.getBoundingClientRect().top - saved.top;
        break;
      }
    }
    const saved = restoreScroll?.current;
    if (saved?.following && restoreScroll) { follow.current = true; restoreScroll.current = null; }
    if (saved && !saved.following) {
      const row = [...el.querySelectorAll<HTMLElement>(':scope > [data-id]')].find(row => row.dataset.id === saved.id);
      if (row) {
        follow.current = saved.following;
        if (!saved.following) el.scrollTop += row.getBoundingClientRect().top - el.getBoundingClientRect().top - saved.top;
        restoreScroll.current = null;
      }
    }
    stick.settle(el);
    if (el.scrollTop !== before) programmaticTop.current = el.scrollTop;
    capture();
  }
  const spaceCache = useRef(new Map<string, { kind: Row['kind']; messages: Message[]; continued: boolean; space: { id: string; text: string; estimate: number } }>());
  const spaces = useMemo(() => {
    const next = runs.map(({ row, continued }) => {
      const messages = row.kind === 'message' ? [row.message] : row.messages;
      const m = messages[0]!, id = row.kind === 'message' ? m.id : row.id;
      const previous = spaceCache.current.get(id);
      if (previous && previous.kind === row.kind && previous.continued === continued && previous.messages.length === messages.length && messages.every((message, i) => sameMessage(previous.messages[i]!, message))) return previous.space;
      const text = messages.map(message => [...new Set([message.text, ...message.parts.flatMap(p => p.type === 'text' || p.type === 'thinking' ? [p.text] : p.type === 'tool' ? [p.name, JSON.stringify(p.args), p.result ?? ''] : p.type === 'file' ? [p.name] : [])])].filter(Boolean).join('\n')).join('\n');
      const space = { id, text, estimate: row.kind === 'message' ? 60 + (continued ? 0 : 28) + Math.ceil(m.text.length / 42) * 26 + m.parts.reduce((height, p) => height + (p.type === 'image' ? 300 : p.type === 'tool' || p.type === 'thinking' ? 48 : 0), 0) : (continued ? 48 : 76) };
      spaceCache.current.set(id, { kind: row.kind, messages, continued, space });
      return space;
    });
    const ids = new Set(next.map(row => row.id));
    for (const id of spaceCache.current.keys()) if (!ids.has(id)) spaceCache.current.delete(id);
    return next;
  }, [runs]);
  const rowContext = useMemo(() => ({}), [names, me, conversation?.memberColors, shared, expand, reply, changed]);
  const windowed = useTranscriptWindow(box, follow, settle);
  useLayoutEffect(() => {
    const el = box.current; if (!el) return;
    transcriptGalleries.set(el, visible.flatMap(row => {
      const messages = row.kind === 'message' ? [row.message] : row.messages;
      return messages.flatMap(m => m.parts.flatMap(p => p.type === 'image' ? [{ fileId: p.fileId, caption: m.text, rowId: row.kind === 'message' ? row.message.id : row.id }] : []));
    }));
    return () => { transcriptGalleries.delete(el); };
  }, [visible]);
  const reachedTarget = useRef<number | null>(null);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    if (!target) { el.querySelectorAll('.message-target').forEach(row => row.classList.remove('message-target')); reachedTarget.current = null; return; }
    if (reachedTarget.current === target.token) return;
    const message = messages?.find(m => m.id === target.message || String(m.seq) === target.message);
    if (!message) return;
    const calls = new Set(message.parts.flatMap(p => p.type === 'tool' ? [p.callId] : []));
    const row = visible.find(row => (row.kind === 'message' ? [row.message] : row.messages).some(m => m.id === message.id))
      ?? visible.find(row => (row.kind === 'message' ? [row.message] : row.messages).some(m => m.parts.some(p => p.type === 'tool' && calls.has(p.callId))));
    if (!row) return;
    const id = row.kind === 'message' ? row.message.id : row.id;
    const shell = [...el.querySelectorAll<HTMLElement>(':scope > .transcript-row')].find(row => row.dataset.id === id);
    if (!shell) return;
    reachedTarget.current = target.token;
    el.querySelectorAll('.message-target').forEach(row => row.classList.remove('message-target'));
    shell.classList.add('message-target');
    follow.current = false; setAway(true);
    windowed.reveal(shell);
    // Windowed rows mount on their own browser task. Open the enclosing fold when it mounts.
    const openFold = () => { const fold = shell.querySelector<HTMLDetailsElement>('details'); if (fold && !fold.open) fold.open = true; };
    const mounted = new MutationObserver(openFold);
    mounted.observe(shell, { childList: true, subtree: true }); openFold();
    el.scrollTop += shell.getBoundingClientRect().top - el.getBoundingClientRect().top - Math.min(el.clientHeight / 3, 160);
    programmaticTop.current = el.scrollTop; capture();
    return () => mounted.disconnect();
  }, [target?.token, visible, windowed]);
  function scrolled() {
    const el = box.current; if (!el || !history) return;
    if (programmaticTop.current === el.scrollTop) { programmaticTop.current = null; capture(); return; }
    programmaticTop.current = null;
    stick.scrolled(el, !history.hasNewer);
    capture(); reachEdges();
  }

  return <div className={`transcript${shared ? ' shared' : ''}`} ref={box} onScroll={scrolled} {...stick.input}>
    {!conversation && <p className="empty">Choose a conversation or create a room.</p>}
    {paging === 'older' && <p className="history-edge" role="status">Loading earlier messages…</p>}
    {history && !history.hasOlder && history.messages.length > 0 && <p className="history-edge" data-history-start>Beginning of conversation</p>}
    {loading && !visible.length && <p className="empty">Loading messages…</p>}
    {conversation && !loading && !visible.length && <p className="empty">Send a message to get started.</p>}
    {runs.map(({ row, continued }, index) => <TranscriptSpace key={spaces[index]!.id} row={spaces[index]!} windowed={windowed} context={rowContext} compact={runs[index + 1]?.row.kind !== 'message' && index + 1 < runs.length}>{() => row.kind === 'message' && row.message.notice === 'membership'
      ? <p key={row.message.id} className="membership-notice" data-id={row.message.id}>{row.message.text}</p> : row.kind === 'message'
      ? <MessageRow key={row.message.id} message={row.message} author={names.get(row.message.authorId) ?? row.message.authorId} mine={row.message.authorId === me} tint={conversation?.memberColors[row.message.authorId] ?? (shared ? kenazniaTint(row.message.authorId) : undefined)} continued={continued} expand={expand} reply={reply} changed={changed}/>
      : row.kind === 'work' ? <WorkRow key={row.id} row={row} author={names.get(row.messages[0]!.authorId) ?? row.messages[0]!.authorId} continued={continued} expand={expand}/>
      : <BackgroundRow key={row.id} row={row} names={names} continued={continued} mine={row.messages[0]!.authorId === me} tint={conversation?.memberColors[row.messages[0]!.authorId] ?? (shared ? kenazniaTint(row.messages[0]!.authorId) : undefined)} expand={expand} reply={reply}/>}</TranscriptSpace>)}
    {!history?.hasNewer && trailing}
    {paging === 'newer' && <p className="history-edge" role="status">Loading newer messages…</p>}
    {(history?.hasNewer || (away && conversation)) && <button type="button" className="latest" aria-label="Jump to latest" title="Jump to latest" onClick={() => { const el = box.current; if (history?.hasNewer) latest(); else if (el) stick.pin(el); }}>↓</button>}
    {conversation && activity && !history?.hasNewer && <p className="activity" role="status">{activityText(activity)}…</p>}
    {busy && !history?.hasNewer && <Suspense fallback={null}><BusyLine waiting={busy} conversationId={conversation!.id} conversations={conversations} follow={() => follow.current}/></Suspense>}
  </div>;
});
