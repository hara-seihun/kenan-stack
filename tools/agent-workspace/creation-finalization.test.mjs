import './scratch-env.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {main,workspaceTesting} from './workspace.mjs';
import {withContentObservation,observeInodeContent} from './inode-content.mjs';
import {allocationSlice} from './incremental-allocation.mjs';
import {assertIdleObservation} from './idle-growth.mjs';
const G=1024**3;
test('admitted construction finalizes after unrelated samples become stale, preserves ignored output and resumes idempotently without a content hash',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'complete-parity-')),state=path.join(root,'registry.sqlite3');let db;
 const previous=process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY;process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY='empty';
 const git=(...a)=>execFileSync('git',a,{encoding:'utf8',timeout:5000}).trim();
 const capture=fn=>{let out='';const write=process.stdout.write,err=process.stderr.write,exit=process.exitCode;process.stdout.write=v=>{out+=v;return true;};process.stderr.write=()=>true;try{fn();return out?JSON.parse(out):null;}finally{process.stdout.write=write;process.stderr.write=err;process.exitCode=exit;}};
 const run=args=>capture(()=>main(args,state));
 const checkout=name=>{const dir=path.join(root,name);fs.mkdirSync(dir);git('init','-q',dir);fs.writeFileSync(path.join(dir,'.gitignore'),'node_modules/\n');git('-C',dir,'add','.');git('-C',dir,'-c','user.name=F','-c','user.email=f@example.invalid','commit','-qm','source');const head=git('-C',dir,'rev-parse','HEAD');return {dir,head,rec:run(['register','--path',dir,'--root',root,'--owner','owner','--source-commit',head,'--json'])};};
 try{
  const own=checkout('target'),other=checkout('direct-env-complete');db=workspaceTesting.openRegistry(state);const device=String(fs.statSync(root).dev),now=Date.now();
  const plan={intent:'budgeted',estimate:'whole-tree-upper-bound',constructionBytes:G,growthBytes:4*G,headroomBytes:8*G};
  db.prepare('INSERT OR REPLACE INTO workspace_capacity VALUES(?,?,?)').run(own.rec.id,device,JSON.stringify(plan));db.prepare("UPDATE workspace SET state='creating' WHERE id=?").run(own.rec.id);
  const otherText=JSON.stringify({...plan,constructionBytes:0,completedAllocationBytes:0,growthBytes:3*G});
  db.prepare('INSERT OR REPLACE INTO workspace_capacity VALUES(?,?,?)').run(other.rec.id,device,otherText);
  const sample={ok:true,device,inode:String(fs.statSync(other.dir).ino),rootPath:other.dir,planSha256:createHash('sha256').update(otherText).digest('hex'),startedAt:now,completedAt:now,bytes:2*G,allocatedBytes:2*G};
  db.prepare('INSERT OR REPLACE INTO workspace_capacity_measurement VALUES(?,?)').run(other.rec.id,JSON.stringify(sample));
  const args={named:new Map([['json',['true']],['max-count',['0']]])};
  assert.ok(workspaceTesting.assertCapacity(root,args,db,own.dir,plan).requiredBytes>0,'original same sampled admission passes');
  db.prepare('UPDATE workspace_capacity_measurement SET measurement_json=? WHERE workspace_id=?').run(JSON.stringify({...sample,startedAt:now-1200000,completedAt:now-1200000}),other.rec.id);
  fs.mkdirSync(path.join(own.dir,'node_modules'));fs.writeFileSync(path.join(own.dir,'node_modules','preserved'),'dependency bytes already present');
  const ownerBefore=db.prepare('SELECT owner,source_commit,creation_request FROM workspace WHERE id=?').get(own.rec.id),otherBefore=db.prepare('SELECT * FROM workspace_capacity_measurement WHERE workspace_id=?').get(other.rec.id);
  const read=fs.readSync;let calls=0;fs.readSync=(...a)=>{calls++;throw Error('injected optional SHA-256 content observation failure');};
  let result;try{result=capture(()=>workspaceTesting.completeCreation(db,own.rec.id,own.dir,1200,'fixture resume completed',args));}finally{fs.readSync=read;}
  assert.equal(calls,0,'allocation finalization must not hash payloads');assert.equal(result.state,'active');assert.equal(result.id,own.rec.id);assert.equal(result.capacity.growthBytes,4*G);
  const stored=JSON.parse(db.prepare('SELECT measurement_json FROM workspace_capacity_measurement WHERE workspace_id=?').get(own.rec.id).measurement_json);assert.equal(stored.ok,true);assert.equal(stored.writeObservationComplete,false);assert.ok(stored.allocatedBytes>0);assert.equal(result.capacity.completedAllocationBytes,stored.allocatedBytes);assert.equal(stored.planSha256,createHash('sha256').update(JSON.stringify(result.capacity)).digest('hex'));
  assert.deepEqual(db.prepare('SELECT owner,source_commit,creation_request FROM workspace WHERE id=?').get(own.rec.id),ownerBefore);assert.deepEqual(db.prepare('SELECT * FROM workspace_capacity_measurement WHERE workspace_id=?').get(other.rec.id),otherBefore);
  assert.equal(fs.readFileSync(path.join(own.dir,'node_modules','preserved'),'utf8'),'dependency bytes already present');assert.equal(git('-C',own.dir,'rev-parse','HEAD'),own.head);
  const once=db.prepare('SELECT * FROM workspace WHERE id=?').get(own.rec.id);assert.equal(run(['finalize-creation','--id',own.rec.id,'--json']).state,'active');assert.deepEqual(db.prepare('SELECT * FROM workspace WHERE id=?').get(own.rec.id),once);
 }finally{db?.close();if(previous===undefined)delete process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY;else process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY=previous;fs.rmSync(root,{recursive:true,force:true});}
});
test('actual link-count change during hashing leaves valid allocation but incomplete idleness proof, never an activation failure',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'hash-race-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const file=path.join(root,'payload'),link=path.join(root,'new-link');fs.writeFileSync(file,'payload bytes');
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());const read=fs.readSync;let changed=false;
 fs.readSync=(...a)=>{const n=read(...a);if(!changed&&n){changed=true;fs.linkSync(file,link);}return n;};
 let proof;try{proof=observeInodeContent(file);}finally{fs.readSync=read;}
 assert.equal(proof.complete,false);assert.equal(proof.record,undefined);assert.ok(fs.statSync(file).nlink>1);
 assert.throws(()=>assertIdleObservation({device:'1'}, {ok:true,writeObservationComplete:false,device:'1'}),{code:'idle-growth-write-race'});
 // Incomplete proof remains false across slices and wrapper publication.
 fs.unlinkSync(link);changed=false;
 fs.readSync=(...a)=>{const n=read(...a);if(!changed&&n){changed=true;fs.linkSync(file,link);}return n;};
 let sample;try{sample=withContentObservation(db,{},observeContent=>allocationSlice(root,String(fs.statSync(root).dev),null,{observeContent}));}finally{fs.readSync=read;}
 assert.equal(sample.ok,true);assert.equal(sample.writeObservationComplete,false);
 const continued=allocationSlice(root,String(fs.statSync(root).dev),{version:3,root,device:String(fs.statSync(root).dev),inode:String(fs.statSync(root).ino),excludedPaths:[],startedAt:Date.now(),pending:[file],seen:[],bytes:0,allocatedBytes:0,entries:0,lastWriteAt:0,writeObservationComplete:false});assert.equal(continued.writeObservationComplete,false);
});
