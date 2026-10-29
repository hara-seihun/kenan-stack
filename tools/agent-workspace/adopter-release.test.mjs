import './scratch-env.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {main,workspaceTesting} from './workspace.mjs';
import {bindNativeOwner} from './native-owner.mjs';
import {submitRelease} from './release-submission.mjs';

// Regression (workspace 33b3fad0, October 29): an ended owner's ordinary release retired
// future growth and retained the tree. release-ended-owners then moved custody to the live
// parent and on to an authenticated requester. The adopter's own release was refused
// ("explicit retained source/runtime custody") because the original settlement named the
// ended owner, and its foreground submission conflicted with the ended owner's submission.
const CHILD='22222222-2222-4222-8222-222222222222',REPAIR='88888888-8888-4888-8888-888888888888',PARENT='manager:converge';
function fixture(action,{wakes=[]}={}){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'adopter-release-')),source=path.join(root,'checkout'),remote=path.join(root,'remote.git'),state=path.join(root,'registry.sqlite3'),native=path.join(root,'native.json');
 const previous=[process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY,process.env.PI_WORKSPACE_TEST_OWNER_LIVENESS];
 process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY='empty';process.env.PI_WORKSPACE_TEST_OWNER_LIVENESS=native;
 const git=(...a)=>execFileSync('git',a,{encoding:'utf8',timeout:5000,stdio:['ignore','pipe','pipe']}).trim();let db;
 const run=args=>{let out='';const write=process.stdout.write,exit=process.exitCode;process.stdout.write=x=>{out+=x;return true;};try{main(args,state,{releaseAuthorityDependencies:{caller:()=>({ok:true,kind:'operator'})}});}finally{process.stdout.write=write;process.exitCode=exit;}return JSON.parse(out);};
 try{
  git('init','--bare',remote);git('clone',remote,source);git('-C',source,'checkout','-b','main');git('-C',source,'config','user.name','Fixture');git('-C',source,'config','user.email','fixture@example.invalid');
  fs.writeFileSync(path.join(source,'proof'),'initial');git('-C',source,'add','.');git('-C',source,'commit','-m','initial');git('-C',source,'push','origin','main');
  const initial=git('-C',source,'rev-parse','HEAD');
  const record=run(['register','--path',source,'--root',root,'--owner',CHILD,'--source-commit',initial,'--json']);
  db=workspaceTesting.openRegistry(state);
  const st=fs.statSync(source),now=Date.now();
  db.prepare('INSERT OR REPLACE INTO workspace_capacity(workspace_id,device_id,plan_json) VALUES(?,?,?)').run(record.id,String(st.dev),JSON.stringify({intent:'budgeted',estimate:'whole-tree-upper-bound',constructionBytes:4096,growthBytes:4*1024**3,headroomBytes:8*1024**3,completedAllocationBytes:4096}));
  db.prepare('INSERT OR REPLACE INTO workspace_capacity_measurement VALUES(?,?)').run(record.id,JSON.stringify({ok:true,bytes:4096,allocatedBytes:4096,device:String(st.dev),inode:String(st.ino),startedAt:now,completedAt:now}));
  bindNativeOwner(db,record.id,{agentId:CHILD,channel:'beta',callId:'call_child'},'caller-scope',{fixture:true});
  const agents=list=>fs.writeFileSync(native,JSON.stringify({errors:[],agents:list,wakes:wakes.map(w=>({...w,text:w.text.replaceAll('$PATH',source)})),observations:[],observedAt:Date.now()}));
  const authenticated=pairs=>({errors:[],confirmed:new Map(pairs.map(p=>[p.agentId+'\0'+p.callId,['beta']]))});
  const args=(entries=[])=>({positional:[],named:new Map(entries.map(([k,v])=>[k,[String(v)]]))});
  // The child commits unique work and releases while it is unpublished: growth retires, the tree is retained.
  fs.writeFileSync(path.join(source,'proof'),'unique work');git('-C',source,'commit','-am','unique');
  const first=run(['release','--id',record.id,'--preserve-runtime','--json']);
  assert.equal(first.futureGrowthSettlement?.kind,'retired',JSON.stringify(first));assert.equal(fs.existsSync(source),true);
  git('-C',source,'push','origin','HEAD:refs/heads/agent/fixture');
  // The child ends; the live parent takes custody, then a live repair worker adopts it.
  agents([{id:CHILD,parentAgentId:PARENT,channel:'beta',role:'worker',state:'stopped',archived:true,goalId:'goal-1'},{id:PARENT,channel:'beta',role:'manager',state:'running',archived:false}]);
  const sweep=workspaceTesting.releaseEndedOwnersCommand(db,args([['id',record.id],['execute',true]]),state,{caller:()=>({ok:true,kind:'operator'})}).results[0];
  // Periodic operator sweeps keep honoring every held trigger of the ended owner's goal.
  if(wakes.length)assert.equal(sweep.code,'pending-wake-reference',JSON.stringify(sweep));else assert.equal(sweep.action,'transferred-to-parent');
  agents([{id:CHILD,parentAgentId:PARENT,channel:'beta',role:'worker',state:'stopped',archived:true,goalId:'goal-1'},{id:PARENT,channel:'beta',role:'manager',state:'running',archived:false},
   {id:REPAIR,parentAgentId:PARENT,channel:'beta',role:'worker',state:'running',archived:false}]);
  const adopted=workspaceTesting.releaseEndedOwnersCommand(db,args([['id',record.id],['execute',true]]),state,{caller:()=>({ok:true,kind:'native',binding:{agentId:REPAIR,channel:'beta',callId:'authentic-repair'}}),authenticate:authenticated});
  action({root,source,state,record,db,run,git,first,adopted});
 }finally{db?.close();['PI_WORKSPACE_TEST_EXTERNAL_SAFETY','PI_WORKSPACE_TEST_OWNER_LIVENESS'].forEach((key,i)=>{if(previous[i]===undefined)delete process.env[key];else process.env[key]=previous[i];});fs.rmSync(root,{recursive:true,force:true});}
}

test('the adopter of ended custody completes the original retired-growth release',()=>fixture(f=>{
 assert.equal(f.adopted.counts['transferred-to-requester'],1,JSON.stringify(f.adopted));
 const row=f.db.prepare('SELECT * FROM workspace WHERE id=?').get(f.record.id);assert.equal(row.owner,REPAIR);
 assert.deepEqual([...workspaceTesting.endedCustodyLineage(f.db,{id:row.id,path:row.path,owner:row.owner,sourceCommit:row.source_commit})].sort(),[CHILD,REPAIR,PARENT].sort());
 const result=f.run(['release','--id',f.record.id,'--json']);
 assert.equal(result.action,'released',JSON.stringify(result));assert.equal(result.ok,true);
 assert.equal(result.ordinaryReleaseContinuation.requestId,f.first.releaseSettlement.requestId);
 assert.equal(fs.existsSync(f.source),false);
 assert.equal(f.run(['release','--id',f.record.id,'--json']).action,'already-released');
}));

test('a non-ended-owner reassignment ends the custody lineage and the tree stays retained',()=>fixture(f=>{
 const row=f.db.prepare('SELECT * FROM workspace WHERE id=?').get(f.record.id);
 f.db.prepare('INSERT INTO workspace_reassignment(workspace_id,path,old_owner,old_source_commit,new_owner,new_source_commit,authorization,occurred_at) VALUES(?,?,?,?,?,?,?,?)')
  .run(f.record.id,f.source,REPAIR,row.source_commit,'other-label',row.source_commit,JSON.stringify({kind:'operator-receipt'}),Date.now());
 f.db.prepare('UPDATE workspace SET owner=? WHERE id=?').run('other-label',f.record.id);
 const result=f.run(['release','--id',f.record.id,'--json']);
 assert.notEqual(result.action,'released',JSON.stringify(result));assert.equal(result.ordinaryReleaseContinuation,undefined);assert.equal(fs.existsSync(f.source),true);
}));

test('a stale terminal release names the custodian and the plan digest it expects',()=>fixture(f=>{
 assert.throws(()=>f.run(['release','--id',f.record.id,'--end-retention','--owner',REPAIR,'--expected-plan-sha256','0'.repeat(64),'--json']),
  {code:'stale-retention-release',message:/binding\.planSha256, not a dispositionSha256/});
 assert.throws(()=>f.run(['release','--id',f.record.id,'--end-retention','--owner',CHILD,'--expected-plan-sha256','0'.repeat(64),'--json']),
  {code:'stale-retention-release',message:new RegExp('not the current custodian '+REPAIR)});
 assert.equal(fs.existsSync(f.source),true);
}));

// Foreground submission: the adopter continues the ended owner's submission, never conflicts forever.
function submission(fn){const database=new DatabaseSync(':memory:');try{let launches=0;
 const original={database,record:{id:'w',path:'/w',owner:CHILD,state:'repair-required'},request:{id:'w',path:'/w',owner:CHILD,sourceCommit:'a',members:['w'],flags:[]},
  binding:{agentId:CHILD,channel:'beta',callId:'call_child'},settlement:{kind:'none'},launch:()=>{launches++;return {started:'unit-'+launches,log:'/log'};}};
 submitRelease(original);
 const adopter={...original,record:{...original.record,owner:REPAIR},request:{...original.request,owner:REPAIR},binding:{agentId:REPAIR,channel:'beta',callId:'call_repair'},
  settlement:{kind:'completed',requestId:'retired-growth',result:{futureGrowthSettlement:{kind:'retired'}}},custodyLineage:[REPAIR,PARENT,CHILD]};
 fn({database,original,adopter,launches:()=>launches});}finally{database.close();}}
test('adopted custody continues the ended owner submission once its unit ceased',()=>submission(s=>{
 const live=submitRelease({...s.adopter,observe:()=>({ceased:false})});assert.equal(live.error.code,'release-submission-conflict');assert.equal(s.launches(),1);
 const foreign=submitRelease({...s.adopter,custodyLineage:[REPAIR],observe:()=>({ceased:true})});assert.equal(foreign.error.code,'release-submission-conflict');assert.equal(s.launches(),1);
 const unsettled=submitRelease({...s.adopter,settlement:{kind:'owned-retention',requestId:'x'},observe:()=>({ceased:true})});assert.equal(unsettled.error.code,'release-submission-conflict');assert.equal(s.launches(),1);
 const adopted=submitRelease({...s.adopter,observe:()=>({ceased:true})});assert.equal(adopted.action,'release-submitted');assert.equal(s.launches(),2);
 assert.deepEqual(adopted.originalBinding,s.original.binding,'the original binding is immutable');
 const row=s.database.prepare('SELECT * FROM workspace_release_submission').get();
 const history=JSON.parse(row.continuations_json);assert.equal(history.at(-1).custodyAdoptedFrom,CHILD);assert.deepEqual(history.at(-1).binding,s.adopter.binding);
 const again=submitRelease({...s.adopter,observe:()=>({ceased:true})});assert.equal(again.requestId,adopted.requestId);assert.equal(s.launches(),2,'a repeated adopter call never launches twice');
}));
test('an unknown original launch is never continued by an adopter',()=>submission(s=>{
 s.database.prepare("UPDATE workspace_release_submission SET state='launch-unknown'").run();
 const result=submitRelease({...s.adopter,observe:()=>({ceased:true})});assert.equal(result.ok,false);assert.equal(s.launches(),1);
}));

const HELD={id:'held-1',agentId:PARENT,channel:'beta',status:'pending',held:true,goalId:'goal-1',heldFor:null};
test('a goal-only held trigger keeps an ended checkout from sweeps but lets an authenticated adopter take custody',()=>fixture(f=>{
 assert.equal(f.adopted.counts['transferred-to-requester'],1,JSON.stringify(f.adopted));
 assert.equal(f.db.prepare('SELECT owner FROM workspace WHERE id=?').get(f.record.id).owner,REPAIR);
 assert.equal(fs.existsSync(f.source),true,'a custody transfer deletes nothing');
 assert.equal(f.run(['release','--id',f.record.id,'--json']).action,'released');
},{wakes:[{...HELD,text:'measure deliverable timing tomorrow'}]}));
test('a held trigger that names the checkout still refuses the adopter',()=>fixture(f=>{
 assert.equal(f.adopted.results[0].code,'pending-wake-reference',JSON.stringify(f.adopted));
 assert.equal(f.db.prepare('SELECT owner FROM workspace WHERE id=?').get(f.record.id).owner,CHILD);
 assert.equal(fs.existsSync(f.source),true);
},{wakes:[{...HELD,text:'continue the build in $PATH'}]}));

// Background launches are idempotent per name: a continuation that reused the name got the
// earlier accepted launch back and nothing ran (workspace 33b3fad0, October 29).
function namedLauncher(){const names=[];return {names,launch:name=>{const reused=names.includes(name);if(!reused)names.push(name);return {started:'unit-'+name,log:'/log/'+name,reused};}};}
test('every continuation launches under its own background name',()=>submission(s=>{
 const bg=namedLauncher();
 const adopted=submitRelease({...s.adopter,launch:bg.launch,observe:()=>({ceased:true})});assert.equal(adopted.launch.reused,false);
 s.database.prepare("UPDATE workspace_release_submission SET state='terminal-known',terminal_json=?").run(JSON.stringify({exitCode:2,finishedAt:1}));
 const again=submitRelease({...s.adopter,launch:bg.launch,binding:{...s.adopter.binding,callId:'call_later'},observe:()=>({ceased:true})});
 assert.equal(again.launch.reused,false,JSON.stringify(again));assert.equal(new Set(bg.names).size,2);
 assert.equal(again.unitName,adopted.unitName,'the recorded original unit name is unchanged');
}));
test('a continuation stuck on a reused launch continues once its unit ceased',()=>submission(s=>{
 const bg=namedLauncher();
 submitRelease({...s.adopter,launch:bg.launch,observe:()=>({ceased:true})});
 s.database.prepare("UPDATE workspace_release_submission SET state='submitted',launch_json=?").run(JSON.stringify({started:'unit-x',reused:true}));
 const live=submitRelease({...s.adopter,launch:bg.launch,observe:()=>({ceased:false})});assert.equal(bg.names.length,1);assert.equal(live.state,'submitted');
 const resumed=submitRelease({...s.adopter,launch:bg.launch,observe:()=>({ceased:true})});
 assert.equal(bg.names.length,2,JSON.stringify(resumed));assert.equal(resumed.launch.reused,false);
}));
