import { memo, useLayoutEffect, useMemo, useRef, useState, type MutableRefObject, type ReactNode } from 'react';

export type WindowRow = { id: string; text: string; estimate: number };
type Space = { el: HTMLElement; near: boolean; mounted: boolean; show: (mounted: boolean) => void };

/** Scroll observation changes only the rows entering or leaving view, not the transcript or app.
 * Separate browser tasks mount rich rows so a page of history cannot monopolize one frame. */
function observer(box: MutableRefObject<HTMLDivElement | null>) {
  const spaces = new Map<HTMLElement, Space>();
  const heights = new Map<string, number>();
  let intersect: IntersectionObserver | undefined, resize: ResizeObserver | undefined;
  let settle = () => {}, found: HTMLElement | null = null;
  const queue = new Set<Space>();
  const channel = new MessageChannel();
  let pending = false;
  function schedule(space: Space) {
    if (space.mounted === keep(space)) { queue.delete(space); return; }
    queue.add(space);
    if (box.current) box.current.dataset.windowPending = 'true';
    if (!pending) { pending = true; channel.port2.postMessage(null); }
  }
  function keep(space: Space) {
    if (space.near || space.el === found) return true;
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed && Array.from({ length: selection.rangeCount }, (_, i) => selection.getRangeAt(i)).some(range => range.intersectsNode(space.el))) return true;
    return space.mounted && (space.el.contains(document.activeElement) || !!space.el.querySelector('details[open], .image-viewer, .media-attachment.playing, .media-attachment.full'));
  }
  channel.port1.onmessage = () => {
    const space = queue.values().next().value as Space | undefined;
    if (space) {
      queue.delete(space);
      if (spaces.has(space.el)) { const next = keep(space); if (space.mounted !== next) { space.mounted = next; space.show(next); } }
    }
    pending = queue.size > 0;
    if (!pending && box.current) box.current.dataset.windowPending = 'false';
    if (pending) channel.port2.postMessage(null);
  };
  function ensure() {
    if (intersect || !box.current) return;
    intersect = new IntersectionObserver(entries => {
      for (const entry of entries) { const space = spaces.get(entry.target as HTMLElement); if (space) { space.near = entry.isIntersecting; schedule(space); } }
    }, { root: box.current, rootMargin: '200px 0px' });
    resize = new ResizeObserver(entries => {
      for (const entry of entries) { const el = entry.target as HTMLElement; if (spaces.has(el) && el.dataset.mounted === 'true') heights.set(el.dataset.id!, el.getBoundingClientRect().height); }
      settle();
    });
    resize.observe(box.current);
  }
  return {
    heights,
    settle: (next: () => void) => { settle = next; },
    register(el: HTMLElement, show: Space['show']) {
      ensure();
      const space = { el, near: false, mounted: false, show }; spaces.set(el, space);
      intersect?.observe(el); resize?.observe(el);
      return () => { spaces.delete(el); if (found === el) found = null; heights.delete(el.dataset.id!); queue.delete(space); intersect?.unobserve(el); resize?.unobserve(el); };
    },
    reveal(el: HTMLElement) {
      found = el;
      const space = spaces.get(el); if (space) { space.near = true; schedule(space); }
    },
    reconsider() { for (const space of spaces.values()) schedule(space); },
    disconnect() { intersect?.disconnect(); resize?.disconnect(); channel.port1.close(); channel.port2.close(); spaces.clear(); queue.clear(); },
  };
}
export type TranscriptWindow = ReturnType<typeof observer>;

export function useTranscriptWindow(box: MutableRefObject<HTMLDivElement | null>, following: MutableRefObject<boolean>, settle: () => void) {
  const windowed = useMemo(() => observer(box), [box]);
  windowed.settle(settle);
  useLayoutEffect(settle);
  useLayoutEffect(() => {
    const el = box.current; if (!el) return;
    const match = (event: Event) => {
      const shell = (event.target as HTMLElement).closest<HTMLElement>('.transcript-row');
      if (shell) { following.current = false; windowed.reveal(shell); }
    };
    const reconsider = () => windowed.reconsider();
    el.addEventListener('beforematch', match);
    el.addEventListener('toggle', reconsider, true);
    document.addEventListener('selectionchange', reconsider);
    return () => {
      el.removeEventListener('beforematch', match); el.removeEventListener('toggle', reconsider, true);
      document.removeEventListener('selectionchange', reconsider); windowed.disconnect();
    };
  }, [windowed]);
  return windowed;
}

/** Native Find can search the text of unmounted rows without laying it out. */
export const TranscriptSpace = memo(function TranscriptSpace({ row, windowed, compact, children }: { row: WindowRow; windowed: TranscriptWindow; context: object; compact: boolean; children: () => ReactNode }) {
  const el = useRef<HTMLDivElement>(null);
  const [mounted, show] = useState(false);
  useLayoutEffect(() => { return el.current ? windowed.register(el.current, show) : undefined; }, [windowed]);
  return <div ref={el} data-id={row.id} data-mounted={mounted} className={`transcript-row${compact ? ' compact-after' : ''}`} style={mounted ? undefined : { height: windowed.heights.get(row.id) ?? row.estimate }}>
    {mounted ? children() : <div hidden={'until-found' as unknown as boolean}>{row.text}</div>}
  </div>;
}, (a, b) => a.row === b.row && a.context === b.context && a.compact === b.compact && a.windowed === b.windowed);
