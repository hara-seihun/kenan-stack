// The in-app viewer for an HTML file, like Claude's artifacts (Dave 2026-10-23), the reader for Markdown and other
// text files (Alice 2026-10-26: Markdown renders with the chat's own renderer, other text is monospace) and for PDFs
// (Alice 2026-10-31, PdfDocument.tsx). On a wide screen it is a panel docked
// to the right: the app keeps working beside it in the space left over, a divider resizes it (the width is kept per
// device) and it can go full screen. On a phone it is a full-screen sheet. Opening another file swaps its content.
// The page runs in a sandboxed frame without allow-same-origin, and the server serves it under the same sandbox as
// its CSP (server/files/files.ts), so even opened on its own it never has the app's origin: no cookies, storage or
// API, no top navigation. Its links to other pages open a new browsing context (the server adds that to the page).
import { useEffect, useState, type MouseEvent } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Download, Maximize, Minimize, X } from 'lucide-react';
import type { TextKind } from '../shared/textFile.js';
import { MessageMarkdown } from './MessageMarkdown.js';
import { useOverlay } from './overlay.js';
import { PdfDocument } from './PdfDocument.js';
import { Divider } from './Divider.js';
import './FileViewer.css';

/** An HTML page shown live from its sandboxed `view` URL, or a text file read from `url` and drawn by the app. */
export type ViewedFile = { name: string; download: string } & ({ kind: 'html'; view: string } | { kind: 'pdf'; fileId: string } | { kind: TextKind; url: string; size: number });

/** Larger files stay downloads: rendering megabytes of Markdown, or painting tens of megabytes of text, would stall a phone. */
const READ_LIMIT: Record<TextKind, number> = { markdown: 2 * 1024 * 1024, text: 8 * 1024 * 1024 };

type Reading = { state: 'loading' } | { state: 'ready'; text: string } | { state: 'failed'; reason: string } | { state: 'large' };

/** JSON on one line (most generated JSON) is shown indented; anything that doesn't parse is shown as it is. */
function shown(name: string, text: string): string {
  if (!/\.(json|ipynb)$/i.test(name)) return text;
  try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return text; }
}

/** Only links that leave for a site, mail or a phone number act; a document's relative links and #anchors would load
 * the app's own address in place of the app, so they do nothing. */
function keepInApp(event: MouseEvent) {
  const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
  if (link && !/^(?:https?:|mailto:|tel:)/i.test(link.getAttribute('href') ?? '')) event.preventDefault();
}

function TextDocument({ file }: { file: Extract<ViewedFile, { kind: TextKind }> }) {
  const [reading, setReading] = useState<Reading>({ state: 'loading' });
  useEffect(() => {
    if (file.size > READ_LIMIT[file.kind]) { setReading({ state: 'large' }); return; }
    const abort = new AbortController();
    setReading({ state: 'loading' });
    fetch(file.url, { signal: abort.signal, credentials: 'same-origin' })
      .then(async r => r.ok ? setReading({ state: 'ready', text: shown(file.name, new TextDecoder().decode(await r.arrayBuffer())) })
        : setReading({ state: 'failed', reason: `the server answered ${r.status}` }))
      .catch((e: unknown) => { if (!abort.signal.aborted) setReading({ state: 'failed', reason: e instanceof Error ? e.message : String(e) }); });
    return () => abort.abort();
  }, [file.url, file.kind, file.size, file.name]);
  switch (reading.state) {
    case 'loading': return <div className="doc-scroll"><p className="doc-note">Loading…</p></div>;
    case 'large': return <div className="doc-scroll"><p className="doc-note">This file is too large to read here. <a href={file.download} download={file.name}>Download it</a></p></div>;
    case 'failed': return <div className="doc-scroll"><p className="doc-note" role="alert">Couldn't read this file: {reading.reason}. <a href={file.download} download={file.name}>Download it</a></p></div>;
    case 'ready': return <div className="doc-scroll" onClick={keepInApp}>{file.kind === 'markdown'
      ? <article className="doc message-body"><MessageMarkdown source="agent" text={reading.text}/></article>
      : <pre className="doc-text">{reading.text}</pre>}</div>;
  }
}

/** Narrower than this the viewer is a full-screen sheet (the app's phone breakpoint). */
const PHONE = '(max-width: 700px)';
/** The docked panel is at least this wide and leaves the app at least its minimum (the chat column, or what a module's own
 * layout needs: setAppMinimum); unset, it takes DEFAULT_SHARE of the window. */
const PANEL_MIN = 320, CLASSIC_MIN = 380, DEFAULT_SHARE = 0.45;
let moduleMinimum: (() => number) | null = null;
/** A module's layout says how much of the window it needs beside the docked panel (null: Classic's chat column). */
export const setAppMinimum = (minimum: (() => number) | null) => { moduleMinimum = minimum; };
const appMin = () => moduleMinimum?.() ?? CLASSIC_MIN;
const WIDTH_KEY = 'kenan.artifactWidth';
const DOCKED = 'artifact-docked';

/** The width the person last left the panel at on this device, or null when they never resized it. */
function savedWidth(): number | null {
  try {
    const value = Number(localStorage.getItem(WIDTH_KEY));
    return Number.isInteger(value) && value > 0 ? value : null;
  } catch { return null; }
}
function saveWidth(width: number): void {
  try { localStorage.setItem(WIDTH_KEY, String(width)); } catch { /* private mode: kept for this page only */ }
}

const panelWidth = (wanted: number | null, viewport: number): number =>
  Math.round(Math.max(PANEL_MIN, Math.min(wanted ?? viewport * DEFAULT_SHARE, viewport - appMin())));

function useMatch(query: string): boolean {
  const [matches, setMatches] = useState(() => matchMedia(query).matches);
  useEffect(() => {
    const list = matchMedia(query), changed = () => setMatches(list.matches);
    list.addEventListener('change', changed);
    return () => list.removeEventListener('change', changed);
  }, [query]);
  return matches;
}

function useViewportWidth(): number {
  const [width, setWidth] = useState(innerWidth);
  useEffect(() => {
    const resized = () => setWidth(innerWidth);
    addEventListener('resize', resized);
    return () => removeEventListener('resize', resized);
  }, []);
  return width;
}

function Artifact({ file, close }: { file: ViewedFile; close: () => void }) {
  const phone = useMatch(PHONE);
  const viewport = useViewportWidth();
  const [full, setFull] = useState(false);
  const [wanted, setWanted] = useState(savedWidth);
  const width = panelWidth(wanted, viewport);
  const docked = !phone;

  useOverlay(phone || full, phone ? close : () => setFull(false));
  useEffect(() => {
    if (!docked) return;
    const html = document.documentElement;
    html.classList.add(DOCKED);
    html.style.setProperty('--artifact-width', `${width}px`);
    return () => { html.classList.remove(DOCKED); html.style.removeProperty('--artifact-width'); };
  }, [docked, width]);

  const mode = phone ? 'sheet' : full ? 'full' : 'docked';
  return <section className={`artifact ${mode}${file.kind === 'html' ? '' : ' reader'}`} aria-label={file.name}>
    {mode === 'docked' && <Divider className="artifact-divider" label="Resize the panel" width={width} min={PANEL_MIN} max={Math.max(PANEL_MIN, viewport - appMin())}
      widthAt={x => innerWidth - x} grows="ArrowLeft"
      resize={(next, done) => { const w = panelWidth(next, innerWidth); setWanted(w); if (done) saveWidth(w); }}
      reset={() => { setWanted(null); try { localStorage.removeItem(WIDTH_KEY); } catch { /* nothing kept */ } }}/>}
    <header>
      <strong title={file.name}>{file.name}</strong>
      {!phone && <button type="button" aria-label={full ? 'Exit full screen' : 'Full screen'} aria-pressed={full} onClick={() => setFull(!full)}>{full ? <Minimize size={17}/> : <Maximize size={17}/>}</button>}
      <a href={file.download} download={file.name} aria-label={`Download ${file.name}`}><Download size={17}/></a>
      <button type="button" aria-label="Close" onClick={close}><X size={18}/></button>
    </header>
    {file.kind === 'html'
      ? <iframe key={file.view} src={file.view} title={file.name} sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox allow-forms allow-modals" referrerPolicy="no-referrer"/>
      : file.kind === 'pdf' ? <PdfDocument key={file.fileId} fileId={file.fileId} name={file.name} download={file.download}/>
      : <TextDocument key={file.url} file={file}/>}
  </section>;
}

let root: Root | null = null;

/** Shows `file` in the viewer, replacing whatever it showed. The viewer is its own React root beside the app's, so it
 * stays open while the person moves between chats and layouts. */
export function showFile(file: ViewedFile): void {
  if (!root) {
    const host = document.createElement('div');
    host.className = 'artifact-host';
    document.body.append(host);
    root = createRoot(host);
  }
  root.render(<Artifact file={file} close={() => root?.render(null)}/>);
}
