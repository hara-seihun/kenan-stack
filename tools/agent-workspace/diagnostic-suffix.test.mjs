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
