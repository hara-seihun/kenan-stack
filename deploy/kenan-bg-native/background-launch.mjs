#!/usr/bin/env node
import { hostname } from 'node:os';
// Root-created transient services carry the authenticated launch identity across
// detachment. User-manager metadata and inherited UUIDs never grant this identity.
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {callerToolCall} from './cache-queue.mjs';
import {NATIVE_CUSTODIAN_ID} from './owner-liveness.mjs';
const run=(cmd,args,opts={})=>spawnSync(cmd,args,{encoding:'utf8',timeout:10000,maxBuffer:2**20,...opts});
export function backgroundSpec(input,binding,uid,gid){
 if(input.keep!==undefined&&typeof input.keep!=='boolean')throw Error('background_invalid_keep');
 if(!binding||!Number.isSafeInteger(uid)||uid<=0||!Number.isSafeInteger(gid)||gid<0)throw Error('background_native_caller_required');
 if(!NATIVE_CUSTODIAN_ID.test(binding.agentId)||!/^[-A-Za-z0-9._]{1,60}$/.test(input.name??'')||input.agentId!==binding.agentId)throw Error('background_owner_mismatch');
 if(!Array.isArray(input.argv)||!input.argv.length||input.argv.some(x=>typeof x!=='string'||x.includes('\0'))||!input.argv[0].startsWith('/')||typeof input.after!=='string'||!input.after.startsWith('/')||input.after.includes('\0')||typeof input.cwd!=='string'||!input.cwd.startsWith('/')||!Array.isArray(input.env)||input.env.some(x=>typeof x!=='string'||!x.includes('=')||x.includes('\0'))||!/^0?[0-7]{3}$/.test(input.umask??''))throw Error('background_invalid_launch');
 const unit=`kenan-bg-${binding.agentId}-${input.name}.service`;
 const description='kenan-tool-call:'+JSON.stringify({version:1,...binding,background:true,keep:input.keep===true,uid});
 return {unit,description};
}
// A three-second kill used to discard the D-Bus reason during manager reloads.
// Type=exec waits only for exec, not command completion. Units are collected when they end (--collect): the job's log end
// line and its job:AGENT:NAME event carry the outcome. Retaining failed units left 1,265 dead ones loaded in PID 1 by
// 2026-10-31, which tripled every daemon-reload (1.6 s to 4.5 s, PID 1 blocked meanwhile) and stalled every agent's
// tool-call scope behind back-to-back reloads (a 20 s timeout on a plain grep).
export function submitBackground(command,args,{execute=run,env}={}){return execute(command,args,{timeout:15000,...(env?{env}:{})});}
export function launchIdentity(input){
 const argv=[...input.argv];
 // The wrapper chooses a new log and current tool call on every invocation.
 if(argv[1]==='--run')argv[3]='<log>';
 return crypto.createHash('sha256').update(JSON.stringify({cwd:input.cwd,argv,umask:input.umask,...(input.keep?{keep:true}:{}),env:input.env.filter(x=>!x.startsWith('KENAN_BG_STDIN=')).sort()})).digest('hex');
}
export function observeBackground(unit,{execute=run}={}){
 const r=execute('/usr/bin/systemctl',['--system','show',unit,'--property=LoadState,Description,ActiveState,SubState,Result,ExecMainCode,ExecMainStatus,ExecMainExitTimestamp,MainPID,ControlGroup'],{timeout:2000});
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
  if(observed.ActiveState==='failed')return {ok:false,code:'background_launch_failed',retry:false,detail:`The unit failed: ${observed.Result}; exec status ${observed.ExecMainStatus}.`};
  // Ours and loaded: it runs, or is starting and will run or fail; either way its end event is raised by ExecStopPost.
  return {ok:true,state:observed.ActiveState==='activating'?'starting':undefined};
 }
 if(result&&result.status!==null&&!result.error&&!result.signal)return {ok:false,code:'background_launch_refused',retry:true,detail:(result.stderr||'The system manager rejected unit creation.').trim().slice(0,4000)};
 // No reply and no unit yet. The reservation stays pending until its original
 // effect is reconciled; an absent unit does not authorize another submission.
 return {ok:false,code:'background_launch_outcome_unknown',retry:false,detail:`systemd gave no answer (${result?.error?.code||result?.signal||'no reply'}); reconcile the original unit and log. Absence alone never permits replay.`};
}
// kenan-bg stop. SIGTERM can't interrupt a long synchronous computation (a CPU-bound node --test child kept 2.8 GB
// after a stop, 2026-10-31), and cpu-slot runs each job in its own scope outside this unit, where stopping the unit never
// reaches it. So the stop is queued with systemd first (it happens even if this caller is cut off), then the job's
// processes outside the unit are found two ways, looked for again on every poll so a scope started mid-stop is caught too:
// by ancestry from the unit, and by the KENAN_BG_JOB marker every job process inherits (it survives reparenting, so a
// repeated stop after the unit is gone still finds a scope whose parent died). Everything gets SIGTERM, and whatever is
// left after graceMs gets SIGKILL (systemd's own escalation waits TimeoutStopSec, 90 s, after ExecStopPost).
// The answer is "stopped" only once none of the job's processes is left; "stopping" lists the survivors.
const procFs={
 procs(group){
  const out=[];const walk=dir=>{let entries;try{out.push(...fs.readFileSync(dir+'/cgroup.procs','utf8').split('\n').filter(Boolean).map(Number));entries=fs.readdirSync(dir,{withFileTypes:true});}catch{return;}
   for(const e of entries)if(e.isDirectory())walk(dir+'/'+e.name);};
  walk('/sys/fs/cgroup'+group);return out;
 },
 children(pid){let tasks;try{tasks=fs.readdirSync(`/proc/${pid}/task`);}catch{return [];}
  return tasks.flatMap(t=>{try{return fs.readFileSync(`/proc/${pid}/task/${t}/children`,'utf8').split(' ').filter(Boolean).map(Number);}catch{return [];}});},
 // Every process whose environment carries this exact entry.
 marked(entry){
  const out=[];for(const name of fs.readdirSync('/proc')){if(!/^\d+$/.test(name))continue;
   let env;try{env=fs.readFileSync(`/proc/${name}/environ`);}catch{continue;}
   if(env.includes(entry)&&env.toString('latin1').split('\0').includes(entry))out.push(Number(name));}
  return out;
 },
 cgroupOf(pid){try{return fs.readFileSync(`/proc/${pid}/cgroup`,'utf8').match(/^0::(.*)$/m)?.[1]??null;}catch{return null;}},
 // null for a process that is gone or a zombie (already dead, only waiting to be reaped).
 start(pid){try{const f=fs.readFileSync(`/proc/${pid}/stat`,'utf8').split(') ').at(-1).split(' ');return f[0]==='Z'||f[0]==='X'?null:f[19];}catch{return null;}},
 kill(pid,signal){try{process.kill(pid,signal);return true;}catch{return false;}},
 killGroup(group){try{fs.writeFileSync('/sys/fs/cgroup'+group+'/cgroup.kill','1');}catch{}},
};
const sleepMs=ms=>Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,ms);
// The environment entry that marks one launch's processes: the unit and its log, which is new for every launch.
export const jobMarker=(unit,log)=>`KENAN_BG_JOB=${unit}:${log}`;
// The job's processes outside its unit (in cpu-slot's job scopes): descendants of the unit's processes, plus every process
// carrying the job's marker, plus the ones already found (known: pid to start time), whose parents may have died since.
// A control group whose processes are all the job's may be killed whole.
export function outsideProcesses(group,marker,proc=procFs,known=new Map()){
 const inside=g=>g===group||(group&&g.startsWith(group+'/'));
 const mine=new Set([...(marker?proc.marked(marker):[]),...[...known].filter(([pid,start])=>proc.start(pid)===start).map(([pid])=>pid)]);
 const queue=[...(group?proc.procs(group):[]),...mine];
 while(queue.length){for(const child of proc.children(queue.pop()))if(!mine.has(child)){mine.add(child);queue.push(child);}}
 const pids=[...mine].filter(pid=>proc.start(pid)!==null).map(pid=>[pid,proc.cgroupOf(pid)]).filter(([,g])=>g&&!inside(g));
 const groups=[...new Set(pids.map(([,g])=>g))];
 return {pids:pids.map(([pid])=>pid),groups,whole:groups.filter(g=>{const all=proc.procs(g);return all.length>0&&all.every(pid=>mine.has(pid));})};
}
export function escapedGroups(group,proc=procFs){return outsideProcesses(group,null,proc).whole;}
export function stopBackground(unit,{marker=null,execute=run,proc=procFs,sleep=sleepMs,now=Date.now,graceMs=3000,settleMs=2000}={}){
 const show=()=>{const r=execute('/usr/bin/systemctl',['--system','show',unit,'--property=LoadState,ActiveState,ControlGroup,ControlPID'],{timeout:10000});
  if(r.error||r.signal||!r.stdout?.includes('LoadState='))throw Error('background_state_unknown');
  return Object.fromEntries(r.stdout.trim().split('\n').map(line=>{const at=line.indexOf('=');return [line.slice(0,at),line.slice(at+1)];}));};
 const initial=show(),group=initial.ControlGroup||null;
 // Found before the stop is queued, while the unit's processes still link to their scopes.
 const known=new Map();
 // Reading every process's environment costs about 0.1 s, so the marker is searched once a second and before any "stopped".
 let scanned=-Infinity;
 const find=(full=false)=>{const scan=marker&&(full||now()-scanned>=1000);if(scan)scanned=now();
  const found=outsideProcesses(group,scan?marker:null,proc,known);for(const pid of found.pids){const start=proc.start(pid);if(start!==null&&!known.has(pid))known.set(pid,start);}return found;};
 // The job's processes in the unit: everything but ExecStopPost (the control process, which raises the job's end event)
 // and its children. systemd runs ExecStopPost as soon as the main process exits, while the rest may still run.
 // The processes are read before ControlPID, so an ExecStopPost started in between is never among them.
 const leftovers=()=>{
  if(!group)return [];
  const pids=proc.procs(group),control=Number(show().ControlPID)||0,spared=new Set();
  if(control){const queue=[control];spared.add(control);while(queue.length)for(const c of proc.children(queue.pop()))if(!spared.has(c)){spared.add(c);queue.push(c);}}
  return pids.filter(pid=>!spared.has(pid)&&proc.start(pid)!==null);
 };
 let outside=find();
 const inside=leftovers(),liveProcessesFound=outside.pids.length>0||inside.length>0;
 const unitNeedsStop=inside.length>0||initial.ActiveState==='activating';
 // A collected/completed unit is not a successful stop. Escaped children still count as live work.
 if(!liveProcessesFound&&!unitNeedsStop)return {unit,state:'already-inactive',stopRequested:false,liveProcessesFound:false,forced:false,scopes:[]};
 let stopRequested=false,stopError;
 if(unitNeedsStop){
  const r=execute('/usr/bin/systemctl',['--system','stop','--no-block',unit],{timeout:10000});
  stopRequested=r.status===0&&!r.error&&!r.signal;
  if(!stopRequested)stopError=(r.stderr||r.error?.message||r.signal||'systemd did not accept the stop').trim();
 }
 const scopes=new Set(),signalled=new Map();
 // Each pid is signalled once per signal, guarded by its start time against reuse.
 const signal=(pids,sig)=>{for(const pid of pids){const start=proc.start(pid),key=`${sig}:${pid}`;
  if(start===null||signalled.get(key)===start)continue;signalled.set(key,start);if(proc.kill(pid,sig)===true)stopRequested=true;}};
 const sweep=sig=>{for(const g of outside.groups)scopes.add(g);signal(outside.pids,sig);};
 sweep('SIGTERM');
 const survivors=(full=false)=>{outside=find(full);sweep('SIGTERM');
  return [...leftovers().map(pid=>({pid,cgroup:group})),...outside.pids.map(pid=>({pid,cgroup:proc.cgroupOf(pid)}))];};
 const until=deadline=>{while(now()<deadline){if(!survivors().length&&!(survivors(true)).length)return [];sleep(100);}return survivors(true);};
 const answer=(left,forced)=>({unit,state:left.length?'stopping':'stopped',stopRequested,liveProcessesFound,forced,scopes:[...scopes],...(stopError?{stopError}:{}),...(left.length?{survivors:left}:{})});
 let left=until(now()+graceMs);
 if(!left.length)return answer(left,false);
 signal(leftovers(),'SIGKILL');signal(outside.pids,'SIGKILL');
 for(const g of outside.whole)proc.killGroup(g);
 left=until(now()+settleMs);
 return answer(left,true);
}
export const BACKGROUND_ROOT='/var/lib/kenan-bg/background-launch';
// The wrapper's argv carries its log twice (argv[3] and the ExecStopPost line); a resubmission keeps the original log.
export function withLog(input,log){
 if(input.argv[1]!=='--run'||!log||input.argv[3]===log)return input;
 const argv=[...input.argv],old=argv[3];argv[3]=log;
 return {...input,argv,after:input.after.endsWith(' '+old)?input.after.slice(0,-old.length)+log:input.after};
}
// Read only the tail: deployment logs can be gigabytes. Absence or a malformed
// marker is uncertainty, never authority to reuse a name for different effects.
function backgroundLog(log){
 if(!log)return {terminal:null,tail:''};
 let fd;try{
  fd=fs.openSync(log,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
  const stat=fs.fstatSync(fd);if(!stat.isFile())return {terminal:null,tail:''};
  const size=Math.min(stat.size,65536),buf=Buffer.alloc(size);
  fs.readSync(fd,buf,0,size,stat.size-size);
  const text=buf.toString('utf8'),lines=text.split('\n');
  const tail=lines.slice(0,text.endsWith('\n')?-1:undefined).slice(-20).join('\n');
  let value;try{value=JSON.parse(lines.filter(x=>x.startsWith('[kenan-bg] end ')).at(-1)?.slice('[kenan-bg] end '.length));}catch{}
  const terminal=Number.isInteger(value?.exitCode)&&typeof value.endedAt==='string'&&['success','failed','oom','stopped'].includes(value.outcome)?value:null;
  return {terminal,tail};
 }catch{return {terminal:null,tail:''};}finally{if(fd!==undefined)fs.closeSync(fd);}
}
export function terminalBackground(log){return backgroundLog(log).terminal;}
function terminalFromSystemd(observed){
 if(!observed||observed.LoadState!=='loaded'||ACTIVE.has(observed.ActiveState)||!observed.ExecMainExitTimestamp)return null;
 const status=Number(observed.ExecMainStatus),code=Number(observed.ExecMainCode);
 if(!Number.isInteger(status)||![1,2,3].includes(code))return null;
 return {exitCode:code===1?status:128+status,outcome:observed.Result==='oom-kill'?'oom':code!==1?'stopped':status===0?'success':'failed',endedAt:observed.ExecMainExitTimestamp,source:'systemd'};
}
export function backgroundStatus(spec,binding,uid,{execute=run,root=BACKGROUND_ROOT,details=false}={}){
 let saved;try{saved=JSON.parse(fs.readFileSync(`${root}/${spec.unit}.json`,'utf8'));}catch{}
 if(saved&&(saved.uid!==uid||saved.channel!==binding.channel))return {ok:false,code:'background_owner_mismatch',retry:false};
 const receipt={unit:spec.unit,log:saved?.log??null};
 const observed=observeBackground(spec.unit,{execute});
 if(observed&&observed.LoadState!=='not-found'&&!sameOwner(ownerOf(observed),binding,uid))return {ok:false,code:'background_owner_mismatch',retry:false};
 const state=!observed?'unknown':ACTIVE.has(observed.ActiveState)&&observed.SubState!=='exited'?'active':'inactive';
 if(!details)return {ok:true,...receipt,state};
 // One authenticated read supplies the caller's saved log, outcome and bounded tail.
 // The CLI must not glob other agents' logs or query systemd again for the same state.
 const log=backgroundLog(receipt.log);
 const systemdTerminal=terminalFromSystemd(observed);
 const terminal=state==='active'?null:log.terminal?{...log.terminal,source:'log'}:state==='unknown'
  ?{note:'the job state could not be read and its log has no end line; it may still be running'}
  :systemdTerminal?{...systemdTerminal,note:'the log has no end line, so it is probably incomplete'}:{outcome:'unknown',note:'no end line in the log and systemd no longer has the unit; the job:AGENT:NAME event, if it arrived, has the outcome'};
 return {ok:true,...receipt,state,terminal,tail:log.tail};
}
// Reservations survive process death; an absent unit after a lost submission is
// NOT proof of non-execution. Different commands require a real terminal marker
// and a collected unit. Historical identities remain idempotent after name reuse.
export function launchOnce(input,binding,uid,spec,argsFor,{root=BACKGROUND_ROOT,execute=run}={}){
 try{fs.mkdirSync(root,{mode:0o700});}catch(error){
  if(error.code==='ENOENT')return {ok:false,code:'background_state_parent_missing',retry:false,detail:`${path.dirname(root)} must exist before background launches can be recorded.`};
  if(error.code!=='EEXIST')throw error;
 }
 const key=spec.unit,file=`${root}/${key}.json`,fd=fs.openSync(`${root}/${key}.lock`,'a',0o600);
 try{
  const lock=execute('/usr/bin/flock',['--exclusive','--wait','2','3'],{stdio:['ignore','pipe','pipe',fd],timeout:2500});
  if(lock.status!==0||lock.error)return {ok:false,code:'background_launch_busy',retry:true,detail:'Another launch of this name is in progress; inspect its status.'};
  const identity=launchIdentity(input);let saved;
  try{saved=JSON.parse(fs.readFileSync(file,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
  const write=value=>{const tmp=file+'.tmp';fs.writeFileSync(tmp,JSON.stringify(value)+'\n',{mode:0o600});fs.renameSync(tmp,file);};
  const accept=(record,extra)=>{const response={ok:true,unit:spec.unit,log:record.log,identity:binding,...extra};write({...record,state:'accepted',response});return response;};
  let history=saved?.history??[];
  if(saved){
   const original={unit:spec.unit,log:saved.log,identity:saved.identity,channel:saved.channel,uid:saved.uid,state:saved.state,response:saved.response??null};
   const conflict=detail=>({ok:false,code:'background_name_conflict',retry:false,detail,original});
   if(saved.channel!==binding.channel||saved.uid!==uid)return conflict('This name belongs to another owner.');
   const prior=history.find(x=>x.identity===identity);
   if(prior)return {...prior.response,ok:true,reused:true,state:'ended'};
   const observed=observeBackground(spec.unit,{execute});
   if(observed===null)return {...conflict('systemd did not answer; the original invocation remains uncertain.'),code:'background_launch_outcome_unknown'};
   const loaded=observed.LoadState!=='not-found';
   if(loaded&&!sameOwner(ownerOf(observed),binding,uid))return {...conflict('The retained unit has another owner.'),code:'background_owner_mismatch'};
   const same=saved.identity===identity;
   if(loaded&&ACTIVE.has(observed.ActiveState)){
    if(!same)return {...conflict('A different command is still running under this name.'),code:'background_running'};
    return accept(saved,{reused:true,state:'running'});
   }
   const terminal=terminalBackground(saved.log);
   if(same&&(saved.state==='accepted'||terminal))return accept(saved,{reused:true,state:'ended'});
   if(saved.state==='pending'&&!terminal)return {...conflict('The original submission has no terminal receipt; absence alone cannot authorize replay.'),code:'background_launch_outcome_unknown'};
   if(!same){
    if(!terminal||loaded)return conflict('A different command may reuse this name only after its terminal log and collected unit are reconciled.');
    // Marked escaped children must also have ended; do not stop them here.
    if(procFs.marked(jobMarker(spec.unit,saved.log)).some(pid=>procFs.start(pid)!==null))return {...conflict('Processes from the original job still exist outside its unit.'),code:'background_running'};
    history=[...history,{identity:saved.identity,response:{...saved.response,ok:true,unit:spec.unit,log:saved.log,state:'ended'},terminal}];
   }
  }
  const log=input.argv[1]==='--run'?input.argv[3]:null;
  // A --keep job is started again after a host reboot (recover.mjs) with exactly this command, environment and directory.
  // Only --keep records hold the environment; the file is root-only (0600 in a 0700 directory).
  const record={identity,channel:binding.channel,uid,callId:binding.callId,keep:input.keep===true,...(input.keep===true?{input:{agentId:input.agentId,name:input.name,argv:input.argv,cwd:input.cwd,env:input.env,umask:input.umask,after:input.after}}:{}),log,state:'pending',history};
  write(record);
  const result=submitBackground('/usr/bin/systemd-run',argsFor(input),{execute,env:{...process.env,...Object.fromEntries(input.env.map(pair=>{const at=pair.indexOf('=');return [pair.slice(0,at),pair.slice(at+1)];}))}});
  const observed=result?.status===0&&!result.error?null:observeBackground(spec.unit,{execute});
  const verdict=settleBackground(result,observed,spec);
  if(verdict.ok)return accept(record,verdict.state?{state:verdict.state}:{});
  const response={...verdict,unit:spec.unit,log,identity:binding};
  // A lost reply never becomes permission for a fresh effect on retry.
  if(verdict.code==='background_launch_refused')write({...record,state:'refused',response});
  return response;
 }finally{fs.closeSync(fd);}
}
function caller(pid){
 let diagnostic;
 const binding=callerToolCall({...(pid?{pid}:{}),background:false,onError:value=>{diagnostic=value;}});
 if(!binding&&diagnostic)throw Error(`background_native_caller_required: ${diagnostic.code}: ${diagnostic.detail}`);
 return binding;
}
export const serveActions=['launch','status'];
export function controlSpec(input,binding,uid,gid){
 return backgroundSpec({...input,argv:['/usr/bin/true'],after:'/usr/bin/true'},binding,uid,gid);
}
// The persistent socket listener supplies credentials read from the connected
// socket by SO_PEERCRED. Each worker authenticates the current root-created scope.
export function serveRequest(input,peer){
 try{
  if(process.getuid()!==0)throw Error('background_root_required');
  const binding=caller(peer.pid);
  if(input.action&&!serveActions.includes(input.action))throw Error('background_invalid_command');
  const spec=(input.action==='status'?controlSpec:backgroundSpec)(input,binding,peer.uid,peer.gid);
  const response=input.action==='status'?backgroundStatus(spec,binding,peer.uid,{details:true}):launchOnce(input,binding,peer.uid,spec,argsFor(spec,peer.uid,peer.gid));
  return response.ok?response:{ok:false,error:response};
 }catch(error){return {ok:false,error:{code:error.message}};}
}
// WorkingDirectory=- : a job that deletes its own directory (a test's temporary root, a removed checkout) must still
// get its ExecStopPost, which raises the end event when the job's wrapper could not; with a plain WorkingDirectory
// systemd failed it at step CHDIR and the job ended without one.
// All background jobs share user-agents-kenanbg.slice (Kenan Stack deploy/priority), weighted as one agent command, so
// they can't crowd out the agents' own shells (2026-10-30: 17 jobs as separate siblings left each shell 0.05 CPU).
export const argsFor=(spec,uid,gid)=>input=>['--system','--quiet','--collect','--expand-environment=no','--property=Type=exec',`--unit=${spec.unit}`,`--uid=${uid}`,`--gid=${gid}`,`--property=WorkingDirectory=-${input.cwd}`,`--description=${spec.description}`,...(hostname() === 'acme-host' ? ['--property=MemoryMax=8G'] : []),'--property=MemorySwapMax=0',...(hostname() === 'ResearchCo' ? ['--property=OOMScoreAdjust=500'] : []),'--property=OOMPolicy=continue',`--property=UMask=${input.umask}`,'--property=Slice=user-agents-kenanbg.slice',...(hostname() === 'acme-host' ? ['--property=CPUQuota=200%'] : []),'--property=CPUWeight=10',`--property=ExecStopPost=${input.after}`,...input.env.filter(x=>!x.startsWith('KENAN_TOOL_CALL_ID=')&&!x.startsWith('KENAN_BG_NATIVE=')&&!x.startsWith('KENAN_BG_JOB=')).map(x=>'--setenv='+x.slice(0,x.indexOf('='))),'--setenv=KENAN_BG_NATIVE=1',...(input.argv[1]==='--run'?['--setenv='+jobMarker(spec.unit,input.argv[3])]:[]),'--',...input.argv];
export function main(){
 if(process.getuid()!==0)throw Error('background_root_required');
 const binding=caller();
 const uid=Number(process.env.SUDO_UID),gid=Number(process.env.SUDO_GID);
 const input=JSON.parse(fs.readFileSync(0,'utf8'));
 const spec=(process.argv[2]==='status'?controlSpec:backgroundSpec)(input,binding,uid,gid);
 if(process.argv[2]==='status'){
  const response=backgroundStatus(spec,binding,uid,{details:true});
  if(!response.ok)throw Error(response.code);
  console.log(JSON.stringify(response));return;
 }
 if(process.argv[2]==='stop'){
  // Authenticate both the retained launch and any loaded unit before inspecting or stopping processes.
  const prior=backgroundStatus(spec,binding,uid);
  if(!prior.ok)throw Error(prior.code);
  if(prior.state==='unknown')throw Error('background_state_unknown');
  const priorOutcome=terminalBackground(prior.log)??terminalFromSystemd(observeBackground(spec.unit));
  const r=stopBackground(spec.unit,{marker:prior.log?jobMarker(spec.unit,prior.log):null});
  const terminal=terminalBackground(prior.log)??priorOutcome;
  console.log(JSON.stringify({...r,log:prior.log,...(terminal??{}),priorOutcome}));
  process.exitCode=r.state==='stopping'?1:0;return;
 }
 if(process.argv[2]!=='launch')throw Error('background_invalid_command');
 const response=launchOnce(input,binding,uid,spec,argsFor(spec,uid,gid));
 if(!response.ok){console.error(JSON.stringify({ok:false,error:response}));process.exitCode=response.code==='background_launch_outcome_unknown'?75:2;return;}
 console.log(JSON.stringify(response));

}
if(process.argv[1]&&fs.existsSync(process.argv[1])&&new URL(import.meta.url).pathname===fs.realpathSync(process.argv[1])){try{main();}catch(error){console.error(error.message);process.exitCode=2;}}
