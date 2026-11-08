import './mine.css';
/** Paint the person's own bubbles in `color` (#RRGGBB); returns the undo. Loaded only for a person with a bubbleColor. */
export function paintMine(color: string): () => void {
  const root = document.documentElement;
  root.style.setProperty('--my-bubble', color); root.dataset.bubble = '';
  return () => { root.style.removeProperty('--my-bubble'); delete root.dataset.bubble; };
}
