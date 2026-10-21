// Synthesized mailbox audio for the voicemail-cue regressions (unit test and live GPT Live check). Speech is espeak-ng
// band-limited to a phone line; beeps are pure tones. Needs espeak-ng and ffmpeg on PATH.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export type Segment = { kind: 'speech'; voice: 'fr' | 'en'; text: string } | { kind: 'quiet'; ms: number } | { kind: 'tone'; hz: number; ms: number } | { kind: 'tick'; ms: number };
export type Rendered = { pcm: Int16Array; rate: number; speech: { endMs: number; text: string }[]; beeps: number[] };

const say = (voice: 'fr' | 'en', text: string): Segment => ({ kind: 'speech', voice, text });
const quiet = (ms: number): Segment => ({ kind: 'quiet', ms });
const tone = (hz: number, ms: number): Segment => ({ kind: 'tone', hz, ms });
/** A clock's second tick: a short broadband click. */
const tick: Segment = { kind: 'tick', ms: 40 };
// The NRC talking clock as call 739f50a8 heard it on 2026-10-19: each ten seconds an announcement, a
// 300 ms 797 Hz time tone, then a tick every second; the first tick comes 680 ms after the tone.
const nrcCycle = (seconds: string): Segment[] => [say('en', `N R C, Eastern Daylight Time, eleven hours, eight minutes and ${seconds} seconds.`), quiet(500), tone(797, 300), quiet(680), tick, quiet(960), tick, quiet(960), tick, quiet(300)];

const prompt = say('fr', 'Après avoir laissé votre message, vous pouvez le modifier en appuyant sur le carré.');
/** Mailboxes that must get the brief's message once, after the beep (or after the greeting when there is none). */
export const MAILBOXES = {
  // Call 96bb3c65 (2026-10-19): the mailbox's own transcript, with a beep after each prompt and a silent recording window.
  incident: [quiet(500), say('fr', 'Veuillez laisser le message après le signal sonore.'), quiet(300), ...[0, 1, 2].flatMap(() => [prompt, quiet(300), tone(1000, 400), quiet(9000)]), say('fr', 'Désolé, nous devons mettre fin à cette conversation. Au revoir.')],
  // The same mailbox if its prompt follows each beep instead of preceding it.
  'incident-beep-first': [quiet(500), say('fr', 'Veuillez laisser le message après le signal sonore.'), quiet(300), ...[0, 1, 2].flatMap(() => [tone(1000, 400), quiet(200), prompt, quiet(9000)]), say('fr', 'Désolé, nous devons mettre fin à cette conversation. Au revoir.')],
  'prompt-after-beep': [quiet(500), say('fr', 'Bonjour, vous avez joint la boîte vocale de Sam. Je ne suis pas disponible. Laissez-moi un message.'), quiet(400), tone(950, 500), quiet(200), prompt, quiet(15000)],
  english: [quiet(500), say('en', "Hi, you've reached Sam. I can't take your call right now. Please leave a message after the tone."), quiet(300), tone(850, 600), quiet(15000)],
  'no-beep': [quiet(500), say('fr', 'Vous avez joint la boîte vocale de Claire. Laissez un message et je vous rappellerai.'), quiet(15000)],
} satisfies Record<string, Segment[]>;
/** A person answered; the bridge joins at 1.8 s, as on a real call. */
export const ANSWERED = {
  // Call 55416c51 (2026-10-19): "Hello?" at 0.5 s, before the bridge joined at 1.8 s, then 12 s of silence and a hang-up.
  'hello-before-join': [quiet(500), say('en', 'Hello?'), quiet(12000)],
  'hello-again': [quiet(500), say('fr', 'Allô?'), quiet(2500), say('fr', 'Allô?'), quiet(6000)],
} satisfies Record<string, Segment[]>;
/** Phone menus whose key the brief names; `brief` is added to the call's brief. */
export const MENUS = {
  // Call 10b48b42 (2026-10-19): a home buyer's menu; the brief said to have 1 pressed at once.
  'achat-exemple': { brief: "MENU TÉLÉPHONIQUE : la ligne répond « Bienvenue chez Achat Exemple. Pour le français, faites le 1. » Dès que tu entends ce menu, demande immédiatement qu'on presse la touche 1.", key: '1', segments: [quiet(300), say('fr', "Bienvenue chez Achat Exemple. Pour le français, faites le 1. Pour l'anglais, faites le 2. Pour l'espagnol, faites le 3."), quiet(8000)] },
} satisfies Record<string, { brief: string; key: string; segments: Segment[] }>;
/** Lines where nobody is recording: no leave cue may fire. */
export const NOT_MAILBOXES = {
  person: [quiet(400), say('fr', "Allô? Oui bonjour, Luc à l'appareil."), quiet(5000)],
  menu: [quiet(400), say('fr', 'Pour laisser un message, faites le 3. Pour parler à un conseiller, faites le 0.'), quiet(5000)],
  'talking-clock': [quiet(400), ...nrcCycle('twenty'), ...nrcCycle('thirty'), ...nrcCycle('forty')],
  'hold-music': [quiet(400), ...[523, 659, 784, 659, 587, 698, 880, 698, 523, 659, 784, 659].flatMap(hz => [tone(hz, 300), quiet(40)]), quiet(4000)],
} satisfies Record<string, Segment[]>;

// Synthesis runs two subprocesses per phrase (seconds on a busy host) and is deterministic, so each phrase is rendered
// once per machine and kept in the temp directory, keyed by everything that shapes it.
const SPEECH_FILTER = 'highpass=f=300,lowpass=f=3400,loudnorm=I=-22:TP=-3';
const spoken = new Map<string, Int16Array>();
function speech(voice: 'fr' | 'en', text: string, rate: number): Int16Array {
  const key = createHash('sha256').update(JSON.stringify([voice, rate, text, SPEECH_FILTER])).digest('hex');
  const known = spoken.get(key);
  if (known) return known;
  const file = join(tmpdir(), 'kenan-voicemail-speech', `${key}.s16le`);
  const cached = existsSync(file) ? readFileSync(file) : null;
  const pcm = cached ?? execFileSync('ffmpeg', ['-loglevel', 'error', '-i', 'pipe:0', '-af', SPEECH_FILTER, '-ar', String(rate), '-ac', '1', '-f', 's16le', 'pipe:1'],
    { input: execFileSync('espeak-ng', ['-v', voice, '--stdout', text], { maxBuffer: 1 << 26 }), maxBuffer: 1 << 26 });
  if (!cached) { mkdirSync(dirname(file), { recursive: true }); writeFileSync(`${file}.${process.pid}`, pcm); renameSync(`${file}.${process.pid}`, file); }
  const samples = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.length / 2);
  spoken.set(key, samples);
  return samples;
}

export function render(segments: Segment[], rate: number): Rendered {
  const parts: Int16Array[] = [], spoken: Rendered['speech'] = [], beeps: number[] = [];
  let samples = 0;
  const ms = () => (samples * 1000) / rate;
  for (const segment of segments) {
    const part = segment.kind === 'speech' ? speech(segment.voice, segment.text, rate)
      : segment.kind === 'quiet' ? Int16Array.from({ length: (rate * segment.ms) / 1000 }, () => Math.round((Math.random() - 0.5) * 30))
      : segment.kind === 'tick' ? Int16Array.from({ length: (rate * segment.ms) / 1000 }, () => Math.round((Math.random() - 0.5) * 12000))
      : Int16Array.from({ length: (rate * segment.ms) / 1000 }, (_, i) => Math.round(6000 * Math.sin((2 * Math.PI * segment.hz * i) / rate)));
    parts.push(part);
    samples += part.length;
    if (segment.kind === 'speech') spoken.push({ endMs: ms(), text: segment.text });
    if (segment.kind === 'tone') beeps.push(ms());
  }
  const pcm = new Int16Array(samples);
  let at = 0;
  for (const part of parts) { pcm.set(part, at); at += part.length; }
  return { pcm, rate, speech: spoken, beeps };
}
