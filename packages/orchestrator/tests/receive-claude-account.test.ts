import { expect, it } from 'vitest';
// @ts-expect-error The receiving CLI is a standalone Node deployment module.
import { receiveClaudeAccount, readClaudeAdmission } from '../../../deploy/receive-claude-account.mjs';
import { Store } from '../src/store.js';
import { mkdtempSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

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

it('does not mistake an ended failed lease or a sibling account for successful admission',()=>{
  const store=Store.open(':memory:'),now=Date.now(),alias='anthropic-2';
  try{
    for(const id of [alias,'anthropic-6'])store.upsertAccount({id,provider:'anthropic'});
    store.createLease('failed',alias,'interactive',undefined,now);store.endLease('failed');
    store.recordMeter(alias,'anthropic-7d',68,now+86400_000,now);
    store.setControl('broker-grant:converge',JSON.stringify({accounts:[alias]}));
    expect(readClaudeAdmission(store,alias,now)).toBeUndefined();
    store.recordUsage({accountId:'anthropic-6',runId:'failed',source:'interactive',hour:now,model:'claude-opus-5-5',component:'output',tokens:4});
    expect(readClaudeAdmission(store,alias,now)).toBeUndefined();
    store.recordUsage({accountId:alias,runId:'failed',source:'interactive',hour:now,model:'claude-opus-5-5',component:'output',tokens:4});
    expect(readClaudeAdmission(store,alias,now)).toMatchObject({leaseId:'failed',granted:true,meterFresh:true,completed:true});
    store.setControl('broker-grant:converge',JSON.stringify({accounts:[]}));
    expect(readClaudeAdmission(store,alias,now)).toBeUndefined();
  }finally{store.close();}
});

it('runs the installed command through its symlink rather than silently doing nothing',()=>{
  const directory=mkdtempSync(join(tmpdir(),'receive-link-'));
  try{
    const link=join(directory,'kenan-claude-account-receive');
    symlinkSync(fileURLToPath(new URL('../../../deploy/receive-claude-account.mjs',import.meta.url)),link);
    const result=spawnSync(process.execPath,[link],{encoding:'utf8'});
    expect(result.status).toBe(1);expect(result.stderr).toContain('Usage:');
  }finally{rmSync(directory,{recursive:true,force:true});}
});
