import './scratch-env.mjs';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,chmodSync,writeFileSync,rmSync,statSync,statfsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {main,workspaceTesting} from './workspace.mjs';
const M=1024**2,G=1024**3;

// Converge 2026-10-21: d4c24e43 held a 512 MiB source-only reservation (2.46 MB written)
// on a device whose other reservations (47.55 GiB, plus 30 GiB of shared headroom from
// unestimated plans) already exceeded its 42.56 GiB free. Re-pricing it as budgeted at
// the same 512 MiB was refused as if it were a new 78.05 GiB admission.
test('re-pricing an existing reservation charges only its increment, even on an oversubscribed device',()=>{
 const root=mkdtempSync(path.join(tmpdir(),'reprice-admission-'));let db;
 const state=path.join(root,'registry.sqlite3');
 const git=(...args)=>execFileSync('git',args,{encoding:'utf8',timeout:5000}).trim();
 const run=args=>{let text='';const prior=process.stdout.write;const exit=process.exitCode;process.stdout.write=v=>{text+=v;return true;};try{main(args,state);}finally{process.stdout.write=prior;process.exitCode=exit;}return JSON.parse(text);};
 const checkout=(name,owner)=>{const dir=path.join(root,name);mkdirSync(dir);git('init','-b','main',dir);git('-C',dir,'config','user.email','fixture@example.invalid');git('-C',dir,'config','user.name','Fixture');writeFileSync(path.join(dir,'proof'),name);git('-C',dir,'add','.');git('-C',dir,'commit','-m','source');const head=git('-C',dir,'rev-parse','HEAD');return {dir,head,rec:run(['register','--path',dir,'--root',root,'--owner',owner,'--source-commit',head,'--json'])};};
 try {
  const own=checkout('current-kenan-custody','c2fb443a');
  db=new DatabaseSync(state);const stats=statSync(own.dir),device=String(stats.dev);
  const plan={intent:'source-only',estimate:'whole-tree-upper-bound',constructionBytes:52054788,sourceImportBytes:19353944,completedAllocationBytes:3923968,growthBytes:512*M,headroomBytes:8*G,sourceCommit:own.head};
  db.prepare('INSERT OR REPLACE INTO workspace_capacity VALUES(?,?,?)').run(own.rec.id,device,JSON.stringify(plan));
  const sample={ok:true,bytes:6459392,allocatedBytes:6459392,device,inode:String(stats.ino),startedAt:Date.now(),completedAt:Date.now()};
  db.prepare('INSERT OR REPLACE INTO workspace_capacity_measurement VALUES(?,?)').run(own.rec.id,JSON.stringify(sample));
  const free=()=>{const s=statfsSync(root);return s.bavail*s.bsize;};
  const unestimated=checkout('develop-taxonomy-src','other');
  db.prepare('INSERT OR REPLACE INTO workspace_capacity VALUES(?,?,?)').run(unestimated.rec.id,device,JSON.stringify({intent:'unestimated',estimate:'unknown',constructionBytes:30*G,growthBytes:0,headroomBytes:0}));
  const big=checkout('host-expiry','other');
  db.prepare('INSERT OR REPLACE INTO workspace_capacity VALUES(?,?,?)').run(big.rec.id,device,JSON.stringify({...plan,sourceCommit:big.head,growthBytes:free()}));
  const reprice=(growth,headroom='8')=>run(['reprice-capacity','--id',own.rec.id,'--intent','budgeted','--headroom-gib',headroom,'--growth-mib',growth,'--json']);
  const stored=()=>db.prepare('SELECT plan_json FROM workspace_capacity WHERE workspace_id=?').get(own.rec.id).plan_json;

  const before=stored();
  assert.throws(()=>reprice('1024'),error=>error.code==='workspace-capacity-refused'&&error.capacity.reprice.incrementalBytes===512*M);
  assert.throws(()=>reprice('512','64'),error=>error.code==='workspace-capacity-refused'&&error.capacity.reprice.incrementalBytes===34*G);
  assert.equal(stored(),before);
  // Automatic target discounts are real effective demand, not a hidden grant
  // to restore an old promise without passing the complete device admission.
  const now=Date.now();
  db.prepare('UPDATE workspace SET created_at=? WHERE id=?').run(now-3*3600000,own.rec.id);
  db.prepare('INSERT OR REPLACE INTO workspace_capacity VALUES(?,?,?)').run(own.rec.id,device,JSON.stringify({...plan,growthBytes:4*G}));
  db.prepare('INSERT OR REPLACE INTO workspace_capacity_measurement VALUES(?,?)').run(own.rec.id,JSON.stringify({...sample,startedAt:now,completedAt:now}));
  const samples=[{at:now-3600000,bytes:6459392},{at:now,bytes:6459392}];
  db.prepare('INSERT OR REPLACE INTO workspace_growth_policy VALUES(?,?)').run(own.rec.id,JSON.stringify({version:1,planGrowthBytes:4*G,samples}));
  assert.throws(()=>reprice('4096'),error=>error.code==='workspace-capacity-refused'&&error.capacity.reprice.incrementalBytes===4*G-512*M);
  db.prepare('INSERT OR REPLACE INTO workspace_capacity VALUES(?,?,?)').run(own.rec.id,device,before);
  db.prepare('UPDATE workspace SET created_at=? WHERE id=?').run(now,own.rec.id);
  db.prepare('DELETE FROM workspace_growth_policy WHERE workspace_id=?').run(own.rec.id);

  const same=reprice('512').capacity;
  assert.equal(same.intent,'budgeted');
  assert.equal(same.admission.kind,'reprice-within-reservation');
  assert.equal(same.admission.incrementalBytes,0);
  assert.ok(same.admission.requiredBytes>same.admission.freeBytes,'the device stays oversubscribed; nothing new was admitted');
  assert.equal(same.admission.deficitBytesAfter,same.admission.deficitBytesBefore);
  assert.equal(same.growthBytes,512*M,'bytes still inside the measurement margin are not booked twice');
  assert.equal(same.repricing.sampledGrowthBytes,6459392-3923968);
  for(const key of ['constructionBytes','sourceImportBytes','completedAllocationBytes','sourceCommit','headroomBytes']) assert.equal(same[key],plan[key]);

  for(const other of [big,unestimated]) db.prepare('DELETE FROM workspace_capacity WHERE workspace_id=?').run(other.rec.id);
  const grown=reprice('1024').capacity;
  assert.equal(grown.admission.kind,'reprice-increment');
  assert.equal(grown.admission.incrementalBytes,512*M);
  assert.equal(grown.growthBytes,1024*M);
  assert.equal(db.prepare('SELECT count(*) n FROM workspace_capacity_repricing WHERE workspace_id=?').get(own.rec.id).n,2);
 } finally { db?.close(); rmSync(root,{recursive:true,force:true}); }
});

// Repricing retains every unrelated promise without reading or refreshing its cache.
test('repricing increases read CREATE sampled accounting without refreshing unrelated stale caches and commit consumed growth exactly once',()=>{
 const root=mkdtempSync(path.join(tmpdir(),'reprice-stale-'));let db;
 const state=path.join(root,'registry.sqlite3'),priorSafety=process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY;
 process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY='empty';
 const git=(...a)=>execFileSync('git',a,{encoding:'utf8',timeout:5000}).trim();
 let warnings='';
 const run=args=>{let text='';warnings='';const write=process.stdout.write,err=process.stderr.write,exit=process.exitCode;process.stdout.write=v=>{text+=v;return true;};process.stderr.write=v=>{warnings+=v;return true;};try{main(args,state);return JSON.parse(text);}finally{process.stdout.write=write;process.stderr.write=err;process.exitCode=exit;}};
 const source=name=>{const dir=path.join(root,name);mkdirSync(dir);git('init','-q',dir);git('-C',dir,'-c','user.name=F','-c','user.email=f@example.invalid','commit','-q','--allow-empty','-m','source');const head=git('-C',dir,'rev-parse','HEAD');return {dir,head,row:run(['register','--path',dir,'--owner','fixture','--source-commit',head,'--json'])};};
 try{
  const own=source('own'),other=source('other');db=new DatabaseSync(state);const device=String(statSync(root).dev),at=Date.now();
  const plan={intent:'source-only',estimate:'whole-tree-upper-bound',constructionBytes:M,completedAllocationBytes:M,growthBytes:512*M,headroomBytes:8*G,sourceCommit:own.head};
  const ownText=JSON.stringify(plan),sample={ok:true,bytes:129*M,allocatedBytes:129*M,device,inode:String(statSync(own.dir).ino),startedAt:at,completedAt:at};
  db.prepare('INSERT OR REPLACE INTO workspace_capacity VALUES(?,?,?)').run(own.row.id,device,ownText);
  db.prepare('INSERT OR REPLACE INTO workspace_capacity_measurement VALUES(?,?)').run(own.row.id,JSON.stringify(sample));
  const stats=statfsSync(root),free=stats.bavail*stats.bsize;
  db.prepare('INSERT OR REPLACE INTO workspace_capacity VALUES(?,?,?)').run(other.row.id,device,JSON.stringify({...plan,intent:'budgeted',growthBytes:Math.floor(free*.6),sourceCommit:other.head}));
  db.prepare('UPDATE workspace SET created_at=? WHERE id=?').run(at-3*3600000,other.row.id);
  // A successful prior cache without bound policy must be refreshed, not waived.
  const otherText=db.prepare('SELECT plan_json FROM workspace_capacity WHERE workspace_id=?').get(other.row.id).plan_json;
  const stale={...sample,rootPath:other.dir,planSha256:createHash('sha256').update(otherText).digest('hex'),bytes:M,allocatedBytes:M,inode:String(statSync(other.dir).ino),startedAt:at-1200000,completedAt:at-1200000};
  db.prepare('INSERT OR REPLACE INTO workspace_capacity_measurement VALUES(?,?)').run(other.row.id,JSON.stringify(stale));
  db.prepare('DELETE FROM workspace_growth_policy WHERE workspace_id=?').run(other.row.id);
  const before=db.prepare('SELECT * FROM workspace WHERE id=?').get(other.row.id),otherPlan=db.prepare('SELECT plan_json FROM workspace_capacity WHERE workspace_id=?').get(other.row.id).plan_json;
  const growthMiB=Math.floor(free*.25/M),result=run(['reprice-capacity','--id',own.row.id,'--intent','budgeted','--headroom-gib','8','--growth-mib',String(growthMiB),'--json']).capacity;
  assert.match(warnings,/capacity warning \(not an admission refusal\)/);
  assert.match(warnings,/conservative ledger pricing/);
  assert.match(warnings,/use the exit status and JSON result/);
  assert.equal(result.growthBytes,growthMiB*M+64*M,'one margin-adjusted consumed growth increment, not two');
  assert.equal(db.prepare('SELECT count(*) n FROM workspace_capacity_repricing WHERE workspace_id=?').get(own.row.id).n,1);
  assert.deepEqual(db.prepare('SELECT * FROM workspace WHERE id=?').get(other.row.id),before);
  assert.equal(db.prepare('SELECT plan_json FROM workspace_capacity WHERE workspace_id=?').get(other.row.id).plan_json,otherPlan);
  const refreshed=JSON.parse(db.prepare('SELECT measurement_json FROM workspace_capacity_measurement WHERE workspace_id=?').get(other.row.id).measurement_json);
  assert.deepEqual(refreshed,stale,'unrelated stale cache remains byte-for-byte unchanged');
  assert.equal(result.admission.otherReservationsObservation,'create-sampled-ledger');
  assert.equal(result.admission.otherAllocationSamplesRead,true);
  assert.equal(result.admission.reservedBytes,Math.floor(free*.6));
  const admitted=db.prepare('SELECT plan_json FROM workspace_capacity WHERE workspace_id=?').get(own.row.id).plan_json;
  assert.throws(()=>run(['reprice-capacity','--id',own.row.id,'--intent','budgeted','--headroom-gib','8','--growth-mib',String(Math.ceil(free*1.3/M)),'--json']),e=>e.code==='workspace-capacity-refused'&&e.capacity.freeBytes>0&&e.capacity.requiredBytes>e.capacity.freeBytes);
  assert.equal(db.prepare('SELECT plan_json FROM workspace_capacity WHERE workspace_id=?').get(own.row.id).plan_json,admitted);
  assert.equal(db.prepare('SELECT count(*) n FROM workspace_capacity_repricing WHERE workspace_id=?').get(own.row.id).n,1);
 }finally{db?.close();if(priorSafety===undefined)delete process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY;else process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY=priorSafety;rmSync(root,{recursive:true,force:true});}
});

// No filesystem or cache interface is supplied. Any accidental global measurement
// in the ledger projection fails this fake database immediately.
test('ledger-only repricing projection never reads unrelated samples or safety state',()=>{
 const plan={intent:'budgeted',constructionBytes:20*G,growthBytes:6*G,headroomBytes:8*G};
 const db={prepare(sql){
  assert.doesNotMatch(sql,/measurement|growth_policy|native_owner/);
  if(sql.includes('JOIN workspace'))return {all:()=>[{state:'active',plan_json:JSON.stringify(plan)}]};
  if(sql.includes('workspace_source_capacity'))return {all:()=>[{destination:'/import',receipt:'receipt',plan_json:JSON.stringify({...plan,intent:'unestimated',constructionBytes:30*G,growthBytes:0})}]};
  if(sql.includes("LIKE 'execution:%'"))return {all:()=>[{plan_json:JSON.stringify({kind:'execution-capacity',state:'reserved',growthBytes:2*G,headroomBytes:9*G})}]};
  if(sql.includes('LEFT JOIN'))return {all:()=>[]};
  throw Error('injected failing global measurement: '+sql);
 }};
 const projected=workspaceTesting.repriceReservations(db,'device','/target');
 assert.deepEqual(projected.priced,[6*G,0,2*G]);
 assert.equal(projected.headroomBytes,30*G);
});

for(const shared of [8,30]) test(`unestimated conversion with ${shared} GiB other headroom compares complete effective demand without sampling stale caches`,()=>{
 const root=mkdtempSync(path.join(tmpdir(),'reprice-shrink-')),state=path.join(root,'registry.sqlite3');let db;
 const git=(...a)=>execFileSync('git',a,{encoding:'utf8',timeout:5000}).trim();
 const run=args=>{let text='';const write=process.stdout.write,err=process.stderr.write,exit=process.exitCode;process.stdout.write=v=>{text+=v;return true;};process.stderr.write=()=>true;try{main(args,state);return JSON.parse(text);}finally{process.stdout.write=write;process.stderr.write=err;process.exitCode=exit;}};
 const source=name=>{const dir=path.join(root,name);mkdirSync(dir);git('init','-q',dir);git('-C',dir,'-c','user.name=F','-c','user.email=f@example.invalid','commit','-q','--allow-empty','-m','source');const head=git('-C',dir,'rev-parse','HEAD');return {dir,head,row:run(['register','--path',dir,'--owner','owner','--source-commit',head,'--json'])};};
 try{
  const own=source('target'),other=source('unrelated');db=new DatabaseSync(state);const device=String(statSync(root).dev),at=Date.now();
  const old={intent:'unestimated',estimate:'unknown',constructionBytes:30*G,growthBytes:0,headroomBytes:0};
  db.prepare('INSERT OR REPLACE INTO workspace_capacity VALUES(?,?,?)').run(own.row.id,device,JSON.stringify(old));
  const sample={ok:true,bytes:M,allocatedBytes:M,device,inode:String(statSync(own.dir).ino),startedAt:at,completedAt:at};
  db.prepare('INSERT OR REPLACE INTO workspace_capacity_measurement VALUES(?,?)').run(own.row.id,JSON.stringify(sample));
  const otherPlan={intent:'budgeted',estimate:'whole-tree-upper-bound',constructionBytes:0,growthBytes:1000000*G,headroomBytes:shared*G};
  db.prepare('INSERT OR REPLACE INTO workspace_capacity VALUES(?,?,?)').run(other.row.id,device,JSON.stringify(otherPlan));
  // An unreadable or malformed sample is deliberately irrelevant to this path.
  db.prepare('INSERT OR REPLACE INTO workspace_capacity_measurement VALUES(?,?)').run(other.row.id,'injected failing global measurement');
  const ownBefore=db.prepare('SELECT * FROM workspace WHERE id=?').get(own.row.id);
  const command=['reprice-capacity','--id',own.row.id,'--intent','budgeted','--headroom-gib','8','--growth-mib','6144','--budget-ms','3000','--json'];
  const before=Date.now();
  if(shared===30){
   assert.throws(()=>run(command),error=>error.code==='workspace-capacity-refused'&&error.capacity.reprice.incrementalBytes===6*G);
   assert.equal(db.prepare('SELECT plan_json FROM workspace_capacity WHERE workspace_id=?').get(own.row.id).plan_json,JSON.stringify(old));
  }else{
   const result=run(command).capacity;
   assert.equal(result.admission.kind,'reprice-within-reservation');
   assert.equal(result.admission.incrementalBytes,-16*G);
   assert.equal(result.repricing.remainingGrowthBytes,6*G);
   assert.equal(result.admission.otherAllocationSamplesRead,false);
   assert.equal(result.admission.reservedBytes,otherPlan.growthBytes);
  }
  assert.ok(Date.now()-before<3000);
  assert.deepEqual(db.prepare('SELECT * FROM workspace WHERE id=?').get(own.row.id),ownBefore);
  assert.equal(db.prepare('SELECT measurement_json FROM workspace_capacity_measurement WHERE workspace_id=?').get(other.row.id).measurement_json,'injected failing global measurement');
  assert.equal(db.prepare('SELECT plan_json FROM workspace_capacity WHERE workspace_id=?').get(other.row.id).plan_json,JSON.stringify(otherPlan));
 }finally{db?.close();rmSync(root,{recursive:true,force:true});}
});

test('the final transaction rejects a changed owner, identity, plan, device or sample',()=>{
 const snapshot={record:{id:'target',path:'/target',owner:'owner',state:'active',sourceCommit:'source',leaseExpiresAt:123},row:{device_id:'1',plan_json:'original'},sampleText:'original sample'};
 assert.doesNotThrow(()=>workspaceTesting.assertRepriceSnapshot(snapshot,structuredClone(snapshot)));
 for(const key of Object.keys(snapshot.record)){
  const changed=structuredClone(snapshot);changed.record[key]='conflicting value';
  assert.throws(()=>workspaceTesting.assertRepriceSnapshot(snapshot,changed),{code:'capacity-reprice-conflict'});
 }
 for(const key of Object.keys(snapshot.row)){
  const changed=structuredClone(snapshot);changed.row[key]='conflicting value';
  assert.throws(()=>workspaceTesting.assertRepriceSnapshot(snapshot,changed),{code:'capacity-reprice-conflict'});
 }
 assert.throws(()=>workspaceTesting.assertRepriceSnapshot(snapshot,{...snapshot,sampleText:'changed'}),{code:'capacity-reprice-conflict'});
});

test('a 512 MiB increase uses exactly CREATE sampled commitments rather than double-charging allocated bytes',()=>{
 const root=mkdtempSync(path.join(tmpdir(),'reprice-create-parity-')),state=path.join(root,'registry.sqlite3');let db;
 const prior=process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY;process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY='empty';
 const git=(...a)=>execFileSync('git',a,{encoding:'utf8',timeout:5000}).trim();
 const run=args=>{let text='';const write=process.stdout.write,err=process.stderr.write,exit=process.exitCode;process.stdout.write=v=>{text+=v;return true;};process.stderr.write=()=>true;try{main(args,state);return JSON.parse(text);}finally{process.stdout.write=write;process.stderr.write=err;process.exitCode=exit;}};
 const source=name=>{const dir=path.join(root,name);mkdirSync(dir);git('init','-q',dir);git('-C',dir,'-c','user.name=F','-c','user.email=f@example.invalid','commit','-q','--allow-empty','-m','source');const head=git('-C',dir,'rev-parse','HEAD');return {dir,head,row:run(['register','--path',dir,'--owner','owner','--source-commit',head,'--json'])};};
 try{
  const own=source('target'),other=source('sampled-other');db=new DatabaseSync(state);const device=String(statSync(root).dev),at=Date.now(),fs=statfsSync(root),free=fs.bavail*fs.bsize;
  const plan={intent:'source-only',estimate:'whole-tree-upper-bound',constructionBytes:0,completedAllocationBytes:0,growthBytes:512*M,headroomBytes:8*G};
  const put=(item,p,bytes)=>{const text=JSON.stringify(p);db.prepare('INSERT OR REPLACE INTO workspace_capacity VALUES(?,?,?)').run(item.row.id,device,text);db.prepare('INSERT OR REPLACE INTO workspace_capacity_measurement VALUES(?,?)').run(item.row.id,JSON.stringify({ok:true,rootPath:item.dir,planSha256:createHash('sha256').update(text).digest('hex'),device,inode:String(statSync(item.dir).ino),bytes,allocatedBytes:bytes,startedAt:at,completedAt:at}));};
  put(own,plan,0);put(other,{...plan,intent:'budgeted',growthBytes:Math.floor(free*1.2)},Math.floor(free*1.1));
  assert.ok(workspaceTesting.repriceReservations(db,device,own.dir).priced.reduce((a,b)=>a+b,0)>free);
  const createProjection=workspaceTesting.capacityReservations(db,device,own.dir),expected=createProjection.priced.reduce((a,b)=>a+b,0);
  assert.ok(expected+8*G+1024*M<free,'the exact same sampled commitments admit CREATE');
  const beforeOther=db.prepare('SELECT plan_json FROM workspace_capacity WHERE workspace_id=?').get(other.row.id).plan_json;
  const result=run(['reprice-capacity','--id',own.row.id,'--intent','budgeted','--growth-mib','1024','--headroom-gib','8','--budget-ms','3000','--json']).capacity;
  assert.equal(result.admission.kind,'reprice-increment');assert.equal(result.admission.incrementalBytes,512*M);assert.equal(result.admission.reservedBytes,expected);assert.equal(result.admission.otherReservationsObservation,'create-sampled-ledger');assert.equal(result.growthBytes,1024*M);
  assert.equal(db.prepare('SELECT plan_json FROM workspace_capacity WHERE workspace_id=?').get(other.row.id).plan_json,beforeOther);
  // Missing, failed and expired-unbound observations never fabricate credit.
  for(const text of [JSON.stringify({ok:false,error:'injected failure'}),JSON.stringify({ok:true,bytes:Math.floor(free*1.1),allocatedBytes:Math.floor(free*1.1),device,inode:String(statSync(other.dir).ino),startedAt:at-1200000,completedAt:at-1200000})]){
   db.prepare('UPDATE workspace_capacity_measurement SET measurement_json=? WHERE workspace_id=?').run(text,other.row.id);
   assert.throws(()=>run(['reprice-capacity','--id',own.row.id,'--intent','budgeted','--growth-mib','1536','--headroom-gib','8','--budget-ms','1000','--json']),e=>e.code==='workspace-capacity-refused');
  }
 }finally{db?.close();if(prior===undefined)delete process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY;else process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY=prior;rmSync(root,{recursive:true,force:true});}
});

test('real stale sample refresh resumes requested price, and failed refresh preserves the plan',()=>{
 const root=mkdtempSync(path.join(tmpdir(),'reprice-stale-'));let db;
 const state=path.join(root,'registry.sqlite3'),dir=path.join(root,'source');
 const git=(...args)=>execFileSync('git',args,{encoding:'utf8',timeout:5000}).trim();
 const run=args=>{let text='';const prior=process.stdout.write;const exit=process.exitCode;process.stdout.write=v=>{text+=v;return true;};try{main(args,state);}finally{process.stdout.write=prior;process.exitCode=exit;}return JSON.parse(text);};
 try {
  mkdirSync(dir);git('init','-b','main',dir);git('-C',dir,'config','user.email','fixture@example.invalid');git('-C',dir,'config','user.name','Fixture');writeFileSync(path.join(dir,'proof'),'source');git('-C',dir,'add','.');git('-C',dir,'commit','-m','source');
  const head=git('-C',dir,'rev-parse','HEAD'),rec=run(['register','--path',dir,'--root',root,'--owner','owner','--source-commit',head,'--json']);
  db=new DatabaseSync(state);const stat=statSync(dir),device=String(stat.dev);
  const plan={intent:'source-only',constructionBytes:1024**2,sourceImportBytes:0,completedAllocationBytes:1024**2,growthBytes:512*M,headroomBytes:8*G,sourceCommit:head};
  db.prepare('INSERT OR REPLACE INTO workspace_capacity VALUES(?,?,?)').run(rec.id,device,JSON.stringify(plan));
  const stale={ok:true,bytes:1024,allocatedBytes:1024,device,inode:String(stat.ino),startedAt:Date.now()-1000000,completedAt:Date.now()-1000000};
  db.prepare('INSERT OR REPLACE INTO workspace_capacity_measurement VALUES(?,?)').run(rec.id,JSON.stringify(stale));
  const args=['reprice-capacity','--id',rec.id,'--intent','budgeted','--headroom-gib','8','--growth-mib','3072','--json'];
  const priced=run(args).capacity;
  assert.equal(priced.intent,'budgeted');assert.equal(priced.headroomBytes,8*G);assert.equal(priced.repricing.remainingGrowthBytes,3072*M);
  assert.ok(priced.repricing.measurementStartedAt>stale.startedAt);
  db.prepare('DELETE FROM workspace_capacity_measurement WHERE workspace_id=?').run(rec.id);
  const before=db.prepare('SELECT plan_json FROM workspace_capacity WHERE workspace_id=?').get(rec.id).plan_json;
  mkdirSync(path.join(dir,"unreadable"));chmodSync(path.join(dir,"unreadable"),0);
  assert.throws(()=>run(args),e=>e.code==='reprice-sample-refresh-failed');
  assert.equal(db.prepare('SELECT plan_json FROM workspace_capacity WHERE workspace_id=?').get(rec.id).plan_json,before);
  assert.equal(db.prepare('SELECT count(*) AS n FROM workspace_capacity_repricing WHERE workspace_id=?').get(rec.id).n,1);
 } finally {if(db)chmodSync(path.join(dir,"unreadable"),0o700);db?.close();rmSync(root,{recursive:true,force:true});}
});
