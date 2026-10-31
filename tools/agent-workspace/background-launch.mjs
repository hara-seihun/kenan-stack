#!/usr/bin/env node
// Root-created transient services carry the authenticated launch identity across
// detachment. User-manager metadata and inherited UUIDs never grant this identity.
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {callerToolCall} from './cache-queue.mjs';
const run=(cmd,args,opts={})=>spawnSync(cmd,args,{encoding:'utf8',timeout:10000,maxBuffer:2**20,...opts});
// Cleanup shells commonly change directory before releasing their own checkout.
// systemd still retains the original WorkingDirectory, even after that shell cd.
// Only cleanup launches change cwd; ordinary jobs retain their caller's cwd.
export function backgroundDirectory(input,home){
 const release=input.argv.some(arg=>/(?:^|[\s/;|&'"()])agent-workspace(?:[\s'";]|$)/.test(arg))
  && input.argv.some(arg=>/(?:^|[\s'";])release(?:[\s'";]|$)/.test(arg));
 return release?home:input.cwd;
}
export function backgroundSpec(input,binding,uid,gid){
 if(!binding||!Number.isSafeInteger(uid)||uid<=0||!Number.isSafeInteger(gid)||gid<0)throw Error('background_native_caller_required');
 if(!/^[a-f0-9-]{36}$/.test(binding.agentId)||!/^[-A-Za-z0-9._]{1,60}$/.test(input.name??'')||input.agentId!==binding.agentId)throw Error('background_owner_mismatch');
 if(!Array.isArray(input.argv)||!input.argv.length||input.argv.some(x=>typeof x!=='string'||x.includes('\0'))||!input.argv[0].startsWith('/')||typeof input.after!=='string'||!input.after.startsWith('/')||input.after.includes('\0')||typeof input.cwd!=='string'||!input.cwd.startsWith('/')||!Array.isArray(input.env)||input.env.some(x=>typeof x!=='string'||!x.includes('=')||x.includes('\0'))||!/^0?[0-7]{3}$/.test(input.umask??''))throw Error('background_invalid_launch');
 const unit=`kenan-bg-${binding.agentId}-${input.name}.service`;
 const description='kenan-tool-call:'+JSON.stringify({version:1,...binding,background:true,uid});
 return {unit,description};
}
// A three-second kill used to discard the D-Bus reason during manager reloads.
// Type=exec waits only for exec, not command completion; retain failed units for readback.
export function submitBackground(command,args,{execute=run}={}){return execute(command,args,{timeout:15000});}
export function launchIdentity(input){
 const argv=[...input.argv];
 // The wrapper chooses a new log and current tool call on every invocation.
 if(argv[1]==='--run')argv[3]='<log>';
 return crypto.createHash('sha256').update(JSON.stringify({cwd:input.cwd,argv,umask:input.umask})).digest('hex');
}
export function observeBackground(unit,{execute=run}={}){
 const r=execute('/usr/bin/systemctl',['--system','show',unit,'--property=LoadState,Description,ActiveState,SubState,Result,ExecMainStatus'],{timeout:10000});
 if(r.error||r.signal||!r.stdout?.includes('LoadState='))return null;
 return Object.fromEntries(r.stdout.trim().split('\n').map(line=>{const at=line.indexOf('=');return [line.slice(0,at),line.slice(at+1)];}));
}
const ACTIVE=new Set(['active','activating','deactivating','reloading','refreshing']);
const ownerOf=observed=>{try{return JSON.parse(observed.Description.slice('kenan-tool-call:'.length));}catch{return null;}};
const sameOwner=(owner,binding,uid)=>owner?.background===true&&owner.agentId===binding.agentId&&owner.channel===binding.channel&&owner.uid===uid;
// The unit's description names the tool call that created it, so a unit found after a lost reply is attributed exactly:
// ours, an earlier queued submission of the same name, or a foreign one.
export function settleBackground(result,observed,spec){
 if(result?.status===0&&!result.error)return {ok:true};
 let wanted;try{wanted=JSON.parse(spec.description.slice('kenan-tool-call:'.length));}catch{}
 if(observed&&observed.LoadState!=='not-found'){
  const owner=ownerOf(observed);
  if(!sameOwner(owner,wanted??{},wanted?.uid))return {ok:false,code:'background_owner_mismatch',retry:false};
  if(owner.callId!==wanted.callId)return {ok:false,code:'background_running',retry:false,createdBy:owner.callId,detail:'An earlier submission under this name created the unit.'};
  if(observed.ActiveState==='failed')return {ok:false,code:'background_launch_failed',retry:true,detail:`The unit failed: ${observed.Result}; exec status ${observed.ExecMainStatus}.`};
  // Ours and loaded: it runs, or is starting and will run or fail; either way its end event is raised by ExecStopPost.
  return {ok:true,state:observed.ActiveState==='activating'?'starting':undefined};
 }
 if(result&&result.status!==null&&!result.error&&!result.signal)return {ok:false,code:'background_launch_refused',retry:true,detail:(result.stderr||'The system manager rejected unit creation.').trim().slice(0,4000)};
 // No reply and no unit yet. The reservation stays pending; the next identical launch reconciles it (finds the unit or
 // the job's log if it started, or submits it once if it never did).
 return {ok:false,code:'background_launch_outcome_unknown',retry:true,detail:`systemd gave no answer (${result?.error?.code||result?.signal||'no reply'}) and no unit exists yet. Run the same kenan-bg command again: it reports the job if it started, or starts it exactly once if it never did.`};
}
export const BACKGROUND_ROOT='/var/lib/agent-workspace/background-launch';
// The wrapper's argv carries its log twice (argv[3] and the ExecStopPost line); a resubmission keeps the original log.
export function withLog(input,log){
 if(input.argv[1]!=='--run'||!log||input.argv[3]===log)return input;
 const argv=[...input.argv],old=argv[3];argv[3]=log;
 return {...input,argv,after:input.after.endsWith(' '+old)?input.after.slice(0,-old.length)+log:input.after};
}
// Only the leaf is created: a missing parent is an error, never a tree a root process invents (2026-10-28: creating
// /var/lib/pi-stack recursively as root 0700 made every model call fail for 3.5 hours).
// A name is reserved while its job runs. The reservation holds a pending state from just before systemd-run until its
// reply; holding the lock proves the submitting process is gone, so a pending record is settled from what exists: the
// unit (attributed by the tool call in its description) or the job's log (the wrapper creates it when the job starts).
// Neither means the job never started, and it is submitted once more with its original log.
export function launchOnce(input,binding,uid,spec,argsFor,{root=BACKGROUND_ROOT,execute=run,exists=fs.existsSync}={}){
 try{fs.mkdirSync(root,{mode:0o700});}catch(error){
  if(error.code==='ENOENT')return {ok:false,code:'background_state_parent_missing',retry:false,detail:`${path.dirname(root)} must exist before background launches can be recorded.`};
  if(error.code!=='EEXIST')throw error;
 }
 const key=spec.unit,file=`${root}/${key}.json`,fd=fs.openSync(`${root}/${key}.lock`,'a',0o600);
 try{
  // flock locks the inherited open file description; our fd retains it after
  // flock exits. Process death releases it automatically, without stale locks.
  const lock=execute('/usr/bin/flock',['--exclusive','--wait','10','3'],{stdio:['ignore','pipe','pipe',fd],timeout:11000});
  if(lock.status!==0||lock.error)return {ok:false,code:'background_launch_busy',retry:true,detail:'Another launch of this name is in progress; run the command again.'};
  const identity=launchIdentity(input);let saved;
  try{saved=JSON.parse(fs.readFileSync(file,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
  const write=value=>{const tmp=file+'.tmp';const out=fs.openSync(tmp,'w',0o600);try{fs.writeFileSync(out,JSON.stringify(value)+'\n');fs.fsyncSync(out);}finally{fs.closeSync(out);}fs.renameSync(tmp,file);const dir=fs.openSync(root,'r');try{fs.fsyncSync(dir);}finally{fs.closeSync(dir);}};
  const accept=(record,extra)=>{const response={ok:true,unit:spec.unit,log:record.log,identity:binding,...extra};write({...record,state:'accepted',response});return response;};
  let launch=input,loaded=false;
  if(saved){
   if(saved.channel!==binding.channel||saved.uid!==uid)return {ok:false,code:'background_name_conflict',retry:false,detail:'This name belongs to another owner.'};
   const observed=observeBackground(spec.unit,{execute});
   if(observed===null)return {ok:false,code:'background_launch_busy',retry:true,detail:'systemd did not answer the unit query; run the command again.'};
   loaded=observed.LoadState!=='not-found';
   if(loaded&&!sameOwner(ownerOf(observed),binding,uid))return {ok:false,code:'background_owner_mismatch',retry:false};
   const same=saved.identity===identity;
   if(loaded&&ACTIVE.has(observed.ActiveState)){
    if(!same)return {ok:false,code:'background_running',retry:false,detail:`A different command is still running under this name (log ${saved.log}). Pick another NAME, or kenan-bg stop it first.`};
    return accept(saved,{reused:true,state:'running'});
   }
   const ran=saved.state==='accepted'||(saved.state==='pending'&&(loaded||saved.log!=null&&exists(saved.log)));
   // The same command under the same name has already run: a retry after a lost reply must not run it twice.
   if(same&&ran)return accept(saved,{reused:true,state:'ended'});
   if(same&&saved.state==='pending')launch=withLog(input,saved.log);
  }
  const log=launch.argv[1]==='--run'?launch.argv[3]:null;
  const record={identity,channel:binding.channel,uid,callId:binding.callId,log,state:'pending'};
  // A retained failed unit of an earlier job holds the name until it is reset.
  if(loaded)execute('/usr/bin/systemctl',['--system','reset-failed',spec.unit],{timeout:10000});
  write(record);
  const result=submitBackground('/usr/bin/systemd-run',argsFor(launch),{execute});
  // systemd-run's own success means it created this exact unit (an existing name is a refusal), so only an unclear or
  // missing reply needs the extra manager query: under a CPU-starved agent slice each process costs up to a second.
  const observed=result?.status===0&&!result.error?null:observeBackground(spec.unit,{execute});
  const verdict=settleBackground(result,observed,spec);
  if(verdict.ok)return accept(record,verdict.state?{state:verdict.state}:{});
  // An earlier queued submission of this same command won the name: that is this job.
  if(verdict.code==='background_running'&&saved?.identity===identity&&verdict.createdBy===saved.callId)return accept({...record,callId:saved.callId},{reused:true,state:'running'});
  const response={...verdict,unit:spec.unit,log,identity:binding};
  if(verdict.code==='background_running')response.detail='A different command started under this name first. Pick another NAME, or kenan-bg stop it first.';
  if(verdict.code!=='background_launch_outcome_unknown')write({...record,state:'refused',response});
  return response;
 }finally{fs.closeSync(fd);}
}
export function main(){
 if(process.getuid()!==0)throw Error('background_root_required');
 let diagnostic;
 const binding=callerToolCall({background:false,onError:value=>{diagnostic=value;}});
 if(!binding&&diagnostic)throw Error(`background_native_caller_required: ${diagnostic.code}: ${diagnostic.detail}`);
 const uid=Number(process.env.SUDO_UID),gid=Number(process.env.SUDO_GID);
 const input=JSON.parse(fs.readFileSync(0,'utf8'));
 const spec=backgroundSpec(input,binding,uid,gid);
 if(process.argv[2]==='status'||process.argv[2]==='stop'){
  const observed=run('/usr/bin/systemctl',['--system','show',spec.unit,'--property=Description,LoadState,SubState']);
  const properties=Object.fromEntries(observed.stdout.trim().split('\n').map(line=>{const at=line.indexOf('=');return [line.slice(0,at),line.slice(at+1)];}));
  if(properties.LoadState==='not-found'){
   if(process.argv[2]==='status'){
    // A launch whose caller was cut off before systemd answered: the job never started, and the same command starts it.
    let saved;try{saved=JSON.parse(fs.readFileSync(`${BACKGROUND_ROOT}/${spec.unit}.json`,'utf8'));}catch{}
    console.log(saved?.state==='pending'&&saved.log&&!fs.existsSync(saved.log)?'not-started':'inactive');process.exitCode=3;
   }
   return;
  }
  if(observed.status!==0||properties.Description!==spec.description) {
   // A new native call by the same worker may manage its previous launch.
   let prior;try{prior=JSON.parse((properties.Description??'').slice('kenan-tool-call:'.length));}catch{}
   if(!prior?.background||prior.agentId!==binding.agentId||prior.channel!==binding.channel||prior.uid!==uid)throw Error('background_owner_mismatch');
  }
  if(process.argv[2]==='status'&&properties.SubState==='exited'){console.log('inactive');return;}
  const result=run('/usr/bin/systemctl',['--system',process.argv[2]==='stop'?'stop':'is-active',spec.unit]);
  process.stdout.write(result.stdout);process.stderr.write(result.stderr);process.exitCode=result.status;return;
 }
 if(process.argv[2]!=='launch')throw Error('background_invalid_command');
 // All background jobs share user-agents-kenanbg.slice (Kenan Stack deploy/priority), weighted as one agent command, so
 // they can't crowd out the agents' own shells (2026-10-30: 17 jobs as separate siblings left each shell 0.05 CPU).
 // A durable name reservation and kernel-held lock prevent retry races. Unit
 // failures remain available for readback after their processes have exited.
 const argsFor=input=>['--system','--quiet','--expand-environment=no','--property=Type=exec',`--unit=${spec.unit}`,`--uid=${uid}`,`--gid=${gid}`,`--working-directory=${backgroundDirectory(input,fs.readFileSync('/etc/passwd','utf8').split('\n').find(line=>line.split(':')[2]===String(uid))?.split(':')[5]||'/')}`,`--description=${spec.description}`,'--property=MemoryMax=8G','--property=MemorySwapMax=0','--property=OOMPolicy=continue',`--property=UMask=${input.umask}`,'--property=Slice=user-agents-kenanbg.slice','--property=CPUQuota=200%','--property=CPUWeight=10',`--property=ExecStopPost=${input.after}`,...input.env.filter(x=>!x.startsWith('KENAN_TOOL_CALL_ID=')&&!x.startsWith('KENAN_BG_NATIVE=')).map(x=>'--setenv='+x),'--setenv=KENAN_BG_NATIVE=1','--',...input.argv];
 const response=launchOnce(input,binding,uid,spec,argsFor);
 if(!response.ok){console.error(JSON.stringify({ok:false,error:response}));process.exitCode=response.code==='background_launch_outcome_unknown'?75:2;return;}
 console.log(JSON.stringify(response));

}
if(process.argv[1]&&new URL(import.meta.url).pathname===fs.realpathSync(process.argv[1])){try{main();}catch(error){console.error(error.message);process.exitCode=2;}}
