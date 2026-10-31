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
 kill(pid,signal){try{process.kill(pid,signal);}catch{}},
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
 const show=()=>{const r=execute('/usr/bin/systemctl',['--system','show',unit,'--property=ControlGroup,ControlPID'],{timeout:10000});
  return Object.fromEntries((r.stdout??'').trim().split('\n').map(line=>{const at=line.indexOf('=');return [line.slice(0,at),line.slice(at+1)];}));};
 const group=show().ControlGroup||null;
 // Found before the stop is queued, while the unit's processes still link to their scopes.
 const known=new Map();
 // Reading every process's environment costs about 0.1 s, so the marker is searched once a second and before any "stopped".
 let scanned=-Infinity;
 const find=(full=false)=>{const scan=marker&&(full||now()-scanned>=1000);if(scan)scanned=now();
  const found=outsideProcesses(group,scan?marker:null,proc,known);for(const pid of found.pids){const start=proc.start(pid);if(start!==null&&!known.has(pid))known.set(pid,start);}return found;};
 let outside=find();
 if(group)execute('/usr/bin/systemctl',['--system','stop','--no-block',unit],{timeout:10000});
 const scopes=new Set(),signalled=new Map();
 // Each pid is signalled once per signal, guarded by its start time against reuse.
 const signal=(pids,sig)=>{for(const pid of pids){const start=proc.start(pid),key=`${sig}:${pid}`;
  if(start===null||signalled.get(key)===start)continue;signalled.set(key,start);proc.kill(pid,sig);}};
 const sweep=sig=>{for(const g of outside.groups)scopes.add(g);signal(outside.pids,sig);};
 sweep('SIGTERM');
 // The job's processes in the unit: everything but ExecStopPost (the control process, which raises the job's end event)
 // and its children. systemd runs ExecStopPost as soon as the main process exits, while the rest may still run.
 // The processes are read before ControlPID, so an ExecStopPost started in between is never among them.
 const leftovers=()=>{
  if(!group)return [];
  const pids=proc.procs(group),control=Number(show().ControlPID)||0,spared=new Set();
  if(control){const queue=[control];spared.add(control);while(queue.length)for(const c of proc.children(queue.pop()))if(!spared.has(c)){spared.add(c);queue.push(c);}}
  return pids.filter(pid=>!spared.has(pid));
 };
 const survivors=(full=false)=>{outside=find(full);sweep('SIGTERM');
  return [...leftovers().map(pid=>({pid,cgroup:group})),...outside.pids.map(pid=>({pid,cgroup:proc.cgroupOf(pid)}))];};
 const until=deadline=>{while(now()<deadline){if(!survivors().length&&!(survivors(true)).length)return [];sleep(100);}return survivors(true);};
 const answer=(left,forced)=>({unit,state:left.length?'stopping':'stopped',forced,scopes:[...scopes],...(left.length?{survivors:left}:{})});
 let left=until(now()+graceMs);
 if(!left.length)return answer(left,false);
 signal(leftovers(),'SIGKILL');signal(outside.pids,'SIGKILL');
 for(const g of outside.whole)proc.killGroup(g);
 left=until(now()+settleMs);
 return answer(left,true);
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
  // Rename keeps a reader from ever seeing half a record. No fsync: the record only has to outlive a killed caller (the
  // page cache does), and after a host crash no unit survives anyway. Four fsyncs cost up to 2.5 s on the busy RAID
  // and pushed a launch past its caller's 10 s timeout (2026-10-31).
  const write=value=>{const tmp=file+'.tmp';fs.writeFileSync(tmp,JSON.stringify(value)+'\n',{mode:0o600});fs.renameSync(tmp,file);};
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
// The launch socket (kenan-bg-launch.socket, Accept=yes) names each connection's service instance after the peer the
// kernel reported: "<nr>-<pid>-<uid>", or "<nr>-<cookie>-<pid>_<pidfd id>-<uid>" on newer systemd.
export function socketPeer(instance){
 const m=/^\d+-(?:\d+-)?(\d+)(?:_\d+)?-(\d+)$/.exec(instance??'');
 if(!m)throw Error('background_invalid_peer');
 return {pid:Number(m[1]),uid:Number(m[2])};
}
const gidOf=pid=>Number(/^Gid:\s+(\d+)/m.exec(fs.readFileSync(`/proc/${pid}/status`,'utf8'))?.[1]);
function caller(pid){
 let diagnostic;
 const binding=callerToolCall({...(pid?{pid}:{}),background:false,onError:value=>{diagnostic=value;}});
 if(!binding&&diagnostic)throw Error(`background_native_caller_required: ${diagnostic.code}: ${diagnostic.detail}`);
 return binding;
}
// serve: one launch per connection, run by systemd in system.slice. Under a CPU-starved agent slice, starting sudo and
// node inside the caller's own tool scope took up to 8 s (2026-10-31); the caller now only starts socat.
export function serve(instance){
 let response;
 try{
  if(process.getuid()!==0)throw Error('background_root_required');
  const peer=socketPeer(instance);
  const binding=caller(peer.pid);
  const input=JSON.parse(fs.readFileSync(0,'utf8'));
  const spec=backgroundSpec(input,binding,peer.uid,gidOf(peer.pid));
  response=launchOnce(input,binding,peer.uid,spec,argsFor(spec,peer.uid,gidOf(peer.pid)));
  if(!response.ok)response={ok:false,error:response};
 }catch(error){response={ok:false,error:{code:error.message}};}
 process.stdout.write(JSON.stringify(response)+'\n');
}
// WorkingDirectory=- : a job that deletes its own directory (a test's temporary root, a released workspace) must still
// get its ExecStopPost, which raises the end event when the job's wrapper could not; with a plain WorkingDirectory
// systemd failed it at step CHDIR and the job ended without one (2026-10-31, two aw-release jobs).
// All background jobs share user-agents-kenanbg.slice (Kenan Stack deploy/priority), weighted as one agent command, so
// they can't crowd out the agents' own shells (2026-10-30: 17 jobs as separate siblings left each shell 0.05 CPU).
const argsFor=(spec,uid,gid)=>input=>['--system','--quiet','--expand-environment=no','--property=Type=exec',`--unit=${spec.unit}`,`--uid=${uid}`,`--gid=${gid}`,`--property=WorkingDirectory=-${backgroundDirectory(input,fs.readFileSync('/etc/passwd','utf8').split('\n').find(line=>line.split(':')[2]===String(uid))?.split(':')[5]||'/')}`,`--description=${spec.description}`,'--property=MemoryMax=8G','--property=MemorySwapMax=0','--property=OOMPolicy=continue',`--property=UMask=${input.umask}`,'--property=Slice=user-agents-kenanbg.slice','--property=CPUQuota=200%','--property=CPUWeight=10',`--property=ExecStopPost=${input.after}`,...input.env.filter(x=>!x.startsWith('KENAN_TOOL_CALL_ID=')&&!x.startsWith('KENAN_BG_NATIVE=')&&!x.startsWith('KENAN_BG_JOB=')).map(x=>'--setenv='+x),'--setenv=KENAN_BG_NATIVE=1',...(input.argv[1]==='--run'?['--setenv='+jobMarker(spec.unit,input.argv[3])]:[]),'--',...input.argv];
export function main(){
 if(process.argv[2]==='serve')return serve(process.argv[3]);
 if(process.getuid()!==0)throw Error('background_root_required');
 const binding=caller();
 const uid=Number(process.env.SUDO_UID),gid=Number(process.env.SUDO_GID);
 const input=JSON.parse(fs.readFileSync(0,'utf8'));
 const spec=backgroundSpec(input,binding,uid,gid);
 if(process.argv[2]==='status'||process.argv[2]==='stop'){
  const observed=run('/usr/bin/systemctl',['--system','show',spec.unit,'--property=Description,LoadState,SubState']);
  const properties=Object.fromEntries(observed.stdout.trim().split('\n').map(line=>{const at=line.indexOf('=');return [line.slice(0,at),line.slice(at+1)];}));
  let saved;try{saved=JSON.parse(fs.readFileSync(`${BACKGROUND_ROOT}/${spec.unit}.json`,'utf8'));}catch{}
  const marker=saved?.log&&saved.uid===uid&&saved.channel===binding.channel?jobMarker(spec.unit,saved.log):null;
  if(properties.LoadState==='not-found'){
   // A launch whose caller was cut off before systemd answered: the job never started, and the same command starts it.
   if(process.argv[2]==='status'){console.log(saved?.state==='pending'&&saved.log&&!fs.existsSync(saved.log)?'not-started':'inactive');process.exitCode=3;}
   // The unit is gone, but a cpu-slot scope it started may still run: a repeated stop finds it by the job's marker.
   else{const r=stopBackground(spec.unit,{marker});console.log(JSON.stringify(r));process.exitCode=r.state==='stopped'?0:1;}
   return;
  }
  if(observed.status!==0||properties.Description!==spec.description) {
   // A new native call by the same worker may manage its previous launch.
   let prior;try{prior=JSON.parse((properties.Description??'').slice('kenan-tool-call:'.length));}catch{}
   if(!prior?.background||prior.agentId!==binding.agentId||prior.channel!==binding.channel||prior.uid!==uid)throw Error('background_owner_mismatch');
  }
  if(process.argv[2]==='status'&&properties.SubState==='exited'){console.log('inactive');return;}
  if(process.argv[2]==='stop'){const r=stopBackground(spec.unit,{marker});console.log(JSON.stringify(r));process.exitCode=r.state==='stopped'?0:1;return;}
  const result=run('/usr/bin/systemctl',['--system','is-active',spec.unit]);
  process.stdout.write(result.stdout);process.stderr.write(result.stderr);process.exitCode=result.status;return;
 }
 if(process.argv[2]!=='launch')throw Error('background_invalid_command');
 const response=launchOnce(input,binding,uid,spec,argsFor(spec,uid,gid));
 if(!response.ok){console.error(JSON.stringify({ok:false,error:response}));process.exitCode=response.code==='background_launch_outcome_unknown'?75:2;return;}
 console.log(JSON.stringify(response));

}
if(process.argv[1]&&new URL(import.meta.url).pathname===fs.realpathSync(process.argv[1])){try{main();}catch(error){console.error(error.message);process.exitCode=2;}}
