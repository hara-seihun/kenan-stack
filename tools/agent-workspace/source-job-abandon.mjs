// Explicit terminal abandonment; never resumes a worker or settles its historical effects.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {callerToolCall,channelDatabase,KENAN_PG_SOCKET_DIR} from './cache-queue.mjs';
import {boundedCommand} from './bounded-command.mjs';
export const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
export function refuse(code,message){throw Object.assign(new Error(message),{code});}
export function readPermit(jobId) {
 if(!/^[a-f0-9]{64}$/.test(jobId))refuse('abandon-invalid-job','full job identity required');
 const file='/etc/pi-stack/source-job-abandon/'+jobId+'.json';
 // Never accept caller-controlled paths, symlinks, group-writable ancestors or hard links.
 for(const dir of ['/etc','/etc/pi-stack','/etc/pi-stack/source-job-abandon']){
  const s=fs.lstatSync(dir);if(!s.isDirectory()||s.uid!==0||(s.mode&0o022))refuse('abandon-permit-unsafe','unsafe permit directory');
 }
 const s=fs.lstatSync(file);if(!s.isFile()||s.uid!==0||(s.mode&0o777)!==0o600||s.nlink!==1||s.size>16384)refuse('abandon-permit-unsafe','root-owned mode600 single-link finite permit required');
 const bytes=fs.readFileSync(file);return {permit:JSON.parse(bytes),permitSha256:sha(bytes)};
}
const literal=s=>"'"+s.replaceAll("'","''")+"'";
export function authenticatedAbandonCaller(permit,{caller=callerToolCall,execute=boundedCommand}={}) {
 const self=caller();if(!self||self.channel!==permit.channel)refuse('abandon-caller-unknown','native server ancestor required');
 const match=self.args.map(arg=>`strpos(p->'args'->>'command',${literal(arg)})>0`).join(' AND ');
 const sql=`BEGIN READ ONLY; SET LOCAL statement_timeout='3000ms'; SELECT coalesce(json_agg(r),'[]'::json) FROM (SELECT DISTINCT a.id,a.goal_id,a.role,a.state,a.archived FROM message m JOIN agent a ON a.conversation_id=m.conversation_id WHERE m.role='tool' AND m.state='streaming' AND EXISTS(SELECT 1 FROM jsonb_array_elements(m.parts) p WHERE p->>'type'='tool' AND p->>'name'='bash' AND strpos(p->'args'->>'command','agent-workspace')>0 AND ${match}))r; ROLLBACK;`;
 const r=execute('psql',['-X','-qAt','--no-password','--host',KENAN_PG_SOCKET_DIR,'--dbname',channelDatabase(self.channel),'--set=ON_ERROR_STOP=1','--command',sql],{timeout:4000,maxBuffer:65536,env:{...process.env,PGCONNECT_TIMEOUT:'2'}});
 if(r.status!==0||r.error)refuse('abandon-caller-unknown','authenticated native caller read failed');
 const rows=JSON.parse(r.stdout);
 if(rows.length!==1||rows[0].id!==permit.agentId||rows[0].goal_id!==permit.goalId||rows[0].role!=='worker'||rows[0].state!=='running'||rows[0].archived)refuse('abandon-foreign-owner','exact current native applying owner required');
 return {channel:self.channel,agentId:rows[0].id,goalId:rows[0].goal_id};
}
export function validateAbandonPermit(permit,{jobId,requestSha256,attemptSha256,request,record,transfer,head,unit,caller}) {
 if(permit.kind!=='source-job-abandon-permit-v1'||permit.jobId!==jobId||permit.outcome!=='ABANDONED'||permit.historicalEffects!=='UNKNOWN_RETAINED'||permit.automaticRetry!==false)refuse('abandon-invalid-permit','finite abandonment-only permit required');
 if(permit.requestSha256!==requestSha256||permit.attemptSha256!==attemptSha256||permit.unit!==unit)refuse('abandon-request-changed','original request/attempt bytes changed');
 const owners=request.args?.filter(([key])=>key==='owner');
 if(owners?.length!==1||owners[0][1]?.length!==1||owners[0][1][0]!==permit.originalOwner||request.destination!==permit.path)refuse('abandon-request-changed','original request owner/destination changed');
 if(!record||record.id!==permit.workspaceId||record.path!==permit.path||record.owner!==permit.owner||record.leaseExpiresAt!==0||!['referenced','repair-required','blocked','active'].includes(record.state)||record.capacity?.growthLifecycle?.kind!=='retired-future-growth')refuse('abandon-custody-changed','exact retained retired owner custody required');
 if(permit.originalOwner!==permit.owner&&(!transfer||transfer.sequence!==permit.adoptionSequence||transfer.workspace_id!==record.id||transfer.path!==record.path||transfer.old_owner!==permit.originalOwner||transfer.new_owner!==permit.owner||!transfer.authorization))refuse('abandon-foreign-owner','supported exact owner adoption required');
 if(head!==permit.head||caller.agentId!==permit.agentId||caller.goalId!==permit.goalId)refuse('abandon-ref-changed','HEAD or authenticated custody changed');
 if(!permit.priorTerminalEvidence?.sha256||permit.priorTerminalEvidence.activeState!=='inactive'||permit.priorTerminalEvidence.mainPid!==0||permit.priorTerminalEvidence.controlGroup!=='')refuse('abandon-cessation-unknown','retained prior terminal custody required');
 return true;
}
// root-only helper: all-UID cgroup census, not systemctl's missing-unit defaults.
export function sourceJobCgroupSnapshot(unit) {
 if(process.getuid?.()!==0)refuse('abandon-cessation-unknown','privileged cgroup census required');
 if(!/^pi-workspace-source-[a-f0-9]{16}-[a-f0-9]{64}-a[1-9][0-9]*\.service$/.test(unit))refuse('abandon-unit-unknown','invalid original unit');
 const members=[];
 for(const name of fs.readdirSync('/proc')){
  if(!/^\d+$/.test(name))continue;
  try {const groups=fs.readFileSync('/proc/'+name+'/cgroup','utf8');if(groups.split(/[\/\n]/).includes(unit))members.push(Number(name));}
  catch(e){if(!['ENOENT','ESRCH'].includes(e.code))refuse('abandon-cessation-unknown','incomplete all-UID cgroup census');}
 }
 const groups=[],pending=['/sys/fs/cgroup'];let count=0;const deadline=Date.now()+5000;
 while(pending.length){
  const current=pending.pop();if(++count>16384||Date.now()>deadline)refuse('abandon-cessation-unknown','cgroup census budget exhausted');
  for(const entry of fs.readdirSync(current,{withFileTypes:true})){
   if(!entry.isDirectory())continue;const full=path.join(current,entry.name);pending.push(full);
   if(entry.name===unit){
    const events=fs.readFileSync(path.join(full,'cgroup.events'),'utf8'),procs=fs.readFileSync(path.join(full,'cgroup.procs'),'utf8').trim();
    if(!/^populated 0$/m.test(events)||procs)refuse('abandon-live-cgroup','original cgroup has holders');
    groups.push({path:full,events,procs});
   }
  }
 }
 return {unit,members,groups,observedAt:Date.now(),complete:true};
}
