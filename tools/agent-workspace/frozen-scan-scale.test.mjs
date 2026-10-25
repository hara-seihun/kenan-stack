import './scratch-env.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync,spawnSync} from 'node:child_process';
import {frozenCustody,FROZEN_OBSERVATION_BUDGET} from './frozen-custody.mjs';
const {main}=await import('./workspace.mjs');

// 300 directories of 500 files: about 150,000 entries, more than the 130,000-entry tree that exhausted the old fixed 5-second budget.
function bigTree(root){
 fs.mkdirSync(root,{recursive:true});
 for(let d=0;d<300;d++){const dir=path.join(root,'d'+d);fs.mkdirSync(dir);for(let f=0;f<500;f++)fs.closeSync(fs.openSync(path.join(dir,'f'+f),'w'));}
}

test('a 150,000-entry tree is observed within its size-scaled deadline and is not frozen',{timeout:280000},()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'frozen-scale-'));
 try{
  bigTree(path.join(root,'tree'));
  const started=Date.now(),result=frozenCustody(path.join(root,'tree'),{recursive:true}),elapsed=Date.now()-started;
  assert.equal(result,null,JSON.stringify(result));
  const entries=150000+301,allowed=(FROZEN_OBSERVATION_BUDGET.baseSeconds+FROZEN_OBSERVATION_BUDGET.perEntrySeconds*entries)*1000;
  assert.ok(elapsed<allowed,`observation took ${elapsed}ms of ${allowed}ms`);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('an observation that cannot finish in its deadline is unknown custody, never not-frozen',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'frozen-unknown-'));
 try{
  bigTree(path.join(root,'tree'));
  const result=frozenCustody(path.join(root,'tree'),{recursive:true,budget:{baseSeconds:0.01,perEntrySeconds:0,capSeconds:0.01}});
  assert.equal(result?.code,'FROZEN_CUSTODY_UNKNOWN',JSON.stringify(result));
  assert.match(result.reason,/budget exhausted after \d+ entries/);
  assert.doesNotMatch(result.reason,/Traceback/);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

function releaseFixture(action){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'release-exit-')),source=path.join(root,'source'),remote=path.join(root,'remote.git'),state=path.join(root,'registry.sqlite3');
 const previous=process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY;process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY='empty';
 const git=(...a)=>execFileSync('git',a,{encoding:'utf8',timeout:5000,stdio:['ignore','pipe','pipe']}).trim();
 const run=args=>{let out='';const write=process.stdout.write,exit=process.exitCode;process.exitCode=undefined;process.stdout.write=x=>{out+=x;return true;};let status;try{main(args,state);status=process.exitCode??0;}finally{process.stdout.write=write;process.exitCode=exit;}return {status,output:JSON.parse(out)};};
 try{
  git('init','--bare',remote);git('clone',remote,source);git('-C',source,'checkout','-b','main');git('-C',source,'config','user.name','Fixture');git('-C',source,'config','user.email','fixture@example.invalid');
  fs.writeFileSync(path.join(source,'proof'),'initial');git('-C',source,'add','.');git('-C',source,'commit','-m','initial');git('-C',source,'push','origin','main');
  const initial=git('-C',source,'rev-parse','HEAD');
  const record=run(['register','--path',source,'--root',root,'--owner','fixture','--source-commit',initial,'--json']).output;
  action({source,record,release:()=>run(['release','--id',record.id,'--preserve-runtime','--json'])});
 }finally{if(previous===undefined)delete process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY;else process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY=previous;fs.rmSync(root,{recursive:true,force:true});}
}

test('a release that reports a blocked outcome exits nonzero',()=>releaseFixture(f=>{
 fs.writeFileSync(path.join(f.source,'.git','pi-frozen-handoff.json'),'{}');
 const {status,output}=f.release();
 assert.equal(output.inspection.classification,'blocked',JSON.stringify(output));
 assert.equal(output.inspection.code,'FROZEN_CUSTODY');
 assert.equal(status,2);
 assert.ok(fs.existsSync(f.source));
}));

test('a release that completes exits zero',()=>releaseFixture(f=>{
 const {status,output}=f.release();
 assert.equal(output.record.state,'released',JSON.stringify(output));
 assert.equal(status,0);
}));
