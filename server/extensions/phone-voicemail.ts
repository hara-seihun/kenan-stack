// Voicemail cue for outbound calls. GPT Live takes every turn itself, but it cannot hear a mailbox's beep as a turn: on
// 2026-10-19 (call 96bb3c65) it stayed silent through "veuillez laisser le message après le signal sonore", the beep and
// three rounds of "après avoir laissé votre message… appuyez sur le carré" until the mailbox hung up. The bridge decodes the
// callee's audio to 8 kHz and watches it with GPT Live's own transcript of the line: once a voicemail greeting is
// recognised, the mailbox is recording at its beep, or once the line has been quiet for a moment after the greeting
// (some mailboxes never beep). A beep that ends a stretch of recorded speech and is followed by quiet means the same even
// when the transcript did not show the greeting. Then GPT is told to leave the brief's message, once, and hears silence
// until it has.
// The same watch opens the call. A callee usually says hello in the second or two between answering and the bridge
// joining the call, so GPT Live never hears it, and it waits for a greeting that already happened: on 2026-10-19 (call
// 55416c51) the callee said "Hello?" before the bridge joined, both sides then waited in silence, and the callee hung up
// 12 s later. Once the bridge has joined, a line that stays quiet while Kenan has not spoken is a person waiting for
// Kenan, and GPT is told to greet them.
// Pure and clocked by 20 ms frames, so recorded or synthetic audio drives it exactly as a live call does.
export const RATE = 8000;
export const FRAME = 160;
const FRAME_MS = 20;
const WINDOW = 320;
const FFT = 512;

const hann = Float64Array.from({ length: WINDOW }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (WINDOW - 1)));

function powerSpectrum(samples: Float64Array): Float64Array {
  const re = new Float64Array(FFT), im = new Float64Array(FFT);
  re.set(samples);
  for (let i = 1, j = 0; i < FFT; i++) {
    let bit = FFT >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j]!, re[i]!]; }
  }
  for (let size = 2; size <= FFT; size <<= 1) {
    const step = (-2 * Math.PI) / size;
    for (let start = 0; start < FFT; start += size) {
      for (let k = 0; k < size / 2; k++) {
        const wr = Math.cos(step * k), wi = Math.sin(step * k);
        const a = start + k, b = a + size / 2;
        const tr = re[b]! * wr - im[b]! * wi, ti = re[b]! * wi + im[b]! * wr;
        re[b] = re[a]! - tr; im[b] = im[a]! - ti;
        re[a] = re[a]! + tr; im[a] = im[a]! + ti;
      }
    }
  }
  const power = new Float64Array(FFT / 2);
  for (let k = 0; k < FFT / 2; k++) power[k] = re[k]! * re[k]! + im[k]! * im[k]!;
  return power;
}

/** Level (dBFS) of the newest frame, and the frequency of a dominant pure tone over the last 40 ms, if one is present. */
export function analyse(previous: Int16Array, current: Int16Array): { level: number; tone: number | null } {
  let sum = 0;
  for (const s of current) sum += s * s;
  const level = 10 * Math.log10(sum / current.length / (32768 * 32768) + 1e-12);
  const windowed = new Float64Array(WINDOW);
  for (let i = 0; i < WINDOW; i++) windowed[i] = (i < FRAME ? previous[i]! : current[i - FRAME]!) * hann[i]!;
  const power = powerSpectrum(windowed);
  const hz = (k: number) => (k * RATE) / FFT;
  let peak = 0, total = 0;
  for (let k = 1; k < power.length; k++) { total += power[k]!; if (power[k]! > power[peak]!) peak = k; }
  let lobe = 0;
  for (let k = Math.max(1, peak - 3); k <= Math.min(power.length - 1, peak + 3); k++) lobe += power[k]!;
  const tonal = total > 0 && lobe / total > 0.8 && hz(peak) >= 300 && hz(peak) <= 2600;
  return { level, tone: tonal ? hz(peak) : null };
}

// What a mailbox says and a person does not: an invitation to leave a message, the beep it is about to play, or the
// mailbox itself. "Pas disponible" alone is what a receptionist says too, and "at the tone" is a talking clock.
const GREETING = /laiss(?:ez|er|e|ant)[- ](?:moi |nous |-moi |-nous )?(?:un |votre |le |vos |ton |tes |une )?(?:(?:court|bref|petit) )?(?:message|coordonn[ée]es)|apr[eè]s (?:le |la |l')?(?:signal|bip|tonalit[ée]|timbre)|signal sonore|bo[iî]te vocale|messagerie vocale|r[ée]pondeur|leave (?:me |us )?(?:a |your )?(?:(?:brief|short|detailed) )?(?:message|name and number)|after the (?:tone|beep)|voice ?mail|mailbox|answering machine/i;
export const voicemailGreeting = (heard: string) => GREETING.test(heard.replace(/\s+/g, ' '));
// A menu offer ("pour laisser un message, faites le 3") is not a recording mailbox: only its beep can mean recording.
const MENU = /(?:faites|fa[iî]tes|appuyez sur|tapez|composez|press|dial|enter)\s+(?:le |la touche |the )?(?:\d|un|deux|trois|quatre|cinq|six|sept|huit|neuf|z[ée]ro|one|two|three|four|five|six|seven|eight|nine|zero)\b/i;

const SOUND_DB = -45;
/** Quiet after a greeting with no beep before the mailbox is taken to be recording. Mailboxes beep within about a second. */
export const GAP_MS = 3000;
const BEEP_MIN_MS = 120;
const BEEP_MAX_MS = 1500;
const MELODY_GAP_MS = 1000;
/** A beep this long before the greeting is recognised still counts: GPT Live's transcript lags the audio. */
const BEEP_LOOKBACK_MS = 15_000;
/** Words Kenan says that mean it is talking with someone, or, after the beep or greeting, already leaving its message. */
const MESSAGE_WORDS = 6;
/** Without a recognised greeting, a beep counts only after this much line speech and when the line stays quiet after it. */
const UNHEARD_GREETING_MS = 1500;
// A mailbox is silent while it records; a talking clock ticks every second. The NRC clock (call 739f50a8, 2026-10-19)
// plays a 300 ms 797 Hz tone after each announcement and its next tick 680 ms later, and the old 400 ms took that tone for
// a beep. Quiet must outlast a second's tick.
const QUIET_AFTER_BEEP_MS = 1200;
/** Tones this alike are the same signal repeating (a clock's time tone), never a mailbox's single beep. */
const SAME_TONE_HZ = 25;
const SAME_TONE_MS = 100;

/** Quiet on a joined line, with Kenan silent, before GPT is told the person is waiting for it. */
export const OPEN_QUIET_MS = 1500;
/** More line sound than this after joining, with no greeting from Kenan, is a recording or a menu, not a waiting person. */
const OPEN_SPEECH_MS = 2500;

export type Cue = { kind: 'greet'; atMs: number } | { kind: 'leave'; atMs: number; after: 'beep'; hz: number } | { kind: 'leave'; atMs: number; after: 'gap' };
type Opening = { state: 'not-joined' } | { state: 'joined'; atMs: number; kenanWords: number; speechMs: number } | { state: 'settled' };
type Tone = { hz: number; startMs: number; melodic: boolean };
type Beep = { atMs: number; hz: number; speechBeforeMs: number };
type Recognised = { atMs: number; fromLine: 'before-kenan' | 'after-kenan'; menu: boolean };

/** Watches one outbound line: emits at most one greet cue (a person waits in silence for Kenan) and at most one leave
 *  cue (a mailbox is recording). */
export class LineWatch {
  private nowMs = 0;
  private previous: Int16Array = new Int16Array(FRAME);
  private heard = '';
  private recognised: Recognised | null = null;
  private lastSoundMs: number | null = null;
  private lastKenanMs: number | null = null;
  private kenanWords = 0;
  /** Kenan's words since the greeting was recognised or, once there is one, since the beep. */
  private kenanWordsSince = 0;
  private speechMs = 0;
  private tone: Tone | null = null;
  private lastToneEndMs: number | null = null;
  private beep: Beep | null = null;
  /** Steady tones heard so far; one that repeats marks the line as a periodic signal. */
  private steadyTones: { hz: number; lengthMs: number }[] = [];
  private periodic = false;
  private settled: 'open' | 'cued' | 'kenan-took-it' = 'open';
  private opening: Opening = { state: 'not-joined' };

  get elapsedMs(): number { return this.nowMs; }
  get state(): 'open' | 'cued' | 'kenan-took-it' { return this.settled; }

  /** GPT Live's transcript of the line. */
  person(delta: string): void {
    if (this.settled !== 'open') return;
    this.heard += delta;
    if (this.recognised || !voicemailGreeting(this.heard)) return;
    this.recognised = { atMs: this.nowMs, fromLine: this.kenanWords >= MESSAGE_WORDS ? 'after-kenan' : 'before-kenan', menu: false };
    this.kenanWordsSince = 0;
  }

  /** Kenan's own speech. Kenan saying a sentence after the beep is Kenan leaving the message itself; before the beep the
   *  mailbox was not recording yet, so the beep still cues it to leave the message from the start. */
  kenan(delta: string): void {
    const words = delta.split(/\s+/).filter(Boolean).length;
    this.lastKenanMs = this.nowMs;
    this.kenanWords += words;
    this.kenanWordsSince += words;
  }

  /** The bridge has joined the call: from now on Kenan is heard, and a quiet line means the person is waiting for it. */
  joined(): void {
    if (this.opening.state === 'not-joined') this.opening = { state: 'joined', atMs: this.nowMs, kenanWords: this.kenanWords, speechMs: this.speechMs };
  }

  /** Keypad digits were pressed: whatever answers next (a mailbox after a menu) is watched from scratch. */
  rearm(): void {
    this.opening = { state: 'settled' };
    if (this.settled !== 'open') return;
    this.heard = '';
    this.recognised = null;
    this.beep = null;
    this.steadyTones = [];
    this.periodic = false;
    this.tone = null;
    this.lastToneEndMs = null;
    this.kenanWords = 0;
    this.kenanWordsSince = 0;
    this.speechMs = 0;
  }

  /** Feed one 20 ms frame of 8 kHz mono PCM; returns the cue when the mailbox is recording and Kenan should speak. */
  push(frame: Int16Array): Cue | null {
    if (frame.length !== FRAME) throw new Error(`VoicemailWatch frames are ${FRAME} samples`);
    const { level, tone } = analyse(this.previous, frame);
    this.previous = frame;
    this.nowMs += FRAME_MS;
    const now = this.nowMs;
    const sound = level > SOUND_DB;
    this.trackTone(sound ? tone : null, now);
    if (sound && tone === null) { this.lastSoundMs = now; this.speechMs += FRAME_MS; }
    if (this.settled !== 'open') return null;
    const greet = this.greet(now);
    if (greet) return greet;
    const { beep } = this;
    if (!this.recognised) {
      // Without mailbox wording, only a single beep's shape can say a mailbox is recording: a tone the line repeats
      // (a talking clock's) never does.
      const unheardGreeting = beep && !this.periodic && beep.speechBeforeMs >= UNHEARD_GREETING_MS && this.kenanWords < MESSAGE_WORDS && now - beep.atMs >= QUIET_AFTER_BEEP_MS && (this.lastSoundMs ?? 0) < beep.atMs;
      return unheardGreeting ? this.cue({ kind: 'leave', atMs: now, after: 'beep', hz: beep.hz }) : null;
    }
    if (MENU.test(this.heard)) this.recognised.menu = true;
    const { recognised } = this;
    if (beep && beep.atMs >= recognised.atMs - BEEP_LOOKBACK_MS) {
      if (this.kenanWordsSince < MESSAGE_WORDS) return this.cue({ kind: 'leave', atMs: now, after: 'beep', hz: beep.hz });
      this.settled = 'kenan-took-it';
      return null;
    }
    // No beep: a mailbox that greeted us and then went quiet is recording. A greeting heard only after Kenan talked with
    // someone may be a person ("voulez-vous laisser un message ?"), and a menu offers a mailbox without being one: only a
    // beep counts there. Kenan already speaking its message needs no cue; a beep after it still does.
    if (recognised.fromLine === 'after-kenan' || recognised.menu || this.kenanWordsSince >= MESSAGE_WORDS) return null;
    const lastSound = Math.max(this.lastSoundMs ?? 0, this.lastKenanMs ?? 0);
    if (now - lastSound >= GAP_MS && this.tone === null) return this.cue({ kind: 'leave', atMs: now, after: 'gap' });
    return null;
  }

  private cue(cue: Cue): Cue { this.settled = 'cued'; return cue; }

  private greet(now: number): Cue | null {
    const opening = this.opening;
    if (opening.state !== 'joined') return null;
    const recorded = this.recognised !== null || this.beep !== null || this.tone !== null || MENU.test(this.heard) || this.speechMs - opening.speechMs > OPEN_SPEECH_MS;
    if (recorded || this.kenanWords > opening.kenanWords) { this.opening = { state: 'settled' }; return null; }
    if (now - Math.max(opening.atMs, this.lastSoundMs ?? 0) < OPEN_QUIET_MS) return null;
    this.opening = { state: 'settled' };
    return { kind: 'greet', atMs: now };
  }

  // A beep is one steady tone, 120 ms to 1.5 s long, not part of a melody or ring cadence.
  private trackTone(tone: number | null, now: number): void {
    const current = this.tone;
    if (tone !== null) {
      if (current && Math.abs(current.hz - tone) <= 25) return;
      if (current) this.lastToneEndMs = now;
      this.tone = { hz: tone, startMs: now, melodic: this.lastToneEndMs !== null && now - this.lastToneEndMs < MELODY_GAP_MS };
      return;
    }
    if (!current) return;
    this.tone = null;
    this.lastToneEndMs = now;
    const length = now - current.startMs;
    if (length >= BEEP_MIN_MS && length <= BEEP_MAX_MS && !current.melodic) {
      if (this.steadyTones.some(t => Math.abs(t.hz - current.hz) <= SAME_TONE_HZ && Math.abs(t.lengthMs - length) <= SAME_TONE_MS)) this.periodic = true;
      this.steadyTones.push({ hz: current.hz, lengthMs: length });
      this.beep = { atMs: now, hz: Math.round(current.hz), speechBeforeMs: this.speechMs };
      this.kenanWordsSince = 0;
    }
  }
}

const SPOKEN_DONE_MS = 2500;
const UNANSWERED_MS = 10_000;
const SHIELD_MAX_MS = 90_000;
/** While Kenan leaves its message, GPT Live hears silence instead of the line, so a mailbox prompt after the beep cannot
 *  interrupt it. The line is heard again once Kenan has been quiet for a moment after speaking, or if it never starts. */
export class MessageShield {
  private since: number | null = null;
  private lastKenanMs: number | null = null;
  get active(): boolean { return this.since !== null; }
  start(nowMs: number): void { this.since = nowMs; this.lastKenanMs = null; }
  kenan(nowMs: number): void { if (this.since !== null) this.lastKenanMs = nowMs; }
  /** Ends the shield when its time is up and says how: Kenan left the message, or never started speaking. */
  check(nowMs: number): 'left' | 'unanswered' | null {
    if (this.since === null) return null;
    const outcome = this.lastKenanMs !== null
      ? nowMs - this.lastKenanMs >= SPOKEN_DONE_MS || nowMs - this.since >= SHIELD_MAX_MS ? 'left' : null
      : nowMs - this.since >= UNANSWERED_MS ? 'unanswered' : null;
    if (outcome) this.since = null;
    return outcome;
  }
}

/** What GPT Live is told when the person answered and is waiting in silence. `heard` is what they said before the bridge
 *  joined the call, from the telephone provider's own transcript. */
export const greetNow = (heard: string | null, language: string | null) =>
  `The person has answered and is waiting for you to speak${heard ? `; before you joined the line they said "${heard}"` : ''}. Greet them now${language ? ` in ${heard ? `the language they spoke (${language} if you cannot tell)` : language}` : ''} and introduce yourself as the brief says.`;

/** What GPT Live is told when the mailbox is recording. */
export const LEAVE_MESSAGE = {
  beep: "The voicemail beep has sounded: the mailbox is recording now, and nothing said before the beep was recorded. Leave the brief's voicemail message now, from its start, once, clearly, in the greeting's language and with only contact details from the brief, then say goodbye. Do not wait for anything else the mailbox says.",
  gap: "The voicemail greeting has ended and the mailbox is recording now. Leave the brief's voicemail message now, once, clearly, in the greeting's language and with only contact details from the brief, then say goodbye.",
} as const;
