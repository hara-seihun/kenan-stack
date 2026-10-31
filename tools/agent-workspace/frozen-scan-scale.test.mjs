import './scratch-env.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync,spawn,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
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

// A host saturated by other work gives the scanner a small share of the CPU. Stopping it 90% of the time reproduces that:
// the scan must still finish, because its allowance is charged against its own CPU time, not the wall clock.
test('a scan starved of CPU by other work still completes and is not frozen',{timeout:120000},async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'frozen-starved-'));
 try{
  const tree=path.join(root,'tree');fs.mkdirSync(tree);
  for(let d=0;d<20;d++){const dir=path.join(tree,'d'+d);fs.mkdirSync(dir);for(let f=0;f<500;f++)fs.closeSync(fs.openSync(path.join(dir,'f'+f),'w'));}
  const scanner=fileURLToPath(new URL('./frozen-custody.py',import.meta.url));
  const child=spawn('/usr/bin/python3',[scanner,tree,'recursive','0.5','0','60'],{stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='',running=true;child.stdout.on('data',x=>stdout+=x);child.stderr.on('data',x=>stderr+=x);
  const done=new Promise(resolve=>child.on('exit',code=>{running=false;resolve(code);}));
  (async()=>{while(running){child.kill('SIGSTOP');await new Promise(r=>setTimeout(r,450));if(!running)break;child.kill('SIGCONT');await new Promise(r=>setTimeout(r,50));}})();
  const code=await done;
  assert.equal(code,0,stderr);
  const value=JSON.parse(stdout);
  assert.equal(value.frozen,false);
  assert.ok(value.entries>10000,stdout);
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
