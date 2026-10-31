import './scratch-env.mjs';
import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {execFileSync} from 'node:child_process';
import {qualifyCustodyImport,exclusiveAllocatedBytes,guardedCustodyImport} from './custody-import-budget.mjs';
test('tiny checkout cannot import whole history; unknown and peak/headroom refuse with zero credit',()=>{
 for(const args of [{exclusiveAllocatedBytes:9863168,importBytes:1771687936,peakBytes:3543375872,freeBytes:19000000000,protectedBytes:8000000000},{exclusiveAllocatedBytes:100,importBytes:null,peakBytes:0,freeBytes:10000,protectedBytes:100},{exclusiveAllocatedBytes:1000,importBytes:100,peakBytes:200,freeBytes:250,protectedBytes:100}])assert.throws(()=>qualifyCustodyImport(args),e=>e.code==='CUSTODY_IMPORT_EXCEEDS_RECLAIM');
 assert.equal(qualifyCustodyImport({exclusiveAllocatedBytes:1000,importBytes:10,peakBytes:20,freeBytes:10000,protectedBytes:1000}).actualPhysicalCreditBytes,0);
});
function fixture(fn){const r=fs.mkdtempSync(path.join(os.tmpdir(),'custody-budget-'));try{fn(r)}finally{fs.rmSync(r,{recursive:true,force:true})}}
const git=(...a)=>execFileSync('git',a,{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
test('exclusive physical allocation excludes hardlinks and symlink targets',()=>fixture(r=>{const outside=path.join(r,'outside');fs.writeFileSync(outside,Buffer.alloc(8192));const inside=path.join(r,'inside');fs.mkdirSync(inside);fs.linkSync(outside,path.join(inside,'linked'));fs.symlinkSync(outside,path.join(inside,'symlink'));assert.equal(exclusiveAllocatedBytes(inside),0);fs.writeFileSync(path.join(inside,'exclusive'),Buffer.alloc(8192));assert.equal(exclusiveAllocatedBytes(inside),fs.statSync(path.join(inside,'exclusive')).blocks*512);}));
test('actual borrowed Git fixture refusal never invokes prepareMirror and preserves all files/refs',()=>fixture(r=>{
 const donor=path.join(r,'donor'),borrower=path.join(r,'borrower'),mirror=path.join(r,'missing-mirror.git');git('init',donor);git('-C',donor,'config','user.name','Fixture');git('-C',donor,'config','user.email','fixture@example.invalid');fs.writeFileSync(path.join(donor,'large'),Buffer.alloc(2*1024*1024,7));git('-C',donor,'add','.');git('-C',donor,'commit','-m','large history');git('-C',donor,'rm','large');fs.writeFileSync(path.join(donor,'tiny'),'tiny');git('-C',donor,'add','.');git('-C',donor,'commit','-m','tiny worktree');git('clone','--shared',donor,borrower);
 fs.mkdirSync(path.join(borrower,'node_modules'));fs.writeFileSync(path.join(borrower,'node_modules/cache'),Buffer.alloc(16*1024*1024));
 const before=git('-C',borrower,'show-ref'),alternate=fs.readFileSync(path.join(borrower,'.git/objects/info/alternates'),'utf8');let called=0;
 assert.throws(()=>guardedCustodyImport(borrower,mirror,()=>called++),e=>e.code==='CUSTODY_IMPORT_EXCEEDS_RECLAIM');assert.equal(called,0);assert.equal(fs.existsSync(mirror),false);assert.equal(git('-C',borrower,'show-ref'),before);assert.equal(fs.readFileSync(path.join(borrower,'.git/objects/info/alternates'),'utf8'),alternate);assert.equal(Number(git('-C',borrower,'cat-file','-s','HEAD~1:large')),2*1024*1024);
}));
test('independent mirror closure avoids duplicate import, admits without claiming credit',()=>fixture(r=>{
 const source=path.join(r,'source'),mirror=path.join(r,'mirror.git');git('init',source);git('-C',source,'config','user.name','Fixture');git('-C',source,'config','user.email','fixture@example.invalid');fs.writeFileSync(path.join(source,'data'),'data');git('-C',source,'add','.');git('-C',source,'commit','-m','data');git('clone','--bare','--no-hardlinks',source,mirror);let called=0;const p=guardedCustodyImport(source,mirror,()=>called++);assert.equal(called,1);assert.equal(p.importBytes,0);assert.equal(p.actualPhysicalCreditBytes,0);
}));
test('actual public cleanup CLI refuses before prepareMirror; normal register stays compatible',{skip:!process.env.WORKSPACE_IMPORT_MODULE},async()=>{
 const {spawnSync}=await import('node:child_process');const {main}=await import(process.env.WORKSPACE_IMPORT_MODULE);
 fixture(r=>{
 const source=path.join(r,'source'),borrower=path.join(r,'borrower'),state=path.join(r,'state/registry.sqlite3');git('init',source);git('-C',source,'config','user.name','Fixture');git('-C',source,'config','user.email','fixture@example.invalid');fs.writeFileSync(path.join(source,'tiny'),'tiny');git('-C',source,'add','.');git('-C',source,'commit','-m','tiny');
 git('clone','--shared',source,borrower);
 // Existing active create/register semantics must not inherit the cleanup-only gate.
 let out='';const write=process.stdout.write;process.stdout.write=x=>{out+=x;return true};try{main(['register','--path',borrower,'--root',r,'--owner','fixture','--json'],state)}finally{process.stdout.write=write}
 assert.ok(JSON.parse(out).id);
 // Restore a non-durable borrowed store after compatible registration, then grow its
 // complete object inventory without changing branches or any published operation.
 fs.writeFileSync(path.join(borrower,'.git/objects/info/alternates'),path.join(source,'.git/objects')+'\n');
 execFileSync('git',['-C',source,'hash-object','-w','--stdin'],{input:Buffer.alloc(2*1024*1024,7)});
 const config=fs.readFileSync(path.join(borrower,'.git/config')),alt=fs.readFileSync(path.join(borrower,'.git/objects/info/alternates'));const mirrors=path.join(r,'state/mirrors');const before=fs.readdirSync(mirrors).map(n=>[n,fs.statSync(path.join(mirrors,n,'config')).mtimeMs]);
 const result=spawnSync(process.execPath,[new URL(process.env.WORKSPACE_IMPORT_MODULE).pathname,'reconcile','--root',r,'--execute','--reap-expired','--preserve-runtime','--json'],{encoding:'utf8',timeout:10000,env:{...process.env,PI_WORKSPACE_STATE:state,PI_WORKSPACE_TEST_EXTERNAL_SAFETY:'empty'}});
 assert.match(result.stdout+result.stderr,/CUSTODY_IMPORT_EXCEEDS_RECLAIM|Closed source cleanup would amplify disk usage/);
 assert.equal(fs.existsSync(borrower),true);assert.deepEqual(fs.readFileSync(path.join(borrower,'.git/config')),config);assert.deepEqual(fs.readFileSync(path.join(borrower,'.git/objects/info/alternates')),alt);assert.deepEqual(fs.readdirSync(mirrors).map(n=>[n,fs.statSync(path.join(mirrors,n,'config')).mtimeMs]),before);
 });
});
