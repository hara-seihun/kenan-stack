// Native root plans are execution custody, including helpers outside the root and smoke
// checkouts. Read only the owning plan directory, never arbitrary evidence JSON or an age.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
export const DEFAULT_ROOT_PLANS='/home/kenan/data/converge-root-precheck';
const SHA=/^[0-9a-f]{40}$/;
const exactPath=s=>typeof s==='string'&&path.isAbsolute(s)&&s!=='/'&&path.normalize(s)===s;
const overlap=(a,b)=>a===b||a.startsWith(b+'/')||b.startsWith(a+'/');
export function rootPlanReferences(roots=null,{directory=DEFAULT_ROOT_PLANS,maxEntries=512,maxFileBytes=4<<20,maxTotalBytes=32<<20}={}){
 const errors=[],references=[],released=[];let total=0;
 const finish=()=>({errors,references:roots===null?references:references.filter(r=>r.paths.some(p=>roots.some(root=>overlap(p,root)))),released,complete:errors.length===0,observations:[{source:'native-root-plans',directory,plans:references.length,released:released.length}],observedAt:Date.now()});
 if(roots!==null&&(!Array.isArray(roots)||roots.some(p=>!exactPath(p))))return {errors:['exact absolute native root reference paths required'],references:[],released:[],complete:false,observations:[],observedAt:Date.now()};
 let names;try{names=fs.readdirSync(directory).filter(n=>n.endsWith('.plan.json')).sort();}catch(e){if(e.code!=='ENOENT')errors.push(`${directory}: ${e.message}`);return finish();}
 if(names.length>maxEntries){errors.push(`${directory}: native root plan entry bound exceeded`);return finish();}
 const read=file=>{const st=fs.lstatSync(file);if(!st.isFile()||st.size>maxFileBytes)throw Error('native root plan is not a bounded regular file');total+=st.size;if(total>maxTotalBytes)throw Error('native root plan total byte bound exceeded');return fs.readFileSync(file);};
 for(const name of names){const file=path.join(directory,name);try{
  const bytes=read(file),plan=JSON.parse(bytes);if(!plan||!SHA.test(plan.commit)||!exactPath(plan.checkout)||!plan.stages||typeof plan.stages!=='object'||Array.isArray(plan.stages))throw Error('native root plan lacks exact commit, checkout or stages');
  const paths=new Set([plan.checkout]);if(plan.candidate!==undefined&&plan.candidate!==null){if(!exactPath(plan.candidate.checkout)||!SHA.test(plan.candidate.commit))throw Error('native root plan candidate identity malformed');paths.add(plan.candidate.checkout);}
  const addArgv=(argv,field)=>{if(!Array.isArray(argv)||argv.length>1024||argv.some(x=>typeof x!=='string'))throw Error(`native root plan ${field} argv malformed`);for(const arg of argv)if(exactPath(arg))paths.add(arg);};
  const stages=Object.entries(plan.stages);if(!stages.length||stages.length>32)throw Error('native root plan stages bound invalid');
  for(const [stage,spec]of stages)addArgv(spec?.argv,stage);
  for(const field of ['finish','candidateFinish'])if(plan[field]!==undefined)addArgv(plan[field],field);
  const digest=crypto.createHash('sha256').update(bytes).digest('hex');
  const settlement=file+'.custody-released.json';let terminal;
  try{terminal=JSON.parse(read(settlement));}catch(e){if(e.code!=='ENOENT')throw Error(`native root plan settlement unreadable: ${e.message}`);}
  if(terminal!==undefined){if(terminal?.state!=='released'||terminal.planSha256!==digest||typeof terminal.owner!=='string'||!terminal.owner||typeof terminal.reason!=='string'||!terminal.reason||!Array.isArray(terminal.paths)||terminal.paths.length!==paths.size||new Set(terminal.paths).size!==paths.size||[...paths].some(p=>!terminal.paths.includes(p)))throw Error('native root plan settlement does not match all exact execution dependencies');released.push({kind:'native_root_plan',id:name,state:'released',evidence:settlement,paths:[...paths]});continue;}
  references.push({kind:'native_root_plan',id:name,state:plan.state??'unsettled',resourceClass:'qualification-request',targetPath:plan.checkout,paths:[...paths],evidence:file,planSha256:digest,commit:plan.commit});
 }catch(e){errors.push(`${file}: ${e.message}`);}}
 return finish();
}
