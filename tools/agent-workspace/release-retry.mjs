import {setTimeout} from 'node:timers/promises';

// Retry only a typed transient lock refusal. An unknown child outcome must first
// be reconciled; source retention, caller refusals and safety failures are final.
export function releaseLockBusy(receipt) {
 const items=Array.isArray(receipt)?receipt:[receipt];
 return items.some(item=>item?.error?.code==='release-resource-busy' ||
  (item?.futureGrowthSettlement?.kind==='retained' && item.futureGrowthSettlement.code==='workspace-capacity-lock-busy'));
}
// A background release is launched by a foreground tool call that names the checkout,
// and the same agent often runs another short call naming it (status, a repeated
// release). Those streaming calls are real Stack references, so the safety check
// rightly retains the tree, but they end within seconds. Re-observe while the ONLY
// thing retaining the checkout is running tool calls; every other reference, a
// process, a container, source retention or an unknown observation stays final.
// The full safety inspection reruns on every attempt; nothing is exempted.
export function transientToolCallReference(receipt) {
 const items=Array.isArray(receipt)?receipt:[receipt];
 const transient=item=>{
  const inspection=item?.inspection;
  if(inspection?.currentStackQueueProtected!==true||inspection.classification!=='referenced')return false;
  const refs=inspection.currentStackReferences;
  return Array.isArray(refs)&&refs.length>0&&refs.every(ref=>ref?.kind==='tool_call'&&ref.state==='running');
 };
 const settled=item=>item?.physicalDisposition?.kind==='removed'||item?.action==='released'||item?.record?.state==='released';
 return items.some(transient)&&items.every(item=>transient(item)||settled(item));
}
// A safety observation that ran out of time established no verdict and changed nothing
// (a loaded host can exhaust the census budget). Observe again while budget remains.
export function observationTimeout(receipt) {
 const items=Array.isArray(receipt)?receipt:[receipt];
 return items.length>0&&items.every(item=>['inspection-timeout','growth-observation-timeout'].includes(item?.error?.code));
}
export async function runReleaseWorker(run,{sleep=setTimeout,now=Date.now,budgetMs=120000,referencePollMs=2000}={}) {
 const deadline=now()+budgetMs;
 for(;;) {
  const result=run();let receipt;
  try{receipt=JSON.parse(result.stdout);}catch{receipt=null;}
  if(result.error||result.signal)return {result,receipt,exitCode:75,known:false};
  const busy=releaseLockBusy(receipt);
  if(busy && [0,75].includes(result.status)) {
   if(now()>=deadline)return {result,receipt,exitCode:75,known:true};
   await sleep(250);continue;
  }
  if(observationTimeout(receipt) && result.status===2 && now()+referencePollMs<deadline) {
   await sleep(referencePollMs);continue;
  }
  if(transientToolCallReference(receipt) && [0,2,75].includes(result.status) && now()+referencePollMs<deadline) {
   await sleep(referencePollMs);continue;
  }
  return {result,receipt,exitCode:result.status,known:Boolean(receipt)&&[0,2].includes(result.status)};
 }
}
