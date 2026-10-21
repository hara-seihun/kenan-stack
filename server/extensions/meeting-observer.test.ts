import {it,expect,vi,afterEach} from 'vitest';
import {mkdtemp,writeFile,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as settle} from 'node:timers/promises';
import {assertObserverSuccess,createObserverHealth,observerDiagnostic} from './meeting-observer.js';
import type {Deps} from '../types.js';
// Fake timer advancement does not drain real filesystem IO. Await the owning observable phase,
// without advancing the policy clock or rerunning the operation.
async function ioPhase(ready:()=>boolean|Promise<boolean>):Promise<void>{
 const deadline=performance.now()+5000;
 while(!await ready()){if(performance.now()>=deadline)throw new Error('Observer IO phase did not complete');await settle(5);}
}
const mocks=vi.hoisted(()=>({process:vi.fn(),query:vi.fn(async(_sql:string,..._args:unknown[])=>({rows:[],rowCount:1})),end:vi.fn(async()=>{})}));
vi.mock('../tools/owner.js',()=>({ownerProcess:mocks.process}));
vi.mock('pg',()=>({default:{Pool:class {query=mocks.query;end=mocks.end;}}}));
import {createMeetingExtension} from './meeting.js';
afterEach(()=>{vi.useRealTimers();vi.clearAllMocks();});
it('retains only finite detector kind/code and exit; arbitrary output cannot leak',()=>{
  const output=Buffer.from('private arbitrary body\n'+JSON.stringify({kind:'meeting-detection-error',code:'required-calendar-coverage-incomplete',body:'secret customer body',url:'https://private.example'}));
  expect(()=>assertObserverSuccess({exitCode:1,output})).toThrow('meeting-detection-error/required-calendar-coverage-incomplete');
  for(const code of ['secret customer body','api_key=secret','https://private.example','Bearer abc']) {
    try{assertObserverSuccess({exitCode:130,output:Buffer.from(JSON.stringify({kind:'meeting-detection-error',code}))});}catch(e){expect(String(e)).not.toContain(code);expect(String(e)).toContain('unclassified-detector-failure');}
  }
  expect(observerDiagnostic(Error('private content'))).not.toContain('private content');
  expect(()=>assertObserverSuccess({exitCode:1,output:Buffer.alloc(0)})).toThrow('unclassified-detector-failure');
});
it('backs off finitely to120s, retains real success and resets to normal30s',()=>{
 const health=createObserverHealth();health.success('p',0,'1970-01-01T00:00:00Z');
 for(const [n,delay] of [[1,30000],[2,60000],[3,120000],[4,120000]] as const){health.failure('p',n*100000,'failure');expect(Date.parse(health.status('p')!.nextPeriodicAttemptAt)).toBe(n*100000+delay);expect(health.status('p')!.lastSuccessAt).toBe('1970-01-01T00:00:00Z');expect(health.ready('p',n*100000+delay-1)).toBe(false);}
 health.success('p',500000,'actual');expect(health.status('p')!.lastError).toBeNull();expect(health.status('p')!.consecutiveFailures).toBe(0);expect(health.ready('p',530000)).toBe(true);expect(health.ready('p',529999)).toBe(true); // healthy interval ticks must not become60s due to child duration
});
it('periodic failure never becomes fresh empty policy or dispatches provider cleanup; shares writer and recovers',async()=>{
 vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-18T10:00:00Z'));
 const dir=await mkdtemp(join(tmpdir(),'observer-test-')),config=join(dir,'config.json'),snapshot=join(dir,'snapshot.json');
 const person={id:'p',manager:{name:'m'},extensions:['meeting'],extensionConfigPath:config};
 await writeFile(config,JSON.stringify({tools:{meeting:{periodicEnabled:true,recallEnabled:true,joiningEnabled:true,observer:{executable:'/fake-readonly',args:[],snapshotPath:snapshot}}}}));
 const terminal=async(args:string[],r:{exitCode:number;output:Buffer})=>{
   const path=args[args.indexOf('--observer-receipt')+1]!,operationId=args[args.indexOf('--observer-op')+1];
   await mkdir(join(dir,'observer-receipts'),{recursive:true});
   await writeFile(path,JSON.stringify(r.exitCode?{version:1,operationId,terminal:'failure',...JSON.parse(r.output.toString())}:{version:1,operationId,terminal:'success',observedAt:new Date().toISOString(),snapshotSha256:'a'.repeat(64)}));
 };
 const logError=vi.fn();const deps={config:{people:[person],databaseUrl:'unused'},now:()=>Date.now(),runtime:{managerFor:()=>null},store:{logError}} as unknown as Deps;
 const extension=createMeetingExtension();const routes=new Map<string,(c:never)=>unknown>();extension.routes!({get:(p:string,fn:(c:never)=>unknown)=>routes.set(p,fn),post:()=>{}} as never,deps);
 // Tool status uses same health as HTTP without needing an authenticated HTTP fixture.
 const status=async()=>(await extension.tool!({person,deps} as never).execute('status',{action:'status'},undefined,undefined,{} as never)).content.map(c=>c.type==='text'?c.text:'').join('');
 let finish!: (result:{exitCode:number;output:Buffer})=>Promise<void>;
 mocks.process.mockImplementationOnce((_placement:unknown,_person:unknown,_exe:unknown,args:string[])=>new Promise(resolve=>{finish=async result=>{await terminal(args,result);resolve(result);};}));
 try{await extension.start!(deps);await vi.advanceTimersByTimeAsync(30000);await ioPhase(()=>mocks.process.mock.calls.length===1);expect(mocks.process).toHaveBeenCalledTimes(1);
 await vi.advanceTimersByTimeAsync(30000);await settle(30);expect(mocks.process).toHaveBeenCalledTimes(1);await finish({exitCode:1,output:Buffer.from(JSON.stringify({kind:'meeting-detection-error',code:'required-calendar-coverage-incomplete'}))});await vi.advanceTimersByTimeAsync(0);await ioPhase(()=>logError.mock.calls.length===1);
 expect(mocks.query.mock.calls.some(call=>String(call[0]).includes('SELECT data FROM kenan_meeting_provider'))).toBe(false);
 expect(await status()).toContain('required-calendar-coverage-incomplete');expect(await status()).toContain('"lastObservation":null');

 mocks.process.mockImplementationOnce(async(_p:unknown,_u:unknown,_e:unknown,args:string[])=>{const r={exitCode:1,output:Buffer.from(JSON.stringify({kind:'meeting-detection-error',code:'required-calendar-coverage-incomplete'}))};await terminal(args,r);return r;});await vi.advanceTimersByTimeAsync(30000);await ioPhase(()=>mocks.process.mock.calls.length===2);await ioPhase(()=>logError.mock.calls.length===2);expect(mocks.process).toHaveBeenCalledTimes(2);
 await vi.advanceTimersByTimeAsync(30000);await settle(30);expect(mocks.process).toHaveBeenCalledTimes(2);
 const at=new Date(Date.now()+30000).toISOString();await writeFile(snapshot,JSON.stringify({at,coverage:{kind:'complete',unknownCalendars:[]},snapshot:{meetings:[],withdrawnEventKeys:[]}}));
 mocks.process.mockImplementation(async(_p:unknown,_u:unknown,_e:unknown,args:string[])=>{const r={exitCode:0,output:Buffer.alloc(0)};await terminal(args,r);return r;});await vi.advanceTimersByTimeAsync(30000);await ioPhase(()=>mocks.process.mock.calls.length===3);await ioPhase(async()=>(await status()).includes('"consecutiveFailures":0'));expect(mocks.process).toHaveBeenCalledTimes(3);expect(await status()).toContain('"consecutiveFailures":0');expect(await status()).toContain(at);expect(logError).toHaveBeenCalledTimes(2);
 }finally{await extension.stop!();await rm(dir,{recursive:true,force:true});}
});
it('never infers timeout from synthetic130 and retains typed signal termination',()=>{
 expect(()=>assertObserverSuccess({exitCode:130,output:Buffer.alloc(0),signal:'SIGTERM',termination:'signal'})).toThrow('termination signal; signal SIGTERM');
 expect(()=>assertObserverSuccess({exitCode:130,output:Buffer.alloc(0),termination:'timeout'})).toThrow('termination timeout');
 expect(()=>assertObserverSuccess({exitCode:130,output:Buffer.alloc(0)})).toThrow('termination unknown');
});

it('retains finite owning detector read failures but never arbitrary code suffixes',()=>{
 for(const code of ['calendar-http-503','directory-network','iam-http-429','token-timeout','detector-unavailable'])expect(()=>assertObserverSuccess({exitCode:1,output:Buffer.from(JSON.stringify({kind:'meeting-detection-error',code}))})).toThrow(code);
 expect(()=>assertObserverSuccess({exitCode:1,output:Buffer.from(JSON.stringify({kind:'meeting-detection-error',code:'calendar-http-503 SECRET'}))})).toThrow('unclassified-detector-failure');
});

it('restored dependency cooldown and original pending identity prohibit explicit and periodic rereads',()=>{
 const h=createObserverHealth(),now=Date.parse('2026-10-18T12:00:00Z');
 let failure:unknown;
 try{assertObserverSuccess({exitCode:1,output:Buffer.from(JSON.stringify({kind:'meeting-detection-error',code:'calendar-http-429',retryNotBefore:now+120000}))},now);}catch(e){failure=e;}
 h.failure('p',now,failure);
 const restored=createObserverHealth();restored.restore('p',JSON.parse(JSON.stringify(h.status('p'))));
 expect(restored.ready('p',now+119999)).toBe(false);
 expect(()=>restored.assertReady('p',now+119999)).toThrow('cooldown');
 restored.success('p',now+1000,'late');expect(restored.ready('p',now+119999)).toBe(false);
 expect(restored.ready('p',now+120000)).toBe(true);
 restored.restore('p',{...restored.status('p')!,retryBlocked:true});
 expect(restored.ready('p',now+7*86400000)).toBe(false);
 expect(()=>restored.assertReady('p',now+7*86400000)).toThrow('cooldown');
});
