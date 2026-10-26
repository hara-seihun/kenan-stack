import assert from 'node:assert/strict';
import {test} from 'node:test';
import {capacityRecovery} from './capacity-recovery.mjs';
const line='5.69 GiB is free; 18.34 GiB is required (source forecast + declared growth + operating headroom + other reservations)';
const diagnostic={freeBytes:6112575488,requiredBytes:19688189602,device:'2049',observedAt:1792278467203,breakdown:{requiredBytes:19688189602}};
const observation={freeBytes:30*1024**3,device:'2049',observedAt:Date.now(),freeInodes:100,totalInodes:200};
const terminal=message=>({state:'failed',error:{code:'workspace-capacity-refused',message}});
test('typed capacity diagnostic suffix does not permanently strand original operation',()=>{
 const old=terminal(`${line}\ncapacity-detail: ${JSON.stringify(diagnostic)}`);
 const result=capacityRecovery(old,'a'.repeat(64),observation);
 assert.equal(result.state,'retry');
 assert.deepEqual(result.value.originalRefusal,old.error);
 assert.equal(result.value.previousJobId,'a'.repeat(64));
});
test('unrelated or malformed appended diagnostics never authorize recovery',()=>{
 for(const suffix of ['\nother error','\ncapacity-detail: nope','\ncapacity-detail: null','\ncapacity-detail: []','\ncapacity-detail: {}','\ncapacity-detail: '+JSON.stringify({...diagnostic,freeBytes:-1}),'\ncapacity-detail: '+JSON.stringify(diagnostic)+'\nother error']) {
  assert.equal(capacityRecovery(terminal(line+suffix),'a'.repeat(64),observation).state,'terminal');
 }
});
test('owned fair-refresh diagnostic preserves original refusal recovery without granting admission',()=>{
 for(const refresh of [{observations:[],budgetMs:30000},{observations:[{path:'native-terminal-projection',kind:'terminal-projection',settled:0},{path:'/workspace/old',kind:'measured',route:'unprivileged'},{path:'/workspace/large',kind:'partial',route:'unprivileged'}],budgetMs:30000}]){
  const old=terminal(`${line}\ncapacity-detail: ${JSON.stringify(diagnostic)}\ncapacity-refresh: ${JSON.stringify(refresh)}`);
  const result=capacityRecovery(old,'a'.repeat(64),observation);
  assert.equal(result.state,'retry');assert.deepEqual(result.value.originalRefusal,old.error);
  assert.equal(result.value.previousJobId,'a'.repeat(64));assert.deepEqual(result.value.observation,observation);
 }
});
test('refresh suffix must be the exact owned finite shape after valid capacity detail',()=>{
 const prefix=`${line}\ncapacity-detail: ${JSON.stringify(diagnostic)}`;
 for(const value of [null,[],{}, {observations:[],budgetMs:-1},{observations:'bad',budgetMs:30000},{observations:[{path:'/x',kind:'fictional'}],budgetMs:30000},{observations:[],budgetMs:30000,unknown:true}])
  assert.equal(capacityRecovery(terminal(`${prefix}\ncapacity-refresh: ${JSON.stringify(value)}`),'a'.repeat(64),observation).state,'terminal');
 for(const message of [`${prefix}\ncapacity-refresh: nope`,`${prefix}\ncapacity-refresh: {"observations":[],"budgetMs":30000}\nother error`,`${line}\ncapacity-refresh: {"observations":[],"budgetMs":30000}`])
  assert.equal(capacityRecovery(terminal(message),'a'.repeat(64),observation).state,'terminal');
});
