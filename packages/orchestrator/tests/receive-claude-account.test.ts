import { expect, it } from 'vitest';
// @ts-expect-error The receiving CLI is a standalone Node deployment module.
import { receiveClaudeAccount } from '../../../deploy/receive-claude-account.mjs';

it('receives, grants and probes together; resume never overwrites a rotated token',async()=>{
  const auth: Record<string, any> = {}, events: string[] = [];
  let granted=false, serving=false;
  const packet={id:'original-transfer',alias:'anthropic-2',migration:'fixture',credential:{type:'oauth',access:'fixture-access',refresh:'fixture-refresh',expires:Date.now()+3600000}};
  const input={packet,alias:packet.alias,migration:packet.migration,
    store:{upsertAccount:()=>events.push('registered')},
    withAuth:async(fn:any)=>fn(auth,()=>events.push('saved')),
    grant:async()=>{granted=true;events.push('granted');},
    probe:async()=>{events.push('probed');return {granted,completed:serving,meterFresh:serving,leaseId:serving?'real-lease':null};}};
  await expect(receiveClaudeAccount(input)).rejects.toThrow('incomplete');
  expect(events).toEqual(['saved','registered','granted','probed']);
  expect(auth['broker-receive:original-transfer'].phase).toBe('received');
  auth['anthropic-2'].access='rotated-after-import';serving=true;
  expect((await receiveClaudeAccount(input)).phase).toBe('proven');
  expect(auth['anthropic-2'].access).toBe('rotated-after-import');
  const n=events.length;
  expect((await receiveClaudeAccount(input)).proof.leaseId).toBe('real-lease');
  expect(events).toHaveLength(n);
  await expect(receiveClaudeAccount({...input,packet:{...packet,migration:'wrong'}})).rejects.toThrow('Invalid');
});

it('does not probe or declare success when grant publication fails',async()=>{
  let probed=false;
  const auth: Record<string,any>={};
  const packet={id:'grant-failure',alias:'anthropic-5',migration:'fixture',credential:{type:'oauth',access:'fixture',refresh:'fixture',expires:Date.now()+100000}};
  await expect(receiveClaudeAccount({packet,alias:packet.alias,migration:packet.migration,
    store:{upsertAccount:()=>{}},withAuth:async(fn:any)=>fn(auth,()=>{}),
    grant:async()=>{throw Error('Grant write failed');},probe:async()=>{probed=true;}})).rejects.toThrow('Grant write failed');
  expect(probed).toBe(false);
  expect(auth['broker-receive:grant-failure'].phase).toBe('received');
});
