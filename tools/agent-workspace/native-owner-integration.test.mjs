import './scratch-env.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {main} from './workspace.mjs';
import {bindNativeOwner,nativeOwnerBinding} from './native-owner.mjs';
const AGENT='22222222-2222-4222-8222-222222222222';
function fixture(action){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'native-owner-integration-')),source=path.join(root,'checkout'),remote=path.join(root,'remote.git'),state=path.join(root,'registry.sqlite3'),native=path.join(root,'native.json');
 const previous=[process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY,process.env.PI_WORKSPACE_TEST_OWNER_LIVENESS];
 process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY='empty';process.env.PI_WORKSPACE_TEST_OWNER_LIVENESS=native;
 const git=(...a)=>execFileSync('git',a,{encoding:'utf8',timeout:5000,stdio:['ignore','pipe','pipe']}).trim();let db;
 const run=args=>{let out='';const write=process.stdout.write,exit=process.exitCode;process.stdout.write=x=>{out+=x;return true;};try{main(args,state);}finally{process.stdout.write=write;process.exitCode=exit;}return JSON.parse(out);};
 try{
  git('init','--bare',remote);git('clone',remote,source);git('-C',source,'checkout','-b','main');git('-C',source,'config','user.name','Fixture');git('-C',source,'config','user.email','fixture@example.invalid');git('-C',source,'commit','--allow-empty','-m','initial');git('-C',source,'push','origin','main');
  const record=run(['register','--path',source,'--root',root,'--owner','task-label','--json']);db=new DatabaseSync(state);
  const bind=()=>bindNativeOwner(db,record.id,{agentId:AGENT,channel:'beta',callId:'call_123'},'caller-scope',{fixture:true});
  const observe=(agentState,wakes=[])=>fs.writeFileSync(native,JSON.stringify({errors:[],agents:[{id:AGENT,channel:'beta',role:'worker',state:agentState,archived:agentState==='stopped',goalId:null,updatedAt:1}],wakes,observations:[],observedAt:Date.now()}));
  const release=(execute=false)=>run(['release-ended-owners','--id',record.id,...(execute?['--execute']:[]),'--json']);
  action({root,source,state,record,db,run,bind,observe,release});
 }finally{db?.close();['PI_WORKSPACE_TEST_EXTERNAL_SAFETY','PI_WORKSPACE_TEST_OWNER_LIVENESS'].forEach((key,i)=>{if(previous[i]===undefined)delete process.env[key];else process.env[key]=previous[i];});fs.rmSync(root,{recursive:true,force:true});}
}
test('bound labels are eligible, live owners stay protected, stopped owner releases with its canonical identity',()=>fixture(f=>{
 f.observe('stopped');assert.equal(f.release().candidates,0,'unbound free labels must never be guessed');
 f.bind();f.observe('running');const live=f.release(true);assert.equal(live.results[0].code,'owner-live');assert.equal(fs.existsSync(f.source),true);
 f.observe('stopped');const dry=f.release();assert.equal(dry.results[0].ownerLiveness.owner,AGENT);assert.equal(dry.results[0].action,'would-release-ended-owner');
 const settled=f.release(true);assert.equal(settled.results[0].record.state,'released',JSON.stringify(settled));assert.equal(fs.existsSync(f.source),false);
}));
test('pending wakes for the canonical bound identity protect a labelled checkout',()=>fixture(f=>{
 f.bind();f.observe('stopped',[{id:'wake',agentId:AGENT,status:'pending',message:'continue',heldFor:null}]);
 const result=f.release(true);assert.notEqual(result.results[0].action,'released');assert.equal(fs.existsSync(f.source),true);
}));
test('migration has an explicit unbound outcome for registration without an admission receipt',()=>fixture(f=>{
 const result=f.run(['bind-native-owners','--id',f.record.id,'--execute','--json']);assert.equal(result.ok,true);assert.equal(result.results[0].outcome,'unbound');assert.equal(result.results[0].code,'no-creation-request');assert.deepEqual(nativeOwnerBinding(f.db,f.record.id),{state:'unset'});
}));
