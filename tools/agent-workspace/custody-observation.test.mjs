import './scratch-env.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync,execFileSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
const cli=new URL('./workspace.mjs',import.meta.url).pathname;
test('custody observation yields promptly to checkout and group owners without reading an unsafe binding or changing custody',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'custody-observation-'));
 const source=path.join(root,'source'),state=path.join(root,'state','registry.sqlite3');
 const env={...process.env,PI_WORKSPACE_STATE:state,PI_WORKSPACE_TEST_EXTERNAL_SAFETY:'empty'};
 const run=args=>spawnSync(process.execPath,[cli,...args,'--json'],{encoding:'utf8',env,timeout:6000});
 const git=(...args)=>execFileSync('git',['-C',source,...args],{encoding:'utf8',stdio:'pipe'}).trim();
 let db;
 try {
  fs.mkdirSync(source);git('init');git('config','user.email','fixture@example.invalid');git('config','user.name','Fixture');
  fs.writeFileSync(path.join(source,'tracked'),'preserved');git('add','.');git('commit','-m','fixture');
  const head=git('rev-parse','HEAD');
  const registered=run(['register','--path',source,'--owner','fixture','--source-commit',head]);
  assert.equal(registered.status,0,registered.stdout+registered.stderr);
  const record=JSON.parse(registered.stdout);
  const args=['custody-status','--id',record.id,'--path',source];
  assert.equal(JSON.parse(run(args).stdout).binding.head,head);
  db=new DatabaseSync(state);
  for(const key of [`checkout:${source}`,'group:fixture-group']) {
   if(key.startsWith('group:'))db.prepare('UPDATE workspace SET group_id=? WHERE id=?').run('fixture-group',record.id);
   const before=db.prepare('SELECT * FROM workspace WHERE id=?').get(record.id);
   const locks=path.join(path.dirname(state),'locks');fs.mkdirSync(locks,{recursive:true});
   const fd=fs.openSync(path.join(locks,createHash('sha256').update(key).digest('hex')),'a',0o600);
   try {
    assert.equal(spawnSync('flock',['--exclusive','--nonblock','3'],{stdio:['ignore','pipe','pipe',fd]}).status,0);
    const started=Date.now(),result=run(args),elapsed=Date.now()-started;
    assert.equal(result.status,75,result.stdout+result.stderr);
    const receipt=JSON.parse(result.stdout);
    assert.equal(receipt.error.code,'custody-observation-busy');assert.equal(receipt.effect,'none');
    assert.equal(receipt.binding,undefined);assert.equal(receipt.lock.lock,key);
    assert.ok(elapsed<4000,`observation took ${elapsed} ms`);
    assert.deepEqual(db.prepare('SELECT * FROM workspace WHERE id=?').get(record.id),before);
    assert.equal(fs.readFileSync(path.join(source,'tracked'),'utf8'),'preserved');
   } finally {fs.closeSync(fd);}
   const resumed=run(args);assert.equal(resumed.status,0,resumed.stdout+resumed.stderr);
   assert.equal(JSON.parse(resumed.stdout).binding.head,head);
  }
 } finally {db?.close();fs.rmSync(root,{recursive:true,force:true});}
});
