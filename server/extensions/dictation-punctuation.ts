// Where dictated sentences end, and how (. ! ?), decided by fusing independent noisy evidence at each boundary, the
// way the Business RF data-fusion work combines sensors: each source gives a log-odds vote with its own confidence, and
// the votes are summed into one decision. Sources: whisper's own mark (weak at a piece end, where whisper always puts
// one because the audio stops), the words on either side, the pause, and her voice (pitch fall or rise at the boundary,
// pitch and loudness of the sentence against her own running baseline). A pause alone never ends a sentence.
// Pure: no model, no tokens, a few milliseconds per stretch of audio.

const RATE = 16_000;
export const FRAME = 320;                 // 20 ms
const MIN_LAG = 40, MAX_LAG = 213;        // 400 Hz … 75 Hz
const WINDOW = 640;                       // 40 ms

/** Per 20 ms frame: loudness (RMS) and pitch in Hz (0 when unvoiced). */
export interface Track { rms: Float32Array; f0: Float32Array }

/** Pitch by normalised autocorrelation on every other sample (8 kHz is plenty below 400 Hz). */
export function trackOf(samples: Int16Array, from: number, to: number): Track {
  const frames = Math.max(0, Math.floor((to - from) / FRAME));
  const rms = new Float32Array(frames), f0 = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    const at = from + f * FRAME;
    let sum = 0; for (let i = at; i < at + FRAME; i++) sum += samples[i]! * samples[i]!;
    rms[f] = Math.sqrt(sum / FRAME);
    if (rms[f]! < 150 || at + WINDOW + 2 * MAX_LAG > samples.length) continue;
    let best = 0, bestLag = 0;
    for (let lag = MIN_LAG; lag <= MAX_LAG; lag += 2) {
      let xy = 0, xx = 0, yy = 0;
      for (let i = at; i < at + WINDOW; i += 2) { const x = samples[i]!, y = samples[i + lag]!; xy += x * y; xx += x * x; yy += y * y; }
      const r = xy / Math.sqrt(xx * yy + 1);
      if (r > best) { best = r; bestLag = lag; }
    }
    if (best > 0.6) f0[f] = RATE / bestLag;
  }
  return { rms, f0 };
}

/** One track for a whole stream, appended piece by piece. */
export class StreamTrack {
  rms = new Float32Array(0); f0 = new Float32Array(0);
  add(track: Track) {
    const join = (a: Float32Array, b: Float32Array) => { const out = new Float32Array(a.length + b.length); out.set(a); out.set(b, a.length); return out; };
    this.rms = join(this.rms, track.rms); this.f0 = join(this.f0, track.f0);
  }
  get frames() { return this.rms.length; }
}

const median = (values: number[]) => { if (!values.length) return null; const s = [...values].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]!; };
const semitones = (a: number, b: number) => 12 * Math.log2(a / b);

/** What her voice says about one boundary: frames are of the stream track. */
/** turn: semitones the pitch moved over the last 150 ms (negative: it fell). lift, loud: the sentence against her baseline. */
export interface Voice { pauseMs: number; turn: number | null; lift: number | null; loud: number | null }

/** Her baseline so far: what counts as quiet (15 % of the way from the floor to the loud end), her usual pitch and loudness. */
export interface Baseline { quiet: number; pitch: number | null; loud: number | null }
export function baselineOf(track: StreamTrack): Baseline {
  const sorted = [...track.rms].sort((a, b) => a - b);
  if (sorted.length < 10) return { quiet: 0, pitch: null, loud: null };
  const floor = sorted[Math.floor(sorted.length * 0.02)]!, peak = sorted[Math.floor(sorted.length * 0.95)]!;
  const quiet = floor + 0.15 * (peak - floor);
  const pitches: number[] = []; for (const f of track.f0) if (f > 0) pitches.push(f);
  const loud = sorted.filter(r => r >= quiet);
  return { quiet, pitch: pitches.length >= 100 ? median(pitches) : null, loud: loud.length >= 100 ? loud[Math.floor(loud.length / 2)]! : null };
}

/** The pause nearest `frame` (within `reach` frames) and what her voice did before it; sentenceFrom is where this
 *  sentence started, for its pitch and loudness against her baseline. Null when there is no pause there. */
export function voiceAt(track: StreamTrack, base: Baseline, frame: number, reach: number, sentenceFrom: number): { voice: Voice; end: number } | null {
  const { rms, f0 } = track, n = rms.length, quiet = base.quiet;
  let best: [number, number] | null = null;
  for (let f = Math.max(0, frame - reach); f <= Math.min(n - 1, frame + reach); f++) {
    if (rms[f]! >= quiet) continue;
    let e = f; while (e + 1 < n && rms[e + 1]! < quiet) e++;
    let s = f; while (s > 0 && rms[s - 1]! < quiet) s--;
    if (e - s + 1 >= 5 && (!best || Math.abs((s + e) / 2 - frame) < Math.abs((best[0] + best[1]) / 2 - frame))) best = [s, e];
    f = e;
  }
  if (!best) return null;
  const [s, e] = best;
  const voiced = (a: number, b: number) => { const out: number[] = []; for (let f = Math.max(0, a); f < Math.min(b, n); f++) if (f0[f]! > 0) out.push(f0[f]!); return out; };
  // The last voiced 150 ms against the 350 ms before them: falling pitch closes a statement, level or rising goes on.
  let last = s - 1; while (last > 0 && f0[last]! === 0 && s - last < 15) last--;
  const tail = median(voiced(last - 7, last + 1)), body = median(voiced(last - 25, last - 7));
  const sentence = voiced(sentenceFrom, s);
  const sentenceLoud: number[] = []; for (let f = Math.max(0, sentenceFrom); f < s; f++) if (rms[f]! >= quiet) sentenceLoud.push(rms[f]!);
  const sp = median(sentence), sl = median(sentenceLoud), turn = tail && body ? semitones(tail, body) : null;
  return {
    end: s,
    voice: {
      pauseMs: (e - s + 1) * 20, turn,
      lift: sp && base.pitch && sentence.length >= 10 ? semitones(sp, base.pitch) : null,
      loud: sl && base.loud && sentenceLoud.length >= 10 ? 20 * Math.log10(sl / base.loud) : null,
    },
  };
}

/** Words that never end an English or French sentence: a mark after them is a pause, not an end. */
const NEVER_LAST = new Set(`to or and the a an of with for from into onto my your our their I if than because like nor I'm I've I'd I'll
we're you're they're just very le la les un une des de du au aux et ou mais car que je tu mon ma mes ton ta tes son sa ses pour avec dans sur
sans chez par`.split(/\s+/).map(w => w.toLowerCase()));
/** "Can you." / "Do we." : an auxiliary and a pronoun open a question that hasn't been asked yet. */
const AUX = new Set('can could would will should do does did is are was were have has shall may might'.split(' '));
const PRONOUNS = new Set('i you we they he she it'.split(' '));
const FILLERS = new Set('um uh hmm euh ah oh er erm'.split(' '));
/** Capitalised after an unpunctuated word, these start a sentence whisper forgot to end (names and I never do). */
export const SENTENCE_STARTS = new Set(`it it's its like also and but so or the this that these those then there there's here we we're we'll you you're
you'll he he's she she's they they're please thank thanks yeah yes no okay ok oh uh um hmm well what what's how why when where which who if
maybe actually because my our your his their just now can could would should do does did don't is are was were let's let in on at for with
after before anyway plus otherwise still right sorry hey hi next finally basically honestly wait even every some all not make go try add send
check fix remember once sometimes again instead however though although since until while as ever never always usually today tomorrow
yesterday another other each any both same good great cool perfect alright sure ignore`.split(/\s+/));
const QUESTION_OPENERS = new Set([...AUX, 'what', 'why', 'how', 'where', 'when', 'who', 'which', "isn't", "aren't", "don't", "doesn't", "didn't", "can't", "won't", 'est-ce', 'pourquoi', 'comment', 'quand', 'où']);
const EXCITED = /\b(great|awesome|amazing|wonderful|perfect|fantastic|excellent|incredible|wow|yay|yes|cool|nice|love it|thank you|thanks|holy crap|heck yeah|congrats|congratulations|finally|super|génial|merci|parfait|bravo|trop bien|wouhou)\b/i;

/** One word as dictated, with the mark whisper put after it and where in the audio that boundary is. */
export interface Word { text: string; mark: '' | '.' | '!' | '?' | ',' | '...'; pieceEnd: boolean; voice: Voice | null }

const key = (word: string) => word.toLowerCase().replace(/’/g, "'").replace(/^[^\p{L}\p{N}']+|[^\p{L}\p{N}']+$/gu, '');

/** Splits text into words and their trailing marks; marks other than . ! ? , … stay part of the word. */
export function wordsOf(text: string): Word[] {
  return text.split(/\s+/).filter(Boolean).map(token => {
    const m = /^(.*?)(\.\.\.|…|[.!?,])$/u.exec(token);
    if (!m || !m[1]) return { text: token, mark: '' as const, pieceEnd: false, voice: null };
    return { text: m[1], mark: (m[2] === '…' ? '...' : m[2]) as Word['mark'], pieceEnd: false, voice: null };
  });
}

/** The fused log-odds that the sentence ends after words[i]; > 0 ends it. */
export function endScore(words: Word[], i: number, names: Set<string>): number {
  const w = words[i]!, next = words[i + 1], k = key(w.text), prev = i > 0 ? key(words[i - 1]!.text) : '';
  let score = { '.': w.pieceEnd ? 1 : 2.5, '?': 3, '!': 3, ',': -2.5, '...': -1.5, '': -3 }[w.mark];
  if (NEVER_LAST.has(k) && !names.has(k) && !(w.mark === '?' && k !== 'i')) score -= 4.5;
  if (PRONOUNS.has(k) && AUX.has(prev) && w.mark !== '?') score -= 3;
  if (next) {
    const nk = key(next.text), lower = next.text[0] === next.text[0]!.toLowerCase() && /\p{L}/u.test(next.text[0]!);
    if (w.mark !== '' && lower && !w.pieceEnd) score -= 3;
    if (w.mark === '' && !lower && SENTENCE_STARTS.has(nk) && !names.has(nk)) score += 5.5;
  }
  if (FILLERS.has(k) && w.mark === '.') score += 1;
  if (w.voice) {
    const { pauseMs, turn } = w.voice;
    score += pauseMs < 250 ? -0.5 : pauseMs < 700 ? 0 : pauseMs < 1500 ? 0.5 : 1;
    if (turn !== null) score += turn < -2 ? 1 : turn < -0.5 ? 0.3 : -0.7;
  }
  return score;
}

/** The fused log-odds that a sentence ending after words[i] was said with excitement (conservative: words alone never do it). */
export function excitedScore(sentence: Word[], last: Word): number {
  const text = sentence.map(w => w.text).join(' ');
  let score = -2.5;
  if (EXCITED.test(text)) score += sentence.length <= 6 ? 2 : 0.8;
  const v = last.voice;
  if (v?.lift != null) score += v.lift > 3 ? 1.5 : v.lift > 1.5 ? 0.8 : v.lift < 0 ? -0.5 : 0;
  if (v?.loud != null) score += v.loud > 3 ? 0.7 : v.loud < -1 ? -0.3 : 0;
  return score;
}

const isName = (word: string, names: Set<string>, capitalisedMid: Set<string>) => {
  const k = key(word);
  return /^i('|$)/.test(k) || names.has(k) || capitalisedMid.has(k);
};

/** Decides every boundary and writes the text back: kept or added ends get . ! or ?, the rest are joined with the next
 *  word lowercased (unless it is a name: vocabulary, I, or a word she has capitalised mid-sentence elsewhere). */
export function fuse(words: Word[], vocabulary: string[]): string {
  const names = new Set(vocabulary.flatMap(v => v.split(/\s+/)).map(key));
  const capitalisedMid = new Set<string>();
  for (let i = 1; i < words.length; i++) if (words[i - 1]!.mark === '' && /^\p{Lu}/u.test(words[i]!.text)) capitalisedMid.add(key(words[i]!.text));
  const out: string[] = [];
  let sentence: Word[] = [], lowerNext = false;
  words.forEach((w, i) => {
    let text = w.text;
    if (lowerNext && !isName(text, names, capitalisedMid)) text = text[0]!.toLowerCase() + text.slice(1);
    lowerNext = false;
    sentence.push(w);
    const next = words[i + 1];
    if (w.mark === ',' || (!next && w.mark === '')) { out.push(text + w.mark); return; }
    if (next && endScore(words, i, names) <= 0) {
      if (w.mark !== '') lowerNext = true;
      out.push(text);
      return;
    }
    let mark: string = w.mark === '?' || w.mark === '!' ? w.mark : '.';
    const opener = key(sentence[0]!.text);
    if (mark === '.' && QUESTION_OPENERS.has(opener) && w.voice?.turn != null && w.voice.turn > 2) mark = '?';
    if (mark === '.' && excitedScore(sentence, w) > 0) mark = '!';
    out.push(text + mark);
    if (next && /^\p{Ll}/u.test(next.text)) words[i + 1] = { ...next, text: next.text[0]!.toUpperCase() + next.text.slice(1) };
    sentence = [];
  });
  return out.join(' ');
}
