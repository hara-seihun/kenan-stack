import './scratch-env.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {main,workspaceTesting} from './workspace.mjs';

const G=1024**3;
function fixture(action){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'sampler-priority-')),state=path.join(root,'registry.sqlite3');
 const previous=process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY;process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY='empty';let db;
 const run=args=>{let out='';const write=process.stdout.write,exit=process.exitCode;process.stdout.write=x=>{out+=x;return true;};try{main(args,state);}finally{process.stdout.write=write;process.exitCode=exit;}return JSON.parse(out);};
 try{
  const rows={};
  for(const name of ['retired','zero','small','large','current']){
   const source=path.join(root,'pool',name);fs.mkdirSync(source,{recursive:true});
   execFileSync('git',['init','-q',source]);execFileSync('git',['-C',source,'-c','user.name=F','-c','user.email=f@example.invalid','commit','-q','--allow-empty','-m','init']);
   rows[name]=run(['register','--path',source,'--root',path.join(root,'pool'),'--owner','fixture-'+name,'--json']);
  }
  db=new DatabaseSync(state);
  const device=String(fs.statSync(path.join(root,'pool')).dev);
  const plan=(growthBytes,extra={})=>JSON.stringify({intent:'budgeted',estimate:'whole-tree-upper-bound',constructionBytes:0,growthBytes,headroomBytes:G,...extra});
  const put=(name,text)=>db.prepare('INSERT OR REPLACE INTO workspace_capacity(workspace_id,device_id,plan_json) VALUES(?,?,?)').run(rows[name].id,device,text);
  put('retired',plan(8*G,{growthLifecycle:{kind:'retired-future-growth',remainingGrowthBytes:0,retainedUse:'source',dispositionSha256:'a'.repeat(64),retiredAt:1}}));
  put('zero',plan(0));put('small',plan(1*G));put('large',plan(4*G));put('current',plan(2*G));
  action({root,state,rows,db,device,run});
 }finally{db?.close();if(previous===undefined)delete process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY;else process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY=previous;fs.rmSync(root,{recursive:true,force:true});}
}

test('sampler skips rows the ledger never measures and refreshes the largest full charges first',()=>fixture(f=>{
 f.run(['measure-capacity','--id',f.rows.current.id,'--json']);
 const pass=f.run(['measure-capacity','--root',path.join(f.root,'pool'),'--json']);
 assert.equal(pass.kind,'capacity-measurement');
 assert.deepEqual(pass.progress.skipped,{'retired-future-growth':1,'zero-liability':1});
 assert.deepEqual(pass.results.map(r=>path.basename(r.path)),['large','small','current']);
 assert.deepEqual(pass.results.map(r=>r.previousCache),['allocated-block-cache-missing','allocated-block-cache-missing','current']);
 assert.equal(pass.progress.fullyChargedBytesBefore,5*G);
 assert.equal(pass.progress.fullyChargedBytesAfter,0);
 assert.equal(pass.progress.measured,3);
}));

test('a targeted request measures even a retired row',()=>fixture(f=>{
 const pass=f.run(['measure-capacity','--id',f.rows.retired.id,'--json']);
 assert.equal(pass.results.length,1);assert.equal(pass.results[0].status,'measured');
}));

test('stale and future-dated samples carry separate codes',()=>fixture(f=>{
 f.run(['measure-capacity','--id',f.rows.large.id,'--json']);
 const sample=JSON.parse(f.db.prepare('SELECT measurement_json FROM workspace_capacity_measurement WHERE workspace_id=?').get(f.rows.large.id).measurement_json);
 const at=(now)=>workspaceTesting.cachedWorkspaceAllocation(f.db,f.rows.large.id,f.rows.large.path,f.device,now);
 assert.equal(at(sample.completedAt+1000).ok,true);
 assert.equal(at(sample.startedAt+16*60_000).code,'allocated-block-cache-stale');
 assert.equal(at(sample.completedAt-1).code,'allocated-block-cache-future-dated');
 const reservations=workspaceTesting.capacityReservations(f.db,f.device,undefined);
 assert.deepEqual(reservations.measurementFailures.map(failure=>[path.basename(failure.path),failure.code]).sort(),
  [['current','allocated-block-cache-missing'],['small','allocated-block-cache-missing']]);
}));
