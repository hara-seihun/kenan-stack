import './scratch-env.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
const {main}=await import(process.env.WORKSPACE_RELEASE_MODULE||'./workspace.mjs');
for(const intent of ['unestimated','budgeted','live-unestimated','unknown-unestimated']) test(`explicit ${intent} runtime handoff settles and retries without deleting evidence`,()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'runtime-handoff-')),source=path.join(root,'source'),state=path.join(root,'state.sqlite');
 const previous=process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY;process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY='empty';let db;
 const git=(...a)=>execFileSync('git',a,{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
 const run=args=>{let out='';const write=process.stdout.write,exit=process.exitCode;process.stdout.write=x=>{out+=x;return true;};try{main(args,state,{releaseAuthorityDependencies:{caller:()=>({ok:true,kind:'operator'})}});return {value:JSON.parse(out),exit:process.exitCode??0};}finally{process.stdout.write=write;process.exitCode=exit;}};
 try{
  git('init',source);git('-C',source,'config','user.name','Fixture');git('-C',source,'config','user.email','fixture@example.invalid');fs.writeFileSync(path.join(source,'proof'),'research evidence');git('-C',source,'add','.');git('-C',source,'commit','-m','proof');
  const head=git('-C',source,'rev-parse','HEAD');const record=run(['register','--path',source,'--root',root,'--owner','fixture','--source-commit',head,'--json']).value;
  db=new DatabaseSync(state);const st=fs.statSync(source),now=Date.now();
  const plan={intent:intent.endsWith('-unestimated')?'unestimated':intent,estimate:'unknown',constructionBytes:30*1024**3,growthBytes:intent==='budgeted'?1024**3:0,headroomBytes:intent==='budgeted'?8*1024**3:0};
  db.prepare('INSERT OR REPLACE INTO workspace_capacity(workspace_id,device_id,plan_json) VALUES(?,?,?)').run(record.id,String(st.dev),JSON.stringify(plan));
  db.prepare('INSERT OR REPLACE INTO workspace_capacity_measurement VALUES(?,?)').run(record.id,JSON.stringify({ok:true,bytes:4096,allocatedBytes:4096,device:String(st.dev),inode:String(st.ino),startedAt:now,completedAt:now}));
  // Simulate the old failed handoff: explicit retention with repair-required state.
  db.exec('CREATE TABLE IF NOT EXISTS workspace_source_retention(workspace_id TEXT PRIMARY KEY, occurred_at INTEGER)');
  db.prepare('INSERT INTO workspace_source_retention(workspace_id) VALUES(?)').run(record.id);
  db.prepare("UPDATE workspace SET lease_expires_at=0,state='repair-required' WHERE id=?").run(record.id);
  if(intent.startsWith('live-') || intent.startsWith('unknown-')) {
   const file=path.join(root,'thread.sqlite3'),threads=new DatabaseSync(file),prior=process.env.PI_THREAD_DATABASE;
   try {
    if(intent.startsWith('live-')) {
     threads.exec('CREATE TABLE thread(id TEXT PRIMARY KEY,cwd TEXT,state TEXT,metadata TEXT); CREATE TABLE thread_work(thread_id TEXT,status TEXT); CREATE TABLE thread_execution(thread_id TEXT,ended_at INTEGER)');
     threads.prepare('INSERT INTO thread VALUES(?,?,?,?)').run('writer',source,'running','{}');
    }
    process.env.PI_THREAD_DATABASE=file;
    const r=run(['release','--id',record.id,'--preserve-runtime','--json']);
    assert.equal(r.exit,2);assert.notEqual(r.value.runtimeHandoff?.kind,'settled');assert.equal(fs.readFileSync(path.join(source,'proof'),'utf8'),'research evidence');
   } finally {threads.close();if(prior===undefined)delete process.env.PI_THREAD_DATABASE;else process.env.PI_THREAD_DATABASE=prior;}
   return;
  }
  for(let i=0;i<2;i++){
   const r=run(['release','--id',record.id,'--preserve-runtime','--json']);
   assert.equal(r.exit,0,JSON.stringify(r.value));assert.equal(r.value.action,'runtime-preserved');assert.equal(r.value.record.state,'referenced');assert.equal(r.value.runtimeHandoff.newWritesAuthorized,false);
   assert.equal(git('-C',source,'rev-parse','HEAD'),head);assert.equal(fs.readFileSync(path.join(source,'proof'),'utf8'),'research evidence');
  }
  if(intent==='unestimated')assert.deepEqual(JSON.parse(db.prepare('SELECT plan_json FROM workspace_capacity WHERE workspace_id=?').get(record.id).plan_json),plan);
  assert.throws(()=>run(['heartbeat','--id',record.id]),{code:'growth-admission-required'});
 }finally{db?.close();if(previous===undefined)delete process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY;else process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY=previous;fs.rmSync(root,{recursive:true,force:true});}
});
