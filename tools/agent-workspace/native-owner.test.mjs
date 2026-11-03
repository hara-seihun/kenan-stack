import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync,spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {isBoundGoalLabel,admissionOwner,nativeCaller,bindNativeOwner,unbindNativeOwner,reassignNativeOwner,nativeOwnerBinding,canonicalNativeOwner,admissionReceipts,authenticateToolCalls,receiptBinding,toolCallAuthenticationSql} from './native-owner.mjs';

const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222';
const REQUEST='{"op":"create","name":"task"}',WS='ws-1';
const tmp=()=>fs.mkdtempSync(path.join(os.tmpdir(),'native-owner-'));
const db=()=>new DatabaseSync(':memory:');

// Writes checkout-jobs/<ws>/<job>/{environment,request}.json beside a fake state file.
function jobs(spec){
 const root=tmp(),statePath=path.join(root,'state.sqlite');
 for(const [job,{environment,request,raw}] of Object.entries(spec)){
  const dir=path.join(root,'checkout-jobs',WS,job);fs.mkdirSync(dir,{recursive:true});
  if(environment!==undefined)fs.writeFileSync(path.join(dir,'environment.json'),raw?.environment??JSON.stringify(environment));
  if(request!==undefined)fs.writeFileSync(path.join(dir,'request.json'),raw?.request??JSON.stringify(request));
 }
 return statePath;
}
const good=(agent,call,extra={})=>({environment:{KENAN_AGENT:agent,KENAN_TOOL_CALL_ID:call},request:{id:WS,request:REQUEST},...extra});

test('caller binding comes only from the authenticated scope reader, never from the environment or labels',()=>{
 const saved=process.env.PI_WORKSPACE_TEST_CALLER;
 process.env.PI_WORKSPACE_TEST_CALLER=JSON.stringify({agentId:A,channel:'beta',callId:'c1'});
 try{
  assert.equal(nativeCaller({caller:()=>null}),null,'an environment variable cannot stand in for the root scope');
  assert.deepEqual(nativeCaller({caller:()=>({agentId:A,channel:'beta',callId:'c1',extra:1})}),{agentId:A,channel:'beta',callId:'c1'});
  assert.equal(nativeCaller({caller:()=>({agentId:'task-name',channel:'beta',callId:'c1'})}),null);
  assert.equal(nativeCaller({caller:()=>({agentId:A,channel:'Bad Channel',callId:'c1'})}),null);
  assert.equal(nativeCaller({caller:()=>({agentId:A,channel:'beta',callId:'bad id'})}),null);
  assert.equal(nativeCaller({caller:()=>{throw new Error('proc unreadable');}}),null);
 }finally{if(saved===undefined)delete process.env.PI_WORKSPACE_TEST_CALLER;else process.env.PI_WORKSPACE_TEST_CALLER=saved;}
});

test('free labels canonicalize only with an authenticated binding; legitimate UUID owners stay untouched',()=>{
 const d=db();
 assert.equal(canonicalNativeOwner(d,{id:WS,owner:'my-task'}),'my-task','an unbound label stays a label');
 assert.equal(canonicalNativeOwner(d,{id:WS,owner:B}),B);
 bindNativeOwner(d,WS,{agentId:A,channel:'beta',callId:'c1'},'caller-scope',{command:'create'});
 assert.equal(canonicalNativeOwner(d,{id:WS,owner:'my-task'}),A);
 assert.equal(canonicalNativeOwner(d,{id:WS,owner:B}),B,'a registered native owner is never replaced by a binding');
 assert.equal(canonicalNativeOwner(d,{id:'other',owner:'my-task'}),'my-task');
 assert.throws(()=>bindNativeOwner(d,WS,{agentId:'my-task',channel:'beta',callId:'c1'},'caller-scope'),/authenticated native owner binding required/);
 assert.throws(()=>bindNativeOwner(d,WS,{agentId:A,channel:'beta',callId:'c1'},'label'),/unknown native owner binding source/);
 assert.equal(nativeOwnerBinding(d,WS).agentId,A);
});

test('safe reassign and unbind: an authenticated caller replaces the owner, any other caller clears it, a receipt never overrides another agent',()=>{
 const d=db();
 bindNativeOwner(d,WS,{agentId:A,channel:'beta',callId:'c1'},'caller-scope');
 assert.throws(()=>bindNativeOwner(d,WS,{agentId:B,channel:'beta',callId:'c2'},'admission-receipt'),/conflicts with the existing/);
 assert.equal(nativeOwnerBinding(d,WS).agentId,A,'a refused receipt leaves the binding intact');
 bindNativeOwner(d,WS,{agentId:A,channel:'beta',callId:'c9'},'admission-receipt',{});
 assert.equal(nativeOwnerBinding(d,WS).callId,'c9','the same agent may refresh its own evidence');
 assert.equal(reassignNativeOwner(d,WS,{agentId:B,channel:'beta',callId:'c3'},{command:'reassign'}).agentId,B);
 assert.deepEqual(reassignNativeOwner(d,WS,null,null),{state:'unset'});
 assert.equal(canonicalNativeOwner(d,{id:WS,owner:'label'}),'label');
 unbindNativeOwner(d,WS);unbindNativeOwner(d,WS);
 assert.deepEqual(nativeOwnerBinding(d,WS),{state:'unset'});
});

test('admission receipts require byte-equal creation requests and consistent identities, and fail closed otherwise',()=>{
 let r=admissionReceipts(jobs({a:good(A,'c1'),b:good(A,'c2')}),WS,REQUEST);
 assert.equal(r.kind,'receipt');assert.equal(r.agentId,A);assert.equal(r.pairs.length,2);
 assert.equal(admissionReceipts(path.join(tmp(),'state.sqlite'),WS,REQUEST).code,'no-checkout-job');
 assert.equal(admissionReceipts(jobs({a:{environment:{PATH:'/bin'},request:{id:WS,request:REQUEST}}}),WS,REQUEST).code,'no-caller-receipt');
 assert.equal(admissionReceipts(jobs({a:good(A,'c1',{request:{id:WS,request:REQUEST+' '}})}),WS,REQUEST).code,'receipt-request-mismatch');
 assert.equal(admissionReceipts(jobs({a:good(A,'c1',{request:{id:'ws-2',request:REQUEST}})}),WS,REQUEST).code,'receipt-request-mismatch');
 assert.equal(admissionReceipts(jobs({a:good(A,'c1')}),WS,'').code,'receipt-request-mismatch');
 assert.equal(admissionReceipts(jobs({a:good(A,'c1')}),WS,undefined).code,'receipt-request-mismatch');
 assert.equal(admissionReceipts(jobs({a:good(A,'c1'),b:good(A,'c2',{request:{id:WS,request:'other'}})}),WS,REQUEST).code,'receipt-request-mismatch','one mismatching job poisons the set');
 assert.equal(admissionReceipts(jobs({a:good(A,'c1'),b:good(B,'c2')}),WS,REQUEST).code,'receipt-agents-conflict');
 assert.equal(admissionReceipts(jobs({a:{environment:{KENAN_AGENT:A},request:{id:WS,request:REQUEST}}}),WS,REQUEST).code,'receipt-identity-malformed');
 assert.equal(admissionReceipts(jobs({a:{environment:{KENAN_TOOL_CALL_ID:'c1'},request:{id:WS,request:REQUEST}}}),WS,REQUEST).code,'receipt-identity-malformed');
 assert.equal(admissionReceipts(jobs({a:good('task-name','c1')}),WS,REQUEST).code,'receipt-identity-malformed','a label is not an agent id');
 assert.equal(admissionReceipts(jobs({a:good(A,'bad call')}),WS,REQUEST).code,'receipt-identity-malformed');
 assert.equal(admissionReceipts(jobs({a:{environment:{},raw:{environment:'{not json'}}}),WS,REQUEST).code,'receipt-environment-unreadable');
 assert.equal(admissionReceipts(jobs({a:{environment:{},raw:{environment:'null'}}}),WS,REQUEST).code,'receipt-environment-unreadable');
 assert.equal(admissionReceipts(jobs({a:{environment:{KENAN_AGENT:A,KENAN_TOOL_CALL_ID:'c1'}}}),WS,REQUEST).code,'receipt-request-unreadable','missing request');
 assert.equal(admissionReceipts(jobs({a:{environment:{KENAN_AGENT:A,KENAN_TOOL_CALL_ID:'c1'},request:{},raw:{request:'[[['}}}),WS,REQUEST).code,'receipt-request-unreadable');
});

const COMPOSITE='call_'+ 'a'.repeat(32)+'|fc_'+ 'b'.repeat(50);
test('native composite call ids preserve the complete authenticated identity without admitting arbitrary pipes',()=>{
 const binding={agentId:A,channel:'beta',callId:COMPOSITE};
 assert.deepEqual(nativeCaller({caller:()=>binding}),binding);
 const r=admissionReceipts(jobs({a:good(A,COMPOSITE)}),WS,REQUEST);
 assert.equal(r.kind,'receipt');assert.equal(r.pairs[0].callId,COMPOSITE);
 const authenticated={errors:[],confirmed:new Map([[A+'\0'+COMPOSITE,['beta']]])};
 const result=receiptBinding(r,authenticated);
 assert.equal(result.kind,'bindable');assert.equal(result.binding.callId,COMPOSITE);
 const d=db();bindNativeOwner(d,WS,result.binding,'admission-receipt',result.evidence);
 assert.equal(canonicalNativeOwner(d,{id:WS,owner:'custom-root-label'}),A);
 assert.equal(nativeOwnerBinding(d,WS).callId,COMPOSITE);
 assert.equal(receiptBinding(r,{errors:[],confirmed:new Map([[A+'\0'+COMPOSITE.split('|')[0],['beta']]])}).code,'receipt-tool-call-unconfirmed','a partial call id never authenticates');
 for(const invalid of ['call_a|fc_b',COMPOSITE+'|extra',COMPOSITE.replace('|','||'),COMPOSITE.slice(0,-1),COMPOSITE+'b',COMPOSITE.toUpperCase(),'label|label',COMPOSITE+'\n',COMPOSITE+"'"]){
  assert.equal(admissionReceipts(jobs({a:good(A,invalid)}),WS,REQUEST).code,'receipt-identity-malformed',invalid);
  assert.throws(()=>toolCallAuthenticationSql([{agentId:A,callId:invalid}]),/bounded exact/);
 }
 assert.match(toolCallAuthenticationSql([{agentId:A,callId:COMPOSITE}]),new RegExp(COMPOSITE.replace('|','\\|')));
});

const receipt=pairs=>({kind:'receipt',agentId:A,pairs:pairs.map(([callId,job])=>({agentId:A,callId,job}))});
const seen=(...entries)=>({errors:[],confirmed:new Map(entries.map(([call,channels])=>[A+'\0'+call,channels]))});

test('receipt binding needs every call confirmed on exactly one and the same channel',()=>{
 const v=receiptBinding(receipt([['c1','j1'],['c2','j2']]),seen(['c1',['beta']],['c2',['beta']]));
 assert.equal(v.kind,'bindable');assert.deepEqual(v.binding,{agentId:A,channel:'beta',callId:'c1'});assert.equal(v.evidence.jobs.length,2);
 assert.equal(receiptBinding(receipt([['c1','j1']]),seen(['c1',['beta','production']])).code,'receipt-tool-call-ambiguous');
 assert.equal(receiptBinding(receipt([['c1','j1']]),seen()).code,'receipt-tool-call-unconfirmed');
 const moved=receiptBinding(receipt([['c1','j1'],['c2','j2']]),{...seen(['c1',['beta','production']],['c2',['production']]),current:new Map([[A,'production']])});
 assert.equal(moved.kind,'bindable','a call from before the owner moved channels is in both; the current channel wins');assert.equal(moved.binding.channel,'production');
 assert.equal(receiptBinding(receipt([['c1','j1']]),{...seen(['c1',['beta','production']]),current:new Map([[A,'other']])}).code,'receipt-tool-call-ambiguous');
 assert.equal(receiptBinding(receipt([['c1','j1'],['c2','j2']]),seen(['c1',['beta']])).code,'receipt-tool-call-unconfirmed','one unconfirmed call is enough to refuse');
 assert.equal(receiptBinding(receipt([['c1','j1'],['c2','j2']]),seen(['c1',['beta']],['c2',['production']])).code,'receipt-channels-conflict');
 assert.equal(receiptBinding({kind:'invalid',code:'receipt-agents-conflict'},seen()).code,'receipt-agents-conflict');
 assert.equal(receiptBinding({kind:'none',code:'no-checkout-job'},seen()).kind,'unbound');
 const failed=receiptBinding(receipt([['c1','j1']]),{errors:['boom'],confirmed:new Map([[A+'\0c1',['beta']]])});
 assert.equal(failed.code,'native-observation-unavailable');assert.match(failed.detail,/boom/);
});

const ok=stdout=>({status:0,stdout,stderr:''});
const pair=(callId,agentId=A)=>({agentId,callId});

test('observation fails closed on bad deadline, role, channel, exit, timeout, malformed or foreign rows',()=>{
 const run=(over={},pairs=[pair('c1')])=>authenticateToolCalls(pairs,{deadline:Date.now()+5000,channels:()=>['beta'],user:()=>'fixture',execute:()=>ok('[]'),...over});
 assert.match(authenticateToolCalls([pair('c1')],{channels:()=>['beta']}).errors[0],/deadline/);
 assert.match(authenticateToolCalls([pair('c1')],{deadline:Date.now()-1,channels:()=>['beta'],user:()=>'f',execute:()=>ok('[]')}).errors[0],/exhausted/);
 assert.match(run({user:()=>'Bad User;'}).errors[0],/role/);
 assert.match(run({channels:()=>['Bad;Channel']}).errors[0],/invalid Kenan Stack channel/);
 assert.match(run({execute:()=>({status:2,stdout:'',stderr:'permission denied'})}).errors[0],/unavailable: beta: permission denied/);
 assert.match(run({execute:()=>({status:null,stdout:'',error:{code:'ETIMEDOUT'}})}).errors[0],/ETIMEDOUT/);
 assert.match(run({execute:()=>ok('not json')}).errors[0],/malformed/);
 assert.match(run({execute:()=>ok('{"a":1}')}).errors[0],/malformed/);
 assert.match(run({execute:()=>ok('[{"agentId":"'+B+'","callId":"c1"}]')}).errors[0],/unrequested pair/);
 assert.match(run({execute:()=>ok('[null]')}).errors[0],/unrequested pair/);
 assert.match(run({},[]).errors[0],/pairs required/);
 assert.match(run({},[{agentId:'label',callId:'c1'}]).errors[0],/bounded exact/);
 const second=run({channels:()=>['beta','production'],execute:(c,args)=>args.includes('kenan_production')?{status:1,stdout:'',stderr:'down'}:ok('[{"agentId":"'+A+'","callId":"c1"}]')});
 assert.equal(second.confirmed.size,0,'one failed channel discards the partial view');assert.match(second.errors[0],/production/);
});

test('observation collects each channel that confirms a pair, so duplicates surface as ambiguity',()=>{
 const rows='[{"agentId":"'+A+'","callId":"c1"}]';
 const seenArgs=[];
 const result=authenticateToolCalls([pair('c1')],{deadline:Date.now()+5000,channels:()=>['beta','production','beta'],user:()=>'fixture',execute:(c,args)=>{seenArgs.push(args[args.indexOf('--dbname')+1]);const sql=args[args.indexOf('--command')+1];return ok(sql.startsWith('SELECT coalesce(max(updated_at)')?(args.includes('kenan_production')?'20':'10'):rows);}});
 assert.deepEqual(result.errors,[]);
 assert.equal(result.current.get(A),'production','the channel with the owner\'s latest activity is current');
 assert.deepEqual(result.confirmed.get(A+'\0c1'),['beta','production']);
 assert.equal(receiptBinding(receipt([['c1','j']]),result).binding.channel,'production','a call present in both channels from before a move binds to the current one');
 assert.deepEqual(seenArgs.slice(0,2),['kenan_beta','kenan_production']);
});

test('the confirmation SQL is read-only and bounded, and refuses identity text that could escape a literal',()=>{
 const sql=toolCallAuthenticationSql([pair('c1')]);
 assert.throws(()=>toolCallAuthenticationSql([pair("c1'); DROP TABLE message; --")]),/bounded/);
 assert.match(sql,/^BEGIN READ ONLY;/);assert.match(sql,/ROLLBACK;\s*$/);assert.match(sql,/statement_timeout/);
 assert.throws(()=>toolCallAuthenticationSql([]),/bounded/);
 assert.throws(()=>toolCallAuthenticationSql(Array.from({length:513},(_,i)=>pair('c'+i))),/bounded/);
 assert.throws(()=>toolCallAuthenticationSql([{agentId:'label',callId:'c'}]),/bounded/);
});

test('actual PostgreSQL: only a tool call that exists in that agent\'s own conversation is confirmed',()=>{
 const root=tmp(),data=path.join(root,'data');
 const bin=process.env.WORKSPACE_TEST_PG_BIN||execFileSync('pg_config',['--bindir'],{encoding:'utf8',timeout:2000}).trim();
 const pg=(name,args)=>execFileSync(path.join(bin,name),args,{encoding:'utf8',timeout:10000,stdio:['ignore','pipe','pipe']});let started=false;
 try{
  pg('initdb',['-D',data,'--username=fixture','--no-locale','--auth=trust','--no-sync','--set=max_connections=10','--set=shared_buffers=8MB']);
  pg('pg_ctl',['-D',data,'-l',path.join(root,'postgres.log'),'-o',`-F -k ${root} -c listen_addresses='' -c max_connections=10 -c shared_buffers=8MB`,'-w','start']);started=true;
  const psql=(database,sql)=>pg('psql',['-X','-qAt','--host',root,'--username','fixture','--dbname',database,'--set=ON_ERROR_STOP=1','--command',sql]);
  psql('postgres','CREATE DATABASE kenan_beta');psql('postgres','CREATE DATABASE kenan_production');
  const schema=`CREATE TABLE agent(id text PRIMARY KEY,conversation_id text NOT NULL,owner_id text DEFAULT 'p',updated_at bigint DEFAULT 1);CREATE TABLE message(id serial PRIMARY KEY,conversation_id text NOT NULL,role text,parts jsonb NOT NULL);`;
  psql('kenan_beta',schema+`INSERT INTO agent VALUES('${A}','conv-a'),('${B}','conv-b');
   INSERT INTO message(conversation_id,role,parts) VALUES('conv-a','tool','[{"type":"text","text":"x"},{"type":"tool","callId":"c1"}]'),
   ('conv-a','assistant','[{"type":"tool","callId":"${COMPOSITE}"}]'),('conv-a','tool','[{"type":"tool","callId":"${COMPOSITE}"}]'),
   ('conv-b','tool','[{"type":"tool","callId":"c2"}]'),('conv-a','assistant','[{"type":"text","callId":"c3"}]'),('conv-a','tool','[{"type":"tool","callId":"dup"}]');`);
  // Historical scalar payloads must not poison an unrelated current call, or authenticate lookalikes.
  psql('kenan_beta',`INSERT INTO message(conversation_id,role,parts) VALUES
   ('conv-a','tool',to_jsonb('[{"type":"tool","callId":"scalar-forgery"}]'::text)),
   ('conv-a','notice','"[]"'),('conv-a','tool','null'),('conv-a','tool','42'),('conv-a','tool','{}');`);
  psql('kenan_production',schema+`INSERT INTO agent VALUES('${A}','conv-p');INSERT INTO message(conversation_id,role,parts) VALUES('conv-p','tool','[{"type":"tool","callId":"dup"}]');`);
  const execute=(command,args,options)=>{const rewritten=args.map((value,index)=>args[index-1]==='--host'?root:value);const r=spawnSync(path.join(bin,command),rewritten,{...options});return {status:r.status,stdout:r.stdout,stderr:r.stderr,error:r.error};};
  const result=authenticateToolCalls([pair('c1'),pair('c2'),pair('c3'),pair('dup'),pair('absent'),pair('scalar-forgery'),pair(COMPOSITE),pair(COMPOSITE,B),pair(COMPOSITE.split('|')[0])],{deadline:Date.now()+20000,channels:()=>['beta','production'],execute,user:()=>'fixture'});
  assert.deepEqual(result.errors,[]);
  assert.deepEqual(result.confirmed.get(A+'\0c1'),['beta']);
  assert.deepEqual(result.confirmed.get(A+'\0'+COMPOSITE),['beta']);
  assert.equal(result.confirmed.has(B+'\0'+COMPOSITE),false,'the full native id in another conversation is not owned by B');
  assert.equal(result.confirmed.has(A+'\0'+COMPOSITE.split('|')[0]),false,'a composite id is never truncated');
  assert.equal(result.confirmed.has(A+'\0c2'),false,'agent B owns c2, not agent A');
  assert.equal(result.confirmed.has(A+'\0c3'),false,'a text part is not a tool call');
  assert.equal(result.confirmed.has(A+'\0absent'),false);
  assert.equal(result.confirmed.has(A+'\0scalar-forgery'),false,'serialized tool-like text is never identity evidence');
  assert.equal(receiptBinding(receipt([['c1','j']]),result).kind,'bindable');
  assert.equal(receiptBinding(receipt([['dup','j']]),result).code,'receipt-tool-call-ambiguous','the same pair on two channels is refused');
  assert.equal(receiptBinding(receipt([['c2','j']]),result).code,'receipt-tool-call-unconfirmed');
  assert.match(authenticateToolCalls([pair('c1')],{deadline:Date.now()+20000,channels:()=>['missing'],execute,user:()=>'fixture'}).errors[0],/unavailable: missing/);
  assert.throws(()=>psql('kenan_beta',toolCallAuthenticationSql([pair('c1')]).replace('SELECT','DELETE FROM message; SELECT')),/read-only|READ ONLY/i);
 }finally{if(started)try{pg('pg_ctl',['-D',data,'-m','immediate','stop']);}catch{}fs.rmSync(root,{recursive:true,force:true});}
});

test('receipt migration refuses oversized pair sets and expired traversal deadlines',()=>{
 const spec=Object.fromEntries(Array.from({length:513},(_,i)=>['job-'+i,good(A,'call_'+i)]));
 const state=jobs(spec);
 try{
  assert.equal(admissionReceipts(state,WS,REQUEST).code,'receipt-pair-limit');
  assert.equal(admissionReceipts(state,WS,REQUEST,{deadline:Date.now()-1}).code,'receipt-deadline');
 }finally{fs.rmSync(path.dirname(state),{recursive:true,force:true});}
});

test('exact authentication uses the tool-call GIN expression before inspecting complete message parts',()=>{
 const sql=toolCallAuthenticationSql([{agentId:A,callId:'exact-call'}]);
 assert.match(sql,/jsonb_path_query_array\(m.parts, '\$\[\*\].callId'\) @> jsonb_build_array\(v.call_id\)/);
 assert.match(sql,/m.role='tool'/);assert.match(sql,/m.conversation_id=v.conversation_id/);
 assert.doesNotMatch(sql,/jsonb_array_elements|OFFSET 0|calls AS MATERIALIZED/);
});
test('an exact statement timeout is retried once and the retry stays in the original channel',()=>{
 let calls=0;const pairs=[{agentId:A,callId:'exact-call'}];
 const io={deadline:Date.now()+30000,channels:()=>['beta'],user:()=> 'kenan',execute:(name,args)=>{
  assert.equal(args[args.indexOf('--dbname')+1],'kenan_beta');
  return ++calls===1?{status:1,stderr:'ERROR: canceling statement due to statement timeout'}:{status:0,stdout:JSON.stringify(pairs)};
 }};
 const found=authenticateToolCalls(pairs,io);assert.equal(calls,2);assert.deepEqual(found.errors,[]);assert.deepEqual(found.confirmed.get(A+'\0exact-call'),['beta']);
});
test('persistent timeout remains unknown after one bounded retry',()=>{
 let calls=0;const found=authenticateToolCalls([{agentId:A,callId:'exact-call'}],{deadline:Date.now()+30000,channels:()=>['beta'],user:()=> 'kenan',execute:()=>{calls++;return {status:1,stderr:'statement timeout'};}});
 assert.equal(calls,2);assert.equal(found.errors.length,1);assert.equal(found.confirmed.size,0);
});

test('admission defaults to the authenticated worker and refuses foreign native and goal UUIDs',()=>{
 const caller={agentId:A,channel:'beta',callId:'c1'};
 assert.equal(admissionOwner(undefined,caller),A);
 assert.equal(admissionOwner(A,caller),A);
 assert.equal(admissionOwner('task-name',caller),'task-name');
 assert.throws(()=>admissionOwner(B,caller),{code:'workspace-owner-mismatch'});
 assert.throws(()=>admissionOwner('manager:converge',caller),{code:'workspace-owner-mismatch'});
 assert.equal(admissionOwner(B,{...caller,agentId:'manager:converge'}),B);
 assert.equal(admissionOwner(B,null),B,'non-native operators retain their explicit route');
});

test('a legacy goal label requires the exact goal relationship, no native owner and a successful read',()=>{
 const binding={agentId:A,channel:'beta',callId:'c1'};
 const probe=result=>isBoundGoalLabel(B,binding,{user:()=> 'kenan',execute:(_cmd,args)=>{
  const sql=args.at(-1);assert.match(sql,/a.goal_id::text=/);assert.match(sql,/NOT EXISTS/);
  assert.ok(sql.includes(A)&&sql.includes(B));return result;
 }});
 assert.equal(probe({status:0,stdout:'t\n'}),true);
 for(const result of [{status:0,stdout:'f\n'},{status:1,stdout:'t'},{status:0,stdout:'t',error:new Error('timeout')}])assert.equal(probe(result),false);
});

test('canonical liveness repairs only a proven legacy goal label, never an actual foreign agent',()=>{
 const d=db();bindNativeOwner(d,WS,{agentId:A,channel:'beta',callId:'c1'},'caller-scope');
 assert.equal(canonicalNativeOwner(d,{id:WS,owner:B},{goalLabel:()=>true}),A);
 assert.equal(canonicalNativeOwner(d,{id:WS,owner:B},{goalLabel:()=>false}),B);
});
