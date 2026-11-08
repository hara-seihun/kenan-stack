import { useEffect, useRef, useState } from 'react';
import { useOverlay } from './overlay.js';
import { beginUpdateActivity } from './updateActivity.js';
import './draw.css';

type Point = { x: number; y: number; p: number };
type Stroke = { color: string; width: number; points: Point[] };
type Sending = { state: 'idle' } | { state: 'sending' } | { state: 'failed'; text: string };

export const INKS = ['#111111', '#ffffff', '#be1236', '#f08a24', '#f2c94c', '#2f9e5b', '#2f80ed', '#8e44ad', '#8b5a2b'] as const;
export const WIDTHS = [3, 8, 20] as const;
const PAPER = '#ffffff';

/** The drawing survives closing the canvas (Back, ✕) until it is sent or cleared, so nothing is lost by accident. */
const kept: { strokes: Stroke[]; color: string; width: number } = { strokes: [], color: INKS[0], width: WIDTHS[1] };

let drawingActivity: (() => void) | null = null;
function saveStrokes(strokes: Stroke[]) {
  kept.strokes = strokes;
  if (strokes.length) drawingActivity ??= beginUpdateActivity();
  else { drawingActivity?.(); drawingActivity = null; }
}

function paint(ctx: CanvasRenderingContext2D, stroke: Stroke, from = 0) {
  const pts = stroke.points, first = pts[0];
  if (!first) return;
  ctx.strokeStyle = stroke.color; ctx.fillStyle = stroke.color; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  if (pts.length === 1) { ctx.beginPath(); ctx.arc(first.x, first.y, stroke.width * first.p / 2, 0, Math.PI * 2); ctx.fill(); return; }
  for (let i = Math.max(1, from); i < pts.length; i++) {
    const a = pts[i - 1]!, b = pts[i]!, before = pts[i - 2] ?? a;
    ctx.lineWidth = stroke.width * (a.p + b.p) / 2;
    ctx.beginPath();
    ctx.moveTo((before.x + a.x) / 2, (before.y + a.y) / 2);
    ctx.quadraticCurveTo(a.x, a.y, (a.x + b.x) / 2, (a.y + b.y) / 2);
    ctx.stroke();
  }
  const last = pts[pts.length - 1]!, prev = pts[pts.length - 2]!;
  if (from === 0) { ctx.beginPath(); ctx.moveTo((prev.x + last.x) / 2, (prev.y + last.y) / 2); ctx.lineTo(last.x, last.y); ctx.stroke(); }
}

export function renderDrawing(ctx: CanvasRenderingContext2D, strokes: Stroke[], width: number, height: number) {
  ctx.fillStyle = PAPER; ctx.fillRect(0, 0, width, height);
  for (const stroke of strokes) paint(ctx, stroke);
}

const fileName = (at: Date) => `drawing-${at.getFullYear()}${String(at.getMonth() + 1).padStart(2, '0')}${String(at.getDate()).padStart(2, '0')}-${String(at.getHours()).padStart(2, '0')}${String(at.getMinutes()).padStart(2, '0')}${String(at.getSeconds()).padStart(2, '0')}.png`;

export function Draw({ close, send }: { close: () => void; send: (file: File) => Promise<boolean> }) {
  const canvas = useRef<HTMLCanvasElement>(null), size = useRef({ w: 0, h: 0, dpr: 1 }), live = useRef(new Map<number, Stroke>());
  const [strokes, setStrokes] = useState<Stroke[]>(kept.strokes), [color, setColor] = useState(kept.color), [width, setWidth] = useState(kept.width);
  const [sending, setSending] = useState<Sending>({ state: 'idle' });
  const strokesRef = useRef(strokes); strokesRef.current = strokes;
  kept.color = color; kept.width = width;
  const replaceStrokes = (next: Stroke[]) => {
    strokesRef.current = next; saveStrokes(next); setStrokes(next);
    if (live.current.size) drawingActivity ??= beginUpdateActivity();
  };
  useEffect(() => () => {
    // Closing with a pointer still down keeps that stroke too.
    if (live.current.size) saveStrokes([...kept.strokes, ...live.current.values()]);
  }, []);
  useOverlay(true, close);

  const redraw = () => {
    const el = canvas.current, ctx = el?.getContext('2d'); if (!el || !ctx) return;
    const { w, h, dpr } = size.current;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    renderDrawing(ctx, [...strokesRef.current, ...live.current.values()], w, h);
  };
  useEffect(() => {
    const el = canvas.current!;
    const fit = () => {
      const box = el.getBoundingClientRect(), dpr = Math.min(window.devicePixelRatio || 1, 3);
      size.current = { w: box.width, h: box.height, dpr };
      el.width = Math.round(box.width * dpr); el.height = Math.round(box.height * dpr);
      redraw();
    };
    fit();
    const observer = new ResizeObserver(fit); observer.observe(el);
    return () => observer.disconnect();
  }, []);
  useEffect(redraw, [strokes]);

  const point = (event: PointerEvent): Point => {
    const box = canvas.current!.getBoundingClientRect();
    const p = event.pointerType === 'pen' && event.pressure > 0 ? 0.35 + event.pressure * 1.3 : 1;
    return { x: event.clientX - box.left, y: event.clientY - box.top, p };
  };
  const down = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (event.button > 0 || sending.state === 'sending') return;
    event.preventDefault();
    drawingActivity ??= beginUpdateActivity();
    event.currentTarget.setPointerCapture(event.pointerId);
    const stroke: Stroke = { color, width, points: [point(event.nativeEvent)] };
    live.current.set(event.pointerId, stroke);
    const ctx = canvas.current!.getContext('2d')!; paint(ctx, stroke);
  };
  const move = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const stroke = live.current.get(event.pointerId); if (!stroke) return;
    const from = stroke.points.length;
    const events = event.nativeEvent.getCoalescedEvents?.() ?? [];
    for (const e of events.length ? events : [event.nativeEvent]) stroke.points.push(point(e));
    paint(canvas.current!.getContext('2d')!, stroke, from);
  };
  const up = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const stroke = live.current.get(event.pointerId); if (!stroke) return;
    live.current.delete(event.pointerId);
    replaceStrokes([...strokesRef.current, stroke]);
  };

  async function finish() {
    const { w, h } = size.current; if (!strokes.length || !w || !h) return;
    const done = beginUpdateActivity();
    setSending({ state: 'sending' });
    try {
      const scale = Math.min(2, Math.max(1, 2048 / Math.max(w, h))), out = document.createElement('canvas');
      out.width = Math.round(w * scale); out.height = Math.round(h * scale);
      const ctx = out.getContext('2d')!; ctx.setTransform(scale, 0, 0, scale, 0, 0); renderDrawing(ctx, strokes, w, h);
      const blob = await new Promise<Blob | null>(resolve => out.toBlob(resolve, 'image/png'));
      if (!blob) { setSending({ state: 'failed', text: 'Couldn’t make an image from the drawing.' }); return; }
      if (await send(new File([blob], fileName(new Date()), { type: 'image/png' }))) { replaceStrokes([]); close(); }
      else setSending({ state: 'failed', text: 'Not sent. Your drawing is still here; try again.' });
    } finally { done(); }
  }

  const busy = sending.state === 'sending';
  return <div className="draw" role="dialog" aria-modal="true" aria-label="Draw">
    <div className="draw-bar">
      <button type="button" aria-label="Close drawing" onClick={close}>✕</button>
      <button type="button" aria-label="Undo" disabled={!strokes.length || busy} onClick={() => replaceStrokes(strokesRef.current.slice(0, -1))}>↶ Undo</button>
      <button type="button" aria-label="Clear" disabled={!strokes.length || busy} onClick={() => replaceStrokes([])}>Clear</button>
      <span/>
      <button type="button" className="send" disabled={!strokes.length || busy} onClick={() => void finish()}>{busy ? 'Sending…' : 'Send ↑'}</button>
    </div>
    {sending.state === 'failed' && <p className="draw-error" role="alert">{sending.text}</p>}
    <canvas ref={canvas} className="draw-canvas" onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onContextMenu={e => e.preventDefault()}/>
    <div className="draw-tools">
      <div className="draw-inks" role="radiogroup" aria-label="Colour">{INKS.map(ink => <button key={ink} type="button" role="radio" aria-checked={ink === color} aria-label={`Colour ${ink}`} className={ink === color ? 'on' : ''} style={{ background: ink }} onClick={() => setColor(ink)}/>)}</div>
      <div className="draw-widths" role="radiogroup" aria-label="Brush size">{WIDTHS.map(w => <button key={w} type="button" role="radio" aria-checked={w === width} aria-label={`Brush ${w}`} className={w === width ? 'on' : ''} onClick={() => setWidth(w)}><i style={{ width: Math.max(4, w), height: Math.max(4, w), background: color === PAPER ? '#bbb' : color }}/></button>)}</div>
    </div>
  </div>;
}
