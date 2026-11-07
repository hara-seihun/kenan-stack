// The composer's dictation button (extension `dictation`), loaded lazily: tap to record (a lime wave shows the level);
// the words appear in the composer's box as she speaks, and she can edit them meanwhile. This button or the timer chip
// (■) stops and leaves the text there to read, edit and send herself; the composer's Send (lit white meanwhile) stops
// and sends it. Nothing here ever removes words from the box (Carol 2026-10-24): leaving the chat, or the composer
// going away, stops the recording the same way and its words land in that chat's draft.
import { useEffect, useRef, useState } from 'react';
import { startRecording, type DictationResult, type Recording } from './dictation.js';
import { follow, type LiveBox } from './dictationText.js';
import './MicButton.css';

/** lucide's Mic, inline: importing lucide here would make the startup chunk export it. */
const Mic = ({ size }: { size: number }) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19v3"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><rect x="9" y="2" width="6" height="13" rx="3"/></svg>;

type State = { kind: 'idle' } | { kind: 'starting' } | { kind: 'recording'; recording: Recording; conversationId: string } | { kind: 'finishing' };
const BARS = [0.55, 0.85, 1, 0.75, 0.5];
/** Recordings already being finished: leaving the chat and a tap can both ask for the same one. */
const finishing = new WeakSet<Recording>();
const clock = (ms: number) => { const s = Math.floor(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

/** The composer's dictation in a chat: its words in the box she may edit meanwhile (`box`) while she speaks, its final
 *  words waiting for her typing to pause after she stopped, or why they could not come (shown with Try again). */
export type Dictation = { state: 'live' | 'settling'; box: LiveBox } | { state: 'failed'; box: LiveBox; message: string; retry: (() => void) | null };
type Dictations = Record<string, Dictation>;

/** What the composer gives its mic: each chat's dictation and draft, its box while it shows that chat, and sending. */
export interface Composer {
  dictations: Dictations;
  setDictations(change: (all: Dictations) => Dictations): void;
  draft(id: string): string;
  save(id: string, text: string): void;
  field(id: string): HTMLTextAreaElement | null;
  submit(id: string, body: string): void;
  /** While recording: what the composer's Send calls to stop and send; null otherwise. */
  onLive(finish: (() => void) | null): void;
  onError(message: string): void;
}

/** Dictation fills the box as she speaks, and she can edit it meanwhile (her edits win); she reads it and sends it
 *  herself (Send while recording stops and sends). Send ends the dictation: nothing it still had to write reaches the
 *  box after it, which Send empties. */
function dictationIn(c: Composer, id: string) {
  const current = c.dictations[id];
  const set = (next: Dictation | null) => c.setDictations(all => { const { [id]: _old, ...rest } = all; return next ? { ...rest, [id]: next } : rest; });
  return {
    start() {
      current?.box.stop();
      const box = follow({ field: () => c.field(id), save: text => c.save(id, text),
        ended: () => c.setDictations(all => { if (all[id]?.box !== box) return all; const { [id]: _done, ...rest } = all; return rest; }) }, c.draft(id));
      set({ state: 'live', box });
    },
    words(text: string) { if (current?.state === 'live') current.box.heard(text); },
    failed(message: string, retry: (() => void) | null) { if (current) set({ state: 'failed', box: current.box, message, retry }); },
    done(text: string, send: boolean) {
      if (!current) return;
      if (send) { const body = current.box.sent(text); set(null); if (body !== null) c.submit(id, body); }
      else { set({ state: 'settling', box: current.box }); current.box.settle(text); c.field(id)?.focus(); }
    },
  };
}

export function MicButton({ conversationId, disabled, composer }: { conversationId: string; disabled: boolean; composer: Composer }) {
  const [state, setState] = useState<State>({ kind: 'idle' });
  const [level, setLevel] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  /** The server stopped writing her words live; they come when she stops. */
  const [liveLost, setLiveLost] = useState(false);
  const latest = useRef(composer); latest.current = composer;
  const mounted = useRef(true);
  const current = useRef(state); current.current = state;
  const recording = state.kind === 'recording' ? state.recording : null;
  useEffect(() => () => { mounted.current = false; const s = current.current; if (s.kind === 'recording') void finish(s, false); }, []);
  useEffect(() => {
    if (!recording || state.kind !== 'recording') return;
    const id = state.conversationId;
    const off = recording.onLevel(value => { setLevel(value); setElapsed(recording.elapsedMs()); });
    const offWords = recording.onWords(text => dictationIn(latest.current, id).words(text));
    setLiveLost(false);
    const offLost = recording.onLiveLost(() => setLiveLost(true));
    return () => { off(); offWords(); offLost(); };
  }, [recording]);
  useEffect(() => { if (state.kind === 'recording' && state.conversationId !== conversationId) void finish(state, false); }, [conversationId]);
  useEffect(() => {
    if (state.kind !== 'recording') return;
    latest.current.onLive(() => void finish(state, true));
    return () => latest.current.onLive(null);
  }, [state]);

  async function start() {
    setState({ kind: 'starting' });
    const started = await startRecording();
    if (!started.ok) { if (mounted.current) setState({ kind: 'idle' }); if (started.error.code !== 'busy') latest.current.onError(started.error.message); return; }
    if (!mounted.current) { started.value.cancel(); return; }
    setLevel(0); setElapsed(0);
    dictationIn(latest.current, conversationId).start();
    setState({ kind: 'recording', recording: started.value, conversationId });
  }
  async function finish(live: Extract<State, { kind: 'recording' }>, send: boolean) {
    if (finishing.has(live.recording)) return;
    finishing.add(live.recording);
    if (mounted.current) setState({ kind: 'finishing' });
    const id = live.conversationId, rec = live.recording;
    const settle = (text: DictationResult<string>) => {
      if (mounted.current) setState({ kind: 'idle' });
      if (text.ok) dictationIn(latest.current, id).done(text.value, send);
      else dictationIn(latest.current, id).failed(text.error.message,
        text.error.code === 'transcribe_failed' ? () => { if (mounted.current) setState({ kind: 'finishing' }); void rec.retry().then(settle); } : null);
    };
    settle(await rec.stop());
  }

  if (state.kind === 'recording') return <>
    <button type="button" className="mic recording" aria-label="Stop: keep the words in the box" onClick={() => void finish(state, false)}>
      <span className="mic-wave" aria-hidden="true">{BARS.map((weight, i) => <i key={i} style={{ transform: `scaleY(${Math.max(0.15, Math.min(1, level * weight * 1.3))})` }}/>)}</span>
    </button>
    <button type="button" className="mic-chip" aria-label="Stop: keep the words in the box" onClick={() => void finish(state, false)}><span>{clock(elapsed)}</span>{liveLost && <span className="mic-later">words at stop</span>}<span className="mic-stop" aria-hidden="true"/></button>
  </>;
  const busy = state.kind !== 'idle';
  return <>
    <button type="button" className="mic" aria-label="Dictate a message" aria-busy={busy} disabled={disabled || busy} onClick={() => void start()}><Mic size={18}/></button>
    {state.kind === 'finishing' && <span className="mic-chip mic-finishing" role="status">Finishing…</span>}
  </>;
}
