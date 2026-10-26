import './scratch-env.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
const source=path.resolve(import.meta.dirname,'../..');
test('full tools installation clears only replaced component provenance, preserving source and ordinary nested data',()=>{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'full-tools-metadata-')),repo=path.join(temp,'repo');
 const file=(p,s)=>{fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,s);};
 const git=(...args)=>execFileSync('git',['-C',repo,...args],{encoding:'utf8'}).trim();
 try{
  fs.mkdirSync(path.join(repo,'deploy'),{recursive:true});
  for(const name of ['tools','lib','release-checkout'])fs.copyFileSync(path.join(source,'deploy',name),path.join(repo,'deploy',name));fs.chmodSync(path.join(repo,'deploy/tools'),0o755);
  file(path.join(repo,'config/tools.json'),JSON.stringify({tools:[{id:'agent-workspace',commands:[{entry:'main',name:'agent-workspace'}]},{id:'read-condensed-session',commands:[{entry:'read-thread',name:'read-thread'}]}]}));
  file(path.join(repo,'tools/shared/body'),'shared');
  file(path.join(repo,'tools/agent-workspace/main'),'#!/bin/sh\nexit 0\n');
  file(path.join(repo,'tools/read-condensed-session/read-thread'),'#!/usr/bin/env node\nprocess.exit(0);\n');
  const stale=JSON.stringify({sourceCommit:'0'.repeat(40)});
  file(path.join(repo,'tools/agent-workspace/.component-release.json'),stale);
  file(path.join(repo,'tools/agent-workspace/data/.component-release.json'),'ordinary nested data');
  git('init','-q','-b','main');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');git('add','.');git('commit','-qm','fixture');const commit=git('rev-parse','HEAD');
  const runtime=path.join(temp,'runtime'),orchestrator=path.join(temp,'orchestrator'),dest=path.join(temp,'tools');
  fs.mkdirSync(path.join(runtime,'node_modules'),{recursive:true});file(path.join(runtime,'.pi-stack-commit'),commit);file(path.join(orchestrator,'.pi-stack-commit'),commit);
  const env={...process.env,PI_STACK_DEPLOY_NO_SUDO:'1',PI_STACK_SKIP_TOOL_LINKS:'1',PI_STACK_HOST_LOCK_HELD:'0',PI_STACK_DEPLOY_LOCK_HELD:'0',PI_STACK_DEPLOY_DEADLINE_ACTIVE:'0',PI_STACK_HOST_LOCK_PATH:path.join(temp,'host.lock'),PI_STACK_RUNTIME_DEST:runtime,PI_STACK_ORCHESTRATOR_DEST:orchestrator,PI_STACK_TOOLS_DEST:dest,PI_STACK_RELEASES_ROOT:path.join(temp,'releases')};delete env.PI_STACK_PUBLICATION_REQUEST;
  execFileSync(path.join(repo,'deploy/tools'),[],{env,encoding:'utf8',timeout:10000});
  assert.equal(fs.existsSync(path.join(dest,'agent-workspace/.component-release.json')),false,'a full replacement cannot carry an old component-only source claim');
  assert.equal(fs.readFileSync(path.join(dest,'.pi-stack-commit'),'utf8').trim(),commit);
  assert.equal(fs.readFileSync(path.join(repo,'tools/agent-workspace/.component-release.json'),'utf8'),stale,'source evidence remains unchanged');
  assert.equal(fs.readFileSync(path.join(dest,'agent-workspace/data/.component-release.json'),'utf8'),'ordinary nested data');
 }finally{fs.rmSync(temp,{recursive:true,force:true});}
});
