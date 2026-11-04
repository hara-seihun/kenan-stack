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
  fs.appendFileSync(path.join(r,'.git/info/exclude'),'\n/releases/\n/selected\n');
  fs.mkdirSync(path.join(r,'releases/base/agent-workspace'),{recursive:true});const selected=path.join(r,'releases/base'),dest=path.join(r,'selected');
  fs.cpSync(path.join(r,'tools/agent-workspace'),path.join(selected,'agent-workspace'),{recursive:true});fs.chmodSync(path.join(selected,'agent-workspace/rollback-main'),0o644);fs.mkdirSync(path.join(selected,'foreign'));fs.writeFileSync(path.join(selected,'foreign/body'),'preserve');fs.symlinkSync(selected,dest);fs.writeFileSync(path.join(selected,'agent-workspace/.component-release.json'),JSON.stringify({sourceCommit:base}));
  fs.writeFileSync(path.join(r,'tools/agent-workspace/main'),'new');fs.unlinkSync(path.join(r,'tools/agent-workspace/obsolete'));fs.writeFileSync(path.join(r,'tools/agent-workspace/deploy'),'canonical-new');fs.writeFileSync(path.join(r,'unrelated'),'canonical-rebase');git('add','.');git('commit','-qm','candidate');const head=git('rev-parse','HEAD');
  const source=new URL('./capacity-deploy.mjs',import.meta.url),dependency=new URL('./deploy-custody-gate.mjs',import.meta.url).href;
  // Relocate only fixed host pathname in a disposable exact script fixture, no production env escape.
  fs.writeFileSync(path.join(r,'fixture.mjs'),fs.readFileSync(source,'utf8').replace("'./deploy-custody-gate.mjs'",JSON.stringify(dependency)).replace("'./install-source-scope.mjs'",JSON.stringify(new URL('./install-source-scope.mjs',import.meta.url).href)).replace("dest='/srv/pi/tools'",'dest='+JSON.stringify(dest)).replace("sourceRepository='/srv/pi/component-source.git'",'sourceRepository='+JSON.stringify(path.join(r,'.git/durable-source.git'))));
  const receipt=path.join(r,'receipt');const result=spawnSync(process.execPath,[path.join(r,'fixture.mjs'),r,base,selected,receipt,'reservation-aware'],{encoding:'utf8',timeout:15000});
  // Fixture executable is deliberately outside tracked source, like the native external launcher.
  assert.match(result.stderr,/unclean source/);fs.renameSync(path.join(r,'fixture.mjs'),path.join(r,'.git/fixture.mjs'));
  const durable=path.join(r,'.git/durable-source.git');execFileSync('git',['init','--bare',durable],{stdio:'ignore'});fs.writeFileSync(path.join(durable,'FETCH_HEAD'),'stale disposable writer path');
  fs.writeFileSync(path.join(selected,'agent-workspace/.component-release.json'),JSON.stringify({sourceCommit:'previous-broad-selection'}));
  const denied=spawnSync(process.execPath,[path.join(r,'.git/fixture.mjs'),r,base,selected,receipt,'reservation-aware'],{encoding:'utf8',timeout:15000});assert.notEqual(denied.status,0);assert.match(denied.stderr,/source scope diverged/);assert.equal(fs.realpathSync(dest),selected);assert.equal(fs.existsSync(receipt),false);
  const manifest=path.join(r,'.git/scope.json');fs.writeFileSync(manifest,JSON.stringify({base,source:head,leaves:['tools/agent-workspace/main','tools/agent-workspace/obsolete'],correction:true,reason:'Restore the exact tested intended component leaves'}));
  const run=spawnSync(process.execPath,[path.join(r,'.git/fixture.mjs'),r,base,selected,receipt,'reservation-aware','',manifest],{encoding:'utf8',timeout:15000});assert.equal(run.status,0,run.stderr);assert.equal(JSON.parse(fs.readFileSync(receipt)).sourceScope.kind,'scope-correction');
  const component=JSON.parse(fs.readFileSync(path.join(dest,'agent-workspace/.component-release.json'),'utf8'));assert.equal(component.sourceCommit,head);assert.equal(component.baseline,base);assert.equal(component.sourceRepository,path.join(r,'.git/durable-source.git'));assert.equal(execFileSync('git',['--git-dir='+component.sourceRepository,'show',head+':unrelated'],{encoding:'utf8'}),'canonical-rebase');assert.equal(execFileSync('git',['--git-dir='+component.sourceRepository,'rev-parse','refs/agent-workspace/deployed/'+head],{encoding:'utf8'}).trim(),head);assert.equal(execFileSync('git',['--git-dir='+component.sourceRepository,'rev-parse',head+'^'],{encoding:'utf8'}).trim(),base);
  assert.equal(fs.existsSync(path.join(durable,'FETCH_HEAD')),false,'transport metadata must not retain the disposable source');
  assert.equal(fs.realpathSync(dest),path.join(r,'releases',head));assert.ok(fs.statSync(path.join(dest,'agent-workspace/rollback-main')).mode&0o111);assert.equal(fs.readFileSync(path.join(dest,'foreign/body'),'utf8'),'preserve');assert.equal(fs.readFileSync(path.join(dest,'agent-workspace/main'),'utf8'),'new');assert.equal(fs.existsSync(path.join(dest,'agent-workspace/obsolete')),false);assert.equal(fs.readFileSync(path.join(dest,'agent-workspace/deploy'),'utf8'),'canonical-old');
 }finally{fs.rmSync(r,{recursive:true,force:true});}
});
