// Whether a scrolled message list keeps its newest content in view. It follows only while she is at the bottom: any move
// of hers upwards stops it at once, however small, and reaching the bottom again (or `pin`, the Jump to latest button)
// resumes it. Streaming text never pulls the view back down while she reads above.
import type { KeyboardEvent, MutableRefObject, TouchEvent, WheelEvent } from 'react';

export interface Box { scrollTop: number; scrollHeight: number; clientHeight: number }
export type Stick = ReturnType<typeof followBottom>;

/** Scrolling back down to within this of the bottom resumes following. */
const BOTTOM_PX = 32;
/** A finger has to drag the content down this far (past a tap's wobble) to mean "up". */
const TOUCH_SLOP_PX = 8;

export function followBottom(follow: MutableRefObject<boolean>, changed: (following: boolean) => void = () => {}) {
  /** Where the list was last seen or put, to tell her moves from the content's. */
  let top = 0, touchY: number | null = null, shown = follow.current;
  const set = (following: boolean) => { follow.current = following; if (following !== shown) changed(shown = following); };
  const settle = (box: Box) => { if (follow.current) box.scrollTop = box.scrollHeight; top = box.scrollTop; set(follow.current); };
  const finger = (e: TouchEvent) => e.touches.length === 1 ? e.touches[0]!.clientY : null;
  return {
    /** A scroll event: a move up that doesn't end at the bottom is hers (content shrinking under a list at the bottom ends there). */
    scrolled(box: Box, canFollow = true) {
      const left = box.scrollHeight - box.scrollTop - box.clientHeight;
      if (!canFollow || (box.scrollTop < top - 1 && left > 1)) set(false);
      else if (box.scrollTop > top && left <= BOTTOM_PX) set(true);
      top = box.scrollTop;
    },
    /** After the content changed: keep the bottom in view while following. */
    settle,
    /** Jump to latest. */
    pin(box: Box) { follow.current = true; settle(box); },
    /** Her input that can only mean "up", seen before the scroll it causes, so content arriving in between can't win. */
    input: {
      onWheel: (e: WheelEvent) => { if (e.deltaY < 0) set(false); },
      onKeyDown: (e: KeyboardEvent) => { if (/^(ArrowUp|PageUp|Home)$/.test(e.key)) set(false); },
      onTouchStart: (e: TouchEvent) => { touchY = finger(e); },
      onTouchMove: (e: TouchEvent) => { const y = finger(e); if (touchY !== null && y !== null && y - touchY > TOUCH_SLOP_PX) set(false); },
      onTouchEnd: () => { touchY = null; },
    },
  };
}
