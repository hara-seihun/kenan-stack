/** One CONTENT machine-to-machine endpoint inside the EXISTING Kenan runtime.
 * The integration owner mounts this exact route before human session middleware;
 * no other extension/user route gains an authentication exception.
 */
import {constants} from 'node:fs';
import {open,realpath,lstat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import type {Extension,Deps} from '../types.js';
export const CONTENT_PUBLIC_PATH='/api/operations/content-cadence';
export const CONTENT_RUNTIME_BINDING='/etc/kenan/content-cadence-host.json';
const OWNER='00000000-0000-4000-8000-000000000001';
const modules=['content-cadence-dispatch-native.ts','content-cadence-dispatch.ts','content-cadence-recovery.ts','content-cadence-operation-readback.ts','content-cadence-job-contract.ts'] as const;
export interface ContentHostBinding {
 version:1; enabled:true; channel:'beta'; owner:typeof OWNER;
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
 if(b?.version!==1||b.enabled!==true||b.channel!=='beta'||b.owner!==OWNER||!d||d.recoveryOwner!==OWNER
  ||!/^https:\/\/kenan\.acme\.example\/pi-stack\/api\/operations\/content-cadence$/u.test(b.publicAudience)
  ||d.audience!==b.publicAudience||!/^[a-f0-9]{40}$/u.test(b.sourceCommit)||b.sourceCommit!==d.sourceCommit
  ||b.acmeSourceRoot!=='/opt/kenan-acme/content-cadence/'+b.sourceCommit
  ||!/^us-central1-docker\.pkg\.dev\/acme-project\/acme-insight\/insight@sha256:[a-f0-9]{64}$/u.test(d.image)
  ||!/^acme-content-scheduler@acme-project\.iam\.gserviceaccount\.com$/u.test(d.schedulerEmail)
  ||!/^\d{10,30}$/u.test(d.schedulerSubject)||b.operatorConfig.receiptBucket!=='acme-project-production-insight-artifacts'
  ||!b.moduleSHA256||Object.keys(b.moduleSHA256).length!==modules.length
  ||modules.some(name=>!/^[a-f0-9]{64}$/u.test(b.moduleSHA256[name]??'')))throw Error('content_host:binding_invalid');
 return b;
}
export async function readRootReferenceJson(path:string):Promise<unknown>{
 const f=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{const s=await f.stat();if(!s.isFile()||s.uid!==0||(s.mode&0o022)!==0||s.size>65536||await realpath(path)!==path)throw Error('content_host:root_reference_custody');return JSON.parse(await f.readFile('utf8'));}finally{await f.close();}
}
export async function loadContentHostPorts(binding:ContentHostBinding):Promise<ContentHostPorts>{
 const b=validateContentHostBinding(binding);
 for(const path of ['/opt','/opt/kenan-acme','/opt/kenan-acme/content-cadence',b.acmeSourceRoot,join(b.acmeSourceRoot,'infrastructure'),join(b.acmeSourceRoot,'infrastructure/release')]){const s=await lstat(path);if(!s.isDirectory()||s.uid!==0||(s.mode&0o022)!==0||await realpath(path)!==path)throw Error('content_host:source_path');}
 for(const name of modules){const path=join(b.acmeSourceRoot,'infrastructure/release',name),f=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{const s=await f.stat();if(!s.isFile()||s.uid!==0||(s.mode&0o022)!==0||s.size>1024*1024||await realpath(path)!==path||createHash('sha256').update(await f.readFile()).digest('hex')!==b.moduleSHA256[name])throw Error('content_host:module_identity');}finally{await f.close();}
 }
 // Node24 executes this qualified source adapter; dependencies resolve within the
 // frozen Acme checkout. No server/daemon, Bun.serve or model entrypoint starts.
 const native=await import(pathToFileURL(join(b.acmeSourceRoot,'infrastructure/release/content-cadence-dispatch-native.ts')).href);
 const recovery=await import(pathToFileURL(join(b.acmeSourceRoot,'infrastructure/release/content-cadence-recovery.ts')).href);
 const handler=await native.createNativeContentCadenceDispatcher(b.operatorConfig.dispatch,b.operatorConfig.receiptBucket);
 const ports=await native.createNativeContentRecovery(b.operatorConfig.receiptBucket);
 return{handler:(request:Request)=>handler(new Request(b.publicAudience,{method:'POST',headers:request.headers})),recover:()=>recovery.reconcileContentDispatch(ports,OWNER,Date.now())};
}
export function createContentHostController(load:()=>Promise<ContentHostPorts>){
 let ports:Promise<ContentHostPorts>|undefined,flight:Promise<unknown>|undefined;
 const acquire=()=>ports??=load().catch(e=>{ports=undefined;throw e;});
 return{
  async handle(request:Request):Promise<Response|null>{
   if(new URL(request.url).pathname!==CONTENT_PUBLIC_PATH)return null;
   if(new URL(request.url).search)return new Response(null,{status:400});
   if(request.method!=='POST')return new Response(null,{status:405});
   if(!/^Bearer \S{1,8192}$/u.test(request.headers.get('authorization')??''))return new Response(null,{status:401});
   try{return await(await acquire()).handler(request);}catch{return Response.json({error:'content_host_unavailable',replay:false},{status:503});}
  },
  initialize: acquire,
  recover(){return flight??=acquire().then(p=>p.recover()).finally(()=>{flight=undefined;});},
 };
}
export type ContentCadenceExtension = Extension & {publicRequest(request:Request):Promise<Response|null>};
export function createContentCadenceExtension(loader=async()=>{
 const binding=validateContentHostBinding(await readRootReferenceJson(CONTENT_RUNTIME_BINDING));
 return{binding,ports:await loadContentHostPorts(binding)};
}):ContentCadenceExtension{
 let deps:Deps|undefined,timer:ReturnType<typeof setInterval>|undefined;
 const controller=createContentHostController(async()=>{const loaded=await loader();return loaded.ports;});
 const recover=async()=>{try{await controller.recover();}catch{await deps?.store.logError('content-cadence','content_host:original_recovery_unavailable; original effects retained; next existing-runtime wake30s').catch(()=>{});}};
 return{id:'content-cadence',name:'CONTENT machine dispatcher',
  async publicRequest(request){
   if(new URL(request.url).pathname!==CONTENT_PUBLIC_PATH)return null;
   if(deps?.config.channel!=='beta')return new Response(null,{status:503});
   // Native handler compares public audience, not loopback Host or spoofed
   // forwarded URL. Exact route matching happens before this canonical rebuild.
   const result=await controller.handle(request);
   return result;
  },
  async start(value){if(timer)clearInterval(timer);timer=undefined;deps=value;if(value.config.channel!=='beta')return;
   // Absent optional config disables this capability; no placeholder/resources.
   try{await controller.initialize();}catch{return;}
   timer=setInterval(()=>void recover(),30000);timer.unref();await recover();
  },
  async stop(){if(timer)clearInterval(timer);timer=undefined;},
 };
}
export const contentCadenceExtension=createContentCadenceExtension();
