import './scratch-env.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {admitWithRefresh} from './admission-refresh.mjs';
import {main} from './workspace.mjs';
const refusal=()=>Object.assign(new Error('real refusal'),{code:'workspace-capacity-refused'});
test('refreshes only typed pre-effect refusals outside admission and commits once',()=>{
 let held=false,valid=false,writes=0,decisions=0;
 const result=admitWithRefresh({decide:()=>{held=true;try{decisions++;if(!valid)throw refusal();writes++;return 'admitted';}finally{held=false;}},
 candidates:()=>[{path:'/stale'}],refresh:()=>{assert.equal(held,false);valid=true;return {kind:'measured'};}});
 assert.equal(result,'admitted');assert.equal(writes,1);assert.equal(decisions,2);
});
test('stops immediately when the deciding reservations fit and never touches unrelated rows',()=>{
 let refreshed=0,decisions=0;
 admitWithRefresh({decide:()=>{if(decisions++===0)throw refusal();return true;},candidates:()=>[{path:'/one'},{path:'/two'}],refresh:()=>{refreshed++;return {kind:'measured'};}});
 assert.equal(refreshed,1);
});
test('failed refresh preserves the actual refusal and a finite deadline',()=>{
 let now=0,refreshed=0;
 assert.throws(()=>admitWithRefresh({now:()=>now,budgetMs:5,decide:()=>{throw refusal();},candidates:()=>[{path:'/one'},{path:'/two'}],refresh:()=>{refreshed++;now=6;throw Error('unreadable');}}),e=>e.code==='workspace-capacity-refused'&&e.capacityRefresh.observations[0].kind==='failed');
 assert.equal(refreshed,1);
});
test('post-admission or unrelated failures are never replayed',()=>{
 let refresh=0;assert.throws(()=>admitWithRefresh({decide:()=>{throw Error('commit failed');},candidates:()=>[],refresh:()=>refresh++}),/commit failed/);assert.equal(refresh,0);
});
test('native registration refreshes the exact stale reservation before a genuine capacity refusal, without lease or source changes',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'admission-refresh-')),state=path.join(root,'registry.sqlite3');let db;
 const prev=process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY;process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY='empty';
 const run=args=>{let text='';const write=process.stdout.write,err=process.stderr.write,exit=process.exitCode;process.stdout.write=v=>{text+=v;return true;};process.stderr.write=()=>true;try{main(args,state);return JSON.parse(text);}finally{process.stdout.write=write;process.stderr.write=err;process.exitCode=exit;}};
 const source=name=>{const dir=path.join(root,name);fs.mkdirSync(dir);execFileSync('git',['init','-q',dir]);execFileSync('git',['-C',dir,'-c','user.name=Fixture','-c','user.email=f@example.invalid','commit','-q','--allow-empty','-m','fixture']);return dir;};
 try{
  const old=source('old'),incoming=source('incoming'),registered=run(['register','--path',old,'--owner','fixture','--intent','budgeted','--growth-mib','6144','--headroom-gib','8','--json']);
  db=new DatabaseSync(state);db.prepare('UPDATE workspace SET created_at=? WHERE id=?').run(Date.now()-3*3600000,registered.id);
  db.prepare('DELETE FROM workspace_capacity_measurement WHERE workspace_id=?').run(registered.id);
  db.prepare('DELETE FROM workspace_growth_policy WHERE workspace_id=?').run(registered.id);
  const row=db.prepare('SELECT * FROM workspace WHERE id=?').get(registered.id),plan=db.prepare('SELECT plan_json FROM workspace_capacity WHERE workspace_id=?').get(registered.id).plan_json;
  const stat=fs.statfsSync(root),growth=Math.floor((stat.bavail*stat.bsize-9*1024**3)/1024**2);
  const next=run(['register','--path',incoming,'--owner','incoming','--intent','budgeted','--growth-mib',String(growth),'--headroom-gib','8','--json']);
  assert.equal(next.state,'active');assert.equal(JSON.parse(db.prepare('SELECT measurement_json FROM workspace_capacity_measurement WHERE workspace_id=?').get(registered.id).measurement_json).ok,true);
  assert.deepEqual(db.prepare('SELECT * FROM workspace WHERE id=?').get(registered.id),row);assert.equal(db.prepare('SELECT plan_json FROM workspace_capacity WHERE workspace_id=?').get(registered.id).plan_json,plan);
 }finally{db?.close();if(prev===undefined)delete process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY;else process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY=prev;fs.rmSync(root,{recursive:true,force:true});}
});
