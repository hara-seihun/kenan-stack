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
