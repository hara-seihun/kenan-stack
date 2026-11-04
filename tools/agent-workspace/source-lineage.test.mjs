import './scratch-env.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {test} from 'node:test';
import {integrateInstalled, retainSource} from './source-lineage.mjs';
const git = (repo, ...args) => execFileSync('git', ['-C', repo, ...args], {encoding:'utf8', stdio:['ignore','pipe','pipe']}).trim();
function fixture(body) {
 const root = fs.mkdtempSync(path.join(os.tmpdir(),'lineage-test-'));
 try {
  const repo = path.join(root,'source'), dest = path.join(root,'tools'), custody = path.join(root,'custody.git');
  fs.mkdirSync(path.join(repo,'tools/agent-workspace'),{recursive:true});
  git(repo,'init','-b','main');git(repo,'config','user.name','Test');git(repo,'config','user.email','test@example.invalid');
  fs.writeFileSync(path.join(repo,'tools/agent-workspace/body'),'common\n');
  git(repo,'add','.');git(repo,'commit','-m','common');
  const common = git(repo,'rev-parse','HEAD');
  fs.writeFileSync(path.join(repo,'tools/agent-workspace/body'),'public repair\n');
  git(repo,'commit','-am','public fix');const fix = git(repo,'rev-parse','HEAD');
  git(repo,'switch','-c','private',common);
  fs.writeFileSync(path.join(repo,'tools/agent-workspace/private'),'retained private behavior\n');
  git(repo,'add','.');git(repo,'commit','-m','private behavior');const baseline = git(repo,'rev-parse','HEAD');
  retainSource(repo,custody,baseline);
  fs.mkdirSync(dest);fs.cpSync(path.join(repo,'tools/agent-workspace'),path.join(dest,'agent-workspace'),{recursive:true});
  fs.writeFileSync(path.join(dest,'.pi-stack-commit'),baseline+'\n');
  fs.writeFileSync(path.join(dest,'agent-workspace/.component-release.json'),JSON.stringify({sourceCommit:baseline,sourceRepository:custody}));
  const checkout = path.join(root,'checkout');
  execFileSync('git',['clone','--single-branch','--no-local','-b','main',repo,checkout],{stdio:'pipe'});
  git(checkout,'config','user.name','Test');git(checkout,'config','user.email','test@example.invalid');
  body({root,repo,checkout,dest,custody,baseline,fix});
 } finally {fs.rmSync(root,{recursive:true,force:true});}
}
test('public fix integrates over exact retained private ancestry after original workspace deletion',()=>fixture(({repo,checkout,dest,custody,baseline,fix})=>{
 assert.throws(()=>git(checkout,'cat-file','-e',baseline));
 fs.rmSync(repo,{recursive:true,force:true});
 const result=integrateInstalled(checkout,dest,[fix]);
 assert.equal(result.baseline,baseline);
 assert.equal(fs.readFileSync(path.join(checkout,'tools/agent-workspace/private'),'utf8'),'retained private behavior\n');
 assert.equal(fs.readFileSync(path.join(checkout,'tools/agent-workspace/body'),'utf8'),'public repair\n');
 git(checkout,'merge-base','--is-ancestor',baseline,'HEAD');
 retainSource(checkout,custody,result.sourceCommit);
 assert.equal(git(custody,'rev-parse',`refs/agent-workspace/deployed/${result.sourceCommit}`),result.sourceCommit);
}));
test('changed installed bytes and dirty workspaces refuse without switching branches',()=>fixture(({checkout,dest,fix})=>{
 const head=git(checkout,'rev-parse','HEAD');
 fs.writeFileSync(path.join(checkout,'untracked'),'writer');
 assert.throws(()=>integrateInstalled(checkout,dest,[fix]),/clean admitted checkout/);
 fs.rmSync(path.join(checkout,'untracked'));
 fs.writeFileSync(path.join(dest,'agent-workspace/private'),'tampered');
 assert.throws(()=>integrateInstalled(checkout,dest,[fix]),/bytes or modes/);
 assert.equal(git(checkout,'rev-parse','HEAD'),head);
}));
test('unrelated public changes are refused before changing the checkout',()=>fixture(({checkout,dest})=>{
 const file=path.join(checkout,'other-tool');fs.writeFileSync(file,'unrelated');
 git(checkout,'add','.');git(checkout,'commit','-m','unrelated');const fix=git(checkout,'rev-parse','HEAD');
 assert.throws(()=>integrateInstalled(checkout,dest,[fix]),/only tools\/agent-workspace/);
 assert.equal(git(checkout,'rev-parse','HEAD'),fix);
}));

test('the installed symlink entry executes its CLI instead of silently doing nothing',()=>fixture(({root,checkout,custody,fix})=>{
 const alias=path.join(root,'selected-source-lineage.mjs');
 fs.symlinkSync(new URL('./source-lineage.mjs',import.meta.url),alias);
 const output=execFileSync(process.execPath,[alias,'retain',checkout,custody,fix],{encoding:'utf8'});
 assert.equal(output.trim(),custody);
 assert.equal(git(custody,'rev-parse',`refs/agent-workspace/deployed/${fix}`),fix);
}));
