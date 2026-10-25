// Read-only projection of native root-precheck cessation. Never finalizes, stops,
// releases or writes an execution checkout. A plan, pushed source or old lease alone
// is not terminal evidence. Every declared stage must have an exact settled grant.
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {isDeepStrictEqual} from 'node:util';

export const PLAN_ROOT='/home/kenan/data/converge-root-precheck';
export const AUTHORITY_ROOT='/home/kenan/data/converge-releases/host-slots';
const UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const SHA=/^[a-f0-9]{40}$/;
const absolute=p=>typeof p==='string'&&path.isAbsolute(p)&&path.normalize(p)===p&&p!=='/';
const overlaps=(a,b)=>a===b||a.startsWith(b+'/')||b.startsWith(a+'/');
const same=(a,b)=>isDeepStrictEqual(a,b);
function boundedRecords(directory,suffix,{secure=false}={}) {
 if(!fs.existsSync(directory))return [];
 const names=fs.readdirSync(directory);if(names.length>4096)throw new Error('record count bound');
 let total=0;
 return names.filter(n=>n.endsWith(suffix)).map(n=>{
  const file=path.join(directory,n),fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
  try {
   const st=fs.fstatSync(fd);
   if(!st.isFile()||st.size>4*1024**2||(total+=st.size)>128*1024**2)throw new Error('record bound or type');
   if(secure&&(st.uid!==0||(st.mode&0o077)!==0))throw new Error('authority ownership');
   const buffer=Buffer.alloc(st.size+1),size=fs.readSync(fd,buffer,0,buffer.length,0);
   if(size!==st.size)throw new Error('record changed during bounded read');
   return JSON.parse(buffer.subarray(0,size).toString('utf8'));
  } finally {fs.closeSync(fd);} 
 });
}
// Read only root-owned authority records. Do not emit grant tokens, issuer calls,
// shell dispatchers, credentials, or user-supplied copies of terminal receipts.
export function authoritySnapshot(directory=AUTHORITY_ROOT,{secure=true}={}) {
 return boundedRecords(directory,'.authority',{secure}).map(r=>({
  state:r.state,terminal:r.terminal,created:r.created,
  spec:{cwd:r.spec?.cwd,source:r.spec?.source,argv:r.spec?.argv,operation:r.spec?.operation,job:r.spec?.job},
  settled:r.version===1&&r.state==='terminal'&&Number.isFinite(r.terminal)&&r.terminal>=r.created&&
   UUID.test(r.spec?.operation)&&UUID.test(r.spec?.job)&&SHA.test(r.spec?.source)&&
   typeof r.unit==='string'&&/^[a-f0-9]{32}$/.test(r.invocation??'')&&r.settler?.boot===r.boot
 }));
}
export function readAuthoritySnapshot() {
 const r=spawnSync('/usr/bin/sudo',['-n',process.execPath,fileURLToPath(import.meta.url),'--authority-snapshot'],{encoding:'utf8',timeout:10000,maxBuffer:32*1024**2});
 if(r.status!==0||r.error)throw new Error('native authority census unavailable');
 const rows=JSON.parse(r.stdout);if(!Array.isArray(rows))throw new Error('invalid native authority census');return rows;
}
export function terminalRootPaths(rows,{plans,authorities,now=Date.now(),safe=()=>false,head=()=>null}={}) {
 const settled=new Map();
 if(!Array.isArray(plans)||!Array.isArray(authorities))return settled;
 const uses=new Map();
 for(const plan of plans){
  if(!absolute(plan?.checkout))continue;
  for(const target of [plan,plan.candidate].filter(Boolean)){
   if(!absolute(target.checkout))continue;
   const list=uses.get(target.checkout)??[];list.push({plan,target});uses.set(target.checkout,list);
  }
 }
 for(const row of rows){
  if(row.state==='creating'||!uses.has(row.path))continue;
  const groups=uses.get(row.path);let at=0,valid=true;
  for(const {plan,target} of groups){
   if(plan.planComplete!==true||plan.state!=='planned'||target.workspaceId!==row.id||!SHA.test(target.commit)||
      !same(plan.requiredStages,['compile','tests','smoke'])||!plan.stages||
      Object.keys(plan.stages).sort().join(',')!=='compile,smoke,tests') {valid=false;break;}
   const relevant=authorities.filter(a=>(absolute(a.spec?.cwd)&&overlaps(a.spec.cwd,row.path))||
    (Array.isArray(a.spec?.argv)&&a.spec.argv.some(arg=>absolute(arg)&&overlaps(arg,row.path))));
   // An admitted/pending/uncertain consumer wins over any historical terminal grant.
   if(relevant.some(a=>!a.settled)){valid=false;break;}
   for(const stage of Object.values(plan.stages)){
    if(!Array.isArray(stage.argv)||!stage.argv.length){valid=false;break;}
    const matches=authorities.filter(a=>a.spec?.cwd===plan.checkout&&a.spec.source===plan.commit&&same(a.spec.argv,stage.argv));
    if(!matches.length||matches.some(a=>!a.settled||!Number.isFinite(a.terminal)||!Number.isFinite(a.created)||a.terminal<a.created||a.terminal*1000>now||a.created*1000<row.created_at)){valid=false;break;}
    at=Math.max(at,...matches.map(a=>a.terminal*1000));
   }
   if(!valid||head(row.path)!==target.commit){valid=false;break;}
  }
  if(valid&&at&&safe(row))settled.set(row.path,at);
 }
 return settled;
}
export function rootTerminalSafety(row,{frozen,observe}) {
 try {
  if(frozen(row.path)!==null)return false;
  const safety=observe(row);
  return Array.isArray(safety?.errors)&&safety.errors.length===0&&Array.isArray(safety.references)&&safety.references.length===0;
 } catch {return false;}
}
export function nativeTerminalRootPaths(rows,{safe,head,planRoot=PLAN_ROOT,authorities=readAuthoritySnapshot}={}) {
 if(!fs.existsSync(planRoot))return new Map();
 try {
  const plans=boundedRecords(planRoot,'.plan.json');
  if(!rows.some(row=>plans.some(p=>p?.checkout===row.path||p?.candidate?.checkout===row.path)))return new Map();
  return terminalRootPaths(rows,{plans,authorities:authorities(),safe,head});
 }
 catch{return new Map();} // Unknown or partial census grants no credit.
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 if(process.argv[2]!=='--authority-snapshot'||process.getuid?.()!==0)process.exitCode=2;
 else try{console.log(JSON.stringify(authoritySnapshot()));}catch{process.exitCode=2;}
}
