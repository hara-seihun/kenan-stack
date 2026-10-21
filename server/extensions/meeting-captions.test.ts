import { describe, expect, it } from 'vitest';
import { captionMessageId, ingestCaption, type CaptionEvent, type CaptionMessage, type CaptionPorts, type CaptionSession } from './meeting-captions.js';

const event: CaptionEvent = { sessionId: 'session', eventId: 'utterance-1', ownerId: 'acme', conversationId: 'conversation', text: 'Alice: Ship the fix.', isFinal: true, at: 1792279000000 };
function fixture() {
  const rows = new Map<string, CaptionMessage>();
  let session: CaptionSession | null = { sessionId: event.sessionId, ownerId: event.ownerId, conversationId: event.conversationId, phase: 'active', providerSessionId: 'actual-provider-session' };
  let calls = 0;
  const ports: CaptionPorts = {
    async resolveSession() { return session; },
    async getMessageByClientId(id) { return rows.get(id) ?? null; },
    async appendMessage(message) { calls++; if (rows.has(message.clientId)) throw new Error('unique'); rows.set(message.clientId, message); },
  };
  return { ports, rows, calls: () => calls, setSession: (value: CaptionSession | null) => { session = value; } };
}
describe('normalized meeting captions', () => {
  it('persists attributed final speech only in the exact active conversation, without human impersonation', async () => {
    const f = fixture();
    const r = await ingestCaption(event, f.ports);
    expect(r.status).toBe('appended');
    expect(r.message).toMatchObject({ conversationId: event.conversationId, authorId: 'meeting:session', role: 'notice', text: event.text });
    expect(f.calls()).toBe(1);
  });
  it('does not persist or wake for partial captions', async () => {
    const f = fixture(); expect(await ingestCaption({ ...event, isFinal: false }, f.ports)).toEqual({ status: 'partial' }); expect(f.calls()).toBe(0);
  });
  it('deduplicates final redelivery including a fresh handler after restart', async () => {
    const f = fixture(); await ingestCaption(event, f.ports);
    expect(await ingestCaption(event, { ...f.ports })).toEqual({ status: 'duplicate' }); expect(f.calls()).toBe(1);
  });
  it('reconciles concurrent duplicates through the persisted unique identity', async () => {
    const f = fixture(); const r = await Promise.all([ingestCaption(event, f.ports), ingestCaption(event, f.ports)]);
    expect(r.map(x => x.status).sort()).toEqual(['appended', 'duplicate']); expect(f.rows.size).toBe(1);
  });
  it('never replaces conflicting final words', async () => {
    const f = fixture(); await ingestCaption(event, f.ports);
    await expect(ingestCaption({ ...event, text: 'Different final words' }, f.ports)).rejects.toThrow('Conflicting'); expect(f.calls()).toBe(1);
  });
  it.each(['joining', 'leaving', 'ended', 'unknown'] as const)('rejects %s lifecycle before persistence', async phase => {
    const f = fixture(); f.setSession({ sessionId: event.sessionId, ownerId: event.ownerId, conversationId: event.conversationId, phase, providerSessionId: 'provider' });
    await expect(ingestCaption(event, f.ports)).rejects.toThrow('inactive'); expect(f.calls()).toBe(0);
  });
  it.each(['sessionId', 'ownerId', 'conversationId', 'providerSessionId'] as const)('rejects mismatched %s', async key => {
    const f = fixture(); f.setSession({ sessionId: event.sessionId, ownerId: event.ownerId, conversationId: event.conversationId, phase: 'active', providerSessionId: 'provider', [key]: key === 'providerSessionId' ? '' : 'other' });
    await expect(ingestCaption(event, f.ports)).rejects.toThrow('mismatched'); expect(f.calls()).toBe(0);
  });
  it('rejects deleted/revoked sessions even for a previously persisted event', async () => {
    const f = fixture(); await ingestCaption(event, f.ports); f.setSession(null);
    await expect(ingestCaption(event, f.ports)).rejects.toThrow('inactive');
  });
  it('does not hide append failures or retry an uncertain external effect', async () => {
    const f = fixture(); let calls = 0; f.ports.appendMessage = async () => { calls++; throw new Error('database down'); };
    await expect(ingestCaption(event, f.ports)).rejects.toThrow('database down'); expect(calls).toBe(1);
  });
  it('recognizes an append committed despite a lost acknowledgement without waking twice', async () => {
    const f = fixture(); const append = f.ports.appendMessage; f.ports.appendMessage = async message => { await append(message); throw new Error('lost ack'); };
    expect(await ingestCaption(event, f.ports)).toEqual({ status: 'duplicate' }); expect(f.rows.size).toBe(1);
  });
  it.each([{ text: '' }, { text: ' ' }, { text: 'é'.repeat(32769) }, { at: NaN }, { at: -1 }, { at: 1.5 }, { eventId: '' }, { isFinal: 'yes' }])('rejects malformed normalized event %j', async patch => {
    const f = fixture(); await expect(ingestCaption({ ...event, ...patch } as CaptionEvent, f.ports)).rejects.toThrow('Invalid caption'); expect(f.calls()).toBe(0);
  });
  it('uses stable, collision-separated session/event identity', () => {
    expect(captionMessageId('a:b', 'c')).not.toBe(captionMessageId('a', 'b:c'));
    expect(captionMessageId('session', 'one')).not.toBe(captionMessageId('other', 'one'));
    expect(captionMessageId('session', 'one')).toBe(captionMessageId('session', 'one'));
  });
});

describe('caption source provenance', () => {
  it('retains original time, optional real speaker and exact authenticated provider identity', async () => {
    const f = fixture();
    const source = { channel: 'beta' as const, eventKey: 'calendar/event', fingerprint: 'original-fingerprint', organizerEmail: 'reader@acme.example', startAt: '2026-10-20T20:00:00Z', endAt: '2026-10-20T21:00:00Z' };
    f.setSession({ sessionId: event.sessionId, ownerId: event.ownerId, conversationId: event.conversationId, phase: 'active', providerSessionId: 'original-provider-id', source });
    const result = await ingestCaption({ ...event, speaker: 'Reported speaker', speakerId: 'provider-person' }, f.ports);
    expect(result.message?.parts?.[0]).toMatchObject({ type: 'text', text: event.text, meetingCaption: { at: event.at, eventId: event.eventId, providerSessionId: 'original-provider-id', source, speaker: 'Reported speaker', speakerId: 'provider-person' } });
    expect(result.message?.id).toBe(captionMessageId(event.sessionId, event.eventId));
  });
  it('unknown speaker and calendar binding stay explicitly unknown, not invented from text', async () => {
    const f = fixture(); const result = await ingestCaption(event, f.ports);
    expect(result.message?.parts?.[0]).toMatchObject({ meetingCaption: { speaker: null, speakerId: null, source: null } });
  });
  it.each([{ at: event.at + 1 }, { speaker: 'Changed speaker' }, { speakerId: 'Other participant' }])('refuses changed final provenance even when words are unchanged: %j', async patch => {
    const f = fixture(); await ingestCaption(event, f.ports);
    await expect(ingestCaption({ ...event, ...patch }, f.ports)).rejects.toThrow('provenance');
    expect(f.calls()).toBe(1);
  });
  it('reconciles a legacy committed duplicate without adding invented historical provenance', async () => {
    const f = fixture(); const result = await ingestCaption(event, f.ports);
    result.message!.parts = [{ type: 'text', text: event.text }];
    expect(await ingestCaption(event, f.ports)).toEqual({ status: 'duplicate' });
    expect(f.rows.get(result.message!.clientId)?.parts).toEqual([{ type: 'text', text: event.text }]);
  });
  it('rejects malformed speaker metadata without writes', async () => {
    const f = fixture();
    await expect(ingestCaption({ ...event, speaker: ' ' }, f.ports)).rejects.toThrow('Invalid');
    expect(f.calls()).toBe(0);
  });
});
