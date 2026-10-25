import './scratch-env.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {classifyLocalMerges} from './local-merge-disposal.mjs';
import {selectorSyntax,cliContracts} from './cli-contract.mjs';
const {main}=await import(process.env.WORKSPACE_RELEASE_MODULE||'./workspace.mjs');

// Fixture: main on the remote, plus two leaf branches (pr-a, pr-b) pushed to the remote.
function fixture(action){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'merge-disposal-')),source=path.join(root,'source'),remote=path.join(root,'remote.git'),state=path.join(root,'registry.sqlite3');
 const previous=process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY;process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY='empty';let db;
 const git=(...a)=>execFileSync('git',a,{encoding:'utf8',timeout:10000,stdio:['ignore','pipe','pipe']}).trim();
 const inSource=(...a)=>git('-C',source,...a);
 const run=(args,expectFail=false)=>{let out='';const write=process.stdout.write,exit=process.exitCode;process.stdout.write=x=>{out+=x;return true;};
  try{main(args,state);}catch(error){if(!expectFail)throw error;return {thrown:String(error.message??error)};}finally{process.stdout.write=write;process.exitCode=exit;}return JSON.parse(out);};
 try{
  git('init','--bare',remote);git('clone',remote,source);inSource('checkout','-b','main');inSource('config','user.name','Fixture');inSource('config','user.email','fixture@example.invalid');
  fs.writeFileSync(path.join(source,'base'),'base\n');fs.writeFileSync(path.join(source,'shared'),'one\ntwo\nthree\n');inSource('add','.');inSource('commit','-m','initial');inSource('push','origin','main');
  const initial=inSource('rev-parse','HEAD');
  for(const [leaf,file] of [['pr-a','a'],['pr-b','b']]){inSource('checkout','-q','-b',leaf,initial);fs.writeFileSync(path.join(source,file),leaf+'\n');inSource('add','.');inSource('commit','-m',leaf);inSource('push','origin',leaf);}
  inSource('checkout','-q','-b','candidate',initial);
  const record=run(['register','--path',source,'--root',root,'--owner','fixture','--source-commit',initial,'--json']);db=new DatabaseSync(state);
  const mergeLeaves=()=>{inSource('merge','--no-ff','-m','merge a','pr-a');inSource('merge','--no-ff','-m','merge b','pr-b');return inSource('rev-parse','HEAD');};
  const dispose=(expectFail)=>run(['dispose-local-merges','--id',record.id,'--path',source,'--owner','fixture','--json'],expectFail);
  const release=()=>run(['release','--id',record.id,'--preserve-runtime','--json']);
  action({root,source,remote,record,git,inSource,run,mergeLeaves,dispose,release,initial});
 }finally{db?.close();if(previous===undefined)delete process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY;else process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY=previous;fs.rmSync(root,{recursive:true,force:true});}
}

test('unrecorded candidate merges still retain the checkout; recorded disposal then releases it',()=>fixture(f=>{
 const head=f.mergeLeaves();
 const before=f.release();assert.equal(before.record.state,'repair-required',JSON.stringify(before));assert.equal(before.physicalDisposition.kind,'retained');
 const disposed=f.dispose();assert.equal(disposed.ok,true);assert.equal(disposed.disposed.length,2);assert.ok(fs.existsSync(disposed.receipt));
 assert.equal(f.inSource('rev-parse','HEAD'),head,'disposal records only; it never moves or deletes source');
 const after=f.release();assert.equal(after.record.state,'released',JSON.stringify(after));assert.equal(after.physicalDisposition.kind,'removed');
 assert.equal(f.git('-C',f.remote,'rev-parse','refs/heads/pr-a')!==undefined,true,'remote leaves untouched');
}));

test('a recorded disposal never covers unique work added afterwards',()=>fixture(f=>{
 f.mergeLeaves();f.dispose();
 fs.writeFileSync(path.join(f.source,'unique'),'unique source\n');f.inSource('add','.');f.inSource('commit','-m','unique');
 const result=f.release();assert.equal(result.record.state,'repair-required',JSON.stringify(result));assert.equal(result.physicalDisposition.kind,'retained');
 assert.equal(fs.readFileSync(path.join(f.source,'unique'),'utf8'),'unique source\n');
}));

test('disposal refuses ordinary commits, evil merges and conflict resolutions',()=>fixture(f=>{
 fs.writeFileSync(path.join(f.source,'unique'),'x\n');f.inSource('add','.');f.inSource('commit','-m','ordinary');
 const ordinary=f.dispose(true);assert.match(ordinary.thrown??JSON.stringify(ordinary),/merge-disposal-refused|ordinary local source/);
}));

test('merge with extra edits is unique source and is refused',()=>fixture(f=>{
 f.inSource('merge','--no-ff','--no-commit','pr-a');fs.writeFileSync(path.join(f.source,'smuggled'),'hand edit inside merge\n');f.inSource('add','.');f.inSource('commit','-m','merge a with edit');
 const refused=f.dispose(true);assert.match(refused.thrown??JSON.stringify(refused),/beyond its parents/);
 const result=f.release();assert.equal(result.record.state,'repair-required');
 assert.equal(fs.readFileSync(path.join(f.source,'smuggled'),'utf8'),'hand edit inside merge\n');
}));

test('conflict-resolution merges are refused',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'merge-classify-'));
 const git=(...a)=>execFileSync('git',['-C',root,...a],{encoding:'utf8',timeout:10000,stdio:['ignore','pipe','pipe']}).trim();
 try{
  git('init','-q','-b','main');git('config','user.name','F');git('config','user.email','f@example.invalid');
  fs.writeFileSync(path.join(root,'f'),'1\n');git('add','.');git('commit','-qm','base');const base=git('rev-parse','HEAD');
  git('checkout','-q','-b','x');fs.writeFileSync(path.join(root,'f'),'x\n');git('commit','-qam','x');const x=git('rev-parse','HEAD');
  git('checkout','-q','main');fs.writeFileSync(path.join(root,'f'),'y\n');git('commit','-qam','y');const y=git('rev-parse','HEAD');
  assert.throws(()=>git('merge','--no-ff','x'));fs.writeFileSync(path.join(root,'f'),'resolved\n');git('commit','-qam','resolved');
  const verdict=classifyLocalMerges((a,o={})=>execFileSync('git',['-C',root,...a],{encoding:'utf8',timeout:10000,input:o.input,stdio:['pipe','pipe','pipe']}).trim(),[git('rev-parse','HEAD')],[base,x,y]);
  assert.equal(verdict.ok,false);assert.match(verdict.reason,/conflict|beyond/);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('octopus merges and unknown owners are refused; nothing is recorded',()=>fixture(f=>{
 f.inSource('merge','--no-ff','-m','octopus','pr-a','pr-b');
 assert.match(JSON.stringify(f.dispose(true)),/only two-parent/);
 const wrongOwner=f.run(['dispose-local-merges','--id',f.record.id,'--path',f.source,'--owner','someone-else','--json'],true);
 assert.match(JSON.stringify(wrongOwner),/stale-merge-disposal|owning identity/);
 assert.equal(fs.existsSync(path.join(f.source,'.git','agent-workspace-merge-disposals')),false);
}));

test('release help and error text derive both selectors from the single CLI contract',()=>{
 const run=args=>execFileSync(process.execPath,[new URL('./workspace.mjs',import.meta.url).pathname,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']});
 let help='';try{help=run(['--help']);}catch(error){help=String(error.stdout??'')+String(error.stderr??'');}
 for(const command of ['release','dispose-local-merges','heartbeat','cancel-creation','finalize-creation']){
  assert.ok(help.includes(`agent-workspace ${command} ${selectorSyntax(command)}`),`help line for ${command} must use ${selectorSyntax(command)}`);
 }
 assert.equal(cliContracts.release.selector.kind,'exactly-one');
 assert.equal(selectorSyntax('release'),'(--id ID|--path PATH)');
 assert.equal(selectorSyntax('dispose-local-merges'),'--id ID --path PATH');
});
