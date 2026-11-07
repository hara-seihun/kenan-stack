// Widths of the wide layout's menu and list panes (Erin 2026-10-28: narrower by default, and resizable). Each is what
// she dragged it to, kept per person on this device, or its default; the open chat keeps at least DETAIL_MIN.
export type Pane = 'nav' | 'list';
export const PANES: Record<Pane, { min: number; initial: number; max: number }> = {
  nav: { min: 160, initial: 200, max: 360 },
  list: { min: 260, initial: 320, max: 560 },
};
export const DETAIL_MIN = 400;

/** What she chose for each pane; null: never resized (or reset), so the default. */
export type Chosen = Record<Pane, number | null>;
export const UNCHOSEN: Chosen = { nav: null, list: null };

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | undefined;
const key = (personId: string) => `kenan.panes.${personId}`;
const valid = (pane: Pane, value: unknown): number | null =>
  typeof value === 'number' && Number.isInteger(value) && value >= PANES[pane].min && value <= PANES[pane].max ? value : null;

export function readChosen(personId: string, storage: Store = globalThis.localStorage): Chosen {
  try {
    const raw = storage?.getItem(key(personId));
    if (!raw) return UNCHOSEN;
    const kept = JSON.parse(raw) as Record<string, unknown>;
    return { nav: valid('nav', kept?.nav), list: valid('list', kept?.list) };
  } catch { return UNCHOSEN; }
}

export function saveChosen(personId: string, chosen: Chosen, storage: Store = globalThis.localStorage): void {
  try {
    if (chosen.nav === null && chosen.list === null) storage?.removeItem(key(personId));
    else storage?.setItem(key(personId), JSON.stringify(chosen));
  } catch { /* private mode: kept for this page only */ }
}

export const clampPane = (pane: Pane, width: number): number => Math.round(Math.min(PANES[pane].max, Math.max(PANES[pane].min, width)));

/** The widths drawn in a layout `total` px wide: her choices within their bounds, then, when the open chat would get
 *  less than DETAIL_MIN, the list and then the menu give way down to their minimums. */
export function paneWidths(chosen: Chosen, total: number): Record<Pane, number> {
  let nav = clampPane('nav', chosen.nav ?? PANES.nav.initial), list = clampPane('list', chosen.list ?? PANES.list.initial);
  let over = nav + list + DETAIL_MIN - total;
  if (over > 0) { const give = Math.min(over, list - PANES.list.min); list -= give; over -= give; }
  if (over > 0) nav -= Math.min(over, nav - PANES.nav.min);
  return { nav, list };
}
