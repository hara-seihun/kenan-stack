import './scratch-env.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {observeInodeContent,withContentObservation,pruneInodeContent} from './inode-content.mjs';
import {allocationSlice} from './incremental-allocation.mjs';
import {assertIdleGrowth} from './idle-growth.mjs';
const H=3600000;
function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'content-proof-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const file=path.join(root,'payload');fs.writeFileSync(file,'original payload');fs.utimesSync(file,1,1);return {root,file};}
test('actual hardlink creation preserves payload age only after matching full hashes and exact identity metadata',t=>{
 const {root,file}=fixture(t),a=observeInodeContent(file);Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5);fs.linkSync(file,path.join(root,'link'));
 const b=observeInodeContent(file,a.record);assert.equal(b.lastWriteAt,a.lastWriteAt);assert.equal(b.record.sha256,a.record.sha256);assert.ok(b.record.linkOnlyProof);assert.notEqual(b.record.metadata.nlink,a.record.metadata.nlink);assert.notEqual(b.record.metadata.ctimeNs,a.record.metadata.ctimeNs);
 fs.unlinkSync(path.join(root,'link'));const c=observeInodeContent(file,b.record);assert.equal(c.lastWriteAt,a.lastWriteAt);assert.ok(c.record.linkOnlyProof);
});
test('first observation never backdates ctime or invents proof from old mtime',t=>{
 const {root,file}=fixture(t);fs.linkSync(file,path.join(root,'link'));const a=observeInodeContent(file);assert.ok(a.lastWriteAt>=Date.now()-1000);assert.equal(a.record.linkOnlyProof,undefined);
});
test('same-size payload write remains recent even with restored mtime and simultaneous link-count change',t=>{
 const {root,file}=fixture(t),a=observeInodeContent(file);fs.writeFileSync(file,'different bytes!');fs.utimesSync(file,1,1);fs.linkSync(file,path.join(root,'link'));const b=observeInodeContent(file,a.record);assert.notEqual(b.record.sha256,a.record.sha256);assert.equal(b.record.linkOnlyProof,undefined);assert.ok(b.lastWriteAt>=Date.now()-1000);
});
test('same bytes written again, chmod, replacement and unproved ctime changes retain real recent evidence',t=>{
 const {root,file}=fixture(t);let a=observeInodeContent(file);fs.writeFileSync(file,'original payload');let b=observeInodeContent(file,a.record);assert.equal(b.record.linkOnlyProof,undefined);assert.ok(b.lastWriteAt>=Date.now()-1000);
 a=b;fs.chmodSync(file,0o600);fs.linkSync(file,path.join(root,'link'));b=observeInodeContent(file,a.record);assert.equal(b.record.linkOnlyProof,undefined);
 fs.unlinkSync(file);fs.writeFileSync(file,'original payload');fs.utimesSync(file,1,1);b=observeInodeContent(file,a.record);assert.equal(b.record.linkOnlyProof,undefined);assert.notEqual(b.record.metadata.ino,a.record.metadata.ino);
});
test('persisted global inode custody is reused across hardlink paths and survives a new observer',t=>{
 const {root,file}=fixture(t),db=new DatabaseSync(path.join(root,'proof.sqlite'));t.after(()=>db.close());
 const a=withContentObservation(db,{},observe=>observe(file));const link=path.join(root,'other');fs.linkSync(file,link);
 const b=withContentObservation(db,{},observe=>observe(link));assert.equal(a,b);const proof=JSON.parse(db.prepare('SELECT evidence_json FROM workspace_inode_content').get().evidence_json);assert.ok(proof.linkOnlyProof);assert.equal(proof.metadata.nlink,'2');
});
test('hardlink-only churn does not restart an actually elapsed one-hour payload guard, but a content write does',t=>{
 const {root,file}=fixture(t);const first=observeInodeContent(file),a=Date.now;Date.now=()=>a()+2*H;
 try{
  fs.linkSync(file,path.join(root,'link'));const second=observeInodeContent(file,first.record);assert.equal(second.lastWriteAt,first.lastWriteAt);
  const n=Date.now(),sample={ok:true,rootPath:root,planSha256:'p',device:'1',inode:'2',startedAt:n-1,completedAt:n,bytes:8,lastWriteAt:second.lastWriteAt};
  const input={now:n,record:{path:root,state:'active',createdAt:n-3*H},plan:{intent:'budgeted',growthBytes:100},planSha256:'p',sample,history:{planGrowthBytes:100,allocationBinding:{rootPath:root,planSha256:'p',device:'1',inode:'2'},samples:[{at:n-5,bytes:8},{at:n,bytes:8}]},safety:{errors:[],references:[]}};
  assert.doesNotThrow(()=>assertIdleGrowth(input));
  // Filesystem time is not the injected observation clock. Use actual inode
  // write evidence and a normal current clock for the negative transition.
  fs.writeFileSync(file,'new same payload');const third=observeInodeContent(file,second.record);assert.equal(third.record.linkOnlyProof,undefined);assert.ok(third.lastWriteAt>=a()-1000);
 }finally{Date.now=a;}
});
test('resumable observation uses content proof without changing allocation, and invalidates old cursor versions',t=>{
 const {root,file}=fixture(t),db=new DatabaseSync(':memory:');t.after(()=>db.close());const device=String(fs.statSync(root).dev);
 let a=withContentObservation(db,{},observeContent=>allocationSlice(root,device,null,{observeContent}));fs.linkSync(file,path.join(root,'link'));
 const b=withContentObservation(db,{},observeContent=>allocationSlice(root,device,null,{observeContent}));assert.ok(a.ok&&b.ok);assert.equal(a.allocatedBytes,b.allocatedBytes);assert.equal(a.inode,b.inode);
 const c=allocationSlice(root,device,{version:2,pending:[],root,device,inode:a.inode});assert.ok(c.lastWriteAt>=Date.now()-1000);
});
test('concurrent observer publication never overwrites newer identity evidence or lowers payload age',t=>{
 const {root,file}=fixture(t),db=new DatabaseSync(':memory:');t.after(()=>db.close());
 let late;
 // Defer the old observer's publication until a new payload has been observed.
 const old=withContentObservation(db,{},observe=>{
  const result=observe(file);fs.writeFileSync(file,'different bytes!');
  late=withContentObservation(db,{},fresh=>fresh(file));return result;
 });
 const record=JSON.parse(db.prepare('SELECT evidence_json FROM workspace_inode_content').get().evidence_json);
 assert.ok(late>=old);assert.equal(record.lastPayloadWriteAt,late);assert.equal(record.sha256,observeInodeContent(file).record.sha256);
});
test('incomplete content hash pauses the cursor without publishing a fake recent write or dropping that inode',t=>{
 const {root,file}=fixture(t),device=String(fs.statSync(root).dev);
 const paused=allocationSlice(root,device,null,{observeContent:f=>{if(f===file)throw Object.assign(Error('budget'),{code:'content-proof-deadline'});return 0;}});
 assert.equal(paused.partial,true);assert.ok(paused.state.pending.includes(file));assert.equal(paused.state.lastWriteAt,0);
 const resumed=allocationSlice(root,device,paused.state,{observeContent:()=>123});assert.equal(resumed.ok,true);assert.equal(resumed.lastWriteAt,123);
});
test('retention drops evidence of deleted or replaced inodes and of old unbound rows, and keeps live evidence',t=>{
 const {root,file}=fixture(t),db=new DatabaseSync(path.join(root,'proof.sqlite'));t.after(()=>db.close());
 const gone=path.join(root,'gone'),replaced=path.join(root,'replaced');fs.writeFileSync(gone,'gone');fs.writeFileSync(replaced,'old');
 withContentObservation(db,{},observe=>{for(const f of [file,gone,replaced])observe(f);return {};});
 fs.unlinkSync(gone);fs.unlinkSync(replaced);fs.writeFileSync(path.join(root,'spacer'),'x');fs.writeFileSync(replaced,'new');
 const insert=db.prepare('INSERT INTO workspace_inode_content VALUES(?,?)');
 insert.run('1:1:1',JSON.stringify({version:1,observedAt:Date.now()-8*24*H}));insert.run('1:2:1',JSON.stringify({version:1,observedAt:Date.now()}));
 assert.deepEqual(pruneInodeContent(db),{removed:3,kept:2});
 const live=fs.lstatSync(file,{bigint:true});
 assert.deepEqual(db.prepare('SELECT identity FROM workspace_inode_content ORDER BY identity').all().map(r=>r.identity),['1:2:1',`${live.dev}:${live.ino}:${live.birthtimeNs}`].sort());
});
