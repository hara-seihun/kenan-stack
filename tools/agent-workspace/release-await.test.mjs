import './scratch-env.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {awaitSubmittedRelease,awaitUnitCessation,RELEASE_AWAIT_MS} from './release-await.mjs';
const removed={recordState:'released',pathExists:false,submissionState:'submitted'};
test('foreground completion waits for the durable settlement after physical removal',()=>{
 let reads=0,time=0;
 const result=awaitSubmittedRelease({read:()=>({...removed,settlementKind:++reads===1?'owned-retention':'completed'}),now:()=>time,sleep:ms=>{time+=ms;}});
 assert.equal(result.kind,'completed');assert.equal(reads,2);
});
test('physical removal without a completed settlement stays pending while the original unit runs',()=>{
 assert.equal(awaitSubmittedRelease({read:()=>({...removed,settlementKind:'owned-retention'}),budgetMs:0}).kind,'pending');
});
test('a ceased original unit cannot turn an uncommitted settlement into completion',()=>{
 assert.equal(awaitSubmittedRelease({read:()=>({...removed,unitCeased:true,settlementKind:'unset'}),budgetMs:0}).kind,'terminal');
});

test('the cessation wait returns as soon as the unit ceases and otherwise ends at its budget',()=>{
 let time=0,reads=0;const fake={now:()=>time,sleep:ms=>{time+=ms;}};
 assert.equal(awaitUnitCessation({observe:()=>({ceased:++reads===2}),...fake}).ceased,true);assert.equal(reads,2);
 assert.equal(awaitUnitCessation({observe:()=>({ceased:false}),budgetMs:300,...fake}).ceased,false);
});


const {retainedReleaseReport} = await import('./release-await.mjs');
test('retained continuation reports its current refusal rather than the old dirty-tree settlement', () => {
 const old = {kind:'completed', result:{physicalDisposition:{kind:'retained',reason:'working tree has changes'}}};
 const result = {error:{code:'retention-release-protected'},inspection:{classification:'blocked',processes:[{pid:42,matches:['cwd:/workspace']} ]}};
 const terminal = {exitCode:2,result};
 const report = retainedReleaseReport({releaseSettlement:old,requestId:'original'},terminal,old);
 assert.equal(report.result,result);
 assert.equal(report.releaseSettlement,undefined);
 assert.equal(report.previousReleaseSettlement,old);
 assert.match(report.hint,/from outside/);
 assert.equal(report.completed,false);
 assert.equal(report.requestId,'original');
 assert.equal(result.inspection.processes[0].pid,42,'process safety evidence is unchanged');
});
test('older terminal receipts keep their log and settlement fallback without inventing a result', () => {
 const old = {kind:'completed'};
 const report = retainedReleaseReport({launch:{log:'/original/log'}},{exitCode:2},old);
 assert.equal(report.releaseSettlement,old);
 assert.equal(report.result,undefined);
 assert.equal(report.hint,undefined);
 assert.match(report.note,/original\/log/);
});
test('references without a cwd match never claim that changing directory resolves them', () => {
 const report = retainedReleaseReport({}, {result:{inspection:{processes:[{matches:['argument']}]}}}, {});
 assert.equal(report.hint,undefined);
});

test('a slow release returns pending within the short foreground budget without another launch',()=>{
 let time=0,reads=0;
 const observed={recordState:'active',pathExists:true,submissionState:'submitted',unitCeased:false};
 const result=awaitSubmittedRelease({read:()=>{reads++;return observed;},now:()=>time,sleep:ms=>{time+=ms;}});
 assert.equal(result.kind,'pending');assert.equal(result.observed,observed);
 assert.equal(time,RELEASE_AWAIT_MS);assert.ok(time<=5000);assert.ok(reads>1);
});
