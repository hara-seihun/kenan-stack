// Organized calendar: Day / Week / Month (mockups design/final/cal-*), working like a phone calendar app. Kenan adds the
// events (Alice, 2026-11-06: no add button); tap one for its details with Edit and Delete (undoable). Swipe or ‹ ›
// to move; pinch (or Ctrl+wheel; − + on a desktop) zooms the hour scale. The view and zoom are remembered per device.
// In Day and Week, long-press an event (or drag it with a mouse) to move it, or its bottom edge to resize it: 15-minute
// snaps, across days in Week, saved with Undo. Weeks start on Monday. Dated to-dos show on their day in the all-day strip
// (and in month cells) as ☐ chips: tick one done (with Undo), tap its text to open its chat. Events that are over (their
// end has passed) are hidden, each occurrence of a series on its own; a small Past button shows them again.
import type { Todo } from '../../../shared/contract.js';
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { swipeDirection } from '../../../web/gallery.js';
import { DateField, Sheet } from './sheets.js';
import { addDays, clampZoom, hourLabels, isOver, lanes, moved, overlapPlace, rangeOf, resized, startOfDay, weekText, type View } from '../../../web/extensions/calendarMath.js';
import { COOL, WARM } from '../../../shared/colors.js';
import { formatDate } from '../../../web/dates.js';

type Point = { clientX: number; clientY: number };
type Touches = { touches: { length: number; [i: number]: Point }; changedTouches: { length: number; [i: number]: Point } };
export interface CalEvent { id: string; title: string; start: string; end: string; allDay?: boolean; color?: string | null; location?: string; notes?: string; seriesId?: string }
export interface EventInput { title: string; start: string; end: string; allDay: boolean; zone: string; color: string | null; location: string; notes: string }
/** Where events live: the server's calendar extension, or the in-memory demo. */
export interface CalSource {
  list(from: Date, to: Date): Promise<CalEvent[]>;
  update(id: string, input: EventInput): Promise<unknown>;
  remove(id: string): Promise<unknown>;
  restore(id: string): Promise<unknown>;
}
const VIEW_KEY = 'kenan.calendarView', ZOOM_KEY = 'kenan.calendarHourPx', PAST_KEY = 'kenan.calendarShowPast';
const DAY = 86_400_000, GUTTER = 48, LONG_PRESS_MS = 400, HOUR_LABELS = hourLabels(new Intl.DateTimeFormat([], { hour: 'numeric' }));
const PALETTE = [...WARM, ...COOL];
export const SWATCHES = [WARM[0], WARM[1], WARM[2], WARM[3], COOL[0], COOL[2], COOL[3], COOL[5]] as const;
function storedView(): View { const v = localStorage.getItem(VIEW_KEY); return v === 'day' || v === 'week' || v === 'month' ? v : 'day'; }
function storedZoom(): number { const v = Number(localStorage.getItem(ZOOM_KEY)); return Number.isFinite(v) && v > 0 ? clampZoom(v) : 44; }
/** An event's colour: the one chosen for it, else one derived from its title (stable). */
export function eventColor(e: { title: string; color?: string | null }): string {
  if (e.color) return e.color;
  let h = 0; for (const ch of e.title) h = (h * 31 + ch.codePointAt(0)!) >>> 0; return PALETTE[h % PALETTE.length]!;
}
const move = (view: View, anchor: Date, step: number) => view === 'day' ? addDays(anchor, step) : view === 'week' ? addDays(anchor, 7 * step) : new Date(anchor.getFullYear(), anchor.getMonth() + step, 1);
const instant = (e: CalEvent, key: 'start' | 'end') => Date.parse(e.allDay && e[key].length <= 10 ? `${e[key]}T00:00:00` : e[key]);
const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();
const pad = (n: number) => String(n).padStart(2, '0');
const dateText = (t: Date) => `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`;
const timeText = (t: Date) => `${pad(t.getHours())}:${pad(t.getMinutes())}`;
/** Whether an event shows on day d: timed by its start day; all-day across its days (end exclusive). */
const onDay = (e: CalEvent, d: Date) => e.allDay ? instant(e, 'start') < addDays(d, 1).getTime() && Math.max(instant(e, 'end'), instant(e, 'start') + 1) > d.getTime() : sameDay(new Date(instant(e, 'start')), d);

type Draft = { id: string; title: string; allDay: boolean; startDate: string; startTime: string; endDate: string; endTime: string; color: string | null; location: string; notes: string };
const draftOf = (e: CalEvent): Draft => {
  const s = new Date(instant(e, 'start')), end = new Date(instant(e, 'end'));
  const lastDay = e.allDay ? addDays(end, end.getTime() > s.getTime() ? -1 : 0) : end;
  return { id: e.id, title: e.title, allDay: !!e.allDay, startDate: dateText(s), startTime: timeText(s), endDate: dateText(lastDay), endTime: timeText(end), color: e.color ?? null, location: e.location ?? '', notes: e.notes ?? '' };
};
/** The sheet's fields as an event, or why they don't make one. */
function inputOf(d: Draft): { ok: true; value: EventInput } | { ok: false; error: string } {
  if (!d.title.trim()) return { ok: false, error: 'Give the event a title.' };
  const zone = zoneOf(), extra = { title: d.title.trim(), color: d.color, location: d.location.trim(), notes: d.notes.trim(), zone };
  if (d.allDay) {
    if (d.endDate < d.startDate) return { ok: false, error: 'The last day is before the first.' };
    return { ok: true, value: { ...extra, allDay: true, start: d.startDate, end: dateText(addDays(new Date(`${d.endDate}T00:00:00`), 1)) } };
  }
  const s = new Date(`${d.startDate}T${d.startTime}`), e = new Date(`${d.endDate}T${d.endTime}`);
  if (!Number.isFinite(s.getTime()) || !Number.isFinite(e.getTime())) return { ok: false, error: 'Pick a start and an end.' };
  if (e < s) return { ok: false, error: 'The end is before the start.' };
  return { ok: true, value: { ...extra, allDay: false, start: s.toISOString(), end: e.toISOString() } };
}
const zoneOf = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
/** A timed event at new times, as the edit API takes it. */
const retimed = (e: CalEvent, start: Date, end: Date): EventInput => ({ title: e.title, start: start.toISOString(), end: end.toISOString(), allDay: false, zone: zoneOf(), color: e.color ?? null, location: e.location ?? '', notes: e.notes ?? '' });
type Press = { e: CalEvent; mode: 'move' | 'resize'; pointerId: number; mouse: boolean; x: number; y: number; scroll: number; col: number; el: HTMLElement; timer: ReturnType<typeof setTimeout> | null; lifted: boolean; next: { start: Date; end: Date } | null };
const whenText = (e: CalEvent) => {
  const s = new Date(instant(e, 'start')), end = new Date(instant(e, 'end'));
  const day = (t: Date) => formatDate(t, { weekday: 'long', month: 'long', day: 'numeric' }), hm = (t: Date) => formatDate(t, { hour: 'numeric', minute: '2-digit' });
  if (e.allDay) { const last = addDays(end, end.getTime() > s.getTime() ? -1 : 0); return sameDay(s, last) ? `${day(s)} · all day` : `${day(s)} – ${day(last)}`; }
  return sameDay(s, end) ? `${day(s)} · ${hm(s)} – ${hm(end)}` : `${day(s)} ${hm(s)} – ${day(end)} ${hm(end)}`;
};

/** Dated to-dos (onDate set) and what tapping their chips does. */
export interface CalTodos { items: Todo[]; tick(t: Todo): void; open(t: Todo): void }
/** The to-dos for day d: those whose day (onDate, YYYY-MM-DD) is d. */
export const todosOn = (items: Todo[], d: Date) => items.filter(t => t.onDate === dateText(d));
function TodoChip({ t, todos, weekday }: { t: Todo; todos: CalTodos; weekday?: string }) {
  const done = t.doneAt !== null;
  return <span className={done ? 'org-tchip done' : 'org-tchip'}>
    <button className="box" role="checkbox" aria-checked={done} aria-label={done ? `Reopen ${t.text}` : `Done: ${t.text}`} onClick={ev => { ev.stopPropagation(); todos.tick(t); }}>{done ? '☑' : '☐'}</button>
    <button className="tx" aria-label={`To-do: ${t.text}, open its chat`} onClick={ev => { ev.stopPropagation(); todos.open(t); }}>{t.text}{weekday && <small> · {weekday}</small>}</button>
  </span>;
}

export function CalendarViews({ source, say, todos }: { source: CalSource; say(text: string, undo?: (() => void) | null): void; todos: CalTodos }) {
  const [view, setView] = useState<View>(storedView);
  const [anchor, setAnchor] = useState(() => startOfDay(new Date()));
  const [zoom, setZoom] = useState(storedZoom);
  const [showPast, setShowPast] = useState(() => localStorage.getItem(PAST_KEY) === '1');
  const [events, setEvents] = useState<CalEvent[] | null>(null);
  const [error, setError] = useState('');
  const [version, setVersion] = useState(0);
  const [open, setOpen] = useState<CalEvent | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [now, setNow] = useState(() => new Date());
  const [drag, setDrag] = useState<{ id: string; start: Date; end: Date } | null>(null);
  const press = useRef<Press | null>(null), dragged = useRef(0);
  const grid = useRef<HTMLDivElement>(null), touch = useRef<{ x: number; y: number } | null>(null), swiped = useRef(0), pinch = useRef<{ dist: number; zoom: number; hour: number; y: number } | null>(null);
  const range = rangeOf(view, anchor);
  const reload = () => setVersion(v => v + 1);
  useEffect(() => { localStorage.setItem(VIEW_KEY, view); }, [view]);
  useEffect(() => { localStorage.setItem(ZOOM_KEY, String(zoom)); }, [zoom]);
  useEffect(() => { localStorage.setItem(PAST_KEY, showPast ? '1' : '0'); }, [showPast]);
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 60_000); return () => clearInterval(t); }, []);
  useEffect(() => {
    let current = true, request = 0;
    const refresh = () => {
      const latest = ++request;
      source.list(range.from, range.to).then(v => { if (current && latest === request) { setEvents(v); setError(''); } }, e => { if (current && latest === request) setError(String(e)); });
    };
    refresh();
    window.addEventListener('kenan-refresh', refresh);
    return () => { current = false; window.removeEventListener('kenan-refresh', refresh); };
  }, [view, range.from.getTime(), version]);
  useLayoutEffect(() => { if (view !== 'month' && grid.current) grid.current.scrollTop = Math.max(0, ((sameDay(anchor, new Date()) || view === 'week' ? new Date().getHours() : 8) - 1.5) * zoom); }, [view, anchor.getTime()]);
  /** Zoom keeping the hour under `y` (px from the grid's top edge) where it is. */
  const zoomTo = (px: number, hour?: number, y?: number) => {
    const el = grid.current, next = clampZoom(px);
    if (el) { const h = hour ?? (el.scrollTop + el.clientHeight / 2) / zoom, at = y ?? el.clientHeight / 2; requestAnimationFrame(() => { el.scrollTop = h * next - at; }); }
    setZoom(next);
  };
  useEffect(() => {
    const el = grid.current; if (!el || view === 'month') return;
    const wheel = (e: WheelEvent) => { if (!e.ctrlKey) return; e.preventDefault(); const y = e.clientY - el.getBoundingClientRect().top; zoomTo(zoom * (e.deltaY < 0 ? 1.1 : 0.9), (el.scrollTop + y) / zoom, y); };
    el.addEventListener('wheel', wheel, { passive: false }); return () => el.removeEventListener('wheel', wheel);
  }, [view, zoom]);
  useEffect(() => {
    const el = grid.current; if (!el || view === 'month') return;
    const hold = (e: TouchEvent) => { if (press.current?.lifted && e.cancelable) e.preventDefault(); };
    el.addEventListener('touchmove', hold, { passive: false }); return () => el.removeEventListener('touchmove', hold);
  }, [view]);
  const endPress = () => { const p = press.current; if (p?.timer) clearTimeout(p.timer); press.current = null; setDrag(null); };
  const lift = (p: Press) => {
    p.timer = null;
    if (p.e.seriesId) { press.current = null; dragged.current = Date.now(); say('Ask Kenan to change a repeating event'); return; }
    p.lifted = true; navigator.vibrate?.(15);
    try { p.el.setPointerCapture(p.pointerId); } catch { /* the pointer already ended */ }
    setDrag({ id: p.e.id, start: new Date(instant(p.e, 'start')), end: new Date(instant(p.e, 'end')) });
  };
  const beginPress = (ev: React.PointerEvent<HTMLElement>, e: CalEvent, col: number, mode: Press['mode']) => {
    if (press.current) { endPress(); return; }
    if (ev.pointerType === 'mouse' && ev.button !== 0) return;
    const p: Press = { e, mode, pointerId: ev.pointerId, mouse: ev.pointerType === 'mouse', x: ev.clientX, y: ev.clientY, scroll: grid.current?.scrollTop ?? 0, col, el: ev.currentTarget, timer: null, lifted: false, next: null };
    if (!p.mouse) p.timer = setTimeout(() => lift(p), LONG_PRESS_MS);
    press.current = p;
  };
  const dragMove = (ev: React.PointerEvent) => {
    const p = press.current, el = grid.current; if (!p || ev.pointerId !== p.pointerId || !el) return;
    if (!p.lifted) {
      if (Math.hypot(ev.clientX - p.x, ev.clientY - p.y) > (p.mouse ? 4 : 8)) { if (p.mouse) lift(p); else endPress(); }
      if (!p.lifted) return;
    }
    const r = el.getBoundingClientRect();
    if (ev.clientY > r.bottom - 32) el.scrollTop += 8; else if (ev.clientY < r.top + 32) el.scrollTop -= 8;
    const dy = ev.clientY - p.y + el.scrollTop - p.scroll, s = new Date(instant(p.e, 'start')), end = new Date(instant(p.e, 'end'));
    const col = Math.min(days.length - 1, Math.max(0, Math.floor((ev.clientX - r.left - GUTTER) / ((r.width - GUTTER) / days.length))));
    p.next = p.mode === 'move' ? moved(s, end, dy, col - p.col, zoom) : resized(s, end, dy, zoom); setDrag({ id: p.e.id, ...p.next });
  };
  const dragEnd = (ev: React.PointerEvent) => {
    const p = press.current; if (!p || ev.pointerId !== p.pointerId) return;
    const next = p.next; endPress();
    if (!p.lifted) return;
    dragged.current = Date.now();
    const e = p.e, s = new Date(instant(e, 'start')), end = new Date(instant(e, 'end'));
    if (!next || (next.start.getTime() === s.getTime() && next.end.getTime() === end.getTime())) return;
    setEvents(list => list && list.map(x => x.id === e.id ? { ...x, start: next.start.toISOString(), end: next.end.toISOString() } : x));
    source.update(e.id, retimed(e, next.start, next.end)).then(() => {
      reload();
      say(`${p.mode === 'move' ? 'Moved' : 'Resized'}: ${e.title}`, () => void source.update(e.id, retimed(e, s, end)).then(reload, err => say(`Couldn't undo it: ${String(err)}`)));
    }, err => { reload(); say(`Couldn't save it: ${String(err)}`); });
  };
  const onTouchStart = (e: Touches) => {
    const el = grid.current;
    if (e.touches.length > 1 && press.current) endPress();
    if (e.touches.length === 2 && el && view !== 'month') {
      const [a, b] = [e.touches[0]!, e.touches[1]!], y = (a.clientY + b.clientY) / 2 - el.getBoundingClientRect().top;
      pinch.current = { dist: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY), zoom, hour: (el.scrollTop + y) / zoom, y }; touch.current = null;
    } else if (e.touches.length === 1) touch.current = { x: e.touches[0]!.clientX, y: e.touches[0]!.clientY };
  };
  const onTouchMove = (e: Touches) => {
    const p = pinch.current, el = grid.current; if (!p || e.touches.length !== 2 || !el) return;
    const [a, b] = [e.touches[0]!, e.touches[1]!], next = clampZoom(p.zoom * Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) / p.dist);
    setZoom(next); el.scrollTop = p.hour * next - p.y;
  };
  const onTouchEnd = (e: Touches) => {
    if (Date.now() - dragged.current < 500) { touch.current = null; return; }
    if (pinch.current) { if (e.touches.length === 0) { pinch.current = null; swiped.current = Date.now(); } return; }
    const s = touch.current, t = e.changedTouches[0]; touch.current = null;
    if (s && t) { const d = swipeDirection(t.clientX - s.x, t.clientY - s.y); if (d) { swiped.current = Date.now(); setAnchor(a => move(view, a, d)); } }
  };
  const title = view === 'day' ? formatDate(anchor, { weekday: 'short', month: 'short', day: 'numeric' })
    : view === 'week' ? `${formatDate(range.from, { month: 'short', day: 'numeric' })} – ${addDays(range.to, -1).toLocaleDateString([], { month: 'short', day: 'numeric' })}`
    : formatDate(anchor, { month: 'long', year: 'numeric' });
  const days = view === 'day' ? [anchor] : view === 'week' ? Array.from({ length: 7 }, (_, i) => addDays(range.from, i)) : [];
  const visible = (events ?? []).filter(e => showPast || !isOver(e, now.getTime())), hidden = (events?.length ?? 0) - visible.length;
  const timed = visible.filter(e => !e.allDay), allDay = visible.filter(e => e.allDay && days.some(d => onDay(e, d)));
  const dayTodos = days.flatMap(d => todosOn(todos.items, d).map(t => ({ t, d })));
  const openDay = (d: Date) => { setAnchor(d); setView('day'); };
  const tint = (e: CalEvent) => { const c = eventColor(e); return { background: `${c}4d`, borderLeftColor: c }; };
  const weekTint = (e: CalEvent) => { const c = eventColor(e); return { background: `linear-gradient(${c}4d, ${c}4d), var(--page)`, borderLeftColor: c }; };
  const remove = (e: CalEvent) => {
    setOpen(null);
    source.remove(e.id).then(() => { reload(); say(`Deleted: ${e.title}`, () => void source.restore(e.id).then(reload, err => say(`Couldn't restore it: ${String(err)}`))); }, err => say(`Couldn't delete it: ${String(err)}`));
  };
  return <div className="org-cal">
    <div className="org-switch org-cal-switch" role="radiogroup" aria-label="Calendar view">{(['day', 'week', 'month'] as const).map(v => <button key={v} role="radio" aria-checked={view === v} onClick={() => setView(v)}>{v[0]!.toUpperCase() + v.slice(1)}</button>)}</div>
    <div className="org-cal-nav"><button className="org-icon" aria-label={`Previous ${view}`} onClick={() => setAnchor(a => move(view, a, -1))}>‹</button><strong>{title}</strong><button className="org-grey" onClick={() => setAnchor(startOfDay(new Date()))}>Today</button>{(hidden > 0 || showPast) && <button className="org-grey org-cal-past" aria-pressed={showPast} aria-label={showPast ? 'Hide past events' : `Show ${hidden} past event${hidden === 1 ? '' : 's'}`} onClick={() => setShowPast(v => !v)}>{showPast ? 'Hide past' : 'Past'}</button>}<button className="org-icon" aria-label={`Next ${view}`} onClick={() => setAnchor(a => move(view, a, 1))}>›</button></div>
    {error && <p className="org-quiet" role="alert">Couldn't load the calendar: {error}</p>}
    {events === null && !error && <p className="org-quiet">Loading…</p>}
    {view !== 'month' && <div className="org-wk-head" style={{ gridTemplateColumns: `${GUTTER}px repeat(${days.length},1fr)` }}><span/>{days.map(d => <button key={d.getTime()} className={sameDay(d, now) ? 'on' : ''} onClick={() => openDay(d)} aria-label={`Open ${d.toDateString()}`}>{formatDate(d, { weekday: 'short' })}<b>{d.getDate()}</b></button>)}</div>}
    {view !== 'month' && allDay.length + dayTodos.length > 0 && <div className="org-allday" aria-label="All-day events and to-dos">{allDay.map(e => <button key={e.id} style={tint(e)} onClick={() => setOpen(e)}>{e.title}{view === 'week' && <small> · {formatDate(new Date(instant(e, 'start')), { weekday: 'short' })}</small>}</button>)}
      {dayTodos.map(({ t, d }) => <TodoChip key={t.id} t={t} todos={todos} weekday={view === 'week' ? formatDate(d, { weekday: 'short' }) : undefined}/>)}</div>}
    {view === 'month' ? <div className="org-mo" onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
      {Array.from({ length: 7 }, (_, i) => addDays(range.from, i)).map((d, i) => <span key={i} className="h" aria-hidden="true">{formatDate(d, { weekday: 'narrow' })}</span>)}
      {Array.from({ length: Math.round((range.to.getTime() - range.from.getTime()) / DAY) }, (_, i) => addDays(range.from, i)).map(d => {
        const mine = visible.filter(e => onDay(e, d)), ticks = todosOn(todos.items, d), shown = Math.min(mine.length, ticks.length ? 1 : 2), more = mine.length - shown + Math.max(0, ticks.length - 1);
        const go = () => { if (Date.now() - swiped.current > 500) openDay(d); };
        return <div key={d.getTime()} role="button" tabIndex={0} className={`c${d.getMonth() !== anchor.getMonth() ? ' o' : ''}${sameDay(d, now) ? ' on' : ''}`} onClick={go} onKeyDown={ev => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); go(); } }}
          aria-label={`${d.toDateString()}${mine.length ? `, ${mine.length} events` : ''}${ticks.length ? `, ${ticks.length} to-dos` : ''}`}><span>{d.getDate()}</span>{mine.slice(0, shown).map(e => <i key={e.id} style={tint(e)}>{e.title}</i>)}
          {ticks.slice(0, 1).map(t => <TodoChip key={t.id} t={t} todos={todos}/>)}{more > 0 && <i className="more">+{more}</i>}</div>;
      })}
    </div> : <div className="org-hours" ref={grid} onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={onTouchEnd} onPointerMove={dragMove} onPointerUp={dragEnd} onPointerCancel={dragEnd}>
      <div className="org-hours-in" style={{ height: 24 * zoom }}>
        {Array.from({ length: 24 }, (_, h) => <div key={h} className="hr" style={{ top: h * zoom, height: zoom }}><span>{h === 0 ? '' : HOUR_LABELS[h]}</span></div>)}
        {days.map((d, col) => sameDay(d, now) && <div key="today" className="today" style={{ left: `calc(${GUTTER}px + ${col} * (100% - ${GUTTER}px) / ${days.length})`, width: `calc((100% - ${GUTTER}px) / ${days.length})` }}/>)}
        {days.map((d, col) => {
          const mine = timed.filter(e => onDay(e, d)), cols = lanes(mine.map(e => ({ id: e.id, start: instant(e, 'start'), end: Math.max(instant(e, 'end'), instant(e, 'start') + 30 * 60_000) })));
          const width = `(100% - ${GUTTER}px) / ${days.length}`;
          const order = [...mine].sort((a, b) => instant(a, 'start') - instant(b, 'start')).map(x => x.id);
          return mine.map(e => {
            const s = new Date(instant(e, 'start')), end = Math.max(instant(e, 'end'), s.getTime() + 15 * 60_000), top = (s.getHours() + s.getMinutes() / 60) * zoom, lane = cols.get(e.id)!;
            const height = Math.max(20, (end - s.getTime()) / 3_600_000 * zoom - 2), ghost = drag?.id === e.id ? ' ghosted' : '';
            const handlers = { onClick: (ev: React.MouseEvent) => { ev.stopPropagation(); if (Date.now() - dragged.current > 500) setOpen(e); }, onContextMenu: (ev: React.MouseEvent) => ev.preventDefault(), onPointerDown: (ev: React.PointerEvent<HTMLElement>) => beginPress(ev, e, col, 'move') };
            const grip = !e.seriesId && <span className="grip" aria-hidden="true" onPointerDown={ev => { ev.stopPropagation(); beginPress(ev, e, col, 'resize'); }}/>;
            if (days.length === 1) return <button key={e.id} className={`ev${ghost}`} style={{ top, height, left: `calc(${GUTTER}px + ${col} * ${width} + ${lane.col} * ${width} / ${lane.cols})`, width: `calc(${width} / ${lane.cols} - 2px)`, ...tint(e) }} {...handlers}>
              {e.title}<small> {formatDate(s, { hour: 'numeric', minute: '2-digit' })}</small>{grip}</button>;
            const place = overlapPlace(lane.col, lane.cols);
            return <button key={e.id} className={`ev wk${ghost}`} aria-label={`${e.title}, ${formatDate(s, { hour: 'numeric', minute: '2-digit' })}`} style={{ top, height, left: `calc(${GUTTER}px + ${col} * ${width} + ${place.left} * ${width})`, width: `calc(${place.width} * ${width} - 2px)`, zIndex: 1 + order.indexOf(e.id), ...weekTint(e) }} {...handlers}>
              <WeekText title={e.title} time={s} minutes={(end - s.getTime()) / 60_000} height={height}/>{grip}</button>;
          });
        })}
        {drag && (() => {
          const e = timed.find(x => x.id === drag.id), col = days.findIndex(d => sameDay(d, drag.start)); if (!e || col < 0) return null;
          const width = `(100% - ${GUTTER}px) / ${days.length}`, hm = (t: Date) => formatDate(t, { hour: 'numeric', minute: '2-digit' });
          const minutes = (drag.end.getTime() - drag.start.getTime()) / 60_000, height = Math.max(20, minutes / 60 * zoom - 2);
          return <div className={days.length === 1 ? 'ev lifted' : 'ev wk lifted'} aria-live="polite" style={{ top: (drag.start.getHours() + drag.start.getMinutes() / 60) * zoom, height, left: `calc(${GUTTER}px + ${col} * ${width})`, width: `calc(${width} - 2px)`, borderLeftColor: eventColor(e), background: `linear-gradient(${eventColor(e)}66, ${eventColor(e)}66), #1b1d1b` }}>
            {days.length === 1 ? <>{e.title}<small> {hm(drag.start)} – {hm(drag.end)}</small></> : <WeekText title={e.title} time={drag.start} minutes={minutes} height={height}/>}</div>;
        })()}
        {days.map((d, col) => sameDay(d, now) && <div key="now" className="now" aria-hidden="true" style={{ top: (now.getHours() + now.getMinutes() / 60) * zoom, left: `calc(${GUTTER}px + ${col} * (100% - ${GUTTER}px) / ${days.length})`, width: `calc((100% - ${GUTTER}px) / ${days.length})` }}/>)}
      </div>
    </div>}
    {view !== 'month' && <div className="org-zoom"><button className="org-grey" aria-label="Show more hours" onClick={() => zoomTo(zoom / 1.25)}>−</button><button className="org-grey" aria-label="Show fewer, taller hours" onClick={() => zoomTo(zoom * 1.25)}>＋</button></div>}
    {open && <Sheet label={open.title} close={() => setOpen(null)}>
      <div className="org-ev-title"><span className="dot" style={{ background: eventColor(open) }} aria-hidden="true"/><h2>{open.title}</h2></div>
      <p className="org-ev-line">{whenText(open)}</p>
      {open.location && <p className="org-ev-line">📍 {open.location}</p>}
      {open.notes && <p className="org-ev-line org-ev-notes">{open.notes}</p>}
      {open.seriesId && <p className="org-quiet">This event repeats. Ask Kenan to change the series; Delete here cancels just this one.</p>}
      <div className="org-sheet-actions">{!open.seriesId && <button className="org-grey" onClick={() => { setDraft(draftOf(open)); setOpen(null); }}>Edit</button>}<button className="org-grey org-danger" onClick={() => remove(open)}>Delete</button><button className="org-grey" onClick={() => setOpen(null)}>Close</button></div>
    </Sheet>}
    {draft && <EventEditor draft={draft} close={() => setDraft(null)} save={async input => { await source.update(draft.id, input); setDraft(null); reload(); }}/>}
  </div>;
}

/** A week-view block's text: the title on the lines that fit (cut with an ellipsis), then the start time if there's room. */
function WeekText({ title, time, minutes, height }: { title: string; time: Date; minutes: number; height: number }) {
  const fit = weekText(minutes, height);
  return <><span className={fit.lines === 1 ? 't one' : 't'} style={{ WebkitLineClamp: fit.lines }}>{title}</span>
    {fit.time && <small>{formatDate(time, time.getMinutes() ? { hour: 'numeric', minute: '2-digit' } : { hour: 'numeric' })}</small>}</>;
}

function EventEditor({ draft, close, save }: { draft: Draft; close(): void; save(input: EventInput): Promise<void> }) {
  const [d, setD] = useState(draft), [problem, setProblem] = useState(''), [busy, setBusy] = useState(false);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD(x => ({ ...x, [k]: v }));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const input = inputOf(d); if (!input.ok) { setProblem(input.error); return; }
    setBusy(true); save(input.value).catch(err => { setProblem(`Couldn't save: ${String(err)}`); setBusy(false); });
  };
  const moveStart = (date: string, time: string) => {
    const old = new Date(`${d.startDate}T${d.startTime}`), next = new Date(`${date}T${time}`), oldEnd = new Date(`${d.endDate}T${d.endTime}`);
    const end = Number.isFinite(next.getTime()) && Number.isFinite(old.getTime()) && Number.isFinite(oldEnd.getTime()) ? new Date(next.getTime() + (oldEnd.getTime() - old.getTime())) : null;
    setD(x => ({ ...x, startDate: date, startTime: time, ...(end ? { endDate: dateText(end), endTime: timeText(end) } : {}) }));
  };
  return <Sheet label="Edit event" close={close}>
    <form className="org-ev-form" onSubmit={submit}>
      <input className="org-ev-name" aria-label="Title" placeholder="Add title" value={d.title} onChange={e => set('title', e.target.value)}/>
      <label className="org-ev-row"><span>All day</span><input type="checkbox" role="switch" checked={d.allDay} onChange={e => set('allDay', e.target.checked)}/></label>
      <div className="org-ev-row"><span>{d.allDay ? 'From' : 'Starts'}</span><DateField label="Start date" value={d.startDate} change={v => moveStart(v, d.startTime)}/>{!d.allDay && <input type="time" aria-label="Start time" value={d.startTime} onChange={e => moveStart(d.startDate, e.target.value)}/>}</div>
      <div className="org-ev-row"><span>{d.allDay ? 'To' : 'Ends'}</span><DateField label="End date" value={d.endDate} change={v => set('endDate', v)}/>{!d.allDay && <input type="time" aria-label="End time" value={d.endTime} onChange={e => set('endTime', e.target.value)}/>}</div>
      <div className="org-ev-colors" role="radiogroup" aria-label="Colour">{SWATCHES.map(c => <button type="button" key={c} role="radio" aria-checked={d.color === c} aria-label={`Colour ${c}`} style={{ background: c }} onClick={() => set('color', d.color === c ? null : c)}/>)}</div>
      <input aria-label="Location" placeholder="📍 Location" value={d.location} onChange={e => set('location', e.target.value)}/>
      <textarea aria-label="Notes" placeholder="Notes" rows={2} value={d.notes} onChange={e => set('notes', e.target.value)}/>
      {problem && <p className="org-quiet" role="alert">{problem}</p>}
      <div className="org-sheet-actions"><button type="button" className="org-grey" onClick={close}>Cancel</button><button type="submit" className="org-grey org-save" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button></div>
    </form>
  </Sheet>;
}
