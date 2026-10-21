// Both sides of a call as they were on the line, so a call can be judged afterwards by what was actually said: Retell
// records only the seconds before the bridge takes the call over, and GPT Live's transcripts are what it heard, not what
// was said (call 488e7d78's "Quelle heure maintenant"). A stereo 8 kHz 16-bit WAV per call: left is the other party,
// right is everything sent to the phone (Kenan's voice and keypad tones), both on the bridge's wall clock.
import { closeSync, mkdirSync, openSync, readdirSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';

// A call is recorded only where recording it needs no one's consent but Kenan's own, as a party to the call. Canada's
// Criminal Code s. 184(2)(a) allows that everywhere in Canada (Quebec included). Other places may require every
// party's consent (California Penal Code s. 632 and about a dozen other US states), and a number's state is a lookup
// this code does not carry, so the rule is an allow-list: the other party's number must be a Canadian geographic number.
// Toll-free, withheld and non-NANP numbers name no jurisdiction and are not recorded. The area code is where the number
// was issued, which is the best evidence of jurisdiction a call has.
/** Canadian geographic area codes, in service or assigned to Canada for relief (CNAC, October 2026). */
const CANADIAN_AREA_CODES = new Set([
  '368', '403', '587', '780', '825', // Alberta
  '236', '250', '257', '604', '672', '778', // British Columbia
  '204', '431', '584', // Manitoba
  '428', '506', // New Brunswick
  '709', '879', // Newfoundland and Labrador
  '782', '851', '902', // Nova Scotia and Prince Edward Island
  '226', '249', '289', '343', '365', '382', '387', '416', '437', '460', '519', '537', '548', '613', '647', '683', '705', '742', '753', '807', '905', '942', // Ontario
  '263', '273', '354', '367', '418', '438', '450', '468', '514', '579', '581', '819', '873', // Quebec
  '306', '474', '639', // Saskatchewan
  '867', // Yukon, Northwest Territories and Nunavut
]);

export type RecordingConsent = { kind: 'one-party'; jurisdiction: 'Canada'; areaCode: string } | { kind: 'not-recorded'; why: string };
/** Whether a call with this party (E.164, or null when withheld) may be recorded on Kenan's consent alone. */
export function recordingConsent(number: string | null): RecordingConsent {
  if (number === null) return { kind: 'not-recorded', why: 'the number is withheld, so its jurisdiction is unknown' };
  const nanp = /^\+1(\d{3})\d{7}$/.exec(number);
  if (!nanp) return { kind: 'not-recorded', why: 'not a North American number, so its consent rule is unknown' };
  const areaCode = nanp[1]!;
  if (CANADIAN_AREA_CODES.has(areaCode)) return { kind: 'one-party', jurisdiction: 'Canada', areaCode };
  return { kind: 'not-recorded', why: `area code ${areaCode} is not Canadian, and its jurisdiction may require every party's consent` };
}

export const RECORDING_RATE = 8000;
/** Recordings older than this are deleted when a bridge starts. */
export const RECORDING_DAYS = 30;
/** How far behind real time a side may lag before the gap is filled with silence. */
const SLACK_MS = 120;

export type Side = 'line' | 'kenan';

function header(dataBytes: number): Buffer {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + dataBytes, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(2, 22);
  h.writeUInt32LE(RECORDING_RATE, 24); h.writeUInt32LE(RECORDING_RATE * 4, 28); h.writeUInt16LE(4, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(dataBytes, 40);
  return h;
}

class Track {
  buffer = new Int16Array(RECORDING_RATE * 4);
  length = 0;
  /** Samples placed on the timeline so far, written or pending. */
  placed = 0;
  append(samples: Int16Array | number): void {
    const n = typeof samples === 'number' ? samples : samples.length;
    if (this.length + n > this.buffer.length) {
      const grown = new Int16Array(Math.max(this.buffer.length * 2, this.length + n));
      grown.set(this.buffer.subarray(0, this.length));
      this.buffer = grown;
    }
    if (typeof samples === 'number') this.buffer.fill(0, this.length, this.length + n);
    else this.buffer.set(samples, this.length);
    this.length += n;
    this.placed += n;
  }
  take(n: number): Int16Array {
    const out = this.buffer.slice(0, n);
    this.buffer.copyWithin(0, n, this.length);
    this.length -= n;
    return out;
  }
}

export class CallRecording {
  private readonly fd: number;
  private readonly tracks: Record<Side, Track> = { line: new Track(), kenan: new Track() };
  private dataBytes = 0;
  private closed = false;

  constructor(readonly path: string, private readonly startMs: number) {
    this.fd = openSync(path, 'w', 0o600);
    writeSync(this.fd, header(0), 0, 44, 0);
  }

  private due(nowMs: number): number { return Math.floor(((nowMs - this.startMs) * RECORDING_RATE) / 1000); }

  /** Decoded 8 kHz mono audio from one side, received at nowMs. A side that fell behind (no packets) gets silence. */
  push(side: Side, samples: Int16Array, nowMs: number): void {
    if (this.closed) return;
    const track = this.tracks[side];
    const gap = this.due(nowMs) - samples.length - track.placed;
    if (gap > (SLACK_MS * RECORDING_RATE) / 1000) track.append(gap);
    track.append(samples);
  }

  /** Writes what both sides have up to nowMs, less the slack, filling a silent side with silence. */
  flush(nowMs: number): void {
    if (this.closed) return;
    const upTo = this.due(nowMs - SLACK_MS);
    for (const track of Object.values(this.tracks)) if (track.placed < upTo) track.append(upTo - track.placed);
    const n = Math.min(this.tracks.line.length, this.tracks.kenan.length);
    if (n === 0) return;
    const line = this.tracks.line.take(n), kenan = this.tracks.kenan.take(n);
    const frames = Buffer.alloc(n * 4);
    for (let i = 0; i < n; i++) { frames.writeInt16LE(line[i]!, i * 4); frames.writeInt16LE(kenan[i]!, i * 4 + 2); }
    writeSync(this.fd, frames, 0, frames.length, 44 + this.dataBytes);
    this.dataBytes += frames.length;
  }

  close(nowMs: number): void {
    if (this.closed) return;
    this.flush(nowMs + SLACK_MS);
    this.closed = true;
    writeSync(this.fd, header(this.dataBytes), 0, 44, 0);
    closeSync(this.fd);
  }
}

/** The directory for a channel's call recordings, created if missing, with recordings past RECORDING_DAYS deleted. */
export function recordingDirectory(dataDir: string, nowMs: number): string {
  const dir = join(dataDir, 'call-audio');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (nowMs - statSync(path).mtimeMs > RECORDING_DAYS * 86_400_000) unlinkSync(path);
  }
  return dir;
}
