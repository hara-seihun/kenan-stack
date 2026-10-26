import './scratch-env.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {selectedArguments,selectorSyntax} from './cli-contract.mjs';
import {main,workspaceTesting} from './workspace.mjs';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import path from 'node:path';
for(const command of ['heartbeat','release','cancel-creation','finalize-creation','measure-capacity','reconcile','maintain'])test(command+' identifies mutually exclusive selectors without effects',()=>{
 const x=selectedArguments(command,{id:'identity',path:'/fixture'});assert.equal(x.ok,false);assert.equal(x.error.code,'invalid-workspace-selector');
 assert.match(x.error.detail,new RegExp('^'+command+' accepts exactly one selector'));assert.match(x.error.detail,/both supplied/);
 assert.equal(x.error.nextAction.command,command);assert.equal(selectorSyntax(command),'(--id ID|--path PATH)');
 assert.equal(selectedArguments(command,{id:'identity'}).ok,true);assert.equal(selectedArguments(command,{path:'/fixture'}).ok,true);
 const root=mkdtempSync(path.join(tmpdir(),'selector-'));const code=process.exitCode;
 try{assert.throws(()=>main([command,'--id','identity','--path','/fixture','--json'],path.join(root,'db')),e=>e.code==='invalid-workspace-selector'&&e.message.startsWith(command+' accepts exactly one selector'));}finally{process.exitCode=code;rmSync(root,{recursive:true,force:true});}
});

test('growth-status accepts either selector or a bound pair; reprice accepts exactly one',()=>{
 assert.equal(selectorSyntax('growth-status'),'(--id ID [--path PATH]|--path PATH)');
 for(const values of [{},{id:''},{path:''}])assert.equal(selectedArguments('growth-status',values).ok,false);
 for(const values of [{id:'identity'},{path:'/fixture'}])assert.equal(selectedArguments('growth-status',values).ok,true);
 assert.equal(selectedArguments('growth-status',{id:'identity',path:'/fixture'}).ok,true);
 assert.equal(selectorSyntax('reprice-capacity'),'(--id ID|--path PATH)');
 assert.equal(selectedArguments('reprice-capacity',{id:'identity',path:'/fixture'}).ok,false);
 for(const values of [{id:'identity'},{path:'/fixture'}])assert.equal(selectedArguments('reprice-capacity',values).ok,true);
});

test('growth-status resolves either selector, binds matching pairs and refuses mismatched or unknown custody without changes',()=>{
 const root=mkdtempSync(path.join(tmpdir(),'growth-status-selectors-')),source=path.join(root,'checkout'),state=path.join(root,'state.sqlite3');let db;
 const run=args=>{let out='';const write=process.stdout.write,exit=process.exitCode;process.stdout.write=x=>{out+=x;return true;};try{main(args,state);}finally{process.stdout.write=write;process.exitCode=exit;}return JSON.parse(out);};
 const git=(...args)=>execFileSync('git',args,{encoding:'utf8',timeout:5000,stdio:['ignore','pipe','pipe']}).trim();
 try {
  mkdirSync(source);git('init','-b','main',source);git('-C',source,'config','user.name','Fixture');git('-C',source,'config','user.email','fixture@example.invalid');
  writeFileSync(path.join(source,'proof.txt'),'Retained source.');git('-C',source,'add','.');git('-C',source,'commit','-m','Fixture');
  const record=run(['register','--path',source,'--root',root,'--owner','exact-owner','--intent','source-only','--headroom-gib','8','--growth-mib','0','--json']);
  run(['measure-capacity','--id',record.id,'--json']);db=workspaceTesting.openRegistry(state);
  const snapshot=()=>({workspace:db.prepare('SELECT * FROM workspace WHERE id=?').get(record.id),capacity:db.prepare('SELECT * FROM workspace_capacity WHERE workspace_id=?').get(record.id),sample:db.prepare('SELECT * FROM workspace_capacity_measurement WHERE workspace_id=?').get(record.id)});
  const before=snapshot(),status=selector=>run(['growth-status',...selector,'--json']);
  const expected=status(['--id',record.id,'--path',source]);
  for(const selector of [['--id',record.id],['--path',source],['--id',record.id,'--path',source]]) {
   const result=status(selector);assert.equal(result.ok,true);assert.equal(result.binding.owner,'exact-owner');
   assert.deepEqual(result.binding,expected.binding);assert.deepEqual(result.plan,expected.plan);assert.deepEqual(result.sample,expected.sample);
  }
  assert.throws(()=>status(['--id',record.id,'--path',root]),{code:'growth-identity-changed'});
  assert.throws(()=>status([]),error=>error.code==='invalid-workspace-selector'&&error.nextAction.command==='growth-status');
  assert.throws(()=>status(['--id','foreign-unknown-id']),/workspace not registered/);
  assert.throws(()=>status(['--path',path.join(root,'unregistered')]),/workspace not registered/);
  for(const selector of [['--id',record.id],['--path',source]]) {
   db.prepare('UPDATE workspace_capacity SET plan_json=? WHERE workspace_id=?').run(JSON.stringify({...expected.plan,growthLifecycle:{kind:'unknown'}}),record.id);
   assert.throws(()=>status(selector),{code:'invalid-growth-lifecycle'});
   db.prepare('UPDATE workspace_capacity SET plan_json=? WHERE workspace_id=?').run(before.capacity.plan_json,record.id);
   db.prepare('DELETE FROM workspace_capacity_measurement WHERE workspace_id=?').run(record.id);
   assert.throws(()=>status(selector),{code:'growth-sample-required'});
   db.prepare('INSERT INTO workspace_capacity_measurement VALUES(?,?)').run(record.id,before.sample.measurement_json);
  }
  assert.deepEqual(snapshot(),before,'read-only selectors preserve source, owner, lease, state, plan and sample');
 }finally{db?.close();rmSync(root,{recursive:true,force:true});}
});
