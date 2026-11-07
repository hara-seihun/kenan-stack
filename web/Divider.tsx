// A vertical divider that resizes the pane beside it: drag, arrow keys, double-click for the default. Shared by the
// artifact panel and Organized's wide panes.
import { useEffect, useRef, useState } from 'react';
import './Divider.css';

export interface DividerProps {
  className: string;
  label: string;
  width: number;
  min: number;
  max: number;
  /** The pane's width for a pointer at `clientX`. */
  widthAt: (clientX: number) => number;
  /** Which arrow key widens the pane. */
  grows: 'ArrowLeft' | 'ArrowRight';
  /** `done` is true when the person lets go (or steps with a key): keep the width then. */
  resize: (width: number, done: boolean) => void;
  reset: () => void;
}

const KEY_STEP = 32;

export function Divider(p: DividerProps) {
  const pointer = useRef<number | null>(null);
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    if (!dragging) return;
    document.documentElement.classList.add('col-resizing');
    return () => document.documentElement.classList.remove('col-resizing');
  }, [dragging]);
  const end = () => { pointer.current = null; setDragging(false); };
  return <div className={`divider ${p.className}${dragging ? ' dragging' : ''}`} role="separator" aria-orientation="vertical" aria-label={p.label} tabIndex={0}
    aria-valuemin={p.min} aria-valuemax={p.max} aria-valuenow={p.width}
    onPointerDown={event => { event.currentTarget.setPointerCapture(event.pointerId); pointer.current = event.pointerId; setDragging(true); }}
    onPointerMove={event => { if (pointer.current === event.pointerId) p.resize(p.widthAt(event.clientX), false); }}
    onPointerUp={event => { if (pointer.current !== event.pointerId) return; end(); p.resize(p.widthAt(event.clientX), true); }}
    onPointerCancel={end}
    onDoubleClick={p.reset}
    onKeyDown={event => {
      const step = event.key === p.grows ? KEY_STEP : event.key === 'ArrowLeft' || event.key === 'ArrowRight' ? -KEY_STEP : 0;
      if (step) { event.preventDefault(); p.resize(p.width + step, true); }
    }}/>;
}
