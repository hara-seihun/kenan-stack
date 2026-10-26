import './scratch-env.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {preparedRuntimeReferences as census,withPreparedRuntimeReferences as merge} from './prepared-runtime-references.mjs';
import {workspaceTesting} from './workspace.mjs';
import {fileURLToPath} from 'node:url';
import {digest} from './growth-lifecycle.mjs';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const ORIGINAL='ed68554c-a84e-4444-a66b-4940c3c4df6a';
function fixture(action){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'prepared-custody-'));
 const dataRoot=path.join(root,'release'),preparedRuntimeRoot=path.join(root,'preparation'),source=path.join(root,'source');
 fs.mkdirSync(dataRoot);fs.mkdirSync(preparedRuntimeRoot);fs.mkdirSync(source);
 const options={dataRoot,preparedRuntimeRoot};
 const put=(file,value)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(value));return file;};
 const config=(name='one',extras={})=>put(path.join(preparedRuntimeRoot,'host-preparation-'+name,'CONFIG.json'),{candidateRoot:source,receiptId:'original40-'+name,unit:'AWAITING.service',runDirectory:path.join(root,'run-'+name),...extras});
 const disposition=(file,kind='prepared-runtime-disposition',extra={})=>{
  const result=census(null,options),ref=result.references.find(r=>r.configPath===file||r.id===file);assert.ok(ref,JSON.stringify(result));
  return put(file+'.disposition.json',{version:1,kind,sourcePath:file,sourceSha256:hash(fs.readFileSync(file)),paths:ref.paths,owner:'publisher',reason:'Exact source is no longer needed by this prepared consumer.',disposition:'disposed',...extra});
 };
 try{action({root,dataRoot,preparedRuntimeRoot,source,options,put,config,disposition});}finally{fs.rmSync(root,{recursive:true,force:true});}
}
test('undispatched config retains exact candidate, helper and current tooling donor with no process',()=>fixture(f=>{
 const donor=path.join(f.root,'tooling'),helper=path.join(f.root,'helper');const file=f.config('one',{helperRoot:helper,currentToolingDonor:{path:donor}});
 const old=new Date('2000-01-01');fs.utimesSync(file,old,old);
 const result=census([f.source,helper,donor],f.options);assert.deepEqual(result.errors,[]);assert.equal(result.references.length,1);
 for(const p of [f.source,donor,helper])assert.ok(result.references[0].paths.includes(p));
 const record={path:f.source,state:'active',owner:ORIGINAL,leaseExpiresAt:0,checkoutType:'clone'};
 const safety={currentStackQueue:result,processes:[],threads:[],docker:{available:false,containers:[]},systemd:{available:false,units:[]}};
 const prior=process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY;process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY='empty';
 try{for(const terminalSourceTransfer of [false,true])assert.equal(workspaceTesting.inspectRecord(record,{safety,ignoreLease:true,terminalSourceTransfer}).classification,'referenced');}
 finally{if(prior===undefined)delete process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY;else process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY=prior;}
}));
test('HOST-CLAIM binds exact bytes and HOST-EXIT never gives up prepared source',()=>fixture(f=>{
 const file=f.config();const v=JSON.parse(fs.readFileSync(file));
 f.put(path.join(v.runDirectory,'HOST-CLAIM.json'),{configPath:file,configSha256:hash(fs.readFileSync(file))});
 f.put(path.join(v.runDirectory,'HOST-EXIT.json'),{schema:'segmented-native-host-exit-v1',wrapperExitCode:1,entrypointExitCode:null});
 assert.equal(census(null,f.options).references[0].state,'claimed-unreleased');
 f.put(file,{...v,candidateRoot:path.join(f.root,'changed')});assert.equal(census(null,f.options).complete,false);
}));
test('exact terminal disposal permits release; changing config bytes invalidates it',()=>fixture(f=>{
 const file=f.config();f.disposition(file);assert.equal(census(null,f.options).references.length,0);assert.equal(census(null,f.options).released.length,1);
 f.put(file,{...JSON.parse(fs.readFileSync(file)),unit:'changed.service'});assert.equal(census(null,f.options).complete,false);
}));
test('handover requires an exact unresolved successor configuration inside owning custody',()=>fixture(f=>{
 const old=f.config(),next=f.config('two',{candidateRoot:path.join(f.root,'new')});
 f.disposition(old,'prepared-runtime-disposition',{disposition:'handed-over',successor:{path:next,sha256:hash(fs.readFileSync(next))}});
 let result=census(null,f.options);assert.equal(result.complete,true);assert.equal(result.references.length,1);assert.equal(result.references[0].configPath,next);
 f.disposition(next);result=census(null,f.options);assert.equal(result.complete,false,'terminal handover cycles cannot release every owning record');
}));
test('publisher adoption protects source whose original worker is archived, and restore destination before checkout is running',()=>fixture(f=>{
 const adopted=f.put(path.join(f.dataRoot,'C497-CUSTODY-ADOPTION-A7.json'),{kind:'operator-source-artifact-custody-adoption',operator:'publisher',priorSourceWriter:ORIGINAL,record:{records:[{path:f.source,root:f.root,owner:ORIGINAL,state:'active',capacity:{measurementFailures:[{path:'/unrelated/historical-measurement'}]}}]},authorization:'The publisher accepts custody.'});
 const restore=f.put(path.join(f.dataRoot,'P226-COMPARISON-SOURCE-RESTORE.json'),{id:'restore',jobId:'original',path:f.source,state:'creating'});
 let result=census([f.source],f.options);assert.equal(result.complete,true);assert.equal(result.references.length,2);
 assert.deepEqual(result.references.find(r=>r.id===adopted).paths,[f.source],'registry roots and historical failed measurements are not adopted source');
 f.disposition(adopted,'publisher-custody-disposition');assert.equal(census([f.source],f.options).references.length,1);
 f.disposition(restore,'publisher-custody-disposition');assert.equal(census([f.source],f.options).references.length,0);
}));
test('canonical helper custody and registered future publisher adoptions are counted',()=>fixture(f=>{
 const helper=path.join(f.dataRoot,'p226/helper-custody');fs.mkdirSync(helper,{recursive:true});
 f.put(path.join(f.dataRoot,'publisher-custody/new.json'),{kind:'operator-source-artifact-custody-adoption',operator:'publisher',record:{records:[{path:f.source}]}});
 const result=census(null,f.options);assert.equal(result.complete,true);assert.equal(result.references.length,2);assert.ok(result.references.some(r=>r.targetPath===helper));
}));
test('missing current config, malformed records, byte and traversal bounds remain visible and fail closed',()=>fixture(f=>{
 f.config();assert.equal(census(null,{...f.options,preparedRuntimeLimits:{fileBytes:2}}).complete,false);
 assert.equal(census(null,{...f.options,preparedRuntimeLimits:{entries:0}}).complete,false);
 assert.equal(census(null,{...f.options,deadline:Date.now()-1}).complete,false);
 fs.writeFileSync(path.join(f.preparedRuntimeRoot,'CURRENT-HOST-CONFIG-PATH'),path.join(f.preparedRuntimeRoot,'host-preparation-missing/CONFIG.json'));
 assert.equal(census(null,f.options).complete,false);
}));
test('the merge wrapper preserves every existing guard and adds prepared custody even without qualification installation',()=>fixture(f=>{
 f.config();const result=merge({errors:['native observation failed'],references:[{kind:'native'}],complete:false},null,f.options);
 assert.equal(result.complete,false);assert.equal(result.references.length,2);assert.deepEqual(result.errors,['native observation failed']);
 assert.equal(merge({errors:[],references:[],complete:true},null,f.options).references.length,1);
}));
test('actual explicit terminal retained release is stopped by the qualification wrapper splice',async()=>{
 const shadow=fs.mkdtempSync(path.join(os.tmpdir(),'prepared-wrapper-'));
 try{
 const component=path.dirname(fileURLToPath(import.meta.url));
 for(const name of fs.readdirSync(component)){
  if(name==='workspace.mjs')fs.copyFileSync(path.join(component,name),path.join(shadow,name));
  else if(name!=='qualification-references.mjs')fs.symlinkSync(path.join(component,name),path.join(shadow,name));
 }
 // This isolated copy applies the exact public wrapper interface without editing the parent's file.
 const qualification=fs.readFileSync(path.join(component,'qualification-references.mjs'),'utf8').replace('export function qualificationReferences(','function baseQualificationReferences(');
 fs.writeFileSync(path.join(shadow,'qualification-references.mjs'),qualification+"\nimport {withPreparedRuntimeReferences} from './prepared-runtime-references.mjs';\nexport function qualificationReferences(roots=null,options={}){return withPreparedRuntimeReferences(baseQualificationReferences(roots,options),roots,options); }\n");
 const {main,workspaceTesting:shadowTesting}=await import('file://'+path.join(shadow,'workspace.mjs'));
 fixture(f=>{
 const prior=process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY;process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY='empty';
 const git=(...args)=>execFileSync('git',args,{encoding:'utf8',timeout:5000,stdio:['ignore','pipe','pipe']}).trim();
 const state=path.join(f.root,'registry.sqlite3');let database;const previousNative=process.env.PI_WORKSPACE_TEST_OWNER_LIVENESS;
 const oldQualification=process.env.PI_WORKSPACE_TEST_QUALIFICATION_ROOT;process.env.PI_WORKSPACE_TEST_QUALIFICATION_ROOT=f.dataRoot;
 const run=args=>{let out='';const write=process.stdout.write,exit=process.exitCode;process.stdout.write=x=>{out+=x;return true;};try{main(args,state);}finally{process.stdout.write=write;process.exitCode=exit;}return JSON.parse(out);};
 try{
  git('init',f.source);git('-C',f.source,'config','user.name','Fixture');git('-C',f.source,'config','user.email','fixture@example.invalid');fs.writeFileSync(path.join(f.source,'proof'),'durable');git('-C',f.source,'add','.');git('-C',f.source,'commit','-m','source');
  const remote=path.join(f.root,'durable.git');git('init','--bare',remote);git('-C',f.source,'remote','add','origin',remote);git('-C',f.source,'push','origin','HEAD:refs/heads/main');
  const native=path.join(f.root,'native.json');process.env.PI_WORKSPACE_TEST_OWNER_LIVENESS=native;
  f.put(native,{errors:[],agents:[{id:ORIGINAL,channel:'beta',role:'worker',state:'stopped',archived:true,goalId:null,updatedAt:1}],wakes:[],observations:[],observedAt:Date.now()});
  const record=run(['register','--path',f.source,'--root',f.root,'--owner',ORIGINAL,'--json']);database=shadowTesting.openRegistry(state);
  const plan=JSON.stringify({intent:'budgeted',growthBytes:0,headroomBytes:0,constructionBytes:0,growthLifecycle:{kind:'retired-future-growth',remainingGrowthBytes:0,retainedUse:'source',dispositionSha256:'a'.repeat(64),retiredAt:Date.now()}});
  database.prepare('UPDATE workspace SET lease_expires_at=0 WHERE id=?').run(record.id);
  database.prepare('INSERT OR REPLACE INTO workspace_capacity(workspace_id,device_id,plan_json) VALUES(?,?,?)').run(record.id,String(fs.statSync(f.source).dev),plan);
  // Use the wrapper's supported test dataRoot convention, not the real host configuration.
  const preparedRoot=path.join(f.dataRoot,'prepared-runtime');fs.mkdirSync(preparedRoot);
  const file=f.put(path.join(preparedRoot,'host-preparation-terminal/CONFIG.json'),{candidateRoot:f.source,receiptId:'prepared-terminal',runDirectory:path.join(f.root,'prepared-run')});
  const result=run(['release','--id',record.id,'--end-retention','--owner',ORIGINAL,'--expected-plan-sha256',digest(plan),'--json']);
  assert.equal(result.action,'none');assert.equal(result.inspection.currentStackQueueProtected,true);assert.equal(fs.readFileSync(path.join(f.source,'proof'),'utf8'),'durable');
  const references=census([f.source],{dataRoot:f.dataRoot});assert.equal(references.complete,true);
  f.put(file+'.disposition.json',{version:1,kind:'prepared-runtime-disposition',sourcePath:file,sourceSha256:hash(fs.readFileSync(file)),paths:references.references[0].paths,owner:'publisher',reason:'The prepared consumer explicitly releases this exact source.',disposition:'disposed'});
  const released=run(['release','--id',record.id,'--end-retention','--owner',ORIGINAL,'--expected-plan-sha256',digest(plan),'--json']);assert.equal(released.action,'released',JSON.stringify(released));assert.equal(fs.existsSync(f.source),false);
  if(previousNative===undefined)delete process.env.PI_WORKSPACE_TEST_OWNER_LIVENESS;else process.env.PI_WORKSPACE_TEST_OWNER_LIVENESS=previousNative;
 }finally{database?.close();if(previousNative===undefined)delete process.env.PI_WORKSPACE_TEST_OWNER_LIVENESS;else process.env.PI_WORKSPACE_TEST_OWNER_LIVENESS=previousNative;if(prior===undefined)delete process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY;else process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY=prior;if(oldQualification===undefined)delete process.env.PI_WORKSPACE_TEST_QUALIFICATION_ROOT;else process.env.PI_WORKSPACE_TEST_QUALIFICATION_ROOT=oldQualification;}
 });
 }finally{fs.rmSync(shadow,{recursive:true,force:true});}
});
