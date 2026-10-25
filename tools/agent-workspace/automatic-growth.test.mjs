import './scratch-env.mjs';
import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {execFileSync} from 'node:child_process';import {DatabaseSync} from 'node:sqlite';
import {main,workspaceTesting} from './workspace.mjs';import {recordGrowthSample,restoreGrowthPolicy} from './growth-policy-store.mjs';
const G=1024**3,H=3600000;
function fixture(fn){const root=fs.mkdtempSync(path.join(os.tmpdir(),'auto-growth-')),state=path.join(root,'registry.sqlite3'),dir=path.join(root,'source');let db;
 const prev=process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY;process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY='empty';
 const run=args=>{let text='';const w=process.stdout.write,e=process.exitCode;process.stdout.write=v=>{text+=v;return true;};try{main(args,state);}finally{process.stdout.write=w;process.exitCode=e;}return JSON.parse(text);};
 try{fs.mkdirSync(dir);execFileSync('git',['init','-q',dir]);execFileSync('git',['-C',dir,'-c','user.name=F','-c','user.email=f@example.invalid','commit','-q','--allow-empty','-m','init']);
 const row=run(['register','--path',dir,'--root',root,'--owner','fixture','--json']);db=new DatabaseSync(state);const st=fs.statSync(dir),device=String(st.dev),now=Date.now(),created=now-3*H;
 db.prepare('UPDATE workspace SET created_at=? WHERE id=?').run(created,row.id);
 const baseline=1024*1024,plan={intent:'budgeted',estimate:'whole-tree-upper-bound',constructionBytes:baseline,completedAllocationBytes:baseline,growthBytes:6*G,headroomBytes:8*G};
 db.prepare('INSERT INTO workspace_capacity VALUES(?,?,?)').run(row.id,device,JSON.stringify(plan));
 const sample=(bytes,at=Date.now())=>({ok:true,bytes,allocatedBytes:bytes,device,inode:String(st.ino),startedAt:at,completedAt:at});
 const cache=s=>db.prepare('INSERT OR REPLACE INTO workspace_capacity_measurement VALUES(?,?)').run(row.id,JSON.stringify(s));
 const projection=()=>workspaceTesting.capacityReservations(db,device);
 const rr={...row,created_at:created,state:'active'};fn({root,dir,state,db,row:rr,run,plan,baseline,device,sample,cache,projection});
 }finally{db?.close();if(prev===undefined)delete process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY;else process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY=prev;fs.rmSync(root,{recursive:true,force:true});}}
test('active read-root idle budget shrinks immediately with fresh samples, preserving plan, headroom and lease',()=>fixture(f=>{
 f.cache(f.sample(f.baseline));const before=f.db.prepare('SELECT * FROM workspace WHERE id=?').get(f.row.id);const r=f.projection();assert.deepEqual(r.priced,[.5*G]);assert.equal(r.headroomBytes,8*G);assert.equal(r.growthRepricing[0].reason,'repriced-bootstrap');assert.deepEqual(f.db.prepare('SELECT * FROM workspace WHERE id=?').get(f.row.id),before);assert.deepEqual(JSON.parse(f.db.prepare('SELECT plan_json FROM workspace_capacity WHERE workspace_id=?').get(f.row.id).plan_json),f.plan);
}));
test('sampler journals successful allocated observations and a real burst restores full budget',()=>fixture(f=>{
 const old=f.sample(f.baseline,Date.now()-10000);recordGrowthSample(f.db,f.row,f.plan,old);const next=f.sample(f.baseline+128*1024**2);f.cache(next);recordGrowthSample(f.db,f.row,f.plan,next);
 const r=f.projection();assert.deepEqual(r.priced,[6*G]);assert.equal(r.growthRepricing[0].reason,'fresh-burst');
}));
test('stale, missing and malformed policy samples fail closed; pending creation and execution do not reprice',()=>fixture(f=>{
 assert.deepEqual(f.projection().priced,[6*G]);f.cache(f.sample(f.baseline,Date.now()-16*60000));assert.deepEqual(f.projection().priced,[6*G]);f.cache(f.sample(f.baseline));
 f.db.prepare('INSERT INTO workspace_growth_policy VALUES(?,?)').run(f.row.id,'{bad');assert.deepEqual(f.projection().priced,[6*G]);f.db.prepare('DELETE FROM workspace_growth_policy').run();f.db.prepare("UPDATE workspace SET state='creating' WHERE id=?").run(f.row.id);assert.equal(f.projection().growthRepricing.length,0);
}));
test('ordinary heartbeat retains idle pricing; explicit heartbeat restores original amount even with a smaller request',()=>fixture(f=>{
 f.cache(f.sample(f.baseline));f.run(['heartbeat','--id',f.row.id,'--json']);assert.deepEqual(f.projection().priced,[.5*G]);
 f.run(['heartbeat','--id',f.row.id,'--growth-mib','512','--json']);assert.deepEqual(f.projection().priced,[6*G]);assert.equal(f.projection().growthRepricing[0].reason,'explicit-restore');
}));
test('unaffordable explicit growth request leaves reservation, lease and policy unchanged',()=>fixture(f=>{
 f.cache(f.sample(f.baseline));const before=f.db.prepare('SELECT * FROM workspace WHERE id=?').get(f.row.id),plan=f.db.prepare('SELECT plan_json FROM workspace_capacity WHERE workspace_id=?').get(f.row.id).plan_json;
 assert.throws(()=>f.run(['heartbeat','--id',f.row.id,'--growth-mib',String(1024**3),'--json']),{code:'workspace-capacity-refused'});
 assert.deepEqual(f.db.prepare('SELECT * FROM workspace WHERE id=?').get(f.row.id),before);assert.equal(f.db.prepare('SELECT plan_json FROM workspace_capacity WHERE workspace_id=?').get(f.row.id).plan_json,plan);assert.equal(f.db.prepare('SELECT count(*) n FROM workspace_growth_policy').get().n,0);
}));
test('supported sampler changes only samples and observation journal, never source plan',()=>fixture(f=>{
 const before=f.db.prepare('SELECT plan_json FROM workspace_capacity WHERE workspace_id=?').get(f.row.id).plan_json;
 const r=f.run(['measure-capacity','--id',f.row.id,'--json']);assert.equal(r.results[0].ok,true);assert.equal(f.db.prepare('SELECT count(*) n FROM workspace_growth_policy').get().n,1);assert.equal(f.db.prepare('SELECT plan_json FROM workspace_capacity WHERE workspace_id=?').get(f.row.id).plan_json,before);
}));
test('existing registry upgrades its policy table automatically and read-only capacity status reports exact projection',()=>fixture(f=>{
 f.cache(f.sample(f.baseline));f.db.exec('DROP TABLE workspace_growth_policy');const r=f.run(['capacity-status','--root',f.root,'--json']);assert.equal(r.kind,'capacity-status');assert.equal(r.effectiveReservedBytes,.5*G);assert.equal(r.headroomBytes,8*G);assert.equal(f.db.prepare('SELECT count(*) n FROM workspace_growth_policy').get().n,0);
}));
test('explicit growth heartbeat can request a larger original amount through ordinary admission',()=>fixture(f=>{
 f.cache(f.sample(f.baseline));f.run(['heartbeat','--id',f.row.id,'--growth-mib','8192','--json']);assert.equal(JSON.parse(f.db.prepare('SELECT plan_json FROM workspace_capacity WHERE workspace_id=?').get(f.row.id).plan_json).growthBytes,8*G);assert.deepEqual(f.projection().priced,[8*G]);
}));
