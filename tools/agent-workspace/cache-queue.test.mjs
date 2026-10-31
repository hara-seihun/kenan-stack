import './scratch-env.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
const {queueReferenceSql,currentStackQueueReferences,callerToolCall,procScope,kenanChannels,channelDatabase}=await import(process.env.WORKSPACE_QUEUE_MODULE||'./cache-queue.mjs');
const literal=x=>"'"+x.replaceAll("'","''")+"'";
const json=x=>literal(JSON.stringify(x))+'::jsonb';

// Mirrors the Kenan Stack columns the observer reads (server/db/schema.sql in the rewrite).
const schema=`CREATE TABLE agent(id text PRIMARY KEY,role text NOT NULL,conversation_id uuid NOT NULL,state text NOT NULL,archived boolean NOT NULL DEFAULT false);
CREATE TABLE message(id uuid PRIMARY KEY,conversation_id uuid NOT NULL,role text NOT NULL,text text NOT NULL DEFAULT '',parts jsonb NOT NULL DEFAULT '[]',state text NOT NULL DEFAULT 'done');`;

test('actual PostgreSQL observer separates running tool calls, live worker intent, the caller and finished history',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'workspace-queue-pg-')),data=path.join(root,'data');
 const bin=process.env.WORKSPACE_TEST_PG_BIN||execFileSync('pg_config',['--bindir'],{encoding:'utf8',timeout:2000}).trim();
 const pg=(name,args)=>execFileSync(path.join(bin,name),args,{encoding:'utf8',timeout:5000,stdio:['ignore','pipe','pipe']});let started=false;
 try{
  pg('initdb',['-D',data,'--username=fixture','--no-locale','--auth=trust','--no-sync','--set=max_connections=10','--set=shared_buffers=8MB']);
  pg('pg_ctl',['-D',data,'-l',path.join(root,'postgres.log'),'-o',`-F -k ${root} -c listen_addresses='' -c max_connections=10 -c shared_buffers=8MB`,'-w','start']);started=true;
  const source="/fixture/source/it's";
  let n=0;const uuid=()=>`00000000-0000-4000-8000-${String(++n).padStart(12,'0')}`;
  let sql=schema;
  const conversation={};
  for(const [id,role,state,archived] of [['caller','worker','running',false],['live','worker','running',false],['idle','worker','idle',false],['stopped','worker','stopped',false],['archived','worker','running',true],['manager','manager','running',false]]){
   conversation[id]=uuid();sql+=`INSERT INTO agent VALUES(${literal(id)},${literal(role)},${literal(conversation[id])},${literal(state)},${archived});\n`;
  }
  const tool=(name,args,result=null)=>[{type:'tool',callId:'call-'+n,name,args,result,isError:false}];
  const message=(key,owner,role,state,parts,text='')=>{sql+=`INSERT INTO message VALUES(${literal(key)},${literal(conversation[owner])},${literal(role)},${literal(text)},${json(parts)},${literal(state)});\n`;};
  const ids={};for(const name of ['caller','running-bash','running-read','running-unrelated','finished-bash','failed-bash','assistant-call','manager-running','prefix-sibling','live-text','idle-parts','stopped-text','archived-text','manager-text','caller-history'])ids[name]=uuid();
  message(ids.caller,'caller','tool','streaming',tool('bash',{command:`cd /tmp && agent-workspace release --path '${source}'`}));
  message(ids['caller-history'],'caller','human','done',[],`please work in ${source}`);
  message(ids['running-bash'],'stopped','tool','streaming',tool('bash',{command:`make -C '${source}' test`}));
  message(ids['running-read'],'archived','tool','streaming',tool('read',{path:source+'/README.md'}));
  message(ids['running-unrelated'],'live','tool','streaming',tool('bash',{command:'ls /elsewhere'}));
  message(ids['finished-bash'],'live','tool','done',tool('bash',{command:`ls ${source}`},'"ok"'));
  message(ids['failed-bash'],'archived','tool','error',tool('bash',{command:`ls ${source}`},'"failed"'));
  message(ids['assistant-call'],'archived','assistant','done',tool('bash',{command:`ls ${source}`}));
  message(ids['manager-running'],'manager','tool','streaming',tool('edit',{path:source+'/file'}));
  message(ids['live-text'],'live','assistant','done',[],`edited ${source}/file`);
  message(ids['idle-parts'],'idle','tool','done',tool('read',{path:source+'/x'},'"x"'));
  message(ids['stopped-text'],'stopped','assistant','done',[],source);
  message(ids['archived-text'],'archived','assistant','done',[],source);
  message(ids['manager-text'],'manager','assistant','done',[],source);
  const query=sql=>pg('psql',['-X','-qAt','--host',root,'--username','fixture','--dbname','postgres','--set=ON_ERROR_STOP=1','--command',sql]);
  query(sql);
  const observe=(kind,self)=>JSON.parse(query(queueReferenceSql(source,self,kind)));
  const self={callId:'call-19',agentId:'caller'};
  // The actual SDK call ID is independent of the expanded command.
  query(`UPDATE message SET parts=jsonb_set(parts,'{0,callId}','\"computed-call\"') WHERE id=${literal(ids.caller)};`);
  self.callId='computed-call';
  const physical=observe('physical-checkout',self),sourceScope=observe('source',self),anonymous=observe('physical-checkout',null);
  assert.equal(physical.self,1);assert.equal(anonymous.self,0);
  const keys=rows=>rows.references.map(r=>r.kind+':'+r.id).sort();
  assert.deepEqual(keys(physical),['tool_call:'+ids['manager-running'],'tool_call:'+ids['running-bash'],'tool_call:'+ids['running-read']].sort());
  assert.deepEqual(keys(anonymous),[...keys(physical),'tool_call:'+ids.caller].sort());
  assert.deepEqual(keys(sourceScope),[...keys(physical),'agent:idle','agent:live'].sort());
  assert.equal(physical.references.find(r=>r.id===ids['running-read']).targetPath,source+'/README.md');
  assert.equal(physical.references.find(r=>r.id===ids['running-read']).resourceClass,'reserved-tool-call');
  const batch=JSON.parse(query(queueReferenceSql([source,'/fixture/unrelated'],self,'physical-checkout')));
  assert.deepEqual(batch.references.find(r=>r.id===ids['running-read']).matchedRoots,[source], 'a batch preserves exact tool-to-root matching instead of keeping every inactive root live');
  assert.equal(sourceScope.references.find(r=>r.id==='live').resourceClass,'source-intent');
  // A different invocation that merely mentions agent-workspace is not the caller.
  assert.equal(observe('physical-checkout',{...self,agentId:'live'}).self,0);
  assert.equal(observe('physical-checkout',{...self,callId:'wrong-call'}).self,0);
  const forms=[
   ['sibling dash',{command:`cd "${source}-followup" && make`},false],
   ['sibling dot',{path:source+'.backup'},false],
   ['sibling underscore',{path:source+'_copy'},false],
   ['exact directory',{path:source},true],
   ['descendant',{path:source+'/child/file'},true],
   ['quoted command',{command:`cd "${source}" && make`},true],
   ['trailing slash',{command:`ls "${source}/"`},true],
   ['argument assignment',{command:`tool --path="${source}"`},true],
   ['shell terminator',{command:`ls ${source}; next`},true]
  ];
  for(const [label,args,protect] of forms){
   const id=uuid();query(`INSERT INTO message VALUES(${literal(id)},${literal(conversation.archived)},'tool','',${json(tool('bash',args))},'streaming');`);
   const refs=observe('physical-checkout',self).references;
   assert.equal(refs.some(r=>r.id===id),protect,label);
   if(protect)assert.deepEqual(refs.find(r=>r.id===id).matchedRoots,[source],label);
   assert.equal(JSON.parse(query(queueReferenceSql(source+'-followup',self,'physical-checkout'))).references.some(r=>r.id===id),label==='sibling dash','the actual sibling stays protected');
   query(`DELETE FROM message WHERE id=${literal(id)};`);
  }
  const escaped="/fixture/a[0].b+(copy)\\quote\"";
  for(const value of [escaped,escaped+'/leaf']){
   const id=uuid();query(`INSERT INTO message VALUES(${literal(id)},${literal(conversation.archived)},'tool','',${json(tool('read',{path:value}))},'streaming');`);
   assert.ok(JSON.parse(query(queueReferenceSql(escaped,self,'physical-checkout'))).references.some(r=>r.id===id));
   assert.equal(JSON.parse(query(queueReferenceSql('/fixture/a0Xbcopy',self,'physical-checkout'))).references.some(r=>r.id===id),false,'regex metacharacters remain literal');
   query(`DELETE FROM message WHERE id=${literal(id)};`);
  }
  const sibling=uuid();query(`INSERT INTO message SELECT ${literal(sibling)},conversation_id,role,text,jsonb_set(parts,'{0,callId}','\"other-call\"'),state FROM message WHERE id=${literal(ids.caller)};`);
  assert.ok(observe('physical-checkout',self).references.some(r=>r.id===sibling));
  query(`DELETE FROM message WHERE id=${literal(sibling)};`);
  query(`INSERT INTO message SELECT ${literal(uuid())},conversation_id,role,text,parts,state FROM message WHERE id=${literal(ids.caller)};`);
  assert.equal(observe('physical-checkout',self).self,0); // ambiguous duplicate stays protected
  assert.equal(observe('physical-checkout',null).references.length,observe('generated-cache',null).references.length);
 }finally{if(started)pg('pg_ctl',['-D',data,'-m','immediate','-w','stop']);fs.rmSync(root,{recursive:true,force:true});}
});

test('every installed channel is observed against one absolute deadline and failures are unknown safety, never empty',()=>{
 const stack=fs.mkdtempSync(path.join(os.tmpdir(),'workspace-channels-'));
 try{
  for(const name of ['beta','production','no-release'])fs.mkdirSync(path.join(stack,name));
  for(const name of ['beta','production'])fs.writeFileSync(path.join(stack,name,'source-commit'),'a'.repeat(40)+'\n');
  assert.deepEqual(kenanChannels(stack),['beta','production']);assert.equal(channelDatabase('qa-two'),'kenan_qa_two');
  fs.rmSync(path.join(stack,'beta'),{recursive:true});fs.rmSync(path.join(stack,'production'),{recursive:true});
  assert.throws(()=>kenanChannels(stack),/channel inventory missing/);
 }finally{fs.rmSync(stack,{recursive:true,force:true});}
 const channels=()=>['beta','production'],caller=()=>({channel:'production',callId:'exact-call',agentId:'caller'}),user=()=>'kenan';
 const seen=[];
 const ok=currentStackQueueReferences(['/source'],{resourceKind:'physical-checkout',deadline:Date.now()+10000,channels,caller,user,execute:(name,args)=>{
  assert.equal(name,'psql');assert.deepEqual(args.slice(args.indexOf('--host'),args.indexOf('--host')+6),['--host','/run/kenan/pg','--username','kenan','--dbname',args[args.indexOf('--dbname')+1]]);
  const db=args[args.indexOf('--dbname')+1];seen.push(db);const sql=args.at(-1);assert.match(sql,/statement_timeout='[0-9]+ms'/);assert.match(sql,/BEGIN READ ONLY/);
  assert.equal(sql.includes("p->>'callId'='exact-call'"),db==='kenan_production');
  return {status:0,stdout:JSON.stringify({self:db==='kenan_production'?1:0,references:db==='kenan_beta'?[{kind:'tool_call',id:'running',state:'running',resourceClass:'reserved-tool-call'}]:[]})};}});
 assert.deepEqual(ok.errors,[]);assert.deepEqual(seen,['kenan_beta','kenan_production']);assert.equal(ok.references[0].channel,'beta');assert.equal(ok.observations[1].callerToolCalls,1);assert.equal(ok.observations[0].callerIdentity.code,'CALLER_CHANNEL_DIFFERENT');
 assert.equal(currentStackQueueReferences(['/source'],{resourceKind:'source',deadline:Date.now()+10000,channels,caller,user,execute:()=>({status:2,stdout:'',stderr:'FATAL: role "kenan" does not exist'})}).errors.length,1);
 assert.equal(currentStackQueueReferences(['/source'],{resourceKind:'source',deadline:Date.now()+10000,channels,caller,user,execute:()=>({status:0,stdout:'[]'})}).errors.length,1);
 assert.equal(currentStackQueueReferences(['/source'],{resourceKind:'source',deadline:Date.now()+10000,channels:()=>{throw new Error('no channels');},caller,user,execute:()=>assert.fail('no query without inventory')}).errors[0],'no channels');
 let calls=0;const late=currentStackQueueReferences(['/source'],{resourceKind:'physical-checkout',deadline:Date.now()+40,channels,caller,user,execute:(_name,_args,options)=>{calls++;assert.ok(options.timeout<=40);Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,60);return {status:0,stdout:'{"self":0,"references":[]}'};}});
 assert.equal(calls,1);assert.equal(late.errors.length,1);assert.equal(late.references.length,0);
});

test('caller identity uses root system-scope metadata, rejecting editable env, foreign channels and missing scopes',()=>{
 const tree={10:{argv:['node','agent-workspace'],parent:19},19:{argv:['flock','--shared','/run/lock/agent-workspace-admission.lock','sh','-c','exec agent-workspace release'],parent:18},18:{argv:['bash','-c','agent-workspace release'],parent:9},9:{argv:['node','/srv/kenan/beta/dist/server/main.js'],parent:1},30:{argv:['node'],parent:1}};
 const actual={version:1,channel:'beta',callId:'native-call',agentId:'caller',unit:'agent-tool-beta-00000000-0000-4000-8000-000000000000.scope'};
 const io={uid:()=>0,argv:pid=>tree[pid].argv,parent:pid=>tree[pid].parent,scope:()=>actual};
 assert.deepEqual(callerToolCall({...io,pid:10}),{channel:'beta',callId:'native-call',agentId:'caller'});
 assert.deepEqual(callerToolCall({...io,pid:10,parent:pid=>pid===10?9:io.parent(pid)}),{channel:'beta',callId:'native-call',agentId:'caller'});
 assert.equal(callerToolCall({...io,pid:30}),null);
 assert.equal(callerToolCall({...io,pid:10,uid:()=>1002}),null);
 assert.equal(callerToolCall({...io,pid:10,scope:()=>null}),null);
 assert.equal(callerToolCall({...io,pid:10,scope:()=>({...actual,channel:'production'})}),null);
 assert.equal(callerToolCall({...io,pid:10,scope:()=>({...actual,callId:'x\n'})}),null);
 assert.throws(()=>queueReferenceSql('/source',['literal-argv'],'physical-checkout'),/caller tool identity/);
});

test('system-scope parser requires exact active transient root-unit ControlGroup, never a lookalike or sibling',()=>{
 const group='/system.slice/agent-tool-beta-00000000-0000-4000-8000-000000000000.scope';
 const props={Description:'kenan-tool-call:'+JSON.stringify({version:1,channel:'beta',callId:'actual',agentId:'owner'}),ControlGroup:group,Transient:'yes',ActiveState:'active'};
 const observe=patch=>procScope(100,{read:()=>`0::${group}\n`,query:unit=>({status:0,stdout:Object.entries({...props,...patch}).map(([k,v])=>`${k}=${v}`).join('\n')})});
 assert.equal(observe({}).callId,'actual');
 for(const patch of [{ControlGroup:group+'/sibling'},{Transient:'no'},{ActiveState:'inactive'},{Description:'editable-env'}]) assert.equal(observe(patch),null);
 assert.equal(procScope(100,{read:()=>`0::/user.slice/lookalike.scope\n`,query:()=>{throw Error('must not query')}}),null);
});

test('retained queue verdict records the authenticated caller separately from a foreign streaming tool',async()=>{
 const {workspaceTesting}=await import('./workspace.mjs');
 const observation={channel:'beta',callerToolCalls:1,callerIdentity:{state:'authenticated-system-scope',agentId:'caller',callId:'own-call'}};
 const foreign={kind:'tool_call',id:'foreign-running-call',channel:'beta'};
 const result=workspaceTesting.stackQueueInspection({errors:[],references:[foreign],observations:[observation]});
 assert.deepEqual(result.currentStackReferences,[foreign]);assert.deepEqual(result.currentStackQueueObservations,[observation]);
});

test('a source view that times out under load falls back to live tool calls plus recent cached worker intent',()=>{
 // 2026-10-31: the source view read ~190 MB of live workers' messages and passed its fixed 4 s
 // statement timeout on a loaded host, so every reconcile kept every checkout blocked.
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'queue-intent-'));
 try{
  const workerIntentCache=path.join(dir,'intent.json'),channels=()=>['beta'],caller=()=>null,user=()=>'kenan';
  const worker={kind:'agent',id:'w1',state:'running',resourceClass:'source-intent'},tool={kind:'tool_call',id:'t1',state:'running',resourceClass:'reserved-tool-call'};
  let t=1_000_000;const now=()=>t;
  const timeouts=[];
  const first=currentStackQueueReferences(['/source'],{resourceKind:'source',deadline:Date.now()+30000,channels,caller,user,workerIntentCache,now,execute:(_n,args,options)=>{
   timeouts.push(Number(args.at(-1).match(/statement_timeout='(\d+)ms'/)[1]));assert.ok(options.timeout<=16500);
   return {status:0,stdout:JSON.stringify({self:0,references:[worker]})};}});
  assert.deepEqual(first.errors,[]);assert.equal(first.observations[0].workerIntent,'live');
  assert.ok(timeouts[0]>4000&&timeouts[0]<=15000,String(timeouts[0]));
  const loaded=(args)=>args.at(-1).includes("WHERE TRUE AND a.role='worker'")
   ?{status:3,stdout:'',stderr:'psql:<stdin>:1: ERROR:  canceling statement due to statement timeout'}
   :{status:0,stdout:JSON.stringify({self:0,references:[tool]})};
  t+=10*60*1000;
  const fallback=currentStackQueueReferences(['/source'],{resourceKind:'source',deadline:Date.now()+30000,channels,caller,user,workerIntentCache,now,execute:(_n,args)=>loaded(args)});
  assert.deepEqual(fallback.errors,[]);
  assert.deepEqual(fallback.references.map(r=>r.id).sort(),['t1','w1']);
  assert.equal(fallback.observations[0].workerIntent.kind,'cached');
  t+=6*60*1000;
  const stale=currentStackQueueReferences(['/source'],{resourceKind:'source',deadline:Date.now()+30000,channels,caller,user,workerIntentCache,now,execute:(_n,args)=>loaded(args)});
  assert.equal(stale.errors.length,1);assert.match(stale.errors[0],/statement timeout.*no worker observation/);
  const other=currentStackQueueReferences(['/elsewhere'],{resourceKind:'source',deadline:Date.now()+30000,channels,caller,user,workerIntentCache,now:()=>1_000_000,execute:(_n,args)=>loaded(args)});
  assert.equal(other.errors.length,1,'another path has no cached worker intent');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
