import './scratch-env.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
const {workspaceTesting}=await import(process.env.WORKSPACE_REMOTE_MODULE || './workspace.mjs');

test('local import preserves an explicit equal HTTPS push route despite host SSH pushInsteadOf',()=>{
 const root=mkdtempSync(path.join(tmpdir(),'workspace-remote-'));
 const previous=process.env.GIT_CONFIG_GLOBAL;
 const git=(...args)=>execFileSync('git',args,{encoding:'utf8',timeout:5000}).trim();
 try {
  const config=path.join(root,'config');
  writeFileSync(config,'[url "ssh://git@github.com/"]\n pushInsteadOf = https://github.com/\n');
  process.env.GIT_CONFIG_GLOBAL=config;
  const source=path.join(root,'source'),child=path.join(root,'child');
  git('init','-q',source);git('init','-q',child);
  const url='https://github.com/owi-link/converge.git';
  git('-C',source,'remote','add','origin',url);
  git('-C',source,'remote','set-url','--push','origin',url);
  const route=workspaceTesting.repositoryRemotes(source);
  git('-C',child,'remote','add','origin',route.fetch);
  workspaceTesting.configurePushUrl(['-C',child],route);
  assert.equal(git('-C',source,'remote','get-url','--push','origin'),url);
  assert.equal(git('-C',child,'remote','get-url','--push','origin'),url);
  // URL-only imports and local sources with no explicit pushurl keep intentional host rewriting.
  git('-C',source,'config','--unset-all','remote.origin.pushurl');
  const implicit=workspaceTesting.repositoryRemotes(source);
  workspaceTesting.configurePushUrl(['-C',child],implicit);
  assert.equal(git('-C',child,'remote','get-url','--push','origin'),'ssh://git@github.com/owi-link/converge.git');
 } finally {
  if(previous===undefined)delete process.env.GIT_CONFIG_GLOBAL;else process.env.GIT_CONFIG_GLOBAL=previous;
  rmSync(root,{recursive:true,force:true});
 }
});

test('explicit distinct push route survives and URL-only input retains host policy',()=>{
 const root=mkdtempSync(path.join(tmpdir(),'workspace-remote-distinct-'));
 const git=(...args)=>execFileSync('git',args,{encoding:'utf8',timeout:5000}).trim();
 try {
  const source=path.join(root,'source'),child=path.join(root,'child');
  git('init','-q',source);git('init','-q',child);
  git('-C',source,'remote','add','origin','https://example.invalid/read.git');
  git('-C',source,'remote','set-url','--push','origin','ssh://git@example.invalid/write.git');
  const route=workspaceTesting.repositoryRemotes(source);
  git('-C',child,'remote','add','origin',route.fetch);
  workspaceTesting.configurePushUrl(['-C',child],route);
  assert.equal(git('-C',child,'remote','get-url','--push','origin'),'ssh://git@example.invalid/write.git');
  const direct=workspaceTesting.repositoryRemotes('https://example.invalid/read.git');
  workspaceTesting.configurePushUrl(['-C',child],direct);
  assert.throws(()=>git('-C',child,'config','--get','remote.origin.pushurl'));
 }finally{rmSync(root,{recursive:true,force:true});}
});
