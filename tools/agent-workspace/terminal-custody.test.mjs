import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {execFileSync,spawnSync} from 'node:child_process';import {DatabaseSync} from 'node:sqlite';import {digest} from './growth-lifecycle.mjs';
const cli=new URL('./workspace.mjs',import.meta.url).pathname;
test('native CLI real Git SQLite terminal headroom and retained registration preserve dirty/ignored bytes and reject stale remote, owner, source and writer',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'terminal-native-')),source=path.join(root,'source'),remote=path.join(root,'remote.git'),state=path.join(root,'registry.sqlite3');
 const git=(...a)=>execFileSync('git',a,{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
 const run=(args,ok=true)=>{const r=spawnSync(process.execPath,[cli,...args,'--json'],{encoding:'utf8',timeout:30000,env:{...process.env,PI_WORKSPACE_STATE:state,PI_WORKSPACE_TEST_EXTERNAL_SAFETY:''}});if(ok)assert.equal(r.status,0,r.stdout+r.stderr);else assert.notEqual(r.status,0);return JSON.parse(r.stdout);};
 const disposition=(kind,b)=>({kind,binding:b,retainedUse:'source',growthWriters:'none',futureWrites:'none',remainingGrowthBytes:0,writingLease:'retire',sourceCustody:'remote-verified',sourceEvidence:'fresh actual remote fixture',headroomBytes:8*1024**3,ownerEvidence:'terminal owner fixture',reason:'terminal',observedAt:Date.now()});
 const effect=(cmd,r,d,ok=true)=>{const file=path.join(root,'disposition.json'),bytes=JSON.stringify(d);fs.writeFileSync(file,bytes);return run([cmd,'--id',r.id,'--path',r.path,'--owner','owner','--disposition',file,'--disposition-sha256',digest(bytes)],ok);};
 try {
 fs.mkdirSync(source);git('init','-b','main',source);git('-C',source,'config','user.email','fixture@example.invalid');git('-C',source,'config','user.name','fixture');fs.writeFileSync(path.join(source,'tracked'),'original');fs.writeFileSync(path.join(source,'.gitignore'),'ignored\n');git('-C',source,'add','.');git('-C',source,'commit','-m','fixture');git('init','--bare',remote);git('-C',source,'remote','add','origin',remote);git('-C',source,'push','origin','main');
 const head=git('-C',source,'rev-parse','HEAD');const r=run(['register','--path',source,'--owner','owner','--source-commit',head]);
 fs.writeFileSync(path.join(source,'tracked'),'dirty preserved');fs.writeFileSync(path.join(source,'ignored'),'generated preserved');
 const db=new DatabaseSync(state),st=fs.statSync(source),device=String(st.dev);const plan={intent:'budgeted',constructionBytes:4096,growthBytes:1024,headroomBytes:20*1024**3,completedAllocationBytes:4096};db.prepare('INSERT INTO workspace_capacity VALUES(?,?,?)').run(r.id,device,JSON.stringify(plan));const sample={ok:true,bytes:4096,allocatedBytes:4096,device,inode:String(st.ino),startedAt:Date.now(),completedAt:Date.now()};db.prepare('INSERT INTO workspace_capacity_measurement VALUES(?,?)').run(r.id,JSON.stringify(sample));
 let b=run(['growth-status','--id',r.id,'--path',source]).binding;effect('retire-growth',r,disposition('retire-future-growth',b));b=run(['growth-status','--id',r.id,'--path',source]).binding;
 let d=disposition('reduce-retained-headroom',b);effect('reduce-retained-headroom',r,{...d,binding:{...b,owner:'wrong'}},false);
 git('--git-dir',remote,'update-ref','-d','refs/heads/main');const refused=effect('reduce-retained-headroom',r,d,false);assert.equal(refused.error.code,'retained-source-unpublished');assert.equal(db.prepare('SELECT count(*) n FROM sqlite_master WHERE name=\'workspace_retained_headroom_repricing\'').get().n,0);git('-C',source,'push','origin','main');

 // Regression: actual original production topology has 12,585 remote heads. One batch, never one subprocess per ref.
 execFileSync('git',['--git-dir',remote,'update-ref','--stdin'],{input:Array.from({length:12585},(_,i)=>`create refs/heads/fixture-${i} ${head}`).join('\n')+'\n',stdio:['pipe','ignore','pipe']});
 const borrow=path.join(root,'retained-borrower');git('-C',source,'worktree','add','--detach',borrow,head);
 b=run(['growth-status','--id',r.id,'--path',source]).binding;d=disposition('reduce-retained-headroom',b);
 assert.equal(effect('reduce-retained-headroom',r,d,false).error.code,'growth-writer-unknown');
 const br=run(['register','--retained','--path',borrow,'--owner','owner','--source-commit',head]);
 b=run(['growth-status','--id',r.id,'--path',source]).binding;d=disposition('reduce-retained-headroom',b);
 // A future lease introduced concurrently must be detected; the failed CAS leaves no journal or repricing.
 db.prepare('UPDATE workspace SET lease_expires_at=? WHERE id=?').run(Date.now()+60000,br.id);
 assert.equal(effect('reduce-retained-headroom',r,d,false).error.code,'retained-headroom-borrower');
 db.prepare('UPDATE workspace SET lease_expires_at=0 WHERE id=?').run(br.id);
 b=run(['growth-status','--id',r.id,'--path',source]).binding;d=disposition('reduce-retained-headroom',b);
 const result=effect('reduce-retained-headroom',r,d);assert.equal(result.safety.borrowerCustody.length,1);
assert.equal(result.kind,'reduced-retained-headroom');assert.equal(result.newWritesAuthorized,false);assert.deepEqual(result.safety.nativeObservations.map(o=>o.channel),['beta','production']);assert.equal(db.prepare('SELECT count(*) n FROM workspace_retained_headroom_repricing').get().n,1);assert.equal(JSON.parse(db.prepare('SELECT plan_json FROM workspace_capacity WHERE workspace_id=?').get(r.id).plan_json).headroomBytes,8*1024**3);
 run(['heartbeat','--id',r.id],false);assert.equal(fs.readFileSync(path.join(source,'tracked'),'utf8'),'dirty preserved');assert.equal(fs.readFileSync(path.join(source,'ignored'),'utf8'),'generated preserved');
 const child=path.join(root,'borrower');git('-C',source,'worktree','add','--detach',child,head);const c=run(['register','--retained','--path',child,'--owner','owner','--source-commit',head]);assert.equal(c.leaseExpiresAt,0);assert.equal(c.state,'referenced');run(['heartbeat','--id',c.id],false);assert.equal(git('-C',child,'rev-parse','HEAD'),head);
 // Existing null-capacity accidental registration is surrendered through exact binding, not deletion.
 const other=path.join(root,'other');git('clone',remote,other);git('-C',other,'checkout','main');const o=run(['register','--path',other,'--owner','owner','--source-commit',head]);const ob=run(['custody-status','--id',o.id,'--path',other]).binding;effect('end-writing',o,disposition('retire-future-growth',ob));run(['heartbeat','--id',o.id],false);assert.equal(run(['status','--id',o.id]).records[0].leaseExpiresAt,0);db.close();
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
