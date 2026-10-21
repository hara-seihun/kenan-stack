import{execFile}from'node:child_process';import{promisify}from'node:util';import{readFile,open,lstat}from'node:fs/promises';import{constants}from'node:fs';import{join,dirname,resolve,parse}from'node:path';
import{assertObserverSuccess,createObserverHealth,type ObserverHealthState}from'./meeting-observer.js';
export interface PendingRead {operationId:string;receiptPath:string;snapshotPath:string;repairOwner:string|null;admittedAt:number;reconcileAt:number;repairWakeAt?:number;ownerUid?:number;launchUnit?:string;launcher?:{pid:number;bootId:string;startTicks:string}}
export type ReadState=ObserverHealthState&{pendingRead?:PendingRead;interruptedRead?:PendingRead & {reason:'process-ended-without-terminal-receipt';noticedAt?:number};legacyRepairWakeAt?:number;priorInterruptedReads?:unknown[]};
export function receiptPath(snapshot:string,id:string){if(!/^[a-f0-9-]{36}$/.test(id))throw Error('invalid read operation');return join(dirname(snapshot),'observer-receipts',id+'.json');}
export async function safeReceipt(path:string,uid?:number){
 let cursor=resolve(path);while(cursor!==parse(cursor).root){if((await lstat(cursor)).isSymbolicLink())throw Error('receipt symlink');cursor=dirname(cursor);}
 const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{const stat=await file.stat();if(!stat.isFile()||stat.size>4096||(stat.mode&0o022)||(uid!==undefined&&stat.uid!==uid))throw Error('foreign receipt');return JSON.parse(await file.readFile('utf8'));}finally{await file.close();}
}
export async function originalProcess(p:PendingRead){
 try{const r=await safeReceipt(p.receiptPath+'.process.json',p.ownerUid);if(r.operationId!==p.operationId||!Number.isInteger(r.pid)||r.pid<1)return'unknown';const boot=(await readFile('/proc/sys/kernel/random/boot_id','utf8')).trim();if(r.bootId!==boot)return'ended';try{const stat=await readFile(`/proc/${r.pid}/stat`,'utf8');return stat.split(') ')[1]?.split(' ')[19]===r.startTicks?'running':'ended';}catch(error){return (error as NodeJS.ErrnoException).code==='ENOENT'?'ended':'unknown';}}catch{return await launchCessation(p);}
}
export async function launchCessation(p:PendingRead){
 if(!p.launcher||!p.launchUnit||!/^agent-tool-(beta|production)-meeting-[a-f0-9-]{36}\.scope$/.test(p.launchUnit))return'unknown';
 try{
  if((await readFile('/proc/sys/kernel/random/boot_id','utf8')).trim()!==p.launcher.bootId)return'ended';
  let alive=false;try{alive=(await readFile(`/proc/${p.launcher.pid}/stat`,'utf8')).split(') ')[1]?.split(' ')[19]===p.launcher.startTicks;}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')return'unknown';}
  if(alive)return'unknown'; // A still-live launcher could admit the scope later.
  const result=await promisify(execFile)('/usr/bin/systemctl',['show',p.launchUnit,'--property=ActiveState','--value'],{timeout:5000});
  return ['inactive','failed'].includes(result.stdout.trim())?'ended':'unknown';
 }catch{return'unknown';}
}

/** Read retained custody only. Never starts a detector or upstream request. */
export async function reconcileRead(state:ReadState,now:number):Promise<{state:ReadState;settled:boolean;process?:string}> {
 const pending=state.pendingRead;if(!pending)return{state,settled:false};
 if(pending.receiptPath!==receiptPath(pending.snapshotPath,pending.operationId))return{state,settled:false,process:'unknown'};
 let r:Record<string,unknown>;try{r=await safeReceipt(pending.receiptPath,pending.ownerUid);}catch{
  const process=await originalProcess(pending);
  if(process==='ended'){
   const {pendingRead:_pending,...prior}=state;
   // Physical cessation is not a server result. Preserve the original UUID and
   // unknown result; never manufacture detector success/failure. Discovery is
   // read-only: an explicit current policy allows a NEW read once cessation is
   // proved, while preserving any actually recorded server deadline.
   return{state:{...prior,...(prior.interruptedRead&&prior.interruptedRead.operationId!==pending.operationId?{priorInterruptedReads:[...(prior.priorInterruptedReads??[]),prior.interruptedRead]}:{}),retryBlocked:false,lastError:'Meeting observer interrupted; original server result and retry hint unknown',interruptedRead:{...pending,reason:'process-ended-without-terminal-receipt'}},settled:false,process};
  }
  return{state:{...state,pendingRead:{...pending,reconcileAt:now+30000}},settled:false,process};
 }
 if(r.version!==1||r.operationId!==pending.operationId||!['success','failure'].includes(String(r.terminal)))return{state:{...state,pendingRead:{...pending,reconcileAt:now+30000}},settled:false,process:await originalProcess(pending)};
 const health=createObserverHealth();const{pendingRead:_p,...prior}=state;health.restore('read',{...prior,retryBlocked:false});
 if(r.terminal==='failure'){
  // Accept only the existing finite protocol, never raw errors/URLs from the receipt.
  if(r.kind!=='meeting-detection-error'||typeof r.code!=='string'||!(/^(calendar|directory|iam|token)-(network|timeout|unavailable|invalid-response|http-[45][0-9]{2})$/.test(r.code)||['detector-unavailable','directory-cache-invalid','directory-membership-out-of-bounds','invalid-policy-series','required-calendar-coverage-incomplete','calendar-coverage-incomplete'].includes(r.code)))return{state,settled:false};
  try{assertObserverSuccess({exitCode:1,output:Buffer.from(JSON.stringify({kind:r.kind,code:r.code,retryNotBefore:r.retryNotBefore,retryBlocked:r.retryBlocked}))},now);}catch(error){health.failure('read',now,error);}
 }else{
  if(typeof r.observedAt!=='string'||!Number.isFinite(Date.parse(r.observedAt))||typeof r.snapshotSha256!=='string'||!/^[a-f0-9]{64}$/.test(r.snapshotSha256))return{state,settled:false};
  // Receipt proves termination, not current policy authority. Keep lastGood and
  // unknown/stale until the normal observer validates actual policy again.
  health.failure('read',now,Error('Meeting observation is stale'));
 }
 return{state:preserveReadLineage(health.status('read')!,state),settled:true};
}

/** Health resets must not erase original uncertain operation custody. */
export function preserveReadLineage(health:ReadState,pending:ReadState):ReadState{return {...health,...(pending.interruptedRead?{interruptedRead:pending.interruptedRead}:{}),...(pending.priorInterruptedReads?{priorInterruptedReads:pending.priorInterruptedReads}:{})};}
