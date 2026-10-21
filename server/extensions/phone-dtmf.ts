// Keypad digits for live calls: parsing what an agent asks to press, and in-band DTMF tones to play on the line.
const FRAME_MS = 20;
const DTMF: Record<string, [number, number]> = {
  '1': [697, 1209], '2': [697, 1336], '3': [697, 1477], A: [697, 1633],
  '4': [770, 1209], '5': [770, 1336], '6': [770, 1477], B: [770, 1633],
  '7': [852, 1209], '8': [852, 1336], '9': [852, 1477], C: [852, 1633],
  '*': [941, 1209], '0': [941, 1336], '#': [941, 1477], D: [941, 1633],
};
export type Digits = string & { readonly digits: unique symbol };
export function parseDigits(raw: unknown): { ok: true; value: Digits } | { ok: false; error: string } {
  if (typeof raw !== 'string') return { ok: false, error: 'digits must be a string of 0-9, *, #, A-D, or w for a half-second pause' };
  const value = raw.replace(/[\s-]/g, '').toUpperCase().replace(/W/g, 'w');
  if (!value || value.length > 32 || !/^[0-9*#A-Dw]+$/.test(value)) return { ok: false, error: `Invalid digits ${JSON.stringify(raw)}: use 0-9, *, #, A-D, or w for a half-second pause (at most 32)` };
  return { ok: true, value: value as Digits };
}

const LEAD_MS = 100, TONE_MS = 200, GAP_MS = 140;
/** In-band DTMF as 20 ms frames of mono PCM at `rate`: 100 ms of lead-in silence, then 200 ms of tone and 140 ms of
 *  silence per key, 500 ms per w. Tones survive Opus and the carrier's transcoding better at this length than at 160 ms. */
export function dtmfFrames(digits: Digits, rate: number): Int16Array[] {
  const per = (rate * FRAME_MS) / 1000;
  const frames: Int16Array[] = [];
  const silence = (ms: number) => { for (let i = 0; i < ms / FRAME_MS; i++) frames.push(new Int16Array(per)); };
  silence(LEAD_MS);
  for (const key of digits) {
    if (key === 'w') { silence(500); continue; }
    const [low, high] = DTMF[key]!;
    for (let f = 0; f < TONE_MS / FRAME_MS; f++) {
      const frame = new Int16Array(per);
      for (let i = 0; i < per; i++) {
        const t = (f * per + i) / rate;
        frame[i] = Math.round(9000 * (Math.sin(2 * Math.PI * low * t) + Math.sin(2 * Math.PI * high * t)));
      }
      frames.push(frame);
    }
    silence(GAP_MS);
  }
  return frames;
}
