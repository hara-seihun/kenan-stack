// One outbound call's media bridge, run as its own systemd unit (kenan-call-<id>) so it outlives Kenan restarts.
// Usage: node phone-bridge.js /etc/kenan/<channel>.json <call id>
// GPT Live (WebRTC) <-> this process <-> Retell's live-call gateway (WebRTC); Opus RTP is relayed without transcoding,
// each packet forwarded the moment it arrives. GPT Live decides when to speak; the bridge only watches an outbound line
// (phone-voicemail.ts) for a person waiting in silence and for a recording mailbox, because GPT Live does not take either
// as its turn: the callee's first hello usually comes before the bridge joins, and a voicemail beep is not speech. On
// every call it also tells GPT when it was cut off mid-sentence or is asked again what it just answered
// (phone-hearing.ts), and records both sides of the line where Kenan's own consent suffices (phone-recording.ts).
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import OpusScript from 'opusscript';
import { MediaStreamTrack, RTCPeerConnection, RTCRtpCodecParameters, RtpHeader, RtpPacket, type RTCDataChannel } from 'werift';
import { loadConfig } from '../config.js';
import { briefLanguage, describe, findProviderCall, liveClient, liveConfig, mediaSettings, phoneInstructions, retell, telephoneConfig, voiceConfig, type PhoneRow } from './phone.js';
import { dtmfFrames, parseDigits, type Digits } from './phone-dtmf.js';
import { MenuWatch, briefKeys } from './phone-menu.js';
import { FRAME, LEAVE_MESSAGE, LineWatch, MessageShield, RATE, greetNow, type Cue } from './phone-voicemail.js';
import { HearingWatch, REPLY_HOLD_MS, goodbyeHangUp, hearingNote, type Timed } from './phone-hearing.js';
import { CallRecording, RECORDING_RATE, recordingConsent, recordingDirectory } from './phone-recording.js';
import { callEvent, callLogDirectory } from './phone-log.js';

type Grant = { access_token: string; participant_id: string; transport?: string; ice_servers?: { urls: string | string[]; username?: string; credential?: string }[] };
type ProviderCall = { call_status: string; disconnection_reason?: string; transcript_object?: { role: string; content: string }[] };

const [configPath, callId] = process.argv.slice(2);
if (!configPath || !callId) throw new Error('usage: phone-bridge.js <config.json> <call id>');
const config = loadConfig(configPath);
const db = new pg.Pool({ connectionString: config.databaseUrl, max: 1 });
const row = (await db.query<PhoneRow>('SELECT * FROM kenan_phone_call WHERE id=$1', [callId])).rows[0];
if (!row) throw new Error(`Call ${callId} not found`);
const direction = row.direction, language = briefLanguage(row.brief);
const person = config.people.find(p => p.id === row.owner_id);
if (!person) throw new Error(`Owner ${row.owner_id} not configured`);
const media = mediaSettings(person);
const telephone = telephoneConfig(media.telephone);
if (telephone.kind !== 'configured') throw new Error(`Telephone unavailable: ${telephone.factor}`);
const liveSettings = liveConfig(media.live), voice = voiceConfig(media.voice);
const retellKey = readFileSync(telephone.apiKeyPath, 'utf8').trim();
const logDir = callLogDirectory(config.dataDir, Date.now());
const codecs = { audio: [new RTCRtpCodecParameters({ mimeType: 'audio/opus', clockRate: 48000, channels: 2 })] };

let transcript = row.transcript, flushed = transcript, speaker = '', ending: Promise<void> | null = null;
// Hang-up: once Kenan has said goodbye, its voice has stopped and no reply is still being written (goodbyeHangUp), end
// the call. Two-way silence ends it only after 10 minutes, because hold queues are silent. Speech activity comes from
// GPT Live's transcripts, Kenan's voice from its audio, pending replies from the row's pending_replies (kept by the server).
const GOODBYE = /\b(good-?bye|bye|au revoir|bonne (journée|soirée|fin de semaine))\b/i;
const SILENCE_LIMIT_MS = 10 * 60_000;
let lastSpeech = Date.now(), goodbyeAt: number | null = null, bridged = false, lastKenanVoice = 0, pendingReplies = 0;
// Turn latency on GPT Live's own timeline: from the end of the caller's last transcribed audio to the start of Kenan's reply.
let personEndMs: number | null = null;
type Delta = { delta?: string; start_ms?: number; end_ms?: number };
const hearing = new HearingWatch();
let untimed = false, lineClosed = false, lastKenanAt: number | null = null, unheardKenan = 0;
const timed = (event: Delta): Timed | null => {
  if (typeof event.start_ms === 'number' && typeof event.end_ms === 'number') return { delta: event.delta ?? '', startMs: event.start_ms, endMs: event.end_ms };
  if (!untimed) { untimed = true; log('transcript-untimed', { event }); }
  return null;
};
const say = (who: 'Person' | 'Kenan', event: Delta) => {
  const delta = event.delta ?? '';
  // After the phone line has closed, GPT's words reach nobody; the person's last words are still being transcribed.
  if (who === 'Kenan' && lineClosed) { unheardKenan++; return; }
  if (who === 'Person' && typeof event.end_ms === 'number') personEndMs = event.end_ms;
  if (speaker !== who) {
    if (who === 'Kenan' && personEndMs !== null && typeof event.start_ms === 'number') log('turn', { replyGapMs: event.start_ms - personEndMs, atMs: event.start_ms });
    speaker = who; transcript += `${transcript ? '\n' : ''}${who}:`;
  }
  transcript += delta;
  lastSpeech = Date.now();
  const at = timed(event);
  if (who === 'Person') {
    voicemail?.person(delta);
    const hit = menu?.person(delta);
    if (hit) press(hit.key, hit.why);
    const cue = at && hearing.person(at);
    // Recordings and menus are not people mishearing: no cue while a mailbox records or a key is being pressed.
    if (cue && !lineClosed && !shield.active && keyQueuedAt === null && voicemail?.state !== 'cued') {
      log('hearing', cue);
      send({ type: 'session.thinking.append', content: hearingNote(cue) });
    }
  }
  else { voicemail?.kenan(delta); shield.kenan(Date.now()); lastKenanAt = Date.now(); if (at) hearing.kenan(at); }
  if (who === 'Kenan' && GOODBYE.test(transcript.slice(transcript.lastIndexOf('\n') + 1))) goodbyeAt = Date.now();
  if (who === 'Person' && goodbyeAt !== null && Date.now() - goodbyeAt > 1500 && delta.trim().split(/\s+/).length > 2) goodbyeAt = null;
};
const note = (line: string) => { transcript += `${transcript ? '\n' : ''}[${line}]`; speaker = ''; };
let holdLogged = false;
setInterval(() => {
  if (!bridged || lineClosed) return;
  const now = Date.now();
  const after = goodbyeAt === null ? null : goodbyeHangUp({ now, goodbyeAt, lastSpeech, lastKenanVoice, pendingReplies });
  if (after?.kind === 'end') void end(after.unanswered ? `Kenan said goodbye (a reply was still unanswered ${REPLY_HOLD_MS / 1000} s later)` : 'Kenan said goodbye');
  else if (after?.kind === 'hold') { if (!holdLogged) { holdLogged = true; log('goodbye-hold', { pendingReplies: after.pendingReplies }); } }
  else if (now - lastSpeech > SILENCE_LIMIT_MS) void end('10 minutes of silence on both sides');
}, 250).unref();
let readingPending = false;
setInterval(() => {
  if (!bridged || readingPending) return;
  readingPending = true;
  void db.query<{ pending: number }>('SELECT cardinality(pending_replies) AS pending FROM kenan_phone_call WHERE id=$1', [callId])
    .then(({ rows }) => { pendingReplies = rows[0]?.pending ?? 0; })
    .catch(e => log('pending-error', { error: String(e) }))
    .finally(() => { readingPending = false; });
}, 300).unref();
const closers: (() => void | Promise<void>)[] = [];
const started = performance.now();
const log = (event: string, detail: Record<string, unknown> = {}) => callEvent(logDir, callId, event, { t: Math.round(performance.now() - started), ...detail });
// Per-second voiced 20 ms frames in each direction (Opus silence/DTX frames are a few bytes) and the line's loudest
// decoded frame (dBFS), for duplex diagnosis: whether the callee's audio reached the bridge and whether anyone spoke.
// Recorded only where Kenan's own consent as a party suffices (phone-recording.ts); otherwise nothing is written.
const recordingDir = recordingDirectory(config.dataDir, Date.now());
const consent = recordingConsent(row.to_number);
log('recording', consent);
const recording = consent.kind === 'one-party' ? new CallRecording(join(recordingDir, `${callId}.wav`), Date.now()) : null;
if (recording) {
  closers.push(() => recording.close(Date.now()));
  setInterval(() => recording.flush(Date.now()), 1000).unref();
}
const frames = { fromPhone: 0, fromGpt: 0 };
let lineDb: number | null = null;
const voiced = (payload: Buffer) => payload.length > 20 ? 1 : 0;
/** A decoded frame's loudness in dBFS. */
function frameDb(decoded: Buffer | Int16Array): number {
  const samples = decoded instanceof Int16Array ? decoded : new Int16Array(decoded.buffer.slice(decoded.byteOffset, decoded.byteOffset + (decoded.length & ~1)));
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  return 10 * Math.log10(sum / Math.max(1, samples.length) / (32768 * 32768) + 1e-12);
}
setInterval(() => {
  if (frames.fromPhone || frames.fromGpt) log('voiced', { ...frames, ...(lineDb === null ? {} : { lineDb: Math.round(lineDb) }) });
  frames.fromPhone = frames.fromGpt = 0; lineDb = null;
}, 1000).unref();

// The phone line closed. Retell's gateway names no reason once the call is taken over (call 488e7d78 dropped a minute in
// with only {"type":"status","state":"ended"}), so the end says what the bridge observed: which side last had sound, and
// what the person said last. GPT Live transcribes the person's last words a second or two after them, so the call ends
// only after DRAIN_MS, with the line feeding GPT silence.
const DRAIN_MS = 2500;
async function lineEnded(gatewayReason: string | null): Promise<void> {
  if (lineClosed || ending) return;
  lineClosed = true;
  const now = Date.now();
  const ago = (at: number | null) => at === null ? 'never' : `${((now - at) / 1000).toFixed(1)} s before`;
  const observed = { lineSoundAgoMs: lastLineSound ? now - lastLineSound : null, kenanAgoMs: lastKenanAt === null ? null : now - lastKenanAt };
  log('line-ended', { gatewayReason, ...observed });
  await new Promise(r => setTimeout(r, DRAIN_MS));
  if (unheardKenan) log('unheard-kenan', { deltas: unheardKenan });
  const evidence = `the person's line last carried sound ${ago(lastLineSound || null)}, Kenan last spoke ${ago(lastKenanAt)}`;
  note(`the phone line closed: ${evidence}`);
  await end(gatewayReason ? `telephone ended: ${gatewayReason} (${evidence})` : `the phone network ended the call: the person hung up or their line dropped (Retell's gateway gives no reason after takeover; ${evidence})`);
}

async function end(reason: string): Promise<void> {
  ending ??= (async () => {
    log('end', { reason });
    for (const close of closers.reverse()) await Promise.resolve().then(close).catch(e => log('close-error', { error: String(e) }));
    await db.query('UPDATE kenan_phone_call SET transcript=$2, ended_at=$3, end_reason=$4 WHERE id=$1 AND ended_at IS NULL', [callId, transcript, Date.now(), reason]);
    await db.end();
    process.exit(0);
  })();
  return ending;
}
process.on('SIGTERM', () => void end('hung up by Kenan'));
process.on('uncaughtException', e => void end(`bridge error: ${String(e?.stack ?? e)}`));
process.on('unhandledRejection', e => void end(`bridge error: ${String((e as Error)?.stack ?? e)}`));
setTimeout(() => void end('maximum call duration reached'), telephone.maxCallSeconds * 1000).unref();
setInterval(() => { if (transcript !== flushed) { flushed = transcript; void db.query('UPDATE kenan_phone_call SET transcript=$2 WHERE id=$1', [callId, transcript]); } }, 100).unref();

// Keypad digits are played in-band once the call is ours: those queued by the call agent (voice digits), taken
// atomically, and the menu keys the brief names, pressed when the line announces them (phone-menu.ts), again if the menu
// replays the option. A menu that does not listen while its prompt plays ignores a key sent over it (call 10b48b42), so
// queued keys wait until the line has been quiet for KEY_QUIET_MS, or at most KEY_WAIT_MS. GPT is not heard on the line
// from the moment a key is queued until its tones end, so nothing it says about the key reaches the callee.
const KEY_QUIET_MS = 700, KEY_WAIT_MS = 8000, LINE_SOUND_DB = -45;
let dtmf: Buffer[] = [], takingDigits = false, keyQueuedAt: number | null = null, keyPlaying = false, lastLineSound = 0;
const dtmfEncoder = new OpusScript(48000, 1, OpusScript.Application.AUDIO);
closers.push(() => dtmfEncoder.delete());
const menu = direction === 'outbound' ? new MenuWatch(briefKeys(row.brief)) : null;
/** The key the bridge pressed itself last, so the same key delegated by GPT Live right after is not pressed twice. */
let ownPress: { digits: Digits; atMs: number } | null = null;
const DUPLICATE_MS = 15_000;
function press(digits: Digits, by: 'agent' | 'brief' | 'replay'): void {
  if (by !== 'agent') ownPress = { digits, atMs: Date.now() };
  for (const frame of dtmfFrames(digits, 48000)) dtmf.push(dtmfEncoder.encode(Buffer.from(frame.buffer), frame.length));
  keyQueuedAt ??= Date.now();
  const spoken = digits.replace(/w/g, ' ');
  note(by === 'replay' ? `Kenan pressed ${spoken} on the keypad again: the menu replayed` : `Kenan pressed ${spoken} on the keypad${by === 'brief' ? ' (the brief\'s menu choice)' : ''}`);
  voicemail?.rearm();
  send({ type: 'session.thinking.append', content: `Kenan is pressing ${spoken} on the keypad itself, once the menu has finished speaking. Say nothing about it, and do not ask for this key.` });
  log('dtmf', { digits, by });
}
setInterval(() => {
  if (!bridged || takingDigits) return;
  takingDigits = true;
  void db.query<{ digits: string }>(`UPDATE kenan_phone_call k SET digits='' FROM (SELECT id, digits FROM kenan_phone_call WHERE id=$1 AND digits<>'' FOR UPDATE) o WHERE k.id=o.id RETURNING o.digits`, [callId])
    .then(({ rows }) => {
      for (const { digits } of rows) {
        const parsed = parseDigits(digits);
        if (!parsed.ok) { log('dtmf-rejected', { error: parsed.error }); continue; }
        if (ownPress && ownPress.digits === parsed.value && Date.now() - ownPress.atMs < DUPLICATE_MS) { log('dtmf-duplicate', { digits: parsed.value }); continue; }
        menu?.pressed(parsed.value);
        press(parsed.value, 'agent');
      }
    })
    .catch(e => log('dtmf-error', { error: String(e) }))
    .finally(() => { takingDigits = false; });
}, 300).unref();

const gathered = (pc: RTCPeerConnection) => new Promise<void>(resolve => {
  if (pc.iceGatheringState === 'complete') return resolve();
  pc.iceGatheringStateChange.subscribe(state => { if (state === 'complete') resolve(); });
});

// GPT Live leg: our track carries the callee's audio in; GPT's track carries its voice out.
const gpt = new RTCPeerConnection({ codecs });
closers.push(() => gpt.close());
const toGpt = new MediaStreamTrack({ kind: 'audio' });
gpt.addTransceiver(toGpt, { direction: 'sendrecv' });
const events: RTCDataChannel = gpt.createDataChannel('oai-events');
// GPT Live's timeline advances only with input audio, so the callee's packets are restamped onto one continuous
// stream and any gap (before answer, carrier DTX) is filled with 20 ms Opus silence frames.
const SILENCE = Buffer.from([0xf8, 0xff, 0xfe]);
let seq = 0, timestamp = 0, lastSource: number | null = null, lastWrite = 0;
type LiveNote = { type: 'session.commentary.append' | 'session.thinking.append'; content: string };
const pendingLive: LiveNote[] = [];
function send(note: LiveNote): void {
  if (!bridged || events.readyState !== 'open') { pendingLive.push(note); return; }
  events.send(JSON.stringify({ type: note.type, event_id: randomUUID(), delegation_id: null, content: note.content }));
}
const live = (content: string) => send({ type: 'session.commentary.append', content });
function writeToGpt(payload: Buffer, step: number): void {
  seq = (seq + 1) & 0xffff;
  timestamp = (timestamp + step) >>> 0;
  lastWrite = Date.now();
  toGpt.writeRtp(new RtpPacket(new RtpHeader({ payloadType: 111, sequenceNumber: seq, timestamp, ssrc: 0x4b454e41, marker: false }), payload));
}
// The callee's audio is also decoded to 8 kHz, for the level log and, on outbound calls, the line watch: a person
// waiting in silence is greeted, and once a mailbox is recording GPT is told to leave its message and hears silence until
// it has, so mailbox prompts cannot interrupt it.
const voicemail = direction === 'outbound' ? new LineWatch() : null;
const shield = new MessageShield();
const decoder = new OpusScript(RATE, 1, OpusScript.Application.VOIP);
closers.push(() => decoder.delete());
let pcm = new Int16Array(0), decodeFailures = 0, heardBeforeJoin: string | null = null;
function watchLine(payload: Buffer | null): void {
  let samples: Int16Array;
  if (payload === null) { samples = new Int16Array(FRAME); recording?.push('line', samples, Date.now()); }
  else {
    try {
      const decoded = decoder.decode(payload);
      samples = new Int16Array(decoded.buffer.slice(decoded.byteOffset, decoded.byteOffset + decoded.length));
    } catch (e) { if (decodeFailures++ === 0) log('decode-error', { error: String(e) }); return; }
    recording?.push('line', samples, Date.now());
    const db = frameDb(samples);
    lineDb = lineDb === null ? db : Math.max(lineDb, db);
    if (db > LINE_SOUND_DB) lastLineSound = Date.now();
  }
  if (!voicemail || voicemail.state !== 'open') return;
  const joined = new Int16Array(pcm.length + samples.length);
  joined.set(pcm); joined.set(samples, pcm.length);
  let at = 0;
  for (; at + FRAME <= joined.length; at += FRAME) {
    const cue = voicemail.push(joined.slice(at, at + FRAME));
    if (cue) act(cue);
  }
  pcm = joined.slice(at);
}
function act(cue: Cue): void {
  if (cue.kind === 'greet') {
    note('the line is quiet after the answer: Kenan greets the person');
    log('greet', { lineMs: cue.atMs, heardBeforeJoin });
    live(greetNow(heardBeforeJoin, language));
    return;
  }
  note(cue.after === 'beep' ? `voicemail beep (${cue.hz} Hz): the mailbox is recording` : 'voicemail greeting ended without a beep: the mailbox is recording');
  log('voicemail', { after: cue.after, lineMs: cue.atMs, ...(cue.after === 'beep' ? { hz: cue.hz } : {}) });
  shield.start(Date.now());
  live(LEAVE_MESSAGE[cue.after]);
}
setInterval(() => {
  const outcome = shield.check(Date.now());
  if (outcome) log('voicemail-shield-end', { outcome });
}, 100).unref();
const forwardToGpt = (rtp: RtpPacket) => {
  frames.fromPhone += voiced(rtp.payload);
  watchLine(rtp.payload);
  const delta = lastSource === null ? 960 : (rtp.header.timestamp - lastSource) >>> 0;
  lastSource = rtp.header.timestamp;
  writeToGpt(shield.active ? SILENCE : rtp.payload, delta > 0 && delta <= 4800 ? delta : 960);
};
setInterval(() => { if (Date.now() - lastWrite >= 40) { lastSource = null; writeToGpt(SILENCE, 960); watchLine(null); } }, 20).unref();
const fromGpt = new Promise<MediaStreamTrack>(resolve => gpt.onTrack.subscribe(resolve));
gpt.connectionStateChange.subscribe(state => { if (state === 'failed' || state === 'closed') void end(`GPT Live connection ${state}`); });
events.onMessage.subscribe(data => {
  const event = JSON.parse(String(data)) as Delta & { type: string; error?: { message?: string } };
  if (event.type === 'session.input_transcript.delta') say('Person', event);
  else if (event.type === 'session.output_transcript.delta') say('Kenan', event);
  else if (event.type === 'error') log('live-error', { error: event.error?.message });
  else if (event.type === 'session.closed') void end('GPT Live session closed');
});
// GPT Live opens while the phone rings and the phone leg joins: neither waits for the other.
const liveReady = (async () => {
await gpt.setLocalDescription(await gpt.createOffer());
await gathered(gpt);
const session = await liveClient(liveSettings).live.create({
  session: {
    model: liveSettings.model, delegation: { type: 'client' }, instructions: phoneInstructions(person, voice, { direction: row.direction, brief: row.brief, callbackNumber: row.callback_number, startedAt: new Date() }), audio: { output: { voice: voice.voice } }, store: false,
    client: { data_channel: { allowed_client_events: ['session.commentary.append', 'session.thinking.append', 'session.close'], allowed_server_events: [{ type: 'session.started' }, { type: 'session.closed' }, { type: 'session.input_transcript.delta' }, { type: 'session.output_transcript.delta' }, { type: 'error' }] } },
  },
  transport: { type: 'webrtc', sdp: gpt.localDescription!.sdp },
} as never) as unknown as { session: { id: string }; transport: { sdp: string } };
await gpt.setRemoteDescription({ type: 'answer', sdp: session.transport.sdp });
await db.query('UPDATE kenan_phone_call SET live_session_id=$2 WHERE id=$1', [callId, session.session.id]);
closers.push(() => { if (events.readyState === 'open') events.send(JSON.stringify({ type: 'session.close', event_id: randomUUID() })); });
log('live-ready', { session: session.session.id });
})();
// Per-hop network latency: ICE round trip to each media peer (GPT Live, Retell's gateway) and RTCP round trip where reported.
async function hop(pc: RTCPeerConnection): Promise<Record<string, unknown>> {
  const stats = [...(await pc.getStats()).values()] as unknown as Record<string, unknown>[];
  const byId = new Map(stats.map(stat => [stat.id, stat]));
  const out: Record<string, unknown> = {};
  const pair = stats.find(stat => stat.type === 'candidate-pair' && stat.nominated) ?? stats.find(stat => stat.type === 'candidate-pair' && stat.state === 'succeeded');
  const side = (id: unknown) => { const c = byId.get(id); return c ? `${c.candidateType} ${c.protocol} ${c.address}:${c.port}` : null; };
  if (pair) Object.assign(out, { iceRttMs: typeof pair.currentRoundTripTime === 'number' ? Math.round(pair.currentRoundTripTime * 1000) : null, local: side(pair.localCandidateId), remote: side(pair.remoteCandidateId) });
  for (const stat of stats) {
    if (stat.type === 'remote-inbound-rtp' && typeof stat.roundTripTime === 'number') out.rtcpRttMs = Math.round(stat.roundTripTime * 1000);
    if (stat.type === 'inbound-rtp' && typeof stat.jitter === 'number') out.jitterMs = Math.round(stat.jitter * 1000);
  }
  return out;
}
const hops: { name: string; pc: RTCPeerConnection }[] = [{ name: 'gpt', pc: gpt }];
setInterval(() => { void Promise.all(hops.map(async h => [h.name, await hop(h.pc).catch(e => ({ error: String(e) }))] as const)).then(r => log('hops', Object.fromEntries(r))); }, 10_000).unref();

// Wait for the callee to answer the PSTN leg (the silent Retell agent holds it). An inbound call's id is known before
// Retell creates the call object, so until it connects get-call answers 404. When placing an outbound call returned an
// uncertain outcome, the provider call is found by this session's own Retell agent; none within PLACE_LIMIT_MS means
// none was placed.
const PLACE_LIMIT_MS = 90_000;
const bridgeStarted = Date.now();
const connectBy = bridgeStarted + 60_000;
const answered = (async (): Promise<string> => {
let providerCallId: string | null = null, lastSearch = 0;
for (;;) {
  if (!providerCallId) {
    const placed = (await db.query<PhoneRow>('SELECT provider_call_id, retell_agent_id FROM kenan_phone_call WHERE id=$1', [callId])).rows[0];
    providerCallId = placed?.provider_call_id ?? null;
    if (!providerCallId && placed?.retell_agent_id && Date.now() - bridgeStarted > 5000 && Date.now() - lastSearch > 2000) {
      lastSearch = Date.now();
      providerCallId = await findProviderCall(retellKey, placed.retell_agent_id).catch(e => { log('find-call-error', { error: describe(e) }); return null; });
    }
    if (providerCallId && !placed?.provider_call_id) await db.query('UPDATE kenan_phone_call SET provider_call_id=$2 WHERE id=$1 AND provider_call_id IS NULL', [callId, providerCallId]);
    if (!providerCallId && Date.now() - bridgeStarted > PLACE_LIMIT_MS) await end('the call was not placed: Retell has no call for this session');
  }
  if (providerCallId) {
    const state = await retell<ProviderCall>(retellKey, `/v2/get-call/${encodeURIComponent(providerCallId)}`, 'GET').catch((e: Error) => {
      if (direction === 'inbound' && / HTTP 404:/.test(e.message) && Date.now() < connectBy) return null;
      throw e;
    });
    if (state === null) { await new Promise(r => setTimeout(r, 100)); continue; }
    if (state.call_status === 'ongoing') break;
    if (state.call_status === 'ended' || state.call_status === 'error' || state.call_status === 'not_connected') { await end(`call ${state.call_status} before answer: ${state.disconnection_reason ?? 'unknown'}`); }
  }
  await new Promise(r => setTimeout(r, 100));
}
log('answered', { providerCallId });
return providerCallId;
})();
// The phone leg joins as soon as the call is answered, while GPT Live may still be opening (inbound call 20ea8bef: GPT Live
// was ready 0.9 s after the answer, and joining only after it put bridged 2.9 s after the answer).
const providerCallId = await answered;

// Retell gateway leg: listen, then take over the call's audio with GPT's voice.
const grant = await retell<Grant>(retellKey, `/v2/listen-live-call/${encodeURIComponent(providerCallId)}`, 'POST', {});
if (grant.transport !== 'gateway') throw new Error(`Unsupported Retell live transport ${grant.transport}`);
const base = `https://api.retellai.com/webrtc-proxy/${encodeURIComponent(providerCallId)}/v1/webrtc/sessions`;
const auth = { authorization: `Bearer ${grant.access_token}` };
const phone = new RTCPeerConnection({ codecs, iceServers: grant.ice_servers?.length ? grant.ice_servers : [{ urls: 'stun:stun.l.google.com:19302' }] });
closers.push(() => phone.close());
hops.push({ name: 'retell', pc: phone });
const transceiver = phone.addTransceiver('audio', { direction: 'recvonly' });
const control = phone.createDataChannel('control');
control.onMessage.subscribe(data => {
  const message = JSON.parse(String(data)) as { type?: string; state?: string; disconnection_reason?: string };
  log(message.type === 'status' ? 'carrier-status' : 'carrier-message', message);
  if (message.type === 'status' && message.state === 'ended') void lineEnded(message.disconnection_reason ?? null);
});
phone.onTrack.subscribe(track => track.onReceiveRtp.subscribe(forwardToGpt));
phone.connectionStateChange.subscribe(state => { if (!lineClosed && (state === 'failed' || state === 'closed')) void end(`telephone connection ${state}`); });
await phone.setLocalDescription(await phone.createOffer());
await gathered(phone);
const created = await fetch(base, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ identity: grant.participant_id, sdp: phone.localDescription!.sdp }) });
if (!created.ok) throw new Error(`Retell gateway session HTTP ${created.status}: ${await created.text()}`);
const gateway = await created.json() as { session_id: string; sdp: string };
closers.push(async () => { await fetch(`${base}/${gateway.session_id}`, { method: 'DELETE', headers: auth }); });
await phone.setRemoteDescription({ type: 'answer', sdp: gateway.sdp });
log('joined', { gateway: gateway.session_id, candidates: gateway.sdp.split(/\r?\n/).filter(l => l.startsWith('a=candidate')), iceServers: (grant.ice_servers ?? []).map(server => server.urls) });

// Retell's take-over needs the listener already in the room, so the session is renegotiated to send GPT's voice after it.
await retell(retellKey, `/v2/take-over-live-call/${encodeURIComponent(providerCallId)}`, 'POST', { participant_id: grant.participant_id });
log('taken-over');
const toPhone = new MediaStreamTrack({ kind: 'audio' });
await transceiver.sender.replaceTrack(toPhone);
transceiver.setDirection('sendrecv');
await phone.setLocalDescription(await phone.createOffer());
await gathered(phone);
const renegotiated = await fetch(`${base}/${gateway.session_id}`, { method: 'PATCH', headers: { ...auth, 'content-type': 'application/sdp' }, body: phone.localDescription!.sdp });
if (!renegotiated.ok) throw new Error(`Retell takeover renegotiation HTTP ${renegotiated.status}: ${await renegotiated.text()}`);
await phone.setRemoteDescription({ type: 'answer', sdp: await renegotiated.text() });
// Everything sent to the phone is restamped onto one stream, so GPT's voice and keypad tones interleave cleanly.
let outSeq = 0, outTimestamp = 0, lastGptSource: number | null = null, lastOut = Date.now();
const sentDecoder = new OpusScript(RECORDING_RATE, 1, OpusScript.Application.VOIP);
closers.push(() => sentDecoder.delete());
let sentDecodeFailures = 0;
function writeToPhone(payload: Buffer, step: number): void {
  if (recording) try {
    const decoded = sentDecoder.decode(payload);
    recording.push('kenan', new Int16Array(decoded.buffer.slice(decoded.byteOffset, decoded.byteOffset + decoded.length)), Date.now());
  } catch (e) { if (sentDecodeFailures++ === 0) log('decode-error', { side: 'kenan', error: String(e) }); }
  outSeq = (outSeq + 1) & 0xffff;
  outTimestamp = (outTimestamp + step) >>> 0;
  lastOut = Date.now();
  toPhone.writeRtp(new RtpPacket(new RtpHeader({ payloadType: 111, sequenceNumber: outSeq, timestamp: outTimestamp, ssrc: 0x4b454e42, marker: false }), payload));
}
const resumeStep = () => Math.max(1, Math.round((Date.now() - lastOut) / 20)) * 960;
log('phone-ready');
await liveReady;
// Kenan's voice is judged by its loudness: GPT Live sometimes sends full-size frames of silence for minutes (9cbb9e63).
const gptDecoder = new OpusScript(RATE, 1, OpusScript.Application.VOIP);
closers.push(() => gptDecoder.delete());
(await fromGpt).onReceiveRtp.subscribe(rtp => {
  if (voiced(rtp.payload)) {
    frames.fromGpt++;
    try { if (frameDb(gptDecoder.decode(rtp.payload)) > LINE_SOUND_DB) lastKenanVoice = Date.now(); }
    catch { lastKenanVoice = Date.now(); }
  }
  if (keyQueuedAt !== null) { lastGptSource = null; return; }
  const delta = lastGptSource === null ? resumeStep() : (rtp.header.timestamp - lastGptSource) >>> 0;
  lastGptSource = rtp.header.timestamp;
  writeToPhone(rtp.payload, delta > 0 && delta <= 4800 ? delta : 960);
});
setInterval(() => {
  if (keyQueuedAt === null || dtmf.length === 0) return;
  if (!keyPlaying) {
    const now = Date.now(), quietMs = now - lastLineSound, waitedMs = now - keyQueuedAt;
    if (quietMs < KEY_QUIET_MS && waitedMs < KEY_WAIT_MS) return;
    keyPlaying = true;
    log('dtmf-play', { waitedMs, quietMs: Math.min(quietMs, waitedMs) });
  }
  const packet = dtmf.shift()!;
  writeToPhone(packet, lastGptSource === null && Date.now() - lastOut > 60 ? resumeStep() : 960);
  lastGptSource = null;
  if (dtmf.length === 0) {
    keyPlaying = false; keyQueuedAt = null;
    send({ type: 'session.thinking.append', content: 'The keypad tones are done; the line hears you again.' });
  }
}, 20).unref();
bridged = true;
lastSpeech = Date.now();
log('bridged', { providerCallId });
for (const pending of pendingLive.splice(0)) send(pending);
// GPT already hears the line and answers a person itself; it is told only what it could not know.
if (direction === 'inbound') live('The caller is connected and waiting. Greet them now as the brief says.');
else {
  voicemail?.joined();
  send({ type: 'session.thinking.append', content: 'The call has connected: from now on the other side hears you.' });
  // What the callee said before the bridge joined is only in Retell's own transcript of its silent agent's leg.
  void retell<ProviderCall>(retellKey, `/v2/get-call/${encodeURIComponent(providerCallId)}`, 'GET').then(call => {
    const said = (call.transcript_object ?? []).filter(u => u.role === 'user').map(u => u.content.replace(/\([^)]*\)/g, '').trim()).filter(Boolean).join(' ');
    log('before-join', { said });
    if (!said) return;
    heardBeforeJoin = said;
    transcript += `${transcript ? '\n' : ''}Person (before Kenan joined): ${said}`; speaker = '';
    voicemail?.person(`${said} `);
    const hit = menu?.person(`${said} `);
    if (hit) press(hit.key, hit.why);
  }).catch(e => log('before-join-error', { error: describe(e) }));
}
