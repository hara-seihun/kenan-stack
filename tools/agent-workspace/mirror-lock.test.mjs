import './scratch-env.mjs';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,readdirSync,existsSync,chmodSync,rmSync,statSync} from 'node:fs';
import {execFileSync,spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {capacityRecovery} from './capacity-recovery.mjs';
const entry=new URL('./main',import.meta.url).pathname;
const obs={observedAt:Date.now(),device:'2049',freeBytes:100000000000,freeInodes:100,totalInodes:200};
test('only exact request-bound mirror acquisition exhausted wait recovers',()=>{
 const mirror='/tmp/owned-mirror.git';
 for(const code of ['source-preparation-failed','workspace-mirror-lock-busy']){
  const old={state:'failed',error:{code,message:`workspace resource busy: mirror:${mirror}: 30000ms lock budget exhausted`}};
  const result=capacityRecovery(old,'a'.repeat(64),obs,mirror);
  assert.equal(result.state,'retry');assert.equal(result.value.cause,'pre-import-mirror-lock');assert.deepEqual(result.value.originalRefusal,old.error);
  for(const expected of [undefined,'/tmp/different.git'])assert.equal(capacityRecovery(old,'a'.repeat(64),obs,expected).state,'terminal');
 }
 for(const message of [`workspace resource busy: mirror:${mirror}: spawnSync flock ETIMEDOUT`,`workspace resource busy: mirror:${mirror}: 30000ms lock budget exhausted\nother`,`source import capacity settlement failed; original liability retained: workspace resource busy: mirror:${mirror}: 30000ms lock budget exhausted`,'git import failed'])
  assert.equal(capacityRecovery({state:'failed',error:{code:'source-preparation-failed',message}},'a'.repeat(64),obs,mirror).state,'terminal');
});
for (const legacy of [false,true]) test(`same create request survives ${legacy?'legacy':'typed'} pre-import mirror lock failure without replaying terminal or duplicate import`,()=>{
 const root=mkdtempSync(path.join(tmpdir(),'mirror-lock-'));
 try {
  const source=path.join(root,'source'),bin=path.join(root,'bin'),state=path.join(root,'state','registry.sqlite3'),workspaces=path.join(root,'workspaces');
  mkdirSync(source);mkdirSync(bin);mkdirSync(workspaces);
  const git=(...args)=>execFileSync('git',['-C',source,...args],{encoding:'utf8'}).trim();
  git('init','-b','main');git('config','user.name','Test');git('config','user.email','test@example.invalid');writeFileSync(path.join(source,'file'),'source');git('add','.');git('commit','-m','source');
  const commit=git('rev-parse','HEAD'),mirror=path.join(root,'state','mirrors',createHash('sha256').update(source).digest('hex').slice(0,24)+'.git'),lock=createHash('sha256').update(`mirror:${mirror}`).digest('hex');
  const realFlock=execFileSync('which',['flock'],{encoding:'utf8'}).trim(),realGit=execFileSync('which',['git'],{encoding:'utf8'}).trim();
  const marker=path.join(root,'failed-once'),imports=path.join(root,'imports');
  writeFileSync(path.join(bin,'flock'),`#!${process.execPath}\nconst fs=require('node:fs'),cp=require('node:child_process');if(process.env.PI_WORKSPACE_SOURCE_JOB_DIR&&fs.readlinkSync('/proc/self/fd/3').endsWith(${JSON.stringify(lock)})&&!fs.existsSync(${JSON.stringify(marker)})){fs.writeFileSync(${JSON.stringify(marker)},'failed');process.exit(1);}const r=cp.spawnSync(${JSON.stringify(realFlock)},process.argv.slice(2),{stdio:['inherit','inherit','inherit',3]});process.exit(r.status??1);`);
  writeFileSync(path.join(bin,'git'),`#!${process.execPath}\nconst fs=require('node:fs'),cp=require('node:child_process'),a=process.argv.slice(2);if(a.includes('update-ref')&&a.some(x=>x.startsWith('refs/pi-workspace/sources/')))fs.appendFileSync(${JSON.stringify(imports)},JSON.stringify(a)+'\\n');const r=cp.spawnSync(${JSON.stringify(realGit)},a,{stdio:'inherit'});process.exit(r.status??1);`);
  chmodSync(path.join(bin,'git'),0o755);chmodSync(path.join(bin,'flock'),0o755);
  const env={...process.env,PATH:`${bin}:${process.env.PATH}`,PI_WORKSPACE_STATE:state,PI_WORKSPACE_TEST_EXTERNAL_SAFETY:'empty'};
  const args=['create','--root',workspaces,'--name','writer','--repo',source,'--ref',commit,'--owner','fixture','--intent','source-only','--headroom-gib','8','--growth-mib','512','--json'];
  const invoke=()=>spawnSync(entry,args,{env,encoding:'utf8',timeout:45000});
  invoke();
  const prep=path.join(root,'state','source-preparations'),pointer=path.join(prep,readdirSync(prep).find(n=>n.endsWith('.job.json'))),oldId=JSON.parse(readFileSync(pointer)).jobId,oldDir=path.join(prep,'jobs',oldId);
  const deadline=Date.now()+45000;
  while(!existsSync(path.join(oldDir,'result.json'))&&Date.now()<deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,50);
  assert.match(readFileSync(path.join(oldDir,'result.json'),'utf8'),/workspace-mirror-lock-busy/);
  // Model a receipt emitted by the earlier deployed worker; only fixture state is changed.
  if (legacy) {const old=JSON.parse(readFileSync(path.join(oldDir,'result.json')));old.error.code='source-preparation-failed';writeFileSync(path.join(oldDir,'result.json'),JSON.stringify(old)+'\n');}
  const terminal=readFileSync(path.join(oldDir,'result.json'),'utf8');assert.equal(existsSync(imports),false);
  let result;
  do {result=invoke();if(result.status===0)break;assert.equal(result.status,75,result.stderr);Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,50);}while(Date.now()<deadline);
  assert.equal(result.status,0,result.stderr);const record=JSON.parse(result.stdout);assert.equal(record.state,'active');assert.equal(record.sourceCommit,commit);
  assert.equal(readFileSync(path.join(oldDir,'result.json'),'utf8'),terminal);assert.equal(JSON.parse(readFileSync(path.join(oldDir,'attempt.json'))).number,1);
  const next=JSON.parse(readFileSync(pointer));assert.notEqual(next.jobId,oldId);assert.equal(next.recovery.previousJobId,oldId);
  assert.equal(readFileSync(imports,'utf8').trim().split('\n').length,1);
  assert.equal(JSON.parse(invoke().stdout).id,record.id);assert.equal(readFileSync(imports,'utf8').trim().split('\n').length,1);
 }finally{rmSync(root,{recursive:true,force:true});}
});
