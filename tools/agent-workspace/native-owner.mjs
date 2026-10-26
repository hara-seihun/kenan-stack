import fs from 'node:fs';
import path from 'node:path';
import {userInfo} from 'node:os';
import {boundedCommand} from './bounded-command.mjs';
import {callerToolCall,channelDatabase,kenanChannels,KENAN_PG_SOCKET_DIR} from './cache-queue.mjs';
import {OWNER_AGENT_ID,NATIVE_CUSTODIAN_ID} from './owner-liveness.mjs';

// Canonical native owner binding.
//
// `--owner` is a free label (task names, 8-character agent prefixes, Converge task ids). The
// native worker that actually created or registered a checkout is recorded separately, from
// one of two authenticated sources and never from a name:
//  - "caller-scope": the root-created systemd scope of the running Kenan Stack tool call
//    (cache-queue.mjs callerToolCall), read at create/register time;
//  - "admission-receipt": a checkout job's environment receipt (KENAN_AGENT and
//    KENAN_TOOL_CALL_ID, written by the runtime into the tool call's environment) whose request
//    is byte-identical to the record's creation request, and whose (agent, tool call) pair is
//    confirmed by the native message store: that exact tool call exists in that agent's
//    conversation on exactly one serving channel.
// Anything else stays unbound; an unbound non-native owner remains "unknown" to owner liveness.

// The runtime retains Codex calls as a complete call id plus response function item id.
// Accept only that exact composite shape in addition to the existing simple ids; neither
// segment is a substitute for the full native-store identity.
const CALL_ID=/^(?:[A-Za-z0-9_:.-]{1,256}|call_[a-f0-9]{32}\|fc_[a-f0-9]{50})$/;
const CHANNEL=/^[a-z][a-z0-9-]{0,23}$/;
const MAX_PAIRS=512;

export function ensureNativeOwnerTable(database){
 database.exec(`CREATE TABLE IF NOT EXISTS workspace_native_owner(
  workspace_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, channel TEXT NOT NULL, call_id TEXT NOT NULL,
  source TEXT NOT NULL CHECK(source IN ('caller-scope','admission-receipt')), bound_at INTEGER NOT NULL, evidence_json TEXT NOT NULL)`);
}

function validBinding(value){
 return value!==null&&typeof value==='object'&&NATIVE_CUSTODIAN_ID.test(value.agentId??'')&&CHANNEL.test(value.channel??'')&&CALL_ID.test(value.callId??'');
}

// The authenticated caller of this process, or null when it is not a native worker tool call.
export function nativeCaller({caller=callerToolCall,onError=()=>{}}={}){
 let observed=null;
 try{observed=caller({onError});}catch(error){onError({code:'caller-observation-failed',detail:`Native caller inspection failed (${error.code??error.name}).`});return null;}
 if(observed!==null&&!validBinding(observed))onError({code:'caller-binding-invalid',detail:'The scope identity does not match the native store identity protocol.'});
 return validBinding(observed)?{agentId:observed.agentId,channel:observed.channel,callId:observed.callId}:null;
}

export function bindNativeOwner(database,workspaceId,binding,source,evidence){
 if(!validBinding(binding))throw new Error('authenticated native owner binding required');
 if(source!=='caller-scope'&&source!=='admission-receipt')throw new Error('unknown native owner binding source');
 ensureNativeOwnerTable(database);
 if(source==='admission-receipt'){
  const existing=nativeOwnerBinding(database,workspaceId);
  if(existing.state==='set'&&existing.agentId!==binding.agentId)throw new Error('admission receipt conflicts with the existing authenticated owner binding');
 }
 database.prepare(`INSERT INTO workspace_native_owner(workspace_id,agent_id,channel,call_id,source,bound_at,evidence_json) VALUES(?,?,?,?,?,?,?)
  ON CONFLICT(workspace_id) DO UPDATE SET agent_id=excluded.agent_id,channel=excluded.channel,call_id=excluded.call_id,source=excluded.source,bound_at=excluded.bound_at,evidence_json=excluded.evidence_json`)
  .run(workspaceId,binding.agentId,binding.channel,binding.callId,source,Date.now(),JSON.stringify(evidence??null));
}

export function unbindNativeOwner(database,workspaceId){
 ensureNativeOwnerTable(database);
 database.prepare('DELETE FROM workspace_native_owner WHERE workspace_id=?').run(workspaceId);
}

// Ownership transfer: an authenticated native caller becomes the owner; any other caller leaves the
// workspace unbound, so a stale binding can never keep classifying the previous owner.
export function reassignNativeOwner(database,workspaceId,caller,evidence){
 if(caller===null||caller===undefined){unbindNativeOwner(database,workspaceId);return {state:'unset'};}
 bindNativeOwner(database,workspaceId,caller,'caller-scope',evidence);
 return nativeOwnerBinding(database,workspaceId);
}

export function nativeOwnerBinding(database,workspaceId){
 if(database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='workspace_native_owner'").get()===undefined)return {state:'unset'};
 const row=database.prepare('SELECT agent_id,channel,call_id,source,bound_at FROM workspace_native_owner WHERE workspace_id=?').get(workspaceId);
 return row===undefined?{state:'unset'}:{state:'set',agentId:row.agent_id,channel:row.channel,callId:row.call_id,source:row.source,boundAt:row.bound_at};
}

// The id owner liveness classifies: a native registered owner is itself canonical; otherwise the
// authenticated binding; otherwise the registered label, which classifies as unknown.
export function canonicalNativeOwner(database,record){
 if(OWNER_AGENT_ID.test(record.owner))return record.owner;
 const binding=nativeOwnerBinding(database,record.id);
 return binding.state==='set'?binding.agentId:record.owner;
}

// Admission receipts of one workspace's checkout jobs. Every job that carries a caller identity
// must name the same agent and carry the record's exact creation request.
export function admissionReceipts(statePath,workspaceId,creationRequest,{deadline=Date.now()+30000}={}){
 const directory=path.join(path.dirname(statePath),'checkout-jobs',workspaceId);
 if(!fs.existsSync(directory))return {kind:'none',code:'no-checkout-job'};
 const pairs=[];
 let entries=0;
 const handle=fs.opendirSync(directory);
 try{for(let entry;(entry=handle.readSync())!==null;){
  if(Date.now()>=deadline)return {kind:'invalid',code:'receipt-deadline'};
  if(++entries>2048)return {kind:'invalid',code:'receipt-job-limit'};
  if(!entry.isDirectory())continue;
  const job=path.join(directory,entry.name);
  let environment,request;
  const environmentFile=path.join(job,'environment.json'),requestFile=path.join(job,'request.json');
  if(!fs.existsSync(environmentFile))continue;
  try{if(fs.statSync(environmentFile).size>1048576)throw Error('oversized');environment=JSON.parse(fs.readFileSync(environmentFile,'utf8'));}catch{return {kind:'invalid',code:'receipt-environment-unreadable',job:entry.name};}
  if(environment===null||typeof environment!=='object')return {kind:'invalid',code:'receipt-environment-unreadable',job:entry.name};
  if(environment.KENAN_AGENT===undefined&&environment.KENAN_TOOL_CALL_ID===undefined)continue;
  try{if(fs.statSync(requestFile).size>16*1048576)throw Error('oversized');request=JSON.parse(fs.readFileSync(requestFile,'utf8'));}catch{return {kind:'invalid',code:'receipt-request-unreadable',job:entry.name};}
  if(!OWNER_AGENT_ID.test(environment.KENAN_AGENT??'')||!CALL_ID.test(environment.KENAN_TOOL_CALL_ID??''))return {kind:'invalid',code:'receipt-identity-malformed',job:entry.name};
  if(typeof creationRequest!=='string'||creationRequest===''||request?.id!==workspaceId||request?.request!==creationRequest)return {kind:'invalid',code:'receipt-request-mismatch',job:entry.name};
  if(pairs.length>=MAX_PAIRS)return {kind:'invalid',code:'receipt-pair-limit'};
  pairs.push({agentId:environment.KENAN_AGENT,callId:environment.KENAN_TOOL_CALL_ID,job:entry.name});
 }
 }finally{handle.closeSync();}
 pairs.sort((a,b)=>a.job.localeCompare(b.job));
 if(!pairs.length)return {kind:'none',code:'no-caller-receipt'};
 const agents=[...new Set(pairs.map(pair=>pair.agentId))];
 if(agents.length!==1)return {kind:'invalid',code:'receipt-agents-conflict',agents};
 return {kind:'receipt',agentId:agents[0],pairs};
}

const literal=value=>"'"+value.replaceAll("'","''")+"'";
export function toolCallAuthenticationSql(pairs){
 if(!Array.isArray(pairs)||!pairs.length||pairs.length>MAX_PAIRS||pairs.some(pair=>!NATIVE_CUSTODIAN_ID.test(pair.agentId)||!CALL_ID.test(pair.callId)))throw new Error('bounded exact (agent, tool call) pairs required');
 const values=pairs.map(pair=>`(${literal(pair.agentId)},${literal(pair.callId)})`).join(',');
 return `BEGIN READ ONLY; SET LOCAL statement_timeout='8000ms';
 WITH requested(agent_id,call_id) AS (VALUES ${values}),
 identities AS MATERIALIZED (SELECT v.agent_id,v.call_id,a.conversation_id FROM requested v JOIN agent a ON a.id::text=v.agent_id),
 conversations AS (SELECT DISTINCT conversation_id FROM identities),
 calls AS MATERIALIZED (SELECT c.conversation_id,p->>'callId' AS call_id FROM conversations c
  CROSS JOIN LATERAL (SELECT parts FROM message WHERE conversation_id=c.conversation_id OFFSET 0) m
  CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(m.parts)='array' THEN m.parts ELSE '[]'::jsonb END) p WHERE p->>'type'='tool')
 SELECT coalesce(json_agg(json_build_object('agentId',v.agent_id,'callId',v.call_id)),'[]'::json) FROM identities v
 WHERE EXISTS (SELECT 1 FROM calls c WHERE c.conversation_id=v.conversation_id AND c.call_id=v.call_id); ROLLBACK;`;
}

// Which pairs the native store confirms, per channel. Any channel failure fails the whole
// observation: a partial view could hide a second channel's claim.
export function authenticateToolCalls(pairs,{deadline,channels=kenanChannels,execute=boundedCommand,user=()=>userInfo().username}={}){
 try{
  if(!Number.isSafeInteger(deadline))throw new Error('explicit absolute authentication deadline required');
  const role=user();
  if(!/^[a-z_][a-z0-9_-]{0,31}$/.test(role))throw new Error('invalid observer database role');
  if(!Array.isArray(pairs)||!pairs.length)throw new Error('exact (agent, tool call) pairs required');
  const confirmed=new Map();
  for(let at=0;at<pairs.length;at+=MAX_PAIRS){
   const batch=pairs.slice(at,at+MAX_PAIRS);
   for(const channel of channels()){
    if(!CHANNEL.test(channel))throw new Error('invalid Kenan Stack channel: '+channel);
    const remaining=deadline-Date.now();if(remaining<=0)throw new Error('authentication deadline exhausted before '+channel);
    const result=execute('psql',['-X','-qAt','--no-password','--host',KENAN_PG_SOCKET_DIR,'--username',role,'--dbname',channelDatabase(channel),'--set=ON_ERROR_STOP=1','--command',toolCallAuthenticationSql(batch)],{encoding:'utf8',timeout:Math.min(10_000,remaining),maxBuffer:16<<20,env:{...process.env,PGCONNECT_TIMEOUT:'2'}});
    if(result.status!==0||result.error)throw new Error('native tool-call observation unavailable: '+channel+': '+String(result.error?.code??result.stderr??result.status).trim().slice(0,1500));
    let rows;try{rows=JSON.parse(String(result.stdout).trim());}catch{throw new Error('native tool-call observation malformed: '+channel);}
    if(!Array.isArray(rows))throw new Error('native tool-call observation malformed: '+channel);
    const asked=new Set(batch.map(pair=>pair.agentId+'\0'+pair.callId));
    for(const row of rows){
     const key=typeof row?.agentId==='string'&&typeof row?.callId==='string'?row.agentId+'\0'+row.callId:'';
     if(!asked.has(key))throw new Error('native tool-call observation returned an unrequested pair: '+channel);
     const seen=confirmed.get(key)??[];if(!seen.includes(channel))confirmed.set(key,[...seen,channel]);
    }
   }
  }
  return {errors:[],confirmed};
 }catch(error){return {errors:[String(error.message)],confirmed:new Map()};}
}

export function receiptBinding(receipt,authentication){
 if(receipt.kind!=='receipt')return {kind:'unbound',code:receipt.code};
 if(authentication.errors.length)return {kind:'unbound',code:'native-observation-unavailable',detail:authentication.errors.join('; ')};
 const channels=new Set();
 for(const pair of receipt.pairs){
  const found=authentication.confirmed.get(pair.agentId+'\0'+pair.callId)??[];
  if(found.length!==1)return {kind:'unbound',code:found.length?'receipt-tool-call-ambiguous':'receipt-tool-call-unconfirmed',job:pair.job};
  channels.add(found[0]);
 }
 if(channels.size!==1)return {kind:'unbound',code:'receipt-channels-conflict'};
 const first=receipt.pairs[0];
 return {kind:'bindable',binding:{agentId:receipt.agentId,channel:[...channels][0],callId:first.callId},evidence:{jobs:receipt.pairs.map(pair=>({job:pair.job,callId:pair.callId}))}};
}
