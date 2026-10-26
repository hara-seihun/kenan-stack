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
import {staleAllocationForecast} from './stale-allocation.mjs';
const G=1024**3,H=3600000,now=10*H;
const plan={intent:'budgeted',estimate:'whole-tree-upper-bound',constructionBytes:G,completedAllocationBytes:G,growthBytes:8*G,headroomBytes:8*G};
const sample={ok:true,bytes:5*G,allocatedBytes:5*G,startedAt:now-20*60000,completedAt:now-20*60000};
const history=[{at:sample.completedAt-H,bytes:sample.bytes},{at:sample.completedAt,bytes:sample.bytes}];
test('stale forecast is age increasing, allowance capped and never credits more than observed consumption after margin',()=>{
 const first=staleAllocationForecast(sample,plan,'active',now,history);
 assert.equal(first.uncertaintyBytes,.5*G);assert.equal(first.creditBytes,4*G-64*1024**2-.5*G);
 const growing=[{...history[0],bytes:sample.bytes-G},history[1]];
 const a=staleAllocationForecast(sample,plan,'active',now,growing),b=staleAllocationForecast(sample,plan,'active',now+H,growing);
 assert.ok(b.uncertaintyBytes>a.uncertaintyBytes);assert.ok(b.creditBytes<a.creditBytes);
 assert.equal(staleAllocationForecast(sample,plan,'active',now+100*H,growing).creditBytes,0);
 assert.ok(a.creditBytes<=a.observedConsumedBytes);assert.equal(a.forecastAllocationBytes,sample.bytes+a.uncertaintyBytes);
});
test('partial, malformed, missing, future and unsafe forecasts never produce credit',()=>{
 for(const changed of [{...sample,partial:true},{...sample,ok:false},{...sample,bytes:NaN},{...sample,allocatedBytes:1},{...sample,completedAt:now+1}])assert.equal(staleAllocationForecast(changed,plan,'active',now,history),null);
 for(const points of [[],null,[history[1],history[0]],[{...history[1],bytes:1}]])assert.equal(staleAllocationForecast(sample,plan,'active',now,points),null);
 assert.equal(staleAllocationForecast(sample,{...plan,completedAllocationBytes:null},'active',now,history),null);
 assert.equal(staleAllocationForecast(sample,plan,'creating',now,history),null);
});
test('positive regrowth after deletion increases uncertainty instead of cancelling growth',()=>{
 const points=[{at:sample.completedAt-H,bytes:5*G},{at:sample.completedAt-H/2,bytes:4*G},{at:sample.completedAt,bytes:5*G}];
 assert.equal(staleAllocationForecast(sample,plan,'active',now,points).hourlyGrowthBytes,G);
});
function fixture(action){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'stale-pricing-')),dir=path.join(root,'source'),state=path.join(root,'registry.sqlite3');let db;
 const prev=process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY;process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY='empty';
 const run=args=>{let out='';const w=process.stdout.write,e=process.exitCode;process.stdout.write=v=>{out+=v;return true;};try{main(args,state);}finally{process.stdout.write=w;process.exitCode=e;}return JSON.parse(out);};
 try{
 fs.mkdirSync(dir);execFileSync('git',['init','-q',dir]);execFileSync('git',['-C',dir,'-c','user.name=F','-c','user.email=f@example.invalid','commit','-q','--allow-empty','-m','init']);
 const head=execFileSync('git',['-C',dir,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
 const row=run(['register','--path',dir,'--root',root,'--owner','fixture','--source-commit',head,'--json']);db=new DatabaseSync(state);
 const device=String(fs.statSync(dir).dev),at=Date.now()-20*60000,planText=JSON.stringify(plan);
 db.prepare('UPDATE workspace SET created_at=? WHERE id=?').run(at-5*60000,row.id);
 db.prepare('INSERT OR REPLACE INTO workspace_capacity VALUES(?,?,?)').run(row.id,device,planText);
 const s={...sample,rootPath:dir,startedAt:at,completedAt:at,device,inode:String(fs.statSync(dir).ino),planSha256:createHash('sha256').update(planText).digest('hex')};
 const cache=value=>db.prepare('INSERT OR REPLACE INTO workspace_capacity_measurement VALUES(?,?)').run(row.id,typeof value==='string'?value:JSON.stringify(value));
 db.prepare('INSERT OR REPLACE INTO workspace_growth_policy VALUES(?,?)').run(row.id,JSON.stringify({version:1,planGrowthBytes:plan.growthBytes,allocationBinding:{rootPath:s.rootPath,planSha256:s.planSha256,device:s.device,inode:s.inode},samples:[{at:at-4*60000,bytes:s.bytes},{at,bytes:s.bytes}]}));
 cache(s);action({root,dir,db,row,device,s,cache,run,projection:()=>workspaceTesting.capacityReservations(db,device)});
 }finally{db?.close();if(prev===undefined)delete process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY;else process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY=prev;fs.rmSync(root,{recursive:true,force:true});}
}
test('a complete bound stale sample retains discounted consumed growth for a new writer without losing refresh candidates',()=>fixture(f=>{
 const before=f.db.prepare('SELECT * FROM workspace WHERE id=?').get(f.row.id),r=f.projection();
 assert.ok(r.priced[0]<8*G);assert.ok(r.priced[0]>=4.5*G);assert.equal(r.headroomBytes,8*G);
 assert.equal(r.measurementFailures[0].code,'allocated-block-cache-stale');
 assert.ok(r.staleAllocationForecasts[0].creditBytes>0);
 assert.deepEqual(f.db.prepare('SELECT * FROM workspace WHERE id=?').get(f.row.id),before);
 assert.equal(workspaceTesting.cachedWorkspaceAllocation(f.db,f.row.id,f.dir,f.device).ok,false,'stale forecast does not satisfy fresh reduction gates');
}));
test('unsafe identity, absent, malformed and partial samples keep full reservation even with detached policy history',()=>fixture(f=>{
 const variants=[null,'{bad',{...f.s,ok:false},{...f.s,partial:true},{...f.s,planSha256:'0'.repeat(64)},{...f.s,rootPath:'elsewhere'},{...f.s,device:'bad'},{...f.s,inode:'bad'},{...f.s,bytes:-1},{...f.s,completedAt:Date.now()+H}];
 for(const value of variants){if(value===null)f.db.prepare('DELETE FROM workspace_capacity_measurement').run();else f.cache(value);assert.deepEqual(f.projection().priced,[8*G],JSON.stringify(value));}
}));
test('actual plan changes and root replacement refuse stale credit; supported fresh measurement rebinds exact plan',()=>fixture(f=>{
 f.db.prepare('UPDATE workspace_capacity SET plan_json=? WHERE workspace_id=?').run(JSON.stringify({...plan,headroomBytes:9*G}),f.row.id);
 assert.deepEqual(f.projection().priced,[8*G]);
 const r=f.run(['measure-capacity','--id',f.row.id,'--json']);assert.equal(r.results[0].ok,true);
 const cached=JSON.parse(f.db.prepare('SELECT measurement_json FROM workspace_capacity_measurement WHERE workspace_id=?').get(f.row.id).measurement_json);
 const text=f.db.prepare('SELECT plan_json FROM workspace_capacity WHERE workspace_id=?').get(f.row.id).plan_json;
 assert.equal(cached.planSha256,createHash('sha256').update(text).digest('hex'));
 fs.renameSync(f.dir,f.dir+'-old');fs.mkdirSync(f.dir);assert.deepEqual(f.projection().priced,[8*G]);
}));
test('known generated cache removal invalidates the stale sample and cannot leave detached growth credit',()=>fixture(f=>{
 fs.writeFileSync(path.join(f.dir,'.gitignore'),'node_modules/\nunclassified-evidence\n');
 fs.writeFileSync(path.join(f.dir,'unclassified-evidence'),'preserved');
 for(const name of ['package.json','package-lock.json'])fs.writeFileSync(path.join(f.dir,name),'{}');
 execFileSync('git',['-C',f.dir,'add','.']);execFileSync('git',['-C',f.dir,'-c','user.name=F','-c','user.email=f@example.invalid','commit','-q','-m','cache contract']);
 fs.mkdirSync(path.join(f.dir,'node_modules'));fs.writeFileSync(path.join(f.dir,'node_modules','fixture'),'regenerable');
 f.db.prepare('UPDATE workspace SET lease_expires_at=0 WHERE id=?').run(f.row.id);
 const head=execFileSync('git',['-C',f.dir,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
 f.db.prepare('UPDATE workspace SET source_commit=? WHERE id=?').run(head,f.row.id);
 const current={...f.row,durableSourceCommit:head,leaseExpiresAt:0};
 const safety={processes:[],threads:[],docker:{containers:[],available:false},systemd:{units:[],available:false},currentStackQueue:{errors:[],references:[],observedAt:Date.now()}};
 const retired=workspaceTesting.reconcileRecord(f.db,current,{execute:true,reapExpired:false,preserveRuntime:true,ignoreLease:true,safety,statePath:path.join(f.root,'registry.sqlite3')});
 assert.ok(retired.removedCaches.includes('node_modules'),JSON.stringify(retired));
 assert.equal(fs.existsSync(path.join(f.dir,'node_modules')),false);
 assert.equal(f.db.prepare('SELECT measurement_json FROM workspace_capacity_measurement WHERE workspace_id=?').get(f.row.id),undefined);
 assert.deepEqual(f.projection().priced,[8*G]);
}));
test('explicit growth restoration and damaged or differently bound rate history keep the original allowance',()=>fixture(f=>{
 const get=()=>JSON.parse(f.db.prepare('SELECT state_json FROM workspace_growth_policy WHERE workspace_id=?').get(f.row.id).state_json);
 const original=get();
 for(const changed of [{...original,restoreAt:Date.now()},{...original,allocationBinding:{...original.allocationBinding,inode:'bad'}},{...original,samples:[]},{...original,samples:[{at:Date.now()+H,bytes:1}]}]){
  f.db.prepare('UPDATE workspace_growth_policy SET state_json=? WHERE workspace_id=?').run(JSON.stringify(changed),f.row.id);
  assert.deepEqual(f.projection().priced,[8*G]);
 }
}));
