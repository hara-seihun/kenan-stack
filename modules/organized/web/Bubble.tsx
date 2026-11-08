// The floating 🌀 bubble and its quick panel on her Kenaznia chat (Carol's mockups design/mic A3, B3, C2, D2, E2, F,
// H; 2026-10-22). Tap the bubble to talk, tap again to send what she said; the panel opens at ¼ with the answer. Drag it
// to a side (remembered per device), onto the ✕ to hide it (a dim pill on the tab bar brings it back), or, while
// recording, onto the ✕ to stop and keep her words in the panel's field. Words she said are never lost (Carol
// 2026-10-24): stopping (■), a failed transcription and leaving the screen put them in the field, which is her
// Kenaznia chat's draft, to edit and send herself. Its own chunk, loaded only for people with the `bubble` extension.
import { useEffect, useSyncExternalStore, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import { MessageMarkdown } from '../../../web/MessageMarkdown.js';
import type { FilePart } from '../../../web/FilePart.js';
import { BusyLine } from '../../../web/BusyLine.js';
import { followBottom } from '../../../web/stick.js';
import { useOverlay } from '../../../web/overlay.js';
import type { DictationError, DictationResult, Recording } from '../../../web/dictation.js';
import { beginUpdateActivity } from '../../../web/updateActivity.js';
import { BUBBLE_KEY, BUBBLE_SIZE, FINISH_MS, FIRST_PLACE, ON_WAY_KEY, clock, dropOnWay, joined, putOnWay, readOnWay, recover, type OnWay, over, placeWords, settleWords, type Placed, panelHeights, pointOf, readBubble, settlePanel, snap, stretchLabel, type BubbleSaved, type PanelSize, type Room } from './bubble.js';
import type { QuickChat } from './quick.js';
import './bubble.css';
import { bridge, call } from '../../../web/native.js';
import FooterIcon from '../../../web/FooterIcon.js';
import { useEmojiSuggest } from '../../../web/EmojiSuggest.js';

const noDraftSubscription = () => () => {};

export interface BubbleProps {
  /** Draws a file her Kenaznia sent (passed in: importing it here splits the app's startup chunk). */
  FilePart: typeof FilePart;
  chat: QuickChat;
  wide: boolean;
  /** Changes whenever the screen under the bubble changes, so its room is measured again. */
  where: string;
  /** The screen she is on, read when she sends ("Chats, Open"). */
  seenFrom(): string;
  openChat(): void;
}
type From = 'bubble' | 'panel';
type Rec = { kind: 'idle' } | { kind: 'starting'; from: From } | { kind: 'recording'; from: From; rec: Recording } | { kind: 'transcribing'; from: From };
type Panel = { kind: 'closed' } | { kind: 'open'; size: PanelSize };
/** The bubble (or the pill, pulled out) under her finger. */
type Hold = { pointerId: number; x0: number; y0: number; x: number; y: number; moved: boolean; pill: boolean };
type PanelHold = { pointerId: number; y0: number; h0: number; h: number; y: number; t: number; v: number; moved: boolean };
/** Her words on their way, in the order she said them, each until the chat has it: being finished (the words heard
 *  so far, null when none came live) or being sent. Several can be on their way at once; none replaces another. Each is
 *  also kept on the device (ON_WAY_KEY) until the chat or the field has its words. */
type Pending = OnWay;
/** Keys of words on their way in this page, whoever started them: a bubble mounted again doesn't recover them twice. */
const live = new Set<string>();
/** The page is going away (a reload, the app's update): its requests are cut off and fail, which must not count as
 *  her words having been dealt with, so what is kept stays for the next page. */
let leaving = false;
for (const gone of ['beforeunload', 'pagehide']) window.addEventListener(gone, () => { leaving = true; });
window.addEventListener('pageshow', () => { leaving = false; });
const kept = (change: (all: OnWay[]) => OnWay[]) => {
  if (leaving) return;
  try {
    const next = change(readOnWay(localStorage.getItem(ON_WAY_KEY), Date.now()));
    if (next.length) localStorage.setItem(ON_WAY_KEY, JSON.stringify(next)); else localStorage.removeItem(ON_WAY_KEY);
  } catch { /* storage full or blocked: the words are still on screen */ }
};
const LATE = 'Still writing it down: ';
const late = (soFar: string) => LATE + (soFar.trim() ? "your words so far are in the box, and the rest joins them when it's ready. Send when you like." : "your words will appear in the box when they're ready, to send when you like.");
const wait = (ms: number) => new Promise<'late'>(resolve => setTimeout(() => resolve('late'), ms));
/** tabs: the tab bar's height; floor: how far up from the bottom the screen's own bottom controls reach (tab bar, Home's
 *  footer, the calendar's ＋), which the bubble rests above. */
interface Layout { vw: number; vh: number; tabs: number; floor: number; keyboard: number; pane: Room & { width: number } }
const BOTTOM_CONTROLS = '.org-tabs, .org-home-foot';

const MOVE = 8;
const WAVE = [4, 9, 15, 10, 13, 6];
const PROBLEMS: Record<DictationError['code'], string> = {
  mic_denied: 'Microphone blocked: allow it for Kenan in Settings',
  mic_unavailable: "Couldn't open the mic: is another app or a Bluetooth headset using it?",
  busy: 'Already recording',
  empty: "Didn't catch anything",
  transcribe_failed: "Couldn't write that down. Try again",
};
const editable = (el: EventTarget | null) => el instanceof HTMLElement && (el.isContentEditable || el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && !['checkbox', 'radio', 'button', 'submit'].includes((el as HTMLInputElement).type)));

function measure(wide: boolean): Layout {
  const vw = window.innerWidth, vh = window.innerHeight, vv = window.visualViewport;
  const tabs = document.querySelector('.organized .org-tabs');
  const pane = wide ? document.querySelector('.organized .org-detail')?.getBoundingClientRect() : undefined;
  const r = pane ?? { left: 0, top: 0, right: vw, bottom: vh, width: vw };
  const floor = Math.max(0, ...[...document.querySelectorAll(`.organized ${wide ? '.org-detail ' : ''}:is(${BOTTOM_CONTROLS})`)]
    .map(el => el.getBoundingClientRect()).filter(b => b.height > 0 && b.left < r.right && b.right > r.left).map(b => r.bottom - b.top));
  return { vw, vh, tabs: tabs ? Math.max(0, vh - tabs.getBoundingClientRect().top) : 0, floor, keyboard: vv ? Math.max(0, vh - (vv.offsetTop + vv.height)) : 0, pane: { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width } };
}
/** Where the bubble's top-left corner may rest: inside the screen (phone) or the main pane (wide), above the tab bar. */
function roomOf(l: Layout, wide: boolean): Room {
  return wide
    ? { left: l.pane.left + 20, right: l.pane.right - 20 - BUBBLE_SIZE, top: l.pane.top + 12, bottom: l.pane.bottom - Math.max(60, l.floor) - 16 - BUBBLE_SIZE }
    : { left: 16, right: l.vw - 16 - BUBBLE_SIZE, top: 12, bottom: l.vh - l.floor - 16 - BUBBLE_SIZE };
}
/** The ✕ to drop the bubble (or the panel) on: bottom centre, just above the tab bar. */
const targetOf = (l: Layout, wide: boolean) => wide ? { x: (l.pane.left + l.pane.right) / 2, y: l.pane.bottom - 48, r: 44 } : { x: l.vw / 2, y: l.vh - l.tabs - 48, r: 44 };

function useLayout(wide: boolean, where: string): Layout {
  const [layout, setLayout] = useState(() => measure(wide));
  useEffect(() => {
    // Read geometry after layout, not from a layout effect in the middle of every screen's render.
    // ResizeObserver also follows the real controls; an arbitrary second read 300ms later did not.
    let frame = 0;
    const again = () => {
      cancelAnimationFrame(frame); frame = 0;
      const next = measure(wide);
      setLayout(current => JSON.stringify(next) === JSON.stringify(current) ? current : next);
    };
    const resized = () => { if (!frame) frame = requestAnimationFrame(again); };
    const observer = new ResizeObserver(again);
    for (const el of document.querySelectorAll(`.organized :is(${BOTTOM_CONTROLS}, .org-detail)`)) observer.observe(el);
    observer.observe(document.documentElement);
    const vv = window.visualViewport;
    window.addEventListener('resize', resized); vv?.addEventListener('resize', resized); vv?.addEventListener('scroll', resized);
    return () => { observer.disconnect(); cancelAnimationFrame(frame); window.removeEventListener('resize', resized); vv?.removeEventListener('resize', resized); vv?.removeEventListener('scroll', resized); };
  }, [wide, where]);
  return layout;
}

/** Microphone level as bars: written straight to a CSS variable about 30 times a second, without re-rendering. */
function Wave({ level }: { level: React.RefObject<HTMLSpanElement | null> }) {
  return <span className="bq-wave" ref={level} aria-hidden="true">{WAVE.map((h, i) => <i key={i} style={{ '--h': `${h}px` } as CSSProperties}/>)}</span>;
}

export default function Bubble(p: BubbleProps) {
  const [saved, setSaved] = useState<BubbleSaved>(() => readBubble(localStorage.getItem(BUBBLE_KEY)));
  const [rec, setRec] = useState<Rec>({ kind: 'idle' });
  const [panel, setPanel] = useState<Panel>({ kind: 'closed' });
  const [messageCount, setMessageCount] = useState(6);
  const olderPosition = useRef<{ row: Element; top: number } | null>(null);
  const [hold, setHold] = useState<Hold | null>(null);
  const [panelHold, setPanelHold] = useState<PanelHold | null>(null);
  const [pending, setPending] = useState<Pending[]>([]);
  const putPending = (item: Pending) => { kept(all => putOnWay(all, item)); setPending(all => putOnWay(all, item)); };
  const dropPending = (key: string) => { kept(all => dropOnWay(all, key)); setPending(all => dropOnWay(all, key)); };
  const draft = useSyncExternalStore(p.chat.subscribeDraft ?? noDraftSubscription, () => p.chat.draft);
  const quickInput = useRef<HTMLInputElement>(null);
  const [problem, setProblem] = useState<string | null>(null);
  /** The clip that could not be written down, while "Try again" can send it once more. */
  const [again, setAgain] = useState<Recording | null>(null);
  const [note, setNote] = useState<string | null>(null);
  /** What she has said so far, written down while she speaks. */
  const [heardSoFar, setHeardSoFar] = useState('');
  /** The server stopped writing her words down live during this recording; they come all at once when she stops. */
  const [liveLost, setLiveLost] = useState(false);
  /** The chat as last rendered, for a recording that finishes after the bubble has gone; and the words put in its field
   *  before their final text, which Try again may still replace. */
  const chat = useRef(p.chat); chat.current = p.chat;
  const heardRef = useRef(heardSoFar); heardRef.current = heardSoFar;
  const placed = useRef<Placed | null>(null);
  const setDraft = (next: string | ((current: string) => string)) => chat.current.setDraft(next);
  const emojiSuggest = useEmojiSuggest(draft, setDraft, quickInput, ['kenaznia']);
  const [scrolling, setScrolling] = useState(false);
  const [typingElsewhere, setTypingElsewhere] = useState(false);
  const [fieldFocused, setFieldFocused] = useState(false);
  const layout = useLayout(p.wide, p.where);
  const tallest = useRef(layout.vh); tallest.current = Math.max(tallest.current, layout.vh);
  const recRef = useRef(rec); recRef.current = rec;
  const level = useRef<HTMLSpanElement>(null), chip = useRef<HTMLButtonElement>(null), barClock = useRef<HTMLSpanElement>(null), list = useRef<HTMLDivElement>(null), sheet = useRef<HTMLElement>(null);
  const following = useRef(true), stick = useMemo(() => followBottom(following), []);
  const retry = useRef<{ text: string; clientId: string } | null>(null);
  const noteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const alive = useRef(true), dragged = useRef(false);
  const open = panel.kind === 'open';
  const openRef = useRef(open); openRef.current = open;
  const close = () => { setPanel({ kind: 'closed' }); setProblem(null); setMessageCount(6); };
  useOverlay(open, close);

  const save = (next: BubbleSaved) => { setSaved(next); localStorage.setItem(BUBBLE_KEY, JSON.stringify(next)); };
  const flash = (text: string) => { if (noteTimer.current) clearTimeout(noteTimer.current); setNote(text); noteTimer.current = setTimeout(() => setNote(null), 4000); };

  useEffect(() => {
    alive.current = true;
    const idle = window.requestIdleCallback ?? ((f: () => void) => setTimeout(f, 1500));
    idle(() => void import('../../../web/dictation.js'));
    let quiet: ReturnType<typeof setTimeout> | null = null;
    const scrolled = (e: Event) => {
      if (sheet.current && e.target instanceof Node && sheet.current.contains(e.target)) return;
      setScrolling(true); if (quiet) clearTimeout(quiet); quiet = setTimeout(() => setScrolling(false), 350);
    };
    const focus = () => setTypingElsewhere(editable(document.activeElement) && !sheet.current?.contains(document.activeElement));
    const blur = () => setTimeout(focus, 0);
    document.addEventListener('scroll', scrolled, { capture: true, passive: true });
    document.addEventListener('focusin', focus); document.addEventListener('focusout', blur);
    const left = readOnWay(localStorage.getItem(ON_WAY_KEY), Date.now()).filter(o => !live.has(o.key)).map(recover);
    for (const r of left) {
      if (r.kind === 'send') void sendText(r.item.text, r.item.key, r.item.clientId);
      else { kept(all => dropOnWay(all, r.item.key)); if (r.kind === 'field') setDraft(d => joined(d, r.item.text)); }
    }
    if (left.some(r => r.kind !== 'send')) {
      openPanel();
      setProblem(left.some(r => r.kind === 'field') ? 'Your last dictation was interrupted: the words heard are in the box.' : 'Your last dictation was interrupted before its words were written down. Please say it again.');
    }
    return () => {
      alive.current = false;
      const r = recRef.current; if (r.kind === 'recording') void keep(r.rec, r.rec.stop());
      document.removeEventListener('scroll', scrolled, { capture: true });
      document.removeEventListener('focusin', focus); document.removeEventListener('focusout', blur);
      if (quiet) clearTimeout(quiet);
    };
  }, []);
  useEffect(() => { if (open && p.chat.messages === null) p.chat.load(); }, [open, p.chat.messages === null]);
  useEffect(() => { if (open && p.chat.unread) p.chat.read(); }, [open, p.chat.unread]);
  useEffect(() => {
    if (rec.kind !== 'recording') return;
    const stop = rec.rec.onLevel(v => level.current?.style.setProperty('--lv', String(Math.min(1, Math.max(0, v)))));
    setHeardSoFar(''); setLiveLost(false);
    const offWords = rec.rec.onWords(setHeardSoFar), offLost = rec.rec.onLiveLost(() => setLiveLost(true));
    const tick = () => {
      const at = clock(rec.rec.elapsedMs());
      if (chip.current) chip.current.textContent = `${at} · tap to send`;
      if (barClock.current) barClock.current.textContent = at;
    };
    tick(); const every = setInterval(tick, 250);
    return () => { stop(); offWords(); offLost(); clearInterval(every); };
  }, [rec]);
  const messages = p.chat.messages ?? [];
  const last = messages.at(-1);
  useLayoutEffect(() => { following.current = true; }, [open, pending.length]);
  useLayoutEffect(() => {
    const el = list.current; if (!el) return;
    const older = olderPosition.current; olderPosition.current = null;
    if (older) el.scrollTop += older.row.getBoundingClientRect().top - older.top;
    else stick.settle(el);
  }, [open, panel.kind === 'open' && panel.size, messages.length, messageCount, last?.text.length, pending, p.chat.working, !p.chat.busy, heardSoFar, liveLost, rec.kind]);

  /** clientId: the one these words had when they were first on their way (sending them again lands them once). */
  async function sendText(text: string, key: string = crypto.randomUUID(), given?: string) {
    const clientId = given ?? (retry.current?.text === text ? retry.current.clientId : crypto.randomUUID());
    retry.current = { text, clientId };
    live.add(key);
    putPending({ key, clientId, text, phase: 'sending', at: Date.now() }); setProblem(null);
    const sent = await chat.current.send(text, p.seenFrom(), clientId);
    live.delete(key);
    if (sent.ok) retry.current = null;
    else setDraft(d => joined(text, d));
    dropPending(key);
    if (!alive.current) return;
    if (!sent.ok) setProblem(`Not sent: ${sent.error} Tap ↑ to try again.`);
    else if (!openRef.current) flash('Sent ✓');
  }
  async function startRecording(from: From) {
    if (recRef.current.kind !== 'idle') return;
    const done = beginUpdateActivity();
    setRec({ kind: 'starting', from }); setProblem(null); setAgain(null);
    if (p.chat.messages === null) p.chat.load();
    const started = await import('../../../web/dictation.js').then(m => m.startRecording(), () => ({ ok: false as const, error: { code: 'mic_unavailable' as const, message: '' } })).finally(done);
    if (!alive.current) { if (started.ok) started.value.cancel(); return; }
    if ((recRef.current as Rec).kind !== 'starting') { if (started.ok) started.value.cancel(); return; }
    if (!started.ok) { setRec({ kind: 'idle' }); if (from === 'panel') setProblem(PROBLEMS[started.error.code]); else flash(PROBLEMS[started.error.code]); return; }
    setRec({ kind: 'recording', from, rec: started.value });
  }
  const openPanel = () => setPanel(current => current.kind === 'open' ? current : { kind: 'open', size: 'quarter' });
  /** Send what she said (the bubble, or the panel's live ↑): with something typed in the field, it goes after that
   *  instead, for her to send. A failure leaves the words heard so far in the field. */
  async function finishRecording() {
    const r = recRef.current; if (r.kind !== 'recording') return;
    setRec({ kind: 'transcribing', from: r.from });
    const typed = chat.current.draft.trim() !== '', soFar = heardSoFar, key = crypto.randomUUID(), clientId = crypto.randomUUID();
    if (r.from === 'bubble') openPanel();
    live.add(key);
    if (!typed) putPending({ key, clientId, text: soFar || null, phase: 'finishing', at: Date.now() });
    const words = r.rec.stop();
    const heard = await Promise.race([words, wait(FINISH_MS)]);
    if (alive.current) setRec({ kind: 'idle' });
    if (heard === 'late') {
      // Taking too long: her words go in the field now, and stay kept on the device until the rest has joined them.
      const put = placeWords(chat.current.draft, soFar); setDraft(put.shown);
      setPending(all => dropOnWay(all, key));
      if (alive.current) { openPanel(); setProblem(late(soFar)); }
      await settle(r.rec, words, put);
      live.delete(key); kept(all => dropOnWay(all, key));
      return;
    }
    live.delete(key);
    if (!heard.ok) { dropPending(key); const put = placeWords(chat.current.draft, soFar); setDraft(put.shown); failed(r.rec, heard.error, put); return; }
    if (typed) setDraft(d => joined(d, heard.value));
    else await sendText(heard.value, key, clientId);
  }
  /** The final text of words already placed in the field replaces them there (unless she has edited it meanwhile). */
  async function settle(clip: Recording, words: Promise<DictationResult<string>>, put: Placed) {
    const heard = await words;
    if (!heard.ok) { failed(clip, heard.error, put); return; }
    setDraft(d => settleWords(d, put, heard.value));
    if (alive.current) setProblem(current => current?.startsWith(LATE) ? null : current);
  }
  /** Stop and keep (the panel's ■, the bubble dropped on ✕ while recording, or the bubble going away): the words so far
   *  go in the field at once and become the final text when it comes, unless she has changed the field meanwhile. */
  async function keep(clip: Recording, words: Promise<DictationResult<string>>) {
    const put = placeWords(chat.current.draft, heardRef.current), key = crypto.randomUUID();
    setDraft(put.shown);
    live.add(key); kept(all => putOnWay(all, { key, clientId: crypto.randomUUID(), text: heardRef.current || null, phase: 'finishing', at: Date.now() }));
    if (alive.current) { setRec({ kind: 'transcribing', from: 'panel' }); openPanel(); }
    const first = await Promise.race([words, wait(FINISH_MS)]);
    if (alive.current) { setRec({ kind: 'idle' }); if (first === 'late') setProblem(late(put.shown)); }
    await settle(clip, words, put);
    live.delete(key); kept(all => dropOnWay(all, key));
  }
  function failed(clip: Recording, error: DictationError, put: Placed) {
    placed.current = put;
    if (!alive.current) return;
    openPanel(); setProblem(PROBLEMS[error.code]); setAgain(error.code === 'transcribe_failed' ? clip : null);
  }
  async function tryAgain() {
    const clip = again, put = placed.current; if (!clip || !put || recRef.current.kind !== 'idle') return;
    setAgain(null); setProblem(null); setRec({ kind: 'transcribing', from: 'panel' });
    const heard = await clip.retry();
    if (alive.current) setRec({ kind: 'idle' });
    if (heard.ok) { placed.current = null; setDraft(d => settleWords(d, put, heard.value)); }
    else failed(clip, heard.error, put);
  }
  function stopRecording() {
    const r = recRef.current; if (r.kind !== 'recording') return;
    void keep(r.rec, r.rec.stop());
  }
  const tap = (from: From) => { const r = recRef.current; if (r.kind === 'idle') void startRecording(from); else if (r.kind === 'recording') void finishRecording(); };

  const room = roomOf(layout, p.wide), target = targetOf(layout, p.wide);
  const place = (p.wide ? saved.wide : saved.phone) ?? FIRST_PLACE;
  const rest = pointOf(room, place);
  const overTarget = !!hold?.moved && over(hold.x, hold.y, target);

  function press(e: ReactPointerEvent<HTMLElement>, pill: boolean) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId); dragged.current = false;
    setHold({ pointerId: e.pointerId, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, moved: false, pill });
  }
  function move(e: ReactPointerEvent<HTMLElement>) {
    if (!hold || hold.pointerId !== e.pointerId) return;
    const moved = hold.moved || Math.hypot(e.clientX - hold.x0, e.clientY - hold.y0) > MOVE;
    setHold({ ...hold, x: e.clientX, y: e.clientY, moved });
  }
  function release(e: ReactPointerEvent<HTMLElement>) {
    if (!hold || hold.pointerId !== e.pointerId) return;
    const h = hold; setHold(null);
    // A tap is acted on in its click, after the finger is up: acting here would re-render the screen under the finger,
    // and the click that follows would land on whatever is there now (the panel's header).
    if (!h.moved) return;
    dragged.current = true;
    if (over(h.x, h.y, target)) {
      if (recRef.current.kind === 'recording') stopRecording();
      else if (!h.pill) save({ ...saved, hidden: true });
      return;
    }
    const at = snap(room, h.x - BUBBLE_SIZE / 2, h.y - BUBBLE_SIZE / 2);
    save({ ...saved, hidden: false, ...(p.wide ? { wide: at } : { phone: at }) });
  }
  const clicked = (pill: boolean) => () => {
    if (dragged.current) { dragged.current = false; return; }
    if (pill) save({ ...saved, hidden: false }); else tap('bubble');
  };
  const pointer = (pill: boolean) => ({
    onPointerDown: (e: ReactPointerEvent<HTMLElement>) => press(e, pill), onPointerMove: move, onPointerUp: release,
    onPointerCancel: () => setHold(null), onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
  });

  // The panel (phone): ¼ or ⅔ of the screen above the tab bar; its handle drags it between them, and down onto the ✕ or off.
  const heights = panelHeights(tallest.current);
  const bottom = p.wide ? 0 : fieldFocused ? layout.keyboard : Math.max(layout.tabs, layout.keyboard);
  const room4panel = layout.vh - layout.keyboard - (fieldFocused ? 0 : layout.tabs) - 24;
  const snapped = open ? Math.min(heights[panel.size], room4panel) : 0;
  const height = panelHold ? panelHold.h : snapped;
  const panelOverTarget = !!panelHold?.moved && over(layout.vw / 2, panelHold.y, { ...target, x: layout.vw / 2 });
  function grab(e: ReactPointerEvent<HTMLElement>) {
    if (p.wide || (e.pointerType === 'mouse' && e.button !== 0) || (e.target as Element).closest('button')) return;
    e.currentTarget.setPointerCapture(e.pointerId); dragged.current = false;
    setPanelHold({ pointerId: e.pointerId, y0: e.clientY, h0: snapped, h: snapped, y: e.clientY, t: e.timeStamp, v: 0, moved: false });
  }
  function drag(e: ReactPointerEvent<HTMLElement>) {
    const h = panelHold; if (!h || h.pointerId !== e.pointerId) return;
    const dt = Math.max(1, e.timeStamp - h.t), next = Math.min(heights.tall + 48, Math.max(0, h.h0 - (e.clientY - h.y0)));
    setPanelHold({ ...h, h: next, y: e.clientY, t: e.timeStamp, v: (h.y - e.clientY) / dt * 0.6 + h.v * 0.4, moved: h.moved || Math.abs(e.clientY - h.y0) > MOVE });
  }
  function letGo(e: ReactPointerEvent<HTMLElement>) {
    const h = panelHold; if (!h || h.pointerId !== e.pointerId) return;
    setPanelHold(null);
    if (!h.moved) return;
    dragged.current = true;
    const to = panelOverTarget ? 'closed' : settlePanel(h.h, h.v, heights);
    if (to === 'closed') close(); else setPanel({ kind: 'open', size: to });
  }

  const recording = rec.kind === 'recording', busy = rec.kind === 'starting' || rec.kind === 'transcribing';
  /** With the panel closed, the bubble shows dots while her words are on their way, and "Sent ✓" once the chat has them. */
  const onWayUnseen = !open && pending.length > 0;
  const showTarget = (hold?.moved ?? false) || (!!panelHold?.moved && panelHold.h < heights.quarter * 0.9);
  const showBubble = !saved.hidden || !!hold?.pill && hold.moved;
  const bubbleHidden = (!p.wide && open && !panelHold) || (typingElsewhere && !recording);
  const at = hold?.moved ? { x: hold.x - BUBBLE_SIZE / 2, y: hold.y - BUBBLE_SIZE / 2 } : rest;
  const right = place.side === 'right';
  const bubble = showBubble && !bubbleHidden && <button className={['bq-bubble', recording && 'rec', (busy || onWayUnseen) && 'busy', hold?.moved && 'held', scrolling && !hold && 'faint', p.wide && open && 'on'].filter(Boolean).join(' ')}
    style={{ left: at.x, top: at.y }} aria-label={recording ? 'Send what you said' : 'Talk to Kenaznia'}
    onClick={clicked(false)} {...pointer(false)}>
    {recording ? <Wave level={level}/> : (rec.kind === 'transcribing' && rec.from === 'bubble') || onWayUnseen ? <span className="bq-dots" aria-hidden="true"><i/><i/><i/></span> : <span aria-hidden="true">🌀</span>}
  </button>;
  const chipStyle: CSSProperties = { top: rest.y - 32, ...(right ? { right: layout.vw - rest.x - BUBBLE_SIZE - 6 } : { left: rest.x - 6 }) };
  const pillStyle: CSSProperties = p.wide ? { right: layout.vw - layout.pane.right + 20, bottom: layout.vh - layout.pane.bottom + 8 } : { right: 16, bottom: Math.max(8, layout.tabs - 12) };

  const panelView = open && <>
    {!p.wide && panel.size === 'tall' && !panelHold && <button className="bq-scrim" style={{ bottom }} aria-label="Make the panel smaller" onClick={() => setPanel({ kind: 'open', size: 'quarter' })}/>}
    <section ref={sheet} className={p.wide ? 'bq-panel bq-drawer' : `bq-panel${panelHold ? ' held' : ''}`} role="dialog" aria-label={p.chat.name}
      style={p.wide ? drawerStyle(layout) : { bottom, height }}>
      <header className="bq-handle" onPointerDown={grab} onPointerMove={drag} onPointerUp={letGo} onPointerCancel={() => setPanelHold(null)}
        onClick={e => { if (dragged.current) { dragged.current = false; return; } if (!p.wide && panel.kind === 'open' && !(e.target as Element).closest('button')) setPanel({ kind: 'open', size: panel.size === 'quarter' ? 'tall' : 'quarter' }); }}>
        {!p.wide && <span className="bq-grip" aria-hidden="true"/>}
        <span className="bq-head"><span aria-hidden="true">🌀</span> {p.chat.name}
          {bridge() && <button className="bq-open" aria-label="forest" onClick={() => void call('openFinder', {})}><FooterIcon id="finder"/></button>}
          <button className="bq-open" aria-label="Open the whole chat" onClick={() => { close(); p.openChat(); }}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15 3h6v6M10 14 21 3M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5"/></svg></button>
          {p.wide && <button className="bq-close" aria-label="Close" onClick={close}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg></button>}
        </span>
      </header>
      <div className="bq-msgs" ref={list} aria-live="polite" onScroll={e => stick.scrolled(e.currentTarget)} {...stick.input}>
        {p.chat.messages === null ? <p className="bq-quiet">Loading…</p> : !messages.length && !pending.length && <p className="bq-quiet">Say or type anything. It goes to your Kenaznia chat.</p>}
        {messages.length > messageCount && messageCount < 40 && <button className="bq-quiet" type="button" onClick={() => {
          const el = list.current, top = el?.getBoundingClientRect().top;
          const row = el && [...el.querySelectorAll('.bq-row')].find(row => row.getBoundingClientRect().bottom > top!);
          if (row) olderPosition.current = { row, top: row.getBoundingClientRect().top };
          following.current = false; setMessageCount(n => Math.min(40, n + 6));
        }}>Earlier messages</button>}
        {messages.slice(-messageCount).map((m, i, all) => { const label = stretchLabel(i === 0 ? null : all[i - 1]!.at, m.at, Date.now()); return <div key={m.id} className="bq-row">
          {label && <div className="bq-time">{label}</div>}
          <div className={m.mine ? 'bq-me' : 'bq-k'}>{m.mine ? <>{m.deletedAt ? <small className="message-deleted">message deleted</small> : <>{m.text}{m.editedAt && <small className="message-edited">edited</small>}</>}</> : <>{m.text.trim() && <MessageMarkdown text={m.text} source="agent"/>}{m.files.map(f => <p.FilePart key={f.fileId} part={f}/>)}</>}</div>
        </div>; })}
        {pending.map(m => <div key={m.key} className="bq-row bq-on-way">
          <div className="bq-me bq-pending">{m.text ?? <span className="bq-dots" aria-label="Writing down what you said"><i/><i/><i/></span>}</div>
          <p className="bq-state" role="status">{m.phase === 'finishing' ? 'Finishing…' : 'Sending…'}</p>
        </div>)}
        {recording && heardSoFar && <div className="bq-me bq-pending bq-live">{heardSoFar}</div>}
        {recording && liveLost && <p className="bq-state" role="status">Live words paused: they'll all be written down when you stop</p>}
        {rec.kind === 'transcribing' && !pending.some(m => m.phase === 'finishing') && <p className="bq-state" role="status">Finishing…</p>}
        {p.chat.working && !(last && !last.mine && last.streaming) && <p className="bq-thinking" role="status">{p.chat.name} is thinking…</p>}
        {p.chat.busy && <BusyLine line={p.chat.busy} className="bq-thinking bq-busy"/>}
      </div>
      {problem && <p className="bq-problem" role="alert">{problem}{again && <button type="button" onClick={tryAgain}>Try again</button>}</p>}
      <form className="bq-input" onSubmit={e => { e.preventDefault(); const t = draft.trim(); if (t && !pending.some(m => m.phase === 'sending')) { setDraft(''); void sendText(t); } }}>
        {emojiSuggest.list}
        {recording && rec.from === 'panel'
          ? <span className="bq-recbar"><Wave level={level}/><span ref={barClock}>0:00</span><button type="button" aria-label="Stop: keep the words to edit" onClick={stopRecording}><i className="bq-stop"/></button></span>
          : <input data-update-draft ref={quickInput} aria-label={`Message ${p.chat.name}`} placeholder={`Message ${p.chat.name}…`} value={draft} enterKeyHint="send"
            onChange={e => { setDraft(e.currentTarget.value); emojiSuggest.track(e); }} onSelect={emojiSuggest.track} onKeyDown={emojiSuggest.onKey} onFocus={() => setFieldFocused(true)} onBlur={() => setFieldFocused(false)}/>}
        {recording && rec.from === 'panel'
          ? <button className="bq-mic bq-send-live" type="button" aria-label="Send what you said" onClick={() => void finishRecording()}><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7"/></svg></button>
          : draft.trim()
          ? <button className="bq-mic" type="submit" aria-label="Send" disabled={pending.some(m => m.phase === 'sending')}><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7"/></svg></button>
          : <button className="bq-mic" type="button" aria-label="Talk" disabled={busy || recording} onClick={() => tap('panel')}>
            {busy && rec.from === 'panel' ? <span className="bq-dots" aria-hidden="true"><i/><i/><i/></span> : <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" x2="12" y1="19" y2="22"/></svg>}
          </button>}
      </form>
    </section>
  </>;

  return <div className="bq">
    {panelView}
    {showTarget && <div className={overTarget || panelOverTarget ? 'bq-x hot' : 'bq-x'} style={{ left: target.x - 24, top: target.y - 24 }} aria-hidden="true"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg></div>}
    {bubble}
    {saved.hidden && !(open && !p.wide) && !typingElsewhere && <button className="bq-pill" style={hold?.pill && hold.moved ? { ...pillStyle, opacity: 0 } : pillStyle} aria-label="Bring back the Kenaznia bubble" onClick={clicked(true)} {...pointer(true)}><span aria-hidden="true">🌀</span></button>}
    {recording && rec.from === 'bubble' && !hold?.moved && !bubbleHidden && <button type="button" className="bq-chip bq-chip-send" ref={chip} style={chipStyle} aria-label="Send what you said" onClick={() => void finishRecording()}>0:00 · tap to send</button>}
    {note && !recording && <span className="bq-chip bq-note" style={saved.hidden ? { ...pillStyle, bottom: (pillStyle.bottom as number) + 36 } : chipStyle} role="status">{note}</span>}
  </div>;
}

/** Laptop (mockup H): a floating drawer at the right of the main pane, above the bubble. */
function drawerStyle(l: Layout): CSSProperties {
  const bottom = l.vh - l.pane.bottom + Math.max(60, l.floor) + 16 + BUBBLE_SIZE + 16, top = Math.max(l.pane.top + 72, l.vh - bottom - 560);
  return { right: l.vw - l.pane.right + 16, bottom, top, width: Math.min(400, l.pane.width - 32) };
}
