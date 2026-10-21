import {it,expect} from 'vitest';import {meetingGenerationId} from './meeting-generation.js';
it('new time generation only after old effect definitively ended; preserves old operation and attendee-only changes',()=>{
 const now=Date.parse('2026-10-20T15:30Z'),base='original';const m={startAt:'2026-10-20T16:00Z',endAt:'2026-10-20T16:30Z',meetingUrl:'same-meet'};const old={phase:'ended',endsAt:Date.parse('2026-10-20T15:00Z')};
 const fresh=meetingGenerationId(base,m,old,now);expect(fresh).not.toBe(base);expect(meetingGenerationId(base,m,old,now)).toBe(fresh);
 for(const phase of ['unknown','joining','active','leaving'])expect(meetingGenerationId(base,m,{...old,phase},now)).toBe(base);
 expect(meetingGenerationId(base,{...m,startAt:'2026-10-20T14:30Z',endAt:'2026-10-20T15:00Z'},old,now)).toBe(base);expect(meetingGenerationId(base,m,undefined,now)).toBe(base);
});
