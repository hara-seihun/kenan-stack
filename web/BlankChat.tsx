// Blank chats (server/agents/blank.ts): a fresh model of her choice with no context, only file and shell tools, closed when
// she is done. The picker in the 🧪 popover (web/BlankButton.tsx), the same in both layouts: a thinking-level row on top and
// the models as rows; tapping a model starts the chat at once. The last model and level she used come first next time.
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from 'react';
import { useOverlay } from './overlay.js';
import type { BlankModel } from '../shared/contract.js';
import { api } from './client.js';
import { popoverPlace, type BlankStarted } from './blank.js';
import './blankChat.css';

const startBlankChat = (model: string, thinking: string) => api<BlankStarted>('/blank-chats', 'POST', { model, thinking });

export const LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const;
const rank = (level: string) => LEVELS.indexOf(level as typeof LEVELS[number]);
export const DEFAULT_LEVEL = 'high';

/** The level a model runs at for the level she chose: that one, else the highest it has below it, else its lowest. */
export function levelFor(m: BlankModel, chosen: string): string {
  if (m.thinking.includes(chosen)) return chosen;
  const below = m.thinking.filter(l => rank(l) <= rank(chosen)).sort((a, b) => rank(b) - rank(a));
  return below[0] ?? [...m.thinking].sort((a, b) => rank(a) - rank(b))[0] ?? chosen;
}
/** The levels any model offers, in order; the row on top of the picker. */
export const levelsOf = (models: BlankModel[]) => LEVELS.filter(l => models.some(m => m.thinking.includes(l)));
/** Her last choice first, the rest in the route's order. */
export const ordered = (models: BlankModel[], last: string | null) => [...models.filter(m => m.model === last), ...models.filter(m => m.model !== last)];

const KEY = 'kenan.blank.last';
export function lastChoice(storage: Pick<Storage, 'getItem'>): { model: string; thinking: string } | null {
  try { const v = JSON.parse(storage.getItem(KEY) ?? 'null'); return v && typeof v.model === 'string' && typeof v.thinking === 'string' ? v : null; } catch { return null; }
}
const remember = (model: string, thinking: string) => { try { localStorage.setItem(KEY, JSON.stringify({ model, thinking })); } catch { /* private mode: nothing to remember */ } };

function BlankPicker({ started }: { started(chat: BlankStarted): void }) {
  const last = lastChoice(localStorage);
  const [models, setModels] = useState<BlankModel[] | null>(null), [problem, setProblem] = useState('');
  const [level, setLevel] = useState(last?.thinking ?? DEFAULT_LEVEL), [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api<BlankModel[]>('/blank-chats/models').then(list => { if (live) setModels(list); },
      e => { if (live) setProblem(`Couldn't list the models: ${e instanceof Error ? e.message : String(e)}`); });
    return () => { live = false; };
  }, []);
  const start = (m: BlankModel) => {
    if (busy) return;
    const thinking = levelFor(m, level);
    setBusy(m.model); setProblem('');
    startBlankChat(m.model, thinking).then(chat => { remember(m.model, thinking); started(chat); }, err => { setProblem(`Couldn't start it: ${err instanceof Error ? err.message : String(err)}`); setBusy(null); });
  };
  return <div className="blank-picker">
    {models === null && !problem && <p className="blank-hint">Loading models…</p>}
    {models && <>
      <div className="blank-levels" role="radiogroup" aria-label="Thinking">{levelsOf(models).map(l => <button key={l} type="button" role="radio" aria-checked={l === level} onClick={() => setLevel(l)}>{l === 'xhigh' ? 'max' : l}</button>)}</div>
      <ul className="blank-models">{ordered(models, last?.model ?? null).map(m => { const at = levelFor(m, level); return <li key={m.model}>
        <button type="button" disabled={busy !== null} onClick={() => start(m)}><span>{m.name}</span>{busy === m.model ? <small>Starting…</small> : at !== level ? <small>{at}</small> : m.model === last?.model ? <small>last used</small> : null}</button>
      </li>; })}</ul>
    </>}
    {problem && <p className="blank-hint" role="alert">{problem}</p>}
    <p className="blank-hint">No context: it only knows it can use files and the shell here. Close it when you're done.</p>
  </div>;
}

/** The popover under the 🧪 button: placed inside the screen, closed by Back, Escape or a tap outside it. */
export default function BlankPopover({ anchor, close, started }: { anchor: RefObject<HTMLButtonElement | null>; close(): void; started(chat: BlankStarted): void }) {
  const [place, setPlace] = useState<CSSProperties | null>(null), pop = useRef<HTMLDivElement>(null);
  useOverlay(true, close);
  useLayoutEffect(() => {
    const at = () => { const r = anchor.current?.getBoundingClientRect(); if (r) setPlace(popoverPlace(r, { width: innerWidth, height: innerHeight })); };
    at(); addEventListener('resize', at); return () => removeEventListener('resize', at);
  }, [anchor]);
  useEffect(() => {
    const outside = (e: PointerEvent) => { const t = e.target as Node; if (!pop.current?.contains(t) && !anchor.current?.contains(t)) close(); };
    document.addEventListener('pointerdown', outside); return () => document.removeEventListener('pointerdown', outside);
  }, [anchor, close]);
  return place && <div ref={pop} className="blank-pop" role="dialog" aria-label="Blank chat" style={place}><BlankPicker started={started}/></div>;
}
