// Back (Android gesture/button, browser back) and Escape close the topmost open overlay before anything else.
import { useEffect, useRef } from 'react';
import { overlayStack } from './overlayStack.js';

const MARK = 'kenanOverlay';
const overlays = overlayStack({
  marked: () => (history.state as Record<string, unknown> | null)?.[MARK] === true,
  push: () => history.pushState({ [MARK]: true }, ''),
  back: () => history.back(),
  unmark: () => history.replaceState(null, ''),
});
window.addEventListener('popstate', () => overlays.popped());
document.addEventListener('keydown', event => { if (event.key === 'Escape' && !event.defaultPrevented && overlays.dismissTop()) event.preventDefault(); });
/** The Android app asks this on back; true means an overlay closed and the app stays where it is. */
(window as unknown as { kenanBack: () => boolean }).kenanBack = () => overlays.dismissTop();

/** Registers an overlay while `open`; back and Escape call `close` when it is the topmost. */
export function useOverlay(open: boolean, close: () => void): void {
  const latest = useRef(close); latest.current = close;
  useEffect(() => open ? overlays.register({ close: () => latest.current() }) : undefined, [open]);
}
