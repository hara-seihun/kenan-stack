// The 🛒 To buy tab of the To-do screen (Carol's approved mockup design/shopping/shop-S.png, 2026-10-22): one list in
// coloured sections; the circle marks an item bought (it fades, then leaves, with Undo); tapping the words edits them in
// place and never opens a chat; a long-press drags a row (rowDrag.ts) within its section or into another. Kenaznia adds
// items and manages sections; a section with nothing in it isn't shown.
// Loaded only when the tab opens. Server: server/extensions/shopping.ts.
import { useEffect, useRef, useState, type RefObject } from 'react';
import type { BuyItem, BuyList, BuySection } from '../../shared/contract.js';
import { api } from '../client.js';
import { useOverlay } from '../overlay.js';
import type { Ask } from './sheets.js';
import { buyDropPlan, demoList, sectionRows, type DemoState } from './buyRows.js';
import { useRowDrag, type RowDrag } from './rowDrag.js';
import './toBuy.css';

/** How long a bought item stays on screen, faded and struck through, before it leaves the list. */
export const LEAVE_MS = 1400;

export interface ToBuyProps {
  /** The To-do screen's scrolling box, which a dragged row scrolls and measures against. */
  scroll: RefObject<HTMLElement | null>;
  list: BuyList | null; setList(list: BuyList): void; demo: boolean;
  say(text: string, undo?: (() => void) | null): void; ask(a: Ask): void;
}
/** Every change answers the whole list (the server's, or the demo's in memory). */
interface BuySource {
  load(): Promise<BuyList>;
  add(sectionId: string, text: string): Promise<BuyList>;
  item(id: string, patch: { text?: string; sectionId?: string; bought?: boolean; position?: number }): Promise<BuyList>;
  remove(id: string): Promise<BuyList>;
}
const at = (id: string) => encodeURIComponent(id);
const serverSource: BuySource = {
  load: () => api<BuyList>('/ext/todos/buy'),
  add: (sectionId, text) => api<BuyList>('/ext/todos/buy/items', 'POST', { sectionId, text }),
  item: (id, patch) => api<BuyList>(`/ext/todos/buy/items/${at(id)}`, 'PATCH', patch),
  remove: id => api<BuyList>(`/ext/todos/buy/items/${at(id)}`, 'DELETE'),
};

/** Demo mode: the same answers as the server, from a copy in memory. */
function demoSource(state: { current: DemoState }): BuySource {
  const view = (): BuyList => ({ sections: [...state.current.sections].sort((a, b) => a.position - b.position), items: state.current.items.filter(i => !i.gone && i.boughtAt === null).sort((a, b) => a.position - b.position).map(({ gone: _g, ...i }) => i) });
  const end = (sectionId: string) => Math.max(0, ...state.current.items.filter(i => i.sectionId === sectionId).map(i => i.position)) + 1;
  const items = (f: (i: DemoState['items'][number]) => DemoState['items'][number]) => { state.current = { ...state.current, items: state.current.items.map(f) }; return view(); };
  return {
    load: async () => view(),
    add: async (sectionId, text) => { state.current = { ...state.current, items: [...state.current.items, { id: `demo-b-${Date.now()}`, sectionId, text, position: end(sectionId), boughtAt: null, gone: false }] }; return view(); },
    item: async (id, patch) => items(i => i.id !== id ? i : { ...i, ...(patch.text !== undefined ? { text: patch.text } : {}), ...(patch.sectionId !== undefined ? { sectionId: patch.sectionId, position: end(patch.sectionId) } : {}), ...(patch.position !== undefined ? { position: patch.position } : {}), ...(patch.bought !== undefined ? { boughtAt: patch.bought ? Date.now() : null } : {}) }),
    remove: async id => items(i => i.id === id ? { ...i, gone: true } : i),
  };
}

export default function ToBuy(p: ToBuyProps) {
  const demoState = useRef<DemoState>(demoList());
  const [demoView, setDemoView] = useState<BuyList | null>(null);
  const source = p.demo ? demoSource(demoState) : serverSource;
  const list = p.demo ? demoView : p.list;
  const show = p.demo ? setDemoView : p.setList;
  const [leaving, setLeaving] = useState<BuyItem[]>([]);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  useEffect(() => {
    const refresh = () => { void source.load().then(show, e => p.say(`Couldn't load the To buy list: ${String(e)}`)); };
    refresh();
    window.addEventListener('kenan-refresh', refresh);
    return () => window.removeEventListener('kenan-refresh', refresh);
  }, [p.demo]);
  useEffect(() => () => { for (const t of timers.current.values()) clearTimeout(t); }, []);
  const run = (change: Promise<BuyList>, failed: string) => change.then(l => { show(l); return true; }, e => { p.say(`${failed}: ${String(e)}`); return false; });
  const stopLeaving = (id: string) => { clearTimeout(timers.current.get(id)); timers.current.delete(id); setLeaving(l => l.filter(i => i.id !== id)); };
  const bought = (item: BuyItem) => {
    setLeaving(l => [...l.filter(i => i.id !== item.id), item]);
    timers.current.set(item.id, setTimeout(() => stopLeaving(item.id), LEAVE_MS));
    void run(source.item(item.id, { bought: true }), `Couldn't mark ${item.text} bought`).then(ok => { if (!ok) stopLeaving(item.id); });
    p.say(`✓ ${item.text} bought`, () => { stopLeaving(item.id); void run(source.item(item.id, { bought: false }), `Couldn't bring back ${item.text}`); });
  };
  const removed = (item: BuyItem) => {
    void run(source.remove(item.id), `Couldn't remove ${item.text}`);
    p.say(`Removed: ${item.text}`, () => void run(source.add(item.sectionId, item.text), `Couldn't bring back ${item.text}`).then(() => undefined));
  };
  const drag = useRowDrag<BuyItem, string>(p.scroll, (item, spot) => {
    if (!list) return;
    const plan = buyDropPlan(list, item, spot); if (!plan) return;
    const moved = (patch: { sectionId: string; position: number }) => show({ ...list, items: list.items.map(i => i.id === item.id ? { ...i, ...patch } : i).sort((a, b) => a.position - b.position) });
    moved(plan.patch);
    const reload = () => void source.load().then(show, () => undefined);
    void run(source.item(item.id, plan.patch), `Couldn't move ${item.text}`).then(ok => { if (!ok) reload(); });
    const to = list.sections.find(s => s.id === spot.section)!;
    p.say(plan.patch.sectionId === item.sectionId ? `Moved: ${item.text}` : `Moved to ${to.name}: ${item.text}`, () => void run(source.item(item.id, plan.undo), `Couldn't move back ${item.text}`));
  });
  if (!list) return <p className="org-quiet">Loading your list…</p>;
  const actions = { source, run, bought, removed, list, drag };
  return <div className="buy">
    {list.sections.map(s => ({ s, rows: sectionRows(list, leaving, s.id) })).filter(x => x.rows.length).map(({ s, rows }) => <Section key={s.id} s={s} rows={rows} {...p} {...actions}/>)}
    {drag.line && <div className="org-drop-line" style={{ top: drag.line.y }} aria-hidden="true"/>}
  </div>;
}

type Actions = { source: BuySource; run(change: Promise<BuyList>, failed: string): Promise<boolean>; bought(item: BuyItem): void; removed(item: BuyItem): void; list: BuyList; drag: RowDrag<BuyItem, string> };
function Section(p: ToBuyProps & Actions & { s: BuySection; rows: { item: BuyItem; fading: boolean }[] }) {
  const { s } = p;
  return <section className={p.drag.line?.section === s.id ? 'buy-section org-drop-target' : 'buy-section'} data-drop-section={s.id} style={{ background: `${s.color}22`, borderColor: `${s.color}55`, ['--buy' as string]: s.color }}>
    <h2 className="buy-h"><span>{s.emoji ? `${s.emoji} ` : ''}{s.name}</span></h2>
    <ul className="buy-rows">{p.rows.map(r => <Row key={r.item.id} {...p} item={r.item} fading={r.fading}/>)}</ul>
  </section>;
}

function Row(p: ToBuyProps & Actions & { item: BuyItem; fading: boolean; s: BuySection }) {
  const { item } = p, [editing, setEditing] = useState(false), [text, setText] = useState(item.text);
  const stop = () => setEditing(false);
  useOverlay(editing, stop);
  const save = () => {
    const t = text.trim(); stop();
    if (!t) p.removed(item);
    else if (t !== item.text) void p.run(p.source.item(item.id, { text: t }), `Couldn't change ${item.text}`);
  };
  const more = () => p.ask({ kind: 'actions', title: item.text, actions: [
    ...(p.list.sections.length > 1 ? [{ kind: 'choices' as const, label: '➡️ Move to', choices: p.list.sections.map(s => ({ label: `${s.emoji ?? ''} ${s.name}`.trim(), current: s.id === item.sectionId, run: () => { if (s.id !== item.sectionId) void p.run(p.source.item(item.id, { sectionId: s.id }), `Couldn't move ${item.text}`); } })) }] : []),
    { kind: 'do', label: '🗑️ Remove', danger: true, run: () => p.removed(item) },
  ] });
  const draggable = !p.fading && !editing, lifted = p.drag.liftedId === item.id;
  const drag = draggable ? { 'data-drag-id': item.id, onPointerDown: (ev: React.PointerEvent<HTMLLIElement>) => p.drag.press(ev, item), onContextMenu: (ev: React.MouseEvent) => ev.preventDefault() } : {};
  return <li className={['buy-row', p.fading && 'bought', draggable && 'draggable', lifted && 'lifted'].filter(Boolean).join(' ')} {...drag}>
    <button className="buy-check" role="checkbox" aria-checked={p.fading} aria-label={p.fading ? `${item.text}, bought` : `Bought: ${item.text}`} disabled={p.fading} onClick={() => p.bought(item)}><span/></button>
    {editing
      ? <form className="buy-edit" onSubmit={e => { e.preventDefault(); save(); }}><input aria-label={`Edit ${item.text}`} value={text} autoFocus onChange={e => setText(e.target.value)} onBlur={save} enterKeyHint="done"/><button type="button" className="org-more" aria-label={`More for ${item.text}`} onPointerDown={e => e.preventDefault()} onClick={() => { stop(); more(); }}>⋯</button></form>
      : <button className="buy-text" disabled={p.fading} onClick={() => { setText(item.text); setEditing(true); }}>{item.text}</button>}
  </li>;
}
