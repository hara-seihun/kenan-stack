import {test} from 'node:test';
import assert from 'node:assert/strict';
import {runReleaseWorker,transientToolCallReference} from './release-retry.mjs';
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

// Oct 28 regression (goal 13e96a50): backup-incr-6d03 stayed repair-required because the
// background release ran while the caller's own next foreground call, which merely named
// the checkout, was still streaming. The worker must re-observe until that call ends.
const toolRef={kind:'tool_call',id:'3c9ba053',state:'running',resourceClass:'reserved-tool-call',toolName:'bash'};
const referenced=(refs=[toolRef])=>({inspection:{classification:'referenced',currentStackQueueProtected:true,currentStackReferences:refs},physicalDisposition:{kind:'retained'}});
const released={action:'released',physicalDisposition:{kind:'removed'},futureGrowthSettlement:{kind:'retired'}};
test('a checkout retained only by a running tool call is re-observed until that call ends',async()=>{
 let calls=0,slept=[];
 const result=await runReleaseWorker(()=>child(++calls<3?referenced():released),{sleep:async ms=>{slept.push(ms);}});
 assert.equal(calls,3);assert.deepEqual(slept,[2000,2000]);assert.equal(result.exitCode,0);assert.deepEqual(result.receipt,released);
});
test('a terminal continuation retained only by a running tool call also retries (exit 2)',async()=>{
 const values=[child({ok:false,...referenced(),error:{code:'retention-release-protected'}},2),child(released)];
 const result=await runReleaseWorker(()=>values.shift(),{sleep:async()=>{}});
 assert.equal(values.length,0);assert.deepEqual(result.receipt,released);
});
test('a tool call that outlives the budget leaves the original retained result, not success',async()=>{
 let clock=0,calls=0;
 const result=await runReleaseWorker(()=>{calls++;return child(referenced());},{now:()=>clock,sleep:async ms=>{clock+=ms;},budgetMs:7000});
 assert.equal(calls,4);assert.equal(result.exitCode,0);assert.equal(result.receipt.physicalDisposition.kind,'retained');
});
test('agents, processes, unknown observations and mixed references are never waited out',()=>{
 for(const receipt of [
  referenced([{kind:'agent',id:'w',state:'idle'}]),
  referenced([toolRef,{kind:'agent',id:'w',state:'idle'}]),
  referenced([]),
  {inspection:{classification:'blocked',currentStackQueueProtected:true,reason:'current Stack queue observation unavailable'}},
  {inspection:{classification:'referenced',reason:'1 process',processes:[{pid:1}]}},
  {inspection:{classification:'repair-required',sourceRetention:true}},
  [referenced(),{inspection:{classification:'referenced',processes:[{pid:1}]}}],
 ])assert.equal(transientToolCallReference(receipt),false,JSON.stringify(receipt));
 assert.equal(transientToolCallReference([referenced(),released]),true);
});

test('a safety observation timeout is re-observed, then left as a known refusal',async()=>{
 const {runReleaseWorker}=await import('./release-retry.mjs');
 const timeout={status:2,stdout:JSON.stringify({ok:false,error:{code:'inspection-timeout',detail:'workspace inspection timed out'}})};
 const released={status:0,stdout:JSON.stringify({ok:true,action:'released',record:{state:'released'}})};
 let calls=0;const done=await runReleaseWorker(()=>++calls<3?timeout:released,{sleep:async()=>{},now:()=>0});
 assert.equal(calls,3);assert.equal(done.exitCode,0);
 let t=0;const out=await runReleaseWorker(()=>timeout,{sleep:async()=>{t+=2000;},now:()=>t,budgetMs:5000});
 assert.equal(out.known,true,'a typed timeout is a known non-effect the next continuation may follow');assert.equal(out.exitCode,2);
});
