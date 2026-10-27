import './scratch-env.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const {workspaceTesting:w}=await import('./workspace.mjs');

test('a prepared source is looked up by the commit pinned at request time even after HEAD moves',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'workspace-pin-'));
 try{
  const repository=path.join(root,'repo'),mirror=path.join(root,'mirror.git');fs.mkdirSync(repository);
  const git=(dir,...args)=>execFileSync('git',['-C',dir,...args],{encoding:'utf8',timeout:5000}).trim();
  git(repository,'init','-q');git(repository,'config','user.name','Fixture');git(repository,'config','user.email','fixture@example.invalid');
  fs.writeFileSync(path.join(repository,'file'),'one');git(repository,'add','.');git(repository,'commit','-qm','one');
  execFileSync('git',['clone','--bare',repository,mirror],{stdio:'ignore',timeout:5000});
  const pinned=git(repository,'rev-parse','HEAD');
  const input={statePath:path.join(root,'state','registry.sqlite3'),root,destination:path.join(root,'writer'),repository,ref:'HEAD',upstream:{fetch:repository,push:repository,explicitPush:false},mirror,intent:{intent:'source-only',growthBytes:536870912,headroomBytes:8589934592},sparsePatterns:[],sourceCommit:pinned};
  const args={named:new Map([['repo',[repository]]])};
  const key=createHash('sha256').update(JSON.stringify({...input,sourceCommit:pinned,args:[...args.named],capacityPricingVersion:4})).digest('hex');
  const directory=path.join(root,'state','source-preparations'),jobId='b'.repeat(64),job=path.join(directory,'jobs',jobId);
  fs.mkdirSync(job,{recursive:true});
  const stamp='previous-object-store-stamp',value={sourceCommit:pinned,plan:{sourceCommit:pinned,constructionBytes:1,growthBytes:536870912,headroomBytes:8589934592},stamp};
  fs.writeFileSync(path.join(job,'result.json'),JSON.stringify({state:'ready',value}));
  fs.writeFileSync(path.join(directory,key+'.job.json'),JSON.stringify({initialStamp:stamp,jobId}));
  fs.writeFileSync(path.join(repository,'file'),'two');git(repository,'commit','-qam','two');
  assert.notEqual(git(repository,'rev-parse','HEAD'),pinned);
  const result=w.prepareCreationSource(new Proxy({}, {get:()=>assert.fail('pinned READY reuse must not touch the registry')}),args,input);
  assert.equal(result.state,'ready');assert.equal(result.value.sourceCommit,pinned);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
