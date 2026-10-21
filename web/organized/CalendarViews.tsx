// Organized calendar: Day / Week / Month (mockups design/final/cal-*). Swipe or ‹ › to move, tap a day to open it,
// pinch (or Ctrl+wheel, or − +) to zoom the hour scale in Day and Week. The view and zoom are remembered per device.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api } from '../client.js';
import { swipeDirection } from '../gallery.js';
import { COOL, WARM } from './colors.js';

type View = 'day' | 'week' | 'month';
type Point = { clientX: number; clientY: number };
type Touches = { touches: { length: number; [i: number]: Point }; changedTouches: { length: number; [i: number]: Point } };
interface CalEvent { id: string; title: string; start: string; end: string; allDay?: boolean }
const VIEW_KEY = 'kenan.calendarView', ZOOM_KEY = 'kenan.calendarHourPx';
export const MIN_HOUR_PX = 20, MAX_HOUR_PX = 120;
const DAY = 86_400_000;
const PALETTE = [...WARM, ...COOL];
export const clampZoom = (px: number) => Math.min(MAX_HOUR_PX, Math.max(MIN_HOUR_PX, px));
function storedView(): View { const v = localStorage.getItem(VIEW_KEY); return v === 'day' || v === 'week' || v === 'month' ? v : 'day'; }
function storedZoom(): number { const v = Number(localStorage.getItem(ZOOM_KEY)); return Number.isFinite(v) && v > 0 ? clampZoom(v) : 44; }
/** Each event keeps one colour, chosen from its title. */
export function eventColor(title: string): string { let h = 0; for (const ch of title) h = (h * 31 + ch.codePointAt(0)!) >>> 0; return PALETTE[h % PALETTE.length]!; }
const startOfDay = (t: Date) => new Date(t.getFullYear(), t.getMonth(), t.getDate());
const addDays = (t: Date, n: number) => new Date(t.getFullYear(), t.getMonth(), t.getDate() + n);
const startOfWeek = (t: Date) => addDays(startOfDay(t), -((t.getDay() + 6) % 7));
/** The days a view shows, first to last (month: whole weeks around the month). */
export function rangeOf(view: View, anchor: Date): { from: Date; to: Date } {
  if (view === 'day') return { from: startOfDay(anchor), to: addDays(startOfDay(anchor), 1) };
  if (view === 'week') return { from: startOfWeek(anchor), to: addDays(startOfWeek(anchor), 7) };
  const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1), last = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 1);
  return { from: startOfWeek(first), to: addDays(startOfWeek(addDays(last, -1)), 7) };
}
const move = (view: View, anchor: Date, step: number) => view === 'day' ? addDays(anchor, step) : view === 'week' ? addDays(anchor, 7 * step) : new Date(anchor.getFullYear(), anchor.getMonth() + step, 1);
const instant = (e: CalEvent, key: 'start' | 'end') => Date.parse(e.allDay && e[key].length <= 10 ? `${e[key]}T00:00:00` : e[key]);
const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();

export function CalendarViews({ fullList }: { fullList: () => void }) {
  const [view, setView] = useState<View>(storedView);
  const [anchor, setAnchor] = useState(() => startOfDay(new Date()));
  const [zoom, setZoom] = useState(storedZoom);
  const [events, setEvents] = useState<CalEvent[] | null>(null);
  const [error, setError] = useState('');
  const grid = useRef<HTMLDivElement>(null), touch = useRef<{ x: number; y: number } | null>(null), pinch = useRef<{ dist: number; zoom: number; hour: number; y: number } | null>(null);
  const range = rangeOf(view, anchor);
  useEffect(() => { localStorage.setItem(VIEW_KEY, view); }, [view]);
  useEffect(() => { localStorage.setItem(ZOOM_KEY, String(zoom)); }, [zoom]);
  useEffect(() => {
    let current = true; setEvents(null);
    api<CalEvent[]>(`/ext/calendar/?from=${encodeURIComponent(range.from.toISOString())}&to=${encodeURIComponent(range.to.toISOString())}`)
      .then(v => { if (current) { setEvents(v); setError(''); } }, e => { if (current) setError(String(e)); });
    return () => { current = false; };
  }, [view, range.from.getTime()]);
  useLayoutEffect(() => { if (view !== 'month' && grid.current && sameDay(anchor, new Date())) grid.current.scrollTop = Math.max(0, (new Date().getHours() - 2) * zoom); }, [view, anchor.getTime()]);
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
  const onTouchStart = (e: Touches) => {
    const el = grid.current;
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
    if (pinch.current) { if (e.touches.length === 0) pinch.current = null; return; }
    const s = touch.current, t = e.changedTouches[0]; touch.current = null;
    if (s && t) { const d = swipeDirection(t.clientX - s.x, t.clientY - s.y); if (d) setAnchor(a => move(view, a, d)); }
  };
  const title = view === 'day' ? anchor.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })
    : view === 'week' ? `${range.from.toLocaleDateString([], { month: 'short', day: 'numeric' })} – ${addDays(range.to, -1).toLocaleDateString([], { month: 'short', day: 'numeric' })}`
    : anchor.toLocaleDateString([], { month: 'long', year: 'numeric' });
  const days = view === 'day' ? [anchor] : view === 'week' ? Array.from({ length: 7 }, (_, i) => addDays(range.from, i)) : [];
  const timed = (events ?? []).filter(e => !e.allDay), allDay = (events ?? []).filter(e => e.allDay);
  const openDay = (d: Date) => { setAnchor(d); setView('day'); };
  return <div className="org-cal">
    <div className="org-switch org-cal-switch" role="radiogroup" aria-label="Calendar view">{(['day', 'week', 'month'] as const).map(v => <button key={v} role="radio" aria-checked={view === v} onClick={() => setView(v)}>{v[0]!.toUpperCase() + v.slice(1)}</button>)}</div>
    <div className="org-cal-nav"><button className="org-icon" aria-label={`Previous ${view}`} onClick={() => setAnchor(a => move(view, a, -1))}>‹</button><strong>{title}</strong><button className="org-grey" onClick={() => setAnchor(startOfDay(new Date()))}>Today</button><button className="org-icon" aria-label={`Next ${view}`} onClick={() => setAnchor(a => move(view, a, 1))}>›</button></div>
    {error && <p className="org-quiet" role="alert">Couldn't load the calendar: {error}</p>}
    {events === null && !error && <p className="org-quiet">Loading…</p>}
    {view === 'week' && <div className="org-wk-head"><span/>{days.map(d => <button key={d.getTime()} className={sameDay(d, new Date()) ? 'on' : ''} onClick={() => openDay(d)} aria-label={`Open ${d.toDateString()}`}>{d.toLocaleDateString([], { weekday: 'short' })}<b>{d.getDate()}</b></button>)}</div>}
    {view !== 'month' && allDay.length > 0 && <div className="org-allday">{allDay.map(e => <span key={e.id} style={{ background: `${eventColor(e.title)}4d`, borderLeftColor: eventColor(e.title) }}>{e.title}</span>)}</div>}
    {view === 'month' ? <div className="org-mo" onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
      {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d, i) => <span key={i} className="h" aria-hidden="true">{d}</span>)}
      {Array.from({ length: Math.round((range.to.getTime() - range.from.getTime()) / DAY) }, (_, i) => addDays(range.from, i)).map(d => {
        const mine = (events ?? []).filter(e => sameDay(new Date(instant(e, 'start')), d));
        return <button key={d.getTime()} className={`c${d.getMonth() !== anchor.getMonth() ? ' o' : ''}${sameDay(d, new Date()) ? ' on' : ''}`} onClick={() => openDay(d)} aria-label={`${d.toDateString()}${mine.length ? `, ${mine.length} events` : ''}`}><span>{d.getDate()}</span>{mine.slice(0, 2).map(e => <i key={e.id} style={{ background: `${eventColor(e.title)}4d`, borderLeftColor: eventColor(e.title) }}>{e.title}</i>)}{mine.length > 2 && <i className="more">+{mine.length - 2}</i>}</button>;
      })}
    </div> : <div className="org-hours" ref={grid} onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={onTouchEnd}>
      <div className="org-hours-in" style={{ height: 24 * zoom }}>
        {Array.from({ length: 24 }, (_, h) => <div key={h} className="hr" style={{ top: h * zoom, height: zoom }}><span>{new Date(2000, 0, 1, h).toLocaleTimeString([], { hour: 'numeric' })}</span></div>)}
        {days.map((d, col) => timed.filter(e => sameDay(new Date(instant(e, 'start')), d)).map(e => {
          const s = new Date(instant(e, 'start')), end = Math.max(instant(e, 'end'), s.getTime() + 15 * 60_000), top = (s.getHours() + s.getMinutes() / 60) * zoom, c = eventColor(e.title);
          return <div key={e.id} className="ev" title={e.title} style={{ top, height: Math.max(18, (end - s.getTime()) / 3_600_000 * zoom - 2), left: `calc(48px + ${col} * (100% - 48px) / ${days.length})`, width: `calc((100% - 48px) / ${days.length} - 3px)`, background: `${c}4d`, borderLeftColor: c }}>{e.title}</div>;
        }))}
        {days.map((d, col) => sameDay(d, new Date()) && <div key="now" className="now" style={{ top: (new Date().getHours() + new Date().getMinutes() / 60) * zoom, left: `calc(48px + ${col} * (100% - 48px) / ${days.length})`, width: `calc((100% - 48px) / ${days.length})` }}/>)}
      </div>
    </div>}
    <div className="org-cal-foot">{view !== 'month' && <><button className="org-grey" aria-label="Show more hours" onClick={() => zoomTo(zoom / 1.25)}>−</button><button className="org-grey" aria-label="Show fewer, taller hours" onClick={() => zoomTo(zoom * 1.25)}>＋</button></>}<button className="org-grey" onClick={fullList}>List & add event</button></div>
  </div>;
}
