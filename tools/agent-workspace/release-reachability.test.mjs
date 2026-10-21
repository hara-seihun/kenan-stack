import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {hasUncoveredCommits} from './release-reachability.mjs';

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
