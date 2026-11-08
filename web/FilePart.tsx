import { useEffect, useRef, useState } from 'react';
import { Download, File, Maximize, Minimize, Pause, Play, X } from 'lucide-react';
import type { GalleryItem } from './gallery.js';
import { VIEWER_QUERY, pdfFile, type MessagePart } from '../shared/contract.js';
import { textKind, type TextKind } from '../shared/textFile.js';
import { apiPath } from './path.js';
import { useOverlay } from './overlay.js';

/** Taller than this many widths, an inline image is shown as its top part at a readable width instead of a sliver. */
const TALL = 2.2;

const fileUrl = (fileId: string, download = false) => apiPath(`/api/files/${fileId}${download ? '?download=1' : ''}`);
const viewUrl = (fileId: string) => apiPath(`/api/files/${fileId}?${VIEWER_QUERY}=1`);

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

type ViewerModule = typeof import('./ImageViewer.js');
type Viewer = ViewerModule['ImageViewer'];
type Opening = { items: GalleryItem[]; start: number };
let viewer: Promise<ViewerModule> | null = null;
/** The image viewer, its gesture code, the gallery reader and the file viewer (HTML, Markdown, text) load on first open, outside the startup budget. */
const loadViewer = (): Promise<ViewerModule> => viewer ??= import('./ImageViewer.js').catch(e => { viewer = null; throw e; });

/** Opens the full-screen image viewer (an overlay: Back closes it and leaves the page as it was). */
export function useImageViewer() {
  const [open, setOpen] = useState<Opening & { Viewer: Viewer } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  /** An opening, or the tapped image whose transcript the gallery is read from once the viewer has loaded. */
  const show = (opening: Opening | { from: HTMLElement; fileId: string }) => loadViewer().then(
    m => { setFailed(null); setOpen({ ...'from' in opening ? m.gallery(opening.from, opening.fileId) : opening, Viewer: m.ImageViewer }); },
    (e: unknown) => setFailed(`Couldn't open the image viewer: ${e instanceof Error ? e.message : String(e)}`));
  return { show, failed, viewer: open && <open.Viewer items={open.items} start={open.start} close={() => setOpen(null)}/> };
}

function ImageAttachment({ fileId }: { fileId: string }) {
  const { show, failed, viewer } = useImageViewer();
  const [shape, setShape] = useState<'loading' | 'tall' | 'regular' | 'broken'>('loading');
  const tall = shape === 'tall';
  return <>
    <button type="button" data-file-id={fileId} className={`image-attachment ${shape}`} aria-label="Open image" onClick={event => void show({ from: event.currentTarget, fileId })}>
      <img loading="lazy" src={fileUrl(fileId)} alt="Attachment" onError={() => setShape('broken')} onLoad={event => setShape(event.currentTarget.naturalHeight > TALL * event.currentTarget.naturalWidth ? 'tall' : 'regular')}/>
      {tall && <span>Tap to see the whole image</span>}
      {failed && <span role="alert">{failed}</span>}
    </button>
    {viewer}
  </>;
}

export function formatTime(seconds: number): string {
  const whole = Math.floor(seconds), h = Math.floor(whole / 3600), m = Math.floor(whole / 60) % 60, s = String(whole % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

type Media = 'audio' | 'video';

/** The player this browser can draw for a file, or null when it stays a download. QuickTime (.mov) reports no
 * support in Chromium yet usually holds H.264 it decodes, so it is tried and says "Can't play here" if it fails. */
function mediaOf(mime: string): Media | null {
  const base = mime.split(';', 1)[0]!.trim().toLowerCase();
  const media = base.startsWith('audio/') ? 'audio' : base.startsWith('video/') ? 'video' : null;
  if (!media) return null;
  return base === 'video/quicktime' || document.createElement(media).canPlayType(mime) !== '' ? media : null;
}

/** One recording or video plays at a time: starting one pauses whichever was playing. */
let playing: HTMLMediaElement | null = null;
const started = (el: HTMLMediaElement) => { if (playing && playing !== el) playing.pause(); playing = el; };
const stopped = (el: HTMLMediaElement) => { if (playing === el) playing = null; };

type Playback = { kind: 'loading' } | { kind: 'ready'; duration: number } | { kind: 'failed' };

/** An audio or video attachment: play/pause, scrub bar, position/duration, filename and download, one playing at a
 * time. A video shows its first frame at its own aspect within the message width; tapping it plays or pauses, and
 * fullscreen is the app's own overlay (the Android WebView has no native fullscreen), which also asks the browser for
 * fullscreen where that is allowed. In fullscreen a tap shows or hides the overlaid controls; playing hides them
 * after 2.5 seconds without interaction. A file the browser can't decode says "Can't play here" and keeps its download. */
function MediaAttachment({ part, media }: { part: Extract<MessagePart, { type: 'file' }>; media: Media }) {
  const element = useRef<HTMLAudioElement & HTMLVideoElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [playback, setPlayback] = useState<Playback>({ kind: 'loading' });
  const [paused, setPaused] = useState(true);
  const [position, setPosition] = useState(0);
  const [aspect, setAspect] = useState<number | null>(null);
  const [full, setFull] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [controlActivity, setControlActivity] = useState(0);
  const [adjusting, setAdjusting] = useState(false);
  const revealControls = () => { setControlsVisible(true); setControlActivity(n => n + 1); };
  useEffect(() => {
    if (!full || paused || !controlsVisible || adjusting) return;
    const timer = window.setTimeout(() => setControlsVisible(false), 2500);
    return () => window.clearTimeout(timer);
  }, [full, paused, controlsVisible, controlActivity, adjusting]);
  const close = () => { setFull(false); if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined); };
  useOverlay(full, close);
  useEffect(() => {
    if (!full) return;
    if (box.current && document.fullscreenEnabled && !('KenanNext' in window)) void box.current.requestFullscreen().catch(() => undefined);
    const left = () => { if (!document.fullscreenElement) setFull(false); };
    document.addEventListener('fullscreenchange', left);
    return () => document.removeEventListener('fullscreenchange', left);
  }, [full]);
  const toggle = () => {
    const el = element.current;
    if (!el) return;
    if (!el.paused) { el.pause(); return; }
    void el.play().catch(() => setPlayback({ kind: 'failed' }));
  };
  const loaded = (el: HTMLMediaElement) => { if (Number.isFinite(el.duration)) setPlayback({ kind: 'ready', duration: el.duration }); };
  const failed = playback.kind === 'failed';
  const label = failed ? "Can't play here" : playback.kind === 'ready' ? `${formatTime(position)} / ${formatTime(playback.duration)}` : formatSize(part.size);
  const events = {
    src: fileUrl(part.fileId), preload: 'metadata',
    onDurationChange: (event: { currentTarget: HTMLMediaElement }) => loaded(event.currentTarget),
    onTimeUpdate: (event: { currentTarget: HTMLMediaElement }) => setPosition(event.currentTarget.currentTime),
    onPlay: (event: { currentTarget: HTMLMediaElement }) => { started(event.currentTarget); setPaused(false); revealControls(); },
    onPause: (event: { currentTarget: HTMLMediaElement }) => { stopped(event.currentTarget); setPaused(true); revealControls(); },
    onEnded: (event: { currentTarget: HTMLMediaElement }) => { event.currentTarget.currentTime = 0; setPosition(0); },
    onError: () => setPlayback({ kind: 'failed' }),
  };
  const controls = <div className="media-controls" onPointerDown={() => { setAdjusting(true); revealControls(); }}
    onPointerUp={() => setAdjusting(false)} onPointerCancel={() => setAdjusting(false)} onLostPointerCapture={() => setAdjusting(false)}
    onFocusCapture={revealControls} onInput={revealControls}>
    <button type="button" className="media-toggle" aria-label={paused ? `Play ${part.name}` : `Pause ${part.name}`} disabled={failed} onClick={toggle}>
      {paused ? <Play size={18}/> : <Pause size={18}/>}
    </button>
    <div className="media-body">
      <span className="media-name">{part.name}</span>
      <input type="range" aria-label={`Position in ${part.name}`} min={0} step="any" disabled={playback.kind !== 'ready'}
        max={playback.kind === 'ready' ? playback.duration : 0} value={position}
        onInput={event => { const el = element.current, at = Number(event.currentTarget.value); if (el) el.currentTime = at; setPosition(at); }}/>
      <small>{label}</small>
    </div>
    {media === 'video' && !failed && (full
      ? <button type="button" className="media-icon" aria-label="Exit fullscreen" onClick={close}><Minimize size={17}/></button>
      : <button type="button" className="media-icon" aria-label={`Fullscreen ${part.name}`} onClick={() => { revealControls(); setFull(true); }}><Maximize size={17}/></button>)}
    <a className="media-icon" href={fileUrl(part.fileId, true)} download={part.name} aria-label={`Download ${part.name}`}><Download size={17}/></a>
  </div>;
  if (media === 'audio') return <div className={`media-attachment audio${paused ? '' : ' playing'}`}>
    <audio ref={element} {...events} onLoadedMetadata={event => loaded(event.currentTarget)}/>
    {controls}
  </div>;
  return <div ref={box} className={`media-attachment video${paused ? '' : ' playing'}${full ? ' full' : ''}${full && !controlsVisible ? ' controls-hidden' : ''}`}
    onKeyDown={revealControls} onPointerMove={event => { if (full && event.pointerType === 'mouse') revealControls(); }}>
    <div className="video-frame" style={!full && aspect ? { aspectRatio: String(aspect) } : undefined}>
      {failed ? <span>Can't play here</span> : <>
        <video ref={element} {...events} playsInline aria-label={part.name} onClick={() => full ? setControlsVisible(visible => !visible) : toggle()}
          onLoadedMetadata={event => { const el = event.currentTarget; loaded(el); if (el.videoWidth && el.videoHeight) setAspect(el.videoWidth / el.videoHeight); if (el.currentTime === 0) el.currentTime = 0.001; }}/>
        {paused && <button type="button" className="video-play" aria-label={`Play ${part.name}`} onClick={toggle}><Play size={28}/></button>}
      </>}
      {full && <button type="button" className="video-close" aria-label="Close" onClick={close}><X size={20}/></button>}
    </div>
    {controls}
  </div>;
}

const htmlFile = (mime: string) => ['text/html', 'application/xhtml+xml'].includes(mime.split(';', 1)[0]!.trim().toLowerCase());

/** An HTML file (a report or page an agent made): a live, sandboxed preview that opens the in-app viewer, with download. */
function HtmlAttachment({ part }: { part: Extract<MessagePart, { type: 'file' }> }) {
  const [failed, setFailed] = useState<string | null>(null);
  const open = () => void loadViewer().then(
    m => { setFailed(null); m.showFile({ kind: 'html', name: part.name, view: viewUrl(part.fileId), download: fileUrl(part.fileId, true) }); },
    (e: unknown) => setFailed(`Couldn't open the viewer: ${e instanceof Error ? e.message : String(e)}`));
  return <div className="media-attachment video html-attachment">
    <div className="video-frame"><iframe src={viewUrl(part.fileId)} sandbox="allow-scripts" loading="lazy" tabIndex={-1} aria-hidden="true" title={part.name}/>
      <button type="button" aria-label={`Open ${part.name}`} onClick={open}/></div>
    <div className="media-controls"><File size={18}/>
      <div className="media-body"><span className="media-name">{part.name}</span><small>{failed ?? formatSize(part.size)}</small></div>
      <button type="button" className="media-icon" aria-label={`Open ${part.name}`} onClick={open}><Maximize size={17}/></button>
      <a className="media-icon" href={fileUrl(part.fileId, true)} download={part.name} aria-label={`Download ${part.name}`}><Download size={17}/></a>
    </div>
  </div>;
}

/** A Markdown or text file: tapping it opens the reader (full screen on a phone, a panel beside the chat on a wide
 * screen); the download stays beside it. */
function TextAttachment({ part, kind }: { part: Extract<MessagePart, { type: 'file' }>; kind: TextKind }) {
  const [failed, setFailed] = useState<string | null>(null);
  const open = () => void loadViewer().then(
    m => { setFailed(null); m.showFile({ kind, name: part.name, url: fileUrl(part.fileId), size: part.size, download: fileUrl(part.fileId, true) }); },
    (e: unknown) => setFailed(`Couldn't open the reader: ${e instanceof Error ? e.message : String(e)}`));
  return <div className="media-attachment text-attachment">
    <button type="button" className="media-controls" aria-label={`Read ${part.name}`} onClick={open}><File size={18}/>
      <span className="media-body"><span className="media-name">{part.name}</span><small>{failed ?? `${formatSize(part.size)} · tap to read`}</small></span></button>
    <a className="media-icon" href={fileUrl(part.fileId, true)} download={part.name} aria-label={`Download ${part.name}`}><Download size={17}/></a>
  </div>;
}

/** A PDF: its first page drawn inline (by the server, so every app shows it); tapping it opens the PDF viewer, all
 * pages with scroll and pinch zoom, and the download stays beside it. */
function PdfAttachment({ part }: { part: Extract<MessagePart, { type: 'file' }> }) {
  const [failed, setFailed] = useState<string | null>(null);
  const [preview, setPreview] = useState(true);
  const open = () => void loadViewer().then(
    m => { setFailed(null); m.showFile({ kind: 'pdf', name: part.name, fileId: part.fileId, download: fileUrl(part.fileId, true) }); },
    (e: unknown) => setFailed(`Couldn't open the viewer: ${e instanceof Error ? e.message : String(e)}`));
  return <div className="media-attachment video html-attachment">
    <div className="video-frame">{preview ? <img loading="lazy" alt="" src={apiPath(`/api/files/${part.fileId}/pdf/1?w=960`)} onError={() => setPreview(false)}/> : <span>No preview</span>}
      <button type="button" aria-label={`Open ${part.name}`} onClick={open}/></div>
    <div className="media-controls"><File size={18}/>
      <div className="media-body"><span className="media-name">{part.name}</span><small>{failed ?? `PDF · ${formatSize(part.size)}`}</small></div>
      <button type="button" className="media-icon" aria-label={`Open ${part.name}`} onClick={open}><Maximize size={17}/></button>
      <a className="media-icon" href={fileUrl(part.fileId, true)} download={part.name} aria-label={`Download ${part.name}`}><Download size={17}/></a>
    </div>
  </div>;
}

/** Images draw inline and open full size in a viewer that swipes through the conversation's loaded images; audio and
 * video the browser can play are players; PDFs show their first page; PDF, HTML, Markdown and text files open in the app's viewer; any other file is a
 * chip that downloads it. */
export function FilePart({ part }: { part: Extract<MessagePart, { type: 'image' | 'file' }> }) {
  if (part.type === 'image') return <ImageAttachment fileId={part.fileId}/>;
  if (htmlFile(part.mime)) return <HtmlAttachment part={part}/>;
  if (pdfFile(part.mime, part.name)) return <PdfAttachment part={part}/>;
  const text = textKind(part.name, part.mime);
  if (text) return <TextAttachment part={part} kind={text}/>;
  const media = mediaOf(part.mime);
  switch (media) {
    case 'audio': case 'video': return <MediaAttachment part={part} media={media}/>;
    case null: return <a className="file" href={fileUrl(part.fileId, true)} download={part.name}><File size={16}/><span>{part.name}</span><small>{formatSize(part.size)}</small></a>;
  }
}
