import { describe, expect, it } from 'vitest';
import { eligibleMeetings, activeProviderEvidence, browserMeetingState, type MeetingObservation } from './meeting.js';
const now = Date.parse('2026-10-18T00:00:00Z');
function proof(): MeetingObservation { return { at: new Date(now).toISOString(), coverage: { kind: 'complete', unknownCalendars: [] }, snapshot: { withdrawnEventKeys: [], meetings: [{ eventKey: 'e', eventId: 'e', title: 'Internal', meetingUrl: 'https://meet.google.com/abc-defg-hij', organizerEmail: 'host@acme.example', startAt: new Date(now).toISOString(), endAt: new Date(now+60000).toISOString(), fingerprint: 'f', attendance: { included: true } }] } }; }
describe('fresh meeting discovery', () => {
  it('accepts policy included events without inventing an invitation requirement', () => { expect(eligibleMeetings(proof(), now)).toHaveLength(1); });
  it('rejects stale, future-dated, and incomplete observations', () => {
    expect(() => eligibleMeetings(proof(), now+60001)).toThrow('stale');
    expect(() => eligibleMeetings(proof(), now-5001)).toThrow('stale');
    const p=proof(); p.coverage.unknownCalendars=['missing']; expect(() => eligibleMeetings(p, now)).toThrow('incomplete');
  });
  it('does not turn malformed dates into withdrawal evidence', () => {
    const p=proof(); p.snapshot.meetings[0]!.startAt='invalid';
    expect(() => eligibleMeetings(p, now)).toThrow('Invalid');
  });
  it('preserves opt-outs, withdrawals, expiration, and lead time', () => {
    const p=proof(); p.snapshot.meetings[0]!.attendance.included=false; expect(eligibleMeetings(p, now)).toEqual([]);
    p.snapshot.meetings[0]!.attendance.included=true; p.snapshot.withdrawnEventKeys=['e']; expect(eligibleMeetings(p, now)).toEqual([]);
    p.snapshot.withdrawnEventKeys=[]; p.snapshot.meetings[0]!.startAt=new Date(now-1000).toISOString(); p.snapshot.meetings[0]!.endAt=new Date(now).toISOString(); expect(eligibleMeetings(p, now)).toEqual([]);
    p.snapshot.meetings[0]!.endAt=new Date(now+3600000).toISOString(); p.snapshot.meetings[0]!.startAt=new Date(now+1800001).toISOString(); expect(eligibleMeetings(p, now)).toEqual([]);
  });
});

it('rejects expired, future and nonfinite provider clocks',()=>{
  const session={sessionId:'s',ownerId:'acme',conversationId:'c',providerSessionId:'p',phase:'active' as const,endsAt:now+1000,lastObservedAt:now};
  expect(activeProviderEvidence(session,now)).toBe(true);
  for(const patch of [{endsAt:now},{endsAt:NaN},{lastObservedAt:NaN},{lastObservedAt:Infinity},{lastObservedAt:now+1},{lastObservedAt:now-60001}]) expect(activeProviderEvidence({...session,...patch},now)).toBe(false);
});
it('uses guarded normalized provider states, not raw snapshot text or dispatch acceptance',()=>{
  expect(browserMeetingState({state:'left'})).toBe('left');
  expect(browserMeetingState({state:'entered'})).toBe('entered');
  expect(browserMeetingState({state:'lobby'})).toBe('lobby');
  expect(browserMeetingState({state:'leave-dispatched'})).toBe('unknown');
  expect(browserMeetingState({observation:{refs:{a:{role:'button',name:'Leave call'}}}})).toBe('unknown');
});
