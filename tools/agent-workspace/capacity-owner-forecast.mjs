import fs from 'node:fs';
import {classifyOwner} from './owner-liveness.mjs';
import {currentStackQueueReferences} from './cache-queue.mjs';
import {observeGrowthWriters} from './growth-writer-observation.mjs';
import {processAncestry,within} from './safety-census.mjs';
import {boundedCommand} from './bounded-command.mjs';
import {privilegedCommand} from './operator-observation.mjs';
import {pathToFileURL} from 'node:url';

export const OWNER_IDLE_FORECAST_MS=60*60_000;

// This is an admission forecast only. It never changes a lease, physical free
// space, source custody or the stricter owner classification used for deletion.
export function ownerFutureWrites(owner,observation,now=Date.now()){
 const verdict=classifyOwner(owner,observation);
 if(verdict.kind==='unknown')return {kind:'unknown',code:verdict.code};
 const rows=observation.agents.filter(a=>a.id===owner);
 if(rows.every(a=>a.archived===true||a.state==='stopped'))return {kind:'inactive',code:'native-owner-ended'};
 const live=rows.filter(a=>a.archived!==true&&a.state!=='stopped');
 if(live.every(a=>a.state==='idle'&&Number.isSafeInteger(Number(a.updatedAt))&&Number(a.updatedAt)>0&&Number(a.updatedAt)<=now&&now-Number(a.updatedAt)>OWNER_IDLE_FORECAST_MS))
  return {kind:'inactive',code:'native-owner-idle-over-one-hour'};
 return {kind:'live',code:'native-owner-active'};
}

export function observeCapacityProcesses(roots,deadline){
 const ignored=processAncestry();
 const pids=fs.readdirSync('/proc').filter(name=>/^\d+$/.test(name)).map(Number).filter(pid=>!ignored.has(pid));
 // Bound every filesystem read in the shared observer, including the /proc walk.
 const io=Object.fromEntries(['readdirSync','readlinkSync','readFileSync','realpathSync'].map(name=>[name,(...args)=>{
  if(Date.now()>=deadline)throw new Error('capacity process observation deadline exhausted');
  return fs[name](...args);
 }]));
 return observeGrowthWriters({roots,pids,io});
}

function privilegedProcesses(roots,deadline){
 const remaining=deadline-Date.now();
 if(remaining<=0)throw new Error('capacity child observation deadline exhausted');
 const result=boundedCommand('sudo',privilegedCommand(import.meta.url,['--processes',JSON.stringify(roots),String(deadline)]),{encoding:'utf8',timeout:remaining,maxBuffer:2<<20});
 if(result.status!==0||result.error)throw new Error('capacity process observation unavailable: '+String(result.error?.code??result.stderr??result.status).slice(0,1000));
 const value=JSON.parse(result.stdout);
 if(typeof value?.complete!=='boolean'||!Array.isArray(value.references)||!Array.isArray(value.errors))throw new Error('capacity process observation malformed');
 return value;
}

export function observeCapacityChildren(roots,{deadline,queue=currentStackQueueReferences,writers=privilegedProcesses}={}){
 try{
  const physical=writers(roots,deadline);
  const native=queue(roots,{resourceKind:'physical-checkout',deadline});
  return {complete:physical.complete&&native.errors.length===0,errors:[...physical.errors,...native.errors],
   references:[...physical.references.filter(r=>!r.exited).map(r=>({path:r.root,kind:'process',pid:r.pid})),
    ...native.references.flatMap(r=>(r.matchedRoots??r.roots??roots).map(root=>({path:root,kind:'native-tool',id:r.id}))) ]};
 }catch(error){return {complete:false,errors:[String(error.message)],references:[]};}
}

export function capacityOwnerProjection(row,owner,observation,children,now=Date.now()){
 if(row.state==='creating')return {zero:false,code:'pending-construction'};
 const intent=ownerFutureWrites(owner,observation,now);
 if(intent.kind!=='inactive')return {zero:false,code:intent.code};
 if(!children?.complete)return {zero:false,code:'child-observation-unavailable'};
 if(children.references.some(ref=>within(row.path,ref.path)||within(ref.path,row.path)))return {zero:false,code:'active-child'};
 return {zero:true,code:intent.code};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 if(process.argv[2]!=='--processes')throw new Error('explicit process observation required');
 const roots=JSON.parse(process.argv[3]),deadline=Number(process.argv[4]);
 if(!Number.isSafeInteger(deadline))throw new Error('explicit absolute process observation deadline required');
 console.log(JSON.stringify(observeCapacityProcesses(roots,deadline)));
}
