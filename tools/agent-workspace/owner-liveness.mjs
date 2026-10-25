import path from 'node:path';
import {userInfo} from 'node:os';
import {boundedCommand} from './bounded-command.mjs';
import {kenanChannels,channelDatabase,KENAN_PG_SOCKET_DIR} from './cache-queue.mjs';

// Owner liveness for registered workspaces whose owner is a Kenan Stack native worker id.
//
// A native worker that is authentically stopped, or archived, can never write to its checkout
// again on its own: that ends the owner's *intent* to write, which is what an ordinary
// `release` by the owner would have declared. It is NOT evidence that nothing is running in the
// checkout: every release still observes running tool calls, live workers that name the path,
// processes, units, containers, threads and Git borrowers, and refuses on any of them.
//
// The classification is deliberately one-sided:
//  - "ended" needs a positive native row for the exact owner id, in a complete observation of
//    every serving channel, with every row stopped or archived and no pending wake owned by or
//    held for that agent;
//  - an owner that is absent from every channel is "unknown", never "ended" (a missing row is
//    not proof: it may belong to another host, a retired runtime or a different registry);
//  - an owner that is not a native worker id (task names, manager ids) is "unknown";
//  - any observation failure makes every owner "unknown".
// Pending wakes (held triggers and ordinary wakes) that name the workspace path or its basename,
// or held triggers for the ended owner's goal, keep the checkout for the worker that will resume.

export const OWNER_AGENT_ID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CHANNEL=/^[a-z][a-z0-9-]{0,23}$/;
const MAX_OWNERS=512,MAX_WAKES=5000;

export function ownerLivenessSql(owners){
 if(!Array.isArray(owners)||owners.length>MAX_OWNERS||owners.some(owner=>!OWNER_AGENT_ID.test(owner)))throw new Error('bounded native worker owner ids required');
 const list=owners.length?`ARRAY[${owners.map(owner=>`'${owner}'`).join(',')}]::text[]`:`ARRAY[]::text[]`;
 return `BEGIN READ ONLY; SET LOCAL statement_timeout='4000ms';
 SELECT json_build_object(
  'agents',coalesce((SELECT json_agg(json_build_object('id',a.id,'role',a.role,'state',a.state,'archived',a.archived,'goalId',a.goal_id,'updatedAt',a.updated_at)) FROM agent a WHERE a.id=ANY(${list})),'[]'::json),
  'wakeCount',(SELECT count(*) FROM wake w WHERE w.status='pending'),
  'wakes',coalesce((SELECT json_agg(json_build_object('id',w.id,'agentId',w.agent_id,'goalId',w.goal_id,'heldFor',w.held_for,'held',w.handoff IS NOT NULL,'text',concat_ws(E'\\n',w.message,w.handoff,w.event::text))) FROM (SELECT * FROM wake WHERE status='pending' ORDER BY created_at LIMIT ${MAX_WAKES}) w),'[]'::json)); ROLLBACK;`;
}

export function observeOwnerLiveness(owners,{deadline,channels=kenanChannels,execute=boundedCommand,user=()=>userInfo().username}={}){
 const nativeOwners=[...new Set(owners.filter(owner=>OWNER_AGENT_ID.test(owner)))].sort();
 try{
  if(!Number.isSafeInteger(deadline))throw new Error('explicit absolute owner observation deadline required');
  if(nativeOwners.length>MAX_OWNERS)throw new Error(`owner observation is bounded to ${MAX_OWNERS} owners`);
  const inventory=channels(),role=user();
  if(!/^[a-z_][a-z0-9_-]{0,31}$/.test(role))throw new Error('invalid observer database role');
  const agents=[],wakes=[],observations=[];
  for(const channel of inventory){
   if(!CHANNEL.test(channel))throw new Error('invalid Kenan Stack channel: '+channel);
   const remaining=deadline-Date.now();if(remaining<=0)throw new Error('owner observation deadline exhausted before '+channel);
   const result=execute('psql',['-X','-qAt','--no-password','--host',KENAN_PG_SOCKET_DIR,'--username',role,'--dbname',channelDatabase(channel),'--set=ON_ERROR_STOP=1','--command',ownerLivenessSql(nativeOwners)],{encoding:'utf8',timeout:Math.min(6000,remaining),maxBuffer:16<<20,env:{...process.env,PGCONNECT_TIMEOUT:'2'}});
   if(result.status!==0||result.error)throw new Error('native owner observation unavailable: '+channel+': '+String(result.error?.code??result.stderr??result.status).trim().slice(0,1500));
   const observed=JSON.parse(result.stdout);
   if(!observed||!Array.isArray(observed.agents)||!Array.isArray(observed.wakes)||!Number.isSafeInteger(Number(observed.wakeCount))||Number(observed.wakeCount)!==observed.wakes.length)throw new Error('native owner observation incomplete: '+channel);
   if(observed.agents.some(a=>!a||typeof a.id!=='string'||typeof a.state!=='string'||typeof a.archived!=='boolean'))throw new Error('native owner observation malformed: '+channel);
   if(observed.wakes.some(w=>!w||typeof w.id!=='string'||typeof w.agentId!=='string'||typeof w.text!=='string'))throw new Error('native wake observation malformed: '+channel);
   agents.push(...observed.agents.map(a=>({...a,channel})));wakes.push(...observed.wakes.map(w=>({...w,channel})));
   observations.push({channel,agents:observed.agents.length,pendingWakes:observed.wakes.length});
  }
  return {errors:[],owners:nativeOwners,agents,wakes,observations,observedAt:Date.now()};
 }catch(error){return {errors:[String(error.message)],owners:nativeOwners,agents:[],wakes:[],observations:[],observedAt:Date.now()};}
}

export function classifyOwner(owner,observation){
 if(typeof owner!=='string'||!OWNER_AGENT_ID.test(owner))return {kind:'unknown',code:'owner-not-native-worker-id',owner};
 if(!observation||!Array.isArray(observation.errors)||observation.errors.length)return {kind:'unknown',code:'owner-observation-unavailable',owner,detail:observation?.errors?.join('; ')??'unset'};
 if(!observation.owners?.includes(owner))return {kind:'unknown',code:'owner-not-observed',owner};
 const rows=observation.agents.filter(a=>a.id===owner);
 if(!rows.length)return {kind:'unknown',code:'owner-absent-from-native-store',owner,detail:'absence is not evidence that the owner ended'};
 const live=rows.filter(a=>a.archived!==true&&a.state!=='stopped');
 if(live.length)return {kind:'live',code:'owner-live',owner,agents:live};
 const wakes=observation.wakes.filter(w=>w.agentId===owner||w.heldFor===owner);
 if(wakes.length)return {kind:'live',code:'owner-pending-wake',owner,wakes:wakes.map(w=>({id:w.id,channel:w.channel}))};
 return {kind:'ended',code:rows.every(a=>a.archived===true)?'owner-archived':'owner-stopped',owner,
  agents:rows.map(a=>({id:a.id,channel:a.channel,role:a.role,state:a.state,archived:a.archived,goalId:a.goalId??null,updatedAt:a.updatedAt??null}))};
}

const boundary=/[A-Za-z0-9_.-]/;
function namesToken(text,token){
 if(!token)return false;
 for(let at=text.indexOf(token);at>=0;at=text.indexOf(token,at+1)){
  const before=at===0?'':text[at-1],after=text[at+token.length]??'';
  if(!boundary.test(before)&&!boundary.test(after))return true;
 }
 return false;
}
// Handoffs name checkouts by absolute path, relative path or bare directory name.
export function pendingWakeReferences(workspacePath,observation,ownerVerdict){
 const base=path.basename(workspacePath),goals=new Set((ownerVerdict?.agents??[]).map(a=>a.goalId).filter(Boolean));
 return (observation?.wakes??[]).filter(w=>w.text.includes(workspacePath)||namesToken(w.text,base)||(w.held&&w.goalId&&goals.has(w.goalId)))
  .map(w=>({kind:'pending-wake',id:w.id,channel:w.channel,agentId:w.agentId,goalId:w.goalId??null,held:w.held===true,
   match:w.text.includes(workspacePath)?'path':namesToken(w.text,base)?'basename':'owner-goal-held-trigger'}));
}
