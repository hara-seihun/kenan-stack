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
// The calling agent's own bash tool call names the checkout in its command: it is the operator, not a competing
// consumer. Bash may exec the final command, so the tool command cannot be read back from /proc. Instead,
// when a Kenan Stack server is an ancestor, the caller is identified by this agent-workspace invocation's own
// arguments: running bash tool calls that invoke agent-workspace with every one of these arguments.
export function callerToolCall({pid=process.pid,argv=procArgv,parent=procParent,args=process.argv.slice(2)}={}) {
 try{
  if(!Array.isArray(args)||!args.length||args.length>64||args.some(arg=>typeof arg!=='string'||arg.length>4096))return null;
  for(let current=pid,depth=0;current>1&&depth<64;depth++){
   const up=parent(current);if(!(up>1))return null;
   const server=argv(up)[1]?.match(SERVER);
   if(server)return {channel:server[1],args:args.filter(Boolean)};
   current=up;
  }
 }catch{}
 return null;
}

export function queueReferenceSql(root,selfArgs,resourceKind){
 if(!['source','physical-checkout','generated-cache'].includes(resourceKind))throw new Error('explicit source or generated-cache resource kind required');
 const roots=Array.isArray(root)?root:[root];
 if(selfArgs!==null&&(!Array.isArray(selfArgs)||!selfArgs.length||selfArgs.length>64||selfArgs.some(arg=>typeof arg!=='string'||!arg||arg.length>4096)))throw new Error('invalid caller tool identity');
 const jsonMatch=body=>roots.map(root=>`jsonb_path_exists(${body},${literal('strict $.** ? (@.type() == "string" && @ like_regex '+JSON.stringify(root)+' flag "q")')}::jsonpath)`).join(' OR ');
 const serializedMatch=body=>roots.map(root=>`strpos((${body})::text,${literal(JSON.stringify(root).slice(1,-1))})>0`).join(' OR ');
 const textMatch=body=>roots.map(root=>`strpos(${body},${literal(root)})>0`).join(' OR ');
 const selfCall=selfArgs===null?'FALSE':`EXISTS (SELECT 1 FROM jsonb_array_elements(m.parts) p WHERE p->>'type'='tool' AND p->>'name'='bash' AND strpos(p->'args'->>'command','agent-workspace')>0 AND ${selfArgs.map(arg=>`strpos(p->'args'->>'command',${literal(arg)})>0`).join(' AND ')})`;
 const source=resourceKind==='source';
 return `BEGIN READ ONLY; SET LOCAL statement_timeout='4000ms';
 WITH running AS MATERIALIZED (SELECT m.id,m.conversation_id,m.parts,(${selfCall}) AS self FROM message m WHERE m.role='tool' AND m.state='streaming'),
 self AS MATERIALIZED (SELECT DISTINCT conversation_id FROM running WHERE self),
 tools AS (SELECT 'tool_call' AS kind,r.id::text AS id,'running' AS state,'reserved-tool-call' AS "resourceClass",p->>'name' AS "toolName",p->'args'->>'path' AS "targetPath"
  FROM running r CROSS JOIN LATERAL jsonb_array_elements(r.parts) p WHERE NOT r.self AND p->>'type'='tool' AND (${serializedMatch("p->'args'")}) AND (${jsonMatch("p->'args'")})),
 workers AS (SELECT 'agent' AS kind,a.id,a.state,'source-intent' AS "resourceClass",NULL::text AS "toolName",NULL::text AS "targetPath"
  FROM agent a WHERE ${source?'TRUE':'FALSE'} AND a.role='worker' AND NOT a.archived AND a.state<>'stopped' AND a.conversation_id NOT IN (SELECT conversation_id FROM self)
  AND EXISTS (SELECT 1 FROM message m WHERE m.conversation_id=a.conversation_id AND ((${textMatch('m.text')}) OR ((${serializedMatch('m.parts')}) AND (${jsonMatch('m.parts')}))))),
 matching AS (SELECT * FROM tools UNION ALL SELECT * FROM workers)
 SELECT json_build_object('self',(SELECT count(*) FROM running WHERE self),'references',coalesce((SELECT json_agg(r) FROM (SELECT * FROM matching LIMIT 65) r),'[]'::json)); ROLLBACK;`;
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
   const selfArgs=self?.channel===channel?self.args:null;
   const result=execute('psql',['-X','-qAt','--no-password','--host',KENAN_PG_SOCKET_DIR,'--username',role,'--dbname',channelDatabase(channel),'--set=ON_ERROR_STOP=1','--command',queueReferenceSql(roots,selfArgs,resourceKind)],{encoding:'utf8',timeout:Math.min(6000,remaining),maxBuffer:262144,env:{...process.env,PGCONNECT_TIMEOUT:'2'}});
   if(result.status!==0||result.error)throw new Error('Kenan Stack queue unavailable: '+channel+': '+String(result.error?.code??result.stderr??result.status).slice(0,1500));
   if(Date.now()>=deadline)throw new Error('Kenan Stack queue observation deadline exhausted after '+channel);
   const observed=JSON.parse(result.stdout),rows=observed?.references;
   if(!Array.isArray(rows)||rows.length>=65||!Number.isSafeInteger(observed.self)||rows.some(r=>!r||typeof r.id!=='string'||!['tool_call','agent'].includes(r.kind)||typeof r.state!=='string'))throw new Error('Kenan Stack queue observation incomplete: '+channel);
   references.push(...rows.filter(r=>resourceKind!=='generated-cache'||!isSourceOnlyRead(r,cacheRoots)).map(r=>({...r,channel,roots})));
   observations.push({channel,roots,count:rows.length,callerToolCalls:observed.self});
  }
  return {errors:[],references,observations,resourceKind,observedAt:Date.now()};
 }catch(error){return {errors:[String(error.message)],references:[],observations:[],observedAt:Date.now()};}
}

export function isSourceOnlyRead(reference,cacheRoots) {
 if(reference.toolName!=='read'||typeof reference.targetPath!=='string'||!path.isAbsolute(reference.targetPath))return false;
 try{const target=reference.targetPath;if(fs.realpathSync(target)!==target||!fs.statSync(target).isFile())return false;return cacheRoots.every(root=>target!==root&&!target.startsWith(root+path.sep)&&!root.startsWith(target+path.sep));}catch{return false;}
}
