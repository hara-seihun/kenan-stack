import { expect, it } from 'vitest';
import { providerObservation, watchdogAction, type ProviderSession } from './meeting-session.js';
const session: ProviderSession = {sessionId:'s',ownerId:'acme',conversationId:'c',providerSessionId:'p',phase:'joining',endsAt:100000,lastObservedAt:1000};
it('never treats lobby or unknown provider state as joined', () => {
  expect(providerObservation(session,{providerSessionId:'p',observedAt:2000,state:'lobby'}).phase).toBe('joining');
  expect(providerObservation(session,{providerSessionId:'p',observedAt:2000,state:'unknown'}).phase).toBe('unknown');
  expect(providerObservation(session,{providerSessionId:'p',observedAt:2000,state:'entered'}).phase).toBe('active');
});
it('rejects foreign and stale provider observations and terminal resurrection', () => {
  expect(()=>providerObservation(session,{providerSessionId:'foreign',observedAt:2000,state:'entered'})).toThrow('mismatch');
  expect(()=>providerObservation(session,{providerSessionId:'p',observedAt:999,state:'entered'})).toThrow('Stale');
  expect(()=>providerObservation({...session,phase:'ended'},{providerSessionId:'p',observedAt:2000,state:'entered'})).toThrow('restart');
});
it('cleans up withdrawals and deadlines; reconciles stale or unknown joins without replay', () => {
  expect(watchdogAction(session,2000,false)).toBe('leave');
  expect(watchdogAction(session,100000,true)).toBe('leave');
  expect(watchdogAction(session,32000,true)).toBe('observe');
  expect(watchdogAction({...session,phase:'unknown'},2000,true)).toBe('observe');
  expect(watchdogAction(session,2000,true)).toBe('observe');
  expect(watchdogAction({...session,phase:'active'},2000,true)).toBe('none');
  expect(watchdogAction({...session,phase:'ended'},100000,false)).toBe('none');
});
it('leave acceptance is not terminal cleanup; provider observation owns outcome', async () => {
  const { reconcileProviderSession } = await import('./meeting-session.js');
  let leaves=0;
  const adapter={leave:async()=>{leaves++;},observe:async()=>({providerSessionId:'p',observedAt:2000,state:'entered' as const})};
  const result=await reconcileProviderSession(session,2000,false,adapter);
  expect(leaves).toBe(1); expect(result.phase).toBe('leaving');
  const ended=await reconcileProviderSession(result,3000,false,{...adapter,observe:async()=>({providerSessionId:'p',observedAt:3000,state:'left'})});
  expect(ended.phase).toBe('ended');
});
it('provider observation failure does not create or repeat a join', async () => {
  const { reconcileProviderSession } = await import('./meeting-session.js');
  let leaves=0;
  await expect(reconcileProviderSession(session,32000,true,{leave:async()=>{leaves++;},observe:async()=>{throw new Error('offline');}})).rejects.toThrow('offline');
  expect(leaves).toBe(0);
});
