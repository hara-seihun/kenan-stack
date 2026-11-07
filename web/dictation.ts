// Voice dictation: record from the microphone, transcribe on our own server, return text.
// Used by the chat composer's mic button and the floating bubble. Load it lazily (import('./dictation.js')).
// The clip is recorded with MediaRecorder (Opus, small) and streamed while she speaks, a second at a time, to
// /api/ext/dictation/stream/ID (server/extensions/dictation.ts), which writes it down pause by pause and answers each
// piece with the words so far; at stop only the last stretch is left. If the stream breaks (onLiveLost), the whole clip
// goes to /api/ext/dictation/transcribe once at stop instead (and again on retry()).
import { readResult } from './client.js';
import { apiPath } from './path.js';
import { beginUpdateActivity } from './updateActivity.js';

export type DictationError =
  | { code: 'mic_denied'; message: string }        // the person or Android refused microphone access
  | { code: 'mic_unavailable'; message: string }   // no microphone / MediaRecorder unsupported
  | { code: 'busy'; message: string }              // another recording is already running
  | { code: 'empty'; message: string }             // nothing was said (or the clip was too short)
  | { code: 'transcribe_failed'; message: string };// the server could not transcribe it

export type DictationResult<T> = { ok: true; value: T } | { ok: false; error: DictationError };

/** One live recording. Exactly one of stop() or cancel() ends it; both are idempotent. */
export interface Recording {
  /** Stops recording, uploads the clip, resolves with the transcript (corrections applied). The server deletes the audio. */
  stop(): Promise<DictationResult<string>>;
  /** After stop() failed with transcribe_failed: uploads the same clip again. */
  retry(): Promise<DictationResult<string>>;
  /** Stops and discards the clip; nothing is uploaded. */
  cancel(): void;
  /** The words written down so far, while recording and until stop() settles. Returns an unsubscribe function. */
  onWords(listener: (text: string) => void): () => void;
  /** The server stopped writing her words down as she speaks (its engine failed, it restarted): the words so far stay,
   *  and stop() writes the whole clip down at once. Called at most once. Returns an unsubscribe function. */
  onLiveLost(listener: () => void): () => void;
  /** Microphone level 0..1, about 30 times a second, while recording. Returns an unsubscribe function. */
  onLevel(listener: (level: number) => void): () => void;
  /** Milliseconds since recording started. */
  elapsedMs(): number;
}

const MIN_MS = 400;
/** Every request has an end, so stop() always settles: the server gives up on an engine and retries once on a fresh one
 *  (server/extensions/dictation.ts), which for a long piece on a failing GPU took 64 s (2026-10-27). */
const PIECE_MS = 120_000, LAST_MS = 150_000;
/** How often a piece of the recording goes to the server while she speaks. */
const SLICE_MS = 1000;
/** Opus is what Whisper's 16 kHz needs at a twentieth of WAV's size; the first type this browser records wins. */
const TYPES = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4;codecs=opus', 'audio/webm'];
/** The previous clip's whole round trip (stop pressed → text) and its share outside the server, reported with the next one. */
let previous: { lastMs: number; lastNetMs: number } | null = null;
const fail = <T>(code: DictationError['code'], message: string): DictationResult<T> => ({ ok: false, error: { code, message } } as DictationResult<T>);
let current: Recording | null = null;

/** Asks for the microphone (first time: the browser/Android prompt) and starts recording. */
export async function startRecording(): Promise<DictationResult<Recording>> {
  if (current) return fail('busy', 'Already recording');
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') return fail('mic_unavailable', 'This browser cannot record audio');
  // A focused text box may have the keyboard's own voice typing holding the microphone; closing the keyboard ends it.
  const focused = document.activeElement;
  if (focused instanceof HTMLElement && (focused.isContentEditable || focused.tagName === 'TEXTAREA' || focused.tagName === 'INPUT')) focused.blur();
  const done = beginUpdateActivity();
  let handedOff = false;
  try {
    const opened = await openMicrophone();
    if (!opened.ok) return opened;
    const stream = opened.value;
    if (current) { stream.getTracks().forEach(t => t.stop()); return fail('busy', 'Already recording'); }
    let recording: Recording;
    try { recording = record(stream); }
    catch (error) { stream.getTracks().forEach(t => t.stop()); throw error; }
    current = recording;
    let stopping = false;
    const protectedRecording: Recording = {
      ...recording,
      stop() { stopping = true; try { return recording.stop().finally(done); } catch (error) { done(); throw error; } },
      cancel() { if (stopping) return; try { recording.cancel(); } finally { done(); } },
      retry() {
        const retried = beginUpdateActivity();
        try { return recording.retry().finally(retried); }
        catch (error) { retried(); throw error; }
      },
    };
    handedOff = true;
    return { ok: true, value: protectedRecording };
  } finally { if (!handedOff) done(); }
}

// Each attempt asks Android for less. With voice processing (echo cancellation and friends), Chromium switches Android
// into call mode and picks a "communication device", which fails with NotReadableError on some phones, notably with a
// Bluetooth headset connected or in an app without MODIFY_AUDIO_SETTINGS. Whisper needs none of that processing.
const ATTEMPTS: MediaTrackConstraints[] = [
  { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
];
const RETRYABLE = new Set(['NotReadableError', 'OverconstrainedError', 'AbortError', 'TrackStartError', 'ConstraintNotSatisfiedError']);

async function openMicrophone(): Promise<DictationResult<MediaStream>> {
  let last = '';
  for (const audio of ATTEMPTS) {
    try {
      return { ok: true, value: await navigator.mediaDevices.getUserMedia({ audio }) };
    } catch (e) {
      const name = (e as DOMException).name;
      if (name === 'NotAllowedError' || name === 'SecurityError') return fail('mic_denied', 'Microphone access is off. Allow it when asked, or in Android: Settings → Apps → Kenan → Permissions → Microphone.');
      if (name === 'NotFoundError') return fail('mic_unavailable', 'No microphone found on this device');
      last = name || String(e);
      if (!RETRYABLE.has(name)) break;
    }
  }
  return fail('mic_unavailable', `Couldn't open the microphone: is another app or a Bluetooth headset using it? (${last})`);
}

function record(stream: MediaStream): Recording {
  const context = new AudioContext();
  const mimeType = TYPES.find(t => MediaRecorder.isTypeSupported(t));
  const analyser = context.createAnalyser();
  analyser.fftSize = 1024;
  context.createMediaStreamSource(stream).connect(analyser);
  const samples = new Float32Array(analyser.fftSize);
  const listeners = new Set<(level: number) => void>();
  const wordListeners = new Set<(text: string) => void>();
  const lostListeners = new Set<() => void>();
  const chunks: Blob[] = [];
  const recorder = new MediaRecorder(stream, mimeType ? { mimeType, audioBitsPerSecond: 32_000 } : {});
  const stopped = new Promise<void>(resolve => recorder.addEventListener('stop', () => resolve(), { once: true }));
  const id = crypto.randomUUID();
  /** Stream state: bytes handed to the server so far, chunks already in them, the piece on its way, and whether it broke. */
  let sentBytes = 0, sentChunks = 0, ended = false, broken = false;
  let inFlight: Promise<void> | null = null;
  const words = (text: string) => wordListeners.forEach(listener => listener(text));
  const pieceOf = () => { const piece = new Blob(chunks.slice(sentChunks), { type: recorder.mimeType || 'audio/webm' }); sentChunks = chunks.length; const at = sentBytes; sentBytes += piece.size; return { at, piece }; };
  const flush = () => {
    if (inFlight || ended || broken || sentChunks === chunks.length) return;
    const { at, piece } = pieceOf();
    inFlight = post(id, at, piece, false, null).then(r => { if (r.ok) { if (!ended) words(r.value.text); } else { broken = true; lostListeners.forEach(listener => listener()); lostListeners.clear(); } }).finally(() => { inFlight = null; flush(); });
  };
  recorder.addEventListener('dataavailable', e => { if (e.data.size) { chunks.push(e.data); flush(); } });
  recorder.start(SLICE_MS);
  const started = performance.now();
  let endedAt: number | null = null;
  const meter = setInterval(() => {
    analyser.getFloatTimeDomainData(samples);
    let sum = 0; for (const s of samples) sum += s * s;
    const level = Math.min(1, Math.sqrt(Math.sqrt(sum / samples.length) / 0.2));
    listeners.forEach(listener => listener(level));
  }, 33);
  const release = () => {
    clearInterval(meter); listeners.clear();
    if (recorder.state !== 'inactive') recorder.stop();
    stream.getTracks().forEach(t => t.stop());
    if (current === self) current = null;
  };
  const drop = () => { if (sentBytes) void fetch(apiPath(`/api/ext/dictation/stream/${id}`), { method: 'DELETE', credentials: 'same-origin', keepalive: true }).catch(() => undefined); };
  let result: Promise<DictationResult<string>> | null = null;
  let clip: Blob | null = null;
  const self: Recording = {
    elapsedMs: () => (endedAt ?? performance.now()) - started,
    onLevel(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    onWords(listener) { wordListeners.add(listener); return () => { wordListeners.delete(listener); }; },
    onLiveLost(listener) { if (broken) { listener(); return () => undefined; } lostListeners.add(listener); return () => { lostListeners.delete(listener); }; },
    cancel() {
      if (result) return;
      endedAt = performance.now(); ended = true;
      result = Promise.resolve(fail('empty', 'Cancelled'));
      release(); void context.close(); wordListeners.clear(); lostListeners.clear(); drop();
    },
    stop() {
      if (result) return result;
      endedAt = performance.now();
      const pressed = endedAt, duration = endedAt - started;
      release(); void context.close();
      result = (async () => {
        await stopped;
        ended = true;
        clip = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
        if (duration < MIN_MS) { drop(); return fail<string>('empty', 'Too short: tap once to start, again to send'); }
        while (inFlight) await inFlight;
        const streamed = broken ? null : await (async () => { const { at, piece } = pieceOf(); return post(id, at, piece, true, pressed); })();
        const heard = streamed?.ok ? streamed.value.text : null;
        const outcome: DictationResult<string> = heard !== null ? (heard ? { ok: true, value: heard } : fail('empty', 'Nothing was heard')) : await upload(clip, pressed);
        wordListeners.clear(); lostListeners.clear();
        return outcome;
      })();
      return result;
    },
    retry() { return clip ? upload(clip, performance.now()) : Promise.resolve(fail<string>('transcribe_failed', 'Nothing to send again')); },
  };
  return self;
}

/** One piece of a live dictation; `pressed` (stop's time) marks the last one, which is answered with the whole text. */
async function post(id: string, at: number, piece: Blob, end: boolean, pressed: number | null): Promise<{ ok: true; value: { text: string } } | { ok: false }> {
  try {
    const timing = pressed === null ? null : { prepMs: Math.round(performance.now() - pressed), ...previous };
    const response = await fetch(apiPath(`/api/ext/dictation/stream/${id}?at=${at}${end ? '&end=1' : ''}`), { method: 'POST', credentials: 'same-origin', headers: { 'content-type': piece.type, ...(timing ? { 'x-dictation-client': JSON.stringify(timing) } : {}) }, body: piece, signal: AbortSignal.timeout(end ? LAST_MS : PIECE_MS) });
    const { text, ms } = await readResult<{ text: string; ms: number }>(response);
    if (pressed !== null && timing) { const lastMs = Math.round(performance.now() - pressed); previous = { lastMs, lastNetMs: lastMs - ms - timing.prepMs }; }
    return { ok: true, value: { text } };
  } catch {
    return { ok: false };
  }
}

async function upload(clip: Blob, pressed: number): Promise<DictationResult<string>> {
  try {
    const timing = { prepMs: Math.round(performance.now() - pressed), ...previous };
    const response = await fetch(apiPath('/api/ext/dictation/transcribe'), { method: 'POST', credentials: 'same-origin', headers: { 'content-type': clip.type, 'x-dictation-client': JSON.stringify(timing) }, body: clip, signal: AbortSignal.timeout(LAST_MS) });
    const { text, ms } = await readResult<{ text: string; ms: number }>(response);
    const lastMs = Math.round(performance.now() - pressed);
    previous = { lastMs, lastNetMs: lastMs - ms - timing.prepMs };
    return text ? { ok: true, value: text } : fail('empty', 'Nothing was heard');
  } catch (e) {
    return fail('transcribe_failed', e instanceof Error ? e.message : String(e));
  }
}
