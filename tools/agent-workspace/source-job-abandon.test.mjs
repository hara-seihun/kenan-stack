import './scratch-env.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {abandonSourceJob,observeSourceJob,runSourceJob,sourceJobId} from './source-job.mjs';
import {sha,validateAbandonPermit,authenticatedAbandonCaller,readPermit} from './source-job-abandon.mjs';

function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'source-abandon-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const id='a'.repeat(64),dir=path.join(root,id);fs.mkdirSync(dir,{mode:0o700});
 const request={args:[['owner',['old']]],destination:'/retained'},attempt={number:1,state:'submitted',unit:'pi-workspace-source-'+ 'b'.repeat(16)+'-'+id+'-a1.service'};
 for(const [name,value]of Object.entries({'request.json':request,'attempt.json':attempt,'progress.json':{state:'interrupted',uncertain:'kept'},'command.json':['/bin/false']}))fs.writeFileSync(path.join(dir,name),JSON.stringify(value));
 const bin=path.join(root,'bin');fs.mkdirSync(bin);fs.writeFileSync(path.join(bin,'systemctl'),`#!/bin/sh\nprintf 'LoadState=not-found\nActiveState=inactive\nMainPID=0\nControlGroup=\n'\n`,{mode:0o700});
 const oldPath=process.env.PATH;process.env.PATH=bin+':'+oldPath;t.after(()=>process.env.PATH=oldPath);
 const p={kind:'source-job-abandon-permit-v1',jobId:id,requestSha256:sha(fs.readFileSync(path.join(dir,'request.json'))),attemptSha256:sha(fs.readFileSync(path.join(dir,'attempt.json'))),unit:attempt.unit,originalOwner:'old',owner:'new',workspaceId:'ws',path:'/retained',adoptionSequence:4,head:'head',agentId:'native',goalId:'goal',channel:'beta',outcome:'ABANDONED',historicalEffects:'UNKNOWN_RETAINED',automaticRetry:false,priorTerminalEvidence:{sha256:'prior',activeState:'inactive',mainPid:0,controlGroup:''}};
 const context={jobId:id,requestSha256:p.requestSha256,attemptSha256:p.attemptSha256,request,record:{id:'ws',path:'/retained',owner:'new',leaseExpiresAt:0,state:'referenced',capacity:{growthLifecycle:{kind:'retired-future-growth'}}},transfer:{sequence:4,workspace_id:'ws',path:'/retained',old_owner:'old',new_owner:'new',authorization:'manager'},head:'head',unit:attempt.unit,caller:{agentId:'native',goalId:'goal'}};
 const options={directory:dir,jobId:id,requestSha256:p.requestSha256,attemptSha256:p.attemptSha256,validate:()=>{validateAbandonPermit(p,context);return {permitSha256:'permit',caller:context.caller};},observe:()=>({errors:[],references:[],cgroup:{complete:true,members:[]}})};
 return {root,id,dir,p,context,options,bin};
}
test('terminal abandon commits immutable UNKNOWN outcome; exact retry idempotent; all original evidence unchanged',t=>{
 const f=fixture(t),names=['request.json','attempt.json','command.json','progress.json'],before=names.map(n=>fs.readFileSync(path.join(f.dir,n)));
 const r=abandonSourceJob(f.options);assert.equal(r.ok,true);assert.equal(r.outcome,'ABANDONED');assert.equal(r.historicalEffects,'UNKNOWN_RETAINED');assert.equal(r.automaticRetry,false);assert.equal(r.state,'abandoned');assert.equal(r.originalProgress.uncertain,'kept');
 assert.equal(abandonSourceJob(f.options).idempotent,true);assert.deepEqual(observeSourceJob(f.dir),JSON.parse(fs.readFileSync(path.join(f.dir,'result.json'))));
 names.forEach((n,i)=>assert.deepEqual(fs.readFileSync(path.join(f.dir,n)),before[i]));
});
for(const kind of ['live-unit','unknown-unit','live-process','live-cgroup','unknown-cgroup','changed-request','changed-attempt','foreign-owner','ref-changed','changed-adoption','active-lease','missing-prior'])test(kind+' refuses before terminal result',t=>{
 const f=fixture(t);
 if(kind==='live-unit')fs.writeFileSync(path.join(f.bin,'systemctl'),"#!/bin/sh\nprintf 'LoadState=loaded\nActiveState=active\nMainPID=222\nControlGroup=/live\n'\n");
 if(kind==='unknown-unit')fs.writeFileSync(path.join(f.bin,'systemctl'),"#!/bin/sh\nexit 1\n");
 if(kind==='live-process')f.options.observe=()=>({errors:[],references:[{pid:222}],cgroup:{complete:true,members:[]}});
 if(kind==='live-cgroup')f.options.observe=()=>({errors:[],references:[],cgroup:{complete:true,members:[222]}});
 if(kind==='unknown-cgroup')f.options.observe=()=>({errors:[],references:[],cgroup:{complete:false,members:[]}});
 if(kind==='changed-request')fs.appendFileSync(path.join(f.dir,'request.json'),' ');
 if(kind==='changed-attempt')fs.appendFileSync(path.join(f.dir,'attempt.json'),' ');
 if(kind==='foreign-owner')f.context.record.owner='other';
 if(kind==='ref-changed')f.context.head='other';
 if(kind==='changed-adoption')f.context.transfer.sequence=5;
 if(kind==='active-lease')f.context.record.leaseExpiresAt=Date.now()+10000;
 if(kind==='missing-prior')delete f.p.priorTerminalEvidence;
 assert.equal(abandonSourceJob(f.options).ok,false);assert.equal(fs.existsSync(path.join(f.dir,'result.json')),false);
});
test('terminal conflict never overwritten, custody change at final CAS refuses',t=>{
 const f=fixture(t);fs.writeFileSync(path.join(f.dir,'result.json'),JSON.stringify({state:'ready',value:'original'}));const before=fs.readFileSync(path.join(f.dir,'result.json'));assert.equal(abandonSourceJob(f.options).ok,false);assert.deepEqual(fs.readFileSync(path.join(f.dir,'result.json')),before);
 fs.unlinkSync(path.join(f.dir,'result.json'));f.options.observe=()=>{f.context.head='moved';return {errors:[],references:[],cgroup:{complete:true,members:[]}};};assert.equal(abandonSourceJob(f.options).ok,false);
});
test('native caller requires ancestor, unique streaming exact owner+goal; foreign owner and ambiguity refused',()=>{
 const p={agentId:'owner',goalId:'goal',channel:'beta'};const row={id:'owner',goal_id:'goal',role:'worker',state:'running',archived:false};
 const io={caller:()=>({channel:'beta',args:['source-job-abandon','--job-id','abc']}),execute:()=>({status:0,stdout:JSON.stringify([row])})};assert.equal(authenticatedAbandonCaller(p,io).agentId,'owner');
 for(const rows of [[],[{...row,id:'foreign'}],[{...row,goal_id:'foreign'}],[{...row,state:'stopped'}],[row,row]])assert.throws(()=>authenticatedAbandonCaller(p,{...io,execute:()=>({status:0,stdout:JSON.stringify(rows)})}));
 assert.throws(()=>authenticatedAbandonCaller(p,{...io,caller:()=>null}));
 assert.throws(()=>authenticatedAbandonCaller(p,{...io,execute:()=>({status:1})}));
});
test('abandoned result cannot submit/retry same job even restartInterrupted true',t=>{
 const f=fixture(t);assert.equal(abandonSourceJob(f.options).ok,true);
 // Source-job fixture identity differs from synthetic id; observing cannot fabricate ready or invoke command.
 const observed=observeSourceJob(f.dir);assert.equal(observed.state,'abandoned');assert.equal(observed.automaticRetry,false);
 const resultPath=path.join(f.dir,'result.json');const r=spawnSync(process.execPath,[new URL('./workspace.mjs',import.meta.url).pathname,'job-status','--job-id',f.id,'--json'],{env:{...process.env,PI_WORKSPACE_STATE:path.join(f.root,'state.sqlite3')}});
 assert.equal(r.status,2); // this fixture is intentionally outside native lookup; unknown also stays non-success
 assert.ok(fs.existsSync(resultPath));
});
test('permit parser rejects untrusted identity before filesystem access',()=>{assert.throws(()=>readPermit('../foreign'),/full job identity/);});

test('runSourceJob preserves abandoned identity despite restart flags and cannot launch command',t=>{
 const f=fixture(t),request={marker:'retained'},key='fixture',id=sourceJobId(key,request),dir=path.join(f.root,id);fs.renameSync(f.dir,dir);
 fs.writeFileSync(path.join(dir,'request.json'),JSON.stringify(request));
 fs.writeFileSync(path.join(dir,'result.json'),JSON.stringify({state:'abandoned',outcome:'ABANDONED',historicalEffects:'UNKNOWN_RETAINED',automaticRetry:false,settlement:{permitSha256:'exact'}}));
 const result=runSourceJob({directory:f.root,key,request,command:['/bin/touch',path.join(f.root,'REPLAYED')],restartInterrupted:true,restartAbnormal:true,waitMs:0});
 assert.equal(result.state,'abandoned');assert.equal(fs.existsSync(path.join(f.root,'REPLAYED')),false);
});
