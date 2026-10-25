import './scratch-env.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {execFileSync,spawnSync} from 'node:child_process';
test('selective capacity installer preserves foreign tools across canonical rebase and removes only deleted component leaves',()=>{
 const r=fs.mkdtempSync(path.join(os.tmpdir(),'capacity-publish-'));
 const git=(...a)=>execFileSync('git',['-C',r,...a],{encoding:'utf8',timeout:5000}).trim();
 try{
  fs.mkdirSync(path.join(r,'tools/agent-workspace'),{recursive:true});
  fs.writeFileSync(path.join(r,'tools/agent-workspace/main'),'old');fs.writeFileSync(path.join(r,'tools/agent-workspace/obsolete'),'obsolete');fs.writeFileSync(path.join(r,'tools/agent-workspace/deploy'),'canonical-old');fs.writeFileSync(path.join(r,'unrelated'),'original');
  for(const name of ['capacity-recovery.test.mjs','capacity-diagnostics.test.mjs'])fs.writeFileSync(path.join(r,'tools/agent-workspace',name),"import {test} from 'node:test';test('rollback sentinel',()=>{});\n");fs.writeFileSync(path.join(r,'tools/agent-workspace/rollback-main'),'#!/bin/sh\nexit 0\n',{mode:0o755});git('init','-q');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');git('add','.');git('commit','-qm','base');const base=git('rev-parse','HEAD');
  fs.mkdirSync(path.join(r,'releases/base/agent-workspace'),{recursive:true});const selected=path.join(r,'releases/base'),dest=path.join(r,'selected');
  fs.cpSync(path.join(r,'tools/agent-workspace'),path.join(selected,'agent-workspace'),{recursive:true});fs.mkdirSync(path.join(selected,'foreign'));fs.writeFileSync(path.join(selected,'foreign/body'),'preserve');fs.symlinkSync(selected,dest);
  fs.writeFileSync(path.join(r,'tools/agent-workspace/main'),'new');fs.unlinkSync(path.join(r,'tools/agent-workspace/obsolete'));fs.writeFileSync(path.join(r,'tools/agent-workspace/deploy'),'canonical-new');fs.writeFileSync(path.join(r,'unrelated'),'canonical-rebase');git('add','.');git('commit','-qm','candidate');const head=git('rev-parse','HEAD');
  const source=new URL('./capacity-deploy.mjs',import.meta.url),dependency=new URL('./deploy-custody-gate.mjs',import.meta.url).href;
  // Relocate only fixed host pathname in a disposable exact script fixture, no production env escape.
  fs.writeFileSync(path.join(r,'fixture.mjs'),fs.readFileSync(source,'utf8').replace("'./deploy-custody-gate.mjs'",JSON.stringify(dependency)).replace("dest='/srv/pi/tools'",'dest='+JSON.stringify(dest)));
  const receipt=path.join(r,'receipt');const result=spawnSync(process.execPath,[path.join(r,'fixture.mjs'),r,base,selected,receipt,'reservation-aware'],{encoding:'utf8',timeout:5000});
  // Fixture executable is deliberately outside tracked source, like the native external launcher.
  assert.match(result.stderr,/unclean source/);fs.renameSync(path.join(r,'fixture.mjs'),path.join(r,'.git/fixture.mjs'));
  const run=spawnSync(process.execPath,[path.join(r,'.git/fixture.mjs'),r,base,selected,receipt,'reservation-aware'],{encoding:'utf8',timeout:5000});assert.equal(run.status,0,run.stderr);
  assert.equal(fs.realpathSync(dest),path.join(r,'releases',head));assert.equal(fs.readFileSync(path.join(dest,'foreign/body'),'utf8'),'preserve');assert.equal(fs.readFileSync(path.join(dest,'agent-workspace/main'),'utf8'),'new');assert.equal(fs.existsSync(path.join(dest,'agent-workspace/obsolete')),false);assert.equal(fs.readFileSync(path.join(dest,'agent-workspace/deploy'),'utf8'),'canonical-old');
 }finally{fs.rmSync(r,{recursive:true,force:true});}
});
