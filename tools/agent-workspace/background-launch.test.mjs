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
 assert.equal(absent.code,'background_launch_outcome_unknown');assert.equal(absent.retry,false);assert.match(absent.detail,/never permits replay/);
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
  const other=launchOnce({...retry,cwd:'/different'},binding,1000,spec,()=>[],{root,execute});assert.equal(other.code,'background_name_conflict');assert.equal(other.original.log,'/tmp/first.log');assert.equal(starts,1);
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
test('a caller cut off before systemd answered remains uncertain and cannot replay from absence alone',()=>withRoot(root=>{
 const sd=fakeSystemd([lost]);
 assert.equal(launchOnce(wrapped('/tmp/first.log'),binding,1000,spec,x=>x.argv,{root,execute:sd.execute,exists:()=>false}).code,'background_launch_outcome_unknown');
 const r=launchOnce(wrapped('/tmp/second.log'),{...binding,callId:'retry-call'},1000,spec,x=>[...x.argv,x.after],{root,execute:sd.execute,exists:()=>false});
 assert.equal(r.code,'background_launch_outcome_unknown');assert.equal(r.original.log,'/tmp/first.log');assert.equal(sd.starts,1);
}));
test('a cut-off launch whose job did start is reported, not run again',()=>withRoot(root=>{
 const sd=fakeSystemd([lost]);
 launchOnce(wrapped('/tmp/first.log'),binding,1000,spec,x=>x.argv,{root,execute:sd.execute});
 // Started and already finished: its unit is collected but the wrapper created its log.
 const r=launchOnce(wrapped('/tmp/second.log'),binding,1000,spec,x=>x.argv,{root,execute:sd.execute,exists:f=>f==='/tmp/first.log'});
 assert.equal(r.code,'background_launch_outcome_unknown');assert.equal(sd.starts,1);
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
 sd.units.set(spec.unit,{ActiveState:'active',Description:earlier});
 const laterSpec=backgroundSpec(input,{...binding,callId:'retry-call'},1000,1000);
 const r=launchOnce(wrapped('/tmp/second.log'),{...binding,callId:'retry-call'},1000,laterSpec,x=>x.argv,{root,execute:sd.execute,exists:()=>false});
 assert.equal(r.ok,true);assert.equal(r.state,'running');assert.equal(r.log,'/tmp/first.log');
}));
test('terminal reconciliation permits different effects and keeps historical retries idempotent',()=>withRoot(root=>{
 const sd=fakeSystemd([]),first=path.join(root,'a.log'),second=path.join(root,'b.log');
 assert.equal(launchOnce(wrapped(first),binding,1000,spec,x=>x.argv,{root,execute:sd.execute}).ok,true);
 const busy=launchOnce(wrapped(second,'/bin/false'),binding,1000,spec,x=>x.argv,{root,execute:sd.execute});
 assert.equal(busy.code,'background_running');assert.equal(busy.original.log,first);assert.equal(sd.starts,1);
 sd.units.delete(spec.unit);
 const missing=launchOnce(wrapped(second,'/bin/false'),binding,1000,spec,x=>x.argv,{root,execute:sd.execute});
 assert.equal(missing.code,'background_name_conflict');assert.equal(sd.starts,1);
 fs.writeFileSync(first,'[kenan-bg] end '+JSON.stringify({exitCode:0,outcome:'success',endedAt:new Date().toISOString()})+'\n');
 const fresh=launchOnce(wrapped(second,'/bin/false'),binding,1000,spec,x=>x.argv,{root,execute:sd.execute});
 assert.equal(fresh.ok,true);assert.equal(fresh.log,second);assert.equal(sd.starts,2);
 const historic=launchOnce(wrapped('/irrelevant/log'),binding,1000,spec,x=>x.argv,{root,execute:sd.execute});
 assert.equal(historic.reused,true);assert.equal(historic.state,'ended');assert.equal(historic.log,first);assert.equal(sd.starts,2);
 // A retained failed unit is not collected and is not automatically reset to authorize reuse.
 sd.units.set(spec.unit,{ActiveState:'failed',Description:spec.description});
 fs.writeFileSync(second,'[kenan-bg] end '+JSON.stringify({exitCode:1,outcome:'failed',endedAt:new Date().toISOString()})+'\n');
 assert.equal(launchOnce(wrapped('/tmp/c.log','/bin/echo'),binding,1000,spec,x=>x.argv,{root,execute:sd.execute}).code,'background_name_conflict');assert.equal(sd.starts,2);
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

// Ended units, failed ones included, are unloaded: 1,265 retained failed units made every daemon-reload 3x slower (2026-10-31).
test('ended jobs neither stay active nor stay loaded in the system manager',()=>{
 const source=fs.readFileSync(new URL('./background-launch.mjs',import.meta.url),'utf8');
 assert.equal(source.includes('--property=RemainAfterExit=yes'),false);
 assert.equal(source.includes("'--collect'"),true);
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
import {stopBackground,escapedGroups} from './background-launch.mjs';
// A job like the 2026-10-31 one: the unit holds the kenan-bg wrapper (10) and cpu-slot (11); cpu-slot's scope holds
// node --test (20) and its CPU-bound child (21), which never runs its SIGTERM handler. Nothing dies until SIGKILL.
function stuckJob({foreignInScope=false}={}){
 const unit='/system.slice/kenan-bg-x.service',scope='/user.slice/user-1990.slice/user@1990.service/heavy.slice/cpu-slot-x.scope';
 const s={alive:new Set([10,11,20,21]),stopQueued:false,log:[],t:0,env:{},mortal:new Set(),where:null,tree:null};
 const where={10:unit,11:unit,20:scope,21:scope,99:scope};
 if(foreignInScope)s.alive.add(99);
 const tree={10:[11],11:[20],20:[21]};
 s.where=where;s.tree=tree;
 s.proc={
  procs:g=>[...s.alive].filter(p=>where[p]===g),
  children:p=>(tree[p]??[]).filter(c=>s.alive.has(c)),
  cgroupOf:p=>s.alive.has(p)?where[p]:null,
  start:p=>s.alive.has(p)?'1000':null,
  marked:entry=>[...s.alive].filter(p=>s.env[p]===entry),
  kill:(p,sig)=>{s.log.push(`${sig}:${p}`);if(sig==='SIGKILL'||s.mortal.has(p))s.alive.delete(p);},
  killGroup:g=>{s.log.push(`cgroup.kill:${g}`);for(const p of [...s.alive])if(where[p]===g)s.alive.delete(p);},
 };
 // Like systemd: the stop SIGTERMs the unit, the wrapper (main, 10) exits, and ExecStopPost (30, with a child 31) runs
 // at once, while cpu-slot (11) is still alive in the unit.
 s.execute=(cmd,args)=>{
  if(args[1]==='stop'){assert.deepEqual(args,['--system','stop','--no-block','kenan-bg-x.service']);s.stopQueued=true;s.log.push('stop');
   s.alive.delete(10);s.alive.add(30);s.alive.add(31);where[30]=where[31]=unit;tree[30]=[31];return {status:0};}
  if(s.unitGone)return {status:0,stdout:'ControlGroup=\nControlPID=0\n'};
  return {status:0,stdout:`ControlGroup=${unit}\nControlPID=${s.alive.has(30)?30:0}\n`};
 };
 s.clock={now:()=>s.t,sleep:ms=>{s.t+=ms;}};
 return {s,unit,scope};
}
test('kenan-bg stop ends a job whose CPU-bound Node child ignores SIGTERM, including the processes in its cpu-slot scope',()=>{
 const {s,scope}=stuckJob();
 const r=stopBackground('kenan-bg-x.service',{execute:s.execute,proc:s.proc,...s.clock});
 assert.equal(r.state,'stopped');assert.equal(r.forced,true);assert.deepEqual(r.scopes,[scope]);assert.equal(r.survivors,undefined);
 assert.deepEqual([...s.alive].sort(),[30,31]);
 // The stop is queued with systemd before anything else, so a caller cut off mid-stop still stops the unit.
 assert.equal(s.log[0],'stop');assert.ok(s.log.includes('SIGTERM:20')&&s.log.includes('SIGTERM:21'));
 assert.ok(s.log.indexOf('SIGKILL:11')>s.log.indexOf('SIGTERM:21'));
 // ExecStopPost, which raises the job's end event, is left to finish.
 assert.ok(s.alive.has(30)&&s.alive.has(31)&&!s.log.some(l=>/:3[01]$/.test(l)));
 assert.ok(s.t>=3000&&s.t<=5000,`the whole stop is bounded (${s.t} ms)`);
});
test('a stop that SIGTERM ends promptly is never escalated, and a still-running job is never reported stopped',()=>{
 const quick=stuckJob();const kill=quick.s.proc.kill;
 quick.s.proc.kill=(p,sig)=>{kill(p,'SIGKILL');quick.s.log.push('graceful');};
 const execute=quick.s.execute;quick.s.execute=(cmd,args,o)=>{const r=execute(cmd,args,o);if(args[1]==='stop')quick.s.alive.delete(11);return r;};
 const r=stopBackground('kenan-bg-x.service',{execute:quick.s.execute,proc:quick.s.proc,...quick.s.clock});
 assert.equal(r.state,'stopped');assert.equal(r.forced,false);assert.ok(quick.s.t<3000);
 const immortal=stuckJob();immortal.s.proc.kill=()=>{};immortal.s.proc.killGroup=()=>{};
 assert.equal(stopBackground('kenan-bg-x.service',{execute:immortal.s.execute,proc:immortal.s.proc,...immortal.s.clock}).state,'stopping');
});
test('a control group shared with anything outside the job is not the job\'s to kill',()=>{
 const {s,unit}=stuckJob({foreignInScope:true});
 assert.deepEqual(escapedGroups(unit,s.proc),[]);
});
import {socketPeer} from './background-launch.mjs';
test('the launch socket takes its caller from the peer the kernel reported in the instance name, never from the request',()=>{
 // systemd 259 on kenan-server names a connection "0-21202-3022292_116236682-1000"; older systemd "0-3022292-1000".
 assert.deepEqual(socketPeer('0-21202-3022292_116236682-1000'),{pid:3022292,uid:1000});
 assert.deepEqual(socketPeer('7-3022292-1990'),{pid:3022292,uid:1990});
 for(const bad of [undefined,'','x-1-2','1-2','0-1-2-3-4'])assert.throws(()=>socketPeer(bad),/background_invalid_peer/);
});
import {jobMarker} from './background-launch.mjs';
// 2026-10-31: a stop answered {state: stopped, escaped: [scope]} and the caller read "escaped" as "got away", though the
// scope had ended on the SIGTERM. The answer now names the scopes it stopped and lists survivors only when there are some.
test('a cpu-slot scope that ends on SIGTERM is reported as stopped, with no survivors',()=>{
 const {s,scope}=stuckJob();for(const p of [20,21])s.mortal.add(p);
 const execute=s.execute;s.execute=(cmd,args,o)=>{const r=execute(cmd,args,o);if(args[1]==='stop')s.alive.delete(11);return r;};
 const r=stopBackground('kenan-bg-x.service',{execute:s.execute,proc:s.proc,...s.clock});
 assert.deepEqual(r,{unit:'kenan-bg-x.service',state:'stopped',forced:false,scopes:[scope]});
});
test('a job process that outlives SIGKILL is listed as a survivor, and the stop says stopping',()=>{
 const {s,scope}=stuckJob();s.proc.killGroup=()=>{};const kill=s.proc.kill;s.proc.kill=(p,sig)=>{if(p!==21)kill(p,sig);};
 const r=stopBackground('kenan-bg-x.service',{execute:s.execute,proc:s.proc,...s.clock});
 assert.equal(r.state,'stopping');assert.equal(r.forced,true);assert.deepEqual(r.survivors,[{pid:21,cgroup:scope}]);
});
test('a cpu-slot scope started while the stop is under way is found and stopped too',()=>{
 const {s,unit}=stuckJob();const late='/heavy.slice/cpu-slot-late.scope';
 // cpu-slot (11) starts a second job (40) into its own scope just after the stop was queued.
 const execute=s.execute;s.execute=(cmd,args,o)=>{const r=execute(cmd,args,o);
  if(args[1]==='stop'){s.alive.add(40);s.where[40]=late;s.tree[11]=[20,40];}return r;};
 const r=stopBackground('kenan-bg-x.service',{execute:s.execute,proc:s.proc,...s.clock});
 assert.equal(r.state,'stopped');assert.ok(r.scopes.includes(late));assert.ok(!s.alive.has(40));
 assert.ok(s.log.includes('SIGTERM:40'));
});
test('a repeated stop, after the unit is gone and the scope lost its parent, still finds the scope by the job marker; then it is a no-op',()=>{
 const {s,scope}=stuckJob();const marker=jobMarker('kenan-bg-x.service','/var/tmp/kenan-bg/u/x-1.log');
 // The unit ended (its wrapper and cpu-slot died) but the scope's processes were reparented and run on.
 s.unitGone=true;s.alive.delete(10);s.alive.delete(11);s.env[20]=s.env[21]=marker;
 // An unrelated process in another scope with another launch's marker is left alone.
 s.alive.add(50);s.where[50]='/heavy.slice/cpu-slot-other.scope';s.env[50]=jobMarker('kenan-bg-x.service','/var/tmp/kenan-bg/u/x-2.log');
 const r=stopBackground('kenan-bg-x.service',{marker,execute:s.execute,proc:s.proc,...s.clock});
 assert.equal(r.state,'stopped');assert.deepEqual(r.scopes,[scope]);assert.ok(!s.alive.has(20)&&!s.alive.has(21)&&s.alive.has(50));
 assert.ok(!s.log.includes('stop'),'no systemd stop is queued for a unit that is gone');
 assert.deepEqual(stopBackground('kenan-bg-x.service',{marker,execute:s.execute,proc:s.proc,...s.clock}),{unit:'kenan-bg-x.service',state:'stopped',forced:false,scopes:[]});
});
test('a marked job process in a control group shared with others is killed alone, never with its whole group',()=>{
 const {s}=stuckJob({foreignInScope:true});s.unitGone=true;s.alive.delete(10);s.alive.delete(11);
 const marker=jobMarker('kenan-bg-x.service','/l');s.env[20]=s.env[21]=marker;
 const r=stopBackground('kenan-bg-x.service',{marker,execute:s.execute,proc:s.proc,...s.clock});
 assert.equal(r.state,'stopped');assert.ok(s.alive.has(99));assert.ok(!s.log.some(l=>l.startsWith('cgroup.kill')));
});

import {backgroundStatus,terminalBackground} from './background-launch.mjs';
test('native status uses one bounded query and uncertainty never becomes inactive',()=>{
 let calls=0;
 const execute=(cmd,args,opts)=>{calls++;assert.equal(opts.timeout,2000);assert.equal(args[1],'show');return {status:0,stdout:'LoadState=loaded\nDescription='+spec.description+'\nActiveState=active\nSubState=running\n'};};
 assert.equal(backgroundStatus(spec,binding,1000,{execute}).state,'active');assert.equal(calls,1);
 assert.equal(backgroundStatus(spec,binding,1000,{execute:()=>({error:{code:'ETIMEDOUT'}})}).state,'unknown');
 assert.equal(backgroundStatus(spec,binding,1000,{execute:()=>({status:0,stdout:'LoadState=not-found\n'})}).state,'inactive');
});
test('terminal log lookup reads a bounded tail even for a huge sparse log',()=>withRoot(root=>{
 const log=path.join(root,'huge.log'),fd=fs.openSync(log,'w');
 fs.ftruncateSync(fd,2**30);const value={exitCode:0,outcome:'success',endedAt:'2026-11-02T21:00:00Z'};
 fs.writeSync(fd,'\n[kenan-bg] end '+JSON.stringify(value)+'\n',2**30);fs.closeSync(fd);
 assert.deepEqual(terminalBackground(log),value);assert.equal(terminalBackground(log+'.absent'),null);
}));

import {controlSpec,serveActions} from './background-launch.mjs';
test('status accepts a non-executable control request while old launchers fail closed',()=>{
 const request={...input,argv:[],after:''};assert.throws(()=>backgroundSpec(request,binding,1000,1000),/invalid_launch/);
 assert.equal(controlSpec(request,binding,1000,1000).unit,spec.unit);assert.ok(serveActions.includes('status'));
 assert.throws(()=>controlSpec({...request,agentId:'foreign'},binding,1000,1000),/owner_mismatch/);
});

test('native status returns the owned original receipt, never another worker log glob',()=>withRoot(root=>{
 fs.writeFileSync(path.join(root,spec.unit+'.json'),JSON.stringify({uid:1000,channel:binding.channel,log:'/original/exact.log'}));
 const execute=()=>({status:0,stdout:'LoadState=not-found\n'});
 assert.equal(backgroundStatus(spec,binding,1000,{root,execute}).log,'/original/exact.log');
 assert.equal(backgroundStatus(spec,binding,1001,{root,execute}).code,'background_owner_mismatch');
}));
