import path from 'node:path';
import {homedir} from 'node:os';
import {createHash} from 'node:crypto';
import {boundedCommand} from './bounded-command.mjs';
import {authorizeWorkspaceRelease} from './release-authority.mjs';
import {nativeOwnerBinding,admissionReceipts,bindNativeOwner} from './native-owner.mjs';
const refused=(code,detail)=>({ok:false,error:{code,detail}});
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');

// Explicit local custody recovery, never an application gate or proof of settled effects.
// Terminal Actions prevents future writes by that exact attempt. Ordinary release still
// independently checks source durability and every process, runtime and prepared consumer.
export function adoptEndedActions(database,record,statePath,input,{execute=boundedCommand,authority,head,branch}={}){
 const self=authorizeWorkspaceRelease(database,[],statePath,authority);
 if(!self.ok)return self;
 if(self.kind!=='native')return refused('actions-adoption-native-required','An exact authenticated native tool call is required.');
 const {repository,run,attempt,sourceCommit}=input;
 if(repository!=='owi-link/converge'||!/^\d{1,16}$/.test(run??'')||!/^\d{1,6}$/.test(attempt??'')||!/^([1-9]\d*)$/.test(run)||!/^([1-9]\d*)$/.test(attempt)||!/^[a-f0-9]{40}$/.test(sourceCommit??''))return refused('actions-adoption-request-invalid','The Converge repository, positive run and attempt, and exact Git source are required.');
 if(record.owner!==`actions-deploy-${run}`||record.repository!==`https://github.com/${repository}`||path.basename(record.path)!==`actions-deploy-${run}-${attempt}`||record.mode!=='writer'||record.groupId!==null||!['active','referenced','blocked','repair-required'].includes(record.state))return refused('actions-adoption-custody-mismatch','This record does not belong to the exact Converge Actions deployment attempt.');
 if(nativeOwnerBinding(database,record.id).state!=='unset')return refused('actions-adoption-already-bound','An existing native custodian must perform any transfer.');
 const bytes=database.prepare('SELECT creation_request FROM workspace WHERE id=?').get(record.id)?.creation_request;
 let request;try{request=JSON.parse(bytes);}catch{return refused('actions-adoption-request-invalid','The original creation request is unreadable.');}
 const expectedBranch=`agent/actions-deploy-${run}-${attempt}`;
 if(record.sourceCommit!==sourceCommit||record.durableSourceCommit!==sourceCommit||head!==sourceCommit||branch!==expectedBranch||request?.ref!==sourceCommit||request?.owner!==record.owner||request?.branch!==expectedBranch||!/^\/home\/kenan\/actions-runner[-a-z0-9]*\/_work\/converge\/converge$/.test(request?.repository??''))return refused('actions-adoption-source-mismatch','The original runner request, registered source, current HEAD and branch must agree.');
 const receipt=admissionReceipts(statePath,record.id,bytes);
 if(receipt.kind!=='none')return refused('actions-adoption-native-receipt','A native or malformed caller receipt cannot be overridden by Actions adoption.');
 let result;
 try{result=execute('/usr/local/bin/gh',['api','--hostname','github.com',`repos/${repository}/actions/runs/${run}/attempts/${attempt}`],{encoding:'utf8',timeout:10000,maxBuffer:1048576,env:{HOME:homedir(),PATH:'/usr/local/bin:/usr/bin:/bin',GH_HOST:'github.com',GH_PROMPT_DISABLED:'1'}});}catch{return refused('actions-adoption-observation-failed','The authenticated GitHub observation failed.');}
 if(result.status!==0||result.error)return refused('actions-adoption-observation-failed','The authenticated GitHub observation failed.');
 let actual;try{actual=JSON.parse(result.stdout);}catch{return refused('actions-adoption-observation-invalid','The GitHub response is not valid JSON.');}
 if(String(actual?.id)!==run||String(actual?.run_attempt)!==attempt||actual?.repository?.full_name!==repository||actual?.head_repository?.full_name!==repository||actual?.head_sha!==sourceCommit||actual?.path!=='.github/workflows/deploy.yml')return refused('actions-adoption-observation-mismatch','The GitHub run identity, repository, workflow and source must match the original request.');
 if(actual.status!=='completed'||!['success','failure','cancelled','timed_out','action_required','neutral','skipped','stale','startup_failure'].includes(actual.conclusion))return refused('actions-adoption-run-active','The exact Actions attempt has not reached a terminal conclusion.');
 const evidence={command:'adopt-ended-actions',workspaceId:record.id,repository,run,attempt,sourceCommit,creationRequestSha256:sha(bytes),githubResponseSha256:sha(result.stdout),status:actual.status,conclusion:actual.conclusion,observedAt:Date.now(),effectsSettlement:'not implied; ordinary release checks remain mandatory'};
 bindNativeOwner(database,record.id,self.binding,'caller-scope',evidence);
 return {ok:true,recordId:record.id,custodian:nativeOwnerBinding(database,record.id),evidence,leaseUnchanged:true,sourceUnchanged:true,next:'Ordinary release revalidates source and unresolved runtime references. No application or provider effect was performed.'};
}
