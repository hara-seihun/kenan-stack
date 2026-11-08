// An open tool card: the complete tool detail and any images it returned.
import { useLayoutEffect, useRef, useState } from 'react';
import { UNSHOWN_NOTE } from '../shared/toolNotes.js';
import { firstLine, outcome, text, type Outcome, type ToolPart } from './toolData.js';
import { bodyOf, Generic, type Ctx } from './toolBodies.js';
import { Fold } from './toolUi.js';
import { useToolReferences } from './toolReferences.js';

/** An image a tool returned (a screenshot), as a thumbnail that opens to full size. */
function Shot({ src, alt }: { src: string; alt: string }) {
  const [full, setFull] = useState(false);
  return <img className={`tb-image${full ? ' full' : ''}`} alt={alt} src={src} onClick={() => setFull(f => !f)}/>;
}

/** The text a draft card previews: the longest string in the call so far (a file's content, a command, an edit's new text). */
function draftText(args: unknown): string {
  let longest = '';
  const walk = (v: unknown): void => { if (typeof v === 'string') { if (v.length > longest.length) longest = v; } else if (v !== null && typeof v === 'object') Object.values(v).forEach(walk); };
  walk(args);
  return longest;
}

/** A call the model is still writing, opened: its newest text, kept scrolled to the end as it grows. */
export function DraftBody({ args }: { args: unknown }) {
  const box = useRef<HTMLPreElement>(null);
  const value = draftText(args);
  useLayoutEffect(() => { const el = box.current; if (el) el.scrollTop = el.scrollHeight; }, [value]);
  return <pre ref={box} className="tool-draft">{value || 'Starting…'}</pre>;
}

export default function ToolBody({ part }: { part: ToolPart }) {
  const references = useToolReferences(part);
  const a = references.args;
  const o: Outcome = part.result === null ? { texts: [], images: [], details: {} } : outcome(part.result);
  const out = o.texts.filter(t => t !== UNSHOWN_NOTE).join('\n\n');
  const c: Ctx = { a, o, out, j: references.result, action: text(a.action), failed: part.isError };
  const own = bodyOf(part.name);
  const failedPlainly = part.isError && !['bash', 'read', 'write', 'edit', 'browser'].includes(part.name);
  return <div className="tool-body">
    {failedPlainly ? <><Fold value={out || 'Failed with no message.'} lines={12} mono={false} className="bad"/><Generic {...c} j={null} out=""/></>
      : own ? own(c) : <Generic {...c}/>}
    {o.images.map((img, i) => <Shot key={i} alt={`Image ${i + 1} from ${part.name}`} src={`data:${img.mime};base64,${img.data}`}/>)}
    {firstLine(out) === '' && part.result === null && <p className="tb-muted">No result yet.</p>}
  </div>;
}
