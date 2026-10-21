import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Download, File, X } from 'lucide-react';
import { gallery, swipeDirection, type GalleryItem } from './gallery.js';
import type { MessagePart } from '../shared/contract.js';
import { apiPath } from './path.js';
import { useOverlay } from './overlay.js';

/** Taller than this many widths, an inline image is shown as its top part at a readable width instead of a sliver. */
const TALL = 2.2;

const fileUrl = (fileId: string, download = false) => apiPath(`/api/files/${fileId}${download ? '?download=1' : ''}`);

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

function ImageViewer({ items, start, close }: { items: GalleryItem[]; start: number; close: () => void }) {
  const [index, setIndex] = useState(start);
  const [actual, setActual] = useState(false);
  const touch = useRef<{ x: number; y: number } | null>(null);
  useOverlay(true, close);
  const item = items[index] ?? items[0]!;
  const go = (step: number) => { const next = index + step; if (next >= 0 && next < items.length) { setIndex(next); setActual(false); } };
  useEffect(() => {
    const key = (event: KeyboardEvent) => { if (event.key === 'ArrowLeft') go(-1); else if (event.key === 'ArrowRight') go(1); };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  });
  return <div className="image-viewer" role="dialog" aria-modal="true" aria-label="Image" onClick={event => { if (event.target === event.currentTarget) close(); }}>
    <div className="image-viewer-bar">
      {items.length > 1 && <span className="image-viewer-count">{index + 1} / {items.length}</span>}
      <button type="button" onClick={() => setActual(!actual)}>{actual ? 'Fit width' : 'Actual size'}</button>
      <a href={fileUrl(item.fileId, true)} download aria-label="Download"><Download size={17}/></a>
      <button type="button" aria-label="Close" onClick={close}><X size={18}/></button>
    </div>
    <div className={`image-viewer-scroll${actual ? ' actual' : ''}`}
      onTouchStart={event => { const t = event.touches[0]; touch.current = t && event.touches.length === 1 ? { x: t.clientX, y: t.clientY } : null; }}
      onTouchEnd={event => { const from = touch.current, t = event.changedTouches[0]; touch.current = null; if (!from || !t || actual) return; const step = swipeDirection(t.clientX - from.x, t.clientY - from.y); if (step) go(step); }}
      onClick={event => { if (event.target === event.currentTarget) close(); }}>
      <img key={item.fileId} src={fileUrl(item.fileId)} alt="Attachment, full size" onClick={() => setActual(!actual)}/>
      {item.caption && <p className="image-viewer-caption">{item.caption}</p>}
    </div>
    {items.length > 1 && index > 0 && <button type="button" className="image-viewer-nav previous" aria-label="Previous image" onClick={() => go(-1)}><ChevronLeft size={22}/></button>}
    {items.length > 1 && index < items.length - 1 && <button type="button" className="image-viewer-nav next" aria-label="Next image" onClick={() => go(1)}><ChevronRight size={22}/></button>}
  </div>;
}

function ImageAttachment({ fileId }: { fileId: string }) {
  const [open, setOpen] = useState<{ items: GalleryItem[]; start: number } | null>(null);
  const [shape, setShape] = useState<'loading' | 'tall' | 'regular' | 'broken'>('loading');
  const tall = shape === 'tall';
  return <>
    <button type="button" data-file-id={fileId} className={`image-attachment ${shape}`} aria-label="Open image" onClick={event => setOpen(gallery(event.currentTarget, fileId))}>
      <img loading="lazy" src={fileUrl(fileId)} alt="Attachment" onError={() => setShape('broken')} onLoad={event => setShape(event.currentTarget.naturalHeight > TALL * event.currentTarget.naturalWidth ? 'tall' : 'regular')}/>
      {tall && <span>Tap to see the whole image</span>}
    </button>
    {open && <ImageViewer items={open.items} start={open.start} close={() => setOpen(null)}/>}
  </>;
}

/** Images draw inline and open full size in a viewer that swipes through the conversation's loaded images; any other file is a chip that downloads it. */
export function FilePart({ part }: { part: Extract<MessagePart, { type: 'image' | 'file' }> }) {
  if (part.type === 'image') return <ImageAttachment fileId={part.fileId}/>;
  return <a className="file" href={fileUrl(part.fileId, true)} download={part.name}><File size={16}/><span>{part.name}</span><small>{formatSize(part.size)}</small></a>;
}
