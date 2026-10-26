import './scratch-env.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync,spawn} from 'node:child_process';
import {once} from 'node:events';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {ownerFutureWrites,capacityOwnerProjection,observeCapacityChildren,OWNER_IDLE_FORECAST_MS} from './capacity-owner-forecast.mjs';
import {main,workspaceTesting} from './workspace.mjs';
import {bindNativeOwner} from './native-owner.mjs';
import {classifyOwner} from './owner-liveness.mjs';
const OWNER='11111111-2222-4333-8444-555555555555',G=1024**3,H=OWNER_IDLE_FORECAST_MS;
const observation=(state='stopped',extra={})=>({errors:[],owners:[OWNER],agents:[{id:OWNER,channel:'beta',state,archived:false,updatedAt:Date.now()-2*H,...extra}],wakes:[]});
const quiet={complete:true,references:[],errors:[]};
const row={path:'/fixture/checkout',state:'active'};

test('stopped, archived and idle native owners have no future intent; active and ambiguous identities retain it',()=>{
 for(const value of [observation(),observation('running',{archived:true}),observation('idle')])assert.equal(ownerFutureWrites(OWNER,value).kind,'inactive');
 for(const value of [observation('running'),observation('idle',{updatedAt:Date.now()}),observation('idle',{updatedAt:null}),observation('idle',{updatedAt:Date.now()+H})])assert.equal(ownerFutureWrites(OWNER,value).kind,'live');
 assert.equal(ownerFutureWrites(OWNER,observation('idle',{updatedAt:100}),100+H).kind,'live','exactly one hour is not over one hour');
 assert.equal(ownerFutureWrites(OWNER,observation('idle',{updatedAt:100}),101+H).kind,'inactive');
 assert.equal(ownerFutureWrites('task-label',observation()).kind,'unknown');
 assert.equal(ownerFutureWrites(OWNER,{...observation(),agents:[]}).kind,'unknown');
 assert.equal(ownerFutureWrites(OWNER,{...observation(),errors:['database denied']}).kind,'unknown');
 const mixed=observation();mixed.agents.push({...mixed.agents[0],channel:'production',state:'running'});
 assert.equal(ownerFutureWrites(OWNER,mixed).kind,'live');
});

test('a future wake is not a current writer; capacity never changes deletion authority',()=>{
 const value=observation();value.wakes.push({agentId:OWNER,id:'wake',text:'later'});
 assert.equal(ownerFutureWrites(OWNER,value).kind,'inactive');
 assert.equal(classifyOwner(OWNER,value).kind,'live','strict release classification still protects the future wake');
 assert.deepEqual(capacityOwnerProjection(row,OWNER,value,quiet),{zero:true,code:'native-owner-ended'});
 assert.equal(capacityOwnerProjection({...row,state:'creating'},OWNER,value,quiet).zero,false);
 for(const child of [{path:row.path,kind:'process'},{path:row.path+'/output',kind:'native-tool'}])
  assert.deepEqual(capacityOwnerProjection(row,OWNER,value,{...quiet,references:[child]}),{zero:false,code:'active-child'});
 assert.equal(capacityOwnerProjection(row,OWNER,value,{complete:false,references:[]}).zero,false);
 assert.equal(capacityOwnerProjection(row,OWNER,value,{...quiet,references:[{path:row.path+'-sibling'}]}).zero,true);
});

function fixture(action){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'capacity-owner-')),dir=path.join(root,'source'),state=path.join(root,'registry.sqlite3');let db;
 const prior=process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY;process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY='empty';
 const run=args=>{let out='';const write=process.stdout.write,exit=process.exitCode;process.stdout.write=v=>{out+=v;return true;};try{main(args,state);}finally{process.stdout.write=write;process.exitCode=exit;}return JSON.parse(out);};
 try{
  fs.mkdirSync(dir);execFileSync('git',['init','-q',dir]);execFileSync('git',['-C',dir,'-c','user.name=Fixture','-c','user.email=f@example.invalid','commit','-q','--allow-empty','-m','initial']);
  fs.writeFileSync(path.join(dir,'valuable-uncommitted-source'),'preserve this source');
  const record=run(['register','--path',dir,'--root',root,'--owner','free-label','--json']);db=new DatabaseSync(state);
  const st=fs.statSync(dir),device=String(st.dev),at=Date.now()-2*H;
  db.prepare('UPDATE workspace SET created_at=? WHERE id=?').run(at-H,record.id);
  const plan={intent:'budgeted',estimate:'whole-tree-upper-bound',constructionBytes:1024**2,completedAllocationBytes:1024**2,growthBytes:6*G,headroomBytes:8*G};
  db.prepare('INSERT OR REPLACE INTO workspace_capacity VALUES(?,?,?)').run(record.id,device,JSON.stringify(plan));
  const sample={ok:true,rootPath:dir,planSha256:createHash('sha256').update(JSON.stringify(plan)).digest('hex'),bytes:1024**2,allocatedBytes:1024**2,device,inode:String(st.ino),startedAt:at,completedAt:at};
  db.prepare('INSERT OR REPLACE INTO workspace_capacity_measurement VALUES(?,?)').run(record.id,JSON.stringify(sample));
  bindNativeOwner(db,record.id,{agentId:OWNER,channel:'beta',callId:'fixture-call'},'caller-scope',{});
  const projection=(owners,children=quiet)=>workspaceTesting.capacityReservations(db,device,undefined,undefined,{owners,children});
  action({root,dir,db,record,device,plan,sample,projection,run});
 }finally{db?.close();if(prior===undefined)delete process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY;else process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY=prior;fs.rmSync(root,{recursive:true,force:true});}
}

for(const [name,owners] of [['stopped',observation()],['dead archived',observation('running',{archived:true})],['idle over one hour',observation('idle')]])
 test(name+' native owner projects zero stale reservation without changing samples, source, physical free space or headroom',()=>fixture(f=>{
  const before=f.db.prepare('SELECT * FROM workspace WHERE id=?').get(f.record.id),sample=f.db.prepare('SELECT measurement_json FROM workspace_capacity_measurement WHERE workspace_id=?').get(f.record.id).measurement_json;
  const output=f.projection(owners);assert.deepEqual(output.priced,[]);assert.equal(output.headroomBytes,8*G);assert.equal(output.growthRepricing[0].effectiveRemainingBytes,0);
  assert.deepEqual(f.db.prepare('SELECT * FROM workspace WHERE id=?').get(f.record.id),before);
  assert.equal(f.db.prepare('SELECT measurement_json FROM workspace_capacity_measurement WHERE workspace_id=?').get(f.record.id).measurement_json,sample);
  assert.deepEqual(JSON.parse(f.db.prepare('SELECT plan_json FROM workspace_capacity WHERE workspace_id=?').get(f.record.id).plan_json),f.plan);
  assert.equal(fs.readFileSync(path.join(f.dir,'valuable-uncommitted-source'),'utf8'),'preserve this source');
  assert.equal(workspaceTesting.cachedWorkspaceAllocation(f.db,f.record.id,f.dir,f.device).ok,false,'stale allocation remains stale, not physical credit');
 }));

test('a heartbeat cannot revive liability for a stopped native writer, but an actual active writer does',()=>fixture(f=>{
 const native=path.join(f.root,'native.json'),prior=process.env.PI_WORKSPACE_TEST_OWNER_LIVENESS;
 process.env.PI_WORKSPACE_TEST_OWNER_LIVENESS=native;fs.writeFileSync(native,JSON.stringify(observation()));
 try{
  f.run(['heartbeat','--id',f.record.id,'--json']);assert.deepEqual(f.projection(observation()).priced,[]);
  f.run(['heartbeat','--id',f.record.id,'--growth-mib','512','--json']);assert.deepEqual(f.projection(observation()).priced,[]);
  assert.deepEqual(f.projection(observation('running')).priced,[6*G]);
 }finally{if(prior===undefined)delete process.env.PI_WORKSPACE_TEST_OWNER_LIVENESS;else process.env.PI_WORKSPACE_TEST_OWNER_LIVENESS=prior;}
}));

test('live children, unknown and nonnative owners retain liability, and pending construction remains fully funded',()=>fixture(f=>{
 assert.deepEqual(f.projection(observation(),{...quiet,references:[{path:f.dir,kind:'native-tool'}]}).priced,[6*G]);
 assert.deepEqual(f.projection(observation(),{complete:false,references:[]}).priced,[6*G]);
 assert.deepEqual(f.projection({...observation(),agents:[]}).priced,[6*G]);
 assert.deepEqual(f.projection(observation('running')).priced,[6*G]);
 f.db.prepare('DELETE FROM workspace_native_owner WHERE workspace_id=?').run(f.record.id);
 assert.deepEqual(f.projection(observation()).priced,[6*G]);
 f.db.prepare('UPDATE workspace SET owner=?,state=? WHERE id=?').run(OWNER,'creating',f.record.id);
 assert.deepEqual(f.projection(observation()).priced,[6*G+1024**2]);
}));

test('missing or malformed native owner fixtures are unavailable observations, not admission exceptions or zero liability',()=>fixture(f=>{
 const prior=process.env.PI_WORKSPACE_TEST_OWNER_LIVENESS,native=path.join(f.root,'missing-native.json');
 process.env.PI_WORKSPACE_TEST_OWNER_LIVENESS=native;
 try{
  const project=()=>workspaceTesting.capacityReservations(f.db,f.device);
  assert.deepEqual(project().priced,[6*G]);
  fs.writeFileSync(native,'{bad json');assert.deepEqual(project().priced,[6*G]);
 }finally{if(prior===undefined)delete process.env.PI_WORKSPACE_TEST_OWNER_LIVENESS;else process.env.PI_WORKSPACE_TEST_OWNER_LIVENESS=prior;}
}));

test('a failed child observer cannot zero an ended owner, and native tools protect only their exact roots',()=>{
 const failed=observeCapacityChildren([row.path],{deadline:Date.now()+1000,writers:()=>{throw new Error('EACCES');}});
 assert.equal(failed.complete,false);assert.equal(capacityOwnerProjection(row,OWNER,observation(),failed).zero,false);
 const seen=observeCapacityChildren([row.path,row.path+'-other'],{deadline:Date.now()+1000,writers:()=>({complete:true,errors:[],references:[]}),
  queue:()=>({errors:[],references:[{id:'child',roots:[row.path,row.path+'-other'],matchedRoots:[row.path]}]})});
 assert.equal(capacityOwnerProjection(row,OWNER,observation(),seen).zero,false);
 assert.equal(capacityOwnerProjection({...row,path:row.path+'-other'},OWNER,observation(),seen).zero,true);
});

test('a real running shell child in the checkout remains charged even after its native parent stops',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'capacity-child-'));
 const child=spawn(process.execPath,['-e',"process.stdout.write('ready\\n');setInterval(()=>{},10000)"],{cwd:dir,stdio:['ignore','pipe','pipe']});
 try{
  await once(child.stdout,'data');
  const seen=observeCapacityChildren([dir],{deadline:Date.now()+5000,queue:()=>({errors:[],references:[]})});
  assert.equal(seen.complete,true,JSON.stringify(seen.errors));assert.ok(seen.references.some(ref=>ref.pid===child.pid));
  assert.equal(capacityOwnerProjection({path:dir,state:'active'},OWNER,observation(),seen).zero,false);
 }finally{child.kill();await once(child,'exit');fs.rmSync(dir,{recursive:true,force:true});}
});
