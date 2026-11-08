/** One CONTENT machine-to-machine endpoint inside the EXISTING Kenan runtime.
 * The integration owner mounts this exact route before human session middleware;
 * no other extension/user route gains an authentication exception.
 */
import {constants} from 'node:fs';
import {readContentAdmissionFence,sameContentAdmissionFence,fencedContentDispatch} from './content-admission-fence.js';
import {routeContentDiagnostic,classifyDiagnosticIntent,contentPreflight} from './content-diagnostic.js';
import {open,realpath,lstat,writeFile,rename,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {CONTENT_REPLACEMENT_MODULES,CONTENT_REVIEWED_MODULES,CONTENT_FINAL_CLEANUP_MODULES,CONTENT_FINAL_CLEANUP_ROOTS,assertContentImportClosure} from './content-module-closure.js';
import {pathToFileURL} from 'node:url';
import type {Extension,Deps} from '../types.js';
export const CONTENT_PUBLIC_PATH='/api/operations/content-cadence';
export const CONTENT_RUNTIME_BINDING='/etc/kenan/content-cadence-host.json';
const OWNER='00000000-0000-4000-8000-000000000002';
const modules=['content-cadence-dispatch-native.ts','content-cadence-dispatch.ts','content-cadence-recovery.ts','content-cadence-operation-readback.ts','content-cadence-job-contract.ts','content-cadence-pilot.ts'] as const;
const controlModules=['content-cadence-control-auth.ts','config.ts'] as const;
const lifecycleModules=['content-cadence-lifecycle.ts','content-cadence-provider-reader.ts','content-cadence-acceptance.ts'] as const;
const continuationModule='content-cadence-continuation.ts';
const knownModules:readonly string[]=[...modules,...controlModules,...lifecycleModules,continuationModule];
export interface ContentHostBinding {
 version:1|2|3|4|5|6; closureRoots?:string[]; productTargetCommit?:string; enabled:true; channel:'beta'; owner:typeof OWNER;
 publicAudience:string; acmeSourceRoot:string; sourceCommit:string;
 moduleSHA256:Record<string,string>;
 operatorConfig:{dispatch:{sourceCommit:string;image:string;audience:string;schedulerEmail:string;schedulerSubject:string;recoveryOwner:string};receiptBucket:string};
}
export interface ContentHostPorts {
 handler(request:Request):Promise<Response>;
 recover():Promise<unknown>;
}
export function validateContentHostBinding(input:unknown):ContentHostBinding{
 const b=input as ContentHostBinding,d=b?.operatorConfig?.dispatch;
 const legacy=CONTENT_REVIEWED_MODULES.filter(x=>!CONTENT_FINAL_CLEANUP_MODULES.includes(x as typeof CONTENT_FINAL_CLEANUP_MODULES[number]));
 const reviewed=b?.version===6?CONTENT_REPLACEMENT_MODULES:b?.version===5?CONTENT_REVIEWED_MODULES:b?.version===4?legacy:legacy.filter(x=>x!=='content-cadence-final-attempt-native.ts'&&(x!=='content-cadence-cumulative-cost.ts'||Object.hasOwn(b?.moduleSHA256??{},x)));
 const expectedRoots=(b?.version===5||b?.version===6)?CONTENT_FINAL_CLEANUP_ROOTS:['content-cadence-dispatch-native.ts','content-cadence-option-b-native.ts'];
 if(![1,2,3,4,5,6].includes(b?.version)||b.enabled!==true||b.channel!=='beta'||b.owner!==OWNER||!d||d.recoveryOwner!==OWNER
  ||!/^https:\/\/kenan\.acme.example\/pi-stack\/api\/operations\/content-cadence$/u.test(b.publicAudience)
  ||d.audience!==b.publicAudience||!/^[a-f0-9]{40}$/u.test(b.sourceCommit)||!/^[a-f0-9]{40}$/u.test(d.sourceCommit)||(b.version===1?b.sourceCommit!==d.sourceCommit:b.productTargetCommit!==d.sourceCommit||(b.version===2?Object.keys(b.moduleSHA256??{}).length!==knownModules.length:Object.keys(b.moduleSHA256??{}).length!==reviewed.length||JSON.stringify(b.closureRoots)!==JSON.stringify(expectedRoots)))
  ||b.acmeSourceRoot!=='/opt/kenan-acme/content-cadence/'+b.sourceCommit
  ||!/^us-central1-docker\.pkg\.dev\/acme-project\/acme-insight\/insight@sha256:[a-f0-9]{64}$/u.test(d.image)
  ||!/^acme-content-scheduler@acme-project\.iam\.gserviceaccount\.com$/u.test(d.schedulerEmail)
  ||!/^\d{10,30}$/u.test(d.schedulerSubject)||b.operatorConfig.receiptBucket!=='acme-project-production-insight-artifacts'
  ||!b.moduleSHA256||(b.version<3&&![modules.length,modules.length+controlModules.length,knownModules.length-1,knownModules.length].includes(Object.keys(b.moduleSHA256).length))
  ||Object.keys(b.moduleSHA256).some(name=>!(b.version>=3?reviewed:knownModules as readonly string[]).includes(name))|| (b.version>=3&&reviewed.some(name=>!/^[a-f0-9]{64}$/u.test(b.moduleSHA256[name]??'')))
  ||modules.some(name=>!/^[a-f0-9]{64}$/u.test(b.moduleSHA256[name]??''))
  ||controlModules.some(name=>Object.keys(b.moduleSHA256).length!==modules.length&&!/^[a-f0-9]{64}$/u.test(b.moduleSHA256[name]??''))
  ||lifecycleModules.some(name=>Object.keys(b.moduleSHA256).length>=knownModules.length-1&&!/^[a-f0-9]{64}$/u.test(b.moduleSHA256[name]??''))
  ||(Object.keys(b.moduleSHA256).length===knownModules.length&&!/^[a-f0-9]{64}$/u.test(b.moduleSHA256[continuationModule]??'')))throw Error('content_host:binding_invalid');
 return b;
}
export async function readRootReferenceBytes(path:string):Promise<Buffer>{
 const f=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{const s=await f.stat();if(!s.isFile()||s.uid!==0||(s.mode&0o022)!==0||s.size>65536||await realpath(path)!==path)throw Error('content_host:root_reference_custody');return await f.readFile();}finally{await f.close();}
}
export async function readRootReferenceJson(path:string):Promise<unknown>{return JSON.parse((await readRootReferenceBytes(path)).toString('utf8'));}
export function assertContentModuleSHA256(name:string,bytes:Uint8Array,expected:Record<string,string>):void {
 if(!(CONTENT_REPLACEMENT_MODULES as readonly string[]).includes(name)||!/^[a-f0-9]{64}$/u.test(expected[name]??'')||createHash('sha256').update(bytes).digest('hex')!==expected[name])throw Error('content_host:module_identity');
}
export function assertContentControlClosure(bytes:Uint8Array,expected:Record<string,string>):void {
 // A legacy six-pin adapter remains valid only when it has no new control import.
 // New helper imports config.ts (admin principal/project); pin that authority too.
 const source=Buffer.from(bytes).toString('utf8');
 if(source.includes('content-cadence-continuation')&&[...controlModules,...lifecycleModules,continuationModule].some(name=>!/^[a-f0-9]{64}$/u.test(expected[name]??'')))throw Error('content_host:continuation_module_identity');
 if(source.includes('content-cadence-lifecycle')&&[...controlModules,...lifecycleModules].some(name=>!/^[a-f0-9]{64}$/u.test(expected[name]??'')))throw Error('content_host:lifecycle_module_identity');
 if(source.includes('content-cadence-control-auth')&&controlModules.some(name=>!/^[a-f0-9]{64}$/u.test(expected[name]??'')))throw Error('content_host:control_module_identity');
}
export async function loadContentHostPorts(binding:ContentHostBinding):Promise<ContentHostPorts>{
 const b=validateContentHostBinding(binding);
 for(const path of ['/opt','/opt/kenan-acme','/opt/kenan-acme/content-cadence',b.acmeSourceRoot,join(b.acmeSourceRoot,'infrastructure'),join(b.acmeSourceRoot,'infrastructure/release')]){const s=await lstat(path);if(!s.isDirectory()||s.uid!==0||(s.mode&0o022)!==0||await realpath(path)!==path)throw Error('content_host:source_path');}
 const sources:Record<string,string>={};
 for(const name of Object.keys(b.moduleSHA256)){const path=join(b.acmeSourceRoot,'infrastructure/release',name),f=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{const s=await f.stat();if(!s.isFile()||s.uid!==0||(s.mode&0o022)!==0||(b.version>=3&&((s.mode&0o777)!==0o600||s.nlink!==1))||s.size>1024*1024||await realpath(path)!==path)throw Error('content_host:module_identity');const bytes=await f.readFile();assertContentModuleSHA256(name,bytes,b.moduleSHA256);sources[name]=bytes.toString('utf8');if(name==='content-cadence-dispatch-native.ts')assertContentControlClosure(bytes,b.moduleSHA256);}finally{await f.close();}
 }
 if(b.version>=3)assertContentImportClosure(sources,b.closureRoots!);
 // Node24 executes this qualified source adapter; dependencies resolve within the
 // frozen Acme checkout. No server/daemon, Bun.serve or model entrypoint starts.
 const native=await import(pathToFileURL(join(b.acmeSourceRoot,'infrastructure/release/content-cadence-dispatch-native.ts')).href);
 const recovery=await import(pathToFileURL(join(b.acmeSourceRoot,'infrastructure/release/content-cadence-recovery.ts')).href);
 const handler=await native.createNativeContentCadenceDispatcher(b.operatorConfig.dispatch,b.operatorConfig.receiptBucket);
 const ports=await native.createNativeContentRecovery(b.operatorConfig.receiptBucket);
 const auth=await import(pathToFileURL(join(b.acmeSourceRoot,'node_modules/google-auth-library/build/src/index.js')).href);
 const verifier=new auth.OAuth2Client();
 const verify=async(bearer:string)=>{const p=(await verifier.verifyIdToken({idToken:bearer,audience:b.publicAudience})).getPayload();return !!p?.email_verified&&p.email===b.operatorConfig.dispatch.schedulerEmail&&p.sub===b.operatorConfig.dispatch.schedulerSubject&&p.aud===b.publicAudience&&['https://accounts.google.com','accounts.google.com'].includes(p.iss);};
 return{handler:async(request:Request)=>{
  let raw:unknown;try{raw=await readRootReferenceJson('/etc/kenan/content-cadence-diagnostic.json');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')return new Response(null,{status:503});}
  if(request.headers.has('x-content-preflight'))return contentPreflight(request,verify,async()=>{
   const piSourceCommit=(await readFile('/srv/kenan/beta/source-commit','utf8')).trim();if(!/^[a-f0-9]{40}$/.test(piSourceCommit))throw Error('content_preflight:pi_identity');
   const fence=await readContentAdmissionFence();
   if(fence){const root=await readRootReferenceBytes(CONTENT_RUNTIME_BINDING),current=validateContentHostBinding(JSON.parse(root.toString()));if(piSourceCommit!==(await readFile('/srv/kenan/beta/source-commit','utf8')).trim()||JSON.stringify(current)!==JSON.stringify(b)||!sameContentAdmissionFence(fence,await readContentAdmissionFence()))throw Error('content_preflight:fence_changed');return{piSourceCommit,channel:'beta',processPID:process.pid,publicAudience:b.publicAudience,adapterSourceCommit:b.sourceCommit,rootRawSHA256:createHash('sha256').update(root).digest('hex'),moduleSHA256:b.moduleSHA256,closedFence:fence,proofScope:'authenticated-closed-admission-route-only-not-dispatch-admission'};}

   const diagnosticState=raw===undefined?'absent':classifyDiagnosticIntent(raw,Date.now()).state;
   if(diagnosticState==='active')throw Error('content_preflight:diagnostic_active');
   const storageModule=await import(pathToFileURL(join(b.acmeSourceRoot,'node_modules/@google-cloud/storage/build/cjs/src/index.js')).href);
   const storage=new storageModule.Storage(),file=storage.bucket(b.operatorConfig.receiptBucket).file('content-cadence/pilot-cost.json');
   const [metadata]=await file.getMetadata(),[bytes]=await storage.bucket(b.operatorConfig.receiptBucket).file('content-cadence/pilot-cost.json',{generation:metadata.generation}).download();if(bytes.length>65536)throw Error('content_preflight:cost_oversize');
   const cost=JSON.parse(bytes.toString()),binding=cost.optionBBinding,target=b.operatorConfig.dispatch;
   if(cost.sourceCommit!==target.sourceCommit||cost.image!==target.image||!binding||binding.sourceCommit!==target.sourceCommit||binding.image!==target.image)throw Error('content_preflight:product_target_conflict');
   const control=await import(pathToFileURL(join(b.acmeSourceRoot,'infrastructure/release/content-cadence-control-auth.ts')).href),client=await control.contentControlClient();
   const get=async(url:string)=>(await client.request({url,method:'GET',timeout:20000,retry:false})).data;
   const job=await get('https://run.googleapis.com/v2/projects/acme-project/locations/us-central1/jobs/production-insight-content-canonical-follow'),scheduler=await get('https://cloudscheduler.googleapis.com/v1/projects/acme-project/locations/us-central1/jobs/production-insight-content-canonical-follow');
   const pilot=await import(pathToFileURL(join(b.acmeSourceRoot,'infrastructure/release/content-cadence-pilot.ts')).href);
   pilot.assertPilotCost(cost,Date.now());
   const proofPath=String(cost.optionBBindingProof).replace(/^gcs:/u,'');
   if(!/^content-cadence\/option-b-bindings\/[a-f0-9]{64}\.json$/u.test(proofPath))throw Error('content_preflight:binding_proof_identity');
   const [proofBytes]=await storage.bucket(b.operatorConfig.receiptBucket).file(proofPath).download();
   if(proofBytes.length>4194304||createHash('sha256').update(proofBytes).digest('hex')!==proofPath.split('/').at(-1)?.replace(/\.json$/u,'')||JSON.stringify(JSON.parse(proofBytes.toString()).binding)!==JSON.stringify(binding))throw Error('content_preflight:binding_proof_conflict');
   if(job.uid!==binding.newJobUID||String(job.generation)!==String(binding.newJobGeneration)||job.labels?.ACME_source_commit!==target.sourceCommit||job.template?.template?.containers?.[0]?.image!==target.image||pilot.pilotSchedulerHash(scheduler,target)!==binding.schedulerSHA256)throw Error('content_preflight:resource_conflict');
   const [fresh]=await file.getMetadata(),current=validateContentHostBinding(await readRootReferenceJson(CONTENT_RUNTIME_BINDING));if(String(metadata.generation)!==String(fresh.generation)||JSON.stringify(current)!==JSON.stringify(b))throw Error('content_preflight:generation_changed');
   return{piSourceCommit,channel:'beta',processPID:process.pid,publicAudience:b.publicAudience,adapterSourceCommit:b.sourceCommit,productSourceCommit:target.sourceCommit,image:target.image,jobUID:job.uid,jobGeneration:String(job.generation),schedulerSHA256:binding.schedulerSHA256,costGeneration:String(metadata.generation),proofScope:'authenticated-route-config-resource-only-not-dispatch-admission',rootCanonicalSHA256:createHash('sha256').update(JSON.stringify(b)).digest('hex'),moduleSHA256:b.moduleSHA256,diagnosticState,authorityScope:cost.authority};
  });
  return routeContentDiagnostic(request,raw,Date.now(),verify,async message=>{console.warn(message);},r=>fencedContentDispatch(r,()=>readContentAdmissionFence(),request=>handler(new Request(b.publicAudience,{method:'POST',headers:request.headers}))));
 },recover:()=>recovery.reconcileContentDispatch(ports,OWNER,Date.now())};
}
/** One validated ROOT binding on disk. `id` is the SHA-256 of the exact binding bytes. */
export interface ContentGeneration {id:string; binding:ContentHostBinding}
export interface ContentHostSource {
 probe():Promise<ContentGeneration>;
 load(generation:ContentGeneration):Promise<ContentHostPorts>;
}
export interface ContentGenerationReceipt {
 generation:string; sourceCommit:string; acmeSourceRoot:string; version:number;
 moduleSHA256:Record<string,string>; previousGeneration:string|null; adoptedAt:string;
}
/** Every operation re-reads the ROOT binding; its SHA-256 is the generation. All native
 * work (Scheduler dispatch and recovery sweeps) runs one at a time, so a generation
 * change waits for the operation in flight, which stays on the ports it started with;
 * the next operation runs only on the new generation once it has loaded from the exact
 * binding bytes that were hashed. A root path already imported under another generation
 * (a return to a retired generation, or a root rewritten in place) would reuse Node's
 * cached modules, so it is refused until a restart. Serial queue after Acme 7ed's
 * eff64580. */
export function createContentHostController(source:ContentHostSource,onAdopt:(receipt:ContentGenerationReceipt)=>void|Promise<void>=()=>{}){
 type Live={generation:ContentGeneration;ports:ContentHostPorts};
 let current:Live|undefined,flight:Promise<unknown>|undefined,tail:Promise<unknown>=Promise.resolve();
 const imported=new Map<string,string>(),retired=new Set<string>();
 const acquire=async():Promise<Live>=>{
  // An absent ROOT binding means the operator retired this capability. Keep the
  // ENOENT code (start() treats it as disabled) but give it a typed message, so a
  // running sweep can tell retirement apart from a failed recovery.
  const g=await source.probe().catch((error:unknown)=>{if((error as NodeJS.ErrnoException)?.code==='ENOENT')throw Object.assign(Error(`${CONTENT_BINDING_RETIRED}: ${(error as Error).message}`,{cause:error}),{code:'ENOENT'});throw error;});
  if(current?.generation.id===g.id)return current;
  const root=g.binding.acmeSourceRoot,seen=imported.get(root);
  if(retired.has(g.id))throw Error('content_host:generation_downgrade_requires_restart');
  if(seen!==undefined&&seen!==g.id)throw Error('content_host:generation_requires_restart');
  imported.set(root,g.id);
  const ports=await source.load(g),previous=current?.generation.id??null;
  if(previous!==null)retired.add(previous);
  current={generation:g,ports};
  await Promise.resolve(onAdopt({generation:g.id,sourceCommit:g.binding.sourceCommit,acmeSourceRoot:root,version:g.binding.version,moduleSHA256:{...g.binding.moduleSHA256},previousGeneration:previous,adoptedAt:new Date().toISOString()})).catch(()=>{});
  return current;
 };
 const serial=<T>(work:(live:Live)=>Promise<T>):Promise<T>=>{const run=tail.then(async()=>work(await acquire()));tail=run.catch(()=>{});return run;};
 return{
  async handle(request:Request):Promise<Response|null>{
   if(new URL(request.url).pathname!==CONTENT_PUBLIC_PATH)return null;
   if(new URL(request.url).search)return new Response(null,{status:400});
   if(request.method!=='POST')return new Response(null,{status:405});
   if(!/^Bearer \S{1,8192}$/u.test(request.headers.get('authorization')??''))return new Response(null,{status:401});
   try{return await serial(live=>live.ports.handler(request));}catch{return Response.json({error:'content_host_unavailable',replay:false},{status:503});}
  },
  initialize():Promise<ContentGeneration>{return serial(async live=>live.generation);},
  recover(){return flight??=serial(live=>live.ports.recover()).finally(()=>{flight=undefined;});},
  generation():string|null{return current?.generation.id??null;},
 };
}
export async function probeContentGeneration(path=CONTENT_RUNTIME_BINDING):Promise<ContentGeneration>{
 const bytes=await readRootReferenceBytes(path);
 return{id:createHash('sha256').update(bytes).digest('hex'),binding:validateContentHostBinding(JSON.parse(bytes.toString('utf8')))};
}
export const CONTENT_GENERATION_RECEIPT='content-cadence-generation.json';
/** Typed cause when the ROOT binding is absent: the capability was retired, not a failed recovery. */
export const CONTENT_BINDING_RETIRED='content_host:binding_retired';
export type ContentCadenceExtension = Extension & {publicRequest(request:Request):Promise<Response|null>;generation():string|null};
export function createContentCadenceExtension(source:ContentHostSource={probe:()=>probeContentGeneration(),load:g=>loadContentHostPorts(g.binding)}):ContentCadenceExtension{
 let deps:Deps|undefined,timer:ReturnType<typeof setInterval>|undefined;
 const controller=createContentHostController(source,async receipt=>{
  const d=deps;if(!d)return;
  const line=JSON.stringify({...receipt,pid:process.pid,channel:d.config.channel});
  if(d.config.dataDir){const path=join(d.config.dataDir,CONTENT_GENERATION_RECEIPT),tmp=path+'.'+process.pid+'.tmp';
   await writeFile(tmp,line+'\n',{mode:0o640});await rename(tmp,path);}
  console.info(JSON.stringify({event:'content_host:generation_adopted',...JSON.parse(line)}));
 });
 // A binding removed while Beta runs retires the recurring sweep: stop this timer and
 // say so once, instead of reporting a failed recovery every 30 s (2026-10-29 flood).
 // Every other failure keeps its typed error log. Restoring the binding needs a restart.
 const recover=async()=>{try{await controller.recover();}catch(error){if(String((error as Error)?.message??'').startsWith(CONTENT_BINDING_RETIRED+':')){if(timer){clearInterval(timer);timer=undefined;console.info(JSON.stringify({event:CONTENT_BINDING_RETIRED,binding:CONTENT_RUNTIME_BINDING,sweep:'stopped',pid:process.pid,channel:deps?.config.channel}));}return;}const m=String((error as Error)?.message??''),code=/^content_host:[a-z_]{1,64}$/u.test(m)?m:'content_host:original_recovery_unavailable';await deps?.store.logError('content-cadence',`${code}; original effects retained; next existing-runtime wake30s`).catch(()=>{});}};
 return{id:'content-cadence',name:'CONTENT machine dispatcher',generation:()=>controller.generation(),
  async publicRequest(request){
   if(new URL(request.url).pathname!==CONTENT_PUBLIC_PATH)return null;
   if(deps?.config.channel!=='beta')return new Response(null,{status:503});
   // Native handler compares public audience, not loopback Host or spoofed
   // forwarded URL. Exact route matching happens before this canonical rebuild.
   const result=await controller.handle(request);
   // A rejected natural Scheduler request must be diagnosable without retaining
   // Authorization, cookies, body or arbitrary user-controlled headers.
   if(result?.status===400)await deps.store.logError('content-cadence',JSON.stringify({error:'content_host:scheduler_metadata_rejected',queryPresent:!!new URL(request.url).search,scheduler:request.headers.get('x-cloudscheduler')?.slice(0,16)??null,jobName:request.headers.get('x-cloudscheduler-jobname')?.slice(0,256)??null,scheduleTime:request.headers.get('x-cloudscheduler-scheduletime')?.slice(0,64)??null})).catch(()=>{});
   return result;
  },
  async start(value){if(timer)clearInterval(timer);timer=undefined;deps=value;if(value.config.channel!=='beta')return;
   // Absent optional config disables this capability; no placeholder/resources.
   try{await controller.initialize();}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;}
   timer=setInterval(()=>void recover(),30000);timer.unref();await recover();
  },
  async stop(){if(timer)clearInterval(timer);timer=undefined;},
 };
}
export const contentCadenceExtension=createContentCadenceExtension();
