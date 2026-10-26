import './scratch-env.mjs';
import{test}from'node:test';import assert from'node:assert/strict';import fs from'node:fs';import os from'node:os';import path from'node:path';import{execFileSync,spawn}from'node:child_process';import{DatabaseSync}from'node:sqlite';
const{main,workspaceTesting}=await import(process.env.WORKSPACE_RELEASE_MODULE||'./workspace.mjs');
function fixture(action){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'release-custody-')),source=path.join(root,'source'),remote=path.join(root,'remote.git'),state=path.join(root,'registry.sqlite3');const previous=process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY;process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY='empty';let db;
 const git=(...a)=>execFileSync('git',a,{encoding:'utf8',timeout:5000,stdio:['ignore','pipe','pipe']}).trim();
 const run=args=>{let out='';const write=process.stdout.write,exit=process.exitCode;process.stdout.write=x=>{out+=x;return true;};try{main(args,state);}finally{process.stdout.write=write;process.exitCode=exit;}return JSON.parse(out);};
 try{
  git('init','--bare',remote);git('clone',remote,source);git('-C',source,'checkout','-b','main');git('-C',source,'config','user.name','Fixture');git('-C',source,'config','user.email','fixture@example.invalid');fs.writeFileSync(path.join(source,'.gitignore'),'node_modules/\nprivate-evidence/\n');fs.writeFileSync(path.join(source,'proof'),'initial');git('-C',source,'add','.');git('-C',source,'commit','-m','initial');git('-C',source,'push','origin','main');const initial=git('-C',source,'rev-parse','HEAD');
  const record=run(['register','--path',source,'--root',root,'--owner','fixture','--source-commit',initial,'--json']);fs.mkdirSync(path.join(source,'node_modules'));fs.writeFileSync(path.join(source,'node_modules','receipt'),'generated cache');db=new DatabaseSync(state);
  const commit=()=>{fs.writeFileSync(path.join(source,'proof'),'new unique work');git('-C',source,'commit','-am','unique');return git('-C',source,'rev-parse','HEAD');};const release=()=>run(['release','--id',record.id,'--preserve-runtime','--json']);
  action({root,source,remote,state,record,db,git,run,commit,release});
 }finally{db?.close();if(previous===undefined)delete process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY;else process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY=previous;fs.rmSync(root,{recursive:true,force:true});}
}

function priced(f) {
 const st=fs.statSync(f.source),now=Date.now();
 const plan={intent:'budgeted',estimate:'whole-tree-upper-bound',constructionBytes:4096,growthBytes:4*1024**3,headroomBytes:8*1024**3,completedAllocationBytes:4096};
 f.db.prepare('INSERT OR REPLACE INTO workspace_capacity(workspace_id,device_id,plan_json) VALUES(?,?,?)').run(f.record.id,String(st.dev),JSON.stringify(plan));
 f.db.prepare('INSERT OR REPLACE INTO workspace_capacity_measurement VALUES(?,?)').run(f.record.id,JSON.stringify({ok:true,bytes:4096,allocatedBytes:4096,device:String(st.dev),inode:String(st.ino),startedAt:now,completedAt:now}));
 return plan;
}
function checkBytes(f,head) {
 assert.equal(f.git('-C',f.source,'rev-parse','HEAD'),head);
 assert.equal(fs.readFileSync(path.join(f.source,'proof'),'utf8'),'new unique work');
 assert.equal(fs.readFileSync(path.join(f.source,'node_modules','receipt'),'utf8'),'generated cache');
}
test('explicit release settles ceased unpublished source future growth, preserving entire tree and floor',()=>fixture(f=>{
 const head=f.commit(),before=priced(f),r=f.release();
 assert.equal(r.physicalDisposition.kind,'retained');assert.equal(r.record.state,'repair-required');
 assert.equal(r.futureGrowthSettlement.kind,'retired',JSON.stringify(r));
 assert.equal(r.record.capacity.growthLifecycle.remainingGrowthBytes,0);assert.equal(r.record.capacity.growthBytes,before.growthBytes);
 assert.equal(r.record.capacity.headroomBytes,before.headroomBytes);assert.equal(r.leaseRelease.expiresAt,0);
 checkBytes(f,head);
 const journal=f.db.prepare('SELECT * FROM workspace_growth_retirement WHERE workspace_id=?').get(f.record.id);
 const d=JSON.parse(journal.disposition_json);assert.match(d.ownerEvidence,/Original ordinary release/);
 assert.equal(d.binding.head,head);assert.equal(JSON.parse(journal.safety_json).references.length,0);
 assert.equal(workspaceTesting.capacityReservations(f.db,String(fs.statSync(f.source).dev),'unrelated').headroomBytes,8*1024**3);
 assert.throws(()=>f.run(['heartbeat','--id',f.record.id]),{code:'growth-admission-required'});
 const again=f.release();assert.equal(again.action,'none');checkBytes(f,head);
}));
test('active linked borrower refuses retirement and preserves original reservation/source',()=>fixture(f=>{
 const head=f.commit(),before=priced(f),child=path.join(f.root,'borrower');
 f.git('-C',f.source,'worktree','add','--detach',child,head);
 f.run(['register','--path',child,'--root',f.root,'--owner','other-writer','--source-commit',head,'--json']);
 const r=f.release();assert.notEqual(r.futureGrowthSettlement?.kind,'retired');
 assert.equal(JSON.parse(f.db.prepare('SELECT plan_json FROM workspace_capacity WHERE workspace_id=?').get(f.record.id).plan_json).growthLifecycle,undefined);
 checkBytes(f,head);
}));
test('stale or failed sample refuses settlement without dropping allocation',()=>fixture(f=>{
 const head=f.commit();priced(f);
 f.db.prepare('UPDATE workspace_capacity_measurement SET measurement_json=? WHERE workspace_id=?').run(JSON.stringify({ok:false,error:'unknown physical allocation'}),f.record.id);
 const r=f.release();assert.equal(r.futureGrowthSettlement.kind,'retained');assert.equal(r.futureGrowthSettlement.code,'growth-sample-required');
 assert.equal(JSON.parse(f.db.prepare('SELECT plan_json FROM workspace_capacity WHERE workspace_id=?').get(f.record.id).plan_json).growthLifecycle,undefined);checkBytes(f,head);
}));
for(const mode of ['running','unknown'])test(mode+' thread custody refuses growth settlement',()=>fixture(f=>{
 const head=f.commit();priced(f);const file=path.join(f.root,'thread.sqlite3'),db=new DatabaseSync(file),prior=process.env.PI_THREAD_DATABASE;
 try {
  if(mode==='running') {
   db.exec("CREATE TABLE thread(id TEXT PRIMARY KEY,cwd TEXT,state TEXT,metadata TEXT); CREATE TABLE thread_work(thread_id TEXT,status TEXT); CREATE TABLE thread_execution(thread_id TEXT,ended_at INTEGER)");
   db.prepare('INSERT INTO thread VALUES(?,?,?,?)').run('actual-writer',f.source,'running','{}');
  }
  process.env.PI_THREAD_DATABASE=file;
  const r=f.release();assert.notEqual(r.futureGrowthSettlement?.kind,'retired');
  assert.equal(JSON.parse(f.db.prepare('SELECT plan_json FROM workspace_capacity WHERE workspace_id=?').get(f.record.id).plan_json).growthLifecycle,undefined);checkBytes(f,head);
 } finally {if(prior===undefined)delete process.env.PI_THREAD_DATABASE;else process.env.PI_THREAD_DATABASE=prior;db.close();}
}));

test('ordinary release by ID completes its retired-growth cleanup after source becomes durable',()=>fixture(f=>{
 f.commit();priced(f);const first=f.release();
 assert.equal(first.futureGrowthSettlement.kind,'retired');
 f.git('-C',f.source,'push','origin','HEAD:refs/heads/main');
 const result=f.release();assert.equal(result.ok,true,JSON.stringify(result));
 assert.equal(result.action,'released');assert.equal(fs.existsSync(f.source),false);
 assert.equal(result.ordinaryReleaseContinuation.requestId,first.releaseSettlement.requestId);
 assert.equal(f.release().action,'already-released');
 assert.equal(f.db.prepare('SELECT count(*) AS n FROM workspace_retention_release WHERE workspace_id=?').get(f.record.id).n,1);
 assert.equal(f.db.prepare('SELECT plan_json FROM workspace_capacity WHERE workspace_id=?').get(f.record.id).plan_json.includes('retired-future-growth'),true);
}));
test('ordinary retired-growth retry still protects dirty source',()=>fixture(f=>{
 f.commit();priced(f);const first=f.release();assert.equal(first.futureGrowthSettlement.kind,'retired');
 f.git('-C',f.source,'push','origin','HEAD:refs/heads/main');fs.writeFileSync(path.join(f.source,'proof'),'dirty');
 const result=f.release();assert.equal(result.ok,false);assert.equal(result.action,'none');
 assert.equal(fs.readFileSync(path.join(f.source,'proof'),'utf8'),'dirty');
 assert.equal(fs.readFileSync(path.join(f.source,'node_modules','receipt'),'utf8'),'generated cache');
}));

test('ordinary release preserves a foreign queued consumer and then completes by ID after its exact settlement',()=>fixture(f=>{
 priced(f);
 const data=path.join(f.root,'release-data'),id='74551659-ca7f-47cc-92ff-c3e4b786e9e9',owner='226bb31d-e421-4f2b-99bb-ced3e5606ad9',base=f.git('-C',f.source,'rev-parse','HEAD');
 for(const d of ['qualification-authority-requests','prepared-qualifications','merge-queue','producer-admission','release-launcher'])fs.mkdirSync(path.join(data,d),{recursive:true});
 const put=(p,x)=>fs.writeFileSync(path.join(data,p),JSON.stringify(x));
 const request={version:1,root:f.source,rootSource:base,name:'foreign-consumer',pipeline:{operation:id,owner,base,leaves:[base]}};
 put('qualification-authority-requests/'+id+'.json',request);put('prepared-qualifications/'+id+'.json.workspace.json',{id:f.record.id,path:f.source});put('prepared-qualifications/'+id+'.json.assembly.json',{request,candidate:base});put('merge-queue/state.json',{batches:[]});
 const previous=process.env.PI_WORKSPACE_TEST_QUALIFICATION_ROOT;process.env.PI_WORKSPACE_TEST_QUALIFICATION_ROOT=data;
 try{
  const first=f.release();assert.equal(first.inspection.classification,'referenced');assert.equal(first.futureGrowthSettlement.kind,'retired',JSON.stringify(first));
  const protectedAgain=f.release();assert.equal(protectedAgain.ok,false);assert.equal(fs.existsSync(f.source),true);assert.ok(protectedAgain.inspection.currentStackReferences.some(r=>r.kind==='qualification_request'));
  put('producer-admission/'+id+'.completed.json',{state:'completed',identity:request.pipeline});
  const done=f.release();assert.equal(done.action,'released',JSON.stringify(done));assert.equal(done.ordinaryReleaseContinuation.requestId,first.releaseSettlement.requestId);assert.equal(fs.existsSync(f.source),false);
 }finally{if(previous===undefined)delete process.env.PI_WORKSPACE_TEST_QUALIFICATION_ROOT;else process.env.PI_WORKSPACE_TEST_QUALIFICATION_ROOT=previous;}
}));

test('ordinary retired-growth continuation does not override a separately retained source',()=>fixture(f=>{
 f.commit();priced(f);assert.equal(f.release().futureGrowthSettlement.kind,'retired');
 f.git('-C',f.source,'push','origin','HEAD:refs/heads/main');
 f.db.exec('CREATE TABLE IF NOT EXISTS workspace_source_retention(workspace_id TEXT PRIMARY KEY,occurred_at INTEGER NOT NULL)');
 f.db.prepare('INSERT INTO workspace_source_retention VALUES(?,?)').run(f.record.id,Date.now());
 const result=f.release();assert.equal(result.action,'none');assert.equal(result.ordinaryReleaseContinuation,undefined);assert.equal(fs.existsSync(f.source),true);
}));

test('ordinary release refuses a measurement-held checkout lock promptly with an explicit continuation',()=>fixture(f=>{
 const crypto=process.getBuiltinModule('node:crypto');const lock=path.join(f.root,'locks',crypto.createHash('sha256').update('checkout:'+f.source).digest('hex'));
 fs.mkdirSync(path.dirname(lock),{recursive:true});const ready=path.join(f.root,'lock-ready');
 const child=spawn('flock',['--exclusive',lock,process.execPath,'-e',`require('fs').writeFileSync(${JSON.stringify(ready)},'held');setTimeout(()=>{},2500)`],{stdio:'ignore'});
 try{const until=Date.now()+2000;while(!fs.existsSync(ready)&&Date.now()<until)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5);assert.ok(fs.existsSync(ready));
 const start=Date.now(),r=f.release();assert.ok(Date.now()-start<1800);assert.equal(r.error.code,'release-resource-busy');assert.equal(r.completed,false);assert.equal(r.nextAction.observe[0],'agent-workspace');assert.ok(fs.existsSync(f.source));
 }finally{child.kill('SIGTERM');}
}));
