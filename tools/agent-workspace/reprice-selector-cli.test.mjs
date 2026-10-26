import './scratch-env.mjs';
import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {spawnSync,execFileSync} from 'node:child_process';
import {selectedArguments} from './cli-contract.mjs';
const script=new URL('./workspace.mjs',import.meta.url).pathname;
test('ordinary repricing accepts either single selector and rejects both or neither before any capacity change',()=>{
 assert.equal(selectedArguments('reprice-capacity',{id:'record'}).ok,true);assert.equal(selectedArguments('reprice-capacity',{path:'/record'}).ok,true);assert.equal(selectedArguments('reprice-capacity',{}).ok,false);assert.equal(selectedArguments('reprice-capacity',{id:'record',path:'/record'}).ok,false);
});
test('public ordinary reprice single selectors reach capacity and every refusal has typed JSON',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'reprice-public-')),env={...process.env,PI_WORKSPACE_STATE:path.join(root,'registry.sqlite3')};
 const run=args=>spawnSync(process.execPath,[script,...args,'--json'],{env,encoding:'utf8',timeout:15000});
 try{
  const repo=path.join(root,'source');fs.mkdirSync(repo);execFileSync('git',['init','-q',repo]);execFileSync('git',['-C',repo,'-c','user.name=F','-c','user.email=f@example.invalid','commit','-q','--allow-empty','-m','source']);const head=execFileSync('git',['-C',repo,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
  const registered=run(['register','--path',repo,'--owner','fixture','--source-commit',head]);assert.equal(registered.status,0,registered.stderr);const record=JSON.parse(registered.stdout);
  const options=['--intent','budgeted','--headroom-gib','8','--growth-mib','2048'];
  for(const selector of [['--id',record.id],['--path',repo]]){const r=run(['reprice-capacity',...selector,...options]);assert.equal(r.status,0,r.stderr);const value=JSON.parse(r.stdout);assert.equal(value.capacity.intent,'budgeted');}
  const missing=run(['reprice-capacity','--path',path.join(root,'missing'),...options]);assert.equal(missing.status,2);assert.equal(JSON.parse(missing.stdout).error.code,'invalid-request');
  for(const selector of [[],['--id',record.id,'--path',repo]]){const r=run(['reprice-capacity',...selector,...options]);assert.equal(r.status,2,r.stderr);assert.equal(JSON.parse(r.stdout).error.code,'invalid-workspace-selector');}
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('the public Actions adoption command validates its bound selector before any GitHub effect',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'adopt-public-'));
 try{const result=spawnSync(process.execPath,[script,'adopt-ended-actions','--id','missing','--path',root,'--repository','owi-link/converge','--run','1','--attempt','1','--source-commit','a'.repeat(40),'--json'],{env:{...process.env,PI_WORKSPACE_STATE:path.join(root,'registry.sqlite3')},encoding:'utf8',timeout:10000});
 assert.equal(result.status,2);assert.doesNotMatch(result.stderr,/invalid-selector-contract|adopt-ended-actions$/);assert.match(result.stderr,/unknown workspace|workspace not found|workspace not registered/);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
