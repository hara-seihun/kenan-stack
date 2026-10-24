// Ephemeral execution capacity lives in workspace_capacity, not a Git workspace or a second ledger.
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {GrowthLifecycleError} from './growth-lifecycle.mjs';
const error=(code,detail)=>{throw new GrowthLifecycleError(code,code+': '+detail);};
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const boot=()=>fs.readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim();
export function executionHolder(pid) {
 if(!Number.isSafeInteger(pid)||pid<1)error('execution-holder-unknown','positive holder PID required');
 const read=()=>fs.readFileSync(`/proc/${pid}/stat`,'utf8').split(')').slice(1).join(')').trim().split(/\s+/)[19];
 const startTime=read(), cgroups=fs.readFileSync(`/proc/${pid}/cgroup`,'utf8');
 const cgroup=cgroups.split('\n').find(line=>line.startsWith('0::'))?.slice(3);
 if(!cgroup||!cgroup.startsWith('/')||cgroup.split('/').includes('..')||!cgroup.split('/').some(part=>part.endsWith('.service')||part.endsWith('.scope'))||read()!==startTime)error('execution-holder-unknown','stable native service cgroup required');
 return {pid,startTime,bootId:boot(),cgroup,uid:fs.statSync(`/proc/${pid}`).uid};
}
// Trusted observer. Unknown/inaccessible process or cgroup state is never cessation.
export function executionCessation(holder) {
 if(process.getuid?.()!==0)error('execution-cessation-unknown','root observer required');
 if(holder.bootId!==boot())error('execution-cessation-unknown','boot changed; retain original reservation for explicit recovery');
 if(typeof holder.cgroup!=='string'||!holder.cgroup.startsWith('/')||holder.cgroup.split('/').includes('..')||!holder.cgroup.split('/').some(p=>p.endsWith('.service')||p.endsWith('.scope')))error('execution-cessation-unknown','invalid holder binding');
 const members=[];const deadline=Date.now()+5000;
 for(const name of fs.readdirSync('/proc')) {
  if(!/^\d+$/.test(name))continue;
  if(Date.now()>deadline)error('execution-cessation-unknown','process census deadline');
  try{const group=fs.readFileSync(`/proc/${name}/cgroup`,'utf8').split('\n').find(x=>x.startsWith('0::'))?.slice(3);if(group===holder.cgroup||group?.startsWith(holder.cgroup+'/'))members.push(Number(name));}
  catch(e){if(!['ENOENT','ESRCH'].includes(e.code))error('execution-cessation-unknown','incomplete process census');}
 }
 if(members.length)error('execution-holder-live','original native cgroup remains populated');
 const root='/sys/fs/cgroup'+holder.cgroup;
 try{const pending=[root];let count=0;while(pending.length){const current=pending.pop();if(++count>4096||Date.now()>deadline)error('execution-cessation-unknown','cgroup census deadline');const events=fs.readFileSync(path.join(current,'cgroup.events'),'utf8');if(!/^populated 0$/m.test(events)||fs.readFileSync(path.join(current,'cgroup.procs'),'utf8').trim())error('execution-holder-live','native cgroup remains populated');for(const e of fs.readdirSync(current,{withFileTypes:true}))if(e.isDirectory())pending.push(path.join(current,e.name));}}
 catch(e){if(e.code!=='ENOENT')throw e;/* removed cgroup + complete /proc census is cessation */}
 const unit=holder.cgroup.split('/').filter(part=>part.endsWith('.service')||part.endsWith('.scope')).at(-1);
 if(!Number.isSafeInteger(holder.uid)||holder.uid<0)error('execution-cessation-unknown','holder UID missing');
 const user=holder.cgroup.includes('/user.slice/');
 const command=user?'runuser':'systemctl';
 const account=spawnSync('getent',['passwd',String(holder.uid)],{encoding:'utf8',timeout:1000}).stdout?.split(':')[0];
 if(user&&!account)error('execution-cessation-unknown','holder account unavailable');
 const commandArgs=user?['-u',account,'--','env',`XDG_RUNTIME_DIR=/run/user/${holder.uid}`,'systemctl','--user','show',unit,'--property=LoadState,ActiveState,SubState,MainPID,ControlPID']:['show',unit,'--property=LoadState,ActiveState,SubState,MainPID,ControlPID'];
 const result=spawnSync(command,commandArgs,{encoding:'utf8',timeout:3000});
 if(result.error||(![0,1].includes(result.status)))error('execution-cessation-unknown','native holder terminal state unavailable');
 const native=Object.fromEntries(result.stdout.trim().split('\n').map(line=>line.split('=')));
 if(!['inactive','failed'].includes(native.ActiveState)||Number(native.MainPID||0)!==0||Number(native.ControlPID||0)!==0||!['loaded','not-found'].includes(native.LoadState))error('execution-cessation-unknown','holder unit not terminal; auto-restart or activation may retain liability');
 return {complete:true,members:[],bootId:holder.bootId,cgroup:holder.cgroup,nativeUnit:{unit,...native},observedAt:Date.now()};
}
export function executionRows(database,device) {
 return database.prepare("SELECT workspace_id,plan_json FROM workspace_capacity WHERE device_id=? AND workspace_id LIKE 'execution:%'").all(device).map(row=>{const plan=JSON.parse(row.plan_json);if(plan.kind!=='execution-capacity'||!['reserved','released'].includes(plan.state)||!Number.isSafeInteger(plan.growthBytes)||plan.growthBytes<0||!Number.isSafeInteger(plan.headroomBytes)||plan.headroomBytes<8*1024**3)error('execution-plan-invalid','invalid execution liability');return plan;});
}
export function executionCommand({database,args,command,statePath,lock,reservations,requirement,observe}) {
 const get=name=>{const v=args.get(name);if(!Array.isArray(v)||v.length!==1||!v[0])error('execution-invalid-request',`one --${name} required`);return v[0];};
 const allowed=command==='execution-reserve'?['root','owner','operation-id','growth-mib','headroom-gib','holder-pid','json']:['id','owner','expected-plan-sha256','json'];
 for(const key of args.keys())if(!allowed.includes(key))error('execution-invalid-request','unexpected --'+key);
 const id=command==='execution-reserve'?'execution:'+get('operation-id'):get('id');
 if(!/^execution:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id))error('execution-invalid-request','UUID operation identity required');
 const load=()=>{const row=database.prepare('SELECT device_id,plan_json FROM workspace_capacity WHERE workspace_id=?').get(id);return row?{device:row.device_id,plan:JSON.parse(row.plan_json)}:null;};
 const original=load();
 if(command==='execution-status'){if(!original)error('execution-not-found','no original reservation');return {ok:true,...original.plan};}
 if(command==='execution-reserve') {
  const root=get('root');if(!path.isAbsolute(root)||path.resolve(root)!==root)error('execution-invalid-request','canonical absolute root required');
  const growthBytes=Number(get('growth-mib'))*1024**2,headroomBytes=Number(get('headroom-gib'))*1024**3;
  if(!Number.isSafeInteger(growthBytes)||growthBytes<=0||!Number.isSafeInteger(headroomBytes)||headroomBytes<8*1024**3)error('execution-budget-unknown','explicit positive operator growth budget and >=8GiB headroom required');
  const request={id,owner:get('owner'),root,growthBytes,headroomBytes,holderPid:Number(get('holder-pid'))};
  const requestSha256=hash(request);
  if(original){if(original.plan.requestSha256!==requestSha256)error('execution-operation-conflict','original operation parameters differ');return {ok:true,...original.plan};}
  const stat=fs.lstatSync(root);if(!stat.isDirectory()||stat.uid!==process.getuid()||fs.realpathSync(root)!==root||fs.readdirSync(root).length)error('execution-root-unsafe','empty owned nonsymlink root required before any producer starts');
  const device=String(stat.dev),holder=executionHolder(request.holderPid);
  return lock(device,()=>{
   const prior=load();if(prior){if(prior.plan.requestSha256!==requestSha256)error('execution-operation-conflict','concurrent operation conflict');return {ok:true,...prior.plan};}
   const current=fs.lstatSync(root);if(current.dev!==stat.dev||current.ino!==stat.ino||fs.readdirSync(root).length||JSON.stringify(executionHolder(request.holderPid))!==JSON.stringify(holder))error('execution-root-unsafe','root or holder changed during admission');
   const others=reservations(device),stats=fs.statfsSync(root),freeBytes=stats.bavail*stats.bsize;
   const requiredBytes=requirement({intent:'budgeted',constructionBytes:0,growthBytes,headroomBytes},others.priced,others.headroomBytes);
   if(freeBytes<requiredBytes)error('execution-capacity-insufficient',JSON.stringify({device,freeBytes,requiredBytes,otherReservationsBytes:others.priced.reduce((a,b)=>a+b,0)}));
   const binding={...request,device,inode:String(stat.ino),holder,requestSha256,estimate:'operator-budget',measuredPeakBytes:null};
   const plan={kind:'execution-capacity',...binding,planSha256:hash(binding),state:'reserved',admission:{freeBytes,requiredBytes,observedAt:Date.now()}};
   database.prepare('INSERT INTO workspace_capacity(workspace_id,device_id,plan_json) VALUES(?,?,?)').run(id,device,JSON.stringify(plan));
   return {ok:true,...plan};
  });
 }
 if(!original)error('execution-not-found','no original reservation');
 return lock(original.device,()=>{
  const plan=load().plan;
  if(plan.owner!==get('owner')||plan.planSha256!==get('expected-plan-sha256'))error('execution-stale-binding','owner/plan does not match');
  if(plan.state==='released')return {ok:true,...plan};
  try{fs.lstatSync(plan.root);error('execution-root-retained','remove owned state after producer cessation before releasing capacity');}catch(e){if(e.code!=='ENOENT')throw e;}
  const cessation=observe(plan.holder);
  if(cessation.complete!==true||cessation.members.length||cessation.cgroup!==plan.holder.cgroup||cessation.bootId!==plan.holder.bootId)error('execution-cessation-unknown','trusted observer returned incomplete binding');
  try{fs.lstatSync(plan.root);error('execution-root-retained','state root reappeared during cessation observation');}catch(e){if(e.code!=='ENOENT')throw e;}
  const next={...plan,state:'released',cessation,releasedAt:Date.now()};
  database.prepare('UPDATE workspace_capacity SET plan_json=? WHERE workspace_id=?').run(JSON.stringify(next),id);
  return {ok:true,...next};
 });
}
