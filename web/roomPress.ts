// Room buttons keep normal taps and scrolling; a stationary hold or desktop context-menu opens their actions.
import { useEffect, useRef, type KeyboardEvent, type MouseEvent, type PointerEvent } from 'react';

export function useRoomPress(enabled: boolean, open: () => void) {
  const press = useRef<{ x: number; y: number; timer: ReturnType<typeof setTimeout> } | null>(null);
  const held = useRef(false), latest = useRef(open); latest.current = open;
  const cancel = () => { if (press.current) clearTimeout(press.current.timer); press.current = null; };
  useEffect(() => cancel, []);
  return {
    onPointerDown: (e: PointerEvent<HTMLElement>) => {
      cancel(); held.current = false;
      if (!enabled || !e.isPrimary || e.button !== 0) return;
      press.current = { x: e.clientX, y: e.clientY, timer: setTimeout(() => { press.current = null; held.current = true; latest.current(); }, 450) };
    },
    onPointerMove: (e: PointerEvent<HTMLElement>) => {
      if (press.current && Math.hypot(e.clientX - press.current.x, e.clientY - press.current.y) > 10) cancel();
    },
    onPointerUp: cancel,
    onPointerCancel: cancel,
    onClickCapture: (e: MouseEvent<HTMLElement>) => { if (held.current) { e.preventDefault(); e.stopPropagation(); held.current = false; } },
    onContextMenu: (e: MouseEvent<HTMLElement>) => {
      if (!enabled) return;
      e.preventDefault(); e.stopPropagation(); cancel();
      if (!held.current) latest.current();
      held.current = true;
    },
    onKeyDown: (e: KeyboardEvent<HTMLElement>) => {
      if (enabled && (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10'))) { e.preventDefault(); cancel(); latest.current(); }
    },
  };
}
