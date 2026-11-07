import { beginUpdateActivity } from './updateActivity.js';

// Live dictation in a box she edits meanwhile: her edits win, word by word. Each dictated word keeps its place in the
// box through her edits; a word she touched is hers and no answer changes it again. Every new answer (the whole
// transcript so far, which may revise punctuation or a recent word) rewrites only dictated words she left alone, and
// words beyond them go in at the anchor: after the last dictated word, or past what she typed right after it.
// The box is written only when that cannot hurt her typing: never during an IME composition (Android keyboards such
// as SwiftKey compose each word; writing the value then drops or doubles letters) and not while she is typing.

/** A dictated word's place in the box, [start, end); `key` matches it across answers; `mine` once she touched it. */
export type Word = { start: number; end: number; key: string; mine: boolean };
/** The dictated words, where the next new words go, and whether a space was put before the first one. */
export type LiveText = { words: Word[]; anchor: number; lead: boolean };
/** One change to the box: `removed` characters at `at` became `text`. `follow`: a caret right at `at` goes after it. */
export type Edit = { at: number; removed: number; text: string; follow?: boolean };

export const startLive = (box: string): LiveText => ({ words: [], anchor: box.length, lead: false });
const words = (text: string) => text.split(/\s+/).filter(Boolean);
const keyOf = (word: string) => word.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const space = (ch: string | undefined) => ch === undefined || /\s/.test(ch);

/** Her change from `before` to `after` as one edit; `caret` (where her caret is after it) settles repeated letters. */
export function editOf(before: string, after: string, caret: number | null = null): Edit {
  const max = Math.min(before.length, after.length);
  let s = 0; const sMax = caret === null ? max : Math.min(max, after.length - caret);
  while (s < sMax && before[before.length - 1 - s] === after[after.length - 1 - s]) s++;
  let p = 0; while (p < max - s && before[p] === after[p]) p++;
  return { at: p, removed: before.length - s - p, text: after.slice(p, after.length - s) };
}

/** The dictated words after her edit: a word it reaches into (or extends without a space) becomes hers. */
export function afterEdit(live: LiveText, edit: Edit): LiveText {
  const end = edit.at + edit.removed, delta = edit.text.length - edit.removed;
  const extendsEnd = (w: Word) => edit.removed === 0 && edit.at === w.end && !space(edit.text[0]);
  const extendsStart = (w: Word) => edit.removed === 0 && edit.at === w.start && !space(edit.text[edit.text.length - 1]);
  const moved = live.words.map(w => {
    if (end <= w.start && !extendsStart(w)) return { ...w, start: w.start + delta, end: w.end + delta };
    if (edit.at >= w.end && !extendsEnd(w)) return w;
    return { ...w, mine: true, start: Math.min(w.start, edit.at), end: w.end >= end ? w.end + delta : edit.at + edit.text.length };
  });
  const anchor = live.anchor >= end ? live.anchor + delta : live.anchor <= edit.at ? live.anchor : edit.at + edit.text.length;
  return { ...live, words: moved, anchor };
}

/** A position across edits made at once (each `at` in the old box, ascending, not overlapping). */
export function carried(at: number, edits: Edit[]): number {
  let shift = 0;
  for (const e of edits) {
    const end = e.at + e.removed;
    if (at > end || (at === end && (e.removed > 0 || e.follow))) shift += e.text.length - e.removed;
    else if (at > e.at) return e.at + shift + Math.min(at - e.at, e.text.length);
    else break;
  }
  return at + shift;
}

/** The box after a new answer (the whole transcript so far): what changed, and the live state. */
export function withWords(live: LiveText, box: string, spoken: string): { box: string; live: LiveText; edits: Edit[] } {
  const heard = words(spoken), old = live.words, edits: Edit[] = [], placed = new Map<Edit, string[]>(), replaced = new Set<number>();
  const replace = (from: number, to: number, list: string[], olds: number[], follow = false) => {
    const e: Edit = { at: from, removed: to - from, text: list.join(' '), ...(follow ? { follow } : {}) };
    edits.push(e); placed.set(e, list); olds.forEach(j => replaced.add(j));
    return e;
  };
  let i = 0;
  for (; i < old.length && i < heard.length && old[i]!.key === keyOf(heard[i]!); i++) {
    const w = old[i]!;
    if (!w.mine && box.slice(w.start, w.end) !== heard[i]) replace(w.start, w.end, [heard[i]!], [i]);
  }
  // From i on the words differ. Those up to her last touch (a word, or text she put between words) stay as they are.
  let frozen = i - 1;
  for (let j = i; j < old.length; j++) if (old[j]!.mine || (j + 1 < old.length && box.slice(old[j]!.end, old[j + 1]!.start) !== ' ')) frozen = j;
  const tail = old.slice(frozen + 1), fresh = heard.slice(frozen + 1), swap = fresh.slice(0, tail.length);
  const first = tail[0], last = tail[tail.length - 1];
  if (first && last && swap.join(' ') !== box.slice(first.start, last.end)) {
    const from = !swap.length && first.start > 0 && box[first.start - 1] === ' ' ? first.start - 1 : first.start;
    replace(from, last.end, swap, tail.map((_, j) => frozen + 1 + j));
  }
  const beyond = fresh.slice(tail.length);
  let lead = live.lead;
  if (beyond.length) {
    const before = live.anchor > 0 && !space(box[live.anchor - 1]), after = !space(box[live.anchor]);
    if (!old.length) lead = before;
    const e = replace(live.anchor, live.anchor, beyond, [], true);
    e.text = `${before ? ' ' : ''}${e.text}${after ? ' ' : ''}`;
  }
  let out = '', from = 0;
  const fixed = edits.filter(e => !e.follow);
  const next: Word[] = old.flatMap((w, j) => replaced.has(j) ? [] : [{ ...w, start: carried(w.start, fixed), end: carried(w.end, fixed) }]);
  for (const e of edits) {
    const at = carried(e.at, edits.filter(x => x.at < e.at)) + (e.text.length - e.text.trimStart().length);
    let pos = at;
    for (const word of placed.get(e)!) { next.push({ start: pos, end: pos + word.length, key: keyOf(word), mine: false }); pos += word.length + 1; }
    out += box.slice(from, e.at) + e.text; from = e.at + e.removed;
  }
  next.sort((a, b) => a.start - b.start);
  const added = beyond.length ? next[next.length - 1]!.end : null;
  return { box: out + box.slice(from), live: { words: next, anchor: added ?? carried(live.anchor, edits), lead }, edits };
}

/** The composer's textarea as the follower uses it (a plain object in tests). */
export type Field = Pick<HTMLTextAreaElement, 'value' | 'selectionStart' | 'selectionEnd' | 'scrollTop' | 'setSelectionRange' | 'addEventListener' | 'removeEventListener'> & { readonly ownerDocument: { readonly activeElement: unknown } };
/** Where the dictation's box is: the field while it shows this chat (else null), the chat's saved draft, and `ended`,
 *  told once when the dictation lets the box go. */
export type BoxAccess = { field(): Field | null; save(text: string): void; ended(): void };
export type Clock = { now(): number; later(run: () => void, ms: number): () => void };
/** A dictation's words in its box: `heard` each answer, then `settle` (stop) or `sent` (Send). Words once in the box
 *  never leave it on the dictation's account; only her own editing removes them.
 *  `sent` ends the dictation and returns the box's text with its final words (`spoken`, else what still waited to be
 *  written), for the composer to send and clear; null once it had already ended. `stop` lets the box go as it is. */
export type LiveBox = { heard(spoken: string): void; settle(spoken: string): void; sent(spoken: string | null): string | null; stop(): void };

/** While she is typing, answers wait this long after her last keystroke. */
export const TYPING_PAUSE_MS = 1000;
const browserClock: Clock = { now: () => performance.now(), later: (run, ms) => { const id = setTimeout(run, ms); return () => clearTimeout(id); } };

export function follow(access: BoxAccess, box: string, clock: Clock = browserClock): LiveBox {
  let live = startLive(box), known = box, field: Field | null = null, composing = false, typedAt = -Infinity;
  let activity: (() => void) | null = null;
  let want: string | null = null, ending = false, stopped = false, timer: (() => void) | null = null;
  const onInput = () => {
    if (!field) return;
    live = afterEdit(live, editOf(known, field.value, field.selectionEnd)); known = field.value; typedAt = clock.now();
    if (want) wait(TYPING_PAUSE_MS);
  };
  const onCompositionStart = () => { composing = true; };
  const onCompositionEnd = () => { composing = false; if (want) wait(0); };
  const onBlur = () => { composing = false; typedAt = -Infinity; if (want) wait(0); };
  const events = [['input', onInput], ['compositionstart', onCompositionStart], ['compositionend', onCompositionEnd], ['blur', onBlur]] as const;
  const listen = (on: boolean) => { if (field) for (const [name, handler] of events) on ? field.addEventListener(name, handler) : field.removeEventListener(name, handler); };
  const wait = (ms: number) => { timer?.(); timer = clock.later(() => { timer = null; flush(); }, ms); };
  function attach() {
    const current = access.field();
    if (current !== field) { listen(false); field = current; composing = false; typedAt = -Infinity; listen(true); }
    if (field && field.value !== known) { live = afterEdit(live, editOf(known, field.value)); known = field.value; }
  }
  function write(next: string, edits: Edit[]) {
    if (field && next !== known) {
      const focused = field.ownerDocument.activeElement === field;
      const start = field.selectionStart, end = field.selectionEnd, top = field.scrollTop;
      field.value = next;
      field.setSelectionRange(carried(start, edits), carried(end, edits));
      if (focused && !edits.some(e => e.follow && e.at === end)) field.scrollTop = top;
    }
    if (next !== known) { known = next; access.save(next); }
  }
  function flush() {
    if (stopped) return;
    attach();
    if (!want) { if (ending) stop(); return; }
    if (field && composing) return;
    const quiet = clock.now() - typedAt;
    if (field && quiet < TYPING_PAUSE_MS) { wait(TYPING_PAUSE_MS - quiet); return; }
    const next = withWords(live, known, want); want = null;
    write(next.box, next.edits); live = next.live;
    if (ending) stop();
  }
  function stop() { if (stopped) return; stopped = true; activity?.(); activity = null; want = null; timer?.(); timer = null; listen(false); field = null; access.ended(); }
  return {
    heard(spoken) { if (ending) return; want = spoken; flush(); },
    settle(spoken) { if (stopped) return; activity ??= beginUpdateActivity(); want = spoken; ending = true; flush(); },
    sent(spoken) {
      if (stopped) return null;
      attach();
      const last = spoken ?? want;
      const text = last === null ? known : withWords(live, known, last).box;
      stop();
      return text;
    },
    stop,
  };
}
