/** One image in the swipeable viewer, with the words of the message it came in. */
export type GalleryItem = { fileId: string; caption: string };

/** A horizontal swipe of at least this many pixels changes image. */
const SWIPE_PX = 50;

/** -1 for a swipe right (previous), 1 for a swipe left (next), 0 for a tap, a scroll or a short drag. */
export function swipeDirection(dx: number, dy: number): -1 | 0 | 1 {
  if (Math.abs(dx) < SWIPE_PX || Math.abs(dx) < Math.abs(dy) * 1.5) return 0;
  return dx < 0 ? 1 : -1;
}

/** The message's own words, without the inline image hints or file chips. */
export function captionOf(article: Element | null): string {
  const body = article?.querySelector('.message-body');
  if (!body) return '';
  return Array.from(body.children)
    .filter(child => !child.matches('.image-attachment, .file, details, .tool-card'))
    .map(child => (child as HTMLElement).innerText ?? child.textContent ?? '')
    .join('\n').trim();
}

/** Every image attachment loaded in the same transcript, in order, starting at the one that was tapped. */
export function gallery(from: HTMLElement, fileId: string): { items: GalleryItem[]; start: number } {
  const root = from.closest('.transcript') ?? document;
  const buttons = Array.from(root.querySelectorAll<HTMLElement>('.image-attachment[data-file-id]'));
  const items = buttons.map(button => ({ fileId: button.dataset.fileId!, caption: captionOf(button.closest('article')) }));
  const start = Math.max(0, buttons.indexOf(from));
  return items.length ? { items, start } : { items: [{ fileId, caption: '' }], start: 0 };
}
