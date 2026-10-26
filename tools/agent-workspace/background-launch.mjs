#!/usr/bin/env node
// Root-created transient services carry the authenticated launch identity across
// detachment. User-manager metadata and inherited UUIDs never grant this identity.
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
import {callerToolCall} from './cache-queue.mjs';
const run=(cmd,args,opts={})=>spawnSync(cmd,args,{encoding:'utf8',timeout:10000,maxBuffer:2**20,...opts});
export function backgroundSpec(input,binding,uid,gid){
 if(!binding||!Number.isSafeInteger(uid)||uid<=0||!Number.isSafeInteger(gid)||gid<0)throw Error('background_native_caller_required');
 if(!/^[a-f0-9-]{36}$/.test(binding.agentId)||!/^[-A-Za-z0-9._]{1,60}$/.test(input.name??'')||input.agentId!==binding.agentId)throw Error('background_owner_mismatch');
 if(!Array.isArray(input.argv)||!input.argv.length||input.argv.some(x=>typeof x!=='string'||x.includes('\0'))||!input.argv[0].startsWith('/')||typeof input.after!=='string'||!input.after.startsWith('/')||input.after.includes('\0')||typeof input.cwd!=='string'||!input.cwd.startsWith('/')||!Array.isArray(input.env)||input.env.some(x=>typeof x!=='string'||!x.includes('=')||x.includes('\0'))||!/^0?[0-7]{3}$/.test(input.umask??''))throw Error('background_invalid_launch');
 const unit=`kenan-bg-${binding.agentId}-${input.name}.service`;
 const description='kenan-tool-call:'+JSON.stringify({version:1,...binding,background:true,uid});
 return {unit,description};
}
export function submitBackground(command,args,{execute=run}={}){return execute(command,args,{timeout:3000});}
export function main(){
 if(process.getuid()!==0)throw Error('background_root_required');
 let diagnostic;
 const binding=callerToolCall({background:false,onError:value=>{diagnostic=value;}});
 if(!binding&&diagnostic)throw Error(`background_native_caller_required: ${diagnostic.code}: ${diagnostic.detail}`);
 const uid=Number(process.env.SUDO_UID),gid=Number(process.env.SUDO_GID);
 const input=JSON.parse(fs.readFileSync(0,'utf8'));
 const spec=backgroundSpec(input,binding,uid,gid);
 if(process.argv[2]==='status'||process.argv[2]==='stop'){
  const observed=run('/usr/bin/systemctl',['--system','show',spec.unit,'--property=Description,LoadState']);
  const properties=Object.fromEntries(observed.stdout.trim().split('\n').map(line=>{const at=line.indexOf('=');return [line.slice(0,at),line.slice(at+1)];}));
  if(properties.LoadState==='not-found'){if(process.argv[2]==='status'){console.log('inactive');process.exitCode=3;}return;}
  if(observed.status!==0||properties.Description!==spec.description) {
   // A new native call by the same worker may manage its previous launch.
   let prior;try{prior=JSON.parse((properties.Description??'').slice('kenan-tool-call:'.length));}catch{}
   if(!prior?.background||prior.agentId!==binding.agentId||prior.channel!==binding.channel||prior.uid!==uid)throw Error('background_owner_mismatch');
  }
  const result=run('/usr/bin/systemctl',['--system',process.argv[2]==='stop'?'stop':'is-active',spec.unit]);
  process.stdout.write(result.stdout);process.stderr.write(result.stderr);process.exitCode=result.status;return;
 }
 if(process.argv[2]!=='launch')throw Error('background_invalid_command');
 // Unit creation is the atomic duplicate check. Separate preflight/reset calls
 // add two unbounded-in-series manager waits and cannot make creation safer.
 const result=submitBackground('/usr/bin/systemd-run',['--system','--quiet','--collect','--expand-environment=no',`--unit=${spec.unit}`,`--uid=${uid}`,`--gid=${gid}`,`--working-directory=${input.cwd}`,`--description=${spec.description}`,'--property=MemoryMax=8G','--property=MemorySwapMax=0','--property=OOMPolicy=continue',`--property=UMask=${input.umask}`,'--property=Slice=user-agents.slice','--property=CPUQuota=200%','--property=CPUWeight=10',`--property=ExecStopPost=${input.after}`,...input.env.filter(x=>!x.startsWith('KENAN_TOOL_CALL_ID=')&&!x.startsWith('KENAN_BG_NATIVE=')).map(x=>'--setenv='+x),'--setenv=KENAN_BG_NATIVE=1','--',...input.argv]);
 if(result.status!==0||result.error){
  const unknown=result.error||result.signal;
  console.error(JSON.stringify({ok:false,error:{code:unknown?'background_launch_outcome_unknown':'background_launch_refused',unit:spec.unit,retry:false,detail:unknown?'Observe this exact unit before any new launch; the system manager may have accepted it.':'The system manager rejected this exact unit creation.'}}));process.exitCode=unknown?75:2;return;
 }
 console.log(JSON.stringify({unit:spec.unit,identity:binding}));
}
if(process.argv[1]&&new URL(import.meta.url).pathname===fs.realpathSync(process.argv[1])){try{main();}catch(error){console.error(error.message);process.exitCode=2;}}
