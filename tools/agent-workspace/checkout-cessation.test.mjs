import './scratch-env.mjs';
import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {spawnSync} from 'node:child_process';
test('stop-post and restart cleanup retain staging when durable process identity is unknown',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'checkout-custody-'));const staging=path.join(root,'.fixture.creating-11111111-1111-4111-8111-111111111111');
 try {
  fs.mkdirSync(staging);fs.writeFileSync(path.join(staging,'proof'),'preserve');
  for(const custody of [{pgid:process.pid,start:'not-the-original-start'},{pgid:null,start:'unknown'}]) {
   fs.writeFileSync(staging+'.custody.json',JSON.stringify(custody));
   const r=spawnSync(process.execPath,[new URL('./checkout-job.mjs',import.meta.url).pathname,'--cleanup',staging],{encoding:'utf8',timeout:5000});
   assert.notEqual(r.status,0);assert.match(r.stderr,/checkout-cessation-unknown/);assert.equal(fs.readFileSync(path.join(staging,'proof'),'utf8'),'preserve');
  }
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
