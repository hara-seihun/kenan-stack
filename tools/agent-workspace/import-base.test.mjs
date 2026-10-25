import './scratch-env.mjs';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {workspaceTesting} from './workspace.mjs';
test('import bases never dereference the entire retained ref set to sort dates',()=>{
 const root=mkdtempSync(path.join(tmpdir(),'import-base-'));
 const git=(...args)=>execFileSync('git',['-C',root,...args],{encoding:'utf8'}).trim();
 try {
  git('init');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');
  writeFileSync(path.join(root,'file'),'source');git('add','.');git('commit','-m','source');
  const head=git('rev-parse','HEAD');
  // A retained unavailable tip must not be opened just to sort all candidates.
  // It is not a usable base; closure qualification still runs on chosen bases.
  mkdirSync(path.join(root,'.git/refs/heads'),{recursive:true});
  writeFileSync(path.join(root,'.git/refs/heads/zzz-unavailable'),'1'.repeat(40)+'\n');
  assert.throws(()=>git('for-each-ref','--sort=-committerdate','--format=%(objectname)'));
  assert.deepEqual(workspaceTesting.importBaseCommits(root,head,path.join(root,'.git')),[head]);
 } finally {rmSync(root,{recursive:true,force:true});}
});
