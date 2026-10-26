import './scratch-env.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {adoptEndedActions} from './actions-adoption.mjs';
import {nativeOwnerBinding,bindNativeOwner} from './native-owner.mjs';
const A='22222222-2222-4222-8222-222222222222',B='11111111-1111-4111-8111-111111111111',commit='a'.repeat(40);
const binding={agentId:A,channel:'beta',callId:'call-test'};
function fixture(action){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'actions-adoption-')),db=new DatabaseSync(':memory:');
 db.exec('CREATE TABLE workspace(id TEXT PRIMARY KEY,creation_request TEXT)');
 const input={repository:'owi-link/converge',run:'40374067792',attempt:'1',sourceCommit:commit};
 const branch='agent/actions-deploy-40374067792-1';
 const record={id:'33333333-3333-4333-8333-333333333333',owner:'actions-deploy-40374067792',path:root+'/actions-deploy-40374067792-1',repository:'https://github.com/owi-link/converge',sourceCommit:commit,durableSourceCommit:commit,mode:'writer',groupId:null,state:'active'};
 const request={repository:'/home/kenan/actions-runner-deploy-1/_work/converge/converge',ref:commit,owner:record.owner,branch};
 const store=()=>db.prepare('INSERT OR REPLACE INTO workspace VALUES(?,?)').run(record.id,JSON.stringify(request));store();
 const response={id:40374067792,run_attempt:1,repository:{full_name:input.repository},head_repository:{full_name:input.repository},head_sha:commit,path:'.github/workflows/deploy.yml',status:'completed',conclusion:'failure'};
 const authority={caller:()=>({ok:true,kind:'native',binding}),authenticate:pairs=>({errors:[],confirmed:new Map(pairs.map(p=>[p.agentId+'\0'+p.callId,['beta']]))})};
 let calls=0;
 const execute=(cmd,args,options)=>{calls++;assert.equal(cmd,'/usr/local/bin/gh');assert.deepEqual(args,['api','--hostname','github.com','repos/owi-link/converge/actions/runs/40374067792/attempts/1']);assert.equal(options.timeout,10000);assert.deepEqual(Object.keys(options.env).sort(),["GH_HOST","GH_PROMPT_DISABLED","HOME","PATH"]);return {status:0,stdout:JSON.stringify(response)};};
 const run=(extra={})=>adoptEndedActions(db,record,root+'/registry.sqlite3',input,{authority,execute,head:commit,branch,...extra});
 const rows=()=>JSON.stringify(db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(({name})=>[name,db.prepare('SELECT * FROM '+name).all()]));
 try{action({root,db,input,record,request,response,authority,run,rows,store,calls:()=>calls});}finally{db.close();fs.rmSync(root,{recursive:true,force:true});}
}
test('an exact terminal failed Actions attempt is adopted by the authenticated caller without implying settled effects',()=>fixture(f=>{
 const result=f.run();assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.custodian.agentId,A);assert.equal(result.leaseUnchanged,true);assert.equal(result.sourceUnchanged,true);assert.equal(result.evidence.conclusion,'failure');assert.match(result.evidence.effectsSettlement,/not implied/);assert.equal(f.calls(),1);
 const evidence=JSON.parse(f.db.prepare('SELECT evidence_json FROM workspace_native_owner').get().evidence_json);assert.equal(evidence.run,f.input.run);assert.match(evidence.githubResponseSha256,/^[a-f0-9]{64}$/);
 const before=f.rows();assert.equal(f.run().error.code,'actions-adoption-already-bound');assert.equal(f.rows(),before);
}));
for(const [name,mutate,expected] of [
 ['foreign repository',f=>f.input.repository='owi-link/link','actions-adoption-request-invalid'],
 ['malformed run',f=>f.input.run='../12','actions-adoption-request-invalid'],
 ['malformed attempt',f=>f.input.attempt='01','actions-adoption-request-invalid'],
 ['foreign label',f=>f.record.owner=B,'actions-adoption-custody-mismatch'],
 ['foreign checkout',f=>f.record.path+='/other','actions-adoption-custody-mismatch'],
 ['foreign registered repository',f=>f.record.repository='https://github.com/owi-link/link','actions-adoption-custody-mismatch'],
 ['changed original request',f=>{f.request.ref='b'.repeat(40);f.store();},'actions-adoption-source-mismatch'],
 ['changed registered source',f=>f.record.sourceCommit='b'.repeat(40),'actions-adoption-source-mismatch'],
 ['foreign run response',f=>f.response.id++,'actions-adoption-observation-mismatch'],
 ['foreign attempt response',f=>f.response.run_attempt++,'actions-adoption-observation-mismatch'],
 ['foreign source response',f=>f.response.head_sha='b'.repeat(40),'actions-adoption-observation-mismatch'],
 ['foreign head repository',f=>f.response.head_repository.full_name='owi-link/link','actions-adoption-observation-mismatch'],
 ['foreign workflow',f=>f.response.path='.github/workflows/test.yml','actions-adoption-observation-mismatch'],
 ['active run',f=>{f.response.status='in_progress';f.response.conclusion=null;},'actions-adoption-run-active'],
 ['unknown conclusion',f=>f.response.conclusion='invented','actions-adoption-run-active'],
 ['existing native custody',f=>bindNativeOwner(f.db,f.record.id,{...binding,agentId:B},'caller-scope',{}),'actions-adoption-already-bound'],
 ['unconfirmed caller',f=>f.authority.authenticate=()=>({errors:[],confirmed:new Map()}),'release-caller-unverified']
])test('adoption refuses '+name+' without changing custody',()=>fixture(f=>{mutate(f);const before=f.rows();assert.equal(f.run().error.code,expected);assert.equal(f.rows(),before);assert.equal(nativeOwnerBinding(f.db,f.record.id).agentId===A,false);}));
for(const [name,extra,code] of [
 ['malformed response',{execute:()=>({status:0,stdout:'not json'})},'actions-adoption-observation-invalid'],
 ['failed observer',{execute:()=>({status:1,stderr:'private error'})},'actions-adoption-observation-failed'],
 ['changed actual head',{head:'b'.repeat(40)},'actions-adoption-source-mismatch'],
 ['changed actual branch',{branch:'other'},'actions-adoption-source-mismatch']
])test('adoption refuses '+name,()=>fixture(f=>{const before=f.rows();assert.equal(f.run(extra).error.code,code);assert.equal(f.rows(),before);}));
test('forged or stale native receipt cannot be replaced by an Actions claim',()=>fixture(f=>{
 const job=path.join(f.root,'checkout-jobs',f.record.id,'job');fs.mkdirSync(job,{recursive:true});fs.writeFileSync(job+'/environment.json',JSON.stringify({KENAN_AGENT:B,KENAN_TOOL_CALL_ID:'call-forged'}));fs.writeFileSync(job+'/request.json',JSON.stringify({id:f.record.id,request:'stale request'}));
 const before=f.rows();assert.equal(f.run().error.code,'actions-adoption-native-receipt');assert.equal(f.rows(),before);assert.equal(f.calls(),0);
}));
