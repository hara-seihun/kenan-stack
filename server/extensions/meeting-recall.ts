import { ALONE_GRACE_SECONDS, OVERTIME_CAP_MS } from './meeting-session.js';
export interface RecallGrant { apiKey: string; region: string }
export interface RecallEvidence {
  botId: string; state: 'joining' | 'lobby' | 'entered' | 'left' | 'failed' | 'unknown';
  status: string; observedAt: string; providerAt: string | null;
  /** Recall's sub_code on the call_ended change (why the bot left), once it has left. */
  endSubCode?: string | null;
}
type Fetch = typeof fetch;
/** Recall's answer body, kept for diagnosis: bounded, with anything token-like removed. */
export function scrubRecallBody(raw: string): string {
  return raw.replace(/(token|key|secret|authorization)("?\s*[:=]\s*"?)[^",}\s]+/gi, '$1$2<redacted>').slice(0, 2000);
}
export class RecallHttpError extends Error {
  constructor(readonly status: number, readonly method: string, readonly body: string) {
    super(`Recall ${method} failed (${status})${body ? `: ${body}` : ''}`);
  }
}
/** A create Recall answered with a 4xx: it made no bot, so a corrected create is safe. */
export class RecallCreateRejected extends Error {
  constructor(readonly status: number, readonly body: string) { super(`Recall refused the create (${status})${body ? `: ${body}` : ''}; no bot was made`); }
}
/** A create whose outcome is unknown (network, timeout, 5xx, no id): only Recall's bot list can settle it. */
export class RecallCreateUncertain extends Error {
  constructor(readonly detail: string) { super(`Recall create outcome unknown (${detail}); reconcile by listing bots for this effect`); }
}
/** Recall answers meeting_url as {meeting_id, platform}; older answers and requests use the URL. */
export function recallMeetingCode(value: unknown): string | null {
  if (typeof value === 'string') return /meet\.google\.com\/([a-z]{3}-[a-z]{4}-[a-z]{3})/.exec(value)?.[1] ?? null;
  if (value && typeof value === 'object') { const id = (value as { meeting_id?: unknown }).meeting_id; return typeof id === 'string' ? id : null; }
  return null;
}
/** Hosts admit the bot by this name; the lobby DM and the channel note use it too. */
export const RECALL_BOT_NAME = 'Kenan (notetaker)';
/** Posted (and pinned) in the meeting chat as the bot joins. California needs every party's consent to record. */
export const RECALL_ANNOUNCEMENT = "Hi, I'm Kenan, Alice's AI notetaker. I'm transcribing this call from the meeting captions and will share notes afterwards. If you'd rather not be transcribed, remove me from the call or tell Alice, and I'll leave.";
/** The announcement for a bot with meeting voice: it can hear the meeting audio, so it says so. */
export const RECALL_VOICE_ANNOUNCEMENT = "Hi, I'm Kenan, Alice's AI assistant and notetaker. I'm taking notes from the captions, I can hear the meeting audio and see shared screens, and I'll only speak when someone addresses me as Kenan. If you'd rather I not be here, say 'Kenan, please leave' or remove me, and I'll go.";
/**
 * Other notetaker bots: Recall leaves once only bots like these remain (bot_detection), so Kenan does not stay in a
 * call with nobody but Alice's Circleback. Recall's own defaults are notetaker, recorder and assistant.
 */
export const OTHER_NOTETAKER_NAMES = ['notetaker', 'recorder', 'assistant', 'circleback', 'fireflies', 'otter', 'fathom', 'read.ai', 'tl;dv', 'tldv'];
/** Never round past the event end or create a bot too late for the provider's minimum. */
export function remainingMeetingSeconds(endsAt: number, now: number): number {
  const seconds = Math.floor((endsAt - now) / 1000);
  if (!Number.isFinite(seconds) || seconds < 30) throw new Error('Meeting has insufficient remaining duration');
  return Math.min(14400, seconds);
}
/**
 * Lobby: give up at the scheduled end. Admitted: stay while anyone else is present, leave
 * ALONE_GRACE_SECONDS after the last person goes, and never stay past OVERTIME_CAP_MS after the end.
 */
export function recallAutomaticLeave(durationSeconds: number) {
  const latest = durationSeconds + OVERTIME_CAP_MS / 1000;
  return { waiting_room_timeout: durationSeconds, noone_joined_timeout: 120,
    // Recall's documented minimum for activate_after is 1; 0 is refused with a 400.
    everyone_left_timeout: { timeout: ALONE_GRACE_SECONDS, activate_after: 1 },
    in_call_not_recording_timeout: latest, in_call_recording_timeout: latest,
    bot_detection: { using_participant_events: { timeout: 600, activate_after: 1200 },
      using_participant_names: { matches: OTHER_NOTETAKER_NAMES, timeout: ALONE_GRACE_SECONDS, activate_after: 120 } } };
}
/** Why a Recall bot left, from the sub_code of its call_ended change. */
export function recallLeaveReason(subCode: string | null | undefined): string | null {
  if (!subCode) return null;
  if (subCode === 'bot_received_leave_call') return 'Kenan was asked to leave';
  if (subCode === 'timeout_exceeded_everyone_left') return 'everyone else had left the call';
  if (subCode.startsWith('timeout_exceeded_only_bots')) return 'only other notetaker bots were left in the call';
  if (subCode === 'call_ended_by_host' || subCode.startsWith('call_ended_by_platform')) return 'the meeting ended';
  if (subCode === 'bot_kicked_from_call') return 'it was removed from the call';
  if (subCode === 'timeout_exceeded_in_call_recording' || subCode === 'timeout_exceeded_in_call_not_recording') return 'it reached the 3-hour limit past the scheduled end';
  if (subCode === 'timeout_exceeded_waiting_room' || subCode === 'bot_kicked_from_waiting_room') return 'nobody admitted it from the waiting room';
  if (subCode === 'timeout_exceeded_noone_joined') return 'nobody else joined';
  if (subCode === 'timeout_exceeded_silence_detected') return 'the call was silent for an hour';
  return `the call ended (Recall: ${subCode})`;
}
/**
 * The reason the notes give for a Recall bot leaving: the reason Kenan recorded when it made the bot leave wins when
 * Recall says it was asked to leave (or says nothing yet); otherwise Recall's own call_ended sub_code decides.
 */
export function recallNotesReason(recorded: string | null | undefined, subCode: string | null | undefined): string {
  if (recorded && (!subCode || subCode === 'bot_received_leave_call')) return recorded;
  return recallLeaveReason(subCode) ?? recorded ?? 'the meeting ended';
}
/**
 * Meeting voice for one bot: the camera webpage it renders (its voice and face), and the real-time websocket that
 * receives captions, participants, chat and screenshare frames.
 */
export interface RecallVoice { cameraUrl: string; realtimeUrl: string; screenView: 'off' | 'png' }
export type RecallTranscriptLine = { speaker: string | null; text: string; at: number | null };
export type RecallTranscript = { kind: 'ready'; lines: RecallTranscriptLine[] } | { kind: 'pending' } | { kind: 'failed' } | { kind: 'none' };
export interface RecallMatch extends RecallEvidence { nonce: string | null; joinAt: string | null }
/**
 * What a Recall bot keeps (tools.meeting.recallTranscript, required with recallEnabled, because recording needs
 * the owner's consent decision): 'meeting-captions' records from the moment it is in the call, keeping only
 * Meet's own captions as the transcript plus who was there (no audio or video), and announces itself in chat;
 * 'none' joins without recording anything.
 */
export type RecallTranscriptSetting = 'meeting-captions' | 'none';
export function recallTranscriptSetting(raw: unknown): { ok: true; value: RecallTranscriptSetting } | { ok: false; error: string } {
  return raw === 'meeting-captions' || raw === 'none' ? { ok: true, value: raw } : { ok: false, error: 'tools.meeting.recallTranscript must be "meeting-captions" (transcribe Meet captions, announced in chat) or "none" (record nothing)' };
}
/** The exact create request. */
export function recallCreateBody(input: { meetingUrl: string; effectId: string; nonce: string; durationSeconds: number; transcript: RecallTranscriptSetting; voice?: RecallVoice }) {
  const voice = input.voice;
  if (voice) {
    // Voice hears the meeting, so it always comes with the captions transcript and the voice announcement.
    const frames = voice.screenView === 'png';
    return { meeting_url: input.meetingUrl, bot_name: RECALL_BOT_NAME,
      recording_config: { transcript: { provider: { meeting_captions: {} } }, video_mixed_mp4: null, participant_events: {}, meeting_metadata: {}, start_recording_on: 'call_join',
        ...(frames ? { video_separate_png: {}, video_mixed_layout: 'gallery_view_v2' } : {}),
        realtime_endpoints: [{ type: 'websocket', url: voice.realtimeUrl, events: ['transcript.data', 'participant_events.join', 'participant_events.leave', 'participant_events.update', 'participant_events.chat_message', ...(frames ? ['video_separate_png.data'] : [])] }] },
      chat: { on_bot_join: { send_to: 'everyone', message: RECALL_VOICE_ANNOUNCEMENT, pin: true } },
      output_media: { camera: { kind: 'webpage', config: { url: voice.cameraUrl } } },
      variant: { google_meet: 'web_4_core' },
      automatic_leave: recallAutomaticLeave(input.durationSeconds),
      metadata: { source: 'acme-meeting', effectId: input.effectId, nonce: input.nonce, voice: 'on' } };
  }
  return { meeting_url: input.meetingUrl, bot_name: RECALL_BOT_NAME,
    ...(input.transcript === 'meeting-captions' ? {
      recording_config: { transcript: { provider: { meeting_captions: {} } }, video_mixed_mp4: null, participant_events: {}, meeting_metadata: {}, start_recording_on: 'call_join' },
      chat: { on_bot_join: { send_to: 'everyone', message: RECALL_ANNOUNCEMENT, pin: true } },
    } : { recording_config: null }),
    automatic_leave: recallAutomaticLeave(input.durationSeconds),
    metadata: { source: 'acme-meeting', effectId: input.effectId, nonce: input.nonce } };
}
/** Reads acme-project Secret Manager secrets with the attached machine identity. No login or identity fallback. */
export async function readMachineSecrets(names: string[], label: string, request: Fetch = fetch): Promise<string[]> {
  const metadata = await request('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token', {
    headers: { 'metadata-flavor': 'Google' }, signal: AbortSignal.timeout(10000),
  });
  if (!metadata.ok) throw new Error(`${label} machine identity unavailable (${metadata.status})`);
  const token = (await metadata.json() as { access_token?: string }).access_token;
  if (!token) throw new Error(`${label} machine identity missing`);
  const values: string[] = [];
  for (const name of names) {
    const response = await request(`https://secretmanager.googleapis.com/v1/projects/acme-project/secrets/${name}/versions/latest:access`, {
      headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error(`${label} existing grant unavailable (${response.status})`);
    const data = await response.json() as { payload?: { data?: string } };
    if (!data.payload?.data) throw new Error(`${label} existing grant missing`);
    values.push(Buffer.from(data.payload.data, 'base64').toString('utf8').trim());
  }
  return values;
}
/** Existing attached-machine grant only. No login, grant changes or identity fallback. */
export async function loadExistingRecallGrant(request: Fetch = fetch): Promise<RecallGrant> {
  const [apiKey, region] = await readMachineSecrets(['meeting-recall-api-key', 'meeting-recall-region'], 'Recall', request);
  if (!apiKey || !region || !/^[a-z]{2}-[a-z]+-\d+$/.test(region)) throw new Error('Recall existing grant invalid');
  return { apiKey, region };
}
export function normalizeRecallEvidence(botId: string, body: unknown, now = Date.now()): RecallEvidence {
  const changes = (body as { status_changes?: { code?: string; created_at?: string }[] } | null)?.status_changes;
  const last = Array.isArray(changes) ? changes.at(-1) : undefined;
  const status = typeof last?.code === 'string' ? last.code : 'unknown';
  const states: Record<string, RecallEvidence['state']> = {
    joining_call: 'joining', in_waiting_room: 'lobby', in_call_not_recording: 'entered',
    in_call_recording: 'entered', call_ended: 'left', done: 'left', fatal: 'failed',
  };
  const ended = Array.isArray(changes) ? changes.find(c => c?.code === 'call_ended') as { sub_code?: unknown } | undefined : undefined;
  return { botId, state: states[status] ?? 'unknown', status, observedAt: new Date(now).toISOString(),
    providerAt: last?.created_at && Number.isFinite(Date.parse(last.created_at)) ? last.created_at : null,
    ...(ended ? { endSubCode: typeof ended.sub_code === 'string' ? ended.sub_code : null } : {}) };
}
/** Caller owns fresh policy, durable reservation/bot id and cleanup timer. Never retries a create. */
export function createRecallMeetingClient(grant: RecallGrant, request: Fetch = fetch) {
  if (!grant.apiKey || !/^[a-z]{2}-[a-z]+-\d+$/.test(grant.region)) throw new Error('Invalid Recall grant');
  const base = `https://${grant.region}.recall.ai/api/v1`;
  const id = (value: string) => {
    if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)) throw new Error('Invalid Recall bot identity');
    return value;
  };
  async function call(path: string, method = 'GET', body?: unknown) {
    let response: Response;
    try { response = await request(base + path, { method,
      headers: { authorization: `Token ${grant.apiKey}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20000) });
    } catch (error) { throw new Error(method === 'POST' ? `Recall effect uncertain (${error instanceof Error ? error.name : 'network'}); reconcile original reservation before another attempt` : 'Recall inspection unavailable'); }
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new RecallHttpError(response.status, method, scrubRecallBody(text.split(grant.apiKey).join('<redacted>')));
    }
    return response.status === 204 ? null : await response.json() as unknown;
  }
  return {
    /** One create. The caller records `nonce` with its reservation before calling, so an unknown outcome can be found again. */
    async join(input: { meetingUrl: string; effectId: string; nonce: string; durationSeconds: number; transcript: RecallTranscriptSetting; voice?: RecallVoice }): Promise<RecallEvidence> {
      if (!/^https:\/\/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}$/.test(input.meetingUrl)) throw new Error('Invalid Meet URL');
      if (input.voice && ![input.voice.cameraUrl, input.voice.realtimeUrl].every(u => /^(https|wss):\/\/[^/?#]+\/[^#\s]*$/.test(u))) throw new Error('Invalid meeting voice URL');
      if (!input.effectId || input.effectId.length > 200 || !input.nonce || input.nonce.length > 100 || !Number.isInteger(input.durationSeconds) || input.durationSeconds < 30 || input.durationSeconds > 14400) throw new Error('Invalid Recall reservation');
      let data: unknown;
      try { data = await call('/bot/', 'POST', recallCreateBody(input)); }
      catch (error) {
        if (error instanceof RecallHttpError && error.status >= 400 && error.status < 500) throw new RecallCreateRejected(error.status, error.body);
        throw new RecallCreateUncertain(error instanceof Error ? error.message : 'unknown');
      }
      const botId = (data as { id?: string } | null)?.id;
      if (!botId) throw new RecallCreateUncertain('answer had no bot id');
      return normalizeRecallEvidence(id(botId), data);
    },
    /**
     * Every bot Recall holds for this effect and meeting, oldest first. A complete bounded scan:
     * an empty list is proof the effect made no bot; an unreadable or truncated list throws.
     */
    async reconcile(effectId: string, meetingUrl: string): Promise<RecallMatch[]> {
      const code = recallMeetingCode(meetingUrl);
      if (!effectId || effectId.length > 200 || !code || !/^https:\/\/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}$/.test(meetingUrl)) throw new Error('Invalid Recall reconciliation identity');
      let path = '/bot/?meeting_url=' + encodeURIComponent(meetingUrl) + '&page_size=100';
      const visited = new Set<string>();
      const matches = new Map<string, RecallMatch>();
      for (let page = 0; page < 5; page++) {
        if (visited.has(path)) throw new Error('Recall reconciliation pagination loop');
        visited.add(path);
        const data = await call(path) as { results?: unknown[]; next?: unknown } | null;
        if (!data || !Array.isArray(data.results) || data.results.length > 100) throw new Error('Recall reconciliation incomplete');
        for (const row of data.results) {
          if (!row || typeof row !== 'object') throw new Error('Recall reconciliation malformed result');
          const bot = row as { id?: string; meeting_url?: unknown; join_at?: string; metadata?: { effectId?: string; nonce?: string } };
          if (bot.metadata?.effectId === effectId && recallMeetingCode(bot.meeting_url) === code) {
            const botId = id(bot.id ?? '');
            matches.set(botId, { ...normalizeRecallEvidence(botId, row), nonce: typeof bot.metadata.nonce === 'string' ? bot.metadata.nonce : null, joinAt: bot.join_at ?? null });
          }
        }
        if (data.next === null || data.next === undefined || data.next === '') {
          return [...matches.values()].sort((a, b) => (a.joinAt ?? '').localeCompare(b.joinAt ?? ''));
        }
        if (typeof data.next !== 'string') throw new Error('Recall reconciliation invalid pagination');
        const next = new URL(data.next, base + '/bot/');
        if (next.origin !== new URL(base).origin || next.pathname !== '/api/v1/bot/' || next.hash || next.username || next.password) throw new Error('Recall reconciliation foreign pagination');
        path = next.pathname.slice('/api/v1'.length) + next.search;
      }
      throw new Error('Recall reconciliation page bound reached; original effect remains uncertain');
    },
    async inspect(botId: string) { return normalizeRecallEvidence(id(botId), await call(`/bot/${id(botId)}/`)); },
    /** The bot's caption transcript once Recall has finished it: lines of speaker and words, in order. */
    async transcript(botId: string): Promise<RecallTranscript> {
      const bot = await call(`/bot/${id(botId)}/`) as { recordings?: { media_shortcuts?: { transcript?: { status?: { code?: string }; data?: { download_url?: string } } | null } }[] } | null;
      const shortcuts = (bot?.recordings ?? []).map(r => r.media_shortcuts?.transcript).filter(t => !!t);
      if (!bot?.recordings?.length || !shortcuts.length) return { kind: 'none' };
      if (shortcuts.some(t => t!.status?.code !== 'done' || !t!.data?.download_url)) return shortcuts.some(t => t!.status?.code === 'failed') ? { kind: 'failed' } : { kind: 'pending' };
      const lines: RecallTranscriptLine[] = [];
      for (const t of shortcuts) {
        let response: Response;
        try { response = await request(t!.data!.download_url!, { signal: AbortSignal.timeout(30000) }); } catch { return { kind: 'pending' }; }
        if (!response.ok) return { kind: 'pending' };
        for (const part of await response.json() as { participant?: { name?: string | null }; words?: { text?: string; start_timestamp?: { absolute?: string | null } | null }[] }[]) {
          const text = (part.words ?? []).map(w => w.text ?? '').join(' ').replace(/\s+/g, ' ').trim();
          if (text) lines.push({ speaker: part.participant?.name ?? null, text, at: Date.parse(part.words?.[0]?.start_timestamp?.absolute ?? '') || null });
        }
      }
      return { kind: 'ready', lines };
    },
    /** Shows a webpage as the bot's screen share. One POST, never retried: an unknown outcome is reported. */
    async startScreenshare(botId: string, url: string) {
      if (!/^https:\/\/[^/?#\s]+\/\S*$/.test(url) || url.length > 4096) throw new Error('Screen share needs an https URL');
      await call(`/bot/${id(botId)}/output_media/`, 'POST', { screenshare: { kind: 'webpage', config: { url } } });
    },
    /** Stops the bot's screen share; a bot that has already left (or shares nothing) counts as stopped. */
    async stopScreenshare(botId: string) {
      try { await call(`/bot/${id(botId)}/output_media/`, 'DELETE', { screenshare: true }); return { stopped: true as const }; }
      catch (error) {
        if (error instanceof RecallHttpError && (error.status === 404 || /cannot_command_completed_bot|not.*(active|sharing|running)/i.test(error.body))) return { stopped: true as const };
        throw error;
      }
    },
    /** One chat message to everyone in the meeting (Google Meet supports only everyone). */
    async sendChat(botId: string, message: string, pin = false) {
      if (typeof message !== 'string' || !message.trim() || message.length > 4096) throw new Error('A chat message is 1 to 4,096 characters');
      await call(`/bot/${id(botId)}/send_chat_message/`, 'POST', { to: 'everyone', message, pin });
    },
    async leave(botId: string) {
      const original = id(botId);
      const inspect = async () => normalizeRecallEvidence(original, await call(`/bot/${original}/`));
      const prior = await inspect();
      if (prior.state === 'left') return prior;
      try {
        await call(`/bot/${original}/leave_call/`, 'POST', {});
      } catch (error) {
        // The original bot may have ended between GET and POST. A 400 alone
        // proves nothing; only a fresh terminal read of that same bot settles it.
        if (error instanceof RecallHttpError && error.status === 400) {
          try {
            const observed = await inspect();
            if (observed.state === 'left') return observed;
          } catch { /* Keep the original refusal when reconciliation is unavailable. */ }
        }
        throw error;
      }
      // A leave ACK is not evidence of departure.
      return inspect();
    },
  };
}
