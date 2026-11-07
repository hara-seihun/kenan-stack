// Copying a code block from a message (Alice 2026-10-23: on her phone she couldn't copy code blocks). Loaded on the
// first touch or click inside a block, so it costs the startup bundle only the listener in main.tsx; events handled
// after that first load keep their own timestamps.
// - The Copy button copies the whole block.
// - On touch, holding still on the block copies it too (with a buzz). The browser's own long-press selection still
//   starts, so its handles and Copy remain there for copying part of it. Android fires contextmenu on a long press and
//   may cancel the pointer as selection begins; either counts as the hold.
// - Where no clipboard route works, the whole block is selected instead, for the browser's own Copy.
import { writeClipboard } from './clipboard.js';

export const HOLD_MS = 450;
const CANCEL_HOLD_MS = 350, SLOP_PX = 10, SHOWN_MS = 1600;

export type CopyOutcome = 'copied' | 'selected';
type Press = { id: number; x: number; y: number; at: number; block: Element; timer: ReturnType<typeof setTimeout> };

let press: Press | null = null;
const resets = new WeakMap<Element, ReturnType<typeof setTimeout>>();

const BLOCK_TAGS = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'BLOCKQUOTE', 'PRE', 'HR', 'DIV', 'TABLE']);

function inlineText(node: Node): string {
  if (node.nodeType === 3) return (node.textContent ?? '').replace(/\s*\n\s*/g, ' ');
  if (node.nodeType !== 1) return '';
  const el = node as Element;
  if (el.tagName === 'BR') return '\n';
  if (el.tagName === 'IMG') return el.getAttribute('alt') ?? '';
  return Array.from(el.childNodes).map(inlineText).join('');
}

function listText(list: Element): string {
  const ordered = list.tagName === 'OL';
  let n = ordered ? Number(list.getAttribute('start') ?? 1) : 0;
  return Array.from(list.children).map(li => {
    const marker = ordered ? `${n++}. ` : '- ';
    return marker + containerText(li, true).split('\n').join('\n' + ' '.repeat(marker.length));
  }).join('\n');
}

function containerText(el: Element, tight = false): string {
  const parts: { text: string; list: boolean }[] = [];
  let run = '';
  const flush = () => { if (run.trim()) parts.push({ text: run.trim(), list: false }); run = ''; };
  for (const c of Array.from(el.childNodes)) {
    if (c.nodeType !== 1 || !BLOCK_TAGS.has((c as Element).tagName)) { run += inlineText(c); continue; }
    flush();
    const e = c as Element;
    if (e.tagName === 'HR') continue;
    if (e.tagName === 'UL' || e.tagName === 'OL') parts.push({ text: listText(e), list: true });
    else if (e.tagName === 'PRE') parts.push({ text: e.textContent ?? '', list: false });
    else if (e.tagName === 'BLOCKQUOTE' || e.tagName === 'DIV') parts.push({ text: containerText(e), list: false });
    else parts.push({ text: inlineText(e).trim(), list: false });
  }
  flush();
  return parts.reduce((acc, p, i) => i === 0 ? p.text : acc + (tight && p.list ? '\n' : '\n\n') + p.text, '');
}

/** A quote as a reader would paste it: paragraphs and line breaks kept, list numbers written out, no markup, no "> ". */
export function quoteText(root: Element): string { return containerText(root); }

export async function copyBlock(block: Element, hold: boolean): Promise<CopyOutcome | null> {
  const quote = block.querySelector('blockquote');
  const code = block.querySelector('pre') ?? quote, button = block.querySelector('.code-copy');
  if (!code || !button) return null;
  const outcome: CopyOutcome = await writeClipboard(quote && code === quote ? quoteText(quote) : code.textContent ?? '') ? 'copied' : 'selected';
  if (outcome === 'selected') { const range = document.createRange(); range.selectNodeContents(code); getSelection()?.removeAllRanges(); getSelection()?.addRange(range); }
  else if (hold) navigator.vibrate?.(15);
  button.textContent = outcome === 'copied' ? 'Copied ✓' : 'Selected';
  clearTimeout(resets.get(button));
  resets.set(button, setTimeout(() => { button.textContent = 'Copy'; }, SHOWN_MS));
  return outcome;
}

function end(fire: boolean) {
  const p = press; press = null;
  if (!p) return;
  clearTimeout(p.timer);
  if (fire) void copyBlock(p.block, true);
}

/** One event from inside a code block, delegated by main.tsx. */
export function handle(event: Event): void {
  const target = event.target as Element, block = target.closest('.code-block');
  if (!block) return;
  const onButton = !!target.closest('.code-copy');
  if (event.type === 'click') { if (onButton) void copyBlock(block, false); return; }
  if (event.type === 'contextmenu') { if (press?.block === block) end(true); return; }
  const p = event as PointerEvent;
  if (event.type === 'pointerdown') {
    end(false);
    if (onButton || p.pointerType === 'mouse' || !p.isPrimary) return;
    press = { id: p.pointerId, x: p.clientX, y: p.clientY, at: p.timeStamp, block, timer: setTimeout(() => end(true), Math.max(0, HOLD_MS - (performance.now() - p.timeStamp))) };
    return;
  }
  if (!press || p.pointerId !== press.id) return;
  if (event.type === 'pointermove') { if (Math.hypot(p.clientX - press.x, p.clientY - press.y) > SLOP_PX) end(false); return; }
  end(event.type === 'pointercancel' && p.timeStamp - press.at >= CANCEL_HOLD_MS);
}
