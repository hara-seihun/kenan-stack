import './scratch-env.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {main,workspaceTesting} from './workspace.mjs';
import {bindNativeOwner,unbindNativeOwner,nativeOwnerBinding} from './native-owner.mjs';
const AGENT='22222222-2222-4222-8222-222222222222';
function fixture(action){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'native-owner-integration-')),source=path.join(root,'checkout'),remote=path.join(root,'remote.git'),state=path.join(root,'registry.sqlite3'),native=path.join(root,'native.json');
 const previous=[process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY,process.env.PI_WORKSPACE_TEST_OWNER_LIVENESS];
 process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY='empty';process.env.PI_WORKSPACE_TEST_OWNER_LIVENESS=native;
 const git=(...a)=>execFileSync('git',a,{encoding:'utf8',timeout:5000,stdio:['ignore','pipe','pipe']}).trim();let db;
 const run=args=>{let out='';const write=process.stdout.write,exit=process.exitCode;process.stdout.write=x=>{out+=x;return true;};try{main(args,state);}finally{process.stdout.write=write;process.exitCode=exit;}return JSON.parse(out);};
 try{
  git('init','--bare',remote);git('clone',remote,source);git('-C',source,'checkout','-b','main');git('-C',source,'config','user.name','Fixture');git('-C',source,'config','user.email','fixture@example.invalid');git('-C',source,'commit','--allow-empty','-m','initial');git('-C',source,'push','origin','main');
  const record=run(['register','--path',source,'--root',root,'--owner','task-label','--json']);db=workspaceTesting.openRegistry(state);unbindNativeOwner(db,record.id);
  const bind=()=>bindNativeOwner(db,record.id,{agentId:AGENT,channel:'beta',callId:'call_123'},'caller-scope',{fixture:true});
  const observe=(agentState,wakes=[])=>fs.writeFileSync(native,JSON.stringify({errors:[],agents:[{id:AGENT,channel:'beta',role:'worker',state:agentState,archived:agentState==='stopped',goalId:null,updatedAt:1}],wakes,observations:[],observedAt:Date.now()}));
  const release=(execute=false)=>workspaceTesting.releaseEndedOwnersCommand(db,{positional:[],named:new Map([['id',[record.id]],...(execute?[['execute',['true']]]:[]),['json',['true']]])},state,{caller:()=>({ok:true,kind:'operator'})});
    const args=(entries=[])=>({positional:[],named:new Map(entries.map(([k,v])=>[k,[String(v)]]))});
  const authenticated=pairs=>({errors:[],confirmed:new Map(pairs.map(p=>[p.agentId+'\0'+p.callId,['beta']]))});
  const receipt=(r,number=1)=>{
   const creation='{"fixture":"'+r.id+'"}';db.prepare('UPDATE workspace SET creation_request=? WHERE id=?').run(creation,r.id);
   for(let i=0;i<number;i++){
    const dir=path.join(root,'checkout-jobs',r.id,'job-'+i);fs.mkdirSync(dir,{recursive:true});
    fs.writeFileSync(path.join(dir,'request.json'),JSON.stringify({id:r.id,request:creation}));
    fs.writeFileSync(path.join(dir,'environment.json'),JSON.stringify({KENAN_AGENT:AGENT,KENAN_TOOL_CALL_ID:'call_'+i}));
   }
  };
  const reaper=(options={})=>workspaceTesting.reapEndedOwnersCommand(db,args([['execute',true],['root',root],...Object.entries(options)]),state,{authenticate:authenticated});
  action({root,source,state,record,db,run,bind,observe,release,args,receipt,authenticated,reaper,git});
 }finally{db?.close();['PI_WORKSPACE_TEST_EXTERNAL_SAFETY','PI_WORKSPACE_TEST_OWNER_LIVENESS'].forEach((key,i)=>{if(previous[i]===undefined)delete process.env[key];else process.env[key]=previous[i];});fs.rmSync(root,{recursive:true,force:true});}
}
test('bound labels are eligible, live owners stay protected, stopped owner releases with its canonical identity',()=>fixture(f=>{
 f.observe('stopped');assert.equal(f.release().candidates,0,'unbound free labels must never be guessed');
 f.bind();f.observe('running');const live=f.release(true);assert.equal(live.results[0].code,'owner-live');assert.equal(fs.existsSync(f.source),true);
 f.observe('stopped');const dry=f.release();assert.equal(dry.results[0].ownerLiveness.owner,AGENT);assert.equal(dry.results[0].action,'would-release-ended-owner');
 const settled=f.release(true);assert.equal(settled.results[0].record.state,'released',JSON.stringify(settled));assert.equal(fs.existsSync(f.source),false);
}));
test('pending wakes for the canonical bound identity protect a labelled checkout',()=>fixture(f=>{
 f.bind();f.observe('stopped',[{id:'wake',agentId:AGENT,status:'pending',message:'continue',heldFor:null}]);
 const result=f.release(true);assert.notEqual(result.results[0].action,'released');assert.equal(fs.existsSync(f.source),true);
}));
test('migration has an explicit unbound outcome for registration without an admission receipt',()=>fixture(f=>{
 const result=f.run(['bind-native-owners','--id',f.record.id,'--execute','--json']);assert.equal(result.ok,true);assert.equal(result.results[0].outcome,'unbound');assert.equal(result.results[0].code,'no-creation-request');assert.deepEqual(nativeOwnerBinding(f.db,f.record.id),{state:'unset'});
}));

test('periodic reaper authenticates an unbound free label before the guarded release',()=>fixture(f=>{
 f.receipt(f.record);f.observe('stopped');
 const result=f.reaper();assert.equal(result.binding.counts.bound,1,JSON.stringify(result));
 assert.equal(result.release.results[0].record.state,'released',JSON.stringify(result));assert.equal(fs.existsSync(f.source),false);
}));
for(const guard of ['live','dirty','unpushed','wake'])test('periodic reaper retains '+guard+' source after authentic binding',()=>fixture(f=>{
 f.receipt(f.record);f.observe(guard==='live'?'running':'stopped',guard==='wake'?[{id:'wake',agentId:AGENT,status:'pending',text:'continue',heldFor:null}]:[]);
 if(guard==='dirty')fs.writeFileSync(path.join(f.source,'valuable.txt'),'irreplaceable');
 if(guard==='unpushed')f.git('-C',f.source,'commit','--allow-empty','-m','not published');
 const before=f.git('-C',f.source,'rev-parse','HEAD');
 const result=f.reaper();assert.equal(result.binding.counts.bound,1);assert.equal(fs.existsSync(f.source),true,JSON.stringify(result));
 assert.equal(f.git('-C',f.source,'rev-parse','HEAD'),before);
 if(guard==='dirty')assert.equal(fs.readFileSync(path.join(f.source,'valuable.txt'),'utf8'),'irreplaceable');
}));
test('bounded binding pages persist fair progress, wrap past unbindable records, and explicit cursors finish',()=>fixture(f=>{
 const records=[f.record];for(let i=0;i<4;i++){
  const dir=path.join(f.root,'checkout-'+i);f.git('clone',path.join(f.root,'remote.git'),dir);f.git('-C',dir,'checkout','main');
  records.push(f.run(['register','--path',dir,'--root',f.root,'--owner','task-label','--json']));unbindNativeOwner(f.db,records.at(-1).id);
 }
 const seen=[];const invoke=(extra=[])=>workspaceTesting.bindNativeOwnersCommand(f.db,f.args([['root',f.root],['execute',true],['max-records',2],...extra]),f.state,{authenticate:f.authenticated});
 for(let n=0;n<3;n++){const page=invoke();assert.ok(page.examined<=2);seen.push(...page.results.map(x=>x.record.id));}
 assert.equal(new Set(seen).size,5,'unbound labels cannot permanently occupy the first page');
 assert.throws(()=>invoke([['max-records',513]]),/max-records/);
 let after='start',walk=[];do{const page=invoke([['after',after]]);walk.push(...page.results.map(x=>x.record.id));after=page.nextAfter;}while(after);
 assert.equal(walk.length,5);assert.equal(new Set(walk).size,5);
 // Binding the final record still requires its authenticated receipt, not the task name.
 const last=records.find(r=>r.id===walk.at(-1));f.receipt(last);
 for(let n=0;n<3;n++)invoke();assert.equal(nativeOwnerBinding(f.db,last.id).agentId,AGENT);
}));
test('binding caps the entire authentication pass at 512 pairs and continues the deferred record next pass',()=>fixture(f=>{
 f.receipt(f.record,400);
 const dir=path.join(f.root,'checkout-z');f.git('clone',path.join(f.root,'remote.git'),dir);f.git('-C',dir,'checkout','main');
 const other=f.run(['register','--path',dir,'--root',f.root,'--owner','task-label','--json']);unbindNativeOwner(f.db,other.id);f.receipt(other,200);
 const batches=[];const invoke=()=>workspaceTesting.bindNativeOwnersCommand(f.db,f.args([['root',f.root],['execute',true],['max-records',512]]),f.state,{authenticate:pairs=>{batches.push(pairs.length);return f.authenticated(pairs);}});
 assert.equal(invoke().examined,1);assert.equal(invoke().examined,1);assert.deepEqual(batches,[400,200]);
}));
test('release action pages prefer positively ended owners over live owners',()=>fixture(f=>{
 const live='11111111-1111-4111-8111-111111111111';
 f.db.prepare('UPDATE workspace SET owner=? WHERE id=?').run(live,f.record.id);
 const dir=path.join(f.root,'checkout-z');f.git('clone',path.join(f.root,'remote.git'),dir);f.git('-C',dir,'checkout','main');
 const ended=f.run(['register','--path',dir,'--root',f.root,'--owner',AGENT,'--json']);
 f.observe('stopped');const observation=JSON.parse(fs.readFileSync(path.join(f.root,'native.json')));observation.agents.push({id:live,channel:'beta',role:'worker',state:'running',archived:false});fs.writeFileSync(path.join(f.root,'native.json'),JSON.stringify(observation));
 const result=f.run(['release-ended-owners','--root',f.root,'--execute','--max-records','1','--json']);
 assert.equal(result.results[0].record.id,ended.id,JSON.stringify(result));assert.equal(fs.existsSync(dir),false);assert.equal(fs.existsSync(f.source),true);
}));

test('ended retained source cannot monopolize later timer action pages',()=>fixture(f=>{
 const records=[f.record];f.bind();fs.writeFileSync(path.join(f.source,'valuable'),'dirty');
 for(let i=0;i<3;i++){
  const dir=path.join(f.root,'checkout-'+i);f.git('clone',path.join(f.root,'remote.git'),dir);f.git('-C',dir,'checkout','main');fs.writeFileSync(path.join(dir,'valuable'),'dirty');
  records.push(f.run(['register','--path',dir,'--root',f.root,'--owner',AGENT,'--json']));
 }
 f.observe('stopped');const examined=[];
 for(let i=0;i<4;i++){
  const result=f.run(['release-ended-owners','--root',f.root,'--execute','--max-records','1','--json']);examined.push(result.results[0].record.id);
 }
 assert.equal(new Set(examined).size,records.length,'persisted attempts fairly cover all retained ended owners');
 for(const record of records)assert.equal(fs.existsSync(path.join(record.path,'valuable')),true);
}));
test('reaper total budget accepts the host invocation but validates both phases before mutation',()=>fixture(f=>{
 f.receipt(f.record);f.observe('running');
 assert.equal(f.reaper({'budget-ms':90000,'max-records':64}).ok,true);
 assert.throws(()=>f.reaper({'budget-ms':1500}),/total budget/);
 assert.throws(()=>f.reaper({'budget-ms':90000,'max-records':65}),/release/);
}));

test('an archived original owner cannot release publisher-adopted native plan helper source',()=>fixture(f=>{
 const old=process.env.PI_WORKSPACE_TEST_QUALIFICATION_ROOT;
 const data=path.join(f.root,'publisher-custody');fs.mkdirSync(path.join(data,'root-plans'),{recursive:true});
 fs.writeFileSync(path.join(data,'root-plans','adopted.plan.json'),JSON.stringify({state:'planned',commit:'a'.repeat(40),checkout:path.join(f.root,'prepared-root'),stages:{tests:{argv:['/usr/bin/python3',path.join(f.source,'helper.py')]}},finish:['/usr/bin/python3',path.join(f.source,'helper.py'),'finish']}));
 process.env.PI_WORKSPACE_TEST_QUALIFICATION_ROOT=data;
 try{f.bind();f.observe('stopped');const result=f.release(true);assert.equal(fs.existsSync(f.source),true,JSON.stringify(result));assert.equal(result.results[0].inspection.classification,'referenced');assert.equal(result.results[0].inspection.currentStackReferences[0].kind,'native_root_plan');}
 finally{if(old===undefined)delete process.env.PI_WORKSPACE_TEST_QUALIFICATION_ROOT;else process.env.PI_WORKSPACE_TEST_QUALIFICATION_ROOT=old;}
}));
for(const parent of ['77777777-7777-4777-8777-777777777777','manager:converge'])test('ended child transfers exact checkout to live native parent '+parent,()=>fixture(f=>{
 f.bind();f.observe('stopped');
 const value=JSON.parse(fs.readFileSync(path.join(f.root,'native.json')));
 value.agents[0].parentAgentId=parent;value.agents.push({id:parent,channel:'beta',role:'worker',state:'running',archived:false});
 fs.writeFileSync(path.join(f.root,'native.json'),JSON.stringify(value));
 const before=f.db.prepare('SELECT * FROM workspace WHERE id=?').get(f.record.id);
 const result=f.release(true);assert.equal(result.results[0].action,'transferred-to-parent',JSON.stringify(result));
 const after=f.db.prepare('SELECT * FROM workspace WHERE id=?').get(f.record.id);
 for(const key of ['id','path','source_commit','lease_expires_at','state','creation_request'])assert.equal(after[key],before[key],key);
 assert.equal(after.owner,parent);assert.equal(fs.existsSync(f.source),true);
 assert.equal(f.db.prepare('SELECT count(*) AS n FROM workspace_parent_custody WHERE workspace_id=?').get(f.record.id).n,1);
 assert.equal(f.release(true).results[0]?.action==='released',false);
 assert.equal(fs.existsSync(f.source),true);
}));
test('a native child with an unobservable parent is retained without forging ownership',()=>fixture(f=>{
 f.bind();f.observe('stopped');const file=path.join(f.root,'native.json'),value=JSON.parse(fs.readFileSync(file));
 value.agents[0].parentAgentId='77777777-7777-4777-8777-777777777777';fs.writeFileSync(file,JSON.stringify(value));
 assert.equal(f.release(true).results[0].code,'parent-custody-unknown');assert.equal(fs.existsSync(f.source),true);
}));

for(const managerHop of [false,true])test('an authenticated live repair worker adopts ended custody directly'+(managerHop?' after an earlier manager transfer':''),()=>fixture(f=>{
 const repair='88888888-8888-4888-8888-888888888888',parent='manager:converge',file=path.join(f.root,'native.json');
 f.bind();f.observe('stopped');let value=JSON.parse(fs.readFileSync(file));
 value.agents[0].parentAgentId=parent;value.agents.push({id:parent,channel:'beta',role:'manager',state:'running',archived:false});
 fs.writeFileSync(file,JSON.stringify(value));
 if(managerHop)assert.equal(f.release(true).results[0].action,'transferred-to-parent');
 value.agents.push({id:repair,parentAgentId:parent,channel:'beta',role:'worker',state:'running',archived:false});fs.writeFileSync(file,JSON.stringify(value));
 const authority={caller:()=>({ok:true,kind:'native',binding:{agentId:repair,channel:'beta',callId:'authentic-repair'}}),authenticate:f.authenticated};
 const before=f.db.prepare('SELECT * FROM workspace WHERE id=?').get(f.record.id);
 const result=workspaceTesting.releaseEndedOwnersCommand(f.db,f.args([['id',f.record.id],['execute',true]]),f.state,authority);
 assert.equal(result.counts['transferred-to-requester'],1,JSON.stringify(result));
 const after=f.db.prepare('SELECT * FROM workspace WHERE id=?').get(f.record.id);
 assert.equal(after.owner,repair);assert.equal(nativeOwnerBinding(f.db,f.record.id).agentId,repair);
 for(const key of ['path','source_commit','lease_expires_at','state'])assert.equal(after[key],before[key]);assert.equal(fs.existsSync(f.source),true);
 // A worker with live custody is never taken over by the next requester.
 const again=workspaceTesting.releaseEndedOwnersCommand(f.db,f.args([['id',f.record.id],['execute',true]]),f.state,authority);
 assert.equal(again.results[0].code,'owner-live');
}));
test('a failed caller authentication cannot acquire ended-owner custody',()=>fixture(f=>{
 f.bind();f.observe('stopped');const result=workspaceTesting.releaseEndedOwnersCommand(f.db,f.args([['id',f.record.id],['execute',true]]),f.state,{caller:()=>({ok:false,error:{code:'release-caller-unverified'}})});
 assert.equal(result.error.code,'release-caller-unverified');assert.equal(fs.existsSync(f.source),true);assert.equal(nativeOwnerBinding(f.db,f.record.id).agentId,AGENT);
}));
