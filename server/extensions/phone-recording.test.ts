import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CallRecording, recordingConsent, RECORDING_RATE } from './phone-recording.js';

describe('call recording', () => {
  it('keeps both sides on one clock when one side starts late and pauses', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'rec-')), 'call.wav');
    const recording = new CallRecording(path, 0);
    const frame = (value: number) => new Int16Array(160).fill(value);
    for (let t = 20; t <= 4000; t += 20) {
      recording.push('line', frame(1000), t);
      if (t > 2000 && (t < 3000 || t > 3500)) recording.push('kenan', frame(-1000), t);
      if (t % 1000 === 0) recording.flush(t);
    }
    recording.close(4000);
    const wav = readFileSync(path);
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    const frames = wav.readUInt32LE(40) / 4;
    expect(Math.abs(frames - 4 * RECORDING_RATE)).toBeLessThan(RECORDING_RATE * 0.15);
    const at = (seconds: number) => [wav.readInt16LE(44 + Math.round(seconds * RECORDING_RATE) * 4), wav.readInt16LE(46 + Math.round(seconds * RECORDING_RATE) * 4)];
    expect(at(1)).toEqual([1000, 0]);
    expect(at(2.5)).toEqual([1000, -1000]);
    expect(at(3.25)).toEqual([1000, 0]);
    expect(at(3.8)).toEqual([1000, -1000]);
  });
});

// Recording without every party's consent is unlawful in California (Penal Code s. 632) and other places; Canada lets a
// party record. Today's calls: Montréal and Ottawa numbers are recorded, the owner's US mobile, toll-free lines,
// withheld and overseas numbers are not.
describe('recording consent', () => {
  it('records only Canadian geographic numbers', () => {
    for (const number of ['+15145550101', '+14385550102', '+16135550103', '+14505550104', '+18195550105']) expect(recordingConsent(number)).toMatchObject({ kind: 'one-party', jurisdiction: 'Canada' });
    for (const number of ['+15105550106', '+15105550107', '+18775550108', '+18665550109', '+12125550100', '+33142000000', null]) expect(recordingConsent(number).kind).toBe('not-recorded');
  });
});
