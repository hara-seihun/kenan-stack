import type React from 'react';
import { memo, useLayoutEffect, useMemo, useRef, type MutableRefObject } from 'react';
import { MessageMarkdown } from './MessageMarkdown.js';
import type { Activity, ConversationSummary, Message, Person } from '../shared/contract.js';
import { backgroundLabel, transcriptRows, workLabel, type Row } from './transcriptRows.js';
import { activityText } from './activity.js';
import { FilePart } from './FilePart.js';
import { ToolCall, toolTitle } from './ToolCall.js';
import type { History } from './history.js';
import { canReply } from './reply.js';
import { SWIPE_REPLY_PX, swipeOffset, swipeReplies, swiping } from './swipe.js';

/** Start fetching the next page when the viewport is this close to the window's edge. */
const EDGE_PX = 1500;
const FOLLOW_PX = 160;

export type Paging = 'older' | 'newer' | null;

const sameMessage = (a: Message, b: Message) => a === b ||
  (a.id === b.id && a.updatedAt === b.updatedAt && a.state === b.state && a.clipped === b.clipped && a.parts.length === b.parts.length && a.text === b.text);

const MessageRow = memo(function MessageRow({ message, author, expand, reply }: { message: Message; author: string; expand: (id: string) => void; reply?: (m: Message, author: string) => void }) {
  /** Text and thinking always arrive whole; only tool calls are clipped, and an opened card loads its whole message. */
  const loadWhole = message.clipped ? () => expand(message.id) : undefined;
  const repliable = !!reply && message.state !== 'streaming' && canReply(message);
  const row = useRef<HTMLElement>(null);
  const touch = useRef<{ x: number; y: number; dx: number; dy: number; active: boolean } | null>(null);
  /** Swipe right to reply, like Signal. A long press is left to the browser, so it selects text normally (handles, Copy). */
  const move = (dx: number) => { const el = row.current; if (el) el.style.transform = dx ? `translateX(${swipeOffset(dx)}px)` : ''; el?.classList.toggle('swipe-ready', dx >= SWIPE_REPLY_PX); };
  const swipe = repliable ? {
    onTouchStart: (e: React.TouchEvent) => {
      const t = e.touches[0];
      const inside = (e.target as HTMLElement).closest('.table-scroll, pre, .image-viewer');
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
  return <article ref={row} data-id={message.id} className={`message ${message.role}`} {...swipe}>
    {repliable && <span className="swipe-icon" aria-hidden="true">↩</span>}
    <div className="message-meta"><strong>{author}</strong><time dateTime={new Date(message.createdAt).toISOString()}>{new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>{(message.state === 'error' || message.state === 'stopped') && <small>{message.state}</small>}{repliable && <button type="button" className="reply-hover" aria-label={`Reply to ${author}`} onClick={() => reply!(message, author)}>↩</button>}</div>
    <div className="message-body">
      {message.role === 'human' ? <MessageMarkdown source="human" text={message.text}/> : message.role === 'tool' && message.parts.some(p => p.type === 'tool' && p.name === message.text) ? null : <MessageMarkdown source="agent" text={message.text}/>}
      {message.parts.map((part, i) => part.type === 'tool' ? <ToolCall key={i} part={part} messageState={message.state} onOpen={loadWhole}/> : part.type === 'thinking' ? <details key={i}><summary>Thinking</summary><p className="plain-text">{part.text}</p></details> : part.type === 'text' ? null : <FilePart key={i} part={part}/>)}
    </div>
  </article>;
}, (a, b) => a.author === b.author && a.expand === b.expand && a.reply === b.reply && sameMessage(a.message, b.message));

const BackgroundRow = memo(function BackgroundRow({ row, names, expand, reply }: { row: Extract<Row, { kind: 'background' }>; names: Map<string, string>; expand: (id: string) => void; reply?: (m: Message, author: string) => void }) {
  return <article data-id={row.id} className="background-updates">
    <details>
      <summary>{backgroundLabel(row)}</summary>
      {row.messages.map(message => <MessageRow key={message.id} message={message} author={names.get(message.authorId) ?? message.authorId} expand={expand} reply={reply}/>)}
    </details>
  </article>;
}, (a, b) => a.row.id === b.row.id && a.names === b.names && a.expand === b.expand && a.reply === b.reply && a.row.updates === b.row.updates && a.row.messages.length === b.row.messages.length && a.row.messages.every((m, i) => sameMessage(m, b.row.messages[i]!)));

const WorkRow = memo(function WorkRow({ row, names, expand, reply }: { row: Extract<Row, { kind: 'work' }>; names: Map<string, string>; expand: (id: string) => void; reply?: (m: Message, author: string) => void }) {
  return <article data-id={row.id} className="work-steps">
    <details>
      <summary>{workLabel(row, toolTitle)}</summary>
      {row.messages.map(message => <MessageRow key={message.id} message={message} author={names.get(message.authorId) ?? message.authorId} expand={expand} reply={reply}/>)}
    </details>
  </article>;
}, (a, b) => a.row.id === b.row.id && a.names === b.names && a.expand === b.expand && a.reply === b.reply && a.row.messages.length === b.row.messages.length && a.row.messages.every((m, i) => sameMessage(m, b.row.messages[i]!)));

export const Transcript = memo(function Transcript({ conversation, activity, history, loading, paging, people, follow, older, newer, latest, expand, reply, foldWork = false }: {
  conversation: ConversationSummary | undefined; activity: Activity | null; history: History | undefined; loading: boolean; paging: Paging; people: Person[];
  follow: MutableRefObject<boolean>; older: () => void; newer: () => void; latest: () => void; expand: (id: string) => void; reply?: (m: Message, author: string) => void; foldWork?: boolean;
}) {
  const box = useRef<HTMLDivElement>(null);
  const anchor = useRef<{ id: string; top: number } | null>(null);
  const opened = useRef(false);
  if (!opened.current) { opened.current = true; follow.current = true; }
  const messages = history?.messages;
  const visible = useMemo(() => transcriptRows(messages ?? [], { foldWork }), [messages, foldWork]);
  const names = useMemo(() => new Map(people.map(p => [p.id, p.name])), [people]);

  /** Remember the first row in view so content added or removed above it doesn't move what she is reading. */
  function capture() {
    const el = box.current; if (!el) return;
    const rows = el.querySelectorAll<HTMLElement>(':scope > article');
    let low = 0, high = rows.length - 1, found: HTMLElement | null = null;
    while (low <= high) {
      const mid = (low + high) >> 1, row = rows[mid]!;
      if (row.offsetTop + row.offsetHeight > el.scrollTop) { found = row; high = mid - 1; } else low = mid + 1;
    }
    anchor.current = found ? { id: found.dataset.id!, top: found.offsetTop - el.scrollTop } : null;
  }
  function reachEdges() {
    const el = box.current; if (!el || paging || !history) return;
    if (history.hasOlder && el.scrollTop < EDGE_PX) older();
    else if (history.hasNewer && el.scrollHeight - el.scrollTop - el.clientHeight < EDGE_PX) newer();
  }
  useLayoutEffect(() => {
    const el = box.current; if (!el) return;
    if (follow.current) el.scrollTop = el.scrollHeight;
    else if (anchor.current) {
      const row = el.querySelector<HTMLElement>(`:scope > article[data-id="${anchor.current.id}"]`);
      const shift = row ? row.offsetTop - el.scrollTop - anchor.current.top : 0;
      if (shift) el.scrollTop += shift;
    }
    capture(); reachEdges();
  }, [visible, activity?.state, paging]);
  function scrolled() {
    const el = box.current; if (!el || !history) return;
    follow.current = !history.hasNewer && el.scrollHeight - el.scrollTop - el.clientHeight < FOLLOW_PX;
    capture(); reachEdges();
  }

  return <div className="transcript" ref={box} onScroll={scrolled}>
    {!conversation && <p className="empty">Choose a conversation or create a room.</p>}
    {paging === 'older' && <p className="history-edge" role="status">Loading earlier messages…</p>}
    {history && !history.hasOlder && history.messages.length > 0 && <p className="history-edge" data-history-start>Beginning of conversation</p>}
    {loading && !visible.length && <p className="empty">Loading messages…</p>}
    {conversation && !loading && !visible.length && <p className="empty">Send a message to get started.</p>}
    {visible.map(row => row.kind === 'message'
      ? <MessageRow key={row.message.id} message={row.message} author={names.get(row.message.authorId) ?? row.message.authorId} expand={expand} reply={reply}/>
      : row.kind === 'work' ? <WorkRow key={row.id} row={row} names={names} expand={expand} reply={reply}/>
      : <BackgroundRow key={row.id} row={row} names={names} expand={expand} reply={reply}/>)}
    {paging === 'newer' && <p className="history-edge" role="status">Loading newer messages…</p>}
    {history?.hasNewer && <button type="button" className="latest" onClick={latest}>Jump to latest ↓</button>}
    {conversation && activity && !history?.hasNewer && <p className="activity" role="status">{activityText(activity)}…</p>}
  </div>;
});
