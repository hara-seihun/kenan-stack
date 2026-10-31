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
test('a lost submission reply is resolved by the unit and the tool call that created it, never by absence alone',()=>{
 const lost={status:null,error:{code:'ETIMEDOUT'}};
 assert.equal(settleBackground(lost,{...properties,LoadState:'loaded'},spec).ok,true);
 const absent=settleBackground(lost,{LoadState:'not-found'},spec);
 assert.equal(absent.code,'background_launch_outcome_unknown');assert.equal(absent.retry,true);assert.match(absent.detail,/same kenan-bg command again/);
 assert.equal(settleBackground(lost,{...properties,LoadState:'loaded',Description:'foreign'},spec).code,'background_owner_mismatch');
 const earlier='kenan-tool-call:'+JSON.stringify({version:1,...binding,callId:'earlier-call',background:true,uid:1000});
 const r=settleBackground(lost,{...properties,LoadState:'loaded',Description:earlier},spec);assert.equal(r.code,'background_running');assert.equal(r.createdBy,'earlier-call');
});
test('the same command under an ended name returns the original log without executing again; a different command runs',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'background-once-'));let starts=0;
 const original={...input,argv:['/usr/local/bin/kenan-bg','--run','fixture','/tmp/first.log','/bin/true']};
 const execute=(cmd,args,options)=>{
  if(cmd==='/usr/bin/flock')return spawnSync(cmd,args,options);
  if(cmd==='/usr/bin/systemd-run'){starts++;return {status:0,stdout:'',stderr:''};}
  return {status:0,stdout:'LoadState=not-found\n'};
 };
 try{
  const a=launchOnce(original,binding,1000,spec,()=>[],{root,execute});assert.equal(a.ok,true);
  const retry={...original,argv:[...original.argv]};retry.argv[3]='/tmp/new.log';
  const b=launchOnce(retry,{...binding,callId:'later-call'},1000,spec,()=>[],{root,execute});
  assert.equal(b.ok,true);assert.equal(b.reused,true);assert.equal(b.log,'/tmp/first.log');assert.equal(starts,1);
  const other=launchOnce({...retry,cwd:'/different'},binding,1000,spec,()=>[],{root,execute});assert.equal(other.ok,true);assert.equal(other.log,'/tmp/new.log');assert.equal(starts,2);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
// A fake systemd: systemd-run outcomes are scripted, and a created unit stays loaded with the creating call's description.
function fakeSystemd(outcomes){
 const state={starts:0,units:new Map(),argv:[]};
 state.execute=(cmd,args,options)=>{
  if(cmd==='/usr/bin/flock')return spawnSync(cmd,args,options);
  if(cmd==='/usr/bin/systemd-run'){state.starts++;state.argv.push(args);const o=outcomes[state.starts-1]??{reply:{status:0},unit:'active'};if(o.unit)state.units.set(spec.unit,{ActiveState:o.unit,Description:o.description??spec.description});return o.reply;}
  if(args[1]==='reset-failed'){state.units.delete(args[2]);return {status:0};}
  const u=state.units.get(args[2]);return {status:0,stdout:u?`LoadState=loaded\nDescription=${u.Description}\nActiveState=${u.ActiveState}\n`:'LoadState=not-found\n'};
 };
 return state;
}
const wrapped=(log,cmd='/bin/true')=>({...input,argv:['/usr/local/bin/kenan-bg','--run','fixture',log,cmd],after:'/usr/local/bin/kenan-bg --after fixture '+log});
const lost={reply:{status:null,error:{code:'ETIMEDOUT'}}};
const withRoot=f=>{const root=fs.mkdtempSync(path.join(os.tmpdir(),'background-'));try{f(root);}finally{fs.rmSync(root,{recursive:true,force:true});}};
test('a caller cut off before systemd answered: the same command starts the job exactly once, with the original log',()=>withRoot(root=>{
 const sd=fakeSystemd([lost]);
 assert.equal(launchOnce(wrapped('/tmp/first.log'),binding,1000,spec,x=>x.argv,{root,execute:sd.execute,exists:()=>false}).code,'background_launch_outcome_unknown');
 const r=launchOnce(wrapped('/tmp/second.log'),{...binding,callId:'retry-call'},1000,spec,x=>[...x.argv,x.after],{root,execute:sd.execute,exists:()=>false});
 assert.equal(r.ok,true);assert.equal(r.log,'/tmp/first.log');assert.equal(sd.starts,2);
 assert.deepEqual(sd.argv[1].slice(3),['/tmp/first.log','/bin/true','/usr/local/bin/kenan-bg --after fixture /tmp/first.log']);
}));
test('a cut-off launch whose job did start is reported, not run again',()=>withRoot(root=>{
 const sd=fakeSystemd([lost]);
 launchOnce(wrapped('/tmp/first.log'),binding,1000,spec,x=>x.argv,{root,execute:sd.execute});
 // Started and already finished: its unit is collected but the wrapper created its log.
 const r=launchOnce(wrapped('/tmp/second.log'),binding,1000,spec,x=>x.argv,{root,execute:sd.execute,exists:f=>f==='/tmp/first.log'});
 assert.equal(r.ok,true);assert.equal(r.reused,true);assert.equal(r.state,'ended');assert.equal(sd.starts,1);
 // Started and still running.
 const sd2=fakeSystemd([{...lost,unit:'active'}]);
 withRoot(root2=>{
  assert.equal(launchOnce(wrapped('/tmp/a.log'),binding,1000,spec,x=>x.argv,{root:root2,execute:sd2.execute}).ok,true);
  const again=launchOnce(wrapped('/tmp/b.log'),{...binding,callId:'later'},1000,spec,x=>x.argv,{root:root2,execute:sd2.execute});
  assert.equal(again.state,'running');assert.equal(again.log,'/tmp/a.log');assert.equal(sd2.starts,1);
 });
}));
test('an earlier cut-off submission that lands after its retry is the same job, never a second one',()=>withRoot(root=>{
 const earlier='kenan-tool-call:'+JSON.stringify({version:1,...binding,background:true,uid:1000});
 const sd=fakeSystemd([lost,{reply:{status:1,stderr:'Unit already exists'},unit:'active',description:earlier}]);
 launchOnce(wrapped('/tmp/first.log'),binding,1000,spec,x=>x.argv,{root,execute:sd.execute,exists:()=>false});
 const laterSpec=backgroundSpec(input,{...binding,callId:'retry-call'},1000,1000);
 const r=launchOnce(wrapped('/tmp/second.log'),{...binding,callId:'retry-call'},1000,laterSpec,x=>x.argv,{root,execute:sd.execute,exists:()=>false});
 assert.equal(r.ok,true);assert.equal(r.state,'running');assert.equal(r.log,'/tmp/first.log');
}));
test('a name is free again for a different command once its job ended, and busy while it runs',()=>withRoot(root=>{
 const sd=fakeSystemd([]);
 assert.equal(launchOnce(wrapped('/tmp/a.log','/bin/true'),binding,1000,spec,x=>x.argv,{root,execute:sd.execute}).ok,true);
 const busy=launchOnce(wrapped('/tmp/b.log','/bin/false'),binding,1000,spec,x=>x.argv,{root,execute:sd.execute});
 assert.equal(busy.code,'background_running');assert.equal(sd.starts,1);
 sd.units.delete(spec.unit);
 const fresh=launchOnce(wrapped('/tmp/b.log','/bin/false'),binding,1000,spec,x=>x.argv,{root,execute:sd.execute});
 assert.equal(fresh.ok,true);assert.equal(fresh.log,'/tmp/b.log');assert.equal(sd.starts,2);
 // A retained failed unit is reset so the name can be used again.
 sd.units.set(spec.unit,{ActiveState:'failed',Description:spec.description});
 assert.equal(launchOnce(wrapped('/tmp/c.log','/bin/echo'),binding,1000,spec,x=>x.argv,{root,execute:sd.execute}).ok,true);assert.equal(sd.starts,3);
}));

test('the inherited flock stays held until the parent closes its descriptor',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'background-lock-')),file=path.join(root,'lock'),fd=fs.openSync(file,'a');
 try{
  assert.equal(spawnSync('/usr/bin/flock',['-x','3'],{stdio:['ignore','pipe','pipe',fd]}).status,0);
  assert.equal(spawnSync('/usr/bin/flock',['-n',file,'/bin/true']).status,1);
  fs.closeSync(fd);
  assert.equal(spawnSync('/usr/bin/flock',['-n',file,'/bin/true']).status,0);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('our own queued unit with a lost reply is reported as starting, not as started',()=>{
 const r=settleBackground({status:null,error:{code:'ETIMEDOUT'}},{...properties,LoadState:'loaded',ActiveState:'activating'},spec);
 assert.equal(r.ok,true);assert.equal(r.state,'starting');
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
  assert.equal(launchOnce(original,binding,1000,spec,()=>[],{root,execute}).code,'background_launch_refused');
  const retry={...original,argv:[...original.argv]};retry.argv[3]='/tmp/accepted.log';
  const r=launchOnce(retry,binding,1000,spec,()=>[],{root,execute});assert.equal(r.ok,true);assert.equal(r.log,'/tmp/accepted.log');assert.equal(starts,2);
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
  const r=launchOnce(input,binding,1000,spec,()=>[],{root:path.join(base,'missing','background-launch')});
  assert.equal(r.code,'background_state_parent_missing');assert.equal(fs.existsSync(path.join(base,'missing')),false);
 }finally{fs.rmSync(base,{recursive:true,force:true});}
});
