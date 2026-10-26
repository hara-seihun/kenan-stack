import './scratch-env.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {syncBuiltinESMExports} from 'node:module';
import {main,workspaceTesting} from './workspace.mjs';

const G=1024**3;
function fixture(action){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'sampler-priority-')),state=path.join(root,'registry.sqlite3');
 const previous=process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY;process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY='empty';let db;
 const run=args=>{let out='';const write=process.stdout.write,exit=process.exitCode;process.stdout.write=x=>{out+=x;return true;};try{main(args,state);}finally{process.stdout.write=write;process.exitCode=exit;}return JSON.parse(out);};
 try{
  const rows={};
  for(const name of ['retired','zero','small','large','current']){
   const source=path.join(root,'pool',name);fs.mkdirSync(source,{recursive:true});
   execFileSync('git',['init','-q',source]);execFileSync('git',['-C',source,'-c','user.name=F','-c','user.email=f@example.invalid','commit','-q','--allow-empty','-m','init']);
   rows[name]=run(['register','--path',source,'--root',path.join(root,'pool'),'--owner','fixture-'+name,'--json']);
  }
  db=new DatabaseSync(state);
  const device=String(fs.statSync(path.join(root,'pool')).dev);
  const plan=(growthBytes,extra={})=>JSON.stringify({intent:'budgeted',estimate:'whole-tree-upper-bound',constructionBytes:0,growthBytes,headroomBytes:G,...extra});
  const put=(name,text)=>db.prepare('INSERT OR REPLACE INTO workspace_capacity(workspace_id,device_id,plan_json) VALUES(?,?,?)').run(rows[name].id,device,text);
  put('retired',plan(8*G,{growthLifecycle:{kind:'retired-future-growth',remainingGrowthBytes:0,retainedUse:'source',dispositionSha256:'a'.repeat(64),retiredAt:1}}));
  put('zero',plan(0));put('small',plan(1*G));put('large',plan(4*G));put('current',plan(2*G));
  db.exec('DELETE FROM workspace_capacity_measurement');
  action({root,state,rows,db,device,run});
 }finally{db?.close();if(previous===undefined)delete process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY;else process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY=previous;fs.rmSync(root,{recursive:true,force:true});}
}

test('sampler skips rows the ledger never measures and refreshes the largest full charges first',()=>fixture(f=>{
 f.run(['measure-capacity','--id',f.rows.current.id,'--json']);
 const pass=f.run(['measure-capacity','--root',path.join(f.root,'pool'),'--json']);
 assert.equal(pass.kind,'capacity-measurement');
 assert.deepEqual(pass.progress.skipped,{'retired-future-growth':1,'zero-liability':1});
 assert.deepEqual(pass.results.map(r=>path.basename(r.path)),['large','small','current']);
 assert.deepEqual(pass.results.map(r=>r.previousCache),['allocated-block-cache-missing','allocated-block-cache-missing','current']);
 assert.equal(pass.progress.fullyChargedBytesBefore,5*G);
 assert.equal(pass.progress.fullyChargedBytesAfter,0);
 assert.equal(pass.progress.measured,3);
}));

test('a targeted request measures even a retired row',()=>fixture(f=>{
 const pass=f.run(['measure-capacity','--id',f.rows.retired.id,'--json']);
 assert.equal(pass.results.length,1);assert.equal(pass.results[0].status,'measured');
}));

test('stale and future-dated samples carry separate codes',()=>fixture(f=>{
 f.run(['measure-capacity','--id',f.rows.large.id,'--json']);
 const sample=JSON.parse(f.db.prepare('SELECT measurement_json FROM workspace_capacity_measurement WHERE workspace_id=?').get(f.rows.large.id).measurement_json);
 const at=(now)=>workspaceTesting.cachedWorkspaceAllocation(f.db,f.rows.large.id,f.rows.large.path,f.device,now);
 assert.equal(at(sample.completedAt+1000).ok,true);
 assert.equal(at(sample.startedAt+16*60_000).code,'allocated-block-cache-stale');
 assert.equal(at(sample.completedAt-1).code,'allocated-block-cache-future-dated');
 const reservations=workspaceTesting.capacityReservations(f.db,f.device,undefined);
 assert.deepEqual(reservations.measurementFailures.map(failure=>[path.basename(failure.path),failure.code]).sort(),
  [['current','allocated-block-cache-missing'],['small','allocated-block-cache-missing']]);
}));

test('oldest attempts rotate first so repeated failure cannot starve another stale reservation',()=>fixture(f=>{
 f.run(['measure-capacity','--id',f.rows.small.id,'--json']);
 f.run(['measure-capacity','--id',f.rows.large.id,'--json']);
 const now=Date.now();
 for(const [name,age] of [['small',4000],['large',1000]]){
  const sample=JSON.parse(f.db.prepare('SELECT measurement_json FROM workspace_capacity_measurement WHERE workspace_id=?').get(f.rows[name].id).measurement_json);
  sample.startedAt=now-20*60000;sample.completedAt=now-20*60000;
  f.db.prepare('UPDATE workspace_capacity_measurement SET measurement_json=? WHERE workspace_id=?').run(JSON.stringify(sample),f.rows[name].id);
  f.db.prepare('UPDATE workspace_capacity_attempt SET attempted_at=? WHERE workspace_id=?').run(now-age,f.rows[name].id);
 }
 const pass=f.run(['measure-capacity','--root',path.join(f.root,'pool'),'--json']);
 assert.deepEqual(pass.results.map(r=>path.basename(r.path)),['current','small','large']);
}));

// Advance a clock at real filesystem observation boundaries instead of sleeping or
// constructing a huge tree. Both the full walk and the fleet slices read these files.
function withSlowWalk(f, action, stepMs = 500) {
 const directory=path.join(f.rows.large.path,'slow-walk');fs.mkdirSync(directory);
 for(let i=0;i<8;i++)fs.writeFileSync(path.join(directory,String(i)),'data');
 const now=Date.now,lstat=fs.lstatSync;let elapsed=0;
 Date.now=()=>now()+elapsed;
 fs.lstatSync=(file,...args)=>{
  const result=lstat(file,...args);
  if(path.dirname(String(file))===directory)elapsed+=stepMs;
  return result;
 };
 syncBuiltinESMExports();
 try{return action();}finally{Date.now=now;fs.lstatSync=lstat;syncBuiltinESMExports();}
}

for(const selector of ['id','path'])test(`targeted --${selector} uses the requested budget beyond two seconds`,()=>fixture(f=>{
 withSlowWalk(f,()=>{
  const pass=f.run(['measure-capacity',`--${selector}`,f.rows.large[selector],'--budget-ms','18000','--json']);
  assert.equal(pass.results.length,1);assert.equal(pass.results[0].status,'measured');
  assert.ok(pass.elapsedMs>=4000);assert.ok(pass.elapsedMs<18000);
  assert.equal(pass.results[0].ok,true);
 });
}));

test('targeted exhaustion respects its shorter budget and preserves the successful sample',()=>fixture(f=>{
 f.run(['measure-capacity','--id',f.rows.large.id,'--json']);
 const sample=()=>f.db.prepare('SELECT measurement_json FROM workspace_capacity_measurement WHERE workspace_id=?').get(f.rows.large.id).measurement_json;
 const previous=sample();
 withSlowWalk(f,()=>{
  const pass=f.run(['measure-capacity','--id',f.rows.large.id,'--budget-ms','1200','--json']);
  assert.equal(pass.results[0].status,'error');assert.match(pass.results[0].error,/measurement budget exhausted/);
  assert.ok(pass.elapsedMs>=1200);assert.ok(pass.elapsedMs<2500);
  assert.equal(sample(),previous);
 });
}));

test('fleet sampling keeps bounded slices and preserves prior credit until the walk finishes',()=>fixture(f=>{
 f.run(['measure-capacity','--id',f.rows.large.id,'--json']);
 const sample=()=>f.db.prepare('SELECT measurement_json FROM workspace_capacity_measurement WHERE workspace_id=?').get(f.rows.large.id).measurement_json;
 const previous=sample();
 // Give this row priority without changing the real successful sample.
 f.db.exec('DELETE FROM workspace_capacity WHERE workspace_id NOT IN (SELECT workspace_id FROM workspace_capacity_measurement)');
 withSlowWalk(f,()=>{
  const pass=f.run(['measure-capacity','--root',path.join(f.root,'pool'),'--budget-ms','1200','--json']);
  assert.ok(pass.results.some(result=>result.status==='partial'));
  assert.equal(pass.progress.measured,0);assert.equal(sample(),previous);
  assert.ok(f.db.prepare('SELECT state_json FROM workspace_capacity_walk WHERE workspace_id=?').get(f.rows.large.id));
  assert.ok(pass.elapsedMs<2500);
  const completed=f.run(['measure-capacity','--root',path.join(f.root,'pool'),'--budget-ms','18000','--json']);
  assert.equal(completed.progress.measured,1);
  assert.equal(completed.results.at(-1).status,'measured');
  assert.equal(f.db.prepare('SELECT state_json FROM workspace_capacity_walk WHERE workspace_id=?').get(f.rows.large.id),undefined);
  assert.notEqual(sample(),previous);
 });
}));

// The CLI accepts up to five minutes; there must not be a second hidden
// one-minute ceiling inside the non-incremental walk.
test('targeted sampling honors requested budgets longer than one minute',()=>fixture(f=>{
 withSlowWalk(f,()=>{
  const pass=f.run(['measure-capacity','--id',f.rows.large.id,'--budget-ms','180000','--json']);
  assert.equal(pass.results[0].status,'measured');
  assert.ok(pass.elapsedMs>=80000);assert.ok(pass.elapsedMs<180000);
 },10000);
}));

// The idle-growth observer and allocation sampler run independently. Alternating
// their modes must advance two resumable walks, not continually reset one slot.
test('alternating allocation and content modes each finish exact resumable observations',()=>fixture(f=>{
 const directory=path.join(f.rows.large.path,'alternating');fs.mkdirSync(directory);
 for(let i=0;i<32;i++)fs.writeFileSync(path.join(directory,String(i)),`payload ${i}`);
 const now=Date.now,lstat=fs.lstatSync;let elapsed=0;
 Date.now=()=>now()+elapsed;
 fs.lstatSync=(file,...args)=>{const result=lstat(file,...args);if(path.dirname(String(file))===directory)elapsed+=125;return result;};
 syncBuiltinESMExports();
 const completed=new Map();
 try{
  for(let i=0;i<120&&completed.size<2;i++){
   const mode=i%2===1;if(completed.has(mode))continue;
   const pass=f.run(['measure-capacity','--id',f.rows.large.id,'--incremental',...(mode?['--content-proof']:[]),'--budget-ms','400','--json']);
   for(const sample of pass.results)if(sample.ok){assert.equal(sample.writeObservationComplete,mode);completed.set(mode,sample);}
   if(completed.size===0)assert.equal(f.db.prepare('SELECT measurement_json FROM workspace_capacity_measurement WHERE workspace_id=?').get(f.rows.large.id),undefined,'partial totals never become credit');
  }
 }finally{Date.now=now;fs.lstatSync=lstat;syncBuiltinESMExports();}
 assert.equal(completed.size,2,'neither periodic observer may starve the other mode');
 const exact=workspaceTesting.workspaceAllocationSample(f.rows.large.path,f.device,{deadline:Date.now()+5000,maxEntries:2000000});
 assert.equal(exact.ok,true);
 for(const sample of completed.values()){assert.equal(sample.bytes,exact.bytes);assert.equal(sample.allocatedBytes,exact.allocatedBytes);assert.equal(sample.inode,exact.inode);}
 assert.equal(f.db.prepare('SELECT 1 FROM workspace_capacity_walk WHERE workspace_id=?').get(f.rows.large.id),undefined);
 assert.equal(f.db.prepare('SELECT 1 FROM workspace_capacity_content_walk WHERE workspace_id=?').get(f.rows.large.id),undefined);
}));

test('legacy explicitly tagged content progress migrates without becoming allocation credit',()=>fixture(f=>{
 withSlowWalk(f,()=>{
  const partial=f.run(['measure-capacity','--id',f.rows.large.id,'--incremental','--content-proof','--budget-ms','400','--json']);
  assert.equal(partial.progress.measured,0);
  const saved=f.db.prepare('SELECT state_json FROM workspace_capacity_content_walk WHERE workspace_id=?').get(f.rows.large.id).state_json;
  // Reproduce the old schema's single shared slot, not a live registry edit.
  f.db.prepare('INSERT OR REPLACE INTO workspace_capacity_walk VALUES(?,?)').run(f.rows.large.id,saved);
  f.db.prepare('DELETE FROM workspace_capacity_content_walk WHERE workspace_id=?').run(f.rows.large.id);
  const allocation=f.run(['measure-capacity','--id',f.rows.large.id,'--incremental','--budget-ms','400','--json']);
  assert.equal(allocation.progress.measured,0);
  assert.equal(f.db.prepare('SELECT state_json FROM workspace_capacity_content_walk WHERE workspace_id=?').get(f.rows.large.id).state_json,saved);
  const current=JSON.parse(f.db.prepare('SELECT state_json FROM workspace_capacity_walk WHERE workspace_id=?').get(f.rows.large.id).state_json);
  assert.equal(current.contentProof,false);
  assert.notEqual(current.startedAt,JSON.parse(saved).startedAt);
  assert.equal(f.db.prepare('SELECT 1 FROM workspace_capacity_measurement WHERE workspace_id=?').get(f.rows.large.id),undefined);
 },50);
}));

test('fleet finishes a bounded row quantum instead of spreading all observation starts across the fleet',()=>fixture(f=>{
 f.db.prepare('DELETE FROM workspace_capacity WHERE workspace_id=?').run(f.rows.current.id);
 const directories=['large','small'].map(name=>path.join(f.rows[name].path,'slow-completion'));
 for(const dir of directories){fs.mkdirSync(dir);for(let i=0;i<8;i++)fs.writeFileSync(path.join(dir,String(i)),'payload');}
 const now=Date.now,lstat=fs.lstatSync;let elapsed=0;
 Date.now=()=>now()+elapsed;
 fs.lstatSync=(file,...args)=>{const result=lstat(file,...args);if(directories.includes(path.dirname(String(file))))elapsed+=600;return result;};
 syncBuiltinESMExports();let pass;
 try{pass=f.run(['measure-capacity','--root',path.join(f.root,'pool'),'--budget-ms','7500','--json']);}
 finally{Date.now=now;fs.lstatSync=lstat;syncBuiltinESMExports();}
 assert.ok(pass.results.some(r=>r.path===f.rows.large.path&&r.status==='measured'),'one complete observation must finish before starting every other expensive walk');
 const sample=JSON.parse(f.db.prepare('SELECT measurement_json FROM workspace_capacity_measurement WHERE workspace_id=?').get(f.rows.large.id).measurement_json);
 assert.equal(sample.ok,true);assert.equal(sample.writeObservationComplete,false);
 const exact=workspaceTesting.workspaceAllocationSample(f.rows.large.path,f.device,{deadline:Date.now()+5000,maxEntries:2000000});
 assert.equal(sample.bytes,exact.bytes);assert.equal(sample.allocatedBytes,exact.allocatedBytes);
 assert.ok(pass.elapsedMs<9000,'the fleet aggregate budget remains bounded');
 assert.equal(f.db.prepare('SELECT measurement_json FROM workspace_capacity_measurement WHERE workspace_id=?').get(f.rows.small.id),undefined,'unfinished sibling cannot receive partial credit');
}));

test('one huge tree yields its completion quantum without starving a smaller row',()=>fixture(f=>{
 f.db.prepare('DELETE FROM workspace_capacity WHERE workspace_id=?').run(f.rows.current.id);
 const directory=path.join(f.rows.large.path,'huge-quantum');fs.mkdirSync(directory);
 for(let i=0;i<40;i++)fs.writeFileSync(path.join(directory,String(i)),'data');
 const now=Date.now,lstat=fs.lstatSync;let elapsed=0;
 Date.now=()=>now()+elapsed;
 fs.lstatSync=(file,...args)=>{const result=lstat(file,...args);if(path.dirname(String(file))===directory)elapsed+=1000;return result;};
 syncBuiltinESMExports();let pass;
 try{pass=f.run(['measure-capacity','--root',path.join(f.root,'pool'),'--budget-ms','32000','--json']);}
 finally{Date.now=now;fs.lstatSync=lstat;syncBuiltinESMExports();}
 assert.ok(pass.results.some(r=>r.path===f.rows.small.path&&r.status==='measured'));
 assert.equal(f.db.prepare('SELECT 1 FROM workspace_capacity_measurement WHERE workspace_id=?').get(f.rows.large.id),undefined);
 assert.ok(pass.elapsedMs<34000);
}));

test('expired incomplete allocation progress restarts without erasing the complete sample',()=>fixture(f=>{
 f.run(['measure-capacity','--id',f.rows.large.id,'--json']);
 const original=f.db.prepare('SELECT measurement_json FROM workspace_capacity_measurement WHERE workspace_id=?').get(f.rows.large.id).measurement_json;
 withSlowWalk(f,()=>{
  f.run(['measure-capacity','--id',f.rows.large.id,'--incremental','--budget-ms','400','--json']);
  const state=JSON.parse(f.db.prepare('SELECT state_json FROM workspace_capacity_walk WHERE workspace_id=?').get(f.rows.large.id).state_json);
  state.startedAt=Date.now()-16*60000;
  f.db.prepare('UPDATE workspace_capacity_walk SET state_json=? WHERE workspace_id=?').run(JSON.stringify(state),f.rows.large.id);
  const pass=f.run(['measure-capacity','--id',f.rows.large.id,'--incremental','--budget-ms','400','--json']);
  assert.ok(pass.results[0].startedAt>state.startedAt);
  assert.equal(pass.progress.measured,0);
  assert.equal(f.db.prepare('SELECT measurement_json FROM workspace_capacity_measurement WHERE workspace_id=?').get(f.rows.large.id).measurement_json,original);
 },500);
}));
