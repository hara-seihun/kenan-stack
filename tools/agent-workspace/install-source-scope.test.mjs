import './scratch-env.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {execFileSync,spawnSync} from 'node:child_process';
import {sourceScope} from './install-source-scope.mjs';
test('source scope refuses a rebased broad diff and permits only an exact declared leaf set or deliberate correction',()=>{
 const r=fs.mkdtempSync(path.join(os.tmpdir(),'source-scope-'));
 const git=(...a)=>execFileSync('git',['-C',r,...a],{encoding:'utf8'}).trim();
 try{
  fs.mkdirSync(path.join(r,'tools/agent-workspace'),{recursive:true});
  git('init','-q');git('config','user.email','fixture@example.invalid');git('config','user.name','Fixture');
  const put=(name,text)=>fs.writeFileSync(path.join(r,'tools/agent-workspace',name),text);
  put('main','base');git('add','.');git('commit','-qm','base');const base=git('rev-parse','HEAD');
  const installed=path.join(r,'.git/installed');fs.mkdirSync(path.join(installed,'agent-workspace'),{recursive:true});
  const metadata=path.join(installed,'agent-workspace/.component-release.json');fs.writeFileSync(metadata,JSON.stringify({sourceCommit:base}));
  put('main','intended');git('add','.');git('commit','-qm','one intended leaf');const exact=git('rev-parse','HEAD');
  assert.deepEqual(sourceScope(r,base,installed).leaves,['tools/agent-workspace/main']);
  put('unqualified','upstream');git('add','.');git('commit','-qm','unrelated upstream leaf');const broad=git('rev-parse','HEAD');
  assert.throws(()=>sourceScope(r,base,installed),/source scope diverged/);
  // The real outer installer rejects before sudo, launcher writes, or slot acquisition.
  const result=spawnSync('/bin/bash',[new URL('./install-capacity-host',import.meta.url).pathname,r,base,installed,path.join(r,'.git/receipt')],{encoding:'utf8',timeout:5000});
  assert.notEqual(result.status,0);assert.equal(fs.existsSync(path.join(r,'.git/receipt')),false);
  // Supply the validator in the candidate just as the real immutable source does.
  fs.copyFileSync(new URL('./install-source-scope.mjs',import.meta.url),path.join(r,'tools/agent-workspace/install-source-scope.mjs'));
  git('add','.');git('commit','-qm','validator');const head=git('rev-parse','HEAD');
  const manifest=path.join(r,'.git/scope.json');const m={base,source:head,leaves:['tools/agent-workspace/main']};
  fs.writeFileSync(manifest,JSON.stringify(m));assert.throws(()=>sourceScope(r,base,installed,manifest),/scope mismatch/);
  m.leaves.push('tools/agent-workspace/unqualified','tools/agent-workspace/install-source-scope.mjs');fs.writeFileSync(manifest,JSON.stringify(m));
  assert.equal(sourceScope(r,base,installed,manifest).kind,'expected-leaves');
  const rejected=spawnSync('/bin/bash',[new URL('./install-capacity-host',import.meta.url).pathname,r,base,installed,path.join(r,'.git/receipt')],{encoding:'utf8',timeout:5000});assert.match(rejected.stderr,/source scope diverged/);
  fs.writeFileSync(metadata,JSON.stringify({sourceCommit:broad}));assert.throws(()=>sourceScope(r,base,installed,manifest),/correction requires/);
  m.correction=true;m.reason='Restore the qualified installed base and exact tested leaves';fs.writeFileSync(manifest,JSON.stringify(m));
  assert.equal(sourceScope(r,base,installed,manifest).kind,'scope-correction');
  assert.equal(git('rev-parse',exact+'^'),base,'historical source is preserved');
 }finally{fs.rmSync(r,{recursive:true,force:true});}
});
