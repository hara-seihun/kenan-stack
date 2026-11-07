import{constants}from'node:fs';
import{open,lstat}from'node:fs/promises';
import{createHash}from'node:crypto';
export const CONTENT_ADMISSION_FENCE='/etc/kenan/content-cadence-admission-fence.json';
export type ContentAdmissionFence={version:1;state:'closed';owner:'00000000-0000-4000-8000-000000000002';budgetId:string;epoch:'2026-10-21T23:58:57.945Z';schedulerJob:string;intentId:string;nonce:string;closedAt:string;reason:string};
export function validateContentAdmissionFence(raw:unknown,now:number):ContentAdmissionFence{
 const f=raw as ContentAdmissionFence;
 if(!f||typeof f!=='object'||Array.isArray(f)||f.version!==1||f.state!=='closed'||f.owner!=='00000000-0000-4000-8000-000000000002'||f.budgetId!=='content-pilot:7851b228ba099cbb852008e4fa0ca601df32c168f08933cc7e79db8573e46c4b'||f.epoch!=='2026-10-21T23:58:57.945Z'||f.schedulerJob!=='projects/acme-project/locations/us-central1/jobs/production-insight-content-canonical-follow'||typeof f.intentId!=='string'||!f.intentId||f.intentId.length>256||!/^[a-f0-9]{64}$/u.test(f.nonce)||typeof f.reason!=='string'||!f.reason||f.reason.length>512||typeof f.closedAt!=='string'||!Number.isFinite(Date.parse(f.closedAt))||Date.parse(f.closedAt)>now||!Number.isFinite(now))throw Error('content_admission_fence:invalid');return f;
}
export type AdmissionFenceObservation={fence:ContentAdmissionFence;rawSHA256:string;canonicalSHA256:string;identity:string};
/** This is an admission fence, never an optional diagnostic or time waiver. */
export async function readContentAdmissionFence(path=CONTENT_ADMISSION_FENCE):Promise<AdmissionFenceObservation|undefined>{
 let file;try{file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw error;}
 try{const before=await file.stat();if(!before.isFile()||before.uid!==0||(before.mode&0o777)!==0o600||before.nlink!==1||before.size>16384)throw Error('content_admission_fence:custody');const bytes=await file.readFile();if(bytes.length>16384)throw Error('content_admission_fence:oversize');const fence=validateContentAdmissionFence(JSON.parse(bytes.toString()),Date.now()),after=await file.stat(),named=await lstat(path);if(before.ino!==after.ino||before.mtimeMs!==after.mtimeMs||before.size!==after.size||named.ino!==before.ino||named.dev!==before.dev)throw Error('content_admission_fence:changed');return{fence,rawSHA256:createHash('sha256').update(bytes).digest('hex'),canonicalSHA256:createHash('sha256').update(JSON.stringify(fence)).digest('hex'),identity:`${before.dev}:${before.ino}:${before.mtimeMs}`};}finally{await file.close();}
}
export function sameContentAdmissionFence(a:AdmissionFenceObservation|undefined,b:AdmissionFenceObservation|undefined){return JSON.stringify(a)===JSON.stringify(b);}
export async function fencedContentDispatch(request:Request,read:()=>Promise<AdmissionFenceObservation|undefined>,native:(request:Request)=>Promise<Response>){try{if(await read())return Response.json({error:'content_admission_fence:closed',dispatch:false},{status:503});}catch{return Response.json({error:'content_admission_fence:unknown',dispatch:false},{status:503});}return native(request);}
