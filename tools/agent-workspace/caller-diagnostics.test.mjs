import {test} from 'node:test';
import assert from 'node:assert/strict';
const {callerToolCall,procScope}=await import(process.env.WORKSPACE_QUEUE_MODULE||'./cache-queue.mjs');
const {nativeCaller}=await import(process.env.WORKSPACE_OWNER_MODULE||'./native-owner.mjs');
const {releaseCaller}=await import(process.env.WORKSPACE_AUTHORITY_MODULE||'./release-authority.mjs');
const group='/user.slice/user-agents.slice/agent-tool-beta-00000000-0000-4000-8000-000000000000.scope';
const binding={agentId:'22222222-2222-4222-8222-222222222222',channel:'beta',callId:'call_'+'a'.repeat(32)+'|fc_'+'b'.repeat(50)};
const description={version:1,...binding};
const properties={Description:'kenan-tool-call:'+JSON.stringify(description),ControlGroup:group,Transient:'yes',ActiveState:'active'};
const io={pid:10,uid:()=>0,parent:p=>p===10?9:1,argv:()=>['node','/srv/kenan/beta/dist/server/main.js']};
const scope=(query)=> (pid,options)=>procScope(pid,{...options,read:()=>`0::${group}\n`,query});
const query=patch=>()=>({status:0,stdout:Object.entries({...properties,...patch}).map(([k,v])=>`${k}=${v}`).join('\n')});
const observe=scope=>{const errors=[];const result=callerToolCall({...io,scope,onError:e=>errors.push(e)});return {result,errors};};

test('the actual swarm scope shape retains the complete native identity without an environment grant',()=>{
 assert.deepEqual(observe(scope(query({}))),{result:binding,errors:[]});
});
for(const [code,queryFixture] of [
 ['caller-scope-query-failed',()=>({status:null,error:{code:'ETIMEDOUT'},stderr:'must not disclose raw output'})],
 ['caller-scope-cgroup-mismatch',query({ControlGroup:group+'/sibling'})],
 ['caller-scope-not-active',query({ActiveState:'inactive'})],
 ['caller-scope-identity-missing',query({Description:'unrelated'})],
 ['caller-observation-failed',query({Description:'kenan-tool-call:{invalid-json'})]
])test('a failed root scope observation retains '+code+' and never grants release',()=>{
 const {result,errors}=observe(scope(queryFixture));assert.equal(result,null);assert.equal(errors.length,1);assert.equal(errors[0].code,code);
 const failure=releaseCaller({caller:options=>nativeCaller({caller:({onError})=>callerToolCall({...io,scope:scope(queryFixture),onError}),...options}),pid:10,cgroup:()=>`0::${group}\n`});
 assert.equal(failure.ok,false);assert.equal(failure.error.code,'release-caller-unverified');assert.equal(failure.diagnostic.code,code);assert.match(failure.error.detail,new RegExp(code));
 const output=JSON.stringify(failure);for(const value of [binding.callId,binding.agentId,'must not disclose raw output'])assert.equal(output.includes(value),false);
});
test('missing, foreign and unreadable server ancestry have explicit causes, not a missing-propagation claim',()=>{
 for(const [code,extra] of [
  ['caller-server-ancestor-missing',{parent:()=>1}],
  ['caller-server-channel-mismatch',{argv:()=>['node','/srv/kenan/production/dist/server/main.js']}],
  ['caller-observation-failed',{argv:()=>{throw Object.assign(new Error('private command'),{code:'EACCES'});}}]
 ]){
  const errors=[];assert.equal(callerToolCall({...io,scope:scope(query({})),...extra,onError:e=>errors.push(e)}),null);assert.equal(errors[0].code,code);assert.equal(JSON.stringify(errors).includes('private command'),false);
 }
 const errors=[];assert.equal(nativeCaller({caller:()=>({...binding,callId:'forged|shape'}),onError:e=>errors.push(e)}),null);assert.equal(errors[0].code,'caller-binding-invalid');
});
test('a server started with node options before its script (kenan@.service passes --max-old-space-size) is still the caller server',()=>{
 const live=['/usr/local/bin/node','--max-old-space-size=12288','/srv/kenan/beta/dist/server/main.js','/etc/kenan/beta.json'];
 assert.deepEqual(callerToolCall({...io,argv:()=>live,scope:scope(query({}))}),binding);
 assert.equal(releaseCaller({caller:()=>null,pid:10,cgroup:()=>'0::/system.slice/x.service\n',parent:p=>p===10?9:1,argv:p=>p===9?[...live,'']:['bash']}).error.code,'release-caller-unverified');
});
