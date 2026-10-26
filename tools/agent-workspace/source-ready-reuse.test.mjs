import './scratch-env.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const {workspaceTesting:w}=await import(process.env.WORKSPACE_READY_MODULE ?? './workspace.mjs');

function fixture() {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'workspace-ready-'));
 const repository=path.join(root,'repo'),mirror=path.join(root,'mirror.git');fs.mkdirSync(repository);
 const git=(dir,...args)=>execFileSync('git',['-C',dir,...args],{encoding:'utf8',timeout:5000}).trim();
 git(repository,'init','-q');git(repository,'config','user.name','Fixture');git(repository,'config','user.email','fixture@example.invalid');
 fs.writeFileSync(path.join(repository,'file'),'original');git(repository,'add','.');git(repository,'commit','-qm','original');
 execFileSync('git',['clone','--bare',repository,mirror],{stdio:'ignore',timeout:5000});
 const sourceCommit=git(repository,'rev-parse','HEAD');
 return {root,repository,mirror,sourceCommit,git,close:()=>fs.rmSync(root,{recursive:true,force:true})};
}

test('READY reuses original job and immutable plan after unrelated mirror churn, without import or capacity mutation',()=>{
 const f=fixture();try{
  const input={statePath:path.join(f.root,'state','registry.sqlite3'),root:f.root,destination:path.join(f.root,'writer'),repository:f.repository,ref:'HEAD',upstream:{fetch:f.repository,push:f.repository,explicitPush:false},mirror:f.mirror,intent:{intent:'source-only',growthBytes:536870912,headroomBytes:8589934592},sparsePatterns:[]};
  const args={named:new Map([['repo',[f.repository]]])};
  const request={...input,sourceCommit:f.sourceCommit,args:[...args.named],capacityPricingVersion:4};
  const key=createHash('sha256').update(JSON.stringify(request)).digest('hex'),directory=path.join(f.root,'state','source-preparations');
  const jobId='a'.repeat(64),job=path.join(directory,'jobs',jobId);fs.mkdirSync(job,{recursive:true});
  const plan={sourceCommit:f.sourceCommit,constructionBytes:123456,growthBytes:536870912,headroomBytes:8589934592};
  const value={sourceCommit:f.sourceCommit,plan,stamp:'previous-object-store-stamp'};
  const original=JSON.stringify({state:'ready',value});fs.writeFileSync(path.join(job,'result.json'),original);
  const pointer=JSON.stringify({initialStamp:'previous-object-store-stamp',jobId});fs.writeFileSync(path.join(directory,key+'.job.json'),pointer);
  // Unrelated loose object changes the stamp, but not the immutable source closure.
  f.git(f.mirror,'hash-object','-w','--stdin');
  const database=new Proxy({}, {get:()=>assert.fail('READY reuse must not import or mutate capacity')});
  for(let round=0;round<3;round++){
   f.git(f.mirror,'config','fixture.round',String(round));
   const result=w.prepareCreationSource(database,args,input);
   assert.equal(result.state,'ready');assert.equal(result.value.sourceCommit,f.sourceCommit);assert.deepEqual(result.value.plan,plan);
   assert.equal(fs.readFileSync(path.join(job,'result.json'),'utf8'),original);
   assert.equal(fs.readFileSync(path.join(directory,key+'.job.json'),'utf8'),pointer);
   assert.deepEqual(fs.readdirSync(path.join(directory,'jobs')),[jobId]);
  }
 }finally{f.close();}
});

test('READY closure refresh refuses missing objects, alternate custody, changed commit and checkout filters',()=>{
 const f=fixture();try{
  const input={repository:f.repository,mirror:f.mirror,sparsePatterns:[]},value={sourceCommit:f.sourceCommit,plan:{sourceCommit:f.sourceCommit},stamp:'old'};
  assert.ok(w.revalidatePreparedSource(value,input,f.sourceCommit));
  assert.equal(w.revalidatePreparedSource(value,input,'b'.repeat(40)),null);
  f.git(f.repository,'config','filter.bad.smudge','cat');assert.throws(()=>w.revalidatePreparedSource(value,input,f.sourceCommit),/checkout filters/);f.git(f.repository,'config','--unset','filter.bad.smudge');
  fs.writeFileSync(path.join(f.mirror,'objects/info/alternates'),path.join(f.repository,'.git/objects')+'\n');assert.equal(w.revalidatePreparedSource(value,input,f.sourceCommit),null);fs.unlinkSync(path.join(f.mirror,'objects/info/alternates'));
  const tree=f.git(f.mirror,'rev-parse','HEAD^{tree}'),object=path.join(f.mirror,'objects',tree.slice(0,2),tree.slice(2)),originalObject=fs.readFileSync(object);
  fs.writeFileSync(object,'corrupt tree object');fs.rmSync(path.join(f.mirror,'pi-workspace-closure'),{recursive:true,force:true});
  assert.equal(w.revalidatePreparedSource(value,input,f.sourceCommit),null,'corrupt exact-commit custody refuses');
  fs.writeFileSync(object,originalObject);fs.unlinkSync(object);
  // Remove stale memo: changing a loose object's parent metadata alone is not covered by a nested unlink.
  fs.rmSync(path.join(f.mirror,'pi-workspace-closure'),{recursive:true,force:true});
  assert.equal(w.revalidatePreparedSource(value,input,f.sourceCommit),null);
 }finally{f.close();}
});

test('real 1500 ms deadline resumes durable READY proof with 9000 paths and mirror churn', {timeout:30000}, async()=>{
 const f=fixture(),oldPath=process.env.PATH;try{
  // Exercise the actual foreground command deadline, not a mocked validator.
  for(let i=0;i<9000;i++)fs.writeFileSync(path.join(f.repository,`path-${i}`),`blob-${i}`);
  f.git(f.repository,'add','.');f.git(f.repository,'commit','-qm','9000 paths');
  f.sourceCommit=f.git(f.repository,'rev-parse','HEAD');f.git(f.mirror,'fetch',f.repository,'HEAD');
  const bin=path.join(f.root,'bin');fs.mkdirSync(bin);
  const real=execFileSync('which',['git'],{encoding:'utf8'}).trim();
  const trace=path.join(f.root,'trace');
  fs.writeFileSync(path.join(bin,'git'),`#!${process.execPath}
const {spawnSync}=require('node:child_process');const fs=require('node:fs');const a=process.argv.slice(2);
if(a.includes('rev-list')){fs.appendFileSync(${JSON.stringify(trace)},'closure\\n');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,4500);}
if(a.includes('fetch')){fs.appendFileSync(${JSON.stringify(trace)},'IMPORT\\n');}
const r=spawnSync(${JSON.stringify(real)},a,{stdio:'inherit'});process.exit(r.status??1);
`);fs.chmodSync(path.join(bin,'git'),0o755);process.env.PATH=bin+':'+oldPath;
  const input={statePath:path.join(f.root,'state','registry.sqlite3'),root:f.root,destination:path.join(f.root,'writer'),repository:f.repository,ref:'HEAD',upstream:{fetch:f.repository,push:f.repository,explicitPush:false},mirror:f.mirror,intent:{intent:'source-only',growthBytes:536870912,headroomBytes:8589934592},sparsePatterns:[]};
  const args={named:new Map([['repo',[f.repository]]])};
  const request={...input,sourceCommit:f.sourceCommit,args:[...args.named],capacityPricingVersion:4};
  const key=createHash('sha256').update(JSON.stringify(request)).digest('hex'),directory=path.join(f.root,'state','source-preparations');
  const jobId='c'.repeat(64),job=path.join(directory,'jobs',jobId);fs.mkdirSync(job,{recursive:true});
  const plan={sourceCommit:f.sourceCommit,constructionBytes:123456,growthBytes:536870912,headroomBytes:8589934592};
  const value={sourceCommit:f.sourceCommit,plan,stamp:'original-stamp'};
  const original=JSON.stringify({state:'ready',value});fs.writeFileSync(path.join(job,'result.json'),original);
  const pointer=JSON.stringify({initialStamp:'original-stamp',jobId});fs.writeFileSync(path.join(directory,key+'.job.json'),pointer);
  const database=new Proxy({}, {get:()=>assert.fail('READY proof must not mutate capacity or import')});
  f.git(f.mirror,'config','fixture.round','before');
  const started=Date.now(),first=w.prepareCreationSource(database,args,input);
  assert.equal(first.state,'pending');assert.ok(Date.now()-started>=1500,'actual foreground budget expired');
  f.git(f.mirror,'config','fixture.round','during');
  const second=w.prepareCreationSource(database,args,input);
  assert.equal(second.state,'pending');assert.equal(second.jobId,first.jobId,'mirror churn keeps in-flight continuation');
  const child=path.join(directory,'jobs',first.jobId,'result.json');
  for(let n=0;n<100&&!fs.existsSync(child);n++)await new Promise(r=>setTimeout(r,100));
  assert.ok(fs.existsSync(child),'durable worker completed without foreground deadline');
  assert.equal(JSON.parse(fs.readFileSync(child)).state,'ready');
  const ready=w.prepareCreationSource(database,args,input);
  assert.equal(ready.state,'ready');assert.deepEqual(ready.value.plan,plan);
  assert.equal(fs.readFileSync(path.join(job,'result.json'),'utf8'),original);
  assert.equal(fs.readFileSync(path.join(directory,key+'.job.json'),'utf8'),pointer);
  assert.equal(fs.readdirSync(path.join(directory,'jobs')).length,2,'only original and one read-only continuation');
  assert.ok(!fs.readFileSync(trace,'utf8').includes('IMPORT'));
  process.env.PATH=oldPath;
  const changedArgs={named:new Map([...args.named,['sparse-pattern',['/file']]])};
  const changedInput={...input,sparsePatterns:['/file']};
  assert.throws(()=>w.prepareCreationSource(database,changedArgs,changedInput),/READY proof must not mutate capacity or import/,
   'different arguments cannot inherit the original READY plan');
  assert.equal(fs.readFileSync(path.join(directory,key+'.job.json'),'utf8'),pointer);
 }finally{process.env.PATH=oldPath;f.close();}
});

test('same original create reaches admitted checkout under continuous unrelated mirror churn', {timeout:55000}, async()=>{
 const f=fixture();let churn;try{
  for(let i=0;i<9000;i++)fs.writeFileSync(path.join(f.repository,`path-${i}`),`blob-${i}`);
  f.git(f.repository,'add','.');f.git(f.repository,'commit','-qm','9000 admission paths');
  f.sourceCommit=f.git(f.repository,'rev-parse','HEAD');f.git(f.mirror,'fetch',f.repository,'HEAD');
  const statePath=path.join(f.root,'state','registry.sqlite3'),root=path.join(f.root,'writers');fs.mkdirSync(root);
  const upstream=w.repositoryRemotes(f.repository),mirror=path.join(path.dirname(statePath),'mirrors',createHash('sha256').update(upstream.fetch).digest('hex').slice(0,24)+'.git');
  fs.mkdirSync(path.dirname(mirror),{recursive:true});fs.renameSync(f.mirror,mirror);
  const named=new Map([['root',[root]],['name',['writer']],['repo',[f.repository]],['ref',[f.sourceCommit]],['owner',['continuous-churn-fixture']],['mode',['writer']],['intent',['source-only']],['headroom-gib',['8']],['growth-mib',['512']],['json',['true']]]);
  const intent={intent:'source-only',headroomBytes:8589934592,growthBytes:536870912};
  const input={statePath,root,destination:path.join(root,'writer'),repository:f.repository,ref:f.sourceCommit,upstream,mirror,intent,sparsePatterns:[]};
  const plan=w.sourceCapacityPlan(f.repository,f.sourceCommit,intent,fs.statfsSync(root).bsize,mirror,[]);
  const request={...input,sourceCommit:f.sourceCommit,args:[...named],capacityPricingVersion:4};
  const key=createHash('sha256').update(JSON.stringify(request)).digest('hex'),directory=path.join(path.dirname(statePath),'source-preparations');
  const jobId='d'.repeat(64),job=path.join(directory,'jobs',jobId);fs.mkdirSync(job,{recursive:true});
  const original=JSON.stringify({state:'ready',value:{sourceCommit:f.sourceCommit,plan,stamp:'original'}});
  fs.writeFileSync(path.join(job,'result.json'),original);
  const pointer=JSON.stringify({initialStamp:'original',jobId});fs.writeFileSync(path.join(directory,key+'.job.json'),pointer);
  fs.rmSync(path.join(mirror,'pi-workspace-closure'),{recursive:true,force:true});
  const bin=path.join(f.root,'bin');fs.mkdirSync(bin);const real=execFileSync('which',['git'],{encoding:'utf8'}).trim(),trace=path.join(f.root,'trace');
  fs.writeFileSync(path.join(bin,'git'),`#!${process.execPath}
const {spawnSync}=require('node:child_process');const fs=require('node:fs');const a=process.argv.slice(2);
if(a.includes('rev-list'))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,2200);
if(a.includes('fetch'))fs.appendFileSync(${JSON.stringify(trace)},'IMPORT\\n');
const r=spawnSync(${JSON.stringify(real)},a,{stdio:'inherit'});process.exit(r.status??1);
`);fs.chmodSync(path.join(bin,'git'),0o755);
  const {spawn,spawnSync}=await import('node:child_process');
  churn=spawn(process.execPath,['-e',`const {spawnSync}=require('node:child_process');let n=0;setInterval(()=>spawnSync(${JSON.stringify(real)},['--git-dir',${JSON.stringify(mirror)},'config','fixture.churn',String(n++)]),15);`],{stdio:'ignore'});
  const entry=process.env.WORKSPACE_READY_MODULE??new URL('./workspace.mjs',import.meta.url).pathname;
  const args=['create',...[...named].flatMap(([k,vs])=>vs.flatMap(v=>['--'+k,v]))];
  const env={...process.env,PI_WORKSPACE_STATE:statePath,PI_WORKSPACE_TEST_EXTERNAL_SAFETY:'empty',PATH:bin+':'+process.env.PATH};
  let receipt,firstJob;const deadline=Date.now()+45000;
  do {
   const result=spawnSync(process.execPath,[entry,...args],{env,encoding:'utf8',timeout:20000});
   assert.ok(result.status===0||result.status===75,result.stderr);
   receipt=JSON.parse(result.stdout);if(receipt.state==='preparing')firstJob??=receipt.jobId;
   if(receipt.state==='active'||receipt.state===undefined)break;
   await new Promise(r=>setTimeout(r,100));
  }while(Date.now()<deadline);
  assert.ok(fs.existsSync(path.join(root,'writer','.git')),'same create completed its checkout while churn continues');
  const database=w.openRegistry(statePath);
  const row=database.prepare('SELECT * FROM workspace WHERE path=?').get(input.destination);
  assert.equal(row.state,'active');assert.equal(row.source_commit,f.sourceCommit);
  const admitted=JSON.parse(database.prepare('SELECT plan_json FROM workspace_capacity WHERE workspace_id=?').get(row.id).plan_json);
  const {admission,completedAllocationBytes,...actualPlan}=admitted;assert.deepEqual(actualPlan,plan);assert.ok(admission);
  database.close();assert.ok(firstJob,'actual foreground deadline delegated continuation');
  assert.equal(fs.readFileSync(path.join(job,'result.json'),'utf8'),original);
  assert.equal(fs.readFileSync(path.join(directory,key+'.job.json'),'utf8'),pointer);
  assert.equal(fs.readdirSync(path.join(directory,'jobs')).length,2,'original source and exactly one admission continuation');
  assert.ok(!fs.existsSync(trace),'no duplicate import');
  assert.equal(f.git(input.destination,'rev-parse','HEAD'),f.sourceCommit);
 }finally{if(churn){churn.kill('SIGKILL');await new Promise(r=>churn.once('exit',r));}f.close();}
});
