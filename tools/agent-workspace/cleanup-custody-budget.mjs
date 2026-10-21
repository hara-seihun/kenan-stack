import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

export class CustodyBudgetError extends Error {
 constructor(code,detail){super(`${code}: ${detail}`);this.code=code;}
}
const deny=(code,detail)=>{throw new CustodyBudgetError(code,detail);};
export function qualifyCleanupCustody({exclusiveBytes,importUpperBytes,peakUpperBytes,freeBytes,protectedBytes}){
 for(const value of [exclusiveBytes,importUpperBytes,peakUpperBytes,freeBytes,protectedBytes])
  if(!Number.isSafeInteger(value)||value<0)deny('CUSTODY_BUDGET_UNMEASURED','Every allocation/peak must be independently measured');
 if(peakUpperBytes<importUpperBytes)deny('CUSTODY_BUDGET_INVALID','Import peak is below retained import');
 if(freeBytes-peakUpperBytes<protectedBytes)deny('CUSTODY_IMPORT_EXCEEDS_HEADROOM','Custody preservation must fit before deletion without consuming protected headroom');
 if(exclusiveBytes<=importUpperBytes)deny('CUSTODY_IMPORT_EXCEEDS_RECLAIM','Closed source cleanup would amplify disk usage; preserve source and establish durable custody independently');
 return {netReclaimUpperBytes:exclusiveBytes-importUpperBytes,physicalCreditBytes:0};
}
export function exclusiveAllocatedBytes(root,{maxEntries=200000,deadline=Date.now()+10000}={}){
 const pending=[root],device=fs.lstatSync(root).dev;let bytes=0,count=0;
 while(pending.length){
  if(++count>maxEntries||Date.now()>deadline)deny('CUSTODY_BUDGET_UNMEASURED','Bounded allocation walk exhausted');
  const p=pending.pop(),s=fs.lstatSync(p);
  if(s.dev!==device)deny('CUSTODY_BUDGET_UNMEASURED','Mount crossed');
  // A hardlinked pack is not freed when one checkout is removed.
  if(s.nlink===1||s.isDirectory())bytes+=s.blocks*512;
  if(s.isDirectory()&&!s.isSymbolicLink())for(const n of fs.readdirSync(p))pending.push(path.join(p,n));
 }
 return bytes;
}
export function assertNoAmplifyingCleanupImport(workspace,statePath){
 const alt=path.join(workspace,'.git','objects','info','alternates');
 if(!fs.existsSync(alt)||!fs.readFileSync(alt,'utf8').trim())return {kind:'no-alternate-import'};
 const mirrorRoot=path.join(path.dirname(statePath),'mirrors');
 const stores=fs.readFileSync(alt,'utf8').trim().split('\n').map(v=>path.resolve(path.dirname(path.dirname(alt)),v));
 if(stores.every(p=>fs.existsSync(p)&&path.basename(p)==='objects'&&path.dirname(path.dirname(p))===mirrorRoot&&!fs.existsSync(path.join(p,'info','alternates'))))return {kind:'existing-independent-mirror'};
 // prepareMirror may clone the entire reference history, not just HEAD's
 // missing objects. Price its conservative complete object-byte upper bound.
 const result=spawnSync('git',['-C',workspace,'cat-file','--batch-all-objects','--batch-check=%(objectsize)'],{encoding:'utf8',timeout:15000,maxBuffer:32*1024*1024,env:{...process.env,GIT_NO_LAZY_FETCH:'1',GIT_NO_REPLACE_OBJECTS:'1'}});
 if(result.error||result.status!==0)deny('CUSTODY_BUDGET_UNMEASURED','Cannot bound independent custody import before cleanup');
 let raw=0,count=0;
 for(const row of result.stdout.trim().split('\n')){if(!/^\d+$/.test(row))deny('CUSTODY_BUDGET_UNMEASURED','Invalid object size');raw+=Number(row);count++;if(!Number.isSafeInteger(raw))deny('CUSTODY_BUDGET_UNMEASURED','Object size overflow');}
 // Deflate framing/index/OID/per-object overhead. Retain a safe upper bound;
 // no deletion proceeds or logical hardlink bytes count as backing.
 const upper=Math.ceil(raw*1.01)+count*4096+1024*1024;
 const exclusive=exclusiveAllocatedBytes(workspace);
 // No positive result is admitted without a reserved import peak. Native
 // cleanup has no such reservation: imports belong to explicit custody repair.
 if(upper>=exclusive)deny('CUSTODY_IMPORT_EXCEEDS_RECLAIM',`Import upper bound ${upper} exceeds exclusive reclaim ${exclusive}`);
 deny('CUSTODY_IMPORT_RESERVATION_REQUIRED','Positive estimate alone does not reserve independent custody peak; repair custody explicitly before native cleanup');
}
