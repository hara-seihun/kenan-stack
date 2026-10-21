import {test,expect,vi} from 'vitest';
import {CONTENT_PUBLIC_PATH,validateContentHostBinding,createContentHostController,createContentCadenceExtension,type ContentHostBinding} from './content-cadence.js';
import type {Deps} from '../types.js';
function fixture():ContentHostBinding{return{version:1,enabled:true,channel:'beta',owner:'00000000-0000-4000-8000-000000000001',publicAudience:'https://kenan.acme.example/pi-stack/api/operations/content-cadence',acmeSourceRoot:'/opt/kenan-acme/content-cadence/'+'a'.repeat(40),sourceCommit:'a'.repeat(40),moduleSHA256:Object.fromEntries(['content-cadence-dispatch-native.ts','content-cadence-dispatch.ts','content-cadence-recovery.ts','content-cadence-operation-readback.ts','content-cadence-job-contract.ts'].map(p=>[p,'c'.repeat(64)])),operatorConfig:{dispatch:{sourceCommit:'a'.repeat(40),image:'us-central1-docker.pkg.dev/acme-project/acme-insight/insight@sha256:'+'b'.repeat(64),audience:'https://kenan.acme.example/pi-stack/api/operations/content-cadence',schedulerEmail:'acme-content-scheduler@acme-project.iam.gserviceaccount.com',schedulerSubject:'123456789012345678901',recoveryOwner:'00000000-0000-4000-8000-000000000001'},receiptBucket:'acme-project-production-insight-artifacts'}};}
test('complete exact binding accepted, not evidence of deployment',()=>{expect(validateContentHostBinding(fixture())).toEqual(fixture());});
for(const field of ['sourceCommit','publicAudience','channel','owner','acmeSourceRoot','moduleSHA256'] as const)test(`refuse foreign/incomplete ${field}`,()=>{const b=fixture();(b as unknown as Record<string,unknown>)[field]=null;expect(()=>validateContentHostBinding(b)).toThrow('binding_invalid');});
test('no other user endpoint gains public path/authentication exception',async()=>{const load=vi.fn();const c=createContentHostController(load);expect(await c.handle(new Request('http://loopback/api/accounts'))).toBeNull();expect(load).not.toHaveBeenCalled();expect((await c.handle(new Request('http://loopback'+CONTENT_PUBLIC_PATH)))!.status).toBe(405);expect((await c.handle(new Request('http://loopback'+CONTENT_PUBLIC_PATH,{method:'POST'})))!.status).toBe(401);expect(load).not.toHaveBeenCalled();});
test('OIDC/native handler—not cookie, callerJSON or timing—owns authentication and idempotency',async()=>{const handler=vi.fn(async()=>new Response(null,{status:403}));const c=createContentHostController(async()=>({handler,recover:async()=>[]}));expect((await c.handle(new Request('http://loopback'+CONTENT_PUBLIC_PATH,{method:'POST',headers:{authorization:'Bearer signed-fixture'}})))!.status).toBe(403);expect(handler).toHaveBeenCalledOnce();});
test('uncertain adapter failure does not claim acceptance or retry RunJob',async()=>{const c=createContentHostController(async()=>{throw Error('secret details');});const r=await c.handle(new Request('http://loopback'+CONTENT_PUBLIC_PATH,{method:'POST',headers:{authorization:'Bearer fixture'}}));expect(r!.status).toBe(503);expect(await r!.text()).not.toContain('secret details');});
test('existing boot/timer recovery serializes same writer and resumes after failure',async()=>{let done!:(v:unknown)=>void;const recovery=vi.fn(()=>new Promise<unknown>(resolve=>done=resolve));const c=createContentHostController(async()=>({handler:async()=>new Response(),recover:recovery}));const a=c.recover(),b=c.recover();await Promise.resolve();await Promise.resolve();expect(a).toBe(b);done([]);await a;expect(recovery).toHaveBeenCalledOnce();const next=c.recover();await Promise.resolve();await Promise.resolve();done([]);await next;expect(recovery).toHaveBeenCalledTimes(2);});
test('beta only lifecycle boot immediate +30s wake without new daemon; production never starts',async()=>{vi.useFakeTimers();const recover=vi.fn(async()=>[]);const loader=vi.fn(async()=>({binding:fixture(),ports:{handler:async()=>new Response(),recover}}));const ext=createContentCadenceExtension(loader);const deps={config:{channel:'production'},store:{logError:vi.fn()}} as unknown as Deps;await ext.start!(deps);expect(loader).not.toHaveBeenCalled();expect((await ext.publicRequest(new Request('http://loopback'+CONTENT_PUBLIC_PATH,{method:'POST'})))!.status).toBe(503);await ext.start!({...deps,config:{channel:'beta'}} as Deps);expect(recover).toHaveBeenCalledOnce();await vi.advanceTimersByTimeAsync(30000);expect(recover).toHaveBeenCalledTimes(2);await ext.stop!();await vi.advanceTimersByTimeAsync(30000);expect(recover).toHaveBeenCalledTimes(2);vi.useRealTimers();});

test('failed lazy initialization is retryable without replaying a failed dispatch', async () => {
 const handler=vi.fn(async()=>new Response(null,{status:202}));
 const load=vi.fn().mockRejectedValueOnce(Error('missing binding')).mockResolvedValue({handler,recover:async()=>[]});
 const c=createContentHostController(load);
 const request=()=>new Request('http://loopback'+CONTENT_PUBLIC_PATH,{method:'POST',headers:{authorization:'Bearer fixture'}});
 expect((await c.handle(request()))!.status).toBe(503);
 expect(handler).not.toHaveBeenCalled();
 expect((await c.handle(request()))!.status).toBe(202);
 expect(load).toHaveBeenCalledTimes(2);expect(handler).toHaveBeenCalledOnce();
});
test('lifecycle loads once and repeated start never duplicates recovery timers',async()=>{
 vi.useFakeTimers();
 const recover=vi.fn(async()=>[]);
 const loader=vi.fn(async()=>({binding:fixture(),ports:{handler:async()=>new Response(),recover}}));
 const ext=createContentCadenceExtension(loader);
 const deps={config:{channel:'beta'},store:{logError:vi.fn()}} as unknown as Deps;
 try{
  await ext.start!(deps);await ext.start!(deps);
  expect(loader).toHaveBeenCalledOnce();expect(recover).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(30000);expect(recover).toHaveBeenCalledTimes(3);
  await ext.start!({...deps,config:{channel:'production'}} as Deps);
  await vi.advanceTimersByTimeAsync(30000);expect(recover).toHaveBeenCalledTimes(3);
 }finally{await ext.stop!();vi.useRealTimers();}
});
