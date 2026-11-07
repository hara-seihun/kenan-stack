import { execFile } from 'node:child_process';

/** Fixed local speech, independent of the Live voice that failed. */
export async function spokenApology(text: string, language: 'fr' | 'en'): Promise<Int16Array> {
  const wav = await new Promise<Buffer>((resolve, reject) => {
    execFile('espeak-ng', ['--stdout', '-v', language, '-s', '165', text],
      { encoding: 'buffer', timeout: 3000, maxBuffer: 2 * 1024 * 1024 },
      (error, stdout) => { if (error) reject(error); else resolve(stdout); });
  });
  if (wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') throw new Error('apology synthesis did not return WAV');
  let rate = 0, channels = 0, pcm: Buffer | null = null;
  for (let at = 12; at + 8 <= wav.length;) {
    const kind = wav.toString('ascii', at, at + 4), size = wav.readUInt32LE(at + 4), data = at + 8;
    if (kind === 'fmt ') {
      if (size < 16 || data + 16 > wav.length || wav.readUInt16LE(data) !== 1 || wav.readUInt16LE(data + 14) !== 16) throw new Error('apology WAV must be PCM16');
      channels = wav.readUInt16LE(data + 2); rate = wav.readUInt32LE(data + 4);
    }
    if (kind === 'data') { pcm = wav.subarray(data, Math.min(data + size, wav.length)); break; }
    at = data + size + (size & 1);
  }
  if (!pcm || !rate || channels !== 1) throw new Error('apology WAV is missing mono PCM');
  const count = Math.floor(pcm.length / 2), output = new Int16Array(Math.ceil(count * 8000 / rate));
  for (let i = 0; i < output.length; i++) {
    const at = i * rate / 8000, left = Math.min(Math.floor(at), count - 1), right = Math.min(left + 1, count - 1), fraction = at - left;
    output[i] = Math.round(pcm.readInt16LE(left * 2) * (1 - fraction) + pcm.readInt16LE(right * 2) * fraction);
  }
  return output;
}
