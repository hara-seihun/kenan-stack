import {test} from 'node:test';
import assert from 'node:assert/strict';
import {nativeCaller} from './native-owner.mjs';
import {authorizeWorkspaceRelease} from './release-authority.mjs';
const actual=nativeCaller();
test('a real root-authenticated run identity survives a store timeout but not a healthy missing record',{skip:actual===null},()=>{
 const invoke=(binding,errors)=>authorizeWorkspaceRelease(null,[],'/unused',{confirmWaitMs:0,caller:()=>({ok:true,kind:'native',binding}),authenticate:()=>({errors,confirmed:new Map()})});
 assert.equal(invoke(actual,['native tool-call observation unavailable: beta: statement timeout']).ok,true);
 assert.equal(invoke({...actual,callId:'foreign'},['statement timeout']).ok,false);
 assert.equal(invoke({...actual,agentId:'11111111-1111-4111-8111-111111111111'},['statement timeout']).ok,false);
 assert.equal(invoke(actual,[]).ok,false);
 assert.equal(invoke(actual,['permission denied']).ok,false);
});
