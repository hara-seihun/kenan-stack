import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createMeetingExtension } from './meeting.js';
import { freshSchema, testDatabaseUrl } from '../db/test-db.js';
import type { Deps, ToolContext } from '../types.js';
it.skipIf(!testDatabaseUrl)('persists current discovery across restart and routes withdrawal to the current manager, without joining', async () => {
  const directory = await mkdtemp(join(tmpdir(),'meet-runtime-'));
  const now = Date.now();
  const snapshot = join(directory,'snapshot.json'), config = join(directory,'config.json');
  const person={id:'acme',uid:process.getuid!(),gid:process.getgid!(),home:directory,unixUser:'kenan',extensionConfigPath:config,extensions:['meeting'],manager:null};
  await writeFile(config,JSON.stringify({tools:{meeting:{joiningEnabled:false,browser:{executable:'/nonexistent-must-not-dispatch',args:[],uid:process.getuid!(),gid:process.getgid!(),home:directory},observer:{executable:'/bin/true',args:[],snapshotPath:snapshot}}}}));
  const proof={at:new Date(now).toISOString(),coverage:{kind:'complete',unknownCalendars:[]},snapshot:{withdrawnEventKeys:[] as string[],meetings:[{eventKey:'e',eventId:'e',title:'Internal',meetingUrl:'https://meet.google.com/abc-defg-hij',organizerEmail:'host@acme.example',startAt:new Date(now-1000).toISOString(),endAt:new Date(now+60000).toISOString(),fingerprint:'one',attendance:{included:true}}]}};
  await writeFile(snapshot,JSON.stringify(proof));
  const notices:{agentId:string;text:string}[]=[];
  let manager='current-manager';
  const deps={config:{databaseUrl:await freshSchema('t_meeting_runtime'),people:[]},placement:{kind:'callerCgroup'},now:()=>now,runtime:{managerFor:()=>manager,deliver:(input:{agentId:string;text:string})=>notices.push(input)},store:{getAgent:async()=>({conversationId:'current-conversation'})}} as unknown as Deps;
  let extension=createMeetingExtension();
  try {
    await extension.start!(deps);
    const context={person,agent:{conversationId:'worker-conversation'},deps} as unknown as ToolContext;
    const execute=async(action:string)=>extension.tool!(context).execute('test',{action},undefined,undefined,{} as never);
    await execute('recheck');await execute('recheck');
    await expect(extension.tool!(context).execute('test',{action:'join',sessionId:'existing'},undefined,undefined,{} as never)).rejects.toThrow('joins are disabled');
    const status=await execute('status');expect(JSON.stringify(status)).toContain('current-manager');expect(JSON.stringify(status)).toContain('not-inferred');
    expect(notices).toHaveLength(1);expect(notices[0]!.agentId).toBe('current-manager');
    await extension.stop!();extension=createMeetingExtension();await extension.start!(deps);
    await execute('recheck');expect(notices).toHaveLength(1);
    manager='replacement-manager';proof.snapshot.withdrawnEventKeys=['e'];await writeFile(snapshot,JSON.stringify(proof));
    await execute('recheck');expect(notices).toHaveLength(2);expect(notices[1]!.agentId).toBe('replacement-manager');expect(notices[1]!.text).toContain('withdrawn');
    const list=await execute('list');expect(JSON.stringify(list)).toContain('withdrawn');
  } finally {await extension.stop!();await rm(directory,{recursive:true,force:true});}
});
it.skipIf(!testDatabaseUrl)('real caption route binds owner/session, persists finals once, and rejects unknown lifecycle', async()=>{
  const {Hono}=await import('hono'); const {default:pg}=await import('pg'); const {createHash}=await import('node:crypto');
  const directory=await mkdtemp(join(tmpdir(),'meet-caption-route-')), now=Date.now();
  const snapshot=join(directory,'snapshot.json'),config=join(directory,'config.json');
  const databaseUrl=await freshSchema('t_meeting_caption_route'); const pool=new pg.Pool({connectionString:databaseUrl});
  const id=createHash('sha256').update('acme\0e').digest('hex');
  const proof={at:new Date(now).toISOString(),coverage:{kind:'complete',unknownCalendars:[]},snapshot:{withdrawnEventKeys:[],meetings:[{eventKey:'e',eventId:'e',title:'Internal',meetingUrl:'https://meet.google.com/abc-defg-hij',organizerEmail:'host@acme.example',startAt:new Date(now-1000).toISOString(),endAt:new Date(now+60000).toISOString(),fingerprint:'one',attendance:{included:true}}]}};
  await writeFile(config,JSON.stringify({tools:{meeting:{observer:{executable:'/bin/true',args:[],snapshotPath:snapshot}}}}));await writeFile(snapshot,JSON.stringify(proof));
  const person={id:'acme',uid:process.getuid!(),gid:process.getgid!(),home:directory,unixUser:'kenan',extensionConfigPath:config,extensions:['meeting'],manager:null};
  const messages=new Map<string,unknown>(),wakes:unknown[]=[],broadcasts:unknown[]=[];
  let loseAcknowledgement=false;
  const deps={config:{databaseUrl,people:[]},placement:{kind:'callerCgroup'},now:()=>now,person:(owner:string)=>owner==='acme'?person:undefined,runtime:{managerFor:()=>null,deliver:(input:unknown)=>wakes.push(input)},bus:{toConversation:(_id:string,event:unknown)=>broadcasts.push(event)},store:{getMessageByClientId:async(key:string)=>messages.get(key)??null,appendMessage:async(m:{clientId:string})=>{if(messages.has(m.clientId))throw Error('unique');messages.set(m.clientId,m);if(loseAcknowledgement)throw Error('lost acknowledgement');return m;},getConversation:async()=>({agentId:'current-agent'})}} as unknown as Deps;
  const extension=createMeetingExtension(); let owner='acme'; const app=new Hono();app.use('*',async(c,next)=>{c.set('me' as never,owner as never);await next();});
  try{
    await extension.start!(deps);extension.routes!(app,deps);
    expect((await app.request('/status')).status).toBe(200);
    expect((await app.request('/recheck',{method:'POST'})).status).toBe(200);
    const session={sessionId:id,ownerId:'acme',conversationId:'right-conversation',providerSessionId:'p',phase:'active',endsAt:now+60000,lastObservedAt:now};
    await pool.query('INSERT INTO kenan_meeting_provider VALUES($1,$2,$3)',[id,'acme',session]);
    const send=(patch={})=>app.request(`/${id}/captions`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({eventId:'one',text:'Alice: test final',isFinal:true,at:now,...patch})});
    expect((await send()).status).toBe(200);expect(messages.size).toBe(1);expect(wakes).toHaveLength(1);expect(broadcasts).toHaveLength(1);
    expect((await send()).status).toBe(200);expect(wakes).toHaveLength(1);
    expect(JSON.stringify([...messages.values()])).toContain('right-conversation');
    expect((await send({text:'Conflicting final'})).status).not.toBe(200);expect(messages.size).toBe(1);
    loseAcknowledgement=true;expect((await send({eventId:'lost-ack'})).status).toBe(200);expect(messages.size).toBe(2);expect(wakes).toHaveLength(1);loseAcknowledgement=false;
    owner='foreign';expect((await send()).status).not.toBe(200);owner='acme';
    for (const invalid of [{endsAt:now-1},{lastObservedAt:now+1},{lastObservedAt:null},{endsAt:null},{lastObservedAt:now-60001}]) {
      await pool.query('UPDATE kenan_meeting_provider SET data=$2 WHERE id=$1',[id,{...session,...invalid}]);
      expect((await send({eventId:'invalid-clock'})).status).not.toBe(200);
    }
    await pool.query('UPDATE kenan_meeting_provider SET data=$2 WHERE id=$1',[id,{...session,phase:'unknown'}]);
    expect((await send({eventId:'two'})).status).not.toBe(200);expect(messages.size).toBe(2);expect(wakes).toHaveLength(1);
  }finally{await extension.stop!();await pool.end();await rm(directory,{recursive:true,force:true});}
});
it.skipIf(!testDatabaseUrl)('Recall runtime reserves once, consumes current policy, observes actual lifecycle and leaves without browser dispatch',async()=>{
 const {vi}=await import('vitest'),{createHash}=await import('node:crypto');const directory=await mkdtemp(join(tmpdir(),'meet-recall-runtime-'));let now=Date.now();
 const snapshot=join(directory,'snapshot.json'),config=join(directory,'config.json'),id=createHash('sha256').update('acme\0recall').digest('hex'),bot='11111111-2222-4333-8444-555555555555';
 await writeFile(snapshot,JSON.stringify({at:new Date(now).toISOString(),coverage:{kind:'complete',unknownCalendars:[]},snapshot:{withdrawnEventKeys:[],meetings:[{eventKey:'recall',eventId:'recall',title:'Internal',meetingUrl:'https://meet.google.com/abc-defg-hij',organizerEmail:'host@acme.example',startAt:new Date(now-1000).toISOString(),endAt:new Date(now+60000).toISOString(),fingerprint:'recall',attendance:{included:true}}]}}));
 await writeFile(config,JSON.stringify({tools:{meeting:{joiningEnabled:true,recallEnabled:true,periodicEnabled:true,observer:{executable:'/bin/true',args:[],snapshotPath:snapshot}}}}));
 const person={id:'acme',uid:process.getuid!(),gid:process.getgid!(),home:directory,unixUser:'kenan',extensionConfigPath:config,extensions:['meeting'],manager:{name:'Kenaznia'}};let creates=0,left=false;
 vi.stubGlobal('fetch',async(input:string,init?:RequestInit)=>{let body:unknown;const u=String(input);
 if(u.includes('metadata.google.internal'))body={access_token:'inert-token'};
 else if(u.includes('secretmanager.googleapis.com'))body={payload:{data:Buffer.from(u.includes('region')?'us-west-2':'inert-key').toString('base64')}};
 else if(u.endsWith('/bot/')){creates++;const created=JSON.parse(init!.body as string);expect(created.recording_config).toBeNull();expect(created.automatic_leave.waiting_room_timeout).toBe(30);expect(created.automatic_leave.in_call_not_recording_timeout).toBe(30);body={id:bot,status_changes:[{code:'in_call_not_recording',created_at:new Date(now).toISOString()}]};}
 else {if(u.endsWith('/leave_call/'))left=true;body={id:bot,status_changes:[{code:left?'done':'in_call_not_recording',created_at:new Date(now).toISOString()}]};}
 return new Response(JSON.stringify(body),{status:200});});
 vi.useFakeTimers({toFake:['setInterval','clearInterval']});
 const deps={config:{databaseUrl:await freshSchema('t_meeting_recall'),people:[person]},placement:{kind:'callerCgroup'},now:()=>now,runtime:{managerFor:()=> 'm',deliver:()=>{}},store:{getAgent:async()=>({conversationId:'current-conversation'}),logError:async()=>{}}} as unknown as Deps;const extension=createMeetingExtension();
 try{await extension.start!(deps);const ctx={person,agent:{conversationId:'current-conversation'},deps}as unknown as ToolContext;const run=(action:string)=>extension.tool!(ctx).execute('t',{action,sessionId:id},undefined,undefined,{}as never);
 now+=30000;await vi.advanceTimersByTimeAsync(30000);
 await vi.waitFor(async()=>expect(JSON.stringify(await run('inspect'))).toContain('active'),{timeout:5000});
 expect(creates).toBe(1);await expect(run('join')).rejects.toThrow('reconciled');expect(creates).toBe(1);
 expect(JSON.stringify(await run('inspect'))).toContain('active');
 const withdrawn=JSON.parse(await (await import('node:fs/promises')).readFile(snapshot,'utf8'));
 withdrawn.at=new Date(now).toISOString();withdrawn.snapshot.withdrawnEventKeys=['recall'];await writeFile(snapshot,JSON.stringify(withdrawn));
 now+=30000;await vi.advanceTimersByTimeAsync(30000);
 await vi.waitFor(()=>expect(left).toBe(true),{timeout:5000});
 await vi.waitFor(async()=>expect(JSON.stringify(await run('inspect'))).toContain('ended'),{timeout:5000});expect(creates).toBe(1);
 }finally{await extension.stop!();vi.unstubAllGlobals();vi.useRealTimers();await rm(directory,{recursive:true,force:true})}
},90000);
it.skipIf(!testDatabaseUrl)('a Recall bot waiting in the lobby DMs the host on Slack at once and once more after 2 minutes',async()=>{
 const {vi}=await import('vitest'),{createHash}=await import('node:crypto');const directory=await mkdtemp(join(tmpdir(),'meet-recall-lobby-'));let now=Date.now();
 const snapshot=join(directory,'snapshot.json'),config=join(directory,'config.json'),id=createHash('sha256').update('acme\0lobby').digest('hex'),bot='66666666-2222-4333-8444-555555555555';
 const writeProof=()=>writeFile(snapshot,JSON.stringify({at:new Date(now).toISOString(),coverage:{kind:'complete',unknownCalendars:[]},snapshot:{withdrawnEventKeys:[],meetings:[{eventKey:'lobby',eventId:'lobby',title:'Pipeline review',meetingUrl:'https://meet.google.com/abc-defg-hij',organizerEmail:'host@acme.example',startAt:new Date(start-1000).toISOString(),endAt:new Date(start+3600000).toISOString(),fingerprint:'lobby',attendance:{included:true}}]}}));
 const start=now;await writeProof();
 await writeFile(config,JSON.stringify({tools:{meeting:{joiningEnabled:true,recallEnabled:true,periodicEnabled:true,observer:{executable:'/bin/true',args:[],snapshotPath:snapshot}}}}));
 const person={id:'acme',uid:process.getuid!(),gid:process.getgid!(),home:directory,unixUser:'kenan',extensionConfigPath:config,extensions:['meeting'],manager:{name:'Kenaznia'}};
 let admitted=false;const dms:string[]=[],errors:string[]=[];
 vi.stubGlobal('fetch',async(input:string,init?:RequestInit)=>{let body:unknown;const u=String(input);
 if(u.includes('metadata.google.internal'))body={access_token:'inert-token'};
 else if(u.includes('secretmanager.googleapis.com'))body={payload:{data:Buffer.from(u.includes('slack')?'xoxb-inert':u.includes('region')?'us-west-2':'inert-key').toString('base64')}};
 else if(u.includes('slack.com/api/users.lookupByEmail'))body={ok:true,user:{id:'UHOST'}};
 else if(u.includes('slack.com/api/conversations.open'))body={ok:true,channel:{id:'DHOST'}};
 else if(u.includes('slack.com/api/chat.postMessage')){dms.push(new URLSearchParams(String(init!.body)).get('text')!);body={ok:true,ts:'1.1'};}
 else body={id:bot,status_changes:[{code:admitted?'in_call_not_recording':'in_waiting_room',created_at:new Date(now).toISOString()}]};
 return new Response(JSON.stringify(body),{status:200});});
 vi.useFakeTimers({toFake:['setInterval','clearInterval','Date']});vi.setSystemTime(now);
 const deps={config:{databaseUrl:await freshSchema('t_meeting_lobby'),people:[person]},placement:{kind:'callerCgroup'},now:()=>now,runtime:{managerFor:()=> 'm',deliver:()=>{}},store:{getAgent:async()=>({conversationId:'current-conversation'}),logError:async(_k:string,e:string)=>{errors.push(e);}}} as unknown as Deps;const extension=createMeetingExtension();
 const step=async()=>{now+=31000;await writeProof();vi.setSystemTime(now-30000);await vi.advanceTimersByTimeAsync(30000);await new Promise(r=>setTimeout(r,300));};
 try{await extension.start!(deps);
  await step();await vi.waitFor(()=>expect(dms).toEqual(['Kenan notetaker is waiting in the lobby of Pipeline review — please admit it']),{timeout:5000});
  await step();await step();await step();expect(dms).toHaveLength(1);
  await step();await vi.waitFor(()=>expect(dms[1]).toBe('Reminder: Kenan notetaker is still waiting in the lobby of Pipeline review — please admit it'),{timeout:5000});
  for(let i=0;i<5;i++)await step();expect(dms).toHaveLength(2);
  admitted=true;await step();await step();expect(dms).toHaveLength(2);expect(errors).toEqual([]);
 }finally{await extension.stop!();vi.unstubAllGlobals();vi.useRealTimers();await rm(directory,{recursive:true,force:true})}
},90000);
it.skipIf(!testDatabaseUrl)('restart reconciles original receipt without launching a replacement read',async()=>{
 const {default:pg}=await import('pg'),{randomUUID}=await import('node:crypto');
 const {mkdir}=await import('node:fs/promises'),{receiptPath}=await import('./meeting-receipt.js');
 const directory=await mkdtemp(join(tmpdir(),'meet-original-')),snapshot=join(directory,'snapshot.json'),config=join(directory,'config.json'),now=Date.now(),operationId=randomUUID();
 const databaseUrl=await freshSchema('t_meeting_original'),pool=new pg.Pool({connectionString:databaseUrl});
 const person={id:'acme',uid:process.getuid!(),gid:process.getgid!(),home:directory,unixUser:'kenan',extensionConfigPath:config,extensions:['meeting'],manager:null};
 await writeFile(config,JSON.stringify({tools:{meeting:{observer:{executable:'/nonexistent-no-replacement-read',args:[],snapshotPath:snapshot}}}}));
 const deps={config:{databaseUrl,people:[]},placement:{kind:'callerCgroup'},now:()=>now,runtime:{managerFor:()=>null}} as unknown as Deps;
 let extension=createMeetingExtension();
 try {
  await extension.start!(deps);await extension.stop!();
  const original={lastAttemptAt:new Date(now).toISOString(),lastSuccessAt:null,consecutiveFailures:0,lastError:'unsettled',nextPeriodicAttemptAt:new Date(now).toISOString(),retryBlocked:true,pendingRead:{operationId,snapshotPath:snapshot,receiptPath:receiptPath(snapshot,operationId),admittedAt:now-100000,reconcileAt:now,repairOwner:null}};
  await pool.query('INSERT INTO kenan_meeting_observer_health VALUES($1,$2)',['acme',original]);
  extension=createMeetingExtension();await extension.start!(deps);
  const execute=()=>extension.tool!({person,deps} as never).execute('test',{action:'recheck'},undefined,undefined,{} as never);
  await expect(execute()).rejects.toThrow('cooldown');
  expect((await pool.query('SELECT data FROM kenan_meeting_observer_health')).rows[0].data.pendingRead.operationId).toBe(operationId);
  await mkdir(join(directory,'observer-receipts'));
  await writeFile(original.pendingRead.receiptPath,JSON.stringify({version:1,operationId,terminal:'failure',kind:'meeting-detection-error',code:'calendar-http-429',retryNotBefore:now+120000}));
  // Read-only receipt reconciliation cannot authorize another upstream call before its actual hint.
  const {reconcileRead}=await import('./meeting-receipt.js');
  const result=await reconcileRead(original,now);expect(result.settled).toBe(true);
  await pool.query('UPDATE kenan_meeting_observer_health SET data=$2 WHERE owner_id=$1',['acme',result.state]);
  await extension.stop!();extension=createMeetingExtension();await extension.start!(deps);
  await expect(execute()).rejects.toThrow('cooldown');
  expect((await pool.query('SELECT data FROM kenan_meeting_observer_health')).rows[0].data.retryNotBefore).toBe(now+120000);
 }finally{await extension.stop!();await pool.end();await rm(directory,{recursive:true,force:true});}
});
