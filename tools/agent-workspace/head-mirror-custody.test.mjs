import './scratch-env.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawnSync,execFileSync} from 'node:child_process';
import {observeHeadMirrorCustody} from './head-mirror-custody.mjs';
const head='a'.repeat(40);
for(const failure of [{status:null,error:new Error('timeout')},{status:null,signal:'SIGKILL'}]) {
 test('an interrupted closure check is unknown, never complete or absent',()=>{
  const r=observeHeadMirrorCustody({workspace:'.',mirror:'.',command:(_,args,options)=>{
   assert.equal(options.timeout,1000);assert.equal(options.env.GIT_NO_LAZY_FETCH,'1');
   assert.equal(options.env.GIT_ALTERNATE_OBJECT_DIRECTORIES,'');
   return args.includes('rev-parse')?{status:0,stdout:head}:failure;
  }});
  assert.equal(r.kind,'unknown');assert.equal(r.sourcePricing,'unknown');
 });
}
test('a thrown observation never turns informational evidence into a release failure',()=>{
 const r=observeHeadMirrorCustody({workspace:'.',mirror:'.',command:()=>{throw Error('budget exhausted');}});
 assert.equal(r.kind,'unknown');assert.equal(r.commit,null);
});
test('real incomplete and dependent mirrors cannot borrow a complete verdict from local source or the environment',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'head-custody-'));
 const source=path.join(root,'source'),mirror=path.join(root,'mirror.git');
 const git=(...args)=>execFileSync('git',args,{encoding:'utf8',stdio:'pipe'}).trim();
 const command=(file,args,options)=>{const r=spawnSync(file,args,{...options,encoding:'utf8',env:{...process.env,...options.env}});return {...r,stdout:r.stdout?.trim()};};
 try {
  git('init',source);git('-C',source,'config','user.name','Fixture');git('-C',source,'config','user.email','fixture@example.invalid');
  fs.writeFileSync(path.join(source,'proof'),'valuable source');git('-C',source,'add','.');git('-C',source,'commit','-m','source');
  git('clone','--bare','--no-hardlinks',source,mirror);
  const observe=()=>observeHeadMirrorCustody({workspace:source,mirror,command});
  assert.equal(observe().kind,'complete');
  const blob=git('-C',source,'rev-parse','HEAD:proof');fs.unlinkSync(path.join(mirror,'objects',blob.slice(0,2),blob.slice(2)));
  assert.equal(observe().kind,'absent-or-incomplete');
  fs.writeFileSync(path.join(mirror,'objects/info/alternates'),path.join(source,'.git/objects')+'\n');
  assert.equal(observe().kind,'absent-or-incomplete');
  assert.equal(fs.readFileSync(path.join(source,'proof'),'utf8'),'valuable source');
 } finally {fs.rmSync(root,{recursive:true,force:true});}
});
