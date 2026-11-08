import {createHash} from 'node:crypto';
/** Finite, explicit natural-request diagnosis. No dispatch/admission port exists. */
export type DiagnosticIntent={version:1;intentId:string;budgetId:string;windowStart:string;windowExpires:string;schedulerJob:string};
export function classifyDiagnosticIntent(x:unknown,now:number):{state:'active'|'expired';intent:DiagnosticIntent}{
 const v=x as DiagnosticIntent;
 if(!v||typeof v!=='object'||Array.isArray(v)||v.version!==1||typeof v.budgetId!=='string'||!/^content-pilot:[a-f0-9]{64}$/.test(v.budgetId)||typeof v.intentId!=='string'||!v.intentId||v.intentId.length>256||v.schedulerJob!=='projects/acme-project/locations/us-central1/jobs/production-insight-content-canonical-follow'||typeof v.windowStart!=='string'||typeof v.windowExpires!=='string'||!Number.isFinite(Date.parse(v.windowStart))||!Number.isFinite(Date.parse(v.windowExpires))||!Number.isFinite(now)||Date.parse(v.windowStart)>now||Date.parse(v.windowExpires)<=Date.parse(v.windowStart)||Date.parse(v.windowExpires)-Date.parse(v.windowStart)>1800000)throw Error('content_diagnostic:intent_invalid');
 return{state:Date.parse(v.windowExpires)<=now?'expired':'active',intent:v};
}
export function validateDiagnosticIntent(x:unknown,now:number):DiagnosticIntent{const value=classifyDiagnosticIntent(x,now);if(value.state!=='active')throw Error('content_diagnostic:intent_expired');return value.intent;}
/** Optional diagnostics expire; invalid/future scope is never treated as expiry.
 * The native branch still owns its full OIDC, cost and generation checks. */
export async function routeContentDiagnostic(request:Request,raw:unknown,now:number,verify:(bearer:string)=>Promise<boolean>,record:(message:string)=>Promise<void>,native:(request:Request)=>Promise<Response>):Promise<Response>{
 if(raw===undefined)return native(request);
 let value:ReturnType<typeof classifyDiagnosticIntent>;try{value=classifyDiagnosticIntent(raw,now);}catch{return Response.json({error:'content_diagnostic:intent_invalid',dispatch:false},{status:503});}
 if(value.state==='expired'){await record(JSON.stringify({event:'content_diagnostic:expired_ignored',intentId:value.intent.intentId,windowExpires:value.intent.windowExpires,dispatch:false}));return native(request);}
 return diagnoseScheduler(request,value.intent,verify,record);
}
/** Structurally separate authenticated, read-only path: cannot call dispatch. */
export async function contentPreflight(request:Request,verify:(bearer:string)=>Promise<boolean>,inspect:()=>Promise<Record<string,unknown>>):Promise<Response>{
 if(request.headers.get('x-content-preflight')!=='version1')return Response.json({error:'content_preflight:version',dispatch:false},{status:400});
 const bearer=request.headers.get('authorization')?.match(/^Bearer (\S+)$/u)?.[1];if(!bearer)return new Response(null,{status:401});
 try{if(!await verify(bearer))return new Response(null,{status:403});}catch{return new Response(null,{status:401});}
 try{return Response.json({...await inspect(),authenticated:true,dispatch:false,preflightContract:1,observedAt:new Date().toISOString()});}catch{return Response.json({error:'content_preflight:readback_failed',authenticated:true,dispatch:false},{status:503});}
}
export async function diagnoseScheduler(request:Request,intent:DiagnosticIntent,verify:(bearer:string)=>Promise<boolean>,record:(message:string)=>Promise<void>):Promise<Response>{
 const bearer=request.headers.get('authorization')?.match(/^Bearer (\S+)$/)?.[1];if(!bearer)return new Response(null,{status:401});
 try{if(!await verify(bearer))return new Response(null,{status:403});}catch{return new Response(null,{status:401});}
 const flag=request.headers.get('x-cloudscheduler'),job=request.headers.get('x-cloudscheduler-jobname'),time=request.headers.get('x-cloudscheduler-scheduletime');
 const result={error:'content_diagnostic:no_dispatch',intentId:intent.intentId,budgetId:intent.budgetId,authenticated:true,schedulerFlagPresent:flag!==null,schedulerFlagExact:flag==='true',schedulerFlagCaseInsensitive:flag?.toLowerCase()==='true',schedulerJobPresent:job!==null,schedulerJobExact:job===intent.schedulerJob,scheduleTimePresent:time!==null,scheduleTimeRFC3339:!!time&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(time)&&Number.isFinite(Date.parse(time)),scheduleTimeParseable:!!time&&Number.isFinite(Date.parse(time)),schedulerJobResource:/^projects\/[a-z0-9-]+\/locations\/[a-z0-9-]+\/jobs\/[a-z0-9-]+$/.test(job??'')&&(job?.length??257)<=256?job:null,schedulerJobLength:job?.length??null,schedulerJobSHA256:job===null?null:createHash('sha256').update(job).digest('hex'),schedulerJobKnownNumberExact:job===intent.schedulerJob.replace('/acme-project/','/453178082974/'),schedulerJobBasenameExact:job===intent.schedulerJob.split('/').at(-1),schedulerJobComponents:job?.split('/').length??0,scheduleTimeClass:time===null?'missing':/^\d+$/.test(time)?'digits':/^\d{4}-/.test(time)?'date-like':'other',dispatch:false};
 await record(JSON.stringify(result));return Response.json(result,{status:409});
}
