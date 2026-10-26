import './scratch-env.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
const {workspaceTesting}=await import(process.env.WORKSPACE_REMOTE_MODULE || './workspace.mjs');

function fixture(action) {
 const root=mkdtempSync(path.join(tmpdir(),'workspace-remote-'));
 const previous={global:process.env.GIT_CONFIG_GLOBAL,system:process.env.GIT_CONFIG_NOSYSTEM};
 const git=(...args)=>execFileSync('git',args,{encoding:'utf8',timeout:5000,stdio:['ignore','pipe','pipe']}).trim();
 try {
  const config=path.join(root,'config');
  // Match the host's more-specific work deploy-key rule and general SSH rule.
  writeFileSync(config,'[url "ssh://git@github.com/owi-link/converge"]\n pushInsteadOf = https://github.com/owi-link/converge\n[url "ssh://git@github.com/"]\n pushInsteadOf = https://github.com/\n');
  process.env.GIT_CONFIG_GLOBAL=config;
  process.env.GIT_CONFIG_NOSYSTEM='1';
  const source=path.join(root,'source'),child=path.join(root,'child');
  git('init','-q',source);git('init','-q',child);
  action({git,source,child});
 } finally {
  if(previous.global===undefined)delete process.env.GIT_CONFIG_GLOBAL;else process.env.GIT_CONFIG_GLOBAL=previous.global;
  if(previous.system===undefined)delete process.env.GIT_CONFIG_NOSYSTEM;else process.env.GIT_CONFIG_NOSYSTEM=previous.system;
  rmSync(root,{recursive:true,force:true});
 }
}

for(const url of ['https://github.com/owi-link/converge.git','https://github.com/owi-link/converge']) {
 test(`Converge import omits the redundant inherited HTTPS push URL for ${url}`,()=>fixture(({git,source,child})=>{
  git('-C',source,'remote','add','origin',url);
  git('-C',source,'remote','set-url','--push','origin',url);
  const route=workspaceTesting.repositoryRemotes(source);
  git('-C',child,'remote','add','origin',route.fetch);
  // Reconcile an old mirror/checkout default too, without touching the source.
  git('-C',child,'remote','set-url','--push','origin',url);
  workspaceTesting.configurePushUrl(['-C',child],route);
  assert.throws(()=>git('-C',child,'config','--get','remote.origin.pushurl'));
  assert.equal(git('-C',child,'config','--get','remote.origin.url'),url);
  assert.equal(git('-C',child,'remote','get-url','--push','origin'),url.replace('https://','ssh://git@'));
  assert.equal(git('-C',source,'config','--get','remote.origin.pushurl'),url);
 }));
}

test('implicit local and URL-only Converge imports leave pushInsteadOf unpinned',()=>fixture(({git,source,child})=>{
 const url='https://github.com/owi-link/converge.git';
 git('-C',source,'remote','add','origin',url);
 git('-C',child,'remote','add','origin',url);
 for(const input of [source,url]) {
  workspaceTesting.configurePushUrl(['-C',child],workspaceTesting.repositoryRemotes(input));
  assert.throws(()=>git('-C',child,'config','--get','remote.origin.pushurl'));
  assert.equal(git('-C',child,'remote','get-url','--push','origin'),'ssh://git@github.com/owi-link/converge.git');
 }
}));

test('explicit equal non-Converge HTTPS route remains intentional',()=>fixture(({git,source,child})=>{
 const url='https://github.com/example/programme.git';
 git('-C',source,'remote','add','origin',url);
 git('-C',source,'remote','set-url','--push','origin',url);
 const route=workspaceTesting.repositoryRemotes(source);
 git('-C',child,'remote','add','origin',route.fetch);
 workspaceTesting.configurePushUrl(['-C',child],route);
 assert.equal(git('-C',child,'config','--get','remote.origin.pushurl'),url);
 assert.equal(git('-C',child,'remote','get-url','--push','origin'),url);
}));

test('explicit distinct Converge write grant survives',()=>fixture(({git,source,child})=>{
 git('-C',source,'remote','add','origin','https://github.com/owi-link/converge.git');
 const push='ssh://git@work-write-key/owi-link/converge.git';
 git('-C',source,'remote','set-url','--push','origin',push);
 const route=workspaceTesting.repositoryRemotes(source);
 git('-C',child,'remote','add','origin',route.fetch);
 workspaceTesting.configurePushUrl(['-C',child],route);
 assert.equal(git('-C',child,'remote','get-url','--push','origin'),push);
 assert.equal(git('-C',child,'config','--get','remote.origin.pushurl'),push);
}));

test('explicit distinct push route survives and URL-only input retains host policy',()=>fixture(({git,source,child})=>{
 git('-C',source,'remote','add','origin','https://example.invalid/read.git');
 git('-C',source,'remote','set-url','--push','origin','ssh://git@example.invalid/write.git');
 const route=workspaceTesting.repositoryRemotes(source);
 git('-C',child,'remote','add','origin',route.fetch);
 workspaceTesting.configurePushUrl(['-C',child],route);
 assert.equal(git('-C',child,'remote','get-url','--push','origin'),'ssh://git@example.invalid/write.git');
 const direct=workspaceTesting.repositoryRemotes('https://example.invalid/read.git');
 workspaceTesting.configurePushUrl(['-C',child],direct);
 assert.throws(()=>git('-C',child,'config','--get','remote.origin.pushurl'));
}));
