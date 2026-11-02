import {userInfo} from 'node:os';
import {boundedCommand} from './bounded-command.mjs';
import {channelDatabase,KENAN_PG_SOCKET_DIR} from './cache-queue.mjs';
import {NATIVE_CUSTODIAN_ID} from './owner-liveness.mjs';

// Cleanup follows authenticated work assignment, not an owner label or an authorization
// string. This grants only ordinary release; reassignment and source freezing stay owner-only.
export function releaseDelegationSql(caller,custodian) {
 if(![caller,custodian].every(id=>NATIVE_CUSTODIAN_ID.test(id??'')))throw Error('exact native release identities required');
 return `BEGIN READ ONLY; SET LOCAL statement_timeout='4000ms';
 SELECT coalesce(json_agg(json_build_object('id',id,'ownerId',owner_id,'role',role,'goalId',goal_id,
  'parentAgentId',parent_agent_id,'state',state,'archived',archived)),'[]'::json)
 FROM agent WHERE id IN ('${caller}','${custodian}'); ROLLBACK;`;
}
export function classifyReleaseDelegation(rows,caller,custodian) {
 if(!Array.isArray(rows))return {allowed:false};
 const callers=rows.filter(r=>r?.id===caller),owners=rows.filter(r=>r?.id===custodian);
 if(callers.length!==1||owners.length!==1)return {allowed:false};
 const c=callers[0],o=owners[0];
 if(c.role!=='worker'||c.archived!==false||typeof c.state!=='string'||c.state==='stopped'||
    typeof c.ownerId!=='string'||!c.ownerId||c.ownerId!==o.ownerId)return {allowed:false};
 if(c.parentAgentId===custodian)return {allowed:true,kind:'custodian-child'};
 if(typeof c.goalId==='string'&&c.goalId&&c.goalId===o.goalId)return {allowed:true,kind:'custodian-goal'};
 return {allowed:false};
}
export function observeReleaseDelegation(binding,custodian,{deadline,execute=boundedCommand,user=()=>userInfo().username}={}) {
 try {
  const role=user();
  if(!/^[a-z_][a-z0-9_-]{0,31}$/.test(role)||!/^[a-z][a-z0-9-]{0,23}$/.test(binding.channel??'')||!Number.isSafeInteger(deadline))return {allowed:false};
  const remaining=deadline-Date.now();if(remaining<=0)return {allowed:false};
  const result=execute('psql',['-X','-qAt','--no-password','--host',KENAN_PG_SOCKET_DIR,'--username',role,
   '--dbname',channelDatabase(binding.channel),'--set=ON_ERROR_STOP=1','--command',releaseDelegationSql(binding.agentId,custodian)],
   {encoding:'utf8',timeout:Math.min(6000,remaining),maxBuffer:1<<20,env:{...process.env,PGCONNECT_TIMEOUT:'2'}});
  if(result.error||result.signal||result.status!==0)return {allowed:false};
  return classifyReleaseDelegation(JSON.parse(result.stdout),binding.agentId,custodian);
 }catch{return {allowed:false};}
}
