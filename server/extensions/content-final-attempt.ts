import {open,realpath} from 'node:fs/promises';
import {constants} from 'node:fs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash,randomUUID} from 'node:crypto';
const exec=promisify(execFile);
const ROOT='/etc/kenan/content-option-b/';
export type FinalAttemptNamespace='legacy'|'replacement-attempt';
export function finalAttemptRoot(namespace:FinalAttemptNamespace='legacy'){
 if(namespace!=='legacy'&&namespace!=='replacement-attempt')throw Error('content_final_root:namespace');
 return namespace==='legacy'?ROOT:ROOT+'replacement-attempt/';
}
type Row=Record<string,unknown>;
export interface FinalAttemptRootIO{read(path:string):Promise<string>;systemctl(args:string[]):Promise<string>;now():number;}
export const finalAttemptRootIO:FinalAttemptRootIO={now:Date.now,
 async read(path){if(!(['legacy','replacement-attempt'] as const).some(n=>['last-attempt-authority.json','last-attempt-deadline.json','last-attempt-qualification.json'].some(x=>path===finalAttemptRoot(n)+x)))throw Error('content_final_root:path');const f=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{const s=await f.stat();if(!s.isFile()||s.uid!==0||s.nlink!==1||(s.mode&0o777)!==0o600||s.size>65536||await realpath(path)!==path)throw Error('content_final_root:custody');const b=await f.readFile();if(b.length>65536)throw Error('content_final_root:size');return b.toString();}finally{await f.close();}},
 async systemctl(args){return(await exec('/usr/bin/systemctl',args,{timeout:5000,maxBuffer:65536,encoding:'utf8'})).stdout;},
};
function insist(ok:unknown,code:string):asserts ok{if(!ok)throw Error('content_final_root:'+code);}
/** Sole A7 arms and seals these two deadline units BEFORE migration. This readback
 * cannot arm, cancel or replace any timer. It refuses a mere receipt without live
 * timer/service-byte verification. Original 16:20 timer is never modified here. */
export function finalAttemptRootCapabilities(io:FinalAttemptRootIO=finalAttemptRootIO,namespace:FinalAttemptNamespace='legacy'){const root=finalAttemptRoot(namespace);return{
 readAuthority:()=>io.read(root+'last-attempt-authority.json'),
 async verifyQualifiedCandidate(candidate:{sourceCommit:string;image:string}){
  const body=await io.read(root+'last-attempt-qualification.json'),p=JSON.parse(body) as Row;
  insist(p['sourceCommit']===candidate.sourceCommit&&p['image']===candidate.image&&p['nativeInfrastructureCompiler']==='PASS'&&p['candidateOwnStaging']==='PASS'&&p['rollback']==='PASS'&&typeof p['qualificationReceipt']==='string'&&Boolean(p['qualificationReceipt']),'exact_candidate_qualification');
  return{...candidate,receipt:String(p['qualificationReceipt']),candidateOwnStaging:true as const,rollback:true as const};
 },
 async assertArmedDeadline(input:{planSHA256:string;windowStart:string;windowExpires:string;sourceCommit:string;image:string}){
  const body=await io.read(root+'last-attempt-deadline.json'),p=JSON.parse(body) as Row;
  insist(p['version']===1&&p['planSHA256']===input.planSHA256&&/^[a-f0-9]{64}$/u.test(input.planSHA256)&&p['sourceCommit']===input.sourceCommit&&p['image']===input.image&&p['windowStart']===input.windowStart&&p['windowExpires']===input.windowExpires&&p['originalDeadlinePreserved']===true&&p['originalDeadline']==='2026-10-22T16:20:01.000Z'&&Date.parse(input.windowExpires)>io.now(),'deadline_identity');
  insist(/^[a-f0-9]{64}$/u.test(String(p['intentSHA256'])),'immutable_intent');
  const units=p['units'] as Row[];insist(Array.isArray(units)&&units.length===2,'two_deadlines');
  for(const [index,kind]of ['gate-close','teardown'].entries()){
   const u=units[index]!;const timer=String(u['timer']),service=String(u['service']);
   insist(u['kind']===kind&&new RegExp('^kenan-content-final-'+kind+'-[a-f0-9]{16}\\.timer$','u').test(timer)&&service===timer.replace(/\.timer$/u,'.service'),'owned_deadline_unit');
   for(const unit of [timer,service]){const actual=await io.systemctl(['cat',unit]);if(kind==='gate-close'&&unit===service)insist(actual.includes((namespace==='legacy'?'--close-final-gate ':'--close-replacement-final-gate ')+String(p['intentSHA256'])),'immutable_watchdog_argv');insist(createHash('sha256').update(actual).digest('hex')===(u['unitSHA256'] as Row)?.[unit],'unit_bytes');}
   const show=Object.fromEntries((await io.systemctl(['show',timer,'--property=ActiveState,Unit,NextElapseUSecRealtime'])).trim().split('\n').map(x=>{const i=x.indexOf('=');return[x.slice(0,i),x.slice(i+1)];}));
   const due=Date.parse(show['NextElapseUSecRealtime']??'');
   insist(show['ActiveState']==='active'&&show['Unit']===service&&Number.isFinite(due)&&due>=Date.parse(input.windowExpires)&&due<=Date.parse(input.windowExpires)+1000,'live_armed_deadline');
  }
  return{receipt:'root-sha256:'+createHash('sha256').update(body).digest('hex'),windowExpires:input.windowExpires,atomicGateClose:true as const,teardownArmed:true as const,originalDeadlinePreserved:true as const};
 },
};}

/** Id-specific immutable intent, separate from the retired mutable CHOSEN-WINDOW.
 * A7 seals it create-only, then arms both timers and publishes live readback.
 * This deadline closes the gate only: actual provider teardown stays sole A7. */
export async function closeFinalAttemptGate(intentSHA256:string,namespace:FinalAttemptNamespace='legacy'){
 const root=finalAttemptRoot(namespace);
 insist(process.getuid?.()===0&&/^[a-f0-9]{64}$/u.test(intentSHA256),'root_intent');
 const fs=await import('node:fs/promises');
 const path=root+'last-attempt-intents/'+intentSHA256+'.json',f=await fs.open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
 let raw:Buffer;try{const s=await f.stat();insist(s.isFile()&&s.uid===0&&s.nlink===1&&(s.mode&0o777)===0o600&&s.size<=16384&&await fs.realpath(path)===path,'immutable_intent_custody');raw=await f.readFile();}finally{await f.close();}
 insist(createHash('sha256').update(raw).digest('hex')===intentSHA256,'immutable_intent_digest');const i=JSON.parse(raw.toString()) as Row;
 const now=Date.now();validateFinalDeadlineIntent(i,now,namespace);
 const grant=await finalAttemptRootIO.read(root+'last-attempt-authority.json');insist(createHash('sha256').update(grant).digest('hex')===i['authoritySHA256'],'intent_authority_digest');
 const gate='/etc/kenan/content-cadence-diagnostic.json',temporary=root+'.deadline-'+intentSHA256+'-'+randomUUID();
 const bytes=JSON.stringify({version:1,intentId:(namespace==='legacy'?'last-attempt:':'replacement-attempt:')+intentSHA256,budgetId:i['budgetId'],schedulerJob:'projects/acme-project/locations/us-central1/jobs/production-insight-content-canonical-follow',windowStart:i['windowStart'],windowExpires:i['windowExpires']});
 let t;try{t=await fs.open(temporary,'wx',0o600);await t.writeFile(bytes);await t.sync();}finally{await t?.close();}
 try{await fs.link(temporary,gate);}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;}finally{await fs.unlink(temporary);}
 const g=await fs.open(gate,constants.O_RDONLY|constants.O_NOFOLLOW);try{const s=await g.stat();insist(s.uid===0&&s.isFile()&&(s.mode&0o022)===0&&s.size<=16384,'gate_custody');const actual=JSON.parse(await g.readFile('utf8')) as Row;insist(actual['budgetId']===i['budgetId']&&Date.parse(String(actual['windowExpires']))<=now,'foreign_active_gate_not_overwritten');}finally{await g.close();}
 const receipt=root+'last-attempt-deadline-fired-'+intentSHA256+'.json';
 let r;try{r=await fs.open(receipt,'wx',0o600);await r.writeFile(JSON.stringify({version:1,intentSHA256,at:new Date(now).toISOString(),gatePresentFailclosed:true,providerWrites:false,teardownConfirmed:false}));await r.sync();}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;}finally{await r?.close();}
}
if(process.argv[2]==='--close-replacement-final-gate')closeFinalAttemptGate(process.argv[3]??'','replacement-attempt').catch(error=>{console.error(String(error));process.exitCode=1;});
if(process.argv[2]==='--close-final-gate')closeFinalAttemptGate(process.argv[3]??'').catch(error=>{console.error(String(error));process.exitCode=1;});

export function validateFinalDeadlineIntent(i:Row,now:number,namespace:FinalAttemptNamespace='legacy'){
 finalAttemptRoot(namespace);
 if(namespace==='replacement-attempt')insist(i['priorIntentSHA256']==='9aee8732214744fec6cdc7770511253d5099448e260efc50b7ffd17447e34e14'&&i['priorAbsenceGeneration']==='1792704199514885'&&i['priorCreationIntentSHA256']==='58f50622cdf19d4d4a20324375c5bdd7d04d6b3e4e30ca068cf6456153bdd708','replacement_prior_terminal');
 const end=Date.parse(String(i['windowExpires'])),start=Date.parse(String(i['windowStart']));
 insist(i['version']===1&&i['kind']===(namespace==='legacy'?'qualified_final_natural_attempt':'qualified_replacement_final_natural_attempt')&&i['originalEpoch']==='2026-10-21T23:58:57.945Z'&&i['budgetId']==='content-pilot:7851b228ba099cbb852008e4fa0ca601df32c168f08933cc7e79db8573e46c4b'&&i['remainingNaturalAttempts']===1&&i['maxTotalAttempts']===3&&i['cumulativeCapUSD']===5.25&&i['manualRunJob']===false&&i['permanentActivation']===false&&/^[a-f0-9]{64}$/u.test(String(i['authoritySHA256']))&&/^[a-f0-9]{40}$/u.test(String(i['adapterSourceCommit']))&&/^[a-f0-9]{64}$/u.test(String(i['planSHA256']))&&end-start===2700000&&start>=Date.parse(namespace==='legacy'?'2026-10-22T00:00:00Z':'2026-10-22T21:31:00Z')&&start<Date.parse(namespace==='legacy'?'2026-10-22T23:59:00Z':'2026-10-23T23:59:00Z')&&now>=end,'last_attempt_due');
}
