import {setTimeout} from 'node:timers/promises';

// Retry only a typed transient lock refusal. An unknown child outcome must first
// be reconciled; source retention, caller refusals and safety failures are final.
export function releaseLockBusy(receipt) {
 const items=Array.isArray(receipt)?receipt:[receipt];
 return items.some(item=>item?.error?.code==='release-resource-busy' ||
  (item?.futureGrowthSettlement?.kind==='retained' && item.futureGrowthSettlement.code==='workspace-capacity-lock-busy'));
}
export async function runReleaseWorker(run,{sleep=setTimeout,now=Date.now,budgetMs=120000}={}) {
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
  return {result,receipt,exitCode:result.status,known:Boolean(receipt)&&[0,2].includes(result.status)};
 }
}
