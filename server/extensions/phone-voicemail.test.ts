import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import OpusScript from 'opusscript';
import { FRAME, GAP_MS, LineWatch, MessageShield, OPEN_QUIET_MS, RATE, voicemailGreeting, type Cue } from './phone-voicemail.js';
import { ANSWERED, MAILBOXES, NOT_MAILBOXES, render, type Segment } from './phone-voicemail-fixtures.js';

const tools = (() => { try { execFileSync('espeak-ng', ['--version']); execFileSync('ffmpeg', ['-version']); return true; } catch { return false; } })();
const OPUS_SET_COMPLEXITY = 4010;
/** GPT Live's transcript of a phrase arrives a little after the audio. */
const TRANSCRIPT_LAG_MS = 800;
const after = (cue: Cue) => cue.kind === 'greet' ? 'greet' : cue.after;

// The callee's audio reaches the bridge as Opus at 48 kHz and is decoded to 8 kHz, so the fixtures take the same path.
function overTheLine(pcm: Int16Array): Int16Array[] {
  const encoder = new OpusScript(48000, 1, OpusScript.Application.VOIP), decoder = new OpusScript(RATE, 1, OpusScript.Application.VOIP);
  // Complexity 10 (the default) costs ~2.4 ms a frame here, so a busy host timed the suite out; 0 keeps the codec's artifacts at a fifth of the CPU.
  encoder.encoderCTL(OPUS_SET_COMPLEXITY, 0);
  const frames: Int16Array[] = [];
  for (let at = 0; at + FRAME <= pcm.length; at += FRAME) {
    const up = new Int16Array(FRAME * 6);
    for (let i = 0; i < up.length; i++) up[i] = pcm[at + Math.floor(i / 6)]!;
    const decoded = decoder.decode(encoder.encode(Buffer.from(up.buffer), up.length));
    frames.push(new Int16Array(decoded.buffer.slice(decoded.byteOffset, decoded.byteOffset + decoded.length)));
  }
  encoder.delete(); decoder.delete();
  return frames;
}
/** The line as the bridge watches it. `joined` is when the bridge joins the call (null: never, as in the mailbox cases);
 *  after a greet cue Kenan's hello (`replyToGreet`) follows GPT Live's reply delay. */
// Rendering and the Opus round trip dominate these suites; a line is the same audio however it is watched.
const lines = new Map<string, { audio: ReturnType<typeof render>; frames: Int16Array[] }>();
function line(segments: Segment[]) {
  const key = JSON.stringify(segments);
  let known = lines.get(key);
  if (!known) { const audio = render(segments, RATE); known = { audio, frames: overTheLine(audio.pcm) }; lines.set(key, known); }
  return known;
}
function watchLine(segments: Segment[], kenanFirst?: string, transcript = true, joined: number | null = null, replyToGreet?: string): { cues: Cue[]; beeps: number[]; greetingEndMs: number | null } {
  const { audio, frames } = line(segments);
  const watch = new LineWatch();
  if (kenanFirst) watch.kenan(kenanFirst);
  let reply: { atMs: number; text: string } | null = null;
  const pending = transcript ? audio.speech.map(s => ({ atMs: s.endMs + TRANSCRIPT_LAG_MS, text: s.text })) : [];
  const cues: Cue[] = [];
  for (const frame of frames) {
    if (joined !== null && watch.elapsedMs >= joined) watch.joined();
    while (pending[0] && pending[0].atMs <= watch.elapsedMs) watch.person(pending.shift()!.text);
    if (reply && reply.atMs <= watch.elapsedMs) { watch.kenan(reply.text); reply = null; }
    const cue = watch.push(frame);
    if (cue) cues.push(cue);
    if (cue?.kind === 'greet' && replyToGreet) reply = { atMs: cue.atMs + 800, text: replyToGreet };
  }
  return { cues, beeps: audio.beeps, greetingEndMs: audio.speech[0]?.endMs ?? null };
}

// These replay minutes of synthesized line audio through Opus and the detector: CPU-bound, not waiting on anything, so a
// busy host (agent tools run at CPU weight 10) stretches them past the 15 s default without anything being wrong.
const REPLAY_TIMEOUT_MS = 120_000;
describe.skipIf(!tools)('voicemail watch', { timeout: REPLAY_TIMEOUT_MS }, () => {
  it("cues once at the first beep of call 96bb3c65's mailbox, though prompts and more beeps follow", () => {
    const { cues, beeps } = watchLine(MAILBOXES.incident);
    expect(cues).toHaveLength(1);
    expect(after(cues[0]!)).toBe('beep');
    expect(cues[0]!.atMs).toBeGreaterThanOrEqual(beeps[0]!);
    expect(cues[0]!.atMs).toBeLessThan(beeps[0]! + 1000);
  });

  it('cues at the first beep when each prompt follows its beep, with or without a transcript of the greeting', () => {
    const { cues, beeps } = watchLine(MAILBOXES['incident-beep-first']);
    expect(cues.map(after)).toEqual(['beep']);
    expect(cues[0]!.atMs).toBeLessThan(beeps[0]! + 1000);
    const unheard = watchLine(MAILBOXES.english, undefined, false);
    expect(unheard.cues.map(after)).toEqual(['beep']);
    expect(unheard.cues[0]!.atMs).toBeLessThan(unheard.beeps[0]! + 1500);
  });

  it('cues at the beep even when a prompt plays straight after it', () => {
    const { cues, beeps } = watchLine(MAILBOXES['prompt-after-beep']);
    expect(cues).toHaveLength(1);
    expect(after(cues[0]!)).toBe('beep');
    expect(Math.abs((cues[0] as Extract<Cue, { after: 'beep' }>).hz - 950)).toBeLessThan(30);
    expect(cues[0]!.atMs).toBeLessThan(beeps[0]! + 1000);
  });

  it('cues an English mailbox at its tone', () => {
    const { cues, beeps } = watchLine(MAILBOXES.english);
    expect(cues.map(after)).toEqual(['beep']);
    expect(cues[0]!.atMs).toBeLessThan(beeps[0]! + 1000);
  });

  it('cues a mailbox that never beeps once the line has been quiet after its greeting', () => {
    const { cues, greetingEndMs } = watchLine(MAILBOXES['no-beep']);
    expect(cues.map(after)).toEqual(['gap']);
    // espeak ends each phrase with a little silence of its own, so the quiet starts slightly before the segment ends.
    expect(cues[0]!.atMs).toBeGreaterThanOrEqual(greetingEndMs! + GAP_MS - 500);
    expect(cues[0]!.atMs).toBeLessThan(greetingEndMs! + GAP_MS + 1000);
  });

  it('never cues a person, a menu offering a mailbox, hold music, or a person who offers to take a message', () => {
    for (const segments of Object.values(NOT_MAILBOXES)) {
      expect(watchLine(segments).cues).toEqual([]);
      expect(watchLine(segments, undefined, false).cues).toEqual([]);
    }
    // A tone the recording talks straight past (a talking clock) is not a mailbox recording when no greeting was heard.
    const clock = watchLine([{ kind: 'quiet', ms: 300 }, { kind: 'speech', voice: 'en', text: 'Eastern daylight time, eleven hours, forty eight minutes and thirty seconds.' }, { kind: 'tone', hz: 800, ms: 300 }, { kind: 'quiet', ms: 200 }, { kind: 'speech', voice: 'en', text: 'Eastern daylight time, eleven hours, forty eight minutes and forty seconds.' }], undefined, false);
    expect(clock.cues).toEqual([]);
    expect(watchLine([{ kind: 'quiet', ms: 400 }, { kind: 'speech', voice: 'fr', text: "Il n'est pas là. Voulez-vous lui laisser un message?" }, { kind: 'quiet', ms: 5000 }], 'Bonjour, ici Kenan, l\'assistant de Alice.').cues).toEqual([]);
  });

  it('lets Kenan leave its own message after a mailbox with no beep, and cues it again from the start at a beep it talked over', () => {
    const watch = new LineWatch();
    watch.person('Veuillez laisser votre message.');
    watch.kenan('Bonjour Monsieur Gagnon, ici Kenan, l\'assistant de Jordan.');
    for (let i = 0; i < (GAP_MS * 2) / 20; i++) expect(watch.push(new Int16Array(FRAME))).toBeNull();
    expect(watch.state).toBe('open');
    const beep = render([{ kind: 'tone', hz: 1000, ms: 400 }, { kind: 'quiet', ms: 400 }], RATE).pcm;
    const cues = [];
    for (let at = 0; at + FRAME <= beep.length; at += FRAME) { const cue = watch.push(beep.slice(at, at + FRAME)); if (cue) cues.push(cue); }
    expect(cues.map(after)).toEqual(['beep']);
  });
});

describe.skipIf(!tools)('opening an outbound call', { timeout: REPLAY_TIMEOUT_MS }, () => {
  it("greets the callee of call 55416c51, whose hello came before the bridge joined and who then waited in silence", () => {
    const { cues } = watchLine(ANSWERED['hello-before-join'], undefined, true, 1800);
    expect(cues.map(c => c.kind)).toEqual(['greet']);
    expect(cues[0]!.atMs).toBeGreaterThanOrEqual(1800 + OPEN_QUIET_MS);
    expect(cues[0]!.atMs).toBeLessThan(1800 + OPEN_QUIET_MS + 200);
  });

  it('greets a person who says hello again after the bridge joined once they fall quiet, and never cues again', () => {
    const { cues } = watchLine(ANSWERED['hello-again'], undefined, true, 1800, "Bonjour, ici Kenan, l'assistant de Jordan.");
    expect(cues.map(c => c.kind)).toEqual(['greet']);
  });

  it('does not greet a mailbox, a menu or hold music the bridge joins, and still cues the mailbox at its beep', () => {
    for (const [name, segments] of Object.entries(MAILBOXES)) {
      const { cues } = watchLine(segments, undefined, true, 0);
      expect(cues.map(c => c.kind), name).toEqual(['leave']);
    }
    for (const name of ['menu', 'hold-music'] as const) expect(watchLine(NOT_MAILBOXES[name], undefined, true, 0).cues, name).toEqual([]);
  });

  it('does not greet once Kenan has spoken on the joined line', () => {
    expect(watchLine(ANSWERED['hello-before-join'], 'Bonjour', true, 1800).cues.map(c => c.kind)).toEqual(['greet']);
    const watch = new LineWatch();
    watch.joined();
    watch.kenan('Bonjour, ici Kenan.');
    for (let i = 0; i < (OPEN_QUIET_MS * 3) / 20; i++) expect(watch.push(new Int16Array(FRAME))).toBeNull();
  });
});

describe('voicemail greetings', () => {
  it('recognises mailbox wording in French and English and not a talking clock or a receptionist', () => {
    for (const heard of ['veuillez laisser le message après le signal sonore', 'Laissez-moi un message', 'Please leave a message after the tone', "You've reached the voicemail of", 'après le bip']) expect(voicemailGreeting(heard)).toBe(true);
    for (const heard of ['At the tone, eastern daylight time', "Il n'est pas disponible pour le moment", 'Comment puis-je vous aider?']) expect(voicemailGreeting(heard)).toBe(false);
  });
});

describe('message shield', () => {
  it('holds the line back until Kenan has finished speaking, or gives it back if Kenan never starts', () => {
    const shield = new MessageShield();
    shield.start(0);
    shield.kenan(500);
    shield.kenan(6000);
    expect(shield.check(7000)).toBeNull();
    expect(shield.active).toBe(true);
    expect(shield.check(8600)).toBe('left');
    expect(shield.active).toBe(false);
    shield.start(10_000);
    expect(shield.check(15_000)).toBeNull();
    expect(shield.check(20_000)).toBe('unanswered');
  });
});
