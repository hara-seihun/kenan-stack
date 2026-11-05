import './scratch-env.mjs';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,statSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {digest} from './growth-lifecycle.mjs';
const {main,workspaceTesting}=await import(process.env.WORKSPACE_TERMINAL_MODULE || './workspace.mjs');

function fixture(action) {
 const root=mkdtempSync(path.join(tmpdir(),'terminal-retention-'));
 const source=path.join(root,'source'), remote=path.join(root,'durable.git'), state=path.join(root,'registry.sqlite3');
 const git=(...args)=>execFileSync('git',args,{encoding:'utf8',timeout:5000,stdio:['ignore','pipe','pipe']}).trim();
 const old=process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY;process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY='empty';
 let db;
 try {
  git('init','--bare',remote);git('clone',remote,source);git('-C',source,'config','user.email','fixture@example.invalid');git('-C',source,'config','user.name','Fixture');
  writeFileSync(path.join(source,'.gitignore'),'node_modules/\n');writeFileSync(path.join(source,'proof'),'durable');git('-C',source,'add','.');git('-C',source,'commit','-m','durable');git('-C',source,'push','origin','HEAD');
  const head=git('-C',source,'rev-parse','HEAD');
  const run=args=>{let out='';const write=process.stdout.write,code=process.exitCode;process.stdout.write=chunk=>{out+=chunk;return true;};try{if(args[0]==='release'){const named=new Map();for(let i=1;i<args.length;i++){const key=args[i].slice(2);named.set(key,[args[i+1]?.startsWith('--')||i+1===args.length?'true':args[++i]]);}workspaceTesting.releaseCommand(db,{positional:[],named},state,{caller:()=>({ok:true,kind:'operator'})});}else main(args,state);}finally{process.stdout.write=write;process.exitCode=code;}return JSON.parse(out);};
  const record=run(['register','--path',source,'--root',root,'--owner','fixture','--source-commit',head,'--json']);
  db=workspaceTesting.openRegistry(state);db.prepare('UPDATE workspace SET lease_expires_at=0 WHERE id=?').run(record.id);
  const plan=JSON.stringify({intent:'budgeted',constructionBytes:0,growthBytes:123456789,headroomBytes:8589934592,growthLifecycle:{kind:'retired-future-growth',remainingGrowthBytes:0,retainedUse:'source',dispositionSha256:'a'.repeat(64),retiredAt:Date.now()}});
  db.prepare('INSERT OR REPLACE INTO workspace_capacity(workspace_id,device_id,plan_json) VALUES(?,?,?)').run(record.id,String(statSync(source).dev),plan);
  const release=(owner='fixture',sha=digest(plan))=>run(['release','--id',record.id,'--end-retention','--owner',owner,'--expected-plan-sha256',sha,'--json']);
  action({root,source,db,run,git,head,record,plan,release});
 } finally {db?.close();if(old===undefined)delete process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY;else process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY=old;rmSync(root,{recursive:true,force:true});}
}

test('completed durable retired checkout releases without growth admission; retained default is unchanged; journal and plan survive',()=>fixture(({source,db,run,record,plan,release})=>{
 mkdirSync(path.join(source,'node_modules'));writeFileSync(path.join(source,'node_modules','generated'),'cache');
 assert.equal(run(['release','--id',record.id,'--json']).action,'none');
 assert.equal(readFileSync(path.join(source,'node_modules','generated'),'utf8'),'cache');
 const result=release();assert.equal(result.ok,true);assert.equal(result.record.state,'released');assert.equal(result.action,'released');assert.equal(existsSync(source),false);
 assert.equal(db.prepare('SELECT plan_json FROM workspace_capacity WHERE workspace_id=?').get(record.id).plan_json,plan);
 assert.equal(db.prepare('SELECT plan_json FROM workspace_retention_release WHERE workspace_id=?').get(record.id).plan_json,plan);
 assert.equal(release().action,'already-released');
}));

test('stale owner/plan and live lease cannot end retention',()=>fixture(({source,db,record,release})=>{
 assert.throws(()=>release('another'),{code:'stale-retention-release'});assert.throws(()=>release('fixture','0'.repeat(64)),{code:'stale-retention-release'});
 db.prepare('UPDATE workspace SET lease_expires_at=? WHERE id=?').run(Date.now()+60000,record.id);
 assert.throws(()=>release(),{code:'retention-release-active'});assert.equal(existsSync(source),true);
}));

for(const kind of ['dirty','unpublished','borrower','unregistered-borrower'])test(`terminal retained release protects ${kind}`,()=>fixture(({root,source,db,run,git,head,record,release})=>{
 if(kind==='dirty')writeFileSync(path.join(source,'proof'),'uncommitted');
 if(kind==='unpublished'){writeFileSync(path.join(source,'proof'),'new source');git('-C',source,'commit','-am','unpublished');}
 if(kind.includes('borrower')){
  const borrower=path.join(root,'borrower');git('-C',source,'worktree','add','--detach',borrower,head);
  if(kind==='borrower'){const saved=db.prepare('SELECT * FROM workspace_capacity WHERE workspace_id=?').get(record.id);db.prepare('DELETE FROM workspace_capacity WHERE workspace_id=?').run(record.id);const child=run(['register','--path',borrower,'--root',root,'--owner','fixture','--source-commit',head,'--json']);db.prepare('UPDATE workspace SET lease_expires_at=0 WHERE id=?').run(child.id);db.prepare('INSERT OR REPLACE INTO workspace_capacity(workspace_id,device_id,plan_json) VALUES(?,?,?)').run(record.id,saved.device_id,saved.plan_json);}
 }
 if(kind==='unregistered-borrower')assert.throws(()=>release(),{code:'growth-writer-unknown'});
 else {const result=release();assert.equal(result.ok,false);assert.equal(result.action,'none');assert.equal(result.error.code,'retention-release-protected');}
 assert.equal(existsSync(source),true);assert.equal(db.prepare('SELECT state FROM workspace WHERE id=?').get(record.id).state,'active');
}));

test('terminal safety consumer still protects process, thread, container and systemd references',()=>fixture(({source,record})=>{
 const base={processes:[],threads:[],docker:{available:false,containers:[]},systemd:{available:false,units:[]},gitAlternates:[],linkedWorktrees:[]};
 for(const safety of [
  {...base,processes:[{pid:123,command:'live',commandLine:[],cwd:source,executable:null,writableFiles:[]}]},
  {...base,threads:[{id:'unfinished',cwd:source}]},
  {...base,docker:{error:'cannot inspect containers'}},
  {...base,systemd:{error:'cannot inspect units'}}
 ])assert.ok(['referenced','blocked'].includes(workspaceTesting.inspectRecord({...record,leaseExpiresAt:0},{safety,ignoreLease:true}).classification));
}));

test('ordinary single checkout carries terminal physical scope through every reconciliation observation',()=>fixture(({source,root,db,record})=>{
 db.prepare('DELETE FROM workspace_capacity WHERE workspace_id=?').run(record.id);
 const safety={processes:[],threads:[],docker:{available:false,containers:[]},systemd:{available:false,units:[]},gitAlternates:[],linkedWorktrees:[],currentStackQueue:{errors:[],references:[{kind:'input',resourceClass:'source-intent',id:'canonical-retained-prose'}],observedAt:Date.now()}};
 const result=workspaceTesting.reconcileRecord(db,{...record,leaseExpiresAt:0},{execute:true,ignoreLease:true,reapExpired:false,preserveRuntime:true,safety,statePath:path.join(root,'registry.sqlite3'),terminalSourceTransfer:true,deadline:Date.now()+5000});
 assert.equal(result.action,'released',JSON.stringify(result));assert.equal(existsSync(source),false);
}));
test('future-growth prerequisite supplies executable bound-selector actions and explicit disposition schema',()=>fixture(({db,record,plan,release,run,source})=>{
 const priced=JSON.stringify({...JSON.parse(plan),growthLifecycle:undefined});db.prepare('UPDATE workspace_capacity SET plan_json=? WHERE workspace_id=?').run(priced,record.id);
 let caught;try{release('fixture',digest(priced));}catch(error){caught=error;}
 assert.equal(caught?.code,'future-growth-not-retired');assert.equal(caught.nextAction.kind,'retire-future-growth-required');
 const status=caught.nextAction.steps.find(step=>step.argv?.[1]==='growth-status');assert.deepEqual(status.argv,['agent-workspace','growth-status','--id',record.id,'--path',source,'--json']);
 assert.equal(caught.nextAction.steps.find(step=>step.kind==='prepare-disposition').schema.properties.growthWriters.const,'none');
 assert.ok(caught.nextAction.steps.find(step=>step.kind==='prepare-disposition').schema.required.includes('observedAt'));
 assert.throws(()=>run(['retire-growth','--id',record.id,'--owner','fixture','--json']),error=>error.code==='invalid-workspace-selector'&&error.nextAction.selector.kind==='all');
 assert.throws(()=>run(['release','--id',record.id,'--path',source,'--end-retention','--owner','fixture','--expected-plan-sha256',digest(priced),'--json']),error=>error.code==='invalid-workspace-selector'&&error.nextAction.selector.kind==='exactly-one');
}));

// A supplied, fresh whole-host snapshot must be consumed, not followed by a
// serial database/systemd/Docker census with the same expiring deadline.
test('growth safety consumes the shared snapshot and preserves its live thread and failed channels',()=>fixture(({source,record})=>{
 const snapshot={gitAlternates:[],linkedWorktrees:[],threads:[{id:'live',cwd:source}],docker:{containers:[],error:'docker unavailable'},systemd:{units:[],error:'systemd unavailable'}};
 const forbiddenDatabase={prepare(){throw new Error('duplicate topology census');}};
 const safety=workspaceTesting.growthSafety(forbiddenDatabase,record,{snapshot});
 assert.deepEqual(safety.errors,['docker unavailable','systemd unavailable']);
 assert.ok(safety.references.some(row=>row.id==='live'));
}));

test('terminal release retains a checkout referenced by a real thread database',()=>fixture(({root,source,release})=>{
 const file=path.join(root,'threads.sqlite3'),threads=new DatabaseSync(file),old=process.env.PI_THREAD_DATABASE;
 try{
  threads.exec(`CREATE TABLE thread(id TEXT PRIMARY KEY,cwd TEXT,state TEXT,metadata TEXT); CREATE TABLE thread_work(thread_id TEXT,status TEXT); CREATE TABLE thread_execution(thread_id TEXT,ended_at INTEGER)`);
  threads.prepare('INSERT INTO thread VALUES(?,?,?,?)').run('live',source,'running','{}');
  process.env.PI_THREAD_DATABASE=file;
  const result=release();assert.equal(result.ok,false);assert.equal(existsSync(source),true);
  threads.exec("UPDATE thread SET state='finished'");
  assert.equal(release().action,'released');assert.equal(existsSync(source),false);
 }finally{threads.close();if(old===undefined)delete process.env.PI_THREAD_DATABASE;else process.env.PI_THREAD_DATABASE=old;}
}));


test('pushed source-only retired checkout prints the exact executable plan-bound release on the first refusal',()=>fixture(({source,db,run,git,record,plan})=>{
 const sourcePlan=JSON.stringify({...JSON.parse(plan),intent:'source-only'});
 db.prepare('UPDATE workspace_capacity SET plan_json=? WHERE workspace_id=?').run(sourcePlan,record.id);
 writeFileSync(path.join(source,'proof'),'pushed source change');
 git('-C',source,'commit','-am','completed source');git('-C',source,'push','origin','HEAD');
 const result=run(['release','--id',record.id,'--json']);
 assert.equal(result.action,'none');assert.equal(existsSync(source),true);
 assert.equal(result.nextAction.kind,'end-retention');
 assert.equal(result.nextAction.planSha256,digest(sourcePlan));
 assert.notEqual(result.nextAction.planSha256,JSON.parse(sourcePlan).growthLifecycle.dispositionSha256);
 assert.deepEqual(result.nextAction.argv,['agent-workspace','release','--id',record.id,'--end-retention','--owner','fixture','--expected-plan-sha256',digest(sourcePlan),'--json']);
 const released=run(result.nextAction.argv.slice(1));
 assert.equal(released.ok,true,JSON.stringify(released));assert.equal(released.action,'released');
 assert.equal(existsSync(source),false);
}));

test('explicit preserve-runtime keeps a runnable handoff and dependencies between consumers and repeated release',()=>fixture(({source,db,record,run,plan})=>{
 const priced=JSON.stringify({...JSON.parse(plan),growthLifecycle:undefined});
 db.prepare('UPDATE workspace_capacity SET plan_json=? WHERE workspace_id=?').run(priced,record.id);
 mkdirSync(path.join(source,'node_modules'));writeFileSync(path.join(source,'node_modules','receipt'),'runtime dependency');
 const result=run(['release','--id',record.id,'--preserve-runtime','--json']);
 assert.equal(result.physicalDisposition.kind,'retained');
 assert.equal(result.futureGrowthSettlement.kind,'retired',JSON.stringify(result));
 assert.equal(readFileSync(path.join(source,'node_modules','receipt'),'utf8'),'runtime dependency');
 assert.equal(readFileSync(path.join(source,'proof'),'utf8'),'durable');
 assert.ok(db.prepare('SELECT 1 FROM workspace_source_retention WHERE workspace_id=?').get(record.id));
 run(['release','--id',record.id,'--json']);
 assert.equal(readFileSync(path.join(source,'node_modules','receipt'),'utf8'),'runtime dependency');
}));
