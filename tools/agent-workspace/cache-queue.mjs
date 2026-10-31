import fs from 'node:fs';
import path from 'node:path';
import {userInfo} from 'node:os';
import {boundedCommand} from './bounded-command.mjs';
import {queryNativeScope} from './native-scope-query.mjs';
import {rootScope} from './root-scope.mjs';

// Kenan Stack (the October 17 minimal rewrite) keeps one PostgreSQL database per installed channel
// (`/srv/kenan/CHANNEL`, database `kenan_CHANNEL`) on the `kenan-postgres` cluster's socket directory.
// A running tool call is a `message` row with role='tool' and state='streaming'; a live worker is a
// non-archived, non-stopped `agent` row with role='worker'.
export const KENAN_STACK_ROOT='/srv/kenan';
export const KENAN_PG_SOCKET_DIR='/run/kenan/pg';
const CHANNEL=/^[a-z][a-z0-9-]{0,23}$/;
const SERVER=/^\/srv\/kenan\/([a-z][a-z0-9-]{0,23})\/dist\/server\/main\.js$/;
// Node takes its options before the script (the units pass e.g. --max-old-space-size=12288), so the script is the first non-option argument.
export const serverChannel=args=>args.slice(1).find(arg=>!arg.startsWith('-'))?.match(SERVER)?.[1]??null;
const literal=value=>"'"+value.replaceAll("'","''")+"'";

export function kenanChannels(stackRoot=KENAN_STACK_ROOT) {
 const channels=fs.readdirSync(stackRoot,{withFileTypes:true})
  .filter(entry=>entry.isDirectory()&&CHANNEL.test(entry.name)&&fs.existsSync(path.join(stackRoot,entry.name,'source-commit')))
  .map(entry=>entry.name).sort();
 if(!channels.length||channels.length>16)throw new Error('bounded Kenan Stack channel inventory missing under '+stackRoot);
 return channels;
}
export const channelDatabase=channel=>'kenan_'+channel.replaceAll('-','_');

function procArgv(pid){return fs.readFileSync(`/proc/${pid}/cmdline`,'utf8').split('\0').slice(0,-1);}
function procParent(pid){const stat=fs.readFileSync(`/proc/${pid}/stat`,'utf8');return Number(stat.slice(stat.lastIndexOf(')')+2).split(' ')[1]);}
// Identity lives in a root-created system-manager scope, never in shell argv/env.
// The observed cgroup and unit ControlGroup must agree with the actual caller.
export function procScope(pid,{read=p=>fs.readFileSync(`/proc/${p}/cgroup`,'utf8'),onError=()=>{},query=queryNativeScope,kernel=rootScope}={}){
 const rows=read(pid).trim().split('\n');
 const group=rows.find(r=>r.startsWith('0::'))?.slice(3),unit=group?.split('/').at(-1);
 const nativeScope=/^agent-tool-[a-z][a-z0-9-]*-[a-f0-9-]{36}\.scope$/.test(unit??'');
 const nativeBackground=/^kenan-bg-[a-f0-9-]{36}-[-A-Za-z0-9._]{1,60}\.service$/.test(unit??'')&&group?.startsWith('/user.slice/user-agents.slice/');
 const fail=(code,detail)=>{onError({code,detail});return null;};
 if(!group||!nativeScope&&!nativeBackground)return fail('caller-scope-missing','The process is not in a recognized native tool scope.');
 const observed=kernel(pid,group,unit);
 if(observed.kind==='authenticated-kernel-scope')return {...observed.identity,unit,group};
 if(observed.kind==='refused')return fail('caller-kernel-scope-refused',observed.code);
 const r=query(unit);
 if(r.status!==0||r.error)return fail('caller-scope-query-failed',`The system-manager scope query failed (${r.error?.code??r.signal??r.status}).`);
 const props=Object.fromEntries(r.stdout.trim().split('\n').map(line=>{const at=line.indexOf('=');return [line.slice(0,at),line.slice(at+1)];}));
 if(props.ControlGroup!==group)return fail('caller-scope-cgroup-mismatch','The unit ControlGroup does not match the actual process.');
 if(props.Transient!=='yes'||props.ActiveState!=='active')return fail('caller-scope-not-active','The unit is not an active transient system-manager scope.');
 if(!props.Description?.startsWith('kenan-tool-call:'))return fail('caller-scope-identity-missing','The root-created scope has no native call description.');
 const v=JSON.parse(props.Description.slice('kenan-tool-call:'.length));
 if(nativeBackground&&(v.background!==true||!unit.startsWith(`kenan-bg-${v.agentId}-`)||String(v.uid)!==props.User||!/^[a-f0-9]{32}$/.test(props.InvocationID??'')))return fail('caller-background-mismatch','The background unit identity does not match its actual invocation.');
 return {...v,unit,group};
}
function identity(v){return v&&typeof v==='object'&&typeof v.callId==='string'&&v.callId.length>0&&v.callId.length<=256&&!/[\x00-\x1f]/.test(v.callId)&&typeof v.agentId==='string'&&/^[a-zA-Z0-9:_-]{1,128}$/.test(v.agentId);}
export function callerToolCall({pid=process.pid,argv=procArgv,parent=procParent,scope=procScope,uid=p=>fs.statSync(`/proc/${p}`).uid,background=true,onError=()=>{}}={}) {
 const fail=(code,detail)=>{onError({code,detail});return null;};
 try{
  const observed=scope(pid,{onError});
  if(observed===null)return null;
  if(!identity(observed)||observed.version!==1||!CHANNEL.test(observed.channel))return fail('caller-scope-identity-invalid','The scope description has an invalid native identity.');
  if(background&&observed.background===true&&observed.unit.startsWith(`kenan-bg-${observed.agentId}-`)&&uid(pid)===observed.uid)return {channel:observed.channel,callId:observed.callId,agentId:observed.agentId};
  if(!observed.unit.startsWith(`agent-tool-${observed.channel}-`))return fail('caller-scope-channel-mismatch','The scope unit does not match its declared channel.');
  for(let current=pid,depth=0;current>1&&depth<64;depth++){
   const up=parent(current);if(!(up>1))return fail('caller-server-ancestor-missing','No root-owned native server remains in the caller ancestry.');
   const server=serverChannel(argv(up));
   if(server!==null&&uid(up)===0)return server===observed.channel?{channel:server,callId:observed.callId,agentId:observed.agentId}:fail('caller-server-channel-mismatch','The root-owned server belongs to another channel.');
   current=up;
  }
 }catch(error){return fail('caller-observation-failed',`Native caller inspection failed (${error.code??error.name}).`);}
 return fail('caller-ancestry-limit','The caller ancestry exceeded 64 processes.');
}

// statementTimeoutMs: the read-only view may run as long as its caller's deadline allows (it read
// ~190 MB of live workers' messages and took 1.2 s idle, over 4 s on a loaded host: 2026-10-31).
// workers=false observes only running tool calls (cheap, index-backed) for the cached fallback.
export function queueReferenceSql(root,selfArgs,resourceKind,{statementTimeoutMs=4000,workers=true}={}){
 if(!Number.isSafeInteger(statementTimeoutMs)||statementTimeoutMs<100)throw new Error('statement timeout must be at least 100 ms');
 if(!['source','physical-checkout','generated-cache'].includes(resourceKind))throw new Error('explicit source or generated-cache resource kind required');
 const roots=Array.isArray(root)?root:[root];
 if(selfArgs!==null&&!identity(selfArgs))throw new Error('invalid caller tool identity');
 const referencePattern=root=>root.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'($|[/[:space:]\"\'`;|&(){}\\[\\],<>])';
 const jsonRootMatch=(body,root)=>`jsonb_path_exists(${body},${literal('strict $.** ? (@.type() == "string" && @ like_regex '+JSON.stringify(referencePattern(root))+')')}::jsonpath)`;
 const jsonMatch=body=>roots.map(root=>jsonRootMatch(body,root)).join(' OR ');
 const serializedMatch=body=>roots.map(root=>`strpos((${body})::text,${literal(JSON.stringify(root).slice(1,-1))})>0`).join(' OR ');
 const textMatch=body=>roots.map(root=>`${body} ~ ${literal(referencePattern(root))}`).join(' OR ');
 // Intent is what a worker says and the arguments of its tool calls. Tool results (about 90% of a
 // worker's stored messages: listings, logs) are never serialised for the match.
 const textPresent=body=>roots.map(root=>`strpos(${body},${literal(root)})>0`).join(' OR ');
 const selfCall=selfArgs===null?'FALSE':`EXISTS (SELECT 1 FROM agent a WHERE a.id=${literal(selfArgs.agentId)} AND a.conversation_id=m.conversation_id) AND EXISTS (SELECT 1 FROM jsonb_array_elements(m.parts) p WHERE p->>'type'='tool' AND p->>'callId'=${literal(selfArgs.callId)})`;

 const matchedRoots=body=>`to_json(array_remove(ARRAY[${roots.map(root=>`CASE WHEN (${serializedMatchForRoot(body,root)}) THEN ${literal(root)} ELSE NULL END`).join(',')}],NULL))`;
 const serializedMatchForRoot=(body,root)=>`strpos((${body})::text,${literal(JSON.stringify(root).slice(1,-1))})>0 AND ${jsonRootMatch(body,root)}`;

 const source=resourceKind==='source';
 return `BEGIN READ ONLY; SET LOCAL statement_timeout='${statementTimeoutMs}ms';
 WITH running AS MATERIALIZED (SELECT m.id,m.conversation_id,m.parts,(${selfCall}) AS self FROM message m WHERE m.role='tool' AND m.state='streaming'),
 unique_self AS MATERIALIZED (SELECT id FROM running WHERE self AND (SELECT count(*) FROM running WHERE self)=1),
 self AS MATERIALIZED (SELECT DISTINCT conversation_id FROM running WHERE id IN (SELECT id FROM unique_self)),
 tools AS (SELECT 'tool_call' AS kind,r.id::text AS id,'running' AS state,'reserved-tool-call' AS "resourceClass",p->>'name' AS "toolName",p->'args'->>'path' AS "targetPath",${matchedRoots("p->'args'")} AS "matchedRoots"
  FROM running r CROSS JOIN LATERAL jsonb_array_elements(r.parts) p WHERE r.id NOT IN (SELECT id FROM unique_self) AND p->>'type'='tool' AND (${serializedMatch("p->'args'")}) AND (${jsonMatch("p->'args'")})),
 workers AS (SELECT 'agent' AS kind,a.id,a.state,'source-intent' AS "resourceClass",NULL::text AS "toolName",NULL::text AS "targetPath",NULL::json AS "matchedRoots"
  FROM agent a WHERE ${source&&workers?'TRUE':'FALSE'} AND a.role='worker' AND NOT a.archived AND a.state<>'stopped' AND a.conversation_id NOT IN (SELECT conversation_id FROM self)
  AND EXISTS (SELECT 1 FROM message m WHERE m.conversation_id=a.conversation_id AND (((${textPresent('m.text')}) AND (${textMatch('m.text')})) OR CASE WHEN m.role='tool'
   THEN EXISTS (SELECT 1 FROM jsonb_array_elements(m.parts) p WHERE p->>'type'='tool' AND (${serializedMatch("p->'args'")}) AND (${jsonMatch("p->'args'")}))
   ELSE (${serializedMatch('m.parts')}) AND (${jsonMatch('m.parts')}) END))),
 matching AS (SELECT * FROM tools UNION ALL SELECT * FROM workers)
 SELECT json_build_object('self',(SELECT count(*) FROM unique_self),'references',coalesce((SELECT json_agg(r) FROM (SELECT * FROM matching LIMIT 65) r),'[]'::json)); ROLLBACK;`;
}

// Live-worker intent (the expensive part of a source observation) from the last successful
// observation of the same roots by the same caller. When the full view times out on a loaded
// host, running tool calls are still observed live and worker intent comes from this cache if
// it is at most WORKER_INTENT_TTL_MS old; otherwise the observation fails as before.
export const WORKER_INTENT_TTL_MS=15*60*1000;
export const defaultWorkerIntentCache=()=>path.join(path.dirname(process.env.PI_WORKSPACE_STATE??path.join(process.env.HOME??'/','.local','state','pi-workspaces','registry.sqlite3')),'queue-worker-intent.json');
const intentKey=(channel,roots,self)=>JSON.stringify([channel,[...roots].sort(),self?.agentId??null]);
function readIntentCache(file){try{const value=JSON.parse(fs.readFileSync(file,'utf8'));return value&&typeof value==='object'&&!Array.isArray(value)?value:{};}catch{return {};}}
function writeIntentCache(file,key,references,now){
 try{
  const cache=readIntentCache(file);
  for(const [k,v] of Object.entries(cache))if(!(now-v?.observedAt<=WORKER_INTENT_TTL_MS))delete cache[k];
  cache[key]={observedAt:now,references};
  fs.mkdirSync(path.dirname(file),{recursive:true});
  const temporary=`${file}.tmp-${process.pid}`;fs.writeFileSync(temporary,JSON.stringify(cache));fs.renameSync(temporary,file);
 }catch{}
}
const timedOut=result=>result.error?.code==='ETIMEDOUT'||/statement timeout/.test(String(result.stderr??''));

export function currentStackQueueReferences(roots,{resourceKind,cacheRoots,deadline,channels=kenanChannels,caller=callerToolCall,execute=boundedCommand,user=()=>userInfo().username,workerIntentCache=defaultWorkerIntentCache(),now=Date.now}={}){
 try{
  if(!Number.isSafeInteger(deadline))throw new Error('explicit absolute queue observation deadline required');
  if(!['source','physical-checkout','generated-cache'].includes(resourceKind))throw new Error('explicit source or generated-cache resource kind required');
  if(resourceKind==='generated-cache'&&(!Array.isArray(cacheRoots)||!cacheRoots.length||cacheRoots.some(p=>!path.isAbsolute(p))))throw new Error('exact generated cache resource roots required');
  if(!Array.isArray(roots)||!roots.length||roots.some(p=>typeof p!=='string'||!path.isAbsolute(p)))throw new Error('exact absolute reference roots required');
  const inventory=channels(),self=caller(),role=user();
  if(!/^[a-z_][a-z0-9_-]{0,31}$/.test(role))throw new Error('invalid observer database role');
  const references=[],observations=[];
  for(const [index,channel] of inventory.entries()){
   if(!CHANNEL.test(channel))throw new Error('invalid Kenan Stack channel: '+channel);
   const remaining=deadline-Date.now();if(remaining<=0)throw new Error('Kenan Stack queue observation deadline exhausted before '+channel);
   const selfArgs=self?.channel===channel?{callId:self.callId,agentId:self.agentId}:null;
   // Each remaining channel gets an equal share of the deadline (at most 15 s), less time for psql to start and answer.
   const share=Math.floor(remaining/(inventory.length-index));
   const query=(workers,budget)=>execute('psql',['-X','-qAt','--no-password','--host',KENAN_PG_SOCKET_DIR,'--username',role,'--dbname',channelDatabase(channel),'--set=ON_ERROR_STOP=1','--command',
     queueReferenceSql(roots,selfArgs,resourceKind,{statementTimeoutMs:Math.max(100,Math.min(15000,budget-1500)),workers})],
     {encoding:'utf8',timeout:Math.max(1,Math.min(16500,budget,deadline-Date.now())),maxBuffer:262144,env:{...process.env,PGCONNECT_TIMEOUT:'2'}});
   const parse=result=>{
    const observed=JSON.parse(result.stdout),rows=observed?.references;
    if(!Array.isArray(rows)||rows.length>=65||!Number.isSafeInteger(observed.self)||rows.some(r=>!r||typeof r.id!=='string'||!['tool_call','agent'].includes(r.kind)||typeof r.state!=='string'))throw new Error('Kenan Stack queue observation incomplete: '+channel);
    return {observed,rows};
   };
   const key=intentKey(channel,roots,self);
   let result=query(true,share),workerIntent='live',observed,rows;
   if((result.status!==0||result.error)&&resourceKind==='source'&&timedOut(result)){
    const cached=readIntentCache(workerIntentCache)[key];
    const age=now()-cached?.observedAt;
    if(!(age>=0&&age<=WORKER_INTENT_TTL_MS)||!Array.isArray(cached.references))throw new Error('Kenan Stack queue unavailable: '+channel+': '+String(result.error?.code??result.stderr??result.status).slice(0,1500)+' (no worker observation of these paths in the last 15 minutes to fall back on)');
    const toolsOnly=query(false,deadline-Date.now());
    if(toolsOnly.status!==0||toolsOnly.error)throw new Error('Kenan Stack queue unavailable: '+channel+': '+String(toolsOnly.error?.code??toolsOnly.stderr??toolsOnly.status).slice(0,1500));
    ({observed,rows}=parse(toolsOnly));
    rows=[...rows.filter(r=>r.kind!=='agent'),...cached.references];
    workerIntent={kind:'cached',ageMs:age};
   } else {
    if(result.status!==0||result.error)throw new Error('Kenan Stack queue unavailable: '+channel+': '+String(result.error?.code??result.stderr??result.status).slice(0,1500));
    ({observed,rows}=parse(result));
    if(resourceKind==='source')writeIntentCache(workerIntentCache,key,rows.filter(r=>r.kind==='agent'),now());
   }
   if(Date.now()>=deadline)throw new Error('Kenan Stack queue observation deadline exhausted after '+channel);
   references.push(...rows.filter(r=>resourceKind!=='generated-cache'||!isSourceOnlyRead(r,cacheRoots)).map(r=>({...r,channel,roots})));
   observations.push({channel,roots,count:rows.length,workerIntent,callerToolCalls:observed.self,callerIdentity:self?.channel===channel?{state:'authenticated-system-scope',agentId:self.agentId,callId:self.callId}:self?{state:'not-exempted',code:'CALLER_CHANNEL_DIFFERENT',callerChannel:self.channel,nextAction:'This authenticated caller belongs to another channel; its identity grants no exemption here.'}:{state:'not-exempted',code:'CALLER_IDENTITY_UNAVAILABLE',nextAction:'Use a current locally deployed native runtime with root scope identity; all unmatched streaming tools remain protected.'}});
  }
  return {errors:[],references,observations,resourceKind,observedAt:Date.now()};
 }catch(error){return {errors:[String(error.message)],references:[],observations:[],observedAt:Date.now()};}
}

export function isSourceOnlyRead(reference,cacheRoots) {
 if(reference.toolName!=='read'||typeof reference.targetPath!=='string'||!path.isAbsolute(reference.targetPath))return false;
 try{const target=reference.targetPath;if(fs.realpathSync(target)!==target||!fs.statSync(target).isFile())return false;return cacheRoots.every(root=>target!==root&&!target.startsWith(root+path.sep)&&!root.startsWith(target+path.sep));}catch{return false;}
}
