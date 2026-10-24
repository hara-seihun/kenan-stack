import fs from 'node:fs';
import path from 'node:path';
import {userInfo} from 'node:os';
import {boundedCommand} from './bounded-command.mjs';

// Kenan Stack (the October 17 minimal rewrite) keeps one PostgreSQL database per installed channel
// (`/srv/kenan/CHANNEL`, database `kenan_CHANNEL`) on the `kenan-postgres` cluster's socket directory.
// A running tool call is a `message` row with role='tool' and state='streaming'; a live worker is a
// non-archived, non-stopped `agent` row with role='worker'.
export const KENAN_STACK_ROOT='/srv/kenan';
export const KENAN_PG_SOCKET_DIR='/run/kenan/pg';
const CHANNEL=/^[a-z][a-z0-9-]{0,23}$/;
const SERVER=/^\/srv\/kenan\/([a-z][a-z0-9-]{0,23})\/dist\/server\/main\.js$/;
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
export function procScope(pid,{read=p=>fs.readFileSync(`/proc/${p}/cgroup`,'utf8'),query=(unit)=>boundedCommand('/usr/bin/systemctl',['--system','show',unit,'--no-pager','--property=Description,ControlGroup,Transient,ActiveState'],{encoding:'utf8',timeout:2000,maxBuffer:8192,env:{PATH:'/usr/sbin:/usr/bin:/sbin:/bin',LC_ALL:'C',SYSTEMD_COLORS:'0'}})}={}){
 const rows=read(pid).trim().split('\n');
 const group=rows.find(r=>r.startsWith('0::'))?.slice(3),unit=group?.split('/').at(-1);
 if(!group||!/^agent-tool-[a-z][a-z0-9-]*-[a-f0-9-]{36}\.scope$/.test(unit??''))return null;
 const r=query(unit);
 if(r.status!==0||r.error)return null;
 const props=Object.fromEntries(r.stdout.trim().split('\n').map(line=>{const at=line.indexOf('=');return [line.slice(0,at),line.slice(at+1)];}));
 if(props.ControlGroup!==group||props.Transient!=='yes'||props.ActiveState!=='active'||!props.Description?.startsWith('kenan-tool-call:'))return null;
 const v=JSON.parse(props.Description.slice('kenan-tool-call:'.length));
 return {...v,unit,group};
}
function identity(v){return v&&typeof v==='object'&&typeof v.callId==='string'&&v.callId.length>0&&v.callId.length<=256&&!/[\x00-\x1f]/.test(v.callId)&&typeof v.agentId==='string'&&/^[a-zA-Z0-9:_-]{1,128}$/.test(v.agentId);}
export function callerToolCall({pid=process.pid,argv=procArgv,parent=procParent,scope=procScope,uid=p=>fs.statSync(`/proc/${p}`).uid}={}) {
 try{
  const observed=scope(pid);
  if(!identity(observed)||observed.version!==1||!CHANNEL.test(observed.channel)||!observed.unit.startsWith(`agent-tool-${observed.channel}-`))return null;
  for(let current=pid,depth=0;current>1&&depth<64;depth++){
   const up=parent(current);if(!(up>1))return null;
   const server=argv(up)[1]?.match(SERVER);
   if(server&&uid(up)===0)return server[1]===observed.channel?{channel:server[1],callId:observed.callId,agentId:observed.agentId}:null;
   current=up;
  }
 }catch{}
 return null;
}

export function queueReferenceSql(root,selfArgs,resourceKind){
 if(!['source','physical-checkout','generated-cache'].includes(resourceKind))throw new Error('explicit source or generated-cache resource kind required');
 const roots=Array.isArray(root)?root:[root];
 if(selfArgs!==null&&!identity(selfArgs))throw new Error('invalid caller tool identity');
 const jsonMatch=body=>roots.map(root=>`jsonb_path_exists(${body},${literal('strict $.** ? (@.type() == "string" && @ like_regex '+JSON.stringify(root)+' flag "q")')}::jsonpath)`).join(' OR ');
 const serializedMatch=body=>roots.map(root=>`strpos((${body})::text,${literal(JSON.stringify(root).slice(1,-1))})>0`).join(' OR ');
 const textMatch=body=>roots.map(root=>`strpos(${body},${literal(root)})>0`).join(' OR ');
 const selfCall=selfArgs===null?'FALSE':`EXISTS (SELECT 1 FROM agent a WHERE a.id=${literal(selfArgs.agentId)} AND a.conversation_id=m.conversation_id) AND EXISTS (SELECT 1 FROM jsonb_array_elements(m.parts) p WHERE p->>'type'='tool' AND p->>'callId'=${literal(selfArgs.callId)})`;

 const source=resourceKind==='source';
 return `BEGIN READ ONLY; SET LOCAL statement_timeout='4000ms';
 WITH running AS MATERIALIZED (SELECT m.id,m.conversation_id,m.parts,(${selfCall}) AS self FROM message m WHERE m.role='tool' AND m.state='streaming'),
 unique_self AS MATERIALIZED (SELECT id FROM running WHERE self AND (SELECT count(*) FROM running WHERE self)=1),
 self AS MATERIALIZED (SELECT DISTINCT conversation_id FROM running WHERE id IN (SELECT id FROM unique_self)),
 tools AS (SELECT 'tool_call' AS kind,r.id::text AS id,'running' AS state,'reserved-tool-call' AS "resourceClass",p->>'name' AS "toolName",p->'args'->>'path' AS "targetPath"
  FROM running r CROSS JOIN LATERAL jsonb_array_elements(r.parts) p WHERE r.id NOT IN (SELECT id FROM unique_self) AND p->>'type'='tool' AND (${serializedMatch("p->'args'")}) AND (${jsonMatch("p->'args'")})),
 workers AS (SELECT 'agent' AS kind,a.id,a.state,'source-intent' AS "resourceClass",NULL::text AS "toolName",NULL::text AS "targetPath"
  FROM agent a WHERE ${source?'TRUE':'FALSE'} AND a.role='worker' AND NOT a.archived AND a.state<>'stopped' AND a.conversation_id NOT IN (SELECT conversation_id FROM self)
  AND EXISTS (SELECT 1 FROM message m WHERE m.conversation_id=a.conversation_id AND ((${textMatch('m.text')}) OR ((${serializedMatch('m.parts')}) AND (${jsonMatch('m.parts')}))))),
 matching AS (SELECT * FROM tools UNION ALL SELECT * FROM workers)
 SELECT json_build_object('self',(SELECT count(*) FROM unique_self),'references',coalesce((SELECT json_agg(r) FROM (SELECT * FROM matching LIMIT 65) r),'[]'::json)); ROLLBACK;`;
}

export function currentStackQueueReferences(roots,{resourceKind,cacheRoots,deadline,channels=kenanChannels,caller=callerToolCall,execute=boundedCommand,user=()=>userInfo().username}={}){
 try{
  if(!Number.isSafeInteger(deadline))throw new Error('explicit absolute queue observation deadline required');
  if(!['source','physical-checkout','generated-cache'].includes(resourceKind))throw new Error('explicit source or generated-cache resource kind required');
  if(resourceKind==='generated-cache'&&(!Array.isArray(cacheRoots)||!cacheRoots.length||cacheRoots.some(p=>!path.isAbsolute(p))))throw new Error('exact generated cache resource roots required');
  if(!Array.isArray(roots)||!roots.length||roots.some(p=>typeof p!=='string'||!path.isAbsolute(p)))throw new Error('exact absolute reference roots required');
  const inventory=channels(),self=caller(),role=user();
  if(!/^[a-z_][a-z0-9_-]{0,31}$/.test(role))throw new Error('invalid observer database role');
  const references=[],observations=[];
  for(const channel of inventory){
   if(!CHANNEL.test(channel))throw new Error('invalid Kenan Stack channel: '+channel);
   const remaining=deadline-Date.now();if(remaining<=0)throw new Error('Kenan Stack queue observation deadline exhausted before '+channel);
   const selfArgs=self?.channel===channel?{callId:self.callId,agentId:self.agentId}:null;
   const result=execute('psql',['-X','-qAt','--no-password','--host',KENAN_PG_SOCKET_DIR,'--username',role,'--dbname',channelDatabase(channel),'--set=ON_ERROR_STOP=1','--command',queueReferenceSql(roots,selfArgs,resourceKind)],{encoding:'utf8',timeout:Math.min(6000,remaining),maxBuffer:262144,env:{...process.env,PGCONNECT_TIMEOUT:'2'}});
   if(result.status!==0||result.error)throw new Error('Kenan Stack queue unavailable: '+channel+': '+String(result.error?.code??result.stderr??result.status).slice(0,1500));
   if(Date.now()>=deadline)throw new Error('Kenan Stack queue observation deadline exhausted after '+channel);
   const observed=JSON.parse(result.stdout),rows=observed?.references;
   if(!Array.isArray(rows)||rows.length>=65||!Number.isSafeInteger(observed.self)||rows.some(r=>!r||typeof r.id!=='string'||!['tool_call','agent'].includes(r.kind)||typeof r.state!=='string'))throw new Error('Kenan Stack queue observation incomplete: '+channel);
   references.push(...rows.filter(r=>resourceKind!=='generated-cache'||!isSourceOnlyRead(r,cacheRoots)).map(r=>({...r,channel,roots})));
   observations.push({channel,roots,count:rows.length,callerToolCalls:observed.self,callerIdentity:self?.channel===channel?{state:'authenticated-system-scope',agentId:self.agentId,callId:self.callId}:{state:'not-exempted',code:'CALLER_IDENTITY_UNAVAILABLE',nextAction:'Use a current locally deployed native runtime with root scope identity; all unmatched streaming tools remain protected.'}});
  }
  return {errors:[],references,observations,resourceKind,observedAt:Date.now()};
 }catch(error){return {errors:[String(error.message)],references:[],observations:[],observedAt:Date.now()};}
}

export function isSourceOnlyRead(reference,cacheRoots) {
 if(reference.toolName!=='read'||typeof reference.targetPath!=='string'||!path.isAbsolute(reference.targetPath))return false;
 try{const target=reference.targetPath;if(fs.realpathSync(target)!==target||!fs.statSync(target).isFile())return false;return cacheRoots.every(root=>target!==root&&!target.startsWith(root+path.sep)&&!root.startsWith(target+path.sep));}catch{return false;}
}
