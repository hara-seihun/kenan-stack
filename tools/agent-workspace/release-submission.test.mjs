import {test} from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';
const {submitRelease}=await import(process.env.WORKSPACE_SUBMISSION_MODULE??'./release-submission.mjs');
function fixture(fn){const database=new DatabaseSync(':memory:');try{let launches=0;const record={id:'fixture',path:'/fixture/source',owner:'owner',state:'active'};
 const base={database,record,request:{id:'fixture',owner:'owner',flags:[['preserve-runtime',['true']]]},binding:{agentId:'owner',channel:'beta',callId:'full|original'},settlement:{kind:'none'},launch:()=>{launches++;return {started:'root-unit',log:'/durable/log'};}};fn(base,()=>launches);}finally{database.close();}}
test('duplicate foreground release adopts original request, unit and full binding without a competing launch',()=>fixture((base,count)=>{
 const first=submitRelease(base);assert.equal(first.completed,false);assert.equal(first.action,'release-submitted');
 const again=submitRelease({...base,binding:{...base.binding,callId:'a later call'}});
 assert.equal(count(),1);assert.equal(again.requestId,first.requestId);assert.equal(again.unitName,first.unitName);assert.deepEqual(again.originalBinding,base.binding);
}));
test('a restart after safety and an unsettled physical transition never blindly relaunches',()=>fixture((base,count)=>{
 const first=submitRelease({...base,launch:()=>{throw Error('connection disappeared');}});
 const again=submitRelease({...base,record:{...base.record,state:'reclaiming'},settlement:{kind:'owned-retention',requestId:'original-effect',physicalDisposition:{kind:'unsettled'}}});
 assert.equal(first.state,'launch-unknown');assert.equal(again.requestId,first.requestId);assert.equal(count(),0);assert.equal(again.completed,false);assert.equal(again.releaseSettlement.requestId,'original-effect');
}));
test('a settled release is idempotent and changed requests cannot replace custody',()=>fixture((base,count)=>{
 submitRelease(base);const changed=submitRelease({...base,request:{...base.request,owner:'foreign'}});assert.equal(changed.ok,false);assert.equal(count(),1);
 const settled=submitRelease({...base,record:{...base.record,state:'released'},settlement:{kind:'completed',requestId:'original-effect'}});assert.equal(settled.action,'already-released');assert.equal(count(),1);
}));
test('a known protected refusal continues the same request only after the original unit ceased',()=>fixture((base,count)=>{
 const first=submitRelease(base);base.database.prepare("UPDATE workspace_release_submission SET state='terminal-known',terminal_json=?").run(JSON.stringify({exitCode:2,finishedAt:1}));
 const live=submitRelease({...base,observe:()=>({ceased:false})});assert.equal(count(),1);assert.equal(live.requestId,first.requestId);
 const resumed=submitRelease({...base,binding:{...base.binding,callId:'authentic continuation'},observe:()=>({ceased:true})});assert.equal(count(),2);assert.equal(resumed.requestId,first.requestId);assert.equal(resumed.unitName,first.unitName);assert.deepEqual(resumed.originalBinding,base.binding);
 const duplicate=submitRelease({...base,observe:()=>({ceased:true})});assert.equal(count(),2);assert.equal(duplicate.requestId,first.requestId);
}));
test('an unknown original effect is never relaunched even if its unit is gone',()=>fixture((base,count)=>{
 const first=submitRelease({...base,launch:()=>({code:'response-lost'})});assert.equal(first.state,'launch-unknown');
 submitRelease({...base,observe:()=>({ceased:true})});assert.equal(count(),0);
}));

test('a parent custody conflict preserves the child request and names the existing authenticated background continuation',()=>fixture((base,count)=>{
 const original=submitRelease(base),before=base.database.prepare('SELECT * FROM workspace_release_submission').get();
 const result=submitRelease({...base,record:{...base.record,owner:'parent'},binding:{...base.binding,agentId:'parent'},request:{...base.request,owner:'parent'},settlement:{kind:'completed',requestId:'retained-child-effect'}});
 assert.equal(result.error.code,'release-submission-conflict');assert.equal(result.requestId,original.requestId);assert.equal(count(),1);
 assert.deepEqual(result.nextAction.settleInAuthenticatedBackground,['kenan-bg','workspace-release-continuation','--','agent-workspace','release','--id','fixture','--preserve-runtime=true','--json']);
 assert.deepEqual(base.database.prepare('SELECT * FROM workspace_release_submission').get(),before,'guidance does not rewrite or relaunch the original effect');
}));
