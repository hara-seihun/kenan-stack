import {test} from 'node:test';
import assert from 'node:assert/strict';
import {runReleaseWorker} from './release-retry.mjs';
const child=(receipt,status=0)=>({stdout:JSON.stringify(receipt),stderr:'',status});
const busy={futureGrowthSettlement:{kind:'retained',code:'workspace-capacity-lock-busy'}};
const settled={futureGrowthSettlement:{kind:'retired',sequence:631}};
test('a capacity lock refusal with exit zero retries automatically and returns only the new result',async()=>{
 let calls=0,sleeps=0;
 const result=await runReleaseWorker(()=>child(++calls<3?busy:settled),{sleep:async()=>{sleeps++;}});
 assert.equal(calls,3);assert.equal(sleeps,2);assert.equal(result.exitCode,0);assert.equal(result.known,true);
 assert.deepEqual(JSON.parse(result.result.stdout),settled);
});
test('a checkout lock refusal retries, including group capacity settlement',async()=>{
 const values=[child({error:{code:'release-resource-busy'}},75),child([busy]),child([settled])];
 const result=await runReleaseWorker(()=>values.shift(),{sleep:async()=>{}});
 assert.equal(result.exitCode,0);assert.deepEqual(result.receipt,[settled]);assert.equal(values.length,0);
});
test('bounded lock exhaustion is a known retryable refusal, not success',async()=>{
 let clock=0;
 const result=await runReleaseWorker(()=>child(busy),{now:()=>clock,sleep:async()=>{clock+=250;},budgetMs:500});
 assert.equal(clock,500);assert.equal(result.exitCode,75);assert.equal(result.known,true);
});
test('unknown effects and non-lock safety refusals are never retried',async()=>{
 for(const result of [child({error:{code:'release-caller-unverified'}},2),child({futureGrowthSettlement:{kind:'retained',code:'growth-sample-required'}}),{...child(busy),signal:'SIGTERM'}, {stdout:'partial',status:75}]) {
  let calls=0;const outcome=await runReleaseWorker(()=>{calls++;return result;});
  assert.equal(calls,1);if(result.signal)assert.equal(outcome.known,false);
 }
});
