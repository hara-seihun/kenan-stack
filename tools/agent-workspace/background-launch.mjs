#!/usr/bin/env node
// Root-created transient services carry the authenticated launch identity across
// detachment. User-manager metadata and inherited UUIDs never grant this identity.
import fs from 'node:fs';
import crypto from 'node:crypto';
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
export function settleBackground(result,observed,spec){
 if(observed&&observed.LoadState!=='not-found'){
  let owner;try{owner=JSON.parse(observed.Description.slice('kenan-tool-call:'.length));}catch{}
  let wanted;try{wanted=JSON.parse(spec.description.slice('kenan-tool-call:'.length));}catch{}
  if(!owner?.background||owner.agentId!==wanted?.agentId||owner.channel!==wanted?.channel||owner.uid!==wanted?.uid)return {ok:false,code:'background_owner_mismatch',retry:false};
  if(result?.status===0&&!result.error)return {ok:true};
  if(observed.ActiveState==='activating')return {ok:false,code:'background_launch_outcome_unknown',retry:false,detail:'The exact unit is still starting; the command has not confirmed exec yet.'};
  if(observed.ActiveState==='failed')return {ok:false,code:'background_launch_failed',retry:false,detail:`The unit failed: ${observed.Result}; exec status ${observed.ExecMainStatus}.`};
  return {ok:true};
 }
 if(result?.status===0&&!result.error)return {ok:true};
 if(result&&result.status!==null&&!result.error&&!result.signal)return {ok:false,code:'background_launch_refused',retry:true,detail:(result.stderr||'The system manager rejected unit creation.').trim().slice(0,4000)};
 // Absence after a lost D-Bus reply is not evidence of non-execution. Keep the
 // reservation, so a retry cannot replay effects even after a process crash.
 return {ok:false,code:'background_launch_outcome_unknown',retry:false,detail:result?.error?.code||result?.signal||'The original submission has no authoritative reply.'};
}
export function launchOnce(input,binding,uid,spec,args,{root='/var/lib/pi-stack/background-launch',execute=run}={}){
 fs.mkdirSync(root,{recursive:true,mode:0o700});
 const key=spec.unit,file=`${root}/${key}.json`,fd=fs.openSync(`${root}/${key}.lock`,'a',0o600);
 try{
  // flock locks the inherited open file description; our fd retains it after
  // flock exits. Process death releases it automatically, without stale locks.
  const lock=execute('/usr/bin/flock',['--exclusive','--wait','10','3'],{stdio:['ignore','pipe','pipe',fd],timeout:11000});
  if(lock.status!==0||lock.error)return {ok:false,code:'background_launch_busy',retry:true,detail:'The same named submission is still being reconciled.'};
  const identity=launchIdentity(input);let saved;
  try{saved=JSON.parse(fs.readFileSync(file,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
  if(saved&&(saved.identity!==identity||saved.channel!==binding.channel||saved.uid!==uid))return {ok:false,code:'background_name_conflict',retry:false,detail:'This name already belongs to a different command, directory or owner. Use its original status receipt.'};
  if(saved?.state==='accepted')return {...saved.response,reused:true};
  const write=value=>{const tmp=file+'.tmp';const out=fs.openSync(tmp,'w',0o600);try{fs.writeFileSync(out,JSON.stringify(value)+'\n');fs.fsyncSync(out);}finally{fs.closeSync(out);}fs.renameSync(tmp,file);const dir=fs.openSync(root,'r');try{fs.fsyncSync(dir);}finally{fs.closeSync(dir);}};
  const log=saved?.state==='pending'?saved.log:(input.argv[1]==='--run'?input.argv[3]:null);
  const record={identity,channel:binding.channel,uid,log,state:'pending'};
  let result;
  if(!saved||saved.state==='refused'){
   write(record);
   result=submitBackground('/usr/bin/systemd-run',args,{execute});
  }
  const observed=observeBackground(spec.unit,{execute});
  const verdict=settleBackground(result,observed,spec);
  const response={...verdict,unit:spec.unit,log,identity:binding};
  if(verdict.ok)write({...record,state:'accepted',response});
  else if(verdict.retry)write({...record,state:'refused',response});
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
  if(properties.LoadState==='not-found'){if(process.argv[2]==='status'){console.log('inactive');process.exitCode=3;}return;}
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
 // A durable name reservation and kernel-held lock prevent retry races. Unit
 // failures remain available for readback after their processes have exited.
 const args=['--system','--quiet','--expand-environment=no','--property=Type=exec',`--unit=${spec.unit}`,`--uid=${uid}`,`--gid=${gid}`,`--working-directory=${backgroundDirectory(input,fs.readFileSync('/etc/passwd','utf8').split('\n').find(line=>line.split(':')[2]===String(uid))?.split(':')[5]||'/')}`,`--description=${spec.description}`,'--property=MemoryMax=8G','--property=MemorySwapMax=0','--property=OOMPolicy=continue',`--property=UMask=${input.umask}`,'--property=Slice=user-agents.slice','--property=CPUQuota=200%','--property=CPUWeight=10',`--property=ExecStopPost=${input.after}`,...input.env.filter(x=>!x.startsWith('KENAN_TOOL_CALL_ID=')&&!x.startsWith('KENAN_BG_NATIVE=')).map(x=>'--setenv='+x),'--setenv=KENAN_BG_NATIVE=1','--',...input.argv];
 const response=launchOnce(input,binding,uid,spec,args);
 if(!response.ok){console.error(JSON.stringify({ok:false,error:response}));process.exitCode=response.code==='background_launch_outcome_unknown'?75:2;return;}
 console.log(JSON.stringify(response));

}
if(process.argv[1]&&new URL(import.meta.url).pathname===fs.realpathSync(process.argv[1])){try{main();}catch(error){console.error(error.message);process.exitCode=2;}}
