import { lazy, Suspense } from 'react';
import { LoaderCircle, CircleAlert } from 'lucide-react';
import { object, type ToolPart } from './toolData.js';
import { draftLine, iconOf, line } from './toolLines.js';
import { FoldCard } from './FoldCard.js';
import { useToolReferences } from './toolReferences.js';
export { toolTitle } from './toolLines.js';

const ToolBody = lazy(() => import('./ToolBody.js'));
const DraftBody = lazy(() => import('./ToolBody.js').then(m => ({ default: m.DraftBody })));

/** The same compact category and summary as background inputs, opening into the full call. */
export function ToolCall({ part, messageState, clipped, onOpen }: { part: ToolPart; messageState: string; clipped: boolean; onOpen: (() => void) | undefined }) {
  const Icon = iconOf(part.name);
  const { title, subject, note, problem } = part.draft ? draftLine({ ...part, draft: part.draft }) : line(part);
  const args = object(part.args);
  const duplicateNote = part.name === 'workers' && args.action === 'message' && !problem;
  const references = useToolReferences(part, [title, subject?.text || problem || note || '', duplicateNote ? '' : problem || note || '', part.name === 'send' ? args.to : ''].join('\n'));
  const chatTo = part.name === 'send' && typeof args.to === 'string' && args.to.startsWith('kenan:') ? references.label(args.to).slice(6) : null;
  const category = chatTo ? title.replace(/to a chat$/, `to ${chatTo}`) : references.lineText(title);
  const running = part.result === null && messageState === 'streaming';
  const summary = references.lineText(subject?.text || problem || note || (running ? 'Running…' : part.result === null ? 'No result yet' : 'Done'));
  const status = part.isError ? <CircleAlert size={15} aria-label="Failed"/> : running ? <LoaderCircle size={15} className="spin" aria-label="Running"/> : null;
  return <FoldCard category={category} summary={summary} icon={<Icon size={15} className="tool-icon"/>} status={status} failed={part.isError} onOpen={onOpen}>
    {open => open ? <>
      {(note || problem) && !duplicateNote && <p className={`tool-note${problem ? ' tool-problem' : ''}`}>{references.lineText(problem || note || '')}</p>}
      {part.draft ? <Suspense fallback={null}><DraftBody args={part.args}/></Suspense>
        : <Suspense fallback={<p className="tool-wait">Loading…</p>}>{clipped ? <p className="tool-wait">Loading…</p> : <ToolBody part={part}/>}</Suspense>}
    </> : null}
  </FoldCard>;
}
