// Where a live dictation stream may be cut into a piece whisper writes down on its own: in a pause, so no word is split.
// Pure: 16 kHz mono samples in, a sample index (or null: keep listening) out.

const FRAME = 320;                     // 20 ms
const MIN_PAUSE_FRAMES = 10;           // a pause between words: 200 ms or more, with speech after it
const TRAILING_PAUSE_FRAMES = 35;      // she stopped talking for 700 ms: what she said so far can be written down
// Each whisper pass costs about the same (≈ 0.6 s on the iGPU) for 1 s or 12 s of audio, so pieces are long: while she
// talks on, cut at a pause once there are 4 s; when she stops, write down even 1 s; never let a piece pass 12 s.
export const MIN_PIECE = 4 * 16_000;
const MIN_PAUSED_PIECE = 16_000;
export const MAX_PIECE = 12 * 16_000;

function levels(samples: Int16Array, from: number, frames: number): Float32Array {
  const rms = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0; const at = from + f * FRAME;
    for (let i = at; i < at + FRAME; i++) sum += samples[i]! * samples[i]!;
    rms[f] = Math.sqrt(sum / FRAME);
  }
  return rms;
}

/** Voice: frames well above the quietest 2 % (a short pause in a long stretch is still found). Absolute floor 60 (≈ −55 dBFS) so digital silence never counts. */
function threshold(rms: Float32Array): { quiet: number; voiced: number } {
  const sorted = [...rms].sort((a, b) => a - b);
  const floor = sorted[Math.floor(rms.length * 0.02)]!, peak = sorted[Math.floor(rms.length * 0.95)]!;
  return { quiet: floor + 0.15 * (peak - floor), voiced: Math.max(60, floor * 3, floor + 0.3 * (peak - floor)) };
}

/** Seconds of voice (by the whole clip's levels) whisper's span [start, end) seconds of `samples` holds. */
export function voicedTime(samples: Int16Array): (start: number, end: number) => number {
  const frames = Math.floor(samples.length / FRAME);
  if (frames < 1) return () => 0;
  const rms = levels(samples, 0, frames), { voiced } = threshold(rms);
  return (start, end) => {
    let count = 0;
    for (let f = Math.max(0, Math.floor(start * 50)); f < Math.min(frames, Math.ceil(end * 50)); f++) if (rms[f]! >= voiced) count++;
    return count * FRAME / 16_000;
  };
}

/** Whether samples[from, to) holds at least 150 ms of something like speech; silence isn't worth a whisper pass. */
export function hasVoice(samples: Int16Array, from: number, to: number): boolean {
  const frames = Math.floor((to - from) / FRAME);
  if (frames < 8) return false;
  const rms = levels(samples, from, frames), { voiced } = threshold(rms);
  let count = 0; for (const r of rms) if (r >= voiced) count++;
  return count >= 8;
}

/** The latest pause in samples[from, to) worth cutting at (see MIN_PIECE); its middle, or just into a trailing pause. */
export function cutPoint(samples: Int16Array, from: number, to: number): number | null {
  const frames = Math.floor((to - from) / FRAME);
  if (frames * FRAME < MIN_PAUSED_PIECE) return null;
  const rms = levels(samples, from, frames), { quiet } = threshold(rms);
  const minFrame = Math.ceil(MIN_PAUSED_PIECE / FRAME), minTalking = Math.ceil(MIN_PIECE / FRAME);
  let end = frames;
  for (let f = frames - 1; f >= minFrame; f--) {
    if (rms[f]! >= quiet) { end = f; continue; }
    let start = f; while (start > 0 && rms[start - 1]! < quiet) start--;
    const trailing = end === frames, length = end - start;
    const cut = trailing ? start + Math.floor(MIN_PAUSE_FRAMES / 2) : Math.floor((start + end) / 2);
    if ((trailing ? length >= TRAILING_PAUSE_FRAMES && cut >= minFrame : length >= MIN_PAUSE_FRAMES && cut >= minTalking) && hasVoice(samples, from, from + cut * FRAME)) return from + cut * FRAME;
    f = start;
  }
  if (to - from < MAX_PIECE) return null;
  let best = Math.floor(frames / 2);
  for (let f = best; f < frames - 5; f++) if (rms[f]! < rms[best]!) best = f;
  return from + best * FRAME + FRAME / 2;
}
