import { createHash } from 'node:crypto';
import type { MeetingCaptionProvenance } from '../../shared/contract.js';
import type { NewMessage } from '../types.js';

/** Provider authentication and wire decoding belong to the meeting route, not this seam. */
export type CaptionEvent = {
  sessionId: string; eventId: string; ownerId: string; conversationId: string;
  text: string; isFinal: boolean; at: number; speaker?: string; speakerId?: string;
};
export type CaptionSession = {
  sessionId: string; ownerId: string; conversationId: string;
  phase: 'joining' | 'active' | 'leaving' | 'ended' | 'unknown'; providerSessionId: string;
  source?: NonNullable<MeetingCaptionProvenance['source']>;
};
export type CaptionMessage = NewMessage & { id: string; clientId: string };
export type CaptionPorts = {
  resolveSession(id: string): Promise<CaptionSession | null>;
  getMessageByClientId(id: string): Promise<Pick<NewMessage, 'id' | 'clientId' | 'conversationId' | 'authorId' | 'role' | 'text' | 'parts'> | null>;
  appendMessage(message: CaptionMessage): Promise<unknown>;
};
export function captionMessageId(sessionId: string, eventId: string): string {
  const hex = createHash('sha256').update(JSON.stringify(['meeting-caption', sessionId, eventId])).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
function valid(event: CaptionEvent): boolean {
  return !!event && [event.sessionId, event.eventId, event.ownerId, event.conversationId].every(s => typeof s === 'string' && s.length > 0 && s.length <= 512)
    && typeof event.text === 'string' && event.text.trim().length > 0 && Buffer.byteLength(event.text, 'utf8') <= 65536
    && [event.speaker, event.speakerId].every(s => s === undefined || typeof s === 'string' && s.trim().length > 0 && s.length <= 512)
    && typeof event.isFinal === 'boolean' && Number.isSafeInteger(event.at) && event.at >= 0;
}
/** Persist only final captions. The caller may broadcast/wake only for `appended`. */
export async function ingestCaption(event: CaptionEvent, ports: CaptionPorts): Promise<{ status: 'partial' | 'duplicate' | 'appended'; message?: CaptionMessage }> {
  if (!valid(event)) throw new Error('Invalid caption');
  const session = await ports.resolveSession(event.sessionId);
  if (!session || session.phase !== 'active' || session.sessionId !== event.sessionId || session.ownerId !== event.ownerId
    || session.conversationId !== event.conversationId || !session.providerSessionId) throw new Error('Caption session is inactive or mismatched');
  if (!event.isFinal) return { status: 'partial' };
  const id = captionMessageId(event.sessionId, event.eventId);
  const provenance: MeetingCaptionProvenance = { version: 1, sessionId: event.sessionId, providerSessionId: session.providerSessionId,
    eventId: event.eventId, ownerId: event.ownerId, conversationId: event.conversationId, at: event.at,
    speaker: event.speaker ?? null, speakerId: event.speakerId ?? null, source: session.source ?? null };
  const message: CaptionMessage = {
    id, clientId: `meeting-caption:${id}`, conversationId: event.conversationId,
    authorId: `meeting:${session.sessionId}`, role: 'notice', notice: 'meeting_caption', text: event.text,
    parts: [{ type: 'text', text: event.text, meetingCaption: provenance }], state: 'done',
  };
  const duplicate = async (): Promise<boolean> => {
    const existing = await ports.getMessageByClientId(message.clientId);
    if (!existing) return false;
    if (existing.id !== message.id || existing.conversationId !== message.conversationId || existing.authorId !== message.authorId
      || existing.role !== message.role || existing.text !== message.text) throw new Error('Conflicting final caption');
    const prior = existing.parts?.find(part => part.type === 'text' && part.meetingCaption);
    // Legacy committed messages have no original timestamp/speaker/source: reconcile them without inventing provenance.
    if (prior?.type === 'text' && JSON.stringify(prior.meetingCaption) !== JSON.stringify(provenance)) throw new Error('Conflicting final caption provenance');
    return true;
  };
  if (await duplicate()) return { status: 'duplicate' };
  try { await ports.appendMessage(message); }
  catch (error) {
    // A concurrent duplicate or a lost append acknowledgement is reconciled, not blindly repeated.
    if (await duplicate()) return { status: 'duplicate' };
    throw error;
  }
  return { status: 'appended', message };
}
