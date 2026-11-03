import './scratch-env.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync,spawn,spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {fileURLToPath} from 'node:url';
const tool=fileURLToPath(new URL('./main',import.meta.url));
async function heldLock(root,key,durationMs=6000) {
 const locks=path.join(root,'locks');fs.mkdirSync(locks,{recursive:true});
 const lock=path.join(locks,createHash('sha256').update(key).digest('hex'));
 const p=spawn('flock',['--exclusive',lock,process.execPath,'-e',`console.log('locked');setTimeout(()=>{},${durationMs})`],{stdio:['ignore','pipe','pipe']});
 await new Promise((resolve,reject)=>{p.stdout.once('data',resolve);p.once('error',reject);});
 return ()=>{p.kill('SIGTERM');};
}
for(const same of [false,true])test(same?'same-checkout contention is bounded by sampler deadline, no stale credit':'independent sampler ignores old pool-wide lock, no30s wait',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'measure-isolation-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const source=path.join(root,'source');fs.mkdirSync(source);execFileSync('git',['init',source],{stdio:'ignore'});execFileSync('git',['-C',source,'-c','user.name=Fixture','-c','user.email=fixture@invalid','commit','--allow-empty','-m','fixture'],{stdio:'ignore'});
 const state=path.join(root,'registry.sqlite3'),env={...process.env,PI_WORKSPACE_STATE:state};
 const register=spawnSync(tool,['register','--path',source,'--owner','fixture','--json'],{encoding:'utf8',env,timeout:3000});assert.equal(register.status,0,register.stderr);const r=JSON.parse(register.stdout);
 const db=new DatabaseSync(state);db.prepare('INSERT OR REPLACE INTO workspace_capacity(workspace_id,device_id,plan_json) VALUES(?,?,?)').run(r.id,String(fs.statSync(source).dev),JSON.stringify({intent:'budgeted',growthBytes:1024,headroomBytes:8*1024**3}));db.close();
 const release=await heldLock(root,same?'checkout:'+source:'capacity-measurement');t.after(release);
 const start=Date.now();const sample=spawnSync(tool,['measure-capacity','--id',r.id,'--budget-ms','1500','--json'],{env,timeout:3000,encoding:'utf8'});assert.equal(sample.status,0,sample.stderr);assert.ok(Date.now()-start<2600);
 const output=JSON.parse(sample.stdout).results;assert.equal(output[0].status,same?'error':'measured');
 if(same){assert.equal(output[0].ok,false);assert.match(output[0].error,/resource busy/);}
});

test('capacity-lock deadline after a complete walk advances neither successful cache nor growth history',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'measure-atomic-deadline-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const source=path.join(root,'source');fs.mkdirSync(source);execFileSync('git',['init','-q',source]);execFileSync('git',['-C',source,'-c','user.name=F','-c','user.email=f@example.invalid','commit','-q','--allow-empty','-m','fixture']);
 const state=path.join(root,'registry.sqlite3'),env={...process.env,PI_WORKSPACE_STATE:state,PI_WORKSPACE_TEST_EXTERNAL_SAFETY:'empty'};
 const run=args=>spawnSync(tool,args,{env,encoding:'utf8',timeout:5000});
 const reg=run(['register','--path',source,'--owner','fixture','--intent','source-only','--headroom-gib','8','--growth-mib','512','--json']);assert.equal(reg.status,0,reg.stderr);const row=JSON.parse(reg.stdout);
 assert.equal(run(['measure-capacity','--id',row.id,'--budget-ms','2000','--json']).status,0);
 const db=new DatabaseSync(state);t.after(()=>db.close());
 const prior=db.prepare('SELECT measurement_json FROM workspace_capacity_measurement WHERE workspace_id=?').get(row.id).measurement_json;
 const history=db.prepare('SELECT state_json FROM workspace_growth_policy WHERE workspace_id=?').get(row.id).state_json;
 const release=await heldLock(root,`capacity:${fs.statSync(source).dev}`);t.after(release);
 const measured=run(['measure-capacity','--id',row.id,'--budget-ms','1500','--json']);assert.equal(measured.status,0,measured.stderr);
 assert.equal(JSON.parse(measured.stdout).results[0].status,'error');
 assert.equal(db.prepare('SELECT measurement_json FROM workspace_capacity_measurement WHERE workspace_id=?').get(row.id).measurement_json,prior);
 assert.equal(db.prepare('SELECT state_json FROM workspace_growth_policy WHERE workspace_id=?').get(row.id).state_json,history);
});

for (const exhausted of [false,true]) test(`ordinary repricing ${exhausted?'refuses at its deadline without mutation':'waits through brief capacity contention'}`,async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'reprice-lock-budget-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const source=path.join(root,'source');fs.mkdirSync(source);
 const git=(...args)=>execFileSync('git',['-C',source,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
 git('init','-q');git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-q','--allow-empty','-m','fixture');
 const head=git('rev-parse','HEAD'),state=path.join(root,'registry.sqlite3');
 const env={...process.env,PI_WORKSPACE_STATE:state,PI_WORKSPACE_TEST_EXTERNAL_SAFETY:'empty'};
 const run=args=>spawnSync(tool,args,{env,encoding:'utf8',timeout:6000});
 const registered=run(['register','--path',source,'--owner','fixture','--source-commit',head,'--intent','source-only','--headroom-gib','8','--growth-mib','512','--json']);assert.equal(registered.status,0,registered.stderr);
 const row=JSON.parse(registered.stdout),db=new DatabaseSync(state);t.after(()=>db.close());
 const before=db.prepare('SELECT plan_json FROM workspace_capacity WHERE workspace_id=?').get(row.id).plan_json;
 const release=await heldLock(root,`capacity:${fs.statSync(source).dev}`,exhausted?6000:800);t.after(release);
 const start=Date.now(),result=run(['reprice-capacity','--id',row.id,'--intent','budgeted','--headroom-gib','8','--growth-mib','2048','--budget-ms',exhausted?'1000':'4000','--json']),elapsed=Date.now()-start;
 if(exhausted){
  assert.equal(result.status,75,result.stderr);assert.match(result.stderr,/workspace resource busy: capacity:/);assert.ok(elapsed<2500);
  assert.equal(db.prepare('SELECT plan_json FROM workspace_capacity WHERE workspace_id=?').get(row.id).plan_json,before);
  assert.equal(db.prepare('SELECT count(*) n FROM workspace_capacity_repricing WHERE workspace_id=?').get(row.id).n,0);
 }else{
  assert.equal(result.status,0,result.stderr);assert.ok(elapsed>=400&&elapsed<4500,`elapsed ${elapsed}`);
  const capacity=JSON.parse(result.stdout).capacity;assert.equal(capacity.intent,'budgeted');assert.equal(capacity.repricing.remainingGrowthBytes,2048*1024**2);
  assert.equal(db.prepare('SELECT count(*) n FROM workspace_capacity_repricing WHERE workspace_id=?').get(row.id).n,1);
 }
});
