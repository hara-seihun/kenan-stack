import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync,spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
const {ownerLivenessSql,observeOwnerLiveness,classifyOwner,pendingWakeReferences,OWNER_AGENT_ID}=await import(process.env.WORKSPACE_OWNER_LIVENESS_MODULE||'./owner-liveness.mjs');
const {main}=await import(process.env.WORKSPACE_RELEASE_MODULE||'./workspace.mjs');

const LIVE='11111111-1111-4111-8111-111111111111',STOPPED='22222222-2222-4222-8222-222222222222',ARCHIVED='33333333-3333-4333-8333-333333333333';
const WAKING='44444444-4444-4444-8444-444444444444',ABSENT='55555555-5555-4555-8555-555555555555',HELDGOAL='66666666-6666-4666-8666-666666666666';
const GOAL='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',OTHERGOAL='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const literal=x=>x===null?'NULL':"'"+String(x).replaceAll("'","''")+"'";

// Mirrors the Kenan Stack columns the owner observer reads (server/db/schema.sql in the rewrite).
const schema=`CREATE TABLE agent(id text PRIMARY KEY,role text NOT NULL,state text NOT NULL,archived boolean NOT NULL DEFAULT false,goal_id uuid,updated_at bigint NOT NULL DEFAULT 0);
CREATE TABLE wake(id uuid PRIMARY KEY,agent_id text NOT NULL,message text NOT NULL,event jsonb,status text NOT NULL,created_at bigint NOT NULL,goal_id uuid,held_for text,handoff text);`;

test('actual PostgreSQL owner observation: only positive stopped/archived rows end an owner; absence, live rows and pending wakes do not',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'owner-liveness-pg-')),data=path.join(root,'data');
 const bin=process.env.WORKSPACE_TEST_PG_BIN||execFileSync('pg_config',['--bindir'],{encoding:'utf8',timeout:2000}).trim();
 const pg=(name,args)=>execFileSync(path.join(bin,name),args,{encoding:'utf8',timeout:10000,stdio:['ignore','pipe','pipe']});let started=false;
 try{
  pg('initdb',['-D',data,'--username=fixture','--no-locale','--auth=trust','--no-sync','--set=max_connections=10','--set=shared_buffers=8MB']);
  pg('pg_ctl',['-D',data,'-l',path.join(root,'postgres.log'),'-o',`-F -k ${root} -c listen_addresses='' -c max_connections=10 -c shared_buffers=8MB`,'-w','start']);started=true;
  pg('psql',['-X','-qAt','--host',root,'--username','fixture','--dbname','postgres','--command','CREATE DATABASE kenan_beta']);
  let sql=schema;
  for(const [id,state,archived,goal] of [[LIVE,'idle',false,GOAL],[STOPPED,'stopped',false,GOAL],[ARCHIVED,'running',true,null],[WAKING,'stopped',false,null],[HELDGOAL,'stopped',true,OTHERGOAL]])
   sql+=`INSERT INTO agent VALUES(${literal(id)},'worker',${literal(state)},${archived},${literal(goal)},1);\n`;
  let n=0;const wake=(agent,status,message,{goal=null,held=null,handoff=null,event=null}={})=>{sql+=`INSERT INTO wake VALUES('00000000-0000-4000-8000-${String(++n).padStart(12,'0')}',${literal(agent)},${literal(message)},${event===null?'NULL':literal(JSON.stringify(event))+'::jsonb'},${literal(status)},${n},${literal(goal)},${literal(held)},${literal(handoff)});\n`;};
  wake(WAKING,'pending','resume the build');
  wake('manager:converge','pending','check later',{goal:GOAL,handoff:"Consume work/clones/held-ws-7ed and report"});
  wake('manager:converge','pending','held',{goal:OTHERGOAL,handoff:'Unrelated handoff text'});
  wake('manager:converge','fired','old',{goal:GOAL,handoff:'/abs/fired-only-ws'});
  wake('manager:converge','pending','event wait',{event:{source:'event',topic:'job:x',prefix:false,note:'/abs/event-ws'}});
  pg('psql',['-X','-qAt','--host',root,'--username','fixture','--dbname','kenan_beta','--set=ON_ERROR_STOP=1','--command',sql]);
  const execute=(command,args,options)=>{const rewritten=args.map((value,index)=>args[index-1]==='--host'?root:value);const r=spawnSync(path.join(bin,command),rewritten,{...options});return {status:r.status,stdout:r.stdout,stderr:r.stderr,error:r.error};};
  const owners=[LIVE,STOPPED,ARCHIVED,WAKING,ABSENT,HELDGOAL,'task-name-owner'];
  const observation=observeOwnerLiveness(owners,{deadline:Date.now()+20000,channels:()=>['beta'],execute,user:()=>'fixture'});
  assert.deepEqual(observation.errors,[]);
  assert.equal(observation.wakes.length,4,'settled wakes are history, every pending wake is read');
  const kinds=Object.fromEntries(owners.map(owner=>[owner,classifyOwner(owner,observation)]));
  assert.equal(kinds[LIVE].kind,'live');
  assert.equal(kinds[STOPPED].kind,'ended');assert.equal(kinds[STOPPED].code,'owner-stopped');
  assert.equal(kinds[ARCHIVED].kind,'ended');assert.equal(kinds[ARCHIVED].code,'owner-archived');
  assert.equal(kinds[WAKING].kind,'live');assert.equal(kinds[WAKING].code,'owner-pending-wake');
  assert.equal(kinds[ABSENT].kind,'unknown');assert.equal(kinds[ABSENT].code,'owner-absent-from-native-store');
  assert.equal(kinds['task-name-owner'].kind,'unknown');
  // Relative and basename references in held handoffs keep the checkout; a longer sibling name does not.
  assert.equal(pendingWakeReferences('/home/kenan/work/clones/held-ws-7ed',observation,kinds[ARCHIVED])[0].match,'basename');
  assert.deepEqual(pendingWakeReferences('/home/kenan/work/clones/held-ws',observation,kinds[ARCHIVED]),[]);
  assert.equal(pendingWakeReferences('/abs/event-ws',observation,kinds[ARCHIVED])[0].match,'path');
  assert.deepEqual(pendingWakeReferences('/abs/fired-only-ws',observation,kinds[ARCHIVED]),[]);
  // A held trigger for the ended owner's goal keeps that owner's checkouts for the successor.
  assert.equal(pendingWakeReferences('/anything/unnamed',observation,kinds[STOPPED])[0].match,'owner-goal-held-trigger');
  assert.equal(pendingWakeReferences('/anything/unnamed',observation,kinds[HELDGOAL])[0].match,'owner-goal-held-trigger');
  // A refused grant (the real converge failure mode) makes every owner unknown.
  pg('psql',['-X','-qAt','--host',root,'--username','fixture','--dbname','kenan_beta','--command',"CREATE ROLE limited LOGIN; GRANT USAGE ON SCHEMA public TO limited; GRANT SELECT ON agent TO limited;"]);
  const refused=observeOwnerLiveness(owners,{deadline:Date.now()+20000,channels:()=>['beta'],execute,user:()=>'limited'});
  assert.match(refused.errors[0],/permission denied for table wake/);
  for(const owner of owners)assert.equal(classifyOwner(owner,refused).kind,'unknown');
 }finally{if(started)pg('pg_ctl',['-D',data,'-m','immediate','-w','stop']);fs.rmSync(root,{recursive:true,force:true});}
});

test('owner SQL accepts only bounded native worker ids and an exhausted deadline is an observation failure',()=>{
 assert.throws(()=>ownerLivenessSql(["x' OR true --"]),/native worker owner ids/);
 assert.ok(OWNER_AGENT_ID.test(STOPPED));assert.ok(!OWNER_AGENT_ID.test('manager:converge'));
 const late=observeOwnerLiveness([STOPPED],{deadline:Date.now()-1,channels:()=>['beta'],execute:()=>{throw new Error('must not run');}});
 assert.equal(classifyOwner(STOPPED,late).kind,'unknown');
 const partial=observeOwnerLiveness([STOPPED],{deadline:Date.now()+5000,channels:()=>['beta','production'],user:()=>'kenan',
  execute:(c,args)=>args.includes('kenan_beta')?{status:0,stdout:JSON.stringify({agents:[{id:STOPPED,state:'stopped',archived:false}],wakes:[],wakeCount:0})}:{status:2,stderr:'connection refused'}});
 assert.equal(classifyOwner(STOPPED,partial).kind,'unknown','one unavailable channel leaves every owner unknown');
 const live=observeOwnerLiveness([STOPPED],{deadline:Date.now()+5000,channels:()=>['beta','production'],user:()=>'kenan',
  execute:(c,args)=>({status:0,stdout:JSON.stringify({agents:[{id:STOPPED,state:args.includes('kenan_beta')?'stopped':'running',archived:false}],wakes:[],wakeCount:0})})});
 assert.equal(classifyOwner(STOPPED,live).kind,'live','a live row in any channel keeps the owner live');
});

function fixture(owner,action){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'owner-release-')),source=path.join(root,'held-ws-7ed'),remote=path.join(root,'remote.git'),state=path.join(root,'registry.sqlite3'),native=path.join(root,'native.json');
 const prior={safety:process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY,native:process.env.PI_WORKSPACE_TEST_OWNER_LIVENESS};
 process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY='empty';process.env.PI_WORKSPACE_TEST_OWNER_LIVENESS=native;let db;
 const git=(...a)=>execFileSync('git',a,{encoding:'utf8',timeout:5000,stdio:['ignore','pipe','pipe']}).trim();
 const run=args=>{let out='';const write=process.stdout.write,exit=process.exitCode;process.stdout.write=x=>{out+=x;return true;};let code;try{main(args,state);}finally{process.stdout.write=write;code=process.exitCode;process.exitCode=exit;}return {...JSON.parse(out),exitCode:code};};
 const observe=value=>fs.writeFileSync(native,JSON.stringify(value));
 try{
  git('init','--bare',remote);git('clone',remote,source);git('-C',source,'checkout','-b','main');git('-C',source,'config','user.name','Fixture');git('-C',source,'config','user.email','fixture@example.invalid');
  fs.writeFileSync(path.join(source,'.gitignore'),'node_modules/\n');fs.writeFileSync(path.join(source,'proof'),'initial');git('-C',source,'add','.');git('-C',source,'commit','-m','initial');git('-C',source,'push','origin','main');
  const initial=git('-C',source,'rev-parse','HEAD');
  let out='';const write=process.stdout.write;process.stdout.write=x=>{out+=x;return true;};try{main(['register','--path',source,'--root',root,'--owner',owner,'--source-commit',initial,'--lease-seconds','86400','--json'],state);}finally{process.stdout.write=write;}
  const record=JSON.parse(out);db=new DatabaseSync(state);
  const priced=()=>{const st=fs.statSync(source),now=Date.now(),plan={intent:'budgeted',estimate:'whole-tree-upper-bound',constructionBytes:4096,growthBytes:4*1024**3,headroomBytes:8*1024**3,completedAllocationBytes:4096};
   db.prepare('INSERT INTO workspace_capacity(workspace_id,device_id,plan_json) VALUES(?,?,?)').run(record.id,String(st.dev),JSON.stringify(plan));
   db.prepare('INSERT INTO workspace_capacity_measurement VALUES(?,?)').run(record.id,JSON.stringify({ok:true,bytes:4096,allocatedBytes:4096,device:String(st.dev),inode:String(st.ino),startedAt:now,completedAt:now}));return plan;};
  const plan=()=>JSON.parse(db.prepare('SELECT plan_json FROM workspace_capacity WHERE workspace_id=?').get(record.id).plan_json);
  const row=()=>({...db.prepare('SELECT state,lease_expires_at FROM workspace WHERE id=?').get(record.id)});
  const release=(...extra)=>run(['release-ended-owners','--id',record.id,...extra,'--json']);
  action({root,source,git,run,record,db,priced,plan,row,release,observe});
 }finally{db?.close();for(const [key,value] of [['PI_WORKSPACE_TEST_EXTERNAL_SAFETY',prior.safety],['PI_WORKSPACE_TEST_OWNER_LIVENESS',prior.native]]){if(value===undefined)delete process.env[key];else process.env[key]=value;}fs.rmSync(root,{recursive:true,force:true});}
}
const ended=(owner,extra={})=>({agents:[{id:owner,channel:'beta',role:'worker',state:'stopped',archived:true,goalId:GOAL}],wakes:[],observations:[{channel:'beta'}],...extra});

test('authentically ended owner: clean published checkout is released despite its unexpired writing lease, with a receipt',()=>fixture(STOPPED,f=>{
 f.observe(ended(STOPPED));
 assert.ok(f.row().lease_expires_at>Date.now());
 const dry=f.release();assert.equal(dry.results[0].action,'would-release-ended-owner');assert.ok(fs.existsSync(f.source));assert.equal(f.row().state,'active');
 const r=f.release('--execute');
 assert.equal(r.results[0].action,'released',JSON.stringify(r));assert.equal(r.results[0].ownerLiveness.code,'owner-archived');
 assert.ok(!fs.existsSync(f.source));assert.equal(f.row().state,'released');
 const receipt=f.db.prepare('SELECT * FROM workspace_owner_liveness_release WHERE workspace_id=?').get(f.record.id);
 assert.equal(receipt.owner,STOPPED);assert.equal(JSON.parse(receipt.result_json).action,'released');
 assert.equal(r.results[0].releaseSettlement.kind,'completed');
}));

test('ended owner with unpublished commits and dirty files keeps every source byte; only future growth is retired',()=>fixture(ARCHIVED,f=>{
 f.observe(ended(ARCHIVED));const before=f.priced();
 fs.writeFileSync(path.join(f.source,'proof'),'unique');f.git('-C',f.source,'commit','-am','unique');const head=f.git('-C',f.source,'rev-parse','HEAD');
 fs.writeFileSync(path.join(f.source,'dirty-untracked'),'uncommitted work');
 const r=f.release('--execute'),item=r.results[0];
 assert.equal(item.physicalDisposition.kind,'retained',JSON.stringify(item));
 assert.equal(item.futureGrowthSettlement.kind,'retired',JSON.stringify(item));assert.equal(item.futureGrowthSettlement.basis,'native-owner-ended');
 assert.equal(f.git('-C',f.source,'rev-parse','HEAD'),head);assert.equal(fs.readFileSync(path.join(f.source,'dirty-untracked'),'utf8'),'uncommitted work');
 assert.equal(f.plan().growthLifecycle.remainingGrowthBytes,0);assert.equal(f.plan().headroomBytes,before.headroomBytes);
 const journal=f.db.prepare('SELECT disposition_json FROM workspace_growth_retirement WHERE workspace_id=?').get(f.record.id);
 assert.match(JSON.parse(journal.disposition_json).ownerEvidence,/Owner-liveness release .* archive\/stop are not cessation evidence/);
 const again=f.release('--execute');assert.equal(again.results[0].code,'retained-custody');assert.equal(f.git('-C',f.source,'rev-parse','HEAD'),head);
}));

for(const [name,owner,observation,code] of [
 ['live owner',LIVE,{agents:[{id:LIVE,channel:'beta',role:'worker',state:'idle',archived:false,goalId:GOAL}],wakes:[]},'owner-live'],
 ['owner absent from the native store',ABSENT,{agents:[],wakes:[]},'owner-unknown'],
 ['stopped owner with its own pending wake',WAKING,{agents:[{id:WAKING,channel:'beta',state:'stopped',archived:false}],wakes:[{id:'w1',channel:'beta',agentId:WAKING,text:'resume',held:false}]},'owner-live'],
 ['held trigger naming the checkout by relative path',STOPPED,ended(STOPPED,{wakes:[{id:'w2',channel:'beta',agentId:'manager:converge',goalId:OTHERGOAL,held:true,text:'continue in work/clones/held-ws-7ed'}]}),'pending-wake-reference'],
 ['held trigger for the ended owner goal',STOPPED,ended(STOPPED,{wakes:[{id:'w3',channel:'beta',agentId:'manager:converge',goalId:GOAL,held:true,text:'nothing about paths'}]}),'pending-wake-reference'],
 ['unavailable native observation',STOPPED,{errors:['permission denied for table wake']},'owner-unknown'],
])test(name+' preserves the checkout, lease and reservation',()=>fixture(owner,f=>{
 f.observe(observation);const before=f.priced(),lease=f.row().lease_expires_at;
 const r=f.release('--execute');
 assert.equal(r.results[0].action,'none',JSON.stringify(r));assert.equal(r.results[0].code,code);
 assert.ok(fs.existsSync(f.source));assert.deepEqual(f.row(),{state:'active',lease_expires_at:lease});assert.deepEqual(f.plan(),before);
 if(observation.errors)assert.equal(r.exitCode,75);
}));

test('an owner that becomes live before the locked fresh readback is preserved',()=>fixture(STOPPED,f=>{
 f.priced();f.observe({sequence:[ended(STOPPED),{agents:[{id:STOPPED,channel:'beta',state:'running',archived:false}],wakes:[]}]});
 const r=f.release('--execute');
 assert.equal(r.results[0].action,'none');assert.equal(r.results[0].code,'owner-live');assert.ok(fs.existsSync(f.source));assert.equal(f.row().state,'active');
}));

test('non-native owners are never candidates',()=>fixture('task-name-owner',f=>{
 f.observe({agents:[],wakes:[]});const r=f.release('--execute');
 assert.equal(r.candidates,0);assert.equal(r.results.length,0);assert.ok(fs.existsSync(f.source));
}));
