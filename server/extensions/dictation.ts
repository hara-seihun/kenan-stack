// Dictation (extension `dictation`): the app records a clip, sends it here as recorded (Opus in WebM/Ogg/MP4, or
// 16 kHz mono WAV), and gets text back. Compressed clips are decoded with ffmpeg, as nobody, in memory.
// Transcription runs on this host with whisper.cpp (`whisper-server`, Vulkan on the iGPU when there is one), never
// through an outside service. The clip lives only in memory for the one request. Each person may keep
// HOME/ID/dictation.json: `vocabulary` (names whisper should expect, given as its prompt), `corrections` (exact
// mishearings replaced afterwards, e.g. "10 deaf" → "Business") and `corrections_LANG` (e.g. `corrections_fr`: replaced
// only in text heard in that language, before `corrections`); agents and the person edit that file directly.
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { stat, readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { availableParallelism } from 'node:os';
import type { PersonConfig } from '../config.js';
import { fail } from '../db/errors.js';
import { personOf } from '../http/app.js';
import type { Extension } from '../types.js';
import { cutPoint, hasVoice, voicedTime } from './dictation-segment.js';
import { baselineOf, FRAME, fuse, StreamTrack, trackOf, voiceAt, wordsOf, type Word } from './dictation-punctuation.js';

const MODEL_DIR = '/var/lib/kenan/models/whisper';
/** What deploy/dictation-models.sh installs (and verifies) when a channel enables dictation for anyone. */
export const MODELS = [
  { file: 'ggml-large-v3-turbo-q5_0.bin', url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin', sha256: '394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2' },
  { file: 'ggml-silero-v5.1.2.bin', url: 'https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin', sha256: '29940d98d42b91fbd05ce489f3ecf7c72f0a42f027e4875919a28fb4c04ea2cf' },
  { file: 'ggml-base-q5_1.bin', url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base-q5_1.bin', sha256: '422f1ae452ade6f30a004d7e5c6a43195e4433bc370bf23fac9cc591f01a8898' },
] as const;
const RENDER_NODE = '/dev/dri/renderD128';
const NOBODY = 65534;
const SAMPLE_RATE = 16_000;
const MIN_SECONDS = 0.3;
export const MAX_SECONDS = 300;
const MAX_PROMPT_CHARS = 600;
const START_MS = 90_000;
const WARM_MS = 120_000;
const INFER_BASE_MS = 20_000;
const INFER_PER_SECOND_MS = 1_000;
const DECODE_MS = 30_000;
/** Clips up to this long go to the engine whose encoder looks at 15.36 s instead of 30 s (about twice as fast). */
export const SHORT_SECONDS = 15;
const SHORT_AUDIO_CTX = 768;
const MAX_COMPRESSED_BYTES = 8 * 1024 * 1024;

export type DictationFailure = { code: 'invalid_input' | 'unavailable' | 'not_found'; message: string };
type Outcome<T> = { ok: true; value: T } | { ok: false; error: DictationFailure };
const err = (code: DictationFailure['code'], message: string): { ok: false; error: DictationFailure } => ({ ok: false, error: { code, message } });

/** `byLanguage`: corrections applied only to text whisper heard in that language (ISO 639-1/3 code), before `corrections`. */
export interface Profile { vocabulary: string[]; corrections: [string, string][]; byLanguage: Record<string, [string, string][]> }
const LANGUAGE_KEY = /^corrections_([a-z]{2,3})$/;
/** The corrections for text heard in `lang` (null: language unknown, only the general ones). */
export const correctionsFor = (profile: Profile, lang: string | null): [string, string][] => [...(lang ? profile.byLanguage[lang] ?? [] : []), ...profile.corrections];
export const profilePath = (person: Pick<PersonConfig, 'home' | 'id'>) => join(person.home, person.id, 'dictation.json');

/** The person's vocabulary and corrections; no file means none. A file that isn't the documented shape is an error. */
export function parseProfile(text: string, path: string): Outcome<Profile> {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch (e) { return err('invalid_input', `${path} is not valid JSON (${(e as Error).message}); fix it or ask Kenan to`); }
  const bad = (what: string) => err('invalid_input', `${path}: ${what}. Expected {"vocabulary": ["Name", …], "corrections": {"heard": "meant", …}, "corrections_fr": {"heard": "meant", …}}`);
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return bad('not an object');
  const unknown = Object.keys(raw).filter(k => k !== 'vocabulary' && k !== 'corrections' && !LANGUAGE_KEY.test(k));
  if (unknown.length) return bad(`unknown key ${unknown.join(', ')}`);
  const { vocabulary = [], corrections = {} } = raw as { vocabulary?: unknown; corrections?: unknown };
  if (!Array.isArray(vocabulary) || !vocabulary.every(w => typeof w === 'string' && w.trim())) return bad('"vocabulary" must be a list of non-empty strings');
  const pairsOf = (key: string, value: unknown): Outcome<[string, string][]> => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return bad(`"${key}" must be an object`);
    const pairs = Object.entries(value);
    if (!pairs.every(([from, to]) => from.trim() && typeof to === 'string')) return bad(`every correction in "${key}" maps a non-empty heard text to a string`);
    return { ok: true, value: pairs as [string, string][] };
  };
  const general = pairsOf('corrections', corrections);
  if (!general.ok) return general;
  const byLanguage: Record<string, [string, string][]> = {};
  for (const [key, value] of Object.entries(raw)) {
    const lang = LANGUAGE_KEY.exec(key)?.[1];
    if (!lang) continue;
    const pairs = pairsOf(key, value);
    if (!pairs.ok) return pairs;
    byLanguage[lang] = pairs.value;
  }
  const profile = { vocabulary: vocabulary as string[], corrections: general.value, byLanguage };
  if (prompt(profile).length > MAX_PROMPT_CHARS) return bad(`"vocabulary" is longer than ${MAX_PROMPT_CHARS} characters; whisper reads only so much, keep the names that get misheard`);
  return { ok: true, value: profile };
}

async function readProfile(person: Pick<PersonConfig, 'home' | 'id'>): Promise<Outcome<Profile>> {
  const path = profilePath(person);
  try { return parseProfile(await readFile(path, 'utf8'), path); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { ok: true, value: { vocabulary: [], corrections: [], byLanguage: {} } };
    return err('unavailable', `${path} could not be read: ${(e as Error).message}`);
  }
}

const prompt = (profile: Profile) => profile.vocabulary.map(w => w.trim()).join(', ');
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Replaces each heard text, as a whole word or phrase, case-insensitively, in file order; then closes a French elision
 *  whisper split off its word ("s 'est" → "s'est", "l' application" → "l'application"). */
export function correct(text: string, corrections: [string, string][]): string {
  let out = text;
  for (const [from, to] of corrections) out = out.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escape(from.trim())}(?![\\p{L}\\p{N}])`, 'giu'), () => to);
  return out.replace(/\s+/g, ' ').replace(ELISION, '$1$2').trim();
}
const ELISION = /(?<![\p{L}\p{N}])([cdjlmnst]|qu|jusqu|lorsqu|puisqu) (['’])(?=\p{L})/giu;

const loopKey = (token: string) => token.toLowerCase().replace(/’/g, "'").replace(/^[^\p{L}\p{N}']+|[^\p{L}\p{N}']+$/gu, '');

/** Whisper's decoding loop undone: a run of words said over and over back to back (a phrase of 2+ words 3+ times, one
 *  word 5+ times, punctuation and case aside) is written once, as its last copy. Nobody dictates the same sentence thrice in a row. */
export function unloop(text: string): string {
  const tokens = text.split(/\s+/).filter(Boolean), keys = tokens.map(loopKey), out: string[] = [];
  const same = (a: number, b: number, n: number) => { for (let k = 0; k < n; k++) if (keys[a + k] !== keys[b + k] || !keys[a + k]) return false; return true; };
  for (let i = 0; i < tokens.length;) {
    let skip = 0;
    for (let n = 1; n <= (tokens.length - i) / 3 && !skip; n++) {
      let copies = 1;
      while (i + (copies + 1) * n <= tokens.length && same(i, i + copies * n, n)) copies++;
      if (copies >= (n === 1 ? 5 : 3)) skip = (copies - 1) * n;
    }
    if (skip) i += skip; else out.push(tokens[i++]!);
  }
  return out.join(' ');
}

/** Text alone (no audio): the fusion of whisper's marks and the words around them. */
export const punctuate = (text: string, vocabulary: string[]) => fuse(wordsOf(text), vocabulary);

/** The previous words as whisper's prompt: the vocabulary as its own sentence, then the text so far from a word start,
 *  punctuation kept, so whisper goes on punctuating where the last piece stopped. */
export function contextPrompt(vocabulary: string, before: string): string {
  const tail = before.length > CONTEXT_CHARS ? before.slice(-CONTEXT_CHARS).replace(/^\S*\s+/, '') : before;
  return [vocabulary && `${vocabulary}.`, tail].filter(Boolean).join(' ');
}

/** The samples of a 16 kHz mono 16-bit PCM WAV, or why it isn't one. */
export function wavSamples(wav: Uint8Array): Outcome<Int16Array> {
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  const tag = (at: number) => String.fromCharCode(...wav.subarray(at, at + 4));
  if (wav.byteLength < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return err('invalid_input', 'The clip is not a WAV file');
  let format: { channels: number; rate: number; bits: number; pcm: boolean } | null = null;
  for (let at = 12; at + 8 <= wav.byteLength;) {
    const id = tag(at); const size = view.getUint32(at + 4, true);
    if (id === 'fmt ' && size >= 16 && at + 24 <= wav.byteLength) {
      format = { pcm: view.getUint16(at + 8, true) === 1, channels: view.getUint16(at + 10, true), rate: view.getUint32(at + 12, true), bits: view.getUint16(at + 22, true) };
    }
    if (id === 'data') {
      if (!format) return err('invalid_input', 'The WAV clip has no format before its data');
      if (!format.pcm || format.channels !== 1 || format.rate !== SAMPLE_RATE || format.bits !== 16) return err('invalid_input', `The clip must be 16 kHz mono 16-bit PCM (got ${format.rate} Hz, ${format.channels} channel(s), ${format.bits} bit${format.pcm ? '' : ', not PCM'})`);
      const bytes = wav.slice(at + 8, at + 8 + (Math.min(size, wav.byteLength - at - 8) & ~1));
      return { ok: true, value: new Int16Array(bytes.buffer, 0, bytes.byteLength >> 1) };
    }
    at += 8 + size + (size % 2);
  }
  return err('invalid_input', 'The WAV clip has no data');
}

/** Seconds of audio in a 16 kHz mono 16-bit PCM WAV, or why it isn't one. */
export function wavSeconds(wav: Uint8Array): Outcome<number> {
  const samples = wavSamples(wav);
  return samples.ok ? { ok: true, value: samples.value.length / SAMPLE_RATE } : samples;
}

/** A whisper-server answering on `port` until `kill()`; `exited` settles with why it ended. */
export interface Running { port: number; exited: Promise<string>; kill(): void }

const freePort = () => new Promise<number>((resolve, reject) => {
  const probe = createServer();
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => { const { port } = probe.address() as { port: number }; probe.close(() => resolve(port)); });
});

/** Runs as nobody with only the render node's group, so it can use the GPU and read the models and nothing of ours. */
/** What one whisper-server runs: `files` are model files it needs (MODELS), `args` refer to them as {0}, {1}…. */
export interface EngineSpec { files: string[]; args: string[] }
const TURBO = 'ggml-large-v3-turbo-q5_0.bin', VAD = 'ggml-silero-v5.1.2.bin', SMALL = 'ggml-base-q5_1.bin';

let accelerator: Promise<Outcome<number | null>> | undefined;
/** Virtual machines can have a render node without a compute device (Virtio guests).
 *  Ask the installed runtime, as the same account that will perform inference. */
async function probeAccelerator(): Promise<Outcome<number | null>> {
  const render = await stat(RENDER_NODE).catch(() => null);
  if (!render) return { ok: true, value: null };
  try {
    const { stderr } = await promisify(execFile)('whisper-server', ['--help'], {
      timeout: 5000, maxBuffer: 256 * 1024,
      env: { PATH: '/usr/bin:/bin', HOME: '/nonexistent', MESA_SHADER_CACHE_DISABLE: 'true' },
      ...(process.getuid?.() === 0 ? { uid: NOBODY, gid: render.gid } : {}),
    });
    return { ok: true, value: /ggml_vulkan: Found [1-9]\d* Vulkan devices:/.test(stderr) ? render.gid : null };
  } catch (e) {
    return err('unavailable', `Could not check dictation's accelerator: ${(e as Error).message}`);
  }
}

async function launch(dir: string, spec: EngineSpec): Promise<Outcome<Running>> {
  const device = await (accelerator ??= probeAccelerator());
  if (!device.ok) return device;
  const gpu = device.value !== null;
  // Turbo needs an accelerator for interactive dictation. CPU-only hosts use the installed
  // multilingual base model for transcription too, without oversubscribing a small VM.
  const files = spec.files.map(f => !gpu && f === TURBO ? SMALL : f);
  const threads = Math.min(gpu ? 8 : 4, availableParallelism());
  const paths = files.map(f => join(dir, f));
  for (const path of paths) {
    if (!(await stat(path).then(s => s.isFile(), () => false))) return err('unavailable', `Dictation's model ${path} is missing; a deploy of a channel with dictation enabled installs it`);
  }
  const gpuGroup = device.value ?? NOBODY;
  const port = await freePort();
  const asRoot = process.getuid?.() === 0;
  const child = spawn('whisper-server', [...spec.args.map(a => a.replace(/\{(\d)\}/g, (_, i: string) => paths[Number(i)]!)), '--host', '127.0.0.1', '--port', String(port), '-t', String(threads), '-l', 'auto', '-nt', ...(!gpu ? ['-ng'] : [])], {
    stdio: ['ignore', 'ignore', 'pipe'], env: { PATH: '/usr/bin:/bin', HOME: '/nonexistent', MESA_SHADER_CACHE_DISABLE: 'true' },
    ...(asRoot ? { uid: NOBODY, gid: gpuGroup } : {}),
  });
  let log = '';
  child.stderr!.on('data', (chunk: Buffer) => { log = (log + chunk.toString()).slice(-2000); });
  const exited = new Promise<string>(resolve => {
    child.once('error', e => resolve((e as NodeJS.ErrnoException).code === 'ENOENT' ? 'whisper-server is not installed (Ubuntu package whisper.cpp)' : String(e)));
    child.once('exit', (code, signal) => resolve(`whisper-server exited (${signal ?? code}): ${log.trim().split('\n').slice(-3).join(' | ')}`));
  });
  const deadline = Date.now() + START_MS;
  while (Date.now() < deadline) {
    const settled = await Promise.race([exited, new Promise<null>(r => setTimeout(() => r(null), 250))]);
    if (settled !== null) return err('unavailable', settled);
    if (await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1000) }).then(() => true, () => false)) {
      const running = { port, exited, kill: () => { child.kill('SIGKILL'); } };
      // Only Vulkan needs pipeline compilation. Synthetic buzz on CPU wastes a full
      // inference pass, can trigger decoding fallbacks, and delays the first real clip.
      if (gpu) await warm(running);
      return { ok: true, value: running };
    }
  }
  child.kill('SIGKILL');
  return err('unavailable', `whisper-server did not start within ${START_MS / 1000} s`);
}

/** One whisper-server, started at channel start (or on first use). GPU pipelines are warmed by launch. One that dies, or fails a request
 *  (after a GPU reset it stays up and fails every clip: Carol 2026-10-25), is replaced on the next clip. */
export class Engine {
  constructor(readonly name: string, private readonly start: () => Promise<Outcome<Running>>, private readonly log: (line: object) => void) {}
  private current: { attempt: Promise<Outcome<Running>>; running: Running | null } | null = null;
  ensure(): Promise<Outcome<Running>> {
    if (this.current) return this.current.attempt;
    const slot: { attempt: Promise<Outcome<Running>>; running: Running | null } = { attempt: this.start(), running: null };
    this.current = slot;
    void slot.attempt.then(r => {
      if (!r.ok) { if (this.current === slot) this.current = null; return; }
      slot.running = r.value;
      void r.value.exited.then(reason => { if (this.current !== slot) return; this.current = null; this.log({ type: 'dictation_engine', engine: this.name, event: 'exited', reason }); });
    });
    return slot.attempt;
  }
  /** `running` failed a request: it is stopped, and the next request starts a fresh one. */
  discard(running: Running, reason: string) {
    if (this.current?.running !== running) return;
    this.current = null;
    running.kill();
    this.log({ type: 'dictation_engine', engine: this.name, event: 'replaced', reason: reason.slice(0, 300) });
  }
  async stop() {
    const slot = this.current; this.current = null;
    const r = await slot?.attempt;
    if (r?.ok) r.value.kill();
  }
}
/** short and full write clips down (full: past SHORT_SECONDS); lid, a small model, names the language first, which
 *  spares the big model its own detection pass (half its time). */
export interface Engines { short: Engine; full: Engine; lid: Engine }
export const engineSpecs: Record<keyof Engines, EngineSpec> = {
  short: { files: [TURBO, VAD], args: ['-m', '{0}', '--vad', '-vm', '{1}', '-ac', String(SHORT_AUDIO_CTX)] },
  full: { files: [TURBO, VAD], args: ['-m', '{0}', '--vad', '-vm', '{1}'] },
  lid: { files: [SMALL], args: ['-m', '{0}', '-ac', String(SHORT_AUDIO_CTX)] },
};
const logLine = (line: object) => console.log(JSON.stringify(line));
const engineOf = (name: keyof Engines) => new Engine(name, () => launch(MODEL_DIR, engineSpecs[name]), logLine);
const engines: Engines = { short: engineOf('short'), full: engineOf('full'), lid: engineOf('lid') };
/** A 16 kHz mono WAV of at most MAX_SECONDS written down on this channel's engines (After Hours memos use it). */
export const transcribeWav = (person: Pick<PersonConfig, 'home' | 'id'>, wav: Uint8Array<ArrayBuffer>) => transcribe(engines, person, wav, 'wav');
/** Below this the small model isn't sure, and the big one detects the language itself. */
const LID_SURE = 0.5;

/** 1.5 s of a voiced, syllable-paced buzz: enough for the VAD to pass it, so the first real clip finds the GPU pipelines built. */
function warmClip(): Uint8Array<ArrayBuffer> {
  const n = Math.round(1.5 * SAMPLE_RATE), pcm = new Int16Array(n);
  const partials: [number, number][] = [[140, 1], [280, 0.8], [700, 0.6], [1200, 0.5], [2400, 0.3]];
  for (let i = 0; i < n; i++) {
    const t = i / SAMPLE_RATE;
    const voice = partials.reduce((sum, [f, a]) => sum + a * Math.sin(2 * Math.PI * f * t), 0);
    pcm[i] = Math.round((0.5 + 0.5 * Math.sin(2 * Math.PI * 4 * t)) * voice * 0.15 * 0x7fff);
  }
  return wavOf(new Uint8Array(pcm.buffer));
}

async function warm(running: Running) {
  const form = new FormData();
  form.append('file', new Blob([warmClip()], { type: 'audio/wav' }), 'warm.wav');
  form.append('response_format', 'json');
  await fetch(`http://127.0.0.1:${running.port}/inference`, { method: 'POST', body: form, signal: AbortSignal.timeout(WARM_MS) }).then(r => r.arrayBuffer(), () => undefined);
}

/** A 16 kHz mono 16-bit WAV around raw little-endian PCM. */
export function wavOf(pcm: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(44 + pcm.byteLength); const view = new DataView(out.buffer);
  const tag = (at: number, text: string) => { for (let i = 0; i < 4; i++) out[at + i] = text.charCodeAt(i); };
  tag(0, 'RIFF'); view.setUint32(4, 36 + pcm.byteLength, true); tag(8, 'WAVE'); tag(12, 'fmt '); view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, SAMPLE_RATE, true); view.setUint32(28, SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); tag(36, 'data'); view.setUint32(40, pcm.byteLength, true);
  out.set(pcm, 44);
  return out;
}

/** Decodes a recorded clip (whatever MediaRecorder made) to 16 kHz mono WAV with ffmpeg, as nobody, never touching disk. */
export async function decodeClip(clip: Uint8Array): Promise<Outcome<Uint8Array<ArrayBuffer>>> {
  const asRoot = process.getuid?.() === 0;
  const child = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', 'pipe:0', '-ac', '1', '-ar', String(SAMPLE_RATE), '-t', String(MAX_SECONDS + 1), '-f', 's16le', 'pipe:1'], {
    stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin', HOME: '/nonexistent' }, ...(asRoot ? { uid: NOBODY, gid: NOBODY } : {}),
  });
  const out: Buffer[] = []; let log = '';
  child.stdout!.on('data', (chunk: Buffer) => out.push(chunk));
  child.stderr!.on('data', (chunk: Buffer) => { log = (log + chunk.toString()).slice(-600); });
  child.stdin!.on('error', () => undefined);
  child.stdin!.end(clip);
  const timer = setTimeout(() => child.kill('SIGKILL'), DECODE_MS);
  const ended = await new Promise<string | null>(resolve => {
    child.once('error', e => resolve((e as NodeJS.ErrnoException).code === 'ENOENT' ? 'ffmpeg is not installed (Ubuntu package ffmpeg)' : String(e)));
    child.once('close', (code, signal) => resolve(code === 0 ? null : `ffmpeg exited (${signal ?? code}): ${log.trim().split('\n').slice(-2).join(' | ')}`));
  });
  clearTimeout(timer);
  if (ended !== null) return ended.startsWith('ffmpeg is not installed') ? err('unavailable', ended) : err('invalid_input', `The recording could not be read: ${ended}`);
  return { ok: true, value: wavOf(Buffer.concat(out)) };
}

/** How long a request may take: a hung engine (a wedged GPU) must fail in seconds, not hold a live dictation for minutes. */
const timeoutFor = (wav: Uint8Array) => INFER_BASE_MS + Math.ceil(Math.max(0, wav.byteLength - 44) / (SAMPLE_RATE * 2)) * INFER_PER_SECOND_MS;

/** One request to an engine's /inference, read by `read`. A request it fails (no answer, an error, nonsense) replaces
 *  the engine and is made once more on a fresh one; the second failure is the answer. */
async function infer<T>(engine: Engine, form: () => FormData, wav: Uint8Array, read: (status: number, body: Record<string, unknown>) => Outcome<T>): Promise<Outcome<T>> {
  const once = async (): Promise<Outcome<T>> => {
    const running = await engine.ensure();
    if (!running.ok) return running;
    let result: Outcome<T>;
    try {
      const response = await fetch(`http://127.0.0.1:${running.value.port}/inference`, { method: 'POST', body: form(), signal: AbortSignal.timeout(timeoutFor(wav)) });
      const body: unknown = await response.json();
      result = typeof body === 'object' && body !== null ? read(response.status, body as Record<string, unknown>) : err('unavailable', `${engine.name} engine answered ${response.status} with ${JSON.stringify(body).slice(0, 200)}`);
    } catch (e) {
      result = err('unavailable', `${engine.name} engine: ${(e as Error).message}`);
    }
    if (!result.ok) engine.discard(running.value, result.error.message);
    return result;
  };
  const first = await once();
  return first.ok ? first : once();
}

const clipForm = (wav: Uint8Array<ArrayBuffer>, fields: Record<string, string>) => () => {
  const form = new FormData();
  form.append('file', new Blob([wav], { type: 'audio/wav' }), 'clip.wav');
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  return form;
};

/** The clip's language by the small model, or null when it isn't sure (the big model then detects it itself). */
function language(engine: Engine, wav: Uint8Array<ArrayBuffer>): Promise<Outcome<string | null>> {
  return infer(engine, clipForm(wav, { detect_language: 'true', response_format: 'verbose_json' }), wav, (status, body) => {
    const probabilities = body.language_probabilities;
    if (status !== 200 || typeof probabilities !== 'object' || probabilities === null) return err('unavailable', `language detection answered ${status}: ${JSON.stringify(body.error ?? body).slice(0, 300)}`);
    const [best, p] = Object.entries(probabilities).reduce<[string, number]>((top, [code, value]) => typeof value === 'number' && value > top[1] ? [code, value] : top, ['', 0]);
    return { ok: true, value: p >= LID_SURE && /^[a-z]{2,3}$/.test(best) ? best : null };
  });
}

/** One stretch whisper wrote, with where in the clip it heard it (seconds). */
export interface Segment { text: string; start: number; end: number }
const SECONDS_PER_LETTER = 0.035;   // half the time the fastest speech gives a letter: less, and nobody said it

/** Whisper's segments as text, without a segment that only repeats words already written and has too little voice under
 *  it for anyone to have said them (`voiced`: seconds of voice in a span of the clip): words right before it, in this
 *  clip or the text before it (`before`; Carol 2026-10-28: one "please" came out "Please. Please."), or, 4 words or
 *  more, a stretch anywhere earlier (2026-10-30: a sentence came back again after the next one, over her pause).
 *  Repeats she really says have her voice under them and stay. */
export function dedupeSegments(segments: Segment[], before: string, voiced: (start: number, end: number) => number): string {
  const kept: string[] = [];
  let out = '';
  const keysOf = (text: string) => text.split(/\s+/).map(loopKey).filter(Boolean);
  for (const s of segments) {
    const keys = keysOf(s.text);
    if (!keys.length) continue;
    const said = keys.join(' '), earlier = keysOf(`${before} ${kept.join(' ')}`);
    const repeat = earlier.slice(-keys.length).join(' ') === said || (keys.length >= 4 && ` ${earlier.join(' ')} `.includes(` ${said} `));
    if (repeat && voiced(s.start, s.end) < keys.join('').length * SECONDS_PER_LETTER) continue;
    kept.push(s.text.trim());
    out += out && /^\S/.test(s.text) ? s.text.trimEnd() : ` ${s.text.trim()}`;
  }
  return out.trim();
}

/** What whisper heard, loops undone. A pass that looped (the prompt of earlier words is what usually sets it off) is
 *  heard again without a prompt; `looped` says it happened. Decoding with timestamps: without them whisper loops far
 *  more (two "please"s came back as eight), and they show a segment too short to have been said. */
async function whisper(engine: Engine, wav: Uint8Array<ArrayBuffer>, initialPrompt: string, before: string, lang: string | null): Promise<Outcome<{ text: string; looped: boolean }>> {
  const samples = wavSamples(wav);
  if (!samples.ok) return samples;
  const voiced = voicedTime(samples.value);
  const first = await whisperPass(engine, wav, initialPrompt, lang);
  if (!first.ok) return first;
  const text = dedupeSegments(first.value, before, voiced).split(/\s+/).filter(Boolean).join(' '), once = unloop(text);
  if (once === text) return { ok: true, value: { text, looped: false } };
  const again = await whisperPass(engine, wav, '', lang);
  return { ok: true, value: { text: again.ok ? unloop(dedupeSegments(again.value, before, voiced)) : once, looped: true } };
}

const isSegment = (s: unknown): s is Segment => typeof s === 'object' && s !== null && typeof (s as Segment).text === 'string' && typeof (s as Segment).start === 'number' && typeof (s as Segment).end === 'number';

function whisperPass(engine: Engine, wav: Uint8Array<ArrayBuffer>, initialPrompt: string, lang: string | null): Promise<Outcome<Segment[]>> {
  return infer(engine, clipForm(wav, { response_format: 'verbose_json', no_timestamps: 'false', temperature: '0', ...(initialPrompt ? { prompt: initialPrompt } : {}), ...(lang ? { language: lang } : {}) }), wav, (status, body) =>
    status === 200 && Array.isArray(body.segments) && body.segments.every(isSegment) ? { ok: true, value: body.segments } : err('unavailable', `whisper-server answered ${status}: ${JSON.stringify(body.error ?? body).slice(0, 300)}`));
}

export interface Timing { format: 'wav' | 'compressed'; bytes: number; audioSeconds: number; engine: 'short' | 'full'; language: string | null; decodeMs: number; lidMs: number; whisperMs: number; looped: boolean }

export async function transcribe(engines: Engines, person: Pick<PersonConfig, 'home' | 'id'>, clip: Uint8Array<ArrayBuffer>, format: Timing['format']): Promise<Outcome<{ text: string; timing: Timing | null }>> {
  const decodeStarted = Date.now();
  const decoded = format === 'wav' ? { ok: true as const, value: clip } : await decodeClip(clip);
  if (!decoded.ok) return decoded;
  const wav = decoded.value, decodeMs = Date.now() - decodeStarted;
  const seconds = wavSeconds(wav);
  if (!seconds.ok) return seconds;
  if (seconds.value > MAX_SECONDS) return err('invalid_input', `The clip is longer than ${MAX_SECONDS / 60} minutes`);
  if (seconds.value < MIN_SECONDS) return { ok: true, value: { text: '', timing: null } };
  const profile = await readProfile(person);
  if (!profile.ok) return profile;
  const which = seconds.value <= SHORT_SECONDS ? 'short' : 'full';
  const lidStarted = Date.now();
  const lang = await language(engines.lid, wav);
  if (!lang.ok) return lang;
  const whisperStarted = Date.now();
  const heard = await whisper(engines[which], wav, prompt(profile.value), '', lang.value);
  if (!heard.ok) return heard;
  return { ok: true, value: { text: unloop(punctuate(correct(heard.value.text, correctionsFor(profile.value, lang.value)), profile.value.vocabulary)), timing: { format, bytes: clip.byteLength, audioSeconds: Math.round(seconds.value * 10) / 10, engine: which, language: lang.value, decodeMs, lidMs: whisperStarted - lidStarted, whisperMs: Date.now() - whisperStarted, looped: heard.value.looped } } };
}


/** Seconds of 16 kHz mono 16-bit PCM. */
const secondsOf = (samples: number) => Math.round(samples / SAMPLE_RATE * 10) / 10;
const STREAM_IDLE_MS = 60_000;
const CONTEXT_CHARS = 200;

/** ffmpeg decoding a recording as it arrives (stdin) to 16 kHz mono PCM (stdout), as nobody. */
function liveDecoder() {
  const asRoot = process.getuid?.() === 0;
  return spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-probesize', '4096', '-analyzeduration', '0', '-fflags', 'nobuffer', '-i', 'pipe:0', '-ac', '1', '-ar', String(SAMPLE_RATE), '-t', String(MAX_SECONDS + 1), '-flush_packets', '1', '-f', 's16le', 'pipe:1'], {
    stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin', HOME: '/nonexistent' }, ...(asRoot ? { uid: NOBODY, gid: NOBODY } : {}),
  });
}

export interface StreamTiming { audioSeconds: number; pieces: number; tailSeconds: number; language: string | null; flushMs: number; tailMs: number; pieceWhisperMs: number }

/** One live dictation: the recording arrives in pieces while she speaks, is decoded as it comes, and each stretch up to
 *  a pause is written down once, by the warm short engine, with the words before it as context. At the end only the
 *  stretch after the last pause is left to write down. */
export class LiveDictation {
  private readonly decoder: ChildProcess;
  private pcm = new Uint8Array(SAMPLE_RATE * 2 * 16);
  private pcmLength = 0;
  private received = 0;
  private committed = 0;
  private readonly pieces: { text: string; from: number; to: number }[] = [];
  private readonly track = new StreamTrack();
  private tracked = 0;
  private lang: string | null = null;
  private langTried = 0;
  private busy: Promise<void> | null = null;
  private failure: DictationFailure | null = null;
  private readonly decoded: Promise<string | null>;
  private pieceWhisperMs = 0;
  lastAt = Date.now();
  constructor(readonly id: string, private readonly engines: Engines, private readonly profile: Profile, private readonly log: (line: object) => void) {
    this.decoder = liveDecoder();
    let errors = '';
    this.decoder.stdout!.on('data', (chunk: Buffer) => {
      if (this.pcmLength + chunk.length > this.pcm.length) { const grown = new Uint8Array(Math.max(this.pcm.length * 2, this.pcmLength + chunk.length)); grown.set(this.pcm.subarray(0, this.pcmLength)); this.pcm = grown; }
      this.pcm.set(chunk, this.pcmLength); this.pcmLength += chunk.length; this.pump();
    });
    this.decoder.stderr!.on('data', (chunk: Buffer) => { errors = (errors + chunk.toString()).slice(-600); });
    this.decoder.stdin!.on('error', () => undefined);
    this.decoded = new Promise(resolve => {
      this.decoder.once('error', e => resolve((e as NodeJS.ErrnoException).code === 'ENOENT' ? 'ffmpeg is not installed (Ubuntu package ffmpeg)' : String(e)));
      this.decoder.once('close', (code, signal) => resolve(code === 0 || this.pcmLength ? null : `ffmpeg exited (${signal ?? code}): ${errors.trim().split('\n').slice(-2).join(' | ')}`));
    });
  }

  private samples(): Int16Array { return new Int16Array(this.pcm.buffer, 0, this.pcmLength >> 1); }
  get text() { return unloop(fuse(this.words(), this.profile.vocabulary)); }

  /** Every word written down, each boundary with what her voice did there: a piece's end at its cut, a mark inside a
   *  piece at the pause nearest where its share of the piece's voiced time puts it. */
  private words(): Word[] {
    const base = baselineOf(this.track), out: Word[] = [];
    let sentenceFrom = 0;
    for (const piece of this.pieces) {
      const words = wordsOf(correct(piece.text, correctionsFor(this.profile, this.lang)));
      const first = Math.floor(piece.from / FRAME), last = Math.min(Math.floor(piece.to / FRAME), this.track.frames);
      const voicedAt: number[] = [];
      for (let f = first; f < last; f++) if (this.track.rms[f]! >= base.quiet) voicedAt.push(f);
      const chars = words.reduce((n, w) => n + w.text.length + 1, 0);
      let seen = 0;
      words.forEach((w, i) => {
        seen += w.text.length + 1;
        const pieceEnd = i === words.length - 1;
        if (!pieceEnd && (w.mark === '' || w.mark === ',')) { out.push(w); return; }
        const at = pieceEnd ? last : voicedAt[Math.min(voicedAt.length - 1, Math.floor(seen / chars * voicedAt.length))] ?? last;
        const heard = voiceAt(this.track, base, at, 40, sentenceFrom);
        if (heard && w.mark !== '') sentenceFrom = heard.end + heard.voice.pauseMs / 20;
        out.push({ ...w, pieceEnd, voice: heard?.voice ?? null });
      });
    }
    return out;
  }

  /** Takes bytes [at, at + chunk.length) of the recording. A repeat of bytes it has is accepted and ignored. */
  append(at: number, chunk: Uint8Array): Outcome<void> {
    this.lastAt = Date.now();
    if (at + chunk.byteLength <= this.received) return { ok: true, value: undefined };
    if (at !== this.received) return err('invalid_input', `This dictation has ${this.received} bytes; a piece starting at ${at} doesn't follow on`);
    if (this.received + chunk.byteLength > MAX_COMPRESSED_BYTES) return err('invalid_input', `The clip is longer than ${MAX_SECONDS / 60} minutes`);
    this.received += chunk.byteLength;
    this.decoder.stdin!.write(chunk);
    return { ok: true, value: undefined };
  }

  /** Writes down every finished stretch, one at a time; called whenever decoded audio arrives. */
  private pump() {
    if (this.busy || this.failure) return;
    const samples = this.samples();
    const cut = cutPoint(samples, this.committed, samples.length);
    if (cut === null) return;
    this.busy = this.write(this.committed, cut).then(ms => { this.pieceWhisperMs += ms; this.busy = null; this.pump(); });
  }

  private async write(from: number, to: number): Promise<number> {
    const samples = this.samples();
    this.committed = to;
    const frameTo = Math.floor(to / FRAME);
    if (frameTo > this.tracked) { this.track.add(trackOf(samples, this.tracked * FRAME, frameTo * FRAME)); this.tracked = frameTo; }
    if (!hasVoice(samples, from, to)) return 0;
    const wav = wavOf(new Uint8Array(samples.buffer, samples.byteOffset + from * 2, (to - from) * 2).slice());
    if (this.lang === null && this.langTried < 3) {
      this.langTried++;
      const lang = await language(this.engines.lid, wav);
      if (!lang.ok) { this.failure = lang.error; return 0; }
      this.lang = lang.value;
    }
    const context = contextPrompt(prompt(this.profile), this.text);
    const started = Date.now();
    const heard = await whisper((to - from) / SAMPLE_RATE <= SHORT_SECONDS ? this.engines.short : this.engines.full, wav, context, this.text, this.lang);
    const ms = Date.now() - started;
    if (!heard.ok) { this.failure = heard.error; return ms; }
    const words = heard.value.text;
    if (words) this.pieces.push({ text: words, from, to });
    this.log({ type: 'dictation_piece', stream: this.id, seconds: secondsOf(to - from), at: secondsOf(from), whisperMs: ms, chars: words.length, ...(heard.value.looped ? { looped: true } : {}) });
    return ms;
  }

  /** The recording is complete: decodes what is left, writes down the stretch after the last pause, returns all of it. */
  async finish(): Promise<Outcome<{ text: string; timing: StreamTiming }>> {
    const started = Date.now();
    this.decoder.stdin!.end();
    const decodeError = await this.decoded;
    if (decodeError !== null) return err(decodeError.startsWith('ffmpeg is not installed') ? 'unavailable' : 'invalid_input', `The recording could not be read: ${decodeError}`);
    while (this.busy) await this.busy;
    const flushMs = Date.now() - started;
    if (this.failure) return { ok: false, error: this.failure };
    const piecesDone = this.pieces.length, pieceWhisperMs = this.pieceWhisperMs;
    const end = this.samples().length, tailFrom = this.committed;
    if (end / SAMPLE_RATE > MAX_SECONDS) return err('invalid_input', `The clip is longer than ${MAX_SECONDS / 60} minutes`);
    const tailStarted = Date.now();
    if (end - tailFrom >= SAMPLE_RATE * MIN_SECONDS) await this.write(tailFrom, end);
    if (this.failure) return { ok: false, error: this.failure };
    return { ok: true, value: { text: this.text, timing: { audioSeconds: secondsOf(end), pieces: piecesDone, tailSeconds: secondsOf(end - tailFrom), language: this.lang, flushMs, tailMs: Date.now() - tailStarted, pieceWhisperMs } } };
  }

  /** Why a piece could not be written down, even on a fresh engine: the stream is over, the app sends the whole clip. */
  get failed(): DictationFailure | null { return this.failure; }

  cancel() { this.decoder.stdin!.destroy(); this.decoder.kill('SIGKILL'); }
}

/** One live dictation per person: a new one replaces any other of theirs; one left idle a minute is dropped. */
const live = new Map<string, LiveDictation>();
const sweep = setInterval(() => { for (const [person, d] of live) if (Date.now() - d.lastAt > STREAM_IDLE_MS) { d.cancel(); live.delete(person); } }, 15_000);
sweep.unref();

async function streamFor(person: Pick<PersonConfig, 'home' | 'id'>, id: string): Promise<Outcome<LiveDictation>> {
  const current = live.get(person.id);
  if (current?.id === id) return { ok: true, value: current };
  const profile = await readProfile(person);
  if (!profile.ok) return profile;
  const again = live.get(person.id);
  if (again?.id === id) return { ok: true, value: again };
  again?.cancel();
  const created = new LiveDictation(id, engines, profile.value, line => logLine({ ...line, person: person.id }));
  live.set(person.id, created);
  return { ok: true, value: created };
}

const MAX_WAV_BYTES = 44 + MAX_SECONDS * SAMPLE_RATE * 2;
/** What the app measured on its side, sent as `x-dictation-client` JSON: its own preparation, and the previous clip's whole round trip. */
const clientTiming = (header: string | undefined): Record<string, number> | null => {
  if (!header || header.length > 200) return null;
  try {
    const raw: unknown = JSON.parse(header);
    if (typeof raw !== 'object' || raw === null) return null;
    return Object.fromEntries(Object.entries(raw).filter((e): e is [string, number] => /^[a-zA-Z]{1,24}$/.test(e[0]) && typeof e[1] === 'number' && Number.isFinite(e[1])));
  } catch { return null; }
};

export const dictationExtension: Extension = {
  id: 'dictation', name: 'Dictation',
  routes(app, deps) {
    app.use('*', async (c, next) => { if (!deps.person(personOf(c))?.extensions.includes('dictation')) fail('forbidden', 'Dictation is not enabled'); await next(); });
    app.post('/transcribe', async c => {
      const started = Date.now();
      const format: Timing['format'] = (c.req.header('content-type') ?? '').startsWith('audio/wav') ? 'wav' : 'compressed';
      if (Number(c.req.header('content-length') ?? 0) > (format === 'wav' ? MAX_WAV_BYTES : MAX_COMPRESSED_BYTES)) return fail('invalid_input', `The clip is longer than ${MAX_SECONDS / 60} minutes`);
      const clip = new Uint8Array(await c.req.arrayBuffer());
      const readMs = Date.now() - started;
      const person = deps.person(personOf(c))!;
      const result = await transcribe(engines, person, clip, format);
      const totalMs = Date.now() - started;
      console.log(JSON.stringify({ type: 'dictation', person: person.id, ok: result.ok, ...(result.ok ? result.value.timing : { error: result.error.code, message: result.error.message.slice(0, 300) }), readMs, totalMs, client: clientTiming(c.req.header('x-dictation-client')) }));
      if (!result.ok) return fail(result.error.code, result.error.message);
      return c.json({ ok: true, value: { text: result.value.text, ms: totalMs } });
    });
    // Live dictation: POST /stream/ID?at=BYTES with the next bytes of the recording as they are recorded; the answer is
    // what has been written down so far. The last piece adds &end=1 and is answered with the whole text.
    app.post('/stream/:id', async c => {
      const started = Date.now();
      const id = c.req.param('id'), at = Number(c.req.query('at')), end = c.req.query('end') === '1';
      if (!/^[0-9a-f-]{36}$/.test(id) || !Number.isSafeInteger(at) || at < 0) return fail('invalid_input', 'A dictation stream needs its id and the byte offset of this piece');
      const person = deps.person(personOf(c))!;
      const chunk = new Uint8Array(await c.req.arrayBuffer());
      const stream = live.get(person.id)?.id === id ? { ok: true as const, value: live.get(person.id)! } : at === 0 ? await streamFor(person, id) : err('not_found', 'This dictation is no longer on the server');
      if (!stream.ok) return fail(stream.error.code, stream.error.message);
      const appended = stream.value.append(at, chunk);
      if (!appended.ok) return fail(appended.error.code, appended.error.message);
      const broken = stream.value.failed;
      if (broken) {
        stream.value.cancel();
        if (live.get(person.id) === stream.value) live.delete(person.id);
        console.log(JSON.stringify({ type: 'dictation', mode: 'stream', person: person.id, ok: false, error: broken.code, message: broken.message.slice(0, 300), bytes: at + chunk.byteLength, end }));
        return fail(broken.code, broken.message);
      }
      if (!end) return c.json({ ok: true, value: { text: stream.value.text, ms: Date.now() - started } });
      const result = await stream.value.finish();
      if (live.get(person.id) === stream.value) live.delete(person.id);
      const totalMs = Date.now() - started;
      console.log(JSON.stringify({ type: 'dictation', mode: 'stream', person: person.id, ok: result.ok, ...(result.ok ? result.value.timing : { error: result.error.code, message: result.error.message.slice(0, 300) }), bytes: at + chunk.byteLength, lastBytes: chunk.byteLength, totalMs, client: clientTiming(c.req.header('x-dictation-client')) }));
      if (!result.ok) return fail(result.error.code, result.error.message);
      return c.json({ ok: true, value: { text: result.value.text, ms: totalMs } });
    });
    app.delete('/stream/:id', c => {
      const person = deps.person(personOf(c))!, current = live.get(person.id);
      if (current?.id === c.req.param('id')) { current.cancel(); live.delete(person.id); }
      return c.json({ ok: true, value: null });
    });
  },
  async start(deps) {
    if (!deps.config.people.some(p => p.extensions.includes('dictation'))) return;
    const warmStarted = Date.now();
    void Promise.all([engines.lid.ensure(), engines.short.ensure(), engines.full.ensure()]).then(rs => console.log(JSON.stringify({ type: 'dictation_warm', ok: rs.map(r => r.ok), ms: Date.now() - warmStarted, errors: rs.flatMap(r => r.ok ? [] : [r.error.message]) })));
  },
  async stop() { for (const d of live.values()) d.cancel(); live.clear(); await Promise.all([engines.lid.stop(), engines.short.stop(), engines.full.stop()]); },
};
