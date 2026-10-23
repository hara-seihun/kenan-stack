#!/usr/bin/env node
// Explicit owner-directed finalization, never a lease-expiry reaper or source deleter.
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {executionCessation} from './execution-capacity.mjs';
import {validateRetirement} from './growth-lifecycle.mjs';
const sha=x=>createHash('sha256').update(x).digest('hex');
const fail=message=>{throw new Error('terminal-finalizer: '+message);};
export function completedOneshot(expected, actual) {
 if(!expected || !/^[a-zA-Z0-9_.@:-]+\.service$/.test(expected.unit) || !/^[a-f0-9]{32}$/.test(expected.invocationId)) fail('exact unit and invocation required');
 if(actual.InvocationID!==expected.invocationId || actual.Type!=='oneshot' || actual.RemainAfterExit!=='yes' || actual.Restart!=='no' ||
 actual.ActiveState!=='active' || actual.SubState!=='exited' || actual.MainPID!=='0' || actual.ControlPID!=='0' || actual.ControlGroup!=='' ||
 actual.ExecStop!=='' || actual.ExecStopPost!=='' || actual.TriggeredBy!=='' || actual.Triggers!=='' || actual.Result!=='success') fail('unit not a completed inert oneshot');
}
export async function finalizeTerminal(request, io) {
 if(request?.kind!=='terminal-growth-finalization' || request.frozen!==false || request.futureWrites!=='none' || request.deleteSource!==false ||
 !Array.isArray(request.units) || !request.units.length || !request.holder || request.holder.bootId!==io.bootId() ||
 request.disposition?.binding?.owner!==request.owner || request.disposition?.binding?.path!==request.path) fail('explicit unfrozen owner disposition, source preservation and original holder required');
 // Validate freshness and exact submitted binding before touching a unit. No rewriting evidence.
 validateRetirement(request.disposition,request.disposition.binding,{references:[],errors:[]},io.now());
 const current=await io.growth(request);
 if(current.plan?.growthLifecycle?.kind==='retired-future-growth') {
  if(current.plan.growthLifecycle.dispositionSha256!==sha(JSON.stringify(request.disposition))) fail('different retirement custody');
  for(const key of ['id','path','owner','head','sourceCommit','durableSourceCommit','device','inode']) if(current.binding[key]!==request.disposition.binding[key]) fail('retired source identity changed');
  return {ok:true,state:'already-retired',sourceDeleted:false};
 }
 validateRetirement(request.disposition,current.binding,{references:[],errors:[]},io.now());
 const holderUnit=request.holder.cgroup?.split('/').at(-1);
 if(!request.units.some(u=>u.unit===holderUnit)) fail('original holder must bind an explicitly completed unit');
 // First validate ALL units. Re-observe each at its effect boundary. No failed/live stop.
 for(const unit of request.units) completedOneshot(unit,await io.show(unit));
 const stopped=[];
 for(const unit of request.units) {
  completedOneshot(unit,await io.show(unit));
  await io.stop(unit);
  const after=await io.show(unit);
  if(!['inactive','failed'].includes(after.ActiveState) || after.MainPID!=='0' || after.ControlPID!=='0' || after.ControlGroup!=='') fail('terminal unit cessation unknown');
  stopped.push({unit:unit.unit,after});
 }
 // Complete original process/cgroup census, not PID-only or caller-supplied cessation.
 const cessation=await io.cessation(request.holder);
 if(cessation.complete!==true || cessation.members?.length!==0 || cessation.bootId!==request.holder.bootId || cessation.cgroup!==request.holder.cgroup) fail('original holder cessation unknown');
 const safety=await io.safety(request);
 validateRetirement(request.disposition,(await io.growth(request)).binding,safety.safety,io.now());
 // Owning CLI revalidates under workspace/borrower/capacity locks and journals CAS.
 const retirement=await io.retire(request);
 if(!retirement.ok) fail('native retirement refused: '+JSON.stringify(retirement));
 return {ok:true,state:'retired',sourceDeleted:false,stopped,cessation,retirement};
}
function command(file,args,timeout=26000) {
 const r=spawnSync(file,args,{encoding:'utf8',timeout,env:{...process.env}});
 if(r.error || r.status!==0) fail(`${file} failed (${r.status}): ${r.stderr?.slice(0,1500)}`);
 return r.stdout;
}
export async function runFinalizer(file,expectedHash) {
 const bytes=fs.readFileSync(file);if(sha(bytes)!==expectedHash)fail('request hash mismatch');
 const request=JSON.parse(bytes),native=fileURLToPath(new URL('./main',import.meta.url));
 const argv=(r,cmd)=>[cmd,'--id',r.disposition.binding.id,'--path',r.path,'--json'];
 const sys=(u,args)=>command('/usr/bin/systemctl',u.manager==='user'?['--user',...args]:args,5000);
 for(const u of request.units??[])if(!['user','system'].includes(u.manager))fail('unknown unit manager');
 const props=['Type','RemainAfterExit','Restart','ActiveState','SubState','MainPID','ControlPID','ControlGroup','InvocationID','ExecStop','ExecStopPost','TriggeredBy','Triggers','Result'];
 const io={now:Date.now,bootId:()=>fs.readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim(),
 growth:r=>JSON.parse(command(native,argv(r,'growth-status'))),
 show:u=>Object.fromEntries(sys(u,['show',u.unit,'--property='+props.join(',')]).trim().split('\n').map(s=>{const n=s.indexOf('=');return [s.slice(0,n),s.slice(n+1)];})),
 stop:u=>sys(u,['stop',u.unit]),
 cessation:h=>JSON.parse(command('/usr/bin/sudo',['-n',process.execPath,fileURLToPath(import.meta.url),'--observe-holder',JSON.stringify(h)],10000)),
 safety:r=>JSON.parse(command(native,[...argv(r,'terminal-safety'),'--owner',r.owner])),
 retire:r=>{
  // Private immutable temporary evidence, removed in finally; never edit registry/source.
  const dir=fs.mkdtempSync('/tmp/terminal-growth-'),disposition=dir+'/disposition.json';
  try{const text=JSON.stringify(r.disposition);fs.writeFileSync(disposition,text,{mode:0o600});return JSON.parse(command(native,[...argv(r,'retire-growth'),'--owner',r.owner,'--disposition',disposition,'--disposition-sha256',sha(text)]));}
  finally{fs.rmSync(dir,{recursive:true,force:true});}
 }};
 return finalizeTerminal(request,io);
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
 try {
  if(process.argv[2]==='--observe-holder') console.log(JSON.stringify(executionCessation(JSON.parse(process.argv[3]))));
  else if(process.argv.length===4) console.log(JSON.stringify(await runFinalizer(process.argv[2],process.argv[3])));
  else fail('usage: terminal-finalizer.mjs REQUEST.json SHA256');
 } catch(e){console.log(JSON.stringify({ok:false,state:'retained',sourceDeleted:false,error:e.message}));process.exitCode=2;}
}
