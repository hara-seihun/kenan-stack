import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {hasUncoveredCommits,observedRemoteHeads,REMOTE_OBJECT_BATCH_SIZE} from './release-reachability.mjs';

test('one bounded union walk matches per-branch reachability; refs and foreign work unchanged', () => {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'reachability-'));
 const git=(args,options={})=>execFileSync('git',['-C',root,...args],{encoding:'utf8',timeout:5000,...options}).trim();
 try {
  git(['init','-b','main']);git(['config','user.name','Fixture']);git(['config','user.email','fixture@example.invalid']);
  fs.writeFileSync(path.join(root,'proof'),'base');git(['add','.']);git(['commit','-m','base']);const base=git(['rev-parse','HEAD']);
  git(['commit','--allow-empty','-m','private']);const unique=git(['rev-parse','HEAD']);
  const names=Array.from({length:256},(_,i)=>`branch-${i}`);git(['update-ref','--stdin'],{input:names.map(name=>`create refs/heads/${name} ${base}\n`).join('')});
  git(['branch','foreign-work',unique]);git(['reset','--hard',base]);
  fs.writeFileSync(path.join(root,'foreign-dirty'),'preserve');
  const before=git(['show-ref'])+'\n'+git(['status','--porcelain']);let calls=0;
  const counted=(...args)=>{calls++;return git(...args);};
  assert.equal(hasUncoveredCommits(counted,Array(256).fill(base),[base]),false);assert.equal(calls,1);
  calls=0;assert.equal(hasUncoveredCommits(counted,[base,unique],[base]),true);assert.equal(calls,1);
  for(const tips of [[base],[unique],[base,unique]]) {
   const legacy=tips.some(tip=>Number(git(['rev-list','--count',tip,'--not',base]))>0);
   assert.equal(hasUncoveredCommits(git,tips,[base]),legacy);
  }
  assert.equal(hasUncoveredCommits(git,[base,unique],[base,unique]),false);
  assert.equal(git(['show-ref'])+'\n'+git(['status','--porcelain']),before);
  assert.equal(fs.readFileSync(path.join(root,'foreign-dirty'),'utf8'),'preserve');
 } finally {fs.rmSync(root,{recursive:true,force:true});}
});

test('timeout, invalid output and unknown custody never establish safe coverage',()=>{
 const sha='a'.repeat(40);
 assert.throws(()=>hasUncoveredCommits(()=>{throw new Error('ETIMEDOUT');},[sha],[]),/ETIMEDOUT/);
 assert.throws(()=>hasUncoveredCommits(()=> 'not-a-commit',[sha],[]),/malformed/);
 assert.throws(()=>hasUncoveredCommits(()=> '',['HEAD'],[]),/exact commit/);
 assert.throws(()=>hasUncoveredCommits(()=> '',[],[]),/no candidates/);
});

function remoteFixture(change=()=>{}) {
 const tips=Array.from({length:13735},(_,i)=>(i+1).toString(16).padStart(40,'0'));
 const calls=[];
 const command=(file,args,options)=>{
  assert.equal(file,'git');
  if(args[2]==='remote')return {status:0,stdout:'origin'};
  if(args[2]==='ls-remote')return {status:0,stdout:tips.map((sha,i)=>`${sha}\trefs/heads/branch-${i}`).join('\n')};
  assert.equal(args[2],'cat-file');
  const batch=options.input.trim().split('\n');calls.push(batch);
  // Reproduce the original quantum failure without a wall-clock-dependent sleep.
  if(batch.length>REMOTE_OBJECT_BATCH_SIZE)return {status:1,error:{code:'ETIMEDOUT'},stdout:''};
  assert.equal(options.env.GIT_NO_LAZY_FETCH,'1');assert.equal(options.env.GIT_NO_REPLACE_OBJECTS,'1');
  const result={status:0,stdout:batch.map((sha,i)=>`${sha} ${Number.parseInt(sha,16)%3===0?'missing':'commit'}`).join('\n')};
  change(result,batch,calls.length);return result;
 };
 return {tips,calls,command};
}
test('large advertised remote inventory is checked in bounded quanta without skipping heads',()=>{
 const f=remoteFixture(),result=observedRemoteHeads(f.command,'/source');
 assert.equal(result.ok,true);assert.equal(f.calls.length,Math.ceil(f.tips.length/REMOTE_OBJECT_BATCH_SIZE));
 assert.deepEqual(f.calls.flat(),f.tips);
 assert.deepEqual(result.durable,f.tips.filter(sha=>Number.parseInt(sha,16)%3!==0));
 assert.equal(result.observations[0].heads,f.tips.length);
});
for(const failure of ['timeout','incomplete','wrong-id','wrong-type'])test('a late '+failure+' batch never establishes partial remote custody',()=>{
 const f=remoteFixture((result,batch,count)=>{if(count!==3)return;
  if(failure==='timeout'){result.status=1;result.error={code:'ETIMEDOUT'};}
  if(failure==='incomplete')result.stdout=result.stdout.split('\n').slice(1).join('\n');
  if(failure==='wrong-id')result.stdout=result.stdout.replace(batch[0],'f'.repeat(40));
  if(failure==='wrong-type')result.stdout=result.stdout.replace(/ (commit|missing)/,' blob');
 });
 const result=observedRemoteHeads(f.command,'/source');assert.equal(result.ok,false);assert.equal(result.code,'remote-custody-unknown');assert.equal(result.durable,undefined);assert.equal(f.calls.length,3);
});
