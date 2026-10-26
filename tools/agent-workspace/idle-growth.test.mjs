import './scratch-env.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {assertIdleGrowth,assertIdleObservation} from './idle-growth.mjs';
import {allocationSlice} from './incremental-allocation.mjs';
import {main} from './workspace.mjs';
const now=10_000_000;
const base=()=>({now,record:{state:'active',path:'/source',createdAt:0},plan:{intent:'budgeted',growthBytes:100},planSha256:'hash',sample:{ok:true,rootPath:'/source',planSha256:'hash',device:'1',inode:'2',startedAt:now-100,completedAt:now-10,bytes:10,allocatedBytes:10,lastWriteAt:now-3600001},history:{planGrowthBytes:100,allocationBinding:{rootPath:'/source',planSha256:'hash',device:'1',inode:'2'},samples:[{at:now-1000,bytes:10},{at:now-10,bytes:10}]},safety:{references:[],errors:[]}});
test('idle promise retirement distinguishes actual last write from sample allocation stability',()=>assert.doesNotThrow(()=>assertIdleGrowth(base())));
for(const [name,mutate,code] of [
 ['active process',v=>v.safety.references.push({pid:8}),'idle-growth-active'],
 ['active unit',v=>v.safety.references.push({id:'writer.service'}),'idle-growth-active'],
 ['native execution',v=>v.safety.references.push({kind:'tool_call',state:'running'}),'idle-growth-active'],
 ['unknown execution',v=>v.safety.errors.push('census failed'),'idle-growth-active'],
 ['growth',v=>v.history.samples[0].bytes--,'idle-growth-unstable'],
 ['missing sample',v=>v.history.samples.shift(),'idle-growth-unstable'],
 ['same sample twice',v=>v.history.samples[0].at=v.history.samples[1].at,'idle-growth-unstable'],
 ['recent same-size write',v=>v.sample.lastWriteAt=now-100,'idle-growth-recent-write'],
 ['missing last write',v=>delete v.sample.lastWriteAt,'idle-growth-recent-write'],
 ['fresh resumed admission',v=>v.history.restoreAt=now-1,'idle-growth-recent-write'],
 ['different source plan',v=>v.sample.planSha256='other','idle-growth-sample-required'],
 ['different root',v=>v.history.allocationBinding.inode='3','idle-growth-sample-required'],
 ['stale observation',v=>v.sample.startedAt=now-900001,'idle-growth-sample-required'],
])test(`idle promise retains ${name}`,()=>{const v=base();mutate(v);assert.throws(()=>assertIdleGrowth(v),{code});});
test('final observation rejects a new same-size write or root replacement',()=>{
 const s=base().sample;assert.doesNotThrow(()=>assertIdleObservation(s,s));
 for(const k of ['lastWriteAt','bytes','allocatedBytes','device','inode'])assert.throws(()=>assertIdleObservation(s,{...s,[k]:s[k]+1}),{code:'idle-growth-write-race'});
});
test('resumable complete observation measures actual inode ctime, not merely directory mtime',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'idle-write-'));
 try{const f=path.join(dir,'state');fs.writeFileSync(f,'same-size');fs.utimesSync(f,1,1);const d=String(fs.statSync(dir).dev);const s=allocationSlice(dir,d,null,{maxEntries:1});const done=allocationSlice(dir,d,s.state);assert.equal(done.ok,true);assert.ok(done.lastWriteAt>=Math.floor(fs.statSync(f).ctimeMs));assert.ok(done.lastWriteAt>Date.now()-1000);}finally{fs.rmSync(dir,{recursive:true,force:true});}
});

// Real Git and SQLite with isolated external execution. The source is deliberately
// dirty and unpublished; promise retirement must not require deleting or publishing it.
test('automatic sweep retires only future demand, preserves bytes, advances cursor and fences new writers',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'idle-cli-')),state=path.join(root,'registry.sqlite3');
 const prior={...process.env};process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY='empty';
 const run=args=>{let out='';const write=process.stdout.write,exit=process.exitCode;process.stdout.write=c=>{out+=c;return true;};try{main(args,state);return JSON.parse(out);}finally{process.stdout.write=write;process.exitCode=exit;}};
 const git=(...a)=>execFileSync('git',a,{encoding:'utf8',timeout:5000}).trim();
 try{
 const source=path.join(root,'source');fs.mkdirSync(source);git('init','-b','main',source);git('-C',source,'config','user.name','Fixture');git('-C',source,'config','user.email','fixture@example.invalid');fs.writeFileSync(path.join(source,'proof'),'valuable source');git('-C',source,'add','.');git('-C',source,'commit','-m','proof');fs.appendFileSync(path.join(source,'proof'),' dirty');
 const head=git('-C',source,'rev-parse','HEAD');const rec=run(['register','--path',source,'--root',root,'--owner','owner','--source-commit',head,'--intent','source-only','--growth-mib','512','--headroom-gib','8','--json']);
 const db=new DatabaseSync(state);db.prepare('UPDATE workspace SET created_at=? WHERE id=?').run(Date.now()-7200000,rec.id);
 // Actual real inode ctime is recent, so two equal-byte samples alone do not qualify.
 run(['measure-capacity','--id',rec.id,'--budget-ms','3000','--json']);
 const sweep=()=>run(['retire-idle-growth','--root',root,'--budget-ms','3000','--max-records','1','--json']);
 const held=sweep();assert.equal(held.retiredCount,0);assert.equal(held.results[0].code,'idle-growth-recent-write');
 assert.equal(db.prepare('SELECT after_id FROM workspace_idle_growth_cursor WHERE scope=?').get(root).after_id,rec.id);
 assert.equal(fs.readFileSync(path.join(source,'proof'),'utf8'),'valuable source dirty');
 // The positive transition is exercised with an injected clock, not fake inode
 // evidence: age the real complete observation while retaining freshness at walk.
 const actual=Date.now;Date.now=()=>actual()+7200000;
 let result;try{result=sweep();}finally{Date.now=actual;}
 assert.equal(result.retiredCount,1);assert.equal(result.retiredPromiseBytes,512*1024**2);
 assert.equal(fs.readFileSync(path.join(source,'proof'),'utf8'),'valuable source dirty');assert.equal(git('-C',source,'rev-parse','HEAD'),head);
 const plan=JSON.parse(db.prepare('SELECT plan_json FROM workspace_capacity WHERE workspace_id=?').get(rec.id).plan_json);assert.equal(plan.growthBytes,512*1024**2);assert.equal(plan.growthLifecycle.remainingGrowthBytes,0);
 const after=db.prepare('SELECT * FROM workspace WHERE id=?').get(rec.id);assert.equal(after.lease_expires_at,0);assert.equal(after.owner,'owner');
 assert.throws(()=>run(['heartbeat','--id',rec.id,'--json']),{code:'growth-admission-required'});
 assert.throws(()=>run(['writer-run','--id',rec.id,'--path',source,'--owner','owner','--expected-head',head,'--command-json','["true"]','--timeout-ms','1000','--json']));
 assert.equal(sweep().retiredCount,0);db.close();
 }finally{for(const k of Object.keys(process.env))if(!(k in prior))delete process.env[k];Object.assign(process.env,prior);fs.rmSync(root,{recursive:true,force:true});}
});
test('maintenance capability launcher preserves sudo observer elevation instead of truncating its bounding set',()=>{
 const text=fs.readFileSync(new URL('./idle-growth-run',import.meta.url),'utf8');
 assert.ok(text.includes('--reuid="$uid" --regid="$gid"'));
 assert.ok(text.includes('--ambient-caps=+dac_read_search'));
 assert.ok(!text.includes('--bounding-set=-all'));
});
test('target-only measurement does not initiate an unrelated idle sweep',()=>{
 const text=fs.readFileSync(new URL('./workspace.mjs',import.meta.url),'utf8');
 assert.ok(text.includes('const idleGrowth = selected===null ? retireIdleGrowthCommand'));
});
