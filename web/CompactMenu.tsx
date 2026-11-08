// The bottom of a sidebar (Classic sidebar, Organized wide nav and ☰ sheet): the places she goes often as one row of
// tiles, and the things she sets rarely (layout, toggles, notifications, app update, account) behind a ⚙ Settings tile.
import { useEffect, useState, type ComponentType, type ReactNode } from 'react';
import type { FooterIconId } from './FooterIcon.js';

type IconView = ComponentType<{ id: FooterIconId }>;
let loaded: IconView | null = null;
const loading = import('./FooterIcon.js').then(m => { loaded = m.default; return m.default; });
/** The icons are their own chunk, fetched right after the first paint. Until it arrives (or if it never does) a tile keeps its place with an empty box the icon's size. */
function Icon({ id }: { id: FooterIconId }) {
  const [shown, setShown] = useState<{ view: IconView } | null>(loaded && { view: loaded });
  useEffect(() => { if (!shown) void loading.then(view => setShown({ view }), () => {}); }, [shown]);
  return shown ? <shown.view id={id}/> : <span aria-hidden="true"/>;
}

/** dot: something new waits there (Organized's 📰 What's new). */
export type Place = { id: string; icon: FooterIconId; label: string; title: string; current: boolean; dot: boolean; go(): void };

/** tray: the person's chosen tiles in order (Bootstrap.trayTiles); null shows every place. ⚙ Settings always shows.
 * `'toggle'` folds the settings above the tiles behind ⚙; `'shown'` (a menu sheet with room to spare) lists them under the tiles. */
export function CompactMenu({ places, tray, settings, mode }: { places: Place[]; tray: readonly string[] | null; settings: ReactNode; mode: 'toggle' | 'shown' }) {
  const [open, setOpen] = useState(false);
  const shown = tray ? tray.flatMap(id => places.filter(p => p.id === id)) : places;
  const panel = (mode === 'shown' || open) && <div className="cm-settings" id="cm-settings" role="group" aria-label="Settings">{settings}</div>;
  return <div className="cm">
    {mode === 'toggle' && panel}
    <div className="cm-tiles">
      {shown.map(p => <button key={p.id} className="cm-tile" title={p.title} aria-current={p.current ? 'page' : undefined} onClick={() => { setOpen(false); p.go(); }}><Icon id={p.icon}/><small>{p.label}</small>{p.dot && <i className="cm-dot" role="img" aria-label="new"/>}</button>)}
      {mode === 'toggle' && <button className="cm-tile" aria-expanded={open} aria-controls="cm-settings" onClick={() => setOpen(!open)}><Icon id="settings"/><small>Settings</small></button>}
    </div>
    {mode === 'shown' && panel}
  </div>;
}
