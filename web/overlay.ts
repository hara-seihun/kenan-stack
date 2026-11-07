// Back (Android gesture/button, browser back) and Escape close the topmost open overlay before anything else.
import { useLayoutEffect, useRef } from 'react';
import { overlayStack } from './overlayStack.js';

const MARK = 'kenanOverlay';
const browser = typeof window !== 'undefined';
// Created at import only in a browser: it reads history, and Node tests import components that use overlays.
const overlays = overlayStack(browser ? {
  marked: () => (history.state as Record<string, unknown> | null)?.[MARK] === true,
  push: () => history.pushState({ [MARK]: true }, ''),
  back: () => history.back(),
  unmark: () => history.replaceState(null, ''),
} : { marked: () => false, push: () => {}, back: () => {}, unmark: () => {} });
if (browser) {
  window.addEventListener('popstate', () => overlays.popped());
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && !event.defaultPrevented && overlays.dismissTop()) event.preventDefault(); });
  (window as unknown as { kenanBack: () => boolean }).kenanBack = () => overlays.dismissTop();
}
/** Back, as the Android button does it: closes the topmost overlay (or steps back along a link trail); false when none is open. */
export const dismissTop = (): boolean => overlays.dismissTop();

/** Registers an overlay while `open`; back and Escape call `close` when it is the topmost. A new `depth` registers it again, on top. */
export function useOverlay(open: boolean, close: () => void, depth = 0): void {
  const latest = useRef(close); latest.current = close;
  useLayoutEffect(() => open ? overlays.register({ close: () => latest.current() }) : undefined, [open, depth]);
}
