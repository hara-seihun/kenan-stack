import { useLayoutEffect, useRef, useState, type Dispatch, type ReactNode, type RefObject, type SetStateAction } from 'react';
import { useOverlay } from './overlay.js';
import { swipeDirection } from './gallery.js';

export type DrawerControl = RefObject<Dispatch<SetStateAction<boolean>> | null>;
/** Keep the contents mounted and toggle here, not in the screen that owns every chat and message.
 * The parent's children keep their identity while this component changes only the two composited layers. */
/** How a drawer looks: the sidebar's classes, or a module's own (its panel closes on a swipe toward the edge). */
export interface DrawerSkin { scrim: string; panel: string; closeLabel: string; label: string | undefined; swipeClose: boolean }
export const SIDEBAR: DrawerSkin = { scrim: 'nav-scrim', panel: 'sidebar', closeLabel: 'Close navigation', label: undefined, swipeClose: false };
export function NavDrawer({ control, skin = SIDEBAR, children, narrow = true, backToList = false, skyOnly = false }: {
  control: DrawerControl; skin?: DrawerSkin; children: ReactNode;
  narrow?: boolean; backToList?: boolean; skyOnly?: boolean;
}) {
  const [open, setOpen] = useState(false);
  control.current = setOpen;
  useOverlay(open && !backToList, () => setOpen(false));
  useOverlay(backToList && !open && !skyOnly, () => setOpen(true));
  const start = useRef<{ x: number; y: number } | null>(null);
  const panel = useRef<HTMLElement>(null);
  // Native inert changes an inherited CSS property: Chrome restyles every row and icon on each
  // toggle. Hide from assistive technology and suspend tab stops instead, without touching styles.
  const tabStops = useRef(new Map<HTMLElement, string | null>());
  const closed = narrow && !open;
  const closedRef = useRef(closed); closedRef.current = closed;
  useLayoutEffect(() => {
    const root = panel.current!;
    const sync = () => {
      for (const [el, value] of tabStops.current) {
        if (!closedRef.current || !root.contains(el)) {
          if (value === null) el.removeAttribute('tabindex'); else el.setAttribute('tabindex', value);
          tabStops.current.delete(el);
        }
      }
      if (!closedRef.current) return;
      for (const el of root.querySelectorAll<HTMLElement>('a[href],button,input,textarea,select,summary,[tabindex],[contenteditable="true"],audio[controls],video[controls],iframe')) {
        if (!tabStops.current.has(el)) tabStops.current.set(el, el.getAttribute('tabindex'));
        if (el.tabIndex !== -1) el.tabIndex = -1;
      }
    };
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(root, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [closed, children]);
  return <>
    <button className={`${skin.scrim} drawer-scrim${open ? ' open' : ''}`} aria-label={skin.closeLabel} aria-hidden={!open} tabIndex={open ? 0 : -1} onClick={() => setOpen(false)}/>
    <aside className={`${skin.panel} nav-drawer${open ? ' open' : ''}`} ref={panel} aria-label={skin.label} aria-hidden={closed}
      onTouchStart={skin.swipeClose ? e => { const t = e.touches[0]!; start.current = { x: t.clientX, y: t.clientY }; } : undefined}
      onTouchEnd={skin.swipeClose ? e => { const s = start.current, t = e.changedTouches[0]!; start.current = null; if (s && swipeDirection(t.clientX - s.x, t.clientY - s.y) === -1) setOpen(false); } : undefined}>
      {children}
    </aside>
  </>;
}
