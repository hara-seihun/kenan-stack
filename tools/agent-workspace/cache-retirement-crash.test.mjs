import './scratch-env.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync,spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {fileURLToPath} from 'node:url';
import {main,workspaceTesting} from './workspace.mjs';
import {retireWorkspaceCache} from './cache-retirement.mjs';

function context(db,state,record){
 return {database:db,stateDirectory:path.dirname(state),deadline:Date.now()+30000,binding:()=>workspaceTesting.cacheBinding(db,record.id),classify:request=>workspaceTesting.classifyWorkspaceCache({...record,leaseExpiresAt:0},request),tracked:()=>false,original:()=>({record:db.prepare('SELECT * FROM workspace WHERE id=?').get(record.id)}),invalidate:()=>{},safety:()=>({errors:[],references:[],retainedBorrowers:[],observedAt:Date.now()})};
}

if(process.env.CACHE_CRASH_CHILD){
 const {state,record,request,crashAt}=JSON.parse(process.env.CACHE_CRASH_CHILD);
 const db=new DatabaseSync(state),c=context(db,state,record),crash=()=>process.kill(process.pid,'SIGKILL');
 if(crashAt==='before-move')c.invalidate=crash;
 else if(crashAt==='after-move')c.afterRename=crash;
 else {let removed=0;c.afterEntryRemoval=()=>{if(++removed===40)crash();};}
 const result=retireWorkspaceCache(c,request);
 console.log(JSON.stringify(result));process.exit(3);
}

function fixture(action){
 const base=fs.mkdtempSync(path.join(tmpdir(),'cache-crash-')),root=path.join(base,'source'),state=path.join(base,'state.sqlite3');fs.mkdirSync(root);
 const git=(...args)=>execFileSync('git',['-C',root,...args],{encoding:'utf8',timeout:5000,stdio:['ignore','pipe','pipe']}).trim();
 const run=args=>{const original=process.stdout.write,code=process.exitCode;let text='';process.stdout.write=x=>{text+=x;return true;};try{main(args,state);}finally{process.stdout.write=original;process.exitCode=code;}return JSON.parse(text);};
 let db;
 try{
  git('init','-b','main');git('config','user.email','fixture@example.invalid');git('config','user.name','Fixture');
  fs.writeFileSync(path.join(root,'.gitignore'),'node_modules/\n');fs.writeFileSync(path.join(root,'package.json'),'{}');fs.writeFileSync(path.join(root,'package-lock.json'),'{}');fs.writeFileSync(path.join(root,'source.ts'),'original');git('add','.');git('commit','-m','unpublished');
  const record=run(['register','--path',root,'--root',base,'--owner','fixture','--source-commit',git('rev-parse','HEAD'),'--json']);
  db=new DatabaseSync(state);db.prepare('UPDATE workspace SET lease_expires_at=0 WHERE id=?').run(record.id);
  const cache=path.join(root,'node_modules'),external=path.join(base,'external');fs.writeFileSync(external,'x'.repeat(9000));
  for(let d=0;d<4;d++){const dir=path.join(cache,'dep-'+d);fs.mkdirSync(dir,{recursive:true});for(let i=0;i<60;i++)fs.writeFileSync(path.join(dir,'f'+i),'y'.repeat(5000));}
  fs.linkSync(external,path.join(cache,'shared-hardlink'));
  let expected=0;const walk=p=>{const s=fs.lstatSync(p);if(s.isDirectory()){expected+=s.blocks*512;for(const n of fs.readdirSync(p))walk(path.join(p,n));}else if(s.nlink===1)expected+=s.blocks*512;};walk(cache);
  const request={kind:'retire-workspace-cache',operationId:'crash-resume-fixture',binding:workspaceTesting.cacheBinding(db,record.id),cachePath:'node_modules',classification:'node-dependencies',ownerEvidence:'fixture actor ended; dependencies regenerable'};
  const requestFile=path.join(base,'request.json');fs.writeFileSync(requestFile,JSON.stringify(request));
  action({base,root,cache,external,state,db,record,request,requestFile,expected,run});
 }finally{db?.close();fs.rmSync(base,{recursive:true,force:true});}
}

for(const crashAt of ['before-move','after-move','mid-delete'])test(`SIGKILL ${crashAt}: same request resumes, deletes only its staging, reports freed bytes, then replays`,()=>fixture(f=>{
 const child=spawnSync(process.execPath,[fileURLToPath(import.meta.url)],{env:{...process.env,NODE_TEST_CONTEXT:'',CACHE_CRASH_CHILD:JSON.stringify({state:f.state,record:f.record,request:f.request,crashAt})},encoding:'utf8',timeout:30000});
 assert.equal(child.signal,'SIGKILL',child.stdout+child.stderr);
 const journal=JSON.parse(f.db.prepare('SELECT journal_json FROM workspace_generated_retirement').get().journal_json),stage=journal.entries[0].stage;
 assert.equal(journal.state,'pending');
 assert.equal(fs.existsSync(f.cache),crashAt==='before-move');assert.equal(fs.existsSync(stage),crashAt!=='before-move');

 const status=f.run(['retire-cache-status','--stage',path.basename(stage),'--json']);
 assert.equal(status.value.operations.length,1);const pending=status.value.operations[0];
 assert.equal(pending.state,'pending');assert.equal(pending.owner,'fixture');assert.deepEqual(JSON.parse(pending.storedRequest),f.request);assert.match(pending.resume.command,/--request-sha256 [0-9a-f]{64}/);

 const c=context(f.db,f.state,f.record);
 assert.equal(retireWorkspaceCache(c,{...f.request,ownerEvidence:'different bytes'}).error.code,'cache-operation-conflict');
 assert.equal(retireWorkspaceCache(c,{...f.request,operationId:'another-operation'}).error.code,'generated-operation-conflict');
 const foreign=f.run(['retire-cache','--id',f.record.id,'--path',f.root,'--owner','someone-else','--request',f.requestFile,'--request-sha256','0'.repeat(64),'--json']);
 assert.equal(foreign.error.code,'cache-owner-changed',JSON.stringify(foreign));assert.equal(fs.existsSync(crashAt==='before-move'?f.cache:stage),true);

 const resumed=retireWorkspaceCache(c,f.request);
 assert.equal(resumed.ok,true,JSON.stringify(resumed));assert.equal(resumed.value.replayed,false);
 assert.equal(fs.existsSync(stage),false);assert.equal(fs.existsSync(f.cache),false);
 assert.equal(fs.readFileSync(f.external,'utf8').length,9000);assert.equal(fs.readFileSync(path.join(f.root,'source.ts'),'utf8'),'original');
 assert.equal(resumed.value.freedBytes,f.expected);assert.ok(f.expected>240*4096);
 assert.equal(resumed.value.freedBytesEstimatedAfterInterruption>0,crashAt==='mid-delete');
 assert.ok(Number.isSafeInteger(resumed.value.filesystemAvailableBytesAfter));

 const third=retireWorkspaceCache(c,f.request);
 assert.equal(third.value.replayed,true);assert.deepEqual({...third.value,replayed:false},resumed.value);
 assert.equal(f.run(['retire-cache-status','--id',f.record.id,'--json']).value.operations.find(o=>o.operationId==='cache-crash-resume-fixture').result.freedBytes,f.expected);
}));
