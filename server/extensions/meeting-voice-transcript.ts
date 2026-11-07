import { randomUUID } from 'node:crypto';

/** Private, owner-scoped meeting evidence. Model text is not proof that the audio was audible. */
export const VOICE_TRANSCRIPT_TABLE = `CREATE TABLE IF NOT EXISTS kenan_meeting_voice_transcript (
  owner_id text NOT NULL, session_id text NOT NULL, voice_session_id text NOT NULL,
  ordinal integer NOT NULL, provider_id text NOT NULL, event_id text NOT NULL,
  at bigint NOT NULL, speaker text NOT NULL CHECK(speaker IN ('Meeting','Kenan')), delta text NOT NULL,
  PRIMARY KEY(owner_id,session_id,voice_session_id,ordinal))`;
type Query = <R = Record<string, unknown>>(sql: string, args: unknown[]) => Promise<{rows: R[]; rowCount: number | null}>;
export type VoiceTranscriptContext = {ownerId: string; sessionId: string; voiceSessionId: string; providerId: string};
export type VoiceTranscriptEvent = {type: string; delta?: string; event_id?: string};
export type VoiceTranscriptPiece = {voiceSessionId: string; providerId: string; ordinal: number; eventId: string; at: number; speaker: 'Meeting' | 'Kenan'; delta: string};

/** A serial writer preserves stream order without putting database work on the audio or control path. */
export function voiceTranscriptWriter(query: Query, context: VoiceTranscriptContext, onError: (error: unknown) => void) {
  let ordinal = 0, pending = Promise.resolve();
  return {
    append(event: VoiceTranscriptEvent, at = Date.now()) {
      const speaker = event.type === 'session.input_transcript.delta' ? 'Meeting' : event.type === 'session.output_transcript.delta' ? 'Kenan' : null;
      if (!speaker || !event.delta) return;
      const args = [context.ownerId,context.sessionId,context.voiceSessionId,++ordinal,context.providerId,event.event_id ?? randomUUID(),at,speaker,event.delta];
      pending = pending.then(async () => {
        await query('INSERT INTO kenan_meeting_voice_transcript(owner_id,session_id,voice_session_id,ordinal,provider_id,event_id,at,speaker,delta) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING',args);
      }).catch(onError);
    },
    flush: () => pending,
  };
}

/** Inspection is bounded, but storage keeps every piece, including across voice reconnects and process restarts. */
export async function readVoiceTranscript(query: Query, ownerId: string, sessionId: string): Promise<VoiceTranscriptPiece[]> {
  const result = await query<VoiceTranscriptPiece>('SELECT voice_session_id AS "voiceSessionId",provider_id AS "providerId",ordinal,event_id AS "eventId",at::float8 AS at,speaker,delta FROM kenan_meeting_voice_transcript WHERE owner_id=$1 AND session_id=$2 ORDER BY at DESC,voice_session_id DESC,ordinal DESC LIMIT 2000',[ownerId,sessionId]);
  return result.rows.reverse();
}
