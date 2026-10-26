import './scratch-env.mjs';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,statSync,statfsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {main} from './workspace.mjs';
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

// Repricing must use the same bounded deciding-reservation refresh as create.
// The caller owns a fresh sample; another reservation alone has lost its history.
test('repricing refreshes an unrelated stale reservation and commits consumed growth exactly once',()=>{
 const root=mkdtempSync(path.join(tmpdir(),'reprice-stale-'));let db;
 const state=path.join(root,'registry.sqlite3'),priorSafety=process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY;
 process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY='empty';
 const git=(...a)=>execFileSync('git',a,{encoding:'utf8',timeout:5000}).trim();
 const run=args=>{let text='';const write=process.stdout.write,err=process.stderr.write,exit=process.exitCode;process.stdout.write=v=>{text+=v;return true;};process.stderr.write=()=>true;try{main(args,state);return JSON.parse(text);}finally{process.stdout.write=write;process.stderr.write=err;process.exitCode=exit;}};
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
  const growthMiB=Math.floor(free*.55/M),result=run(['reprice-capacity','--id',own.row.id,'--intent','budgeted','--headroom-gib','8','--growth-mib',String(growthMiB),'--json']).capacity;
  assert.equal(result.growthBytes,growthMiB*M+64*M,'one margin-adjusted consumed growth increment, not two');
  assert.equal(db.prepare('SELECT count(*) n FROM workspace_capacity_repricing WHERE workspace_id=?').get(own.row.id).n,1);
  assert.deepEqual(db.prepare('SELECT * FROM workspace WHERE id=?').get(other.row.id),before);
  assert.equal(db.prepare('SELECT plan_json FROM workspace_capacity WHERE workspace_id=?').get(other.row.id).plan_json,otherPlan);
  const refreshed=JSON.parse(db.prepare('SELECT measurement_json FROM workspace_capacity_measurement WHERE workspace_id=?').get(other.row.id).measurement_json);
  assert.ok(refreshed.startedAt>=at);assert.equal(refreshed.ok,true);
  const admitted=db.prepare('SELECT plan_json FROM workspace_capacity WHERE workspace_id=?').get(own.row.id).plan_json;
  assert.throws(()=>run(['reprice-capacity','--id',own.row.id,'--intent','budgeted','--headroom-gib','8','--growth-mib',String(Math.ceil(free*1.3/M)),'--json']),e=>e.code==='workspace-capacity-refused'&&e.capacity.freeBytes>0&&e.capacity.requiredBytes>e.capacity.freeBytes);
  assert.equal(db.prepare('SELECT plan_json FROM workspace_capacity WHERE workspace_id=?').get(own.row.id).plan_json,admitted);
  assert.equal(db.prepare('SELECT count(*) n FROM workspace_capacity_repricing WHERE workspace_id=?').get(own.row.id).n,1);
 }finally{db?.close();if(priorSafety===undefined)delete process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY;else process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY=priorSafety;rmSync(root,{recursive:true,force:true});}
});
