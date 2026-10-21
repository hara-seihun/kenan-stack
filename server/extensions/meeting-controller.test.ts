import { expect, it } from 'vitest';
import { joinMeeting, type JoinRequest, type MeetingControllerPorts } from './meeting-controller.js';
const request: JoinRequest={sessionId:'s',ownerId:'acme',conversationId:'c',meetingUrl:'https://meet.google.com/abc-defg-hij',endsAt:100000,observedAt:1000,included:true};
function ports() { let reserved=false,joins=0; const p:MeetingControllerPorts={reserve:async()=>{if(reserved)return false;reserved=true;return true;},save:async()=>{},join:async()=>{joins++;return{providerSessionId:'p',observedAt:2000,state:'lobby'};}};return{p,joins:()=>joins}; }
it('requires fresh eligible policy before any provider effect',async()=>{
  const {p,joins}=ports();
  await expect(joinMeeting({...request,included:false},2000,p)).rejects.toThrow('eligible');
  await expect(joinMeeting(request,62000,p)).rejects.toThrow('eligible');
  await expect(joinMeeting({...request,meetingUrl:'https://foreign.example/'},2000,p)).rejects.toThrow('Invalid');
  expect(joins()).toBe(0);
});
it('distinguishes actual lobby from entered; reserves one join',async()=>{
  const {p,joins}=ports(); expect((await joinMeeting(request,2000,p)).phase).toBe('joining');
  await expect(joinMeeting(request,2000,p)).rejects.toThrow('reconciled'); expect(joins()).toBe(1);
});
it('does not replay an uncertain original provider effect',async()=>{
  const {p}=ports();p.join=async()=>{throw new Error('lost response');};
  await expect(joinMeeting(request,2000,p)).rejects.toThrow('lost response');
  await expect(joinMeeting(request,2000,p)).rejects.toThrow('reconciled');
});
it('does not claim provider acceptance when persistence failed',async()=>{
  const {p}=ports();p.save=async()=>{throw new Error('storage unavailable');};
  await expect(joinMeeting(request,2000,p)).rejects.toThrow('storage unavailable');
  await expect(joinMeeting(request,2000,p)).rejects.toThrow('reconciled');
});
