import {test} from 'node:test';
import assert from 'node:assert/strict';
import {classifyReleaseDelegation,observeReleaseDelegation,releaseDelegationSql} from './release-delegation.mjs';
const caller='22222222-2222-4222-8222-222222222222',custodian='manager:converge';
const worker={id:caller,ownerId:'converge',role:'worker',goalId:'goal-1',parentAgentId:custodian,state:'running',archived:false};
const owner={id:custodian,ownerId:'converge',role:'manager',goalId:null,parentAgentId:null,state:'idle',archived:false};
test('a live worker launched by the actual custodian may release without changing custody',()=>{
 assert.deepEqual(classifyReleaseDelegation([worker,owner],caller,custodian),{allowed:true,kind:'custodian-child'});
});
test('a successor on the same nonempty goal may release the old custodian checkout',()=>{
 const old={...owner,id:'11111111-1111-4111-8111-111111111111',role:'worker',goalId:'goal-1',archived:true};
 assert.deepEqual(classifyReleaseDelegation([{...worker,parentAgentId:'manager:other'},old],caller,old.id),{allowed:true,kind:'custodian-goal'});
});
for(const [name,c,o] of [
 ['unrelated worker',{...worker,parentAgentId:'manager:other'},owner],
 ['different work account',{...worker,ownerId:'another'},owner],
 ['stopped caller',{...worker,state:'stopped'},owner],
 ['archived caller',{...worker,archived:true},owner],
 ['manager caller',{...worker,role:'manager'},owner],
 ['missing owner account',worker,{...owner,ownerId:null}],
 ['null goals',{...worker,parentAgentId:null,goalId:null},owner],
 ['empty goals',{...worker,parentAgentId:null,goalId:''},{...owner,goalId:''}]
])test('release delegation refuses '+name,()=>assert.equal(classifyReleaseDelegation([c,o],caller,custodian).allowed,false));
test('missing, duplicate and malformed native rows never delegate',()=>{
 for(const rows of [[],[worker],[owner],[worker,worker,owner],[worker,owner,owner],null,{}])assert.equal(classifyReleaseDelegation(rows,caller,custodian).allowed,false);
});
test('release delegation reads only exact native identities in the authenticated channel',()=>{
 let calls=0;
 const result=observeReleaseDelegation({agentId:caller,channel:'beta'},custodian,{deadline:Date.now()+10000,user:()=> 'kenan',execute:(command,args)=>{
  calls++;assert.equal(command,'psql');assert.equal(args[args.indexOf('--dbname')+1],'kenan_beta');
  assert.match(args.at(-1),/BEGIN READ ONLY/);assert.match(args.at(-1),/parent_agent_id/);assert.match(args.at(-1),/owner_id/);
  return {status:0,stdout:JSON.stringify([worker,owner])};
 }});
 assert.equal(calls,1);assert.equal(result.allowed,true);
 assert.throws(()=>releaseDelegationSql("' OR true",custodian));
});
test('failed, incomplete and expired store observations never delegate',()=>{
 for(const result of [{status:1},{status:0,error:{code:'ETIMEDOUT'}},{status:0,signal:'SIGTERM'},{status:0,stdout:'partial'},{status:0,stdout:'[]'}])
  assert.equal(observeReleaseDelegation({agentId:caller,channel:'beta'},custodian,{deadline:Date.now()+1000,execute:()=>result}).allowed,false);
 assert.equal(observeReleaseDelegation({agentId:caller,channel:'beta'},custodian,{deadline:Date.now()-1,execute:()=>assert.fail('expired')}).allowed,false);
});
