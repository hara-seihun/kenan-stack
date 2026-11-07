// Voicemail facts for outbound calls. GPT Live hears the line continuously, but a beep is a sound it does not reliably
// read as "the mailbox is recording now": on 2026-10-19 (call 96bb3c65) it stayed silent through "veuillez laisser le
// message après le signal sonore", the beep and three rounds of "après avoir laissé votre message… appuyez sur le carré"
// until the mailbox hung up. The bridge decodes the callee's audio to 8 kHz and watches it with GPT Live's own transcript of
// the line: once a voicemail greeting is recognised, the mailbox is recording at its beep, or once the line has been quiet
// for a moment after the greeting (some mailboxes never beep). A beep that ends a stretch of recorded speech and is
// followed by quiet means the same even when the transcript did not show the greeting. The bridge then adds that fact to
// GPT Live's context (session.thinking.append) and nothing else: GPT Live keeps hearing the line and decides itself what
// to say and when. GPT Live has no turns (see the top of phone-bridge.ts).
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
// A menu offer ("pour laisser un message, faites le 3") is not a mailbox greeting. Its tones do not establish recording
// either: pressing a key rearms the watch for the selected mailbox's own greeting and beep.
const MENU = /(?:faites|fa[iî]tes|appuyez sur|tapez|composez|press|dial|enter)\s+(?:le |la touche |the )?(?:\d|un|deux|trois|quatre|cinq|six|sept|huit|neuf|z[ée]ro|one|two|three|four|five|six|seven|eight|nine|zero)\b/i;
// Mailboxes may describe their after-recording keys before the beep. That does not make a direct recording instruction
// into a menu offer ('press zero to leave a message').
const RECORDING_INSTRUCTION = /apr[eè]s (?:le |la |l')?(?:signal|bip|tonalit[ée]|timbre)|signal sonore|after the (?:tone|beep)/i;
export const voicemailGreeting = (heard: string) => {
  const text = heard.replace(/\s+/g, ' ');
  return GREETING.test(text) && (!MENU.test(text) || RECORDING_INSTRUCTION.test(text));
};

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
/** The phone network's own call-progress tones (North America: dial 350+440, ringback 440+480, busy and reorder 480+620 Hz;
 *  Europe 425, UK 400+450 Hz). The detector's 15.6 Hz bins see a pair 40 Hz apart as one tone. A queue or transfer that
 *  rings on or gives up plays one of these, so such a tone is not evidence of a mailbox's beep (call
 *  d16adef8, 2026-11-02: after 9.5 min on hold a 484 Hz tone was taken for a beep and the line hung up 5 s later). */
const CALL_PROGRESS_HZ = [350, 400, 425, 440, 450, 480, 620];
const CALL_PROGRESS_SPREAD_HZ = 20;
export const callProgressTone = (hz: number) => CALL_PROGRESS_HZ.some(f => Math.abs(f - hz) <= CALL_PROGRESS_SPREAD_HZ);
/** Tones this alike are the same signal repeating (a clock's time tone), never a mailbox's single beep. */
const SAME_TONE_HZ = 25;
const SAME_TONE_MS = 100;

export type Cue = { kind: 'recording'; atMs: number; after: 'beep'; hz: number } | { kind: 'recording'; atMs: number; after: 'gap' };
type Tone = { hz: number; startMs: number; melodic: boolean };
type Beep = { atMs: number; hz: number; speechBeforeMs: number };
type Recognised = { atMs: number; fromLine: 'before-kenan' | 'after-kenan' };

/** Watches one outbound line: says at most once per keypad selection that a mailbox is recording. */
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

  get elapsedMs(): number { return this.nowMs; }
  get state(): 'open' | 'cued' | 'kenan-took-it' { return this.settled; }

  /** GPT Live's transcript of the line. */
  person(delta: string): void {
    if (this.settled !== 'open') return;
    this.heard += delta;
    if (this.recognised || !voicemailGreeting(this.heard)) return;
    this.recognised = { atMs: this.nowMs, fromLine: this.kenanWords >= MESSAGE_WORDS ? 'after-kenan' : 'before-kenan' };
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

  /** Keypad digits were pressed: whatever answers next is watched from scratch, even after a mistaken recording cue. */
  rearm(): void {
    this.settled = 'open';
    this.previous = new Int16Array(FRAME);
    this.lastSoundMs = this.nowMs;
    this.lastKenanMs = null;
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

  /** Feed one 20 ms frame of 8 kHz mono PCM; returns the cue when the mailbox has started recording. */
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
    const { beep } = this;
    // A menu can acquire its key instruction after the leave-message wording arrived in an earlier transcript delta.
    // Apply these exclusions before either beep path and the quiet-gap path; a rejected network tone must not become
    // recording merely because the line stays quiet afterwards.
    const menu = MENU.test(this.heard.replace(/\s+/g, ' '));
    if ((menu && !RECORDING_INSTRUCTION.test(this.heard)) || this.periodic || (beep && callProgressTone(beep.hz))) return null;
    if (!this.recognised) {
      // Without mailbox wording, only a single beep's shape can say a mailbox is recording: a tone the line repeats
      // (a talking clock's) never does.
      const unheardGreeting = beep && beep.speechBeforeMs >= UNHEARD_GREETING_MS && this.kenanWords < MESSAGE_WORDS && now - beep.atMs >= QUIET_AFTER_BEEP_MS && (this.lastSoundMs ?? 0) < beep.atMs;
      return unheardGreeting ? this.cue({ kind: 'recording', atMs: now, after: 'beep', hz: beep.hz }) : null;
    }
    const { recognised } = this;
    if (beep && beep.atMs >= recognised.atMs - BEEP_LOOKBACK_MS) {
      if (this.kenanWordsSince < MESSAGE_WORDS) return this.cue({ kind: 'recording', atMs: now, after: 'beep', hz: beep.hz });
      this.settled = 'kenan-took-it';
      return null;
    }
    // No beep: a mailbox that greeted us and then went quiet is recording. A greeting heard only after Kenan talked with
    // someone may be a person ("voulez-vous laisser un message ?"): only a beep counts there. Kenan already speaking its
    // message needs no cue; a beep after it still does.
    if (recognised.fromLine === 'after-kenan' || menu || this.kenanWordsSince >= MESSAGE_WORDS) return null;
    const lastSound = Math.max(this.lastSoundMs ?? 0, this.lastKenanMs ?? 0);
    if (now - lastSound >= GAP_MS && this.tone === null) return this.cue({ kind: 'recording', atMs: now, after: 'gap' });
    return null;
  }

  private cue(cue: Cue): Cue { this.settled = 'cued'; return cue; }

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

/** What GPT Live is told (session.thinking.append, a fact) when the mailbox is recording. */
export const MAILBOX_RECORDING = {
  beep: 'Fact about the line: a voicemail beep has just sounded, so the mailbox is recording from that beep on; nothing said before it was recorded.',
  gap: 'Fact about the line: the voicemail greeting has ended without a beep, so the mailbox is most likely recording now.',
} as const;

// Only a mailbox's explicit after-recording menu can establish that recording has ended.
// An unanswered opening followed by silence proves neither a mailbox nor that anyone heard it.
const MAILBOX_MENU = /to send (?:your|this|the) message,? (?:press|hang up)|(?:has|have) reached (?:its|the|your) maximum|maximum (?:message |recording )?(?:length|duration|time)|to re-?record (?:your|this|the) message|press (?:#|pound|one|1|two|2) to re-?record|to (?:delete|erase) (?:your|this|the) (?:current )?message and (?:re-?)?record|to (?:listen to|review|hear) (?:your|this) message\b|pour envoyer (?:votre|ce|le) message|pour r[ée]-?enregistrer|pour (?:effacer|supprimer) (?:votre|ce) message|pour (?:r[ée]?[ée]couter|[ée]couter) (?:votre|ce) message\b|dur[ée]e maximale/i;
export const mailboxMenu = (heard: string) => MAILBOX_MENU.test(heard.replace(/\s+/g, ' '));
/** Kenan's words since the line last answered it that make a message rather than a question. */
export const MESSAGE_MIN_WORDS = 12;
export type MessageOver = { kind: 'mailbox-menu'; messageLeft: boolean };

/** Recognises the mailbox's after-recording menu. Silence alone never ends an opening. */
export class MessageEnd {
  private kenanWords = 0;
  private heard = '';

  person(delta: string): MessageOver | null {
    this.heard += delta;
    return mailboxMenu(this.heard) ? { kind: 'mailbox-menu', messageLeft: this.kenanWords >= MESSAGE_MIN_WORDS } : null;
  }

  kenan(delta: string): void { this.kenanWords += delta.split(/\s+/).filter(Boolean).length; }

  /** A mailbox started recording, or a key was pressed. */
  restart(): void { this.kenanWords = 0; this.heard = ''; }
}

/** A recording mailbox is a call destination, not permission to speak. Closing a forbidden destination is a hangup,
 * not speech timing: the continuous audio streams remain untouched for every ongoing call. */
export function recordingAction(allowed: boolean, cue: Cue): { kind: 'end'; reason: string } | { kind: 'fact'; content: string } {
  return allowed
    ? { kind: 'fact', content: MAILBOX_RECORDING[cue.after] }
    : { kind: 'end', reason: 'reached a recording mailbox; voicemail is forbidden for this call, so Kenan ended it without a message' };
}
