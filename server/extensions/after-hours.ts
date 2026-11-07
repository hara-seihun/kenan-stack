// Kenan After Hours (Dave 2026-10-23): one-way voice memos from his Apple Watch, and (2026-10-25) text memos his Watch's
// "Hey Siri, After Hours" shortcut dictates and sends; the shortcut keeps its own copy in Reminders and resends from there. He uses no electronics after 23:00
// except the watch, and gets ideas then. The watch keeps every recording until this endpoint confirms it, so the
// contract is: a 200 means the audio is on disk here (fsynced, sha256 checked) under the memo's id, and sending the same
// memo again is answered `duplicate`. Each memo is then written down on this host's dictation engines, posted as his own
// message into his 🌙 After Hours chat (no agent hears that post), and handed to his Kenaznia as a clock wake at the end of
// his quiet hours, so nothing talks back at night. The watch reaches us through the public entrance (kenan.example.com,
// exact path; DESIGN.md, Kenan After Hours) with a per-device bearer token whose sha256 is in people[].afterHours.
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { open, readdir, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import type { ConversationSummary } from '../../shared/contract.js';
import { clockIn, minuteIn, zoneOrHome } from '../../shared/zone.js';
import { hostFolder, hostedManager, type AfterHoursConfig, type PersonConfig, type ServerConfig } from '../config.js';
import { fail } from '../db/errors.js';
import { filePart, saveFile } from '../files/files.js';
import type { Deps, Extension } from '../types.js';
import { MAX_SECONDS, transcribeWav, wavOf } from './dictation.js';
import { deviceFor, writeOwned } from './device-token.js';
import { ownedDir } from './texts.js';

export const MAX_BYTES = 100 * 1024 * 1024;
/** Audio types the watch may send, and the file extension each is kept under. */
export const AUDIO = { 'audio/wav': 'wav', 'audio/mp4': 'm4a' } as const;
export type AudioType = keyof typeof AUDIO;
export const MAX_TEXT_BYTES = 64 * 1024;
const SAMPLE_RATE = 16_000;
const MAX_AUDIO_SECONDS = 3600;
/** A memo longer than the engines take at once is written down in pieces cut at the quietest 20 ms before this mark. */
const PIECE_SECONDS = MAX_SECONDS - 10;
const CUT_SEARCH_SECONDS = 10;
const DECODE_MS = 120_000;
const SWEEP_MS = 60_000;
const WAKE_TRANSCRIPT_CHARS = 8000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NOBODY = 65534;

export type Transcript = { kind: 'pending' } | { kind: 'done'; text: string; seconds: number } | { kind: 'failed'; error: string };
/** Whether his Kenaznia has the memo: a clock wake for the end of quiet hours, or this channel does not host it. */
export type Handover = { kind: 'pending' } | { kind: 'scheduled'; wakeId: string; at: number } | { kind: 'not_hosted' };
interface MemoBase { id: string; device: string; recordedAt: number; receivedAt: number; bytes: number; sha256: string; messageId: string | null; kenaznia: Handover }
/** A recording (written down here) or text dictated on the watch (kept as UUID.txt, already words). */
export type Memo = MemoBase & ({ type: AudioType; audio: string; transcript: Transcript } | { type: 'text/plain'; text: string });
export type Ingest = { status: 'stored'; memo: Memo } | { status: 'duplicate'; memo: Memo };


/** When a memo recorded now may reach Kenaznia: now, or the end of the quiet hours it falls in (in the person's zone). */
export function handoverAt(now: number, zone: string, quiet: AfterHoursConfig['quietHours']): number {
  if (quiet === null) return now;
  const minutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));
  const from = minutes(quiet.from), until = minutes(quiet.until), minute = minuteIn(now, zone);
  const inside = from < until ? minute >= from && minute < until : minute >= from || minute < until;
  if (!inside) return now;
  return now - (now % 60_000) + ((until - minute + 1440) % 1440) * 60_000;
}

const memoType = (header: string | undefined): AudioType | 'text/plain' => {
  const base = header?.split(';', 1)[0]!.trim().toLowerCase();
  return base === 'audio/wav' || base === 'audio/mp4' || base === 'text/plain' ? base : fail('invalid_input', `after_hours_type: Content-Type must be ${[...Object.keys(AUDIO), 'text/plain'].join(', ')}`);
};

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/;
/** x-recorded-at: epoch milliseconds, or ISO 8601 with its offset (what Shortcuts' Format Date gives). */
export function recordedAtOf(header: string | undefined): number {
  const value = header?.trim() ?? '';
  const at = /^\d{1,15}$/.test(value) ? Number(value) : ISO.test(value) ? Date.parse(value.replace(/([+-]\d{2})(\d{2})$/, '$1:$2')) : NaN;
  return Number.isSafeInteger(at) && at > 0 ? at : fail('invalid_input', 'after_hours_recorded_at: x-recorded-at must be epoch milliseconds or ISO 8601 with an offset');
}

async function syncDir(dir: string) { const handle = await open(dir, 'r'); try { await handle.sync(); } finally { await handle.close(); } }

async function readMemo(dir: string, id: string): Promise<Memo | null> {
  const text = await readFile(join(dir, `${id}.json`), 'utf8').catch(e => (e as NodeJS.ErrnoException).code === 'ENOENT' ? null : Promise.reject(e));
  return text === null ? null : JSON.parse(text) as Memo;
}
const saveMemo = (person: PersonConfig, dir: string, memo: Memo) => writeOwned(person, join(dir, `${memo.id}.json`), JSON.stringify(memo, null, 1) + '\n');

/** One writer per person's folder: the duplicate check and the memo's first write happen together. */
const folders = new Map<string, Promise<unknown>>();
function inFolder<T>(dir: string, work: () => Promise<T>): Promise<T> {
  const run = (folders.get(dir) ?? Promise.resolve()).then(work);
  folders.set(dir, run.catch(() => {}));
  return run;
}

class TooLarge extends Error {}

/** Takes one text memo: valid UTF-8 with words, at most MAX_TEXT_BYTES, its sha256 checked when the sender gives one. */
export async function ingestText(deps: Pick<Deps, 'config' | 'now'>, person: PersonConfig, device: string,
  head: { id: string; recordedAt: number; sha256: string | null }, body: Uint8Array): Promise<Ingest> {
  if (body.byteLength > MAX_TEXT_BYTES) fail('invalid_input', `after_hours_too_large: a text memo is at most ${MAX_TEXT_BYTES / 1024} KiB`);
  const sha256 = createHash('sha256').update(body).digest('hex');
  if (head.sha256 !== null && head.sha256 !== sha256) fail('invalid_input', `after_hours_checksum: received ${body.byteLength} bytes with sha256 ${sha256}, not the x-content-sha256 sent; send it again`);
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(body).trim(); } catch { return fail('invalid_input', 'after_hours_text: the body must be UTF-8 text'); }
  if (!text) fail('invalid_input', 'after_hours_empty: the memo has no words');
  const dir = await ownedDir(person, hostFolder(person, deps.config.channel, 'after-hours'));
  return inFolder(dir, async () => {
    const existing = await readMemo(dir, head.id);
    if (existing) {
      if (existing.sha256 !== sha256) fail('conflict', `after_hours_id_taken: memo ${head.id} is already kept with other content`);
      return { status: 'duplicate', memo: existing };
    }
    await writeOwned(person, join(dir, `${head.id}.txt`), text + '\n');
    const memo: Memo = { id: head.id, device, recordedAt: head.recordedAt, receivedAt: deps.now(), bytes: body.byteLength, sha256, type: 'text/plain', text, messageId: null, kenaznia: { kind: 'pending' } };
    await saveMemo(person, dir, memo);
    await syncDir(dir);
    return { status: 'stored', memo };
  });
}

/** Takes one upload: streams it to a temporary file, checks its size and sha256, and keeps it under its id once. */
export async function ingest(deps: Pick<Deps, 'config' | 'now'>, person: PersonConfig, device: string,
  head: { id: string; type: AudioType; recordedAt: number; sha256: string }, body: WebReadableStream<Uint8Array>): Promise<Ingest> {
  const dir = await ownedDir(person, hostFolder(person, deps.config.channel, 'after-hours'));
  const temp = join(dir, `.incoming-${head.id}-${randomUUID()}`);
  const hash = createHash('sha256');
  let bytes = 0;
  try {
    await pipeline(Readable.fromWeb(body), new Transform({ transform(chunk: Buffer, _encoding, done) {
      bytes += chunk.length;
      if (bytes > MAX_BYTES) { done(new TooLarge()); return; }
      hash.update(chunk); done(null, chunk);
    } }), createWriteStream(temp, { mode: 0o600 }));
  } catch (e) {
    await rm(temp, { force: true });
    if (e instanceof TooLarge) fail('invalid_input', `after_hours_too_large: a memo is at most ${MAX_BYTES / 1024 / 1024} MiB`);
    throw e;
  }
  const sha256 = hash.digest('hex');
  if (bytes === 0 || sha256 !== head.sha256) {
    await rm(temp, { force: true });
    fail('invalid_input', bytes === 0 ? 'after_hours_empty: the body is empty' : `after_hours_checksum: received ${bytes} bytes with sha256 ${sha256}, not the x-content-sha256 sent; the upload was cut or changed, send it again`);
  }
  const handle = await open(temp, 'r+');
  try { await handle.sync(); await handle.chown(person.uid, person.gid); } finally { await handle.close(); }
  return inFolder(dir, async () => {
    const existing = await readMemo(dir, head.id);
    if (existing) {
      await rm(temp, { force: true });
      if (existing.sha256 !== sha256) fail('conflict', `after_hours_id_taken: memo ${head.id} is already kept with other content`);
      return { status: 'duplicate', memo: existing };
    }
    const audio = `${head.id}.${AUDIO[head.type]}`;
    await rename(temp, join(dir, audio));
    const memo: Memo = { id: head.id, device, recordedAt: head.recordedAt, receivedAt: deps.now(), bytes, sha256, type: head.type, audio, transcript: { kind: 'pending' }, messageId: null, kenaznia: { kind: 'pending' } };
    await saveMemo(person, dir, memo);
    await syncDir(dir);
    return { status: 'stored', memo };
  });
}

/** The recording as 16 kHz mono PCM. The cache protocol makes the inherited input seekable even on FFmpeg 5.1,
 *  which has no fd: protocol. Its read-ahead bound is the upload limit: an .m4a index may sit at the end.
 *  The child still runs as nobody and never opens the person's folder. FFmpeg removes its temporary cache on exit. */
export async function decodeFile(path: string): Promise<{ ok: true; samples: Int16Array } | { ok: false; error: string }> {
  const file = await open(path, 'r');
  try {
    const asRoot = process.getuid?.() === 0;
    const child = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-read_ahead_limit', String(MAX_BYTES), '-i', 'cache:pipe:0', '-ac', '1', '-ar', String(SAMPLE_RATE), '-t', String(MAX_AUDIO_SECONDS), '-f', 's16le', 'pipe:1'], {
      stdio: [file.fd, 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin', HOME: '/nonexistent' }, ...(asRoot ? { uid: NOBODY, gid: NOBODY } : {}),
    });
    const out: Buffer[] = []; let log = '';
    child.stdout!.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr!.on('data', (chunk: Buffer) => { log = (log + chunk.toString()).slice(-600); });
    const timer = setTimeout(() => child.kill('SIGKILL'), DECODE_MS);
    const ended = await new Promise<string | null>(resolve => {
      child.once('error', e => resolve(String(e)));
      child.once('close', (code, signal) => resolve(code === 0 ? null : `ffmpeg exited (${signal ?? code}): ${log.trim().split('\n').slice(-2).join(' | ')}`));
    });
    clearTimeout(timer);
    if (ended !== null) return { ok: false, error: `The recording could not be read: ${ended}` };
    const pcm = Buffer.concat(out);
    return { ok: true, samples: new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.byteLength / 2)) };
  } finally { await file.close(); }
}

/** Where to end a piece that starts at `from`: the quietest 20 ms in the CUT_SEARCH_SECONDS before PIECE_SECONDS. */
export function pieceEnd(samples: Int16Array, from: number): number {
  const limit = from + PIECE_SECONDS * SAMPLE_RATE;
  if (limit >= samples.length) return samples.length;
  const frame = SAMPLE_RATE / 50;
  let best = limit, quietest = Infinity;
  for (let at = limit - CUT_SEARCH_SECONDS * SAMPLE_RATE; at + frame <= limit; at += frame) {
    let energy = 0;
    for (let i = at; i < at + frame; i++) energy += samples[i]! * samples[i]!;
    if (energy < quietest) { quietest = energy; best = at + frame / 2; }
  }
  return best;
}

async function transcribeMemo(person: PersonConfig, path: string): Promise<Transcript> {
  const decoded = await decodeFile(path);
  if (!decoded.ok) return { kind: 'failed', error: decoded.error };
  const { samples } = decoded, texts: string[] = [];
  for (let from = 0; from < samples.length;) {
    const to = pieceEnd(samples, from);
    const piece = samples.slice(from, to);
    const heard = await transcribeWav(person, wavOf(new Uint8Array(piece.buffer)));
    if (!heard.ok) return { kind: 'failed', error: heard.error.message };
    if (heard.value.text) texts.push(heard.value.text);
    from = to;
  }
  return { kind: 'done', text: texts.join(' '), seconds: Math.round(samples.length / SAMPLE_RATE) };
}

const duration = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
const clock = (at: number, zone: string) => clockIn(at, zone).replace(/, .*$/, '');
const heardLine = (memo: Memo) => {
  if (memo.type === 'text/plain') return memo.text;
  const t = memo.transcript;
  switch (t.kind) {
    case 'done': return t.text || '(no words heard)';
    case 'failed': return `(not written down: ${t.error})`;
    case 'pending': return '(not written down yet)';
  }
};

/** His 🌙 After Hours chat on this channel (its id kept in the memo folder): made the first time, reopened if he closed it. */
async function chatFor(deps: Deps, person: PersonConfig, dir: string): Promise<ConversationSummary> {
  const statePath = join(dir, 'chat.json');
  const saved = await readFile(statePath, 'utf8').then(t => (JSON.parse(t) as { conversationId: string }).conversationId, e => (e as NodeJS.ErrnoException).code === 'ENOENT' ? null : Promise.reject(e));
  const existing = saved ? await deps.store.getConversation(saved, person.id) : null;
  if (existing) return existing.archived ? deps.store.updateConversation(existing.id, person.id, { archived: false }) : existing;
  const manager = deps.runtime.managerFor(person.id);
  const created = await deps.store.createConversation({ title: 'After Hours', ownerId: person.id, memberIds: [person.id, ...(manager ? [manager] : [])] });
  const room = await deps.store.updateConversation(created.id, person.id, { titleLocked: true, emoji: '🌙' });
  await writeOwned(person, statePath, JSON.stringify({ conversationId: room.id }) + '\n');
  return room;
}

/** Posts the memo as his own message (audio and the words) into the After Hours chat. No agent is told: that is the handover's job. */
async function post(deps: Deps, person: PersonConfig, dir: string, memo: Memo, zone: string): Promise<string> {
  const clientId = `after-hours:${memo.id}`;
  const prior = await deps.store.getMessageByClientId(clientId);
  if (prior) return prior.id;
  const room = await chatFor(deps, person, dir);
  const message = memo.type === 'text/plain'
    ? await deps.store.appendMessage({ conversationId: room.id, authorId: person.id, role: 'human', clientId, text: `⌚ ${clock(memo.recordedAt, zone)}\n\n${memo.text}` })
    : await (async () => {
      const name = `After Hours ${clockIn(memo.recordedAt, zone).replace(/^\S+ /, '').replace(/, .*$/, '').replace(':', '.')}.${AUDIO[memo.type]}`;
      const file = await saveFile(deps, person.id, name, memo.type, await readFile(join(dir, memo.audio)));
      const length = memo.transcript.kind === 'done' ? ` · ${duration(memo.transcript.seconds)}` : '';
      return deps.store.appendMessage({
        conversationId: room.id, authorId: person.id, role: 'human', clientId,
        text: `🎙️ ${clock(memo.recordedAt, zone)}${length}\n\n${heardLine(memo)}`, parts: [filePart(file)],
      });
    })();
  deps.bus.toConversation(room.id, { type: 'message', message });
  const summary = await deps.store.getConversation(room.id, person.id);
  if (summary) deps.bus.toPerson(person.id, { type: 'conversation', conversation: summary });
  return message.id;
}

export function wakeText(person: Pick<PersonConfig, 'name'>, memo: Memo, dir: string, zone: string, quiet: AfterHoursConfig['quietHours']): string {
  const heard = heardLine(memo);
  const text = heard.length > WAKE_TRANSCRIPT_CHARS ? `${heard.slice(0, WAKE_TRANSCRIPT_CHARS)}… (cut; the whole text is in ${join(dir, `${memo.id}.txt`)})` : heard;
  const how = memo.type === 'text/plain' ? ', dictated to Siri' : memo.transcript.kind === 'done' ? `, ${duration(memo.transcript.seconds)} long` : '';
  return `After Hours memo from ${person.name}'s Apple Watch, recorded ${clockIn(memo.recordedAt, zone)}${how}. `
    + `The watch app is one-way: he never sees replies there${quiet ? `, and he uses no electronics ${quiet.from}–${quiet.until}, so this reached you only now that those hours are over; never message or notify him about memos during them` : ''}.\n`
    + `What he said:\n${text}\n\n`
    + `${memo.type === 'text/plain' ? `Text: ${join(dir, `${memo.id}.txt`)}` : `Audio: ${join(dir, memo.audio)}`}; the memo is also in his 🌙 After Hours chat. File it as what it is (an idea for a goal or its notes, a to-do, a fact for his memory files), `
    + 'then tell him in one short message what you filed and where. Several memos may arrive together: answer them in one message.';
}

/** Gives the memo to his Kenaznia as a clock wake at the end of his quiet hours; null while the manager isn't running yet. */
async function handOver(deps: Deps, person: PersonConfig, dir: string, memo: Memo, zone: string): Promise<Handover | null> {
  if (!hostedManager(person)) return { kind: 'not_hosted' };
  const manager = deps.runtime.managerFor(person.id);
  if (!manager) return null;
  const quiet = person.afterHours!.quietHours;
  const at = handoverAt(deps.now(), zone, quiet);
  const wake = await deps.store.createWake({
    agentId: manager, ownerId: person.id, originConversationId: null, message: wakeText(person, memo, dir, zone, quiet),
    trigger: { at, event: null, listen: { kind: 'clock', reason: `${person.name}'s After Hours memos wait for the end of his quiet hours` } },
  });
  return { kind: 'scheduled', wakeId: wake.id, at };
}

/** Moves one kept memo through its remaining steps, saving after each, so a restart resumes where it stopped. */
async function advance(deps: Deps, person: PersonConfig, dir: string, start: Memo): Promise<void> {
  let memo = start;
  const zone = zoneOrHome(await deps.store.zoneOf(person.id));
  if (memo.type !== 'text/plain' && memo.transcript.kind === 'pending') {
    const transcript = await transcribeMemo(person, join(dir, memo.audio));
    memo = { ...memo, transcript };
    if (transcript.kind === 'done') await writeOwned(person, join(dir, `${memo.id}.txt`), transcript.text + '\n');
    await saveMemo(person, dir, memo);
  }
  if (memo.messageId === null) {
    memo = { ...memo, messageId: await post(deps, person, dir, memo, zone) };
    await saveMemo(person, dir, memo);
  }
  if (memo.kenaznia.kind === 'pending') {
    const handover = await handOver(deps, person, dir, memo, zone);
    if (handover) { memo = { ...memo, kenaznia: handover }; await saveMemo(person, dir, memo); }
  }
  console.log(JSON.stringify({ type: 'after_hours', person: person.id, memo: memo.id, bytes: memo.bytes, transcript: memo.type === 'text/plain' ? 'text' : memo.transcript.kind, posted: memo.messageId !== null, kenaznia: memo.kenaznia.kind }));
}

const unfinished = (m: Memo) => (m.type !== 'text/plain' && m.transcript.kind === 'pending') || m.messageId === null || m.kenaznia.kind === 'pending';

/** One memo at a time on this channel (the engines are shared with dictation); each id is queued once. */
export function createAfterHours() {
  let queue: Promise<void> = Promise.resolve();
  const queued = new Set<string>();
  let timer: NodeJS.Timeout | null = null;
  let current: Deps | null = null;
  const enqueue = (deps: Deps, person: PersonConfig, memo: Memo) => {
    if (queued.has(memo.id)) return;
    queued.add(memo.id);
    const dir = hostFolder(person, deps.config.channel, 'after-hours');
    queue = queue.then(async () => {
      const fresh = await readMemo(dir, memo.id);
      if (fresh && unfinished(fresh)) await advance(deps, person, dir, fresh);
    }).catch(e => {
      console.error(JSON.stringify({ type: 'error', scope: 'after_hours', memo: memo.id, error: String((e as Error)?.stack ?? e) }));
      return deps.store.logError('after_hours', `memo ${memo.id}: ${String((e as Error)?.message ?? e)}`).catch(() => {});
    }).finally(() => { queued.delete(memo.id); });
  };
  const sweep = async (deps: Deps) => {
    for (const person of deps.config.people) {
      if (!person.extensions.includes('after-hours')) continue;
      const dir = hostFolder(person, deps.config.channel, 'after-hours');
      const names = await readdir(dir).catch(e => (e as NodeJS.ErrnoException).code === 'ENOENT' ? [] : Promise.reject(e));
      for (const name of names) {
        const id = name.match(/^([0-9a-f-]{36})\.json$/)?.[1];
        const memo = id ? await readMemo(dir, id) : null;
        if (memo && unfinished(memo)) enqueue(deps, person, memo);
      }
    }
  };
  const extension: Extension = {
    id: 'after-hours', name: 'After Hours',
    hooks(app, deps) {
      app.post('/memos/:id', async c => {
        const found = deviceFor(deps.config.people, c.req.header('authorization'), p => p.afterHours?.devices);
        if (!found) return fail('unauthenticated', 'after_hours_token: send the device\'s token as Authorization: Bearer TOKEN');
        const id = c.req.param('id').toLowerCase();
        if (!UUID.test(id)) return fail('invalid_input', 'after_hours_id: the memo id in the path must be a UUID');
        const type = memoType(c.req.header('content-type'));
        const recordedAt = recordedAtOf(c.req.header('x-recorded-at'));
        const given = c.req.header('x-content-sha256')?.trim().toLowerCase();
        if (given !== undefined && !/^[0-9a-f]{64}$/.test(given)) return fail('invalid_input', 'after_hours_checksum: x-content-sha256 must be the body\'s sha256 in hex');
        const body = c.req.raw.body ?? fail('invalid_input', 'after_hours_empty: the body is empty');
        const result = type === 'text/plain'
          ? await ingestText(deps, found.person, found.device.id, { id, recordedAt, sha256: given ?? null }, new Uint8Array(await c.req.arrayBuffer()))
          : await ingest(deps, found.person, found.device.id, { id, type, recordedAt, sha256: given ?? fail('invalid_input', 'after_hours_checksum: audio needs x-content-sha256, the body\'s sha256 in hex') }, body as unknown as WebReadableStream<Uint8Array>);
        console.log(JSON.stringify({ type: 'after_hours_ingest', person: found.person.id, device: found.device.id, memo: id, status: result.status, bytes: result.memo.bytes }));
        if (result.status === 'stored') enqueue(deps, found.person, result.memo);
        return c.json({ ok: true, value: { id, status: result.status, bytes: result.memo.bytes, sha256: result.memo.sha256 } });
      });
    },
    async start(deps) {
      if (!deps.config.people.some(p => p.extensions.includes('after-hours'))) return;
      current = deps;
      const run = () => { if (current) void sweep(current).catch(e => deps.store.logError('after_hours', String(e)).catch(() => {})); };
      run();
      timer = setInterval(run, SWEEP_MS);
      timer.unref();
    },
    async stop() { if (timer) clearInterval(timer); timer = null; current = null; },
  };
  return { extension, sweep, idle: () => queue };
}

export const afterHoursExtension = createAfterHours().extension;
