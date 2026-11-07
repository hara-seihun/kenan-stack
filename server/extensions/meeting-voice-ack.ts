/**
 * Spoken acknowledgements for requests the request desk carries out (meeting-voice.ts), in Kenan's own voice.
 *
 * GPT Live still decides when Kenan speaks, and nothing here touches what it hears or says: this module only gives the
 * desk two short recorded lines of its own, "Let me check." and "Sure.", which the native notetaker's page plays into
 * Kenan's microphone on the desk's command. Round 2 (November 6, 2026) measured why: GPT Live's own "let me check" for a
 * lookup came 2.6 to 7 s after the question in 7 of 12 calls, and its "Sure" for a screen request reached 4 to 8 s
 * while the system was already acting. A line the desk sends to GPT Live as commentary takes 0.9 to 1.8 s more before it
 * is heard (16 measured shares), so the desk plays a recording instead, and tells GPT Live it was said.
 *
 * The desk decides from the words (the input transcript), as it already does for routing; the page decides nothing
 * about the people in the call. The page only declines to start a line while GPT Live itself is talking or has just
 * talked, and stops its own line if GPT Live starts (Kenan never talks over itself).
 */

export type AckClip = 'sure' | 'check';

/** The clips and their words. */
export const CLIP_WORDS: Record<AckClip, string> = { sure: 'Sure.', check: 'Let me check.' };

/** What the voice is told once a clip has played (it did not say those words itself). */
export const CLIP_NOTE: Record<AckClip, string> = {
  check: 'Kenan\'s system just said "Let me check." aloud for you. Do not say it again or announce the lookup; if the request needs backend work, generate <|SpawnThinking|> silently. The result reaches you when it is done.',
  sure: 'Kenan\'s system just said "Sure." aloud for you. Do not say "Sure" again; if the request needs backend work, generate <|SpawnThinking|> silently. The system tells the meeting when it is done.',
};

/** Asking to show, share, switch or stop a screen, or to make or move slides. */
const ACTION_WORDS = /\b(share|sharing|show (?:us|me|the)|present|presenting|put (?:it|that|this|them|.{1,50}) (?:up|on)|pull (?:it|that|this|them|.{1,50}) up|pull up|bring up|switch|slides|deck|next slide|previous slide|go back|slide (?:one|two|three|four|five|\d+)|stop sharing|stop presenting)\b/i;
/** Talk about a slide or the screen rather than a request to change it ("walk us through this first slide"). */
const NOT_ACTION = /\b(walk (?:us|me) through|explain|tell (?:us|me)|what(?:'s| is| does)|summari[sz]e|describe|talk (?:us )?through)\b/i;
/** Asking Kenan to look something up ("Google" only as a verb: "the Wikipedia article about Google Meet" is not a lookup). */
const LOOKUP_REQUEST = /\b(look (?:it |that |this )?up|look into|search(?: for)?|google (?:it|that|this|for|what|how|who|when|where|whether)|find out|check (?:on |what|whether|if|the|how)|what(?:'s| is| are) the (?:current|latest))\b/i;

/**
 * Which acknowledgement the words heard so far call for: 'check' for a lookup, 'sure' for a screen or slide action, or
 * null. `addressedToKenan` is the strict addressee test (meeting-consent.ts addressed); "hold on" words never get one.
 */
export function ackClip(words: string, addressedToKenan: boolean, holdOn: boolean): AckClip | null {
  if (!addressedToKenan || holdOn || words.trim().length < 6) return null;
  if (LOOKUP_REQUEST.test(words)) return 'check';
  if (ACTION_WORDS.test(words) && !NOT_ACTION.test(words)) return 'sure';
  return null;
}

/**
 * A spoken clip without its leading and trailing silence (the speech API pads both; the padding is heard as delay). A
 * 16-bit PCM WAV in, the same format out; anything else is returned unchanged.
 */
export function trimWav(wav: Buffer, threshold = 400, marginMs = 30): Buffer {
  if (wav.length < 44 || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') return wav;
  let offset = 12, format: { channels: number; rate: number; bits: number } | null = null;
  while (offset + 8 <= wav.length) {
    const id = wav.toString('ascii', offset, offset + 4);
    let size = wav.readUInt32LE(offset + 4);
    if (id === 'fmt ') format = { channels: wav.readUInt16LE(offset + 10), rate: wav.readUInt32LE(offset + 12), bits: wav.readUInt16LE(offset + 22) };
    if (id === 'data') {
      if (!format || format.bits !== 16) return wav;
      // Streaming WAVs give 0xFFFFFFFF (unknown) as the data size: the data runs to the end.
      if (size > wav.length - offset - 8) size = wav.length - offset - 8;
      const frame = 2 * format.channels, start = offset + 8, frames = Math.floor(size / frame);
      let first = -1, last = -1;
      for (let i = 0; i < frames; i++) {
        let loud = false;
        for (let c = 0; c < format.channels; c++) if (Math.abs(wav.readInt16LE(start + i * frame + c * 2)) >= threshold) loud = true;
        if (loud) { if (first < 0) first = i; last = i; }
      }
      if (first < 0) return wav;
      const margin = Math.round(format.rate * marginMs / 1000);
      const from = Math.max(0, first - margin), to = Math.min(frames, last + 1 + margin);
      const data = wav.subarray(start + from * frame, start + to * frame);
      const header = Buffer.alloc(44);
      header.write('RIFF', 0, 'ascii'); header.writeUInt32LE(36 + data.length, 4); header.write('WAVE', 8, 'ascii');
      header.write('fmt ', 12, 'ascii'); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(format.channels, 22);
      header.writeUInt32LE(format.rate, 24); header.writeUInt32LE(format.rate * frame, 28); header.writeUInt16LE(frame, 32); header.writeUInt16LE(16, 34);
      header.write('data', 36, 'ascii'); header.writeUInt32LE(data.length, 40);
      return Buffer.concat([header, data]);
    }
    offset += 8 + size + (size % 2);
  }
  return wav;
}

/** Duration (seconds) and peak (0 to 1) of a 16-bit PCM WAV's audio, or null for anything else. */
export function wavShape(wav: Buffer): { seconds: number; peak: number } | null {
  const pcm = wavPcm(wav);
  if (!pcm) return null;
  let peak = 0;
  for (let i = 0; i + 1 < pcm.data.length; i += 2) peak = Math.max(peak, Math.abs(pcm.data.readInt16LE(i)));
  return { seconds: pcm.data.length / 2 / pcm.channels / pcm.rate, peak: peak / 32768 };
}
/** The same WAV scaled so its peak is `target` (0 to 1): the clips must be as loud as GPT Live's own voice. */
export function normalizeWav(wav: Buffer, target = CLIP_PEAK): Buffer {
  const pcm = wavPcm(wav), shape = wavShape(wav);
  if (!pcm || !shape || shape.peak <= 0) return wav;
  const gain = target / shape.peak, out = Buffer.from(wav), start = pcm.offset;
  for (let i = 0; i + 1 < pcm.data.length; i += 2) out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(pcm.data.readInt16LE(i) * gain))), start + i);
  return out;
}
function wavPcm(wav: Buffer): { data: Buffer; offset: number; rate: number; channels: number } | null {
  if (wav.length < 44 || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') return null;
  let offset = 12, format: { channels: number; rate: number; bits: number } | null = null;
  while (offset + 8 <= wav.length) {
    const id = wav.toString('ascii', offset, offset + 4);
    let size = wav.readUInt32LE(offset + 4);
    if (id === 'fmt ') format = { channels: wav.readUInt16LE(offset + 10), rate: wav.readUInt32LE(offset + 12), bits: wav.readUInt16LE(offset + 22) };
    if (id === 'data') {
      if (!format || format.bits !== 16) return null;
      if (size > wav.length - offset - 8) size = wav.length - offset - 8;
      return { data: wav.subarray(offset + 8, offset + 8 + size), offset: offset + 8, rate: format.rate, channels: format.channels };
    }
    offset += 8 + size + (size % 2);
  }
  return null;
}

/**
 * What a usable recording of each line looks like once trimmed. Round 3 (November 7, 2026) found the speech API had
 * once returned "Let me check." as a 0.30 s near-silent clip: the page reported it played, and nobody heard anything (the
 * lookup went unacknowledged for 8.4 s). Its normal length is 0.8 to 0.9 s; "Sure." is 0.35 to 0.45 s.
 */
export const CLIP_LIMITS: Record<AckClip, { minSeconds: number; maxSeconds: number }> = { sure: { minSeconds: 0.25, maxSeconds: 1.2 }, check: { minSeconds: 0.55, maxSeconds: 1.6 } };
/** A clip quieter than this is refused; a kept clip is scaled to CLIP_PEAK (GPT Live's own voice peaks at 0.3 to 0.5 in Meet). */
export const CLIP_MIN_PEAK = 0.08, CLIP_PEAK = 0.7;
/** Speech calls per line before it is left out (the page then has no recording for it, and the desk's spoken fallback stands). */
export const CLIP_ATTEMPTS = 3;

/** The text-to-speech model for the clips (the voice exception to subscription-only routing: Kenan's own voice). */
export const CLIP_TTS_MODEL = 'gpt-4o-mini-tts';
type SpeechClient = { audio?: { speech?: { create(input: Record<string, unknown>): Promise<{ arrayBuffer(): Promise<ArrayBuffer> }> } } };
const clipCache = new Map<string, Promise<Partial<Record<AckClip, string>> | null>>();
/**
 * The clips in this voice as base64 WAV, made once per process and voice (short speech calls, about USD 0.0003 each).
 * Each recording is trimmed, checked against CLIP_LIMITS and CLIP_MIN_PEAK, and scaled to CLIP_PEAK; a bad one is made
 * again, up to CLIP_ATTEMPTS times, and then left out. A failure of the whole set is remembered for ten minutes and then
 * retried; without clips the system's spoken commentary is the fallback.
 */
export function voiceClips(client: SpeechClient, voice: string, log: (detail: Record<string, unknown>) => void): Promise<Partial<Record<AckClip, string>> | null> {
  let made = clipCache.get(voice);
  if (!made) {
    const started = Date.now();
    made = (async () => {
      const speech = client.audio?.speech;
      if (!speech) throw new Error('no speech API on this client');
      const entries = await Promise.all((Object.keys(CLIP_WORDS) as AckClip[]).map(async kind => {
        const rejected: { seconds: number; peak: number }[] = [];
        for (let attempt = 0; attempt < CLIP_ATTEMPTS; attempt++) {
          const response = await speech.create({ model: CLIP_TTS_MODEL, voice, input: CLIP_WORDS[kind], response_format: 'wav', instructions: 'Brief, relaxed and friendly, like a colleague in a meeting.' });
          const wav = trimWav(Buffer.from(await response.arrayBuffer())), shape = wavShape(wav);
          const limits = CLIP_LIMITS[kind];
          if (shape && shape.seconds >= limits.minSeconds && shape.seconds <= limits.maxSeconds && shape.peak >= CLIP_MIN_PEAK) {
            if (rejected.length) log({ voiceClipRetried: kind, voice, rejected: rejected.map(r => ({ seconds: Math.round(r.seconds * 1000) / 1000, peak: Math.round(r.peak * 1000) / 1000 })) });
            return [kind, normalizeWav(wav).toString('base64'), Math.round(shape.seconds * 1000)] as const;
          }
          rejected.push(shape ?? { seconds: 0, peak: 0 });
        }
        log({ voiceClipRefused: kind, voice, rejected: rejected.map(r => ({ seconds: Math.round(r.seconds * 1000) / 1000, peak: Math.round(r.peak * 1000) / 1000 })) });
        return null;
      }));
      const kept = entries.filter((e): e is NonNullable<typeof e> => e !== null);
      if (!kept.length) throw new Error('no usable recording');
      log({ voiceClips: voice, ms: Date.now() - started, bytes: kept.map(([, b]) => b.length), clipMs: Object.fromEntries(kept.map(([k, , ms]) => [k, ms])) });
      return Object.fromEntries(kept.map(([k, b]) => [k, b])) as Partial<Record<AckClip, string>>;
    })().catch(error => {
      log({ voiceClipsFailed: String(error).slice(0, 200), voice });
      setTimeout(() => clipCache.delete(voice), 600_000).unref?.();
      return null;
    });
    clipCache.set(voice, made);
  }
  return made;
}
/** Test hook: forget the made clips. */
export function forgetVoiceClips() { clipCache.clear(); }

/**
 * How long the input transcript must have been quiet before the desk plays a line. The transcript's last word arrives
 * 0.3 to 1.4 s after the words end (round 2), and words inside a request can be 0.6 to 0.8 s apart, so a lookup's line
 * waits 600 ms and an action's "Sure" (which GPT Live usually says itself at 1.5 to 2 s) waits 1,100 ms.
 */
export const ACK_QUIET_MS: Record<AckClip, number> = { check: 600, sure: 1_100 };
/** The page does not start a line if GPT Live's own voice was heard within this long. */
export const ACK_VOICE_RECENT_MS = 1_500;
