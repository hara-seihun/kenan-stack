// Overlays close topmost-first on back or Escape. While any is open the page holds exactly one extra history entry,
// so a browser's back pops that entry instead of leaving the app.

export interface Navigation {
  marked(): boolean;
  push(): void;
  back(): void;
  unmark(): void;
}

type Entry = 'absent' | 'present' | 'leaving';
type Overlay = { close: () => void };

export function overlayStack(nav: Navigation) {
  const open: Overlay[] = [];
  let entry: Entry = 'absent';
  if (nav.marked()) nav.unmark();
  let scheduled = false;

  function reconcile() {
    scheduled = false;
    if (open.length > 0 && entry === 'absent') { nav.push(); entry = 'present'; }
    else if (open.length === 0 && entry === 'present') { entry = 'leaving'; nav.back(); }
  }
  const schedule = () => { if (!scheduled) { scheduled = true; queueMicrotask(reconcile); } };

  /** Closes the topmost overlay; false when none is open, so back belongs to the app or system. */
  function dismissTop(): boolean {
    const top = open.pop();
    if (!top) return false;
    top.close();
    schedule();
    return true;
  }

  return {
    register(overlay: Overlay): () => void {
      open.push(overlay); schedule();
      return () => { const i = open.indexOf(overlay); if (i >= 0) { open.splice(i, 1); schedule(); } };
    },
    dismissTop,
    /** The history entry this stack pushed was popped (browser back, or our own back after the last overlay closed). */
    popped(): void {
      const previous = entry;
      entry = 'absent';
      if (previous === 'present') dismissTop();
      schedule();
    },
    get depth() { return open.length; },
  };
}
