import './scratch-env.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {main,workspaceTesting} from './workspace.mjs';
import {assertIdleObservation} from './idle-growth.mjs';
for(const incremental of [false,true])test(`generated runtime measurement needs no payload reads (${incremental?'incremental':'targeted'})`,()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'measure-content-')),state=path.join(root,'state.sqlite3'),source=path.join(root,'runtime');let db;
 const capture=fn=>{let out='';const w=process.stdout.write;process.stdout.write=v=>{out+=v;return true;};try{fn();return JSON.parse(out);}finally{process.stdout.write=w;}};
 const run=args=>capture(()=>main(args,state));
 try{
  fs.mkdirSync(source);execFileSync('git',['init','-q',source]);execFileSync('git',['-C',source,'-c','user.name=F','-c','user.email=f@invalid','commit','--allow-empty','-qm','fixture']);
  const r=run(['register','--path',source,'--owner','fixture','--json']);
  fs.mkdirSync(path.join(source,'node_modules'));const fd=fs.openSync(path.join(source,'node_modules','large-output'),'w');fs.writeSync(fd,Buffer.alloc(1024*1024));fs.ftruncateSync(fd,32*1024*1024);fs.closeSync(fd);
  db=workspaceTesting.openRegistry(state);db.prepare('INSERT OR REPLACE INTO workspace_capacity VALUES(?,?,?)').run(r.id,String(fs.statSync(root).dev),JSON.stringify({intent:'budgeted',growthBytes:2**30,headroomBytes:8*2**30}));
  const read=fs.readSync;let reads=0;fs.readSync=(...a)=>{if(fs.readlinkSync('/proc/self/fd/'+a[0]).startsWith(source+'/')){reads++;throw Object.assign(Error('full payload hashing is forbidden for capacity'),{code:'content-proof-deadline'});}return read(...a);};
  let result;try{result=run(['measure-capacity','--id',r.id,'--budget-ms','1200',...(incremental?['--incremental']:[]),'--json']);}finally{fs.readSync=read;}
  assert.equal(reads,0);assert.equal(result.progress.error,0);const sample=result.results.at(-1);assert.equal(sample.ok,true);assert.equal(sample.writeObservationComplete,false);assert.ok(sample.bytes>0);assert.ok(sample.bytes<32*1024*1024,'sparse logical size is not fabricated allocation');
  assert.throws(()=>assertIdleObservation(sample,sample),{code:'idle-growth-write-race'});
  const proof=run(['measure-capacity','--id',r.id,'--content-proof','--budget-ms','3000','--json']).results.at(-1);assert.equal(proof.ok,true);assert.equal(proof.writeObservationComplete,true);
 }finally{db?.close();fs.rmSync(root,{recursive:true,force:true});}
});
