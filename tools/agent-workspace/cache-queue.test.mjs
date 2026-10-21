import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
const {queueReferenceSql,currentStackQueueReferences,callerToolCall,kenanChannels,channelDatabase}=await import(process.env.WORKSPACE_QUEUE_MODULE||'./cache-queue.mjs');
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
  const self=['release','--path',source];
  const physical=observe('physical-checkout',self),sourceScope=observe('source',self),anonymous=observe('physical-checkout',null);
  assert.equal(physical.self,1);assert.equal(anonymous.self,0);
  const keys=rows=>rows.references.map(r=>r.kind+':'+r.id).sort();
  assert.deepEqual(keys(physical),['tool_call:'+ids['manager-running'],'tool_call:'+ids['running-bash'],'tool_call:'+ids['running-read']].sort());
  assert.deepEqual(keys(anonymous),[...keys(physical),'tool_call:'+ids.caller].sort());
  assert.deepEqual(keys(sourceScope),[...keys(physical),'agent:idle','agent:live'].sort());
  assert.equal(physical.references.find(r=>r.id===ids['running-read']).targetPath,source+'/README.md');
  assert.equal(physical.references.find(r=>r.id===ids['running-read']).resourceClass,'reserved-tool-call');
  assert.equal(sourceScope.references.find(r=>r.id==='live').resourceClass,'source-intent');
  // A different invocation that merely mentions agent-workspace is not the caller.
  assert.equal(observe('physical-checkout',['heartbeat','--path',source]).self,0);
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
 const channels=()=>['beta','production'],caller=()=>({channel:'production',args:['release','--path','/source']}),user=()=>'kenan';
 const seen=[];
 const ok=currentStackQueueReferences(['/source'],{resourceKind:'physical-checkout',deadline:Date.now()+10000,channels,caller,user,execute:(name,args)=>{
  assert.equal(name,'psql');assert.deepEqual(args.slice(args.indexOf('--host'),args.indexOf('--host')+6),['--host','/run/kenan/pg','--username','kenan','--dbname',args[args.indexOf('--dbname')+1]]);
  const db=args[args.indexOf('--dbname')+1];seen.push(db);const sql=args.at(-1);assert.match(sql,/statement_timeout='4000ms'/);assert.match(sql,/BEGIN READ ONLY/);
  assert.equal(/strpos\(p->'args'->>'command','release'\)/.test(sql),db==='kenan_production');
  return {status:0,stdout:JSON.stringify({self:db==='kenan_production'?1:0,references:db==='kenan_beta'?[{kind:'tool_call',id:'running',state:'running',resourceClass:'reserved-tool-call'}]:[]})};}});
 assert.deepEqual(ok.errors,[]);assert.deepEqual(seen,['kenan_beta','kenan_production']);assert.equal(ok.references[0].channel,'beta');assert.equal(ok.observations[1].callerToolCalls,1);
 assert.equal(currentStackQueueReferences(['/source'],{resourceKind:'source',deadline:Date.now()+10000,channels,caller,user,execute:()=>({status:2,stdout:'',stderr:'FATAL: role "kenan" does not exist'})}).errors.length,1);
 assert.equal(currentStackQueueReferences(['/source'],{resourceKind:'source',deadline:Date.now()+10000,channels,caller,user,execute:()=>({status:0,stdout:'[]'})}).errors.length,1);
 assert.equal(currentStackQueueReferences(['/source'],{resourceKind:'source',deadline:Date.now()+10000,channels:()=>{throw new Error('no channels');},caller,user,execute:()=>assert.fail('no query without inventory')}).errors[0],'no channels');
 let calls=0;const late=currentStackQueueReferences(['/source'],{resourceKind:'physical-checkout',deadline:Date.now()+40,channels,caller,user,execute:(_name,_args,options)=>{calls++;assert.ok(options.timeout<=40);Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,60);return {status:0,stdout:'{"self":0,"references":[]}'};}});
 assert.equal(calls,1);assert.equal(late.errors.length,1);assert.equal(late.references.length,0);
});

test('caller identity requires a Kenan Stack server ancestor and survives bash exec of the final command',()=>{
 const tree={10:{argv:['node','/usr/local/bin/agent-workspace','release'],parent:9},9:{argv:['/usr/local/bin/node','/srv/kenan/beta/dist/server/main.js','/etc/kenan/beta.json'],parent:1},
  20:{argv:['node','agent-workspace'],parent:19},19:{argv:['/bin/bash','-c','x && agent-workspace release'],parent:9},30:{argv:['node'],parent:29},29:{argv:['systemd','--user'],parent:1}};
 const io={argv:pid=>tree[pid].argv,parent:pid=>tree[pid].parent};
 assert.deepEqual(callerToolCall({...io,pid:10,args:['release','--path','/x']}),{channel:'beta',args:['release','--path','/x']});
 assert.deepEqual(callerToolCall({...io,pid:20,args:['release']}),{channel:'beta',args:['release']});
 assert.equal(callerToolCall({...io,pid:30,args:['reconcile']}),null);
 assert.equal(callerToolCall({...io,pid:10,args:[]}),null);
});
