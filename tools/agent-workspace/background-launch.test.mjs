import {test} from 'node:test';
import assert from 'node:assert/strict';
import {backgroundSpec} from './background-launch.mjs';
import {callerToolCall,procScope} from './cache-queue.mjs';
const binding={channel:'beta',callId:'exact-call',agentId:'11111111-1111-4111-8111-111111111111'};
const input={agentId:binding.agentId,name:'fixture',argv:['/bin/true'],cwd:'/tmp',env:[],umask:'0077',after:'/bin/true'};
const spec=backgroundSpec(input,binding,1000,1000),group='/user.slice/user-agents.slice/'+spec.unit;
const properties={Description:spec.description,ControlGroup:group,Transient:'yes',ActiveState:'active',User:'1000',InvocationID:'a'.repeat(32)};
const observe=(patch={},cg=group)=>procScope(100,{read:()=>`0::${cg}\n`,query:()=>({status:0,stdout:Object.entries({...properties,...patch}).map(([k,v])=>k+'='+v).join('\n')})});
test('a root-created background launch preserves the exact native identity after server ancestry is gone',()=>{
 assert.deepEqual(callerToolCall({pid:100,scope:()=>observe(),uid:()=>1000,parent:()=>1}),binding);
 assert.equal(callerToolCall({pid:100,scope:()=>observe(),uid:()=>1001,parent:()=>1}),null);
 assert.equal(callerToolCall({pid:100,scope:()=>observe(),uid:()=>1000,parent:()=>1,background:false}),null);
});
test('stale, forged, wrong worker and wrong launch metadata cannot authenticate a background caller',()=>{
 for(const patch of [{ActiveState:'inactive'},{Transient:'no'},{InvocationID:''},{User:'1001'},{Description:'untrusted-user-metadata'},{Description:'kenan-tool-call:'+JSON.stringify({...binding,version:1,background:true,uid:1000,agentId:'22222222-2222-4222-8222-222222222222'})},{ControlGroup:group+'-other'}])assert.equal(observe(patch),null);
 assert.equal(observe({},group.replace('fixture','different-launch')),null);
 assert.equal(observe({},'/user.slice/user-1000.slice/'+spec.unit),null);
 assert.throws(()=>backgroundSpec({...input,agentId:'other'},binding,1000,1000),/owner_mismatch/);
 assert.throws(()=>backgroundSpec(input,null,1000,1000),/caller_required/);
 assert.throws(()=>backgroundSpec(input,binding,0,0),/caller_required/);
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
test('the installed symlink invokes the actual CLI rather than silently doing nothing',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'background-cli-'));
 try{const file=path.join(root,'linked.mjs');fs.symlinkSync(new URL('./background-launch.mjs',import.meta.url).pathname,file);const r=spawnSync(process.execPath,[file,'launch'],{input:'{}',encoding:'utf8',timeout:5000});assert.equal(r.status,2);assert.match(r.stderr,/background_(root|native_caller)_required/);}finally{fs.rmSync(root,{recursive:true,force:true});}
});

import {releaseCaller} from './release-authority.mjs';
test('a background native caller with failed authentication cannot fall through to operator authority',()=>{
 const r=releaseCaller({caller:()=>null,pid:100,cgroup:()=>`0::${group}`,argv:()=>['/bin/worker'],parent:()=>1});
 assert.equal(r.ok,false);assert.equal(r.error.code,'release-caller-unverified');
});
import {submitBackground} from './background-launch.mjs';
test('native background submission is one atomic bounded creation, not preflight and reset waits',()=>{
 let calls=0;const timeout={status:null,error:{code:'ETIMEDOUT'},stdout:'',stderr:''};const r=submitBackground('/usr/bin/systemd-run',['--unit=exact-original.service'],{execute:(cmd,args,options)=>{calls++;assert.equal(cmd,'/usr/bin/systemd-run');assert.deepEqual(args,['--unit=exact-original.service']);assert.equal(options.timeout,15000);return timeout;}});assert.equal(r,timeout);assert.equal(calls,1);
});

import {backgroundDirectory} from './background-launch.mjs';
test('an outer cleanup unit launched inside its release target uses a neutral directory',()=>{
 const cwd='/home/kenan/work/clones/cleanup-target',home='/home/kenan';
 for(const argv of [
  ['/usr/local/bin/kenan-bg','--run','cleanup','/var/tmp/log','/bin/bash','-c',`cd /home/kenan && agent-workspace release --path ${cwd} --json`],
  ['/usr/local/bin/kenan-bg','--run','cleanup','/var/tmp/log','/home/kenan/.local/bin/agent-workspace','release','--path',cwd],
 ])assert.equal(backgroundDirectory({cwd,argv},home),home);
 assert.equal(backgroundDirectory({cwd,argv:['/bin/bash','-c','bun test']},home),cwd);
 assert.equal(backgroundDirectory({cwd,argv:['/usr/bin/agent-workspace','status','--path',cwd]},home),cwd);
});

import {launchOnce,settleBackground,launchIdentity} from './background-launch.mjs';
test('a definite manager refusal preserves its actual reason rather than inventing an unknown outcome',()=>{
 const r=settleBackground({status:1,stderr:'Failed to connect to bus: No such file or directory'}, {LoadState:'not-found'},spec);
 assert.equal(r.code,'background_launch_refused');assert.equal(r.retry,true);assert.match(r.detail,/connect to bus/);
});
test('a lost submission reply is resolved by the retained exact unit, never by absence alone',()=>{
 const lost={status:null,error:{code:'ETIMEDOUT'}};
 assert.equal(settleBackground(lost,{...properties,LoadState:'loaded'},spec).ok,true);
 assert.equal(settleBackground(lost,{LoadState:'not-found'},spec).retry,false);
 assert.equal(settleBackground(lost,{...properties,LoadState:'loaded',Description:'foreign'},spec).code,'background_owner_mismatch');
});
test('named retries return the original log without executing again, including after unit collection or reboot',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'background-once-'));let starts=0;
 const original={...input,argv:['/usr/local/bin/kenan-bg','--run','fixture','/tmp/first.log','/bin/true']};
 const execute=(cmd,args,options)=>{
  if(cmd==='/usr/bin/flock')return spawnSync(cmd,args,options);
  if(cmd==='/usr/bin/systemd-run'){starts++;return {status:0,stdout:'',stderr:''};}
  return {status:0,stdout:'LoadState=not-found\n'};
 };
 try{
  const a=launchOnce(original,binding,1000,spec,[],{root,execute});assert.equal(a.ok,true);
  const retry={...original,argv:[...original.argv]};retry.argv[3]='/tmp/new.log';
  const b=launchOnce(retry,{...binding,callId:'later-call'},1000,spec,[],{root,execute});
  assert.equal(b.ok,true);assert.equal(b.reused,true);assert.equal(b.log,'/tmp/first.log');assert.equal(starts,1);
  const conflict=launchOnce({...retry,cwd:'/different'},binding,1000,spec,[],{root,execute});assert.equal(conflict.code,'background_name_conflict');assert.equal(starts,1);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('a crashed or timed-out submission reserves its name until exact reconciliation, without replay',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'background-pending-'));let starts=0;
 const execute=(cmd,args,options)=>{
  if(cmd==='/usr/bin/flock')return spawnSync(cmd,args,options);
  if(cmd==='/usr/bin/systemd-run'){starts++;return {status:null,error:{code:'ETIMEDOUT'}};}
  return {status:0,stdout:'LoadState=not-found\n'};
 };
 try{for(let i=0;i<2;i++)assert.equal(launchOnce(input,binding,1000,spec,[],{root,execute}).code,'background_launch_outcome_unknown');assert.equal(starts,1);}finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('the inherited flock stays held until the parent closes its descriptor',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'background-lock-')),file=path.join(root,'lock'),fd=fs.openSync(file,'a');
 try{
  assert.equal(spawnSync('/usr/bin/flock',['-x','3'],{stdio:['ignore','pipe','pipe',fd]}).status,0);
  assert.equal(spawnSync('/usr/bin/flock',['-n',file,'/bin/true']).status,1);
  fs.closeSync(fd);
  assert.equal(spawnSync('/usr/bin/flock',['-n',file,'/bin/true']).status,0);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('a queued unit with a lost reply is not falsely reported as started',()=>{
 const r=settleBackground({status:null,error:{code:'ETIMEDOUT'}},{...properties,LoadState:'loaded',ActiveState:'activating'},spec);
 assert.equal(r.ok,false);assert.equal(r.code,'background_launch_outcome_unknown');assert.equal(r.retry,false);
});

test('a definitely refused submission can retry, returning the log actually used by its new attempt',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'background-refused-'));let starts=0;
 const original={...input,argv:['/usr/local/bin/kenan-bg','--run','fixture','/tmp/refused.log','/bin/true']};
 const execute=(cmd,args,options)=>{
  if(cmd==='/usr/bin/flock')return spawnSync(cmd,args,options);
  if(cmd==='/usr/bin/systemd-run'){starts++;return starts===1?{status:1,stderr:'Failed to connect to bus'}:{status:0};}
  return {status:0,stdout:'LoadState=not-found\n'};
 };
 try{
  assert.equal(launchOnce(original,binding,1000,spec,[],{root,execute}).code,'background_launch_refused');
  const retry={...original,argv:[...original.argv]};retry.argv[3]='/tmp/accepted.log';
  const r=launchOnce(retry,binding,1000,spec,[],{root,execute});assert.equal(r.ok,true);assert.equal(r.log,'/tmp/accepted.log');assert.equal(starts,2);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('completed successful jobs do not remain active merely to retain retry evidence',()=>{
 const source=fs.readFileSync(new URL('./background-launch.mjs',import.meta.url),'utf8');
 assert.equal(source.includes('--property=RemainAfterExit=yes'),false);
 assert.equal(source.includes("'--collect'"),false);
 assert.equal(source.includes('--property=Type=exec'),true);
});
test('background receipts live under a state directory that is not a retired pi path, and a missing parent is an error, not a created tree',async()=>{
 const {BACKGROUND_ROOT,launchOnce}=await import('./background-launch.mjs');
 assert.equal(BACKGROUND_ROOT,'/var/lib/agent-workspace/background-launch');
 const base=fs.mkdtempSync(path.join(os.tmpdir(),'background-parent-'));
 try{
  const r=launchOnce(input,binding,1000,spec,[],{root:path.join(base,'missing','background-launch')});
  assert.equal(r.code,'background_state_parent_missing');assert.equal(fs.existsSync(path.join(base,'missing')),false);
 }finally{fs.rmSync(base,{recursive:true,force:true});}
});
