#!/usr/bin/env node
// Runs as root at every boot (kenan-bg-recover.service). A host reboot kills every background job, and a hard reset
// gives no job a chance to write its end line or raise its job:AGENT:NAME event. This finds each accepted launch whose
// log has no end line and whose unit is gone, then:
//  - writes the end line (outcome stopped, reason "killed: host reboot") and raises the job's event with that reason, so
//    the owner's wake fires;
//  - starts a --keep job again with the command, environment, directory and umask it was launched with (stored in its
//    launch record), under a new log. A job that ended by itself or by kenan-bg stop has an end line without the host
//    reason and is never restarted.
// `--seed-hours H` (installation only): launches older than H hours that already lack an end line are closed silently,
// with no event, so history from before this existed is not announced as news.
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {BACKGROUND_ROOT,argsFor,backgroundSpec,observeBackground,settleBackground,submitBackground,withLog} from './background-launch.mjs';
const HOST_REASON='killed: host reboot';
const ACTIVE=new Set(['active','activating','deactivating','reloading','refreshing']);
const END='[kenan-bg] end ';
function logState(log){
 let fd;try{
  fd=fs.openSync(log,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
  const stat=fs.fstatSync(fd);if(!stat.isFile())return null;
  const size=Math.min(stat.size,65536),buf=Buffer.alloc(size);fs.readSync(fd,buf,0,size,stat.size-size);
  let end=null;
  for(const line of buf.toString('utf8').split('\n').reverse()){const at=line.indexOf(END);if(at>=0){try{end=JSON.parse(line.slice(at+END.length));}catch{}break;}}
  return {end,size:stat.size,mtimeMs:stat.mtimeMs};
 }catch{return null;}finally{if(fd!==undefined)fs.closeSync(fd);}
}
// The same summary the job wrapper puts in an event: all of a short log, else its head and tail.
function eventTail(log,size){
 const read=(start,len)=>{const fd=fs.openSync(log,'r');try{const b=Buffer.alloc(len);fs.readSync(fd,b,0,len,start);return b.toString('utf8').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g,'');}finally{fs.closeSync(fd);}};
 try{return size<=8192?read(0,size):read(0,3072)+'\n[kenan-bg: middle omitted; full output in log]\n'+read(size-5000,5000);}catch{return '';}
}
// Every KENAN_BG_JOB marker alive now: a job's processes outside its unit (cpu-slot scopes) can outlive the unit.
function liveMarkers(){
 const found=new Set();
 for(const name of fs.readdirSync('/proc')){if(!/^\d+$/.test(name))continue;
  let env;try{env=fs.readFileSync(`/proc/${name}/environ`,'latin1');}catch{continue;}
  for(const entry of env.split('\0'))if(entry.startsWith('KENAN_BG_JOB='))found.add(entry);}
 return found;
}
const stamp=()=>{const d=new Date();return d.toISOString().replace(/[-:]/g,'').replace(/\.(\d{3})Z$/,'.$1000000Z');};
const appendEnd=(log,record)=>fs.appendFileSync(log,`\n${END}${JSON.stringify(record)}\n`);
function raiseEvent(rec,unit,body,id){
 const agent=rec.input?.agentId??unit.slice('kenan-bg-'.length).replace(/-[^-]*$/,'');
 const name=unit.slice(('kenan-bg-'+agent+'-').length).replace(/\.service$/,'');
 const r=spawnSync('/usr/local/bin/kenan-event',['--uid',String(rec.uid),'--id',id,`job:${agent}:${name}`],{input:JSON.stringify({name,unit:unit.replace(/\.service$/,''),...body}),encoding:'utf8',timeout:20000,env:Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.startsWith('SUDO_')))});
 if(r.status!==0)console.error(`kenan-bg recover: event for ${unit} not queued: ${(r.stderr||r.error?.message||'').trim()}`);
 return r.status===0;
}
function relaunch(rec,unit,file,oldLog){
 const input=rec.input,gid=Number(spawnSync('/usr/bin/id',['-g',String(rec.uid)],{encoding:'utf8'}).stdout);
 const newLog=path.join(path.dirname(oldLog),`${input.name}-${stamp()}.log`);
 let next=withLog({...input,keep:true},newLog);
 if(next.argv[1]!=='--run'||next.argv[3]!==newLog)return {ok:false,detail:'launch is not a kenan-bg wrapper command'};
 // A here-document given to the job lives beside its log; the new run reads a copy beside the new log.
 const stdinEntry=next.env.find(x=>x.startsWith('KENAN_BG_STDIN='));
 if(stdinEntry){
  const old=stdinEntry.slice('KENAN_BG_STDIN='.length);
  try{fs.copyFileSync(old,newLog+'.stdin');fs.chownSync(newLog+'.stdin',rec.uid,gid);fs.chmodSync(newLog+'.stdin',0o600);
   next={...next,env:next.env.map(x=>x===stdinEntry?'KENAN_BG_STDIN='+newLog+'.stdin':x)};}
  catch{return {ok:false,detail:'the job\'s stdin file is gone'};}
 }
 const binding={channel:rec.channel,callId:rec.callId,agentId:input.agentId};
 const spec=backgroundSpec(next,binding,rec.uid,gid);
 const lock=fs.openSync(file.replace(/\.json$/,'.lock'),'a',0o600);
 try{
  const got=spawnSync('/usr/bin/flock',['--exclusive','--wait','10','3'],{stdio:['ignore','pipe','pipe',lock],timeout:12000});
  if(got.status!==0)return {ok:false,detail:'another launch of this name is in progress'};
  const write=value=>{const tmp=file+'.tmp';fs.writeFileSync(tmp,JSON.stringify(value)+'\n',{mode:0o600});fs.renameSync(tmp,file);};
  write({...rec,input:{...next,keep:undefined},log:newLog,state:'pending'});
  const env={...process.env,...Object.fromEntries(next.env.map(pair=>{const at=pair.indexOf('=');return [pair.slice(0,at),pair.slice(at+1)];}))};
  const result=submitBackground('/usr/bin/systemd-run',argsFor(spec,rec.uid,gid)(next),{env});
  const observed=result?.status===0&&!result.error?null:observeBackground(unit);
  const verdict=settleBackground(result,observed,spec);
  if(verdict.ok){write({...rec,log:newLog,state:'accepted',response:{ok:true,unit,log:newLog,identity:binding}});return {ok:true,log:newLog};}
  write({...rec,state:'accepted'});
  return {ok:false,detail:verdict.detail??verdict.code};
 }finally{fs.closeSync(lock);}
}
export function recover({root=BACKGROUND_ROOT,seedHours=null}={}){
 const markers=liveMarkers(),now=Date.now(),out=[];
 for(const name of fs.readdirSync(root)){
  if(!name.endsWith('.json')||!name.startsWith('kenan-bg-'))continue;
  const file=path.join(root,name),unit=name.slice(0,-'.json'.length);
  let rec;try{rec=JSON.parse(fs.readFileSync(file,'utf8'));}catch{continue;}
  if(rec.state!=='accepted'||!rec.log)continue;
  const state=logState(rec.log);
  if(!state)continue;
  const hostKilled=state.end?.reason===HOST_REASON;
  // An end line without the host reason is a normal end. With it, only a --keep job whose restart did not happen is left.
  if(state.end&&!(hostKilled&&rec.keep===true&&rec.input))continue;
  // A launch this run starts again is skipped when its unit or its escaped processes are alive.
  const observed=observeBackground(unit);
  if(observed===null)continue;
  if(observed.LoadState!=='not-found'&&ACTIVE.has(observed.ActiveState))continue;
  if(markers.has(`KENAN_BG_JOB=${unit}:${rec.log}`))continue;
  if(!state.end&&seedHours!==null&&now-state.mtimeMs>seedHours*3600e3){
   appendEnd(rec.log,{exitCode:137,outcome:'stopped',endedAt:new Date(state.mtimeMs).toISOString(),reason:'lost before host-reboot recovery existed'});
   out.push({unit,action:'closed-silently'});continue;
  }
  const endedAt=new Date(now).toISOString();
  let raised=null;
  const restart=rec.keep===true&&rec.input?relaunch(rec,unit,file,rec.log):null;
  if(!state.end){
   appendEnd(rec.log,{exitCode:137,outcome:'stopped',endedAt,reason:HOST_REASON});
   const lastWrite=new Date(state.mtimeMs).toISOString();
   raised=raiseEvent(rec,unit,{exitCode:137,outcome:'stopped',reason:HOST_REASON,log:rec.log,startedAt:null,endedAt,lastLogWriteAt:lastWrite,
    note:'the host went down (reboot or reset) while this job ran'+(restart?.ok?`; it was started again with the same command under a new log (${restart.log})`:rec.keep?'; it could not be restarted'+(restart?.detail?` (${restart.detail})`:' (no stored launch)'):'; it is not restarted, start it again from its checkpoint'),
    ...(restart?.ok?{restarted:true,newLog:restart.log}:{}),tail:eventTail(rec.log,state.size)},`${unit}-lost-${path.basename(rec.log)}`);
  }
  out.push({unit,action:restart?.ok?'restarted':'ended',eventQueued:raised,...(restart&&!restart.ok?{restartFailed:restart.detail}:{})});
 }
 return out;
}
if(process.argv[1]&&fs.existsSync(process.argv[1])&&new URL(import.meta.url).pathname===fs.realpathSync(process.argv[1])){
 try{
  if(process.getuid()!==0)throw Error('background_root_required');
  const at=process.argv.indexOf('--seed-hours');
  for(const r of recover({seedHours:at>0?Number(process.argv[at+1]):null}))console.log(JSON.stringify(r));
 }catch(error){console.error(error.message);process.exitCode=2;}
}
