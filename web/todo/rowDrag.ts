// Long-press a row (or drag it with a mouse) to move it, on the 🛒 To buy list: the
// row lifts and follows the finger, a line shows where it will land (across sections, empty ones included), and the list
// scrolls itself near its top and bottom edges. Markup: each section carries data-drop-section (its key), each draggable
// row data-drag-id, and an empty section's placeholder data-drop-empty. The same press-then-lift rules as the calendar (CalendarViews.tsx): a touch
// lifts after LONG_PRESS_MS without moving, so a quick swipe still scrolls; a mouse lifts once it moves.
import { useEffect, useRef, useState, type RefObject } from 'react';

/** Where a dragged row lands: a section and an index among that section's rows without the dragged one. */
export interface DropSpot<K extends string> { section: K; index: number }
/** A section's measured place in the scrolling list (content coordinates), and its rows' places. */
export interface SectionBox<K extends string> { section: K; top: number; bottom: number; rows: { id: string; top: number; bottom: number }[]; empty: { top: number; bottom: number } | null }

/** The drop spot under content y, and where its indicator line goes. Above the first section is its top; below the last, its end. */
export function dropSpot<K extends string>(boxes: SectionBox<K>[], draggedId: string, y: number): DropSpot<K> & { lineY: number } {
  const box = boxes.find((b, i) => y < b.bottom || i === boxes.length - 1)!;
  const rows = box.rows.filter(r => r.id !== draggedId), index = rows.filter(r => (r.top + r.bottom) / 2 < y).length;
  const lineY = rows.length === 0 ? (box.empty ? (box.empty.top + box.empty.bottom) / 2 : box.top) : index < rows.length ? rows[index]!.top - 3 : rows[rows.length - 1]!.bottom + 3;
  return { section: box.section, index, lineY };
}

const LONG_PRESS_MS = 400, EDGE = 56, MAX_SPEED = 14;
interface Press<T, K extends string> {
  t: T; el: HTMLElement; pointerId: number; mouse: boolean; x: number; y: number;
  timer: ReturnType<typeof setTimeout> | null; lifted: { boxes: SectionBox<K>[]; startY: number } | null; lastY: number;
  /** The browser cancelled the pointer of a lifted row (its own long-press claiming the gesture): touch events drive the drag from then on. */
  byTouch: boolean; unlisten(): void;
}
export interface RowDrag<T, K extends string> {
  /** The row's pointerdown. */
  press(ev: { pointerId: number; pointerType: string; button: number; clientX: number; clientY: number; currentTarget: EventTarget | null }, t: T): void;
  liftedId: string | null;
  /** Where the indicator line is (content y in the scroll box) and the section it is in, while a row is lifted. */
  line: { y: number; section: K } | null;
}

/** Content y (inside the scrolling box) of a viewport y. */
const contentY = (box: HTMLElement, clientY: number) => clientY - box.getBoundingClientRect().top + box.scrollTop;
function measure<K extends string>(box: HTMLElement): SectionBox<K>[] {
  const at = (el: Element) => { const r = el.getBoundingClientRect(); return { top: contentY(box, r.top), bottom: contentY(box, r.bottom) }; };
  return [...box.querySelectorAll<HTMLElement>('[data-drop-section]')].map(s => {
    const empty = s.querySelector('[data-drop-empty]');
    return { section: s.dataset.dropSection as K, ...at(s), rows: [...s.querySelectorAll<HTMLElement>('[data-drag-id]')].map(r => ({ id: r.dataset.dragId!, ...at(r) })), empty: empty ? at(empty) : null };
  });
}

export function useRowDrag<T extends { id: string }, K extends string>(scroll: RefObject<HTMLElement | null>, drop: (t: T, spot: DropSpot<K>) => void): RowDrag<T, K> {
  const press = useRef<Press<T, K> | null>(null), frame = useRef<number | null>(null);
  const [liftedId, setLiftedId] = useState<string | null>(null), [line, setLine] = useState<RowDrag<T, K>['line']>(null);
  const dropRef = useRef(drop); dropRef.current = drop;

  const follow = (p: Press<T, K>) => {
    const box = scroll.current; if (!box || !p.lifted) return;
    const y = contentY(box, p.lastY);
    p.el.style.transform = `translateY(${y - p.lifted.startY}px)`;
    const spot = dropSpot(p.lifted.boxes, p.t.id, y);
    setLine(l => l && l.y === spot.lineY && l.section === spot.section ? l : { y: spot.lineY, section: spot.section });
    return spot;
  };
  const autoScroll = () => {
    frame.current = null;
    const p = press.current, box = scroll.current; if (!p?.lifted || !box) return;
    const r = box.getBoundingClientRect();
    const speed = p.lastY < r.top + EDGE ? -MAX_SPEED * Math.min(1, (r.top + EDGE - p.lastY) / EDGE) : p.lastY > r.bottom - EDGE ? MAX_SPEED * Math.min(1, (p.lastY - r.bottom + EDGE) / EDGE) : 0;
    if (speed !== 0) { const before = box.scrollTop; box.scrollTop += speed; if (box.scrollTop !== before) follow(p); }
    frame.current = requestAnimationFrame(autoScroll);
  };
  const finish = (dropIt: boolean) => {
    const p = press.current; if (!p) return;
    press.current = null;
    if (p.timer) clearTimeout(p.timer);
    if (frame.current !== null) { cancelAnimationFrame(frame.current); frame.current = null; }
    p.unlisten();
    if (!p.lifted) return;
    document.documentElement.classList.remove('org-row-dragging');
    const spot = dropIt ? follow(p) : undefined;
    p.el.style.transform = '';
    setLiftedId(null); setLine(null);
    // The release that ends a drag is not a tap on whatever is under it.
    const swallow = (e: Event) => { e.preventDefault(); e.stopPropagation(); };
    document.addEventListener('click', swallow, { capture: true, once: true });
    setTimeout(() => document.removeEventListener('click', swallow, { capture: true }), 400);
    if (spot) dropRef.current(p.t, spot);
  };
  const lift = (p: Press<T, K>) => {
    const box = scroll.current; if (!box || press.current !== p) return;
    p.timer = null;
    p.lifted = { boxes: measure<K>(box), startY: contentY(box, p.y) };
    navigator.vibrate?.(15);
    document.documentElement.classList.add('org-row-dragging');
    getSelection()?.removeAllRanges();
    try { p.el.setPointerCapture(p.pointerId); } catch { /* the pointer already ended */ }
    setLiftedId(p.t.id); follow(p);
    frame.current = requestAnimationFrame(autoScroll);
  };
  const move = (ev: PointerEvent) => {
    const p = press.current; if (!p || ev.pointerId !== p.pointerId) return;
    p.lastY = ev.clientY;
    if (!p.lifted) {
      if (Math.hypot(ev.clientX - p.x, ev.clientY - p.y) > (p.mouse ? 4 : 8)) { if (p.mouse) lift(p); else finish(false); }
      return;
    }
    follow(p);
  };
  const up = (ev: PointerEvent) => { if (ev.pointerId === press.current?.pointerId) finish(true); };
  // Before the lift a cancel is the page scrolling; after it, the platform's own long-press (WebView) cancelling the pointer, while
  // the finger is still down and still dragging the row.
  const cancel = (ev: PointerEvent) => { const p = press.current; if (ev.pointerId !== p?.pointerId) return; if (p.lifted && !p.mouse) p.byTouch = true; else finish(false); };
  // Once lifted the finger drags the row, not the page.
  const hold = (e: TouchEvent) => {
    const p = press.current; if (!p?.lifted) return;
    if (e.cancelable) e.preventDefault();
    const f = e.touches[0]; if (p.byTouch && f) { p.lastY = f.clientY; follow(p); }
  };
  const touchEnd = (e: TouchEvent) => { const p = press.current; if (p?.byTouch && e.touches.length === 0) finish(e.type === 'touchend'); };
  // A press never opens the long-press menu, selects text or starts a native drag, however long it is held: the lifted row
  // takes no pointer events, so the platform's long-press lands on whatever is under it, not on the row's own handlers.
  const quiet = (e: Event) => { if (press.current) e.preventDefault(); };
  const QUIET = ['contextmenu', 'selectstart', 'dragstart'] as const;
  const key = (e: KeyboardEvent) => { if (e.key === 'Escape') finish(false); };
  useEffect(() => () => finish(false), []);

  return {
    liftedId, line,
    press(ev, t) {
      if (press.current) { finish(false); return; }
      if (ev.pointerType === 'mouse' && ev.button !== 0) return;
      const el = ev.currentTarget as HTMLElement;
      const p: Press<T, K> = { t, el, pointerId: ev.pointerId, mouse: ev.pointerType === 'mouse', x: ev.clientX, y: ev.clientY, timer: null, lifted: null, lastY: ev.clientY, unlisten: () => {
        document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up); document.removeEventListener('pointercancel', cancel);
        document.removeEventListener('touchmove', hold); document.removeEventListener('keydown', key);
        document.removeEventListener('touchend', touchEnd); document.removeEventListener('touchcancel', touchEnd);
        for (const t of QUIET) document.removeEventListener(t, quiet, true);
      }, byTouch: false };
      if (!p.mouse) p.timer = setTimeout(() => lift(p), LONG_PRESS_MS);
      press.current = p;
      document.addEventListener('pointermove', move); document.addEventListener('pointerup', up); document.addEventListener('pointercancel', cancel);
      document.addEventListener('touchmove', hold, { passive: false }); document.addEventListener('keydown', key);
      document.addEventListener('touchend', touchEnd); document.addEventListener('touchcancel', touchEnd);
      for (const t of QUIET) document.addEventListener(t, quiet, true);
    },
  };
}
