import './scratch-env.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {rootPlanReferences,publisherPlanReferences} from './root-plan-references.mjs';
import {qualificationReferences,protects} from './qualification-references.mjs';
import {workspaceTesting} from './workspace.mjs';
const sha='a'.repeat(40);
function fixture(fn){const root=fs.mkdtempSync(path.join(os.tmpdir(),'root-plan-custody-')),directory=path.join(root,'root-plans'),helper=path.join(root,'helper');fs.mkdirSync(directory);fs.mkdirSync(helper);const file=path.join(directory,'root-candidate.plan.json');const plan={state:'planned',commit:sha,checkout:path.join(root,'qualification'),candidate:{commit:sha,checkout:path.join(root,'smoke')},stages:{tests:{argv:['/usr/bin/python3','-B',helper+'/converge-root-precheck','tests',path.join(root,'qualification')]}},finish:['/usr/bin/python3',helper+'/converge-root-precheck','finish',path.join(root,'qualification')]};const write=p=>fs.writeFileSync(file,JSON.stringify(p));write(plan);try{fn({root,directory,helper,file,plan,write});}finally{fs.rmSync(root,{recursive:true,force:true});}}
test('native root plan argv protects a helper, root and smoke without a running process',()=>fixture(f=>{
 const r=qualificationReferences([f.helper],{dataRoot:f.root});assert.equal(r.complete,true,JSON.stringify(r.errors));assert.equal(r.references.length,1);assert.equal(r.references[0].kind,'native_root_plan');assert.equal(protects(r,f.helper),true);assert.equal(protects(r,f.helper+'/other'),false);
 const all=rootPlanReferences(null,{directory:f.directory});assert.equal(protects(all,f.plan.checkout),true);assert.equal(protects(all,f.plan.candidate.checkout),true);assert.equal(protects(all,f.root+'/unrelated'),false);
}));
test('ordinary supported release inspection preserves a helper referenced only by native plan',()=>fixture(f=>{
 const old=[process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY,process.env.PI_WORKSPACE_TEST_QUALIFICATION_ROOT];process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY='empty';process.env.PI_WORKSPACE_TEST_QUALIFICATION_ROOT=f.root;
 try{const held=workspaceTesting.inspectRecord({id:'r',path:f.helper,state:'active',leaseExpiresAt:0,checkoutType:'clone'},{safety:{currentStackQueue:{errors:[],references:[]}}});assert.equal(held.classification,'referenced');assert.equal(held.currentStackReferences[0].kind,'native_root_plan');assert.equal(fs.existsSync(f.helper),true);}finally{['PI_WORKSPACE_TEST_EXTERNAL_SAFETY','PI_WORKSPACE_TEST_QUALIFICATION_ROOT'].forEach((k,i)=>{if(old[i]===undefined)delete process.env[k];else process.env[k]=old[i];});}
}));
test('age and a terminal-looking plan state never waive execution custody',()=>fixture(f=>{
 f.write({...f.plan,state:'completed'});fs.utimesSync(f.file,new Date(2000,0,1),new Date(2000,0,1));const r=rootPlanReferences([f.helper],{directory:f.directory});assert.equal(r.references.length,1);assert.equal(r.complete,true);
}));
test('only a digest-bound explicit release covering every dependency ends plan custody',()=>fixture(f=>{
 const before=rootPlanReferences(null,{directory:f.directory});const paths=before.references[0].paths;const terminal={state:'released',owner:'publisher',reason:'All execution paths were adopted into durable replacement custody.',planSha256:crypto.createHash('sha256').update(fs.readFileSync(f.file)).digest('hex'),paths};
 fs.writeFileSync(f.file+'.custody-released.json',JSON.stringify({...terminal,paths:paths.slice(1)}));assert.equal(rootPlanReferences(null,{directory:f.directory}).complete,false);
 fs.writeFileSync(f.file+'.custody-released.json',JSON.stringify(terminal));let r=rootPlanReferences(null,{directory:f.directory});assert.equal(r.complete,true);assert.equal(r.references.length,0);assert.equal(r.released.length,1);
 f.write({...f.plan,extra:true});r=rootPlanReferences(null,{directory:f.directory});assert.equal(r.complete,false);assert.match(r.errors[0],/does not match/);
}));
test('malformed, symlinked and oversized plans retain custody conservatively',()=>fixture(f=>{
 f.write({...f.plan,stages:{tests:{argv:'not argv'}}});let r=rootPlanReferences([f.helper],{directory:f.directory});assert.equal(r.complete,false);assert.equal(protects(r,f.helper),true);
 f.write(f.plan);assert.equal(rootPlanReferences(null,{directory:f.directory,maxFileBytes:1}).complete,false);assert.equal(rootPlanReferences(null,{directory:f.directory,maxEntries:0}).complete,false);
 fs.renameSync(f.file,f.file+'.saved');fs.symlinkSync(f.file+'.saved',f.file);assert.equal(rootPlanReferences(null,{directory:f.directory}).complete,false);
}));

test('publisher plan copies retain independently added helper and adopted source paths among unrelated history',()=>fixture(f=>{
 fs.writeFileSync(path.join(f.root,'P226-N161-PLAN.json'),JSON.stringify({...f.plan,donor:{path:f.helper+'/donor'}}));
 for(let i=0;i<100;i++)fs.writeFileSync(path.join(f.root,'old-'+i+'.json'),'not a plan');
 let r=publisherPlanReferences([f.helper],{directory:f.root});assert.equal(r.complete,true);assert.equal(r.references.length,1);assert.equal(r.references[0].kind,'publisher_native_plan');assert.ok(r.references[0].paths.includes(f.helper+'/donor'));
 r=publisherPlanReferences([f.helper],{directory:f.root,maxEntries:16});assert.equal(r.complete,false);
}));

test('cancelled native and publisher requests end only future request protection without changing original evidence',()=>fixture(f=>{
 f.write({...f.plan,state:'cancelled',activationReady:false,retirementReason:'The publisher withdrew future dispatch.'});
 const publisher=path.join(f.root,'N152-MATERIALIZED-PLAN.json');fs.copyFileSync(f.file,publisher);
 const originals=[f.file,publisher].map(file=>fs.readFileSync(file));
 for(const result of [rootPlanReferences([f.helper],{directory:f.directory}),publisherPlanReferences([f.helper],{directory:f.root})]){
  assert.equal(result.complete,true,JSON.stringify(result.errors));assert.equal(result.references.length,0);
  assert.equal(result.released.length,1);assert.equal(result.released[0].state,'cancelled');
  assert.equal(result.released[0].resourceClass,'qualification-request');
 }
 const combined=qualificationReferences([f.helper],{dataRoot:f.root});assert.equal(combined.complete,true);assert.equal(combined.references.length,0);assert.equal(combined.released.filter(r=>r.state==='cancelled').length,2);
 [f.file,publisher].forEach((file,i)=>assert.deepEqual(fs.readFileSync(file),originals[i]));
}));

test('active, materialized, terminal-looking and unknown plans continue protecting future dependencies',()=>fixture(f=>{
 for(const state of ['planned','active','materialized','completed','failed','unknown',undefined]){
  const plan={...f.plan,state};f.write(plan);fs.writeFileSync(path.join(f.root,'N152-PLAN.json'),JSON.stringify(plan));
  for(const result of [rootPlanReferences([f.helper],{directory:f.directory}),publisherPlanReferences([f.helper],{directory:f.root})]){
   assert.equal(result.complete,true,JSON.stringify(result.errors));assert.equal(result.references.length,1,String(state));
  }
 }
}));

test('cancelled future requests cannot waive queue, installed source, process, container or unit custody',()=>fixture(f=>{
 f.write({...f.plan,state:'cancelled'});fs.writeFileSync(path.join(f.root,'N152-PLAN.json'),JSON.stringify({...f.plan,state:'cancelled'}));
 const keys=['PI_WORKSPACE_TEST_EXTERNAL_SAFETY','PI_WORKSPACE_TEST_QUALIFICATION_ROOT'],old=keys.map(k=>process.env[k]);
 process.env[keys[0]]='empty';process.env[keys[1]]=f.root;
 const record={id:'r',path:f.helper,state:'active',leaseExpiresAt:0,checkoutType:'clone'};
 const empty={threads:[],processes:[],installed:[],docker:{available:true,containers:[]},systemd:{available:true,units:[]},currentStackQueue:{errors:[],references:[]}};
 const cases=[
  {currentStackQueue:{errors:[],references:[{kind:'streaming_tool',paths:[f.helper]}]}},
  {installed:[{file:'/srv/installed.js',path:f.helper+'/worker.js'}]},
  {processes:[{pid:123,cwd:f.helper,executable:null,commandLine:[],command:'worker'}]},
  {docker:{available:true,containers:[{Id:'running',State:{Status:'running'},HostConfig:{RestartPolicy:{Name:'no'}},Config:{Labels:{'com.docker.compose.project.working_dir':f.helper}},Mounts:[]}]}},
  {systemd:{available:true,units:[{id:'active.service',workingDirectory:f.helper,execStart:'/usr/bin/node',manager:'user'}]}},
  {currentStackQueue:{errors:['runtime observation unavailable'],references:[]}},
 ];
 try{
  for(const extra of cases){const inspected=workspaceTesting.inspectRecord(record,{safety:{...empty,...extra}});assert.ok(['referenced','blocked'].includes(inspected.classification),JSON.stringify({extra,inspected}));assert.equal(fs.existsSync(f.helper),true);}
  const prepared=path.join(f.root,'prepared-runtime','host-preparation-active');fs.mkdirSync(prepared,{recursive:true});fs.writeFileSync(path.join(prepared,'CONFIG.json'),JSON.stringify({candidateRoot:f.helper,receiptId:'active',runDirectory:path.join(f.root,'run')}));
  const inspected=workspaceTesting.inspectRecord(record,{safety:empty});assert.equal(inspected.classification,'referenced');assert.equal(inspected.currentStackReferences[0].kind,'prepared_runtime_config');
 }
 finally{keys.forEach((k,i)=>{if(old[i]===undefined)delete process.env[k];else process.env[k]=old[i];});}
}));
