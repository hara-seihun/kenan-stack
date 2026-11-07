// The PDF reader inside the file viewer (Alice 2026-10-31): every page as an image the server draws, scrolled like a
// document, pinch (or ctrl/trackpad wheel) to zoom about the fingers. Pages load as they come near the screen and are
// redrawn sharper after a zoom, so a long PDF costs only what is looked at.
import { useEffect, useRef, useState } from 'react';
import { PDF_PAGE_WIDTHS, type PdfInfo, type PdfPageWidth } from '../shared/contract.js';
import { api } from './client.js';
import { apiPath } from './path.js';

export const MIN_ZOOM = 1, MAX_ZOOM = 6;
/** The pages' width at zoom 1: the viewer's width, but no wider than a comfortable reading column. */
const COLUMN_MAX = 920;

/** The narrowest drawn width that is sharp at `pixels` device pixels, or the widest there is. */
export const pageWidthFor = (pixels: number): PdfPageWidth => PDF_PAGE_WIDTHS.find(w => w >= pixels) ?? PDF_PAGE_WIDTHS[PDF_PAGE_WIDTHS.length - 1]!;

export const clampZoom = (zoom: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));

type Rect = { left: number; top: number; width: number; height: number };
/** How far to scroll so the point of the pages that was under `at` (in `before`) is under it again once they are laid
 * out as `after`. */
export const keepUnder = (at: { x: number; y: number }, before: Rect, after: Rect) => ({
  x: after.left + (at.x - before.left) / before.width * after.width - at.x,
  y: after.top + (at.y - before.top) / before.height * after.height - at.y,
});

type Loading = { state: 'loading' } | { state: 'ready'; info: PdfInfo } | { state: 'failed'; reason: string };
const distance = (t: TouchList) => Math.hypot(t[0]!.clientX - t[1]!.clientX, t[0]!.clientY - t[1]!.clientY);
const middle = (t: TouchList) => ({ x: (t[0]!.clientX + t[1]!.clientX) / 2, y: (t[0]!.clientY + t[1]!.clientY) / 2 });

export function PdfDocument({ fileId, name, download }: { fileId: string; name: string; download: string }) {
  const [loading, setLoading] = useState<Loading>({ state: 'loading' });
  const scroller = useRef<HTMLDivElement>(null), column = useRef<HTMLDivElement>(null);
  const [portWidth, setPortWidth] = useState(0);
  /** The zoom the pages are drawn sharp for; during a pinch the column is resized directly and this follows at the end. */
  const [zoom, setZoom] = useState(1);
  const live = useRef(1);

  useEffect(() => {
    let current = true;
    setLoading({ state: 'loading' });
    api<PdfInfo>(`/files/${fileId}/pdf`).then(
      info => { if (current) setLoading({ state: 'ready', info }); },
      (e: unknown) => { if (current) setLoading({ state: 'failed', reason: e instanceof Error ? e.message : String(e) }); });
    return () => { current = false; };
  }, [fileId]);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setPortWidth(el.clientWidth));
    observer.observe(el);
    return () => observer.disconnect();
  }, [loading.state]);

  const base = Math.max(1, Math.min(portWidth - 16, COLUMN_MAX));

  useEffect(() => {
    const el = scroller.current, col = column.current;
    if (!el || !col) return;
    /** Sets the column to `next` zoom keeping the page point under `at` where it is. */
    const zoomTo = (next: number, at: { x: number; y: number }) => {
      const before = col.getBoundingClientRect();
      live.current = next;
      col.style.width = `${base * next}px`;
      const shift = keepUnder(at, before, col.getBoundingClientRect());
      el.scrollLeft += shift.x; el.scrollTop += shift.y;
    };
    let pinch: { distance: number; zoom: number } | null = null;
    let settle: ReturnType<typeof setTimeout> | undefined;
    const done = () => { clearTimeout(settle); settle = setTimeout(() => setZoom(live.current), 150); };
    const start = (e: TouchEvent) => { if (e.touches.length === 2) pinch = { distance: distance(e.touches), zoom: live.current }; };
    const move = (e: TouchEvent) => {
      if (!pinch || e.touches.length !== 2) return;
      e.preventDefault();
      zoomTo(clampZoom(pinch.zoom * distance(e.touches) / pinch.distance), middle(e.touches));
    };
    const end = (e: TouchEvent) => { if (pinch && e.touches.length < 2) { pinch = null; done(); } };
    const wheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      zoomTo(clampZoom(live.current * Math.exp(-e.deltaY / 200)), { x: e.clientX, y: e.clientY });
      done();
    };
    const gesture = (e: Event) => e.preventDefault();
    el.addEventListener('touchstart', start, { passive: true });
    el.addEventListener('touchmove', move, { passive: false });
    el.addEventListener('touchend', end);
    el.addEventListener('touchcancel', end);
    el.addEventListener('wheel', wheel, { passive: false });
    el.addEventListener('gesturestart', gesture);
    return () => {
      clearTimeout(settle);
      el.removeEventListener('touchstart', start); el.removeEventListener('touchmove', move); el.removeEventListener('touchend', end);
      el.removeEventListener('touchcancel', end); el.removeEventListener('wheel', wheel); el.removeEventListener('gesturestart', gesture);
    };
  }, [base, loading.state]);

  switch (loading.state) {
    case 'loading': return <div className="doc-scroll"><p className="doc-note">Loading…</p></div>;
    case 'failed': return <div className="doc-scroll"><p className="doc-note" role="alert">Couldn't show this PDF: {loading.reason}. <a href={download} download={name}>Download it</a></p></div>;
    case 'ready': {
      if (!portWidth) return <div ref={scroller} className="doc-scroll pdf-scroll"/>;
      const drawn = pageWidthFor(base * zoom * devicePixelRatio);
      return <div ref={scroller} className="doc-scroll pdf-scroll">
        <div ref={column} className="pdf-pages" style={{ width: `${base * zoom}px` }}>
          {loading.info.pages.map((page, i) => <img key={i} loading={i < 2 ? 'eager' : 'lazy'} alt={`Page ${i + 1} of ${loading.info.pages.length}`}
            style={{ aspectRatio: `${page.width} / ${page.height}` }} src={apiPath(`/api/files/${fileId}/pdf/${i + 1}?w=${drawn}`)}/>)}
        </div>
      </div>;
    }
  }
}
