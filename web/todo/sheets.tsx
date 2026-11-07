// Bottom sheets of the to-do screens (instead of the browser's prompt boxes): a text field and an action list. Back closes an
// open sheet (useOverlay).
import { useState, type FormEvent, type ReactNode } from 'react';
import { useOverlay } from '../overlay.js';
import { useAboveKeyboard, useFocusInside } from '../menuPlacement.js';

export function Sheet({ label, close, children }: { label: string; close(): void; children: ReactNode }) {
  useOverlay(true, close);
  const ref = useAboveKeyboard<HTMLDivElement>();
  useFocusInside(ref);
  return <><button className="org-scrim" aria-label="Close" onClick={close}/><div className="org-bottom" ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-label={label}>{children}</div></>;
}

export type Ask =
  | { kind: 'text'; title: string; label: string; value: string; hint?: string; multiline?: boolean; save(value: string): void }
  | { kind: 'actions'; title: string; actions: SheetAction[] };
/** One line of an action sheet: a button, or a label with a row of choices (the current one marked). */
export type SheetAction =
  | { kind: 'do'; label: string; run(): void; danger?: boolean }
  | { kind: 'choices'; label: string; choices: { label: string; current: boolean; run(): void }[] };

export function AskSheet({ ask, close }: { ask: Ask; close(): void }) {
  const done = (f: () => void) => { close(); f(); };
  switch (ask.kind) {
    case 'text': return <TextSheet ask={ask} close={close}/>;
    case 'actions': return <Sheet label={ask.title} close={close}><h2 className="org-sheet-h org-sheet-title">{ask.title}</h2>
      <div className="org-choose">{ask.actions.map(a => a.kind === 'do'
        ? <button key={a.label} className={a.danger ? 'org-danger' : undefined} onClick={() => done(a.run)}>{a.label}</button>
        : <div key={a.label} className="org-choice-row"><span>{a.label}</span><div className="org-chips" role="radiogroup" aria-label={a.label}>{a.choices.map(c => <button key={c.label} role="radio" aria-checked={c.current} onClick={() => done(c.run)}>{c.label}</button>)}</div></div>)}</div>
      <div className="org-sheet-actions"><button className="org-grey" onClick={close}>Cancel</button></div></Sheet>;
  }
}
function TextSheet({ ask, close }: { ask: Extract<Ask, { kind: 'text' }>; close(): void }) {
  const [value, setValue] = useState(ask.value);
  const submit = (e: FormEvent) => { e.preventDefault(); close(); ask.save(value.trim()); };
  return <Sheet label={ask.title} close={close}><form className="org-ev-form" onSubmit={submit}>
    <h2 className="org-sheet-h">{ask.title}</h2>
    {ask.multiline ? <textarea aria-label={ask.label} placeholder={ask.label} rows={3} autoFocus value={value} onChange={e => setValue(e.target.value)}/> : <input aria-label={ask.label} placeholder={ask.label} autoFocus value={value} onChange={e => setValue(e.target.value)} enterKeyHint="done"/>}
    {ask.hint && <p className="org-quiet">{ask.hint}</p>}
    <div className="org-sheet-actions"><button type="button" className="org-grey" onClick={close}>Cancel</button><button type="submit" className="org-grey org-save">Save</button></div>
  </form></Sheet>;
}
