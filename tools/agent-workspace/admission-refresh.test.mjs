import './scratch-env.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync,spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {admitWithRefresh} from './admission-refresh.mjs';
import {allocationSlice} from './incremental-allocation.mjs';
import {main} from './workspace.mjs';
const refusal=()=>Object.assign(new Error('real refusal'),{code:'workspace-capacity-refused'});
test('refreshes only typed pre-effect refusals outside admission and commits once',()=>{
 let held=false,valid=false,writes=0,decisions=0;
 const result=admitWithRefresh({decide:()=>{held=true;try{decisions++;if(!valid)throw refusal();writes++;return 'admitted';}finally{held=false;}},
 candidates:()=>[{path:'/stale'}],refresh:()=>{assert.equal(held,false);valid=true;return {kind:'measured'};}});
 assert.equal(result,'admitted');assert.equal(writes,1);assert.equal(decisions,2);
});
test('stops immediately when the deciding reservations fit and never touches unrelated rows',()=>{
 let refreshed=0,decisions=0;
 admitWithRefresh({decide:()=>{if(decisions++===0)throw refusal();return true;},candidates:()=>[{path:'/one'},{path:'/two'}],refresh:()=>{refreshed++;return {kind:'measured'};}});
 assert.equal(refreshed,1);
});
test('failed refresh preserves the actual refusal and a finite deadline',()=>{
 let now=0,refreshed=0;
 assert.throws(()=>admitWithRefresh({now:()=>now,budgetMs:5,decide:()=>{throw refusal();},candidates:()=>[{path:'/one'},{path:'/two'}],refresh:()=>{refreshed++;now=6;throw Error('unreadable');}}),e=>e.code==='workspace-capacity-refused'&&e.capacityRefresh.observations[0].kind==='failed');
 assert.equal(refreshed,1);
});
test('post-admission or unrelated failures are never replayed',()=>{
 let refresh=0;assert.throws(()=>admitWithRefresh({decide:()=>{throw Error('commit failed');},candidates:()=>[],refresh:()=>refresh++}),/commit failed/);assert.equal(refresh,0);
});
test('native registration refreshes the exact stale reservation before a genuine capacity refusal, without lease or source changes',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'admission-refresh-')),state=path.join(root,'registry.sqlite3');let db;
 const prev=process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY;process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY='empty';
 const run=args=>{let text='';const write=process.stdout.write,err=process.stderr.write,exit=process.exitCode;process.stdout.write=v=>{text+=v;return true;};process.stderr.write=()=>true;try{main(args,state);return JSON.parse(text);}finally{process.stdout.write=write;process.stderr.write=err;process.exitCode=exit;}};
 const source=name=>{const dir=path.join(root,name);fs.mkdirSync(dir);execFileSync('git',['init','-q',dir]);execFileSync('git',['-C',dir,'-c','user.name=Fixture','-c','user.email=f@example.invalid','commit','-q','--allow-empty','-m','fixture']);return dir;};
 try{
  const old=source('old'),incoming=source('incoming'),registered=run(['register','--path',old,'--owner','fixture','--intent','budgeted','--growth-mib','6144','--headroom-gib','8','--json']);
  db=new DatabaseSync(state);db.prepare('UPDATE workspace SET created_at=? WHERE id=?').run(Date.now()-3*3600000,registered.id);
  db.prepare('DELETE FROM workspace_capacity_measurement WHERE workspace_id=?').run(registered.id);
  db.prepare('DELETE FROM workspace_growth_policy WHERE workspace_id=?').run(registered.id);
  const device=String(fs.statSync(old).dev),slice=allocationSlice(old,device,null,{maxEntries:1});assert.equal(slice.partial,true);slice.state.startedAt-=10_000;
  db.exec('CREATE TABLE IF NOT EXISTS workspace_capacity_walk(workspace_id TEXT PRIMARY KEY,state_json TEXT NOT NULL)');db.prepare('INSERT OR REPLACE INTO workspace_capacity_walk VALUES(?,?)').run(registered.id,JSON.stringify(slice.state));
  const row=db.prepare('SELECT * FROM workspace WHERE id=?').get(registered.id),plan=db.prepare('SELECT plan_json FROM workspace_capacity WHERE workspace_id=?').get(registered.id).plan_json;
  const stat=fs.statfsSync(root),growth=Math.floor((stat.bavail*stat.bsize-9*1024**3)/1024**2);
  const next=run(['register','--path',incoming,'--owner','incoming','--intent','budgeted','--growth-mib',String(growth),'--headroom-gib','8','--json']);
  assert.equal(next.state,'active');const sample=JSON.parse(db.prepare('SELECT measurement_json FROM workspace_capacity_measurement WHERE workspace_id=?').get(registered.id).measurement_json);assert.equal(sample.ok,true);assert.equal(sample.startedAt,slice.state.startedAt);
  assert.deepEqual(db.prepare('SELECT * FROM workspace WHERE id=?').get(registered.id),row);assert.equal(db.prepare('SELECT plan_json FROM workspace_capacity WHERE workspace_id=?').get(registered.id).plan_json,plan);
 }finally{db?.close();if(prev===undefined)delete process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY;else process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY=prev;fs.rmSync(root,{recursive:true,force:true});}
});

for(const cache of ['missing','stale'])test(`a reserved checkout child refreshes the deciding ${cache} sample again before physical materialization`,()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'admission-materialization-')),state=path.join(root,'registry.sqlite3');let db;
 const previous={...process.env};process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY='empty';
 const run=args=>{let text='',errors='';const write=process.stdout.write,err=process.stderr.write,exit=process.exitCode;process.stdout.write=v=>{text+=v;return true;};process.stderr.write=v=>{errors+=v;return true;};try{main(args,state);assert.equal(process.exitCode,exit,errors);return JSON.parse(text);}finally{process.stdout.write=write;process.stderr.write=err;process.exitCode=exit;}};
 const source=name=>{const dir=path.join(root,name);fs.mkdirSync(dir);execFileSync('git',['init','-q',dir]);execFileSync('git',['-C',dir,'-c','user.name=Fixture','-c','user.email=f@example.invalid','commit','-q','--allow-empty','-m','fixture']);return dir;};
 try{
  const old=source('old'),sourcePath=source('source'),destination=path.join(root,'checkout');
  const oldRecord=run(['register','--path',old,'--owner','fixture','--intent','budgeted','--growth-mib','6144','--headroom-gib','8','--json']);
  const pending=run(['register','--path',sourcePath,'--owner','child','--intent','source-only','--growth-mib','1','--headroom-gib','8','--json']);
  db=new DatabaseSync(state);
  db.prepare('UPDATE workspace SET created_at=? WHERE id=?').run(Date.now()-3*3600000,oldRecord.id);
  if(cache==='missing')db.prepare('DELETE FROM workspace_capacity_measurement WHERE workspace_id=?').run(oldRecord.id);
  else {const row=db.prepare('SELECT measurement_json FROM workspace_capacity_measurement WHERE workspace_id=?').get(oldRecord.id),sample=JSON.parse(row.measurement_json);sample.startedAt-=2*3600000;sample.completedAt-=2*3600000;db.prepare('UPDATE workspace_capacity_measurement SET measurement_json=? WHERE workspace_id=?').run(JSON.stringify(sample),oldRecord.id);}
  db.prepare('DELETE FROM workspace_growth_policy WHERE workspace_id=?').run(oldRecord.id);
  const head=execFileSync('git',['-C',sourcePath,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
  const stat=fs.statfsSync(root),growthMiB=Math.floor((stat.bavail*stat.bsize-9*1024**3)/1024**2);
  const capacity={intent:'budgeted',headroomBytes:8*1024**3,growthBytes:growthMiB*1024**2};
  const request={repository:sourcePath,ref:head,mode:'writer',strategy:'clone',branch:'agent/checkout',owner:'child',kind:'agent',groupId:null,cachePaths:JSON.parse(db.prepare('SELECT cache_paths FROM workspace WHERE id=?').get(pending.id).cache_paths),capacity,leaseSeconds:3600};
  db.prepare("UPDATE workspace SET path=?,root=?,repository=?,source_commit=?,state='creating',creation_request=? WHERE id=?").run(destination,root,sourcePath,head,JSON.stringify(request),pending.id);
  const priorPlan=JSON.parse(db.prepare('SELECT plan_json FROM workspace_capacity WHERE workspace_id=?').get(pending.id).plan_json);
  db.prepare('UPDATE workspace_capacity SET plan_json=? WHERE workspace_id=?').run(JSON.stringify({...priorPlan,...capacity,constructionBytes:0}),pending.id);
  process.env.PI_WORKSPACE_CHECKOUT_JOB=pending.id;process.env.PI_WORKSPACE_CHECKOUT_STAGE=path.join(root,'.checkout.creating-'+pending.id);
  const device=String(fs.statSync(old).dev),slice=allocationSlice(old,device,null,{maxEntries:1});assert.equal(slice.partial,true);slice.state.startedAt-=10_000;
  db.exec('CREATE TABLE IF NOT EXISTS workspace_capacity_walk(workspace_id TEXT PRIMARY KEY,state_json TEXT NOT NULL)');db.prepare('INSERT OR REPLACE INTO workspace_capacity_walk VALUES(?,?)').run(oldRecord.id,JSON.stringify(slice.state));
  const oldBefore=db.prepare('SELECT * FROM workspace WHERE id=?').get(oldRecord.id),planBefore=db.prepare('SELECT plan_json FROM workspace_capacity WHERE workspace_id=?').get(oldRecord.id).plan_json;
  const result=run(['create','--root',root,'--name','checkout','--repo',sourcePath,'--ref',head,'--owner','child','--mode','writer','--intent','budgeted','--headroom-gib','8','--growth-mib',String(growthMiB),'--lease-seconds','3600','--json']);
  assert.equal(result.state,'active');assert.equal(result.id,pending.id);assert.equal(execFileSync('git',['-C',destination,'rev-parse','HEAD'],{encoding:'utf8'}).trim(),head);
  const completed=JSON.parse(db.prepare('SELECT measurement_json FROM workspace_capacity_measurement WHERE workspace_id=?').get(oldRecord.id).measurement_json);assert.equal(completed.ok,true);assert.equal(completed.startedAt,slice.state.startedAt);assert.equal(db.prepare('SELECT 1 FROM workspace_capacity_walk WHERE workspace_id=?').get(oldRecord.id),undefined);
  assert.deepEqual(db.prepare('SELECT * FROM workspace WHERE id=?').get(oldRecord.id),oldBefore);assert.equal(db.prepare('SELECT plan_json FROM workspace_capacity WHERE workspace_id=?').get(oldRecord.id).plan_json,planBefore);
 }finally{db?.close();for(const key of Object.keys(process.env))if(!(key in previous))delete process.env[key];Object.assign(process.env,previous);fs.rmSync(root,{recursive:true,force:true});}
});


test('a partial large sample cannot consume the smaller deciding row sampling turn',()=>{
 let now=0,admitted=false;const visited=[];
 const result=admitWithRefresh({now:()=>now,budgetMs:30,decide:()=>{if(!admitted)throw refusal();return 'ready';},candidates:()=>[{path:'/large'},{path:'/small'},{path:'/unneeded'}],refresh:candidate=>{visited.push(candidate.path);now+=10;if(candidate.path==='/large')return {kind:'partial'};admitted=true;return {kind:'measured'};}});
 assert.equal(result,'ready');assert.deepEqual(visited,['/large','/small']);
});
test('partial samples resume round-robin within one finite admission budget',()=>{
 let now=0,admitted=false,largeTurns=0;const visited=[];
 assert.equal(admitWithRefresh({now:()=>now,budgetMs:30,decide:()=>{if(!admitted)throw refusal();return 'ready';},candidates:()=>[{path:'/large'},{path:'/other'}],refresh:candidate=>{visited.push(candidate.path);now+=5;if(candidate.path==='/large'&&++largeTurns===2){admitted=true;return {kind:'measured'};}return {kind:'partial'};}}),'ready');
 assert.deepEqual(visited,['/large','/other','/large']);
});
test('failed admission retains its partial observations in the caller-visible stderr message',()=>{
 let now=0;assert.throws(()=>admitWithRefresh({now:()=>now,budgetMs:5,decide:()=>{throw refusal();},candidates:()=>[{path:'/large'},{path:'/later'}],refresh:()=>{now+=6;return {kind:'partial'};}}),error=>{assert.match(error.message,/capacity-refresh: /);assert.deepEqual(error.capacityRefresh.observations,[{path:'/large',kind:'partial'}]);return true;});
});


test('native admission samples a smaller deciding reservation after a busy largest tree, without a fleet refresh',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'admission-deciding-subset-')),state=path.join(root,'registry.sqlite3');let db,holder;
 const prior=process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY;process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY='empty';
 const run=args=>{let text='';const write=process.stdout.write,err=process.stderr.write,exit=process.exitCode;process.stdout.write=v=>{text+=v;return true;};process.stderr.write=()=>true;try{main(args,state);return JSON.parse(text);}finally{process.stdout.write=write;process.stderr.write=err;process.exitCode=exit;}};
 const source=name=>{const dir=path.join(root,name);fs.mkdirSync(dir);execFileSync('git',['init','-q',dir]);execFileSync('git',['-C',dir,'-c','user.name=Fixture','-c','user.email=f@example.invalid','commit','-q','--allow-empty','-m','fixture']);return dir;};
 try{
  const large=source('large'),small=source('small'),incoming=source('incoming');
  const records=[run(['register','--path',large,'--owner','large','--intent','budgeted','--growth-mib','8192','--headroom-gib','8','--json']),run(['register','--path',small,'--owner','small','--intent','budgeted','--growth-mib','6144','--headroom-gib','8','--json'])];
  db=new DatabaseSync(state);
  for(const record of records){db.prepare('UPDATE workspace SET created_at=? WHERE id=?').run(Date.now()-3*3600000,record.id);db.prepare('DELETE FROM workspace_capacity_measurement WHERE workspace_id=?').run(record.id);db.prepare('DELETE FROM workspace_growth_policy WHERE workspace_id=?').run(record.id);}
  const before=records.map(r=>({row:db.prepare('SELECT * FROM workspace WHERE id=?').get(r.id),plan:db.prepare('SELECT plan_json FROM workspace_capacity WHERE workspace_id=?').get(r.id).plan_json}));
  const locks=path.join(root,'locks');fs.mkdirSync(locks,{recursive:true});const lock=path.join(locks,createHash('sha256').update('checkout:'+large).digest('hex'));
  holder=spawn('flock',['--no-fork','--exclusive',lock,process.execPath,'-e',"console.log('held');setTimeout(()=>{},40000)"],{stdio:['ignore','pipe','pipe']});await new Promise((resolve,reject)=>{holder.stdout.once('data',resolve);holder.once('error',reject);});
  const stats=fs.statfsSync(root),growth=Math.floor((stats.bavail*stats.bsize-17*1024**3)/1024**2),started=Date.now();
  const next=run(['register','--path',incoming,'--owner','incoming','--intent','budgeted','--growth-mib',String(growth),'--headroom-gib','8','--json']);
  assert.equal(next.state,'active');assert.ok(Date.now()-started<10_000,'one busy tree consumed the admission sampling budget');
  assert.equal(JSON.parse(db.prepare('SELECT measurement_json FROM workspace_capacity_measurement WHERE workspace_id=?').get(records[1].id).measurement_json).ok,true);
  assert.notEqual(JSON.parse(db.prepare('SELECT measurement_json FROM workspace_capacity_measurement WHERE workspace_id=?').get(records[0].id)?.measurement_json??'{}').ok,true);
  records.forEach((r,i)=>{assert.deepEqual(db.prepare('SELECT * FROM workspace WHERE id=?').get(r.id),before[i].row);assert.equal(db.prepare('SELECT plan_json FROM workspace_capacity WHERE workspace_id=?').get(r.id).plan_json,before[i].plan);});
 }finally{holder?.kill('SIGTERM');db?.close();if(prior===undefined)delete process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY;else process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY=prior;fs.rmSync(root,{recursive:true,force:true});}
});

test('admission continues past ten refreshed entries until the deciding stale reservation fits',()=>{
 let admitted=false,now=0;const measured=[];
 const candidates=Array.from({length:30},(_,index)=>({path:`/stale-${index}`}));
 const result=admitWithRefresh({budgetMs:30000,now:()=>now,
  decide:()=>{if(!admitted)throw refusal();return 'admitted';},candidates:()=>candidates,
  refresh:entry=>{measured.push(entry.path);now+=100;if(entry.path==='/stale-19')admitted=true;return {kind:'measured'};}});
 assert.equal(result,'admitted');assert.equal(measured.length,20);
 assert.equal(measured.at(-1),'/stale-19');assert.ok(now<30000);
});
