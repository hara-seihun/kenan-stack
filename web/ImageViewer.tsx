import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Download, X } from 'lucide-react';
import { swipeDirection, type GalleryItem } from './gallery.js';
export { gallery } from './gallery.js';
export { showFile } from './FileViewer.js';
import { apiPath } from './path.js';
import { useOverlay } from './overlay.js';
import { fitSize, pinch, settle, tall, toggleZoom, zoomAt, zoomed, MAX_SCALE, type Pinch, type Point, type Size, type View } from './zoom.js';
import './ImageViewer.css';

const fileUrl = (fileId: string, download = false) => apiPath(`/api/files/${fileId}${download ? '?download=1' : ''}`);

/** Movement under this many pixels is a tap; two taps this close in time and space are a double tap. */
const TAP_PX = 10, DOUBLE_TAP_MS = 300, DOUBLE_TAP_PX = 30;
/** A drag down at fit closes the viewer past this distance or a flick faster than this (px/ms). */
const DISMISS_PX = 110, DISMISS_SPEED = 0.6;

type Laid = { natural: Size; port: Size; content: Size };
type Drag = { origin: View; start: Point; last: Point; mode: 'undecided' | 'pan' | 'swipe' | 'dismiss'; samples: { at: Point; t: number }[] };
type Actions = { zoomChanged: (zoomed: boolean) => void; toggleControls: () => void; step: (step: -1 | 1) => boolean; close: () => void };

/** Owns one image's gestures. Transforms are written straight to the element so a pinch never waits on a render. */
class Gestures {
  view: View = { scale: 1, x: 0, y: 0 };
  laid: Laid | null = null;
  private pointers = new Map<number, Point>();
  private pinchStart: Pinch | null = null;
  private drag: Drag | null = null;
  private lastTap: { at: Point; t: number } | null = null;
  private fling = 0;
  private pendingToggle = 0;
  private origin: Point = { x: 0, y: 0 };

  constructor(private stage: HTMLElement, private img: HTMLImageElement, private backdrop: HTMLElement, private act: Actions) {}

  layout(): void {
    const { naturalWidth: width, naturalHeight: height } = this.img;
    if (!width || !height) return;
    const port = { width: this.stage.clientWidth, height: this.stage.clientHeight };
    const content = fitSize({ width, height }, port);
    this.laid = { natural: { width, height }, port, content };
    this.img.style.width = `${content.width}px`;
    this.img.style.height = `${content.height}px`;
    this.set(settle({ scale: 1, x: 0, y: 0 }, content, port));
    this.img.classList.add('ready');
  }

  private apply(view: View, animate: boolean, shift: Point = { x: 0, y: 0 }): void {
    this.img.style.transition = animate ? 'transform .22s ease-out' : 'none';
    this.img.style.transform = `translate(${view.x + shift.x}px,${view.y + shift.y}px) scale(${view.scale})`;
  }

  private set(view: View, animate = false): void {
    this.view = view;
    this.apply(view, animate);
    this.act.zoomChanged(zoomed(view));
  }

  zoomTo(scale: number, animate = true): void {
    const l = this.laid; if (!l) return;
    this.set(settle(zoomAt(this.view, scale, { x: l.port.width / 2, y: l.port.height / 2 }), l.content, l.port), animate);
  }

  /** The scale at which one image pixel is one screen pixel. */
  actualScale(): number { const l = this.laid; return l ? Math.min(MAX_SCALE, l.natural.width / l.content.width) : 1; }

  private local(e: PointerEvent | WheelEvent): Point { return { x: e.clientX - this.origin.x, y: e.clientY - this.origin.y }; }

  private onImage(p: Point): boolean {
    const l = this.laid, v = this.view; if (!l) return false;
    return p.x >= v.x && p.y >= v.y && p.x <= v.x + l.content.width * v.scale && p.y <= v.y + l.content.height * v.scale;
  }

  private startPinch(): void {
    const [a, b] = [...this.pointers.values()] as [Point, Point];
    clearTimeout(this.pendingToggle);
    this.pinchStart = { view: this.view, mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)) };
    this.drag = null;
    this.lastTap = null;
  }

  private startDrag(at: Point): void {
    this.drag = { origin: this.view, start: at, last: at, mode: 'undecided', samples: [{ at, t: performance.now() }] };
  }

  down = (e: PointerEvent): void => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (!this.laid) return;
    cancelAnimationFrame(this.fling);
    const rect = this.stage.getBoundingClientRect();
    this.origin = { x: rect.left, y: rect.top };
    this.stage.setPointerCapture(e.pointerId);
    this.pointers.set(e.pointerId, this.local(e));
    if (this.pointers.size === 2) this.startPinch();
    else if (this.pointers.size === 1) this.startDrag(this.local(e));
  };

  move = (e: PointerEvent): void => {
    if (!this.pointers.has(e.pointerId)) return;
    const p = this.local(e);
    this.pointers.set(e.pointerId, p);
    const l = this.laid; if (!l) return;
    if (this.pinchStart && this.pointers.size >= 2) {
      const [a, b] = [...this.pointers.values()] as [Point, Point];
      this.view = pinch(this.pinchStart, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, Math.hypot(a.x - b.x, a.y - b.y));
      this.apply(this.view, false);
      return;
    }
    const d = this.drag; if (!d) return;
    d.last = p;
    d.samples.push({ at: p, t: performance.now() });
    if (d.samples.length > 6) d.samples.shift();
    const dx = p.x - d.start.x, dy = p.y - d.start.y;
    if (d.mode === 'undecided') {
      if (Math.hypot(dx, dy) < TAP_PX) return;
      d.mode = zoomed(d.origin) ? 'pan' : Math.abs(dx) > Math.abs(dy) ? 'swipe' : tall(l.content, l.port) ? 'pan' : 'dismiss';
    }
    if (d.mode === 'pan') { this.view = settle({ ...d.origin, x: d.origin.x + dx, y: d.origin.y + dy }, l.content, l.port); this.apply(this.view, false); }
    else if (d.mode === 'swipe') this.apply(this.view, false, { x: dx, y: 0 });
    else { this.apply(this.view, false, { x: 0, y: dy }); this.backdrop.style.opacity = String(Math.max(0.3, 1 - Math.abs(dy) / 400)); }
  };

  up = (e: PointerEvent): void => {
    if (!this.pointers.delete(e.pointerId)) return;
    const l = this.laid; if (!l) return;
    if (this.pinchStart) {
      if (this.pointers.size >= 2) { this.startPinch(); return; }
      const at = this.pinchStart.mid;
      this.pinchStart = null;
      this.set(settle(this.view, l.content, l.port, at), true);
      const rest = [...this.pointers.values()][0];
      if (rest) this.startDrag(rest);
      return;
    }
    const d = this.drag; this.drag = null;
    if (!d || e.type === 'pointercancel') { this.set(this.view, true); this.backdrop.style.opacity = ''; return; }
    const dx = d.last.x - d.start.x, dy = d.last.y - d.start.y;
    if (d.mode === 'undecided') return this.tap(d.start, performance.now());
    if (d.mode === 'swipe') { const step = swipeDirection(dx, dy); if (!step || !this.act.step(step)) this.apply(this.view, true); return; }
    const first = d.samples[0]!, now = performance.now(), ms = Math.max(1, now - first.t);
    const velocity = { x: (d.last.x - first.at.x) / ms, y: (d.last.y - first.at.y) / ms };
    if (d.mode === 'dismiss') {
      if (Math.abs(dy) > DISMISS_PX || Math.abs(velocity.y) > DISMISS_SPEED) return this.act.close();
      this.backdrop.style.opacity = '';
      return this.apply(this.view, true);
    }
    this.flingFrom(velocity);
  };

  private flingFrom(velocity: Point): void {
    let v = velocity, last = performance.now();
    const frame = (now: number) => {
      const l = this.laid; if (!l) return;
      const dt = Math.min(32, now - last); last = now;
      const next = settle({ ...this.view, x: this.view.x + v.x * dt, y: this.view.y + v.y * dt }, l.content, l.port);
      const stuck = next.x === this.view.x && next.y === this.view.y;
      this.view = next; this.apply(next, false);
      v = { x: v.x * Math.pow(0.995, dt), y: v.y * Math.pow(0.995, dt) };
      if (!stuck && Math.hypot(v.x, v.y) > 0.02) this.fling = requestAnimationFrame(frame);
    };
    if (Math.hypot(v.x, v.y) > 0.1) this.fling = requestAnimationFrame(frame);
  }

  private tap(at: Point, t: number): void {
    const l = this.laid; if (!l) return;
    const previous = this.lastTap;
    if (previous && t - previous.t < DOUBLE_TAP_MS && Math.hypot(at.x - previous.at.x, at.y - previous.at.y) < DOUBLE_TAP_PX) {
      this.lastTap = null;
      clearTimeout(this.pendingToggle);
      this.set(toggleZoom(this.view, at, l.content, l.port), true);
      return;
    }
    if (!this.onImage(at)) { this.lastTap = null; if (!zoomed(this.view)) this.act.close(); return; }
    this.lastTap = { at, t };
    clearTimeout(this.pendingToggle);
    this.pendingToggle = window.setTimeout(() => this.act.toggleControls(), DOUBLE_TAP_MS);
  }

  /** Trackpad pinch (ctrl+wheel) zooms at the cursor; the wheel pans a zoomed or tall image. */
  wheel = (e: WheelEvent): void => {
    const l = this.laid; if (!l) return;
    const rect = this.stage.getBoundingClientRect();
    this.origin = { x: rect.left, y: rect.top };
    if (e.ctrlKey) {
      e.preventDefault();
      const at = this.local(e);
      this.set(settle(zoomAt(this.view, Math.min(MAX_SCALE, Math.max(1, this.view.scale * Math.exp(-e.deltaY / 100))), at), l.content, l.port, at));
    } else if (zoomed(this.view) || tall(l.content, l.port)) {
      e.preventDefault();
      this.set(settle({ ...this.view, x: this.view.x - e.deltaX, y: this.view.y - e.deltaY }, l.content, l.port));
    }
  };

  /** Back to fit; false when already there. */
  reset(): boolean {
    const l = this.laid;
    if (!l || !zoomed(this.view)) return false;
    this.set(settle({ scale: 1, x: 0, y: 0 }, l.content, l.port), true);
    return true;
  }

  dispose(): void { cancelAnimationFrame(this.fling); clearTimeout(this.pendingToggle); }
}

/** Full-screen viewer for the conversation's images: a single tap on the image (or click) hides or shows the controls; pinch or double-tap to zoom (up to 8×), drag to pan, swipe sideways
 * for the next image and down to close. Zoomed, back and Escape return to fit first and the close gestures do nothing. */
export function ImageViewer({ items, start, close }: { items: GalleryItem[]; start: number; close: () => void }) {
  const [index, setIndex] = useState(start);
  const [isZoomed, setZoomed] = useState(false);
  const [actualScale, setActualScale] = useState(1);
  const [controls, setControls] = useState(true);
  const viewer = useRef<HTMLDivElement>(null), stage = useRef<HTMLDivElement>(null), img = useRef<HTMLImageElement>(null);
  const gestures = useRef<Gestures | null>(null);
  useOverlay(true, close);
  useOverlay(isZoomed, () => gestures.current?.reset());
  const item = items[index] ?? items[0]!;
  const go = (step: number): boolean => {
    const next = index + step;
    if (next < 0 || next >= items.length) return false;
    setIndex(next);
    return true;
  };
  const latest = useRef({ go, close }); latest.current = { go, close };

  useEffect(() => {
    const s = stage.current!, i = img.current!, v = viewer.current!;
    v.style.opacity = '';
    setZoomed(false);
    const g = new Gestures(s, i, v, { zoomChanged: setZoomed, toggleControls: () => setControls(shown => !shown), step: step => latest.current.go(step), close: () => latest.current.close() });
    gestures.current = g;
    const laid = () => { g.layout(); setActualScale(g.actualScale()); };
    if (i.complete && i.naturalWidth) laid();
    i.addEventListener('load', laid);
    const resize = new ResizeObserver(() => { if (g.laid) laid(); });
    resize.observe(s);
    s.addEventListener('pointerdown', g.down);
    s.addEventListener('pointermove', g.move);
    s.addEventListener('pointerup', g.up);
    s.addEventListener('pointercancel', g.up);
    s.addEventListener('wheel', g.wheel, { passive: false });
    return () => {
      g.dispose(); resize.disconnect(); i.removeEventListener('load', laid);
      s.removeEventListener('pointerdown', g.down); s.removeEventListener('pointermove', g.move);
      s.removeEventListener('pointerup', g.up); s.removeEventListener('pointercancel', g.up); s.removeEventListener('wheel', g.wheel);
    };
  }, [item.fileId]);

  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === 'ArrowLeft' && !isZoomed) go(-1);
      else if (event.key === 'ArrowRight' && !isZoomed) go(1);
      else if (event.key === '+' || event.key === '=') gestures.current?.zoomTo(Math.min(MAX_SCALE, (gestures.current.view.scale) * 1.5));
      else if (event.key === '-') gestures.current?.zoomTo(gestures.current.view.scale / 1.5);
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  });

  return <div ref={viewer} className={`image-viewer${isZoomed ? ' zoomed' : ''}${controls ? '' : ' controls-hidden'}`} role="dialog" aria-modal="true" aria-label="Image">
    <div className="image-viewer-bar">
      {items.length > 1 && <span className="image-viewer-count">{index + 1} / {items.length}</span>}
      {(isZoomed || actualScale > 1.01) && <button type="button" onClick={() => isZoomed ? gestures.current?.reset() : gestures.current?.zoomTo(actualScale)}>{isZoomed ? 'Fit' : 'Actual size'}</button>}
      <a href={fileUrl(item.fileId, true)} download aria-label="Download"><Download size={17}/></a>
      <button type="button" aria-label="Close" onClick={close}><X size={18}/></button>
    </div>
    <div ref={stage} className="image-viewer-stage">
      <img ref={img} key={item.fileId} src={fileUrl(item.fileId)} alt="Attachment, full size" draggable={false}/>
    </div>
    {item.caption && !isZoomed && <p className="image-viewer-caption">{item.caption}</p>}
    {!isZoomed && items.length > 1 && index > 0 && <button type="button" className="image-viewer-nav previous" aria-label="Previous image" onClick={() => go(-1)}><ChevronLeft size={22}/></button>}
    {!isZoomed && items.length > 1 && index < items.length - 1 && <button type="button" className="image-viewer-nav next" aria-label="Next image" onClick={() => go(1)}><ChevronRight size={22}/></button>}
  </div>;
}
