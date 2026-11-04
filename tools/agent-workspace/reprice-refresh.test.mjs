import assert from 'node:assert/strict';
import {test} from 'node:test';
import {repriceWithSample} from './reprice-refresh.mjs';
const stale=()=>Object.assign(Error('stale'),{code:'reprice-sample-required'});
test('stale sample refreshes bounded slices and resumes the identical requested price',()=>{
 const request=Object.freeze({intent:'budgeted',headroom:8,growth:3072});let fresh=false,calls=0,walks=0;
 const result=repriceWithSample({deadline:10000,now:()=>0,decide:()=>{calls++;if(!fresh)throw stale();return request;},refresh:()=>{if(++walks===1)return {kind:'partial'};fresh=true;return {kind:'measured'};},defer:()=>assert.fail('must complete')});
 assert.equal(result,request);assert.equal(calls,3);assert.equal(walks,2);
});
test('failed refresh never applies a price or publishes a partial allocation',()=>{
 let calls=0;assert.throws(()=>repriceWithSample({deadline:10000,now:()=>0,decide:()=>{calls++;throw stale();},refresh:()=>({kind:'failed',detail:'permission denied'}),defer:()=>assert.fail()}),{code:'reprice-sample-refresh-failed'});assert.equal(calls,1);
});
test('partial sampling continues as a durable request rather than a false success',()=>{
 let time=0;const pending={state:'running',jobId:'original'};
 assert.equal(repriceWithSample({deadline:3000,now:()=>time,decide:()=>{throw stale();},refresh:()=>{time=2000;return {kind:'partial'};},defer:observations=>{assert.deepEqual(observations,[{kind:'partial'}]);return pending;}}),pending);
});
test('fresh cache does not walk and genuine capacity failure is not retried',()=>{
 assert.equal(repriceWithSample({decide:()=>42,refresh:()=>assert.fail()}),42);
 const error=Object.assign(Error('capacity'),{code:'workspace-capacity-refused'});
 assert.throws(()=>repriceWithSample({decide:()=>{throw error;},refresh:()=>assert.fail()}),e=>e===error);
});
