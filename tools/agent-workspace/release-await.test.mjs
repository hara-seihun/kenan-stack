import './scratch-env.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {awaitSubmittedRelease,awaitUnitCessation} from './release-await.mjs';
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
