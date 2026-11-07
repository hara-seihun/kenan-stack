/**
 * Kenan's own Meet notetaker, server side: starts one meeting-joiner process per meeting as its own systemd
 * unit (so it survives restarts), reads what it writes, and asks it to leave. The joiner's files live in
 * stateDir/<sessionId>: request.json (written here), events.jsonl (written by the joiner), control.json
 * (written here to make it leave).
 */
import { execFile } from 'node:child_process';
import { chown, mkdir, open, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { JoinerEvent, JoinerRequest, LeaveReason } from './meeting-joiner.js';
import type { JoinerVoice } from './meeting-joiner-voice.js';

const run = promisify(execFile);

/**
 * tools.meeting.native: every field is required.
 * user/uid/gid: the account the browser runs as. profile: a signed-in Chrome user-data directory that account
 * can read, or null to join signed out (Meet asks for displayName and the host must let it in).
 * announcement: posted in the meeting chat on entry; it must say a notetaker is taking notes and how to make it leave.
 * cloudProfile (optional): a Browser Use Cloud profile (deploy/cloud-browser) that holds the signed-in Google session;
 * the joiner then runs Chrome there (US residential egress) instead of locally, and profile is unused. A host whose own
 * address is a datacenter needs it: Google challenges a sign-in there and revokes a session copied in from elsewhere.
 */
export interface NativeSettings {
  uid: number; gid: number; chrome: string; profile: string | null;
  displayName: string; announcement: string; stateDir: string; cloudProfile?: string;
  /** Concurrent native notetakers autojoin may run; beyond it, autojoin sends Recall. */
  maxConcurrent: number;
}
export const DEFAULT_NATIVE_MAX_CONCURRENT = 4;
export type NativeSettingsResult = { ok: true; value: NativeSettings } | { ok: false; error: string };
export function nativeSettings(raw: unknown): NativeSettingsResult {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'tools.meeting.native must be an object' };
  const r = raw as Record<string, unknown>;
  const text = (k: string) => typeof r[k] === 'string' && (r[k] as string).trim().length > 0;
  if (!Number.isSafeInteger(r.uid) || (r.uid as number) <= 0) return { ok: false, error: 'tools.meeting.native.uid must be a non-root uid' };
  if (!Number.isSafeInteger(r.gid) || (r.gid as number) <= 0) return { ok: false, error: 'tools.meeting.native.gid must be a non-root gid' };
  for (const k of ['chrome', 'stateDir', 'displayName', 'announcement']) if (!text(k)) return { ok: false, error: `tools.meeting.native.${k} must be set` };
  if (!(r.profile === null || text('profile'))) return { ok: false, error: 'tools.meeting.native.profile must be a Chrome profile directory or null (signed out)' };
  if (!/notetaker|taking notes|transcri/i.test(r.announcement as string)) return { ok: false, error: 'tools.meeting.native.announcement must say a notetaker is taking notes' };
  if (r.cloudProfile !== undefined && !text('cloudProfile')) return { ok: false, error: 'tools.meeting.native.cloudProfile must be a Browser Use profile name when set' };
  if (r.maxConcurrent !== undefined && (!Number.isSafeInteger(r.maxConcurrent) || (r.maxConcurrent as number) < 1)) return { ok: false, error: 'tools.meeting.native.maxConcurrent must be a positive integer when set' };
  return { ok: true, value: { uid: r.uid as number, gid: r.gid as number, chrome: r.chrome as string, profile: r.profile as string | null,
    displayName: r.displayName as string, announcement: r.announcement as string, stateDir: r.stateDir as string, ...(r.cloudProfile !== undefined ? { cloudProfile: r.cloudProfile as string } : {}),
    maxConcurrent: (r.maxConcurrent as number | undefined) ?? DEFAULT_NATIVE_MAX_CONCURRENT } };
}

export const ALONE_GRACE_MS = 120_000;
/** How long a knock waits for someone to let the notetaker in, past the meeting's start. */
export const LOBBY_WAIT_MS = 15 * 60_000;
/** The notetaker opens the meeting this long before its scheduled start; earlier, Meet may end the empty call under it. */
export const ENTER_BEFORE_START_MS = 90_000;

export const joinerUnit = (channel: string, sessionId: string) => `kenan-meet-${channel}-${sessionId.slice(0, 16)}`;
const joinerScript = join(dirname(fileURLToPath(import.meta.url)), 'meeting-joiner.js');
export const sessionDir = (settings: NativeSettings, sessionId: string) => join(settings.stateDir, sessionId);

export type StartResult = { kind: 'started' } | { kind: 'already-started' };
/**
 * Starts the joiner for a session. The unit name is derived from the session id, so systemd itself refuses a
 * second joiner for the same session; that refusal is reported as already-started.
 */
export async function startJoiner(settings: NativeSettings, channel: string, input: { sessionId: string; meetingUrl: string; startAt: number; endsAt: number; capAt: number; now: number; voice?: JoinerVoice }): Promise<StartResult> {
  const dir = sessionDir(settings, input.sessionId);
  await mkdir(settings.stateDir, { recursive: true, mode: 0o750 });
  await chown(settings.stateDir, 0, settings.gid);
  await mkdir(dir, { recursive: true, mode: 0o750 });
  await chown(dir, settings.uid, settings.gid);
  const request: JoinerRequest = { sessionId: input.sessionId, meetingUrl: input.meetingUrl, displayName: settings.displayName, announcement: settings.announcement,
    chrome: settings.chrome, profile: settings.profile, ...(settings.cloudProfile ? { cloudProfile: settings.cloudProfile } : {}), admitUntil: Math.max(input.now, input.startAt) + LOBBY_WAIT_MS, capAt: input.capAt, aloneGraceMs: ALONE_GRACE_MS,
    enterAt: input.startAt - ENTER_BEFORE_START_MS, ...(input.voice ? { voice: input.voice } : {}) };
  const temporary = join(dir, `request.json.${process.pid}.tmp`);
  await writeFile(temporary, JSON.stringify(request), { mode: 0o640 });
  await chown(temporary, settings.uid, settings.gid);
  await rename(temporary, join(dir, 'request.json'));
  try {
    await run('systemd-run', ['--quiet', '--collect', '--expand-environment=no', `--unit=${joinerUnit(channel, input.sessionId)}`, `--uid=${settings.uid}`, `--gid=${settings.gid}`,
      `--property=WorkingDirectory=${dir}`, '--property=TimeoutStopSec=30s', '--property=MemoryMax=4G', `--description=Kenan notetaker ${input.meetingUrl}`,
      `--setenv=HOME=${dir}`, process.execPath, joinerScript, dir], { timeout: 30_000 });
    return { kind: 'started' };
  } catch (error) {
    const text = String((error as { stderr?: string }).stderr ?? (error as Error).message);
    if (/already (exists|loaded|active)|Unit .* was already loaded|File exists/i.test(text)) return { kind: 'already-started' };
    throw new Error(`Couldn't start the notetaker: ${text.trim().slice(0, 300)}`);
  }
}

export type UnitState = 'active' | 'gone';
export async function joinerUnitState(channel: string, sessionId: string): Promise<UnitState> {
  const unit = `${joinerUnit(channel, sessionId)}.service`;
  try { const { stdout } = await run('systemctl', ['is-active', unit], { timeout: 10_000 }); return /^(active|activating|deactivating|reloading)/.test(stdout.trim()) ? 'active' : 'gone'; }
  catch (error) { const out = String((error as { stdout?: string }).stdout ?? '').trim(); return /^(active|activating|deactivating|reloading)/.test(out) ? 'active' : 'gone'; }
}

/** Stops a joiner's unit without waiting (SIGTERM, then SIGKILL after its 30 s TimeoutStopSec); a unit already gone is fine. */
export async function stopJoiner(channel: string, sessionId: string): Promise<void> {
  try { await run('systemctl', ['stop', '--no-block', `${joinerUnit(channel, sessionId)}.service`], { timeout: 10_000 }); }
  catch (error) { if (!/not loaded|not found/i.test(String((error as { stderr?: string }).stderr ?? ''))) throw error; }
}

/** Events written since byte offset `from`; a partly written last line is left for the next read. */
export async function readJoinerEvents(settings: NativeSettings, sessionId: string, from: number): Promise<{ events: JoinerEvent[]; offset: number; started: boolean }> {
  let file;
  try { file = await open(join(sessionDir(settings, sessionId), 'events.jsonl'), 'r'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { events: [], offset: from, started: false }; throw error; }
  try {
    const { size } = await file.stat();
    if (size <= from) return { events: [], offset: from, started: true };
    const buffer = Buffer.alloc(size - from);
    await file.read(buffer, 0, buffer.length, from);
    const text = buffer.toString('utf8');
    const end = text.lastIndexOf('\n');
    if (end < 0) return { events: [], offset: from, started: true };
    const events = text.slice(0, end).split('\n').filter(Boolean).map(line => JSON.parse(line) as JoinerEvent);
    return { events, offset: from + Buffer.byteLength(text.slice(0, end + 1), 'utf8'), started: true };
  } finally { await file.close(); }
}

export async function askJoinerToLeave(settings: NativeSettings, sessionId: string, reason: string): Promise<void> {
  const dir = sessionDir(settings, sessionId);
  const temporary = join(dir, `control.json.${process.pid}.tmp`);
  await writeFile(temporary, JSON.stringify({ leave: reason }), { mode: 0o640 });
  await chown(temporary, settings.uid, settings.gid);
  await rename(temporary, join(dir, 'control.json'));
}

/** What a session's event log adds up to, folded from its start. */
export interface JoinerSummary {
  state: 'starting' | 'prejoin' | 'lobby' | 'entered' | 'left';
  enteredAt: number | null; leftAt: number | null; reason: LeaveReason | null; detail: string | null;
  participants: string[]; everyone: string[]; announced: boolean | null; captions: boolean | null;
}
export const emptySummary = (): JoinerSummary => ({ state: 'starting', enteredAt: null, leftAt: null, reason: null, detail: null, participants: [], everyone: [], announced: null, captions: null });
export function foldJoinerEvents(summary: JoinerSummary, events: JoinerEvent[]): JoinerSummary {
  let s = summary;
  for (const e of events) {
    switch (e.kind) {
      case 'state':
        if (s.state === 'left') break;
        s = e.state === 'left' ? { ...s, state: 'left', leftAt: e.at, reason: e.reason, detail: e.detail }
          : { ...s, state: e.state, ...(e.state === 'entered' && s.enteredAt === null ? { enteredAt: e.at } : {}) };
        break;
      case 'participants': s = { ...s, participants: e.names, everyone: [...new Set([...s.everyone, ...e.names.filter(Boolean)])] }; break;
      case 'announced': s = { ...s, announced: e.ok }; break;
      case 'captions': s = { ...s, captions: e.ok }; break;
      case 'caption': case 'chat': case 'page': case 'voice': break;
    }
  }
  return s;
}
/** The provider state the meeting extension tracks: lobby/entered/left, or unknown before the joiner reaches the meeting. */
export function joinerProviderState(summary: JoinerSummary): 'lobby' | 'entered' | 'left' | 'unknown' {
  switch (summary.state) {
    case 'lobby': return 'lobby';
    case 'entered': return 'entered';
    case 'left': return 'left';
    case 'starting': case 'prejoin': return 'unknown';
  }
}

/** The name Meet shows for the native notetaker: the Google name of the signed-in work account person25@example.com. */
export const NATIVE_MEET_NAME = 'Kenan Agent';

export const LEAVE_REASON_TEXT: Record<LeaveReason, string> = {
  alone: 'everyone else had left', ended: 'the call ended', removed: 'it was removed from the call', asked: 'someone asked it to leave',
  control: 'Kenan asked it to leave', cap: 'it reached the 3-hour limit past the scheduled end', 'not-admitted': 'nobody let it in',
  denied: 'Google Meet refused it', failed: 'it failed',
};

type CaptionEvent = Extract<JoinerEvent, { kind: 'caption' }>;
const captionWords = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}'\s]/gu, ' ').split(/\s+/).filter(Boolean).join(' ');
const pairsOf = (words: string) => { const w = words.split(' '); return new Set(w.slice(1).map((x, i) => `${w[i]} ${x}`)); };
/** Share of word pairs two captions have in common, relative to the shorter: Meet's rewrites of one sentence score high. */
const pairShare = (a: Set<string>, b: Set<string>) => (!a.size || !b.size ? 0 : [...b].filter(p => a.has(p)).length / Math.min(a.size, b.size));
/**
 * Final captions without the copies a joiner wrote of a block Meet kept on screen (November 4, Alice / Taylor Sync: 11,051
 * lines for 46 minutes, the same sentences again every second and again minutes later). A sentence of six words or more
 * that a caption by the same speaker already holds (the same words, inside it, or a rewrite sharing 80% of its word
 * pairs) is a copy anywhere in the meeting, and the fuller of the two is kept. Shorter ones are copies only within a
 * minute (under four words, ten seconds) of the latest copy seen, since people do say "Yeah." again.
 */
export function dedupeCaptions(events: CaptionEvent[], windowMs = 60_000): CaptionEvent[] {
  type Kept = CaptionEvent & { words: string; pairs: Set<string>; seen: number; dropped?: true };
  const kept: Kept[] = [];
  for (const e of [...events].sort((a, b) => a.at - b.at)) {
    const words = captionWords(e.text);
    if (!words) continue;
    const count = words.split(' ').length, pairs = pairsOf(words);
    const window = count >= 6 ? Infinity : count >= 4 ? windowMs : 10_000;
    const same = kept.find(k => !k.dropped && k.speaker === e.speaker && e.at - k.seen < window
      && (k.words === words || (count >= 4 && k.words.includes(words)) || (count >= 6 && pairShare(k.pairs, pairs) >= 0.8 && k.words.length >= words.length)));
    if (same) { same.seen = e.at; continue; }
    // A fuller version of an earlier long caption replaces it, in its place in time.
    const fuller = count >= 6 ? kept.find(k => !k.dropped && k.speaker === e.speaker && k.words.split(' ').length >= 4 && (words.includes(k.words) || pairShare(pairs, k.pairs) >= 0.8)) : undefined;
    if (fuller) { fuller.dropped = true; kept.push({ ...e, startedAt: Math.min(e.startedAt, fuller.startedAt), words, pairs, seen: e.at }); continue; }
    kept.push({ ...e, words, pairs, seen: e.at });
  }
  return kept.filter(k => !k.dropped).map(({ words: _w, pairs: _p, seen: _s, dropped: _d, ...e }) => e);
}

/** The meeting's transcript as plain text, one line per final caption, in the order spoken. */
export async function transcriptOf(settings: NativeSettings, sessionId: string): Promise<{ lines: string[]; chat: string[] }> {
  const { events } = await readJoinerEvents(settings, sessionId, 0);
  const time = (at: number) => new Date(at).toISOString().slice(11, 19);
  const lines = dedupeCaptions(events.filter((e): e is CaptionEvent => e.kind === 'caption')).sort((a, b) => a.startedAt - b.startedAt)
    .map(e => `[${time(e.startedAt)}] ${e.speaker ?? 'Unknown'}: ${e.text}`);
  const chat = events.filter((e): e is Extract<JoinerEvent, { kind: 'chat' }> => e.kind === 'chat').map(e => `[${time(e.at)}] ${e.from ?? 'Unknown'} (chat): ${e.text}`);
  return { lines, chat };
}
export async function writeTranscript(settings: NativeSettings, sessionId: string, header: string): Promise<{ path: string; lines: number; text: string }> {
  const { lines, chat } = await transcriptOf(settings, sessionId);
  const text = `${header}\n\n${lines.join('\n')}${chat.length ? `\n\nChat:\n${chat.join('\n')}` : ''}\n`;
  const path = join(sessionDir(settings, sessionId), 'transcript.txt');
  await writeFile(path, text, { mode: 0o640 });
  return { path, lines: lines.length, text };
}
