// Where a menu opened from a button goes: below it when it fits in the visible area, else above, else clamped into
// the visible area and scrolling inside (Carol 2026-10-21: the last chat row's ⋯ menu opened off-screen).
import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';

export type Edges = { top: number; right: number; bottom: number; left: number };
export type Size = { width: number; height: number };
export type Placement = { side: 'below' | 'above' | 'clamped'; top: number; left: number; maxHeight: number; maxWidth: number };

const GAP = 4;

/** Pure placement: the menu's right edge lines up with the anchor's, clamped to the area's sides. */
export function placeMenu(anchor: Edges, menu: Size, area: Edges): Placement {
  const maxWidth = area.right - area.left, width = Math.min(menu.width, maxWidth);
  const left = Math.min(Math.max(anchor.right - width, area.left), area.right - width);
  const below = area.bottom - (anchor.bottom + GAP), above = anchor.top - GAP - area.top;
  if (menu.height <= below) return { side: 'below', top: anchor.bottom + GAP, left, maxHeight: below, maxWidth };
  if (menu.height <= above) return { side: 'above', top: anchor.top - GAP - menu.height, left, maxHeight: above, maxWidth };
  const maxHeight = area.bottom - area.top, height = Math.min(menu.height, maxHeight);
  const wanted = below >= above ? anchor.bottom + GAP : anchor.top - GAP - height;
  return { side: 'clamped', top: Math.min(Math.max(wanted, area.top), area.bottom - height), left, maxHeight, maxWidth };
}

const MARGIN = 8;

/** The part of the screen a menu may use: the visual viewport (so the on-screen keyboard counts), inside the safe
 * area, above the bottom tab bar, with a small margin. */
function visibleArea(): Edges {
  const vv = window.visualViewport;
  const view = vv ? { top: vv.offsetTop, left: vv.offsetLeft, right: vv.offsetLeft + vv.width, bottom: vv.offsetTop + vv.height }
    : { top: 0, left: 0, right: window.innerWidth, bottom: window.innerHeight };
  const safe = safeInsets(), tabs = document.querySelector('.org-tabs')?.getBoundingClientRect();
  const bottom = Math.min(view.bottom, window.innerHeight - safe.bottom, tabs && tabs.height > 0 ? tabs.top : Infinity);
  return { top: Math.max(view.top, safe.top) + MARGIN, left: Math.max(view.left, safe.left) + MARGIN, right: Math.min(view.right, window.innerWidth - safe.right) - MARGIN, bottom: bottom - MARGIN };
}

let probe: HTMLDivElement | null = null;
function safeInsets(): Edges {
  if (!probe) {
    probe = document.createElement('div');
    probe.style.cssText = 'position:fixed;visibility:hidden;pointer-events:none;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)';
    document.body.appendChild(probe);
  }
  const s = getComputedStyle(probe);
  return { top: parseFloat(s.paddingTop), right: parseFloat(s.paddingRight), bottom: parseFloat(s.paddingBottom), left: parseFloat(s.paddingLeft) };
}

/** Keeps a fixed-position menu next to its anchor button and fully visible while it is open. */
export function useAnchoredMenu<T extends HTMLElement>(anchor: RefObject<HTMLElement | null>): RefObject<T | null> {
  const menu = useRef<T>(null);
  useLayoutEffect(() => {
    const place = (e?: Event) => {
      const el = menu.current, a = anchor.current;
      if (!el || !a || (e?.target instanceof Node && el.contains(e.target))) return;
      el.style.maxHeight = el.style.maxWidth = '';
      const p = placeMenu(a.getBoundingClientRect(), { width: el.offsetWidth, height: el.scrollHeight }, visibleArea());
      Object.assign(el.style, { position: 'fixed', top: `${p.top}px`, left: `${p.left}px`, right: 'auto', maxHeight: `${p.maxHeight}px`, maxWidth: `${p.maxWidth}px`, overflowY: 'auto' });
      el.dataset.side = p.side;
    };
    place();
    const vv = window.visualViewport;
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    vv?.addEventListener('resize', place);
    vv?.addEventListener('scroll', place);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
      vv?.removeEventListener('resize', place);
      vv?.removeEventListener('scroll', place);
    };
  }, []);
  return menu;
}

/** Keeps a bottom sheet above the on-screen keyboard: its bottom follows the visual viewport's. */
export function useAboveKeyboard<T extends HTMLElement>(): RefObject<T | null> {
  const sheet = useRef<T>(null);
  useLayoutEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const fit = () => {
      const el = sheet.current;
      if (!el) return;
      const hidden = Math.max(0, window.innerHeight - (vv.offsetTop + vv.height));
      el.style.bottom = `${hidden}px`;
      el.style.maxHeight = `${Math.round(vv.height * 0.88)}px`;
    };
    fit();
    vv.addEventListener('resize', fit);
    vv.addEventListener('scroll', fit);
    return () => { vv.removeEventListener('resize', fit); vv.removeEventListener('scroll', fit); };
  }, []);
  return sheet;
}

/** Keyboard focus for an overlay: on open it moves into the overlay (the container itself, so no phone keyboard pops
 * up), unless something inside already took it; on close it goes back to what had it, if focus would otherwise be lost. */
export function useFocusInside<T extends HTMLElement>(ref: RefObject<T | null>, back?: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null, el = ref.current;
    if (el && !el.contains(document.activeElement)) el.focus({ preventScroll: true });
    return () => {
      const target = back?.current ?? before;
      const lost = !document.activeElement || document.activeElement === document.body || !document.activeElement.isConnected || el?.contains(document.activeElement);
      if (lost && target?.isConnected) target.focus({ preventScroll: true });
    };
  }, []);
}
