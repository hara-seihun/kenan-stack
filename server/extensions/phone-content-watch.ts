import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface OutgoingTranscription {
  text: string;
  language: string | null;
  /** Confidence in the detected language, not in the transcript. */
  confidence: number | null;
}

export interface OutgoingContentTrip extends OutgoingTranscription {
  reason: 'wrong-language' | 'off-topic';
  startSeconds: number;
  endSeconds: number;
}

export interface OutgoingContentWatchOptions {
  language: 'French' | 'English' | null;
  brief: string;
  transcribe: (samples8k: Int16Array) => Promise<OutgoingTranscription>;
  onTrip: (detail: OutgoingContentTrip) => void;
  onError: (error: unknown) => void;
}

const RATE = 8000;
const WINDOW = 4 * RATE;
const HOP = 2 * RATE;
const STOP = new Set(`a an and are as at be been being but by can could did do does doing for from had has have he her here hers him his how i if in into is it its just me my no not of on or our ours please s she so some t than that the their them then there these they this those to too us very was we were what when where which who will with would you your yours yes yeah okay ok thank thanks hello goodbye well really all also get got want need let now one about avec au aux ce ces cet cette comme dans de des du elle elles en est et eux il ils je la le les leur lui ma mais me mes moi mon ne nos notre nous on ou par pas plus pour qu que qui sa se ses son sont sur ta te tes toi ton tu un une vos votre vous y bon bonjour merci oui non alors donc bien tres tout tous toute toutes faire fait ca c est d l j n qu s t m aujourd hui`.split(/\s+/));

function words(text: string): string[] {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/\[[^\]]*\]|<[^>]*>/g, ' ').match(/[a-z0-9]+/g) ?? [];
}
function substantive(tokens: string[]): string[] {
  return tokens.filter(t => t.length >= 3 && !STOP.has(t));
}
function sameTopic(a: string, b: string): boolean {
  return a === b || (a.length >= 5 && b.length >= 5 && a.slice(0, 5) === b.slice(0, 5));
}
function languageCode(language: string | null): string | null {
  const value = language?.trim().toLowerCase();
  if (value === 'french' || value === 'fr' || value === 'francais') return 'fr';
  if (value === 'english' || value === 'en') return 'en';
  return value ?? null;
}

/** An observer only: never buffers, cuts, or controls the actual outgoing audio. */
export class OutgoingContentWatch {
  private readonly ring = new Int16Array(WINDOW);
  private position = 0;
  private samples = 0;
  private nextWindow = WINDOW;
  private pending: { audio: Int16Array; end: number } | null = null;
  private busy = false;
  private closed = false;
  private tripped = false;
  private conversation = '';
  private passages: { start: number; end: number; text: string; tokens: string[] }[] = [];
  private contextVersion = 0;
  private expectedLanguage: string | null;

  expectLanguage(language: 'French' | 'English' | null): void { this.expectedLanguage = languageCode(language); }

  constructor(private readonly options: OutgoingContentWatchOptions) { this.expectedLanguage = languageCode(options.language); }

  /** Append actual person/backend text, rather than predicted or invented replies. */
  context(text: string): void {
    if (this.closed || !text.trim()) return;
    this.conversation = `${this.conversation}\n${text}`.slice(-16000);
    this.contextVersion++;
    // New conversation can legitimately introduce a new subject.
    this.passages = [];
  }

  push(samples8k: Int16Array): void {
    if (this.closed || this.tripped) return;
    for (const sample of samples8k) {
      this.ring[this.position] = sample;
      this.position = (this.position + 1) % WINDOW;
      this.samples++;
      if (this.samples < this.nextWindow) continue;
      this.nextWindow += HOP;
      const audio = new Int16Array(WINDOW);
      audio.set(this.ring.subarray(this.position));
      audio.set(this.ring.subarray(0, this.position), WINDOW - this.position);
      // This is only ASR input filtering, never speech/turn control. Reject near-zero
      // audio so Whisper cannot hallucinate a content failure out of digital silence.
      let energy = 0;
      let audible = 0;
      for (let offset = 0; offset < audio.length; offset += 160) {
        let frameEnergy = 0;
        for (let j = offset; j < offset + 160; j++) frameEnergy += audio[j]! ** 2;
        energy += frameEnergy;
        if (Math.sqrt(frameEnergy / 160) >= 180) audible++;
      }
      if (Math.sqrt(energy / WINDOW) < 100 || audible < 25) continue;
      this.pending = { audio, end: this.samples };
      void this.drain();
    }
  }

  close(): void {
    this.closed = true;
    this.pending = null;
    this.passages = [];
  }

  private async drain(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      while (this.pending && !this.closed && !this.tripped) {
        const window = this.pending;
        this.pending = null;
        const version = this.contextVersion;
        try {
          const result = await this.options.transcribe(window.audio);
          if (!this.closed && !this.tripped) this.classify(result, window.end, version);
        } catch (error) {
          if (!this.closed) this.error(error);
        }
      }
    } finally {
      this.busy = false;
    }
  }

  private error(error: unknown): void {
    try { this.options.onError(error); } catch { /* An observer must not break the call. */ }
  }

  private classify(result: OutgoingTranscription, end: number, version: number): void {
    const tokens = words(result.text);
    const content = substantive(tokens);
    if (tokens.length < 6 || new Set(content).size < 3) return;
    const start = end - WINDOW;
    const expected = this.expectedLanguage;
    const detected = languageCode(result.language);
    const confidence = result.confidence;
    if (expected && detected && detected !== expected && confidence !== null
      && Number.isFinite(confidence) && confidence >= 0.85) {
      this.trip({ ...result, reason: 'wrong-language', startSeconds: start / RATE, endSeconds: end / RATE });
      return;
    }
    if (version !== this.contextVersion) return;
    // Never count words in overlapping windows twice. Sustained topic divergence
    // requires at least three independent passages, not one unfamiliar short reply.
    this.passages = this.passages.filter(p => end - p.start <= 24 * RATE);
    if (this.passages.some(p => start < p.end)) return;
    this.passages.push({ start, end, text: result.text, tokens });
    const passageWords = this.passages.flatMap(p => p.tokens);
    const unique = [...new Set(substantive(passageWords))];
    const reference = [...new Set(substantive(words(`${this.options.brief}\n${this.conversation}`)))];
    if (this.passages.length < 3 || passageWords.length < 24 || unique.length < 12 || reference.length < 8) return;
    // A single real topic word is enough to withhold a trip. This is intentionally
    // conservative: synonyms, introductions and brief replies are not failures.
    if (unique.some(token => reference.some(topic => sameTopic(token, topic)))) return;
    this.trip({ ...result, text: this.passages.map(p => p.text.trim()).join(' '), reason: 'off-topic',
      startSeconds: this.passages[0]!.start / RATE, endSeconds: end / RATE });
  }

  private trip(detail: OutgoingContentTrip): void {
    this.tripped = true;
    this.pending = null;
    this.passages = [];
    try { this.options.onTrip(detail); } catch (error) { this.error(error); }
  }
}

/** Independent CPU ASR. No brief/prompt is sent to it: that could bias away a failure. */
export async function transcribeOutgoing(samples8k: Int16Array): Promise<OutgoingTranscription> {
  if (!samples8k.length) return { text: '', language: null, confidence: null };
  const directory = await mkdtemp(join(tmpdir(), 'kenan-outgoing-asr-'));
  try {
    const input = join(directory, 'audio.wav');
    const output = join(directory, 'transcript');
    // Whisper consumes 16 kHz PCM; linear interpolation avoids a resampler subprocess.
    const count = samples8k.length * 2;
    const wav = Buffer.alloc(44 + count * 2);
    wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
    wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32);
    wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(count * 2, 40);
    for (let i = 0; i < samples8k.length; i++) {
      wav.writeInt16LE(samples8k[i]!, 44 + i * 4);
      wav.writeInt16LE(Math.round((samples8k[i]! + (samples8k[i + 1] ?? samples8k[i]!)) / 2), 46 + i * 4);
    }
    await writeFile(input, wav, { mode: 0o600 });
    const stderr = await new Promise<string>((resolve, reject) => {
      // Each call has its own observer. One low-priority CPU thread avoids
      // oversubscribing the two-core edge when calls overlap and leaves audio
      // forwarding ahead of ASR. Keep the deadline independent of the 4s window:
      // decoding can outlast it under load; the watch retains only the latest
      // pending window, so this never creates an unbounded queue or delays audio.
      const started = performance.now();
      execFile('nice', ['-n', '10', 'whisper-cli', '-m', '/var/lib/kenan/models/whisper/ggml-base-q5_1.bin',
        '-f', input, '-l', 'auto', '-oj', '-of', output, '-t', '1', '-ac', '256', '-bs', '1', '-bo', '1', '-nf', '-ng'],
      { timeout: 60000, killSignal: 'SIGKILL', maxBuffer: 2 * 1024 * 1024 }, (error, _stdout, stderr) => {
        if (error) reject(new Error(`Outgoing ASR failed after ${Math.round(performance.now() - started)}ms (${error.killed ? `killed, signal ${error.signal}` : `exit ${error.code}`}): ${stderr.trim()}`, { cause: error }));
        else resolve(stderr);
      });
    });
    const data = JSON.parse(await readFile(`${output}.json`, 'utf8')) as {
      result?: { language?: string; language_probability?: number };
      transcription?: { text?: string }[];
    };
    if (!Array.isArray(data.transcription)) throw new Error('Whisper did not produce a transcription array');
    const detection = stderr.match(/auto-detected language:\s*([\w-]+)\s*\(p\s*=\s*([\d.eE+-]+)\)/i);
    const probability = detection ? Number(detection[2]) : data.result?.language_probability;
    return {
      text: data.transcription.map(segment => segment.text ?? '').join(' ').replace(/\[[^\]]*\]|<[^>]*>/g, ' ').trim(),
      language: data.result?.language ?? detection?.[1] ?? null,
      confidence: typeof probability === 'number' && Number.isFinite(probability) && probability >= 0 && probability <= 1 ? probability : null,
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
