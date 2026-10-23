import fs from 'node:fs';
import path from 'node:path';
import {retireGeneratedOnly,generatedStagingRoots} from './generated-retirement.mjs';
import {digest} from './growth-lifecycle.mjs';

export class CacheRetirementError extends Error {constructor(code,detail){super(detail);this.code=code;}}
const refuse=(code,detail)=>{throw new CacheRetirementError(code,detail);};
const exact=(o,keys)=>o!==null&&typeof o==='object'&&!Array.isArray(o)&&JSON.stringify(Object.keys(o).sort())===JSON.stringify(keys.sort());
const bindingKeys=['id','path','owner','sourceCommit','durableSourceCommit','head','device','inode','updatedAt','leaseExpiresAt'];
export function validateCacheRequest(request){
 if(!exact(request,['kind','operationId','binding','cachePath','classification','ownerEvidence'])||request.kind!=='retire-workspace-cache'||!/^[a-zA-Z0-9_-]{8,80}$/.test(request.operationId)||!exact(request.binding,bindingKeys)||typeof request.ownerEvidence!=='string'||!request.ownerEvidence.trim())refuse('invalid-cache-request','exact bound cache request and owner evidence required');
 if(!['node-dependencies','declared-build-cache'].includes(request.classification))refuse('unclassified-cache','unknown cache class');
 const p=request.cachePath;
 if(typeof p!=='string'||!p||path.isAbsolute(p)||path.posix.normalize(p)!==p||p.includes('\\')||/[?*\[\x00]/.test(p)||p.split('/').some(x=>['.','..','.git','.converge','evidence','receipts','results','logs'].includes(x)))refuse('unclassified-cache','exact unaliased relative generated path required; evidence paths are protected');
 if(!bindingKeys.filter(x=>!['updatedAt','leaseExpiresAt'].includes(x)).every(x=>typeof request.binding[x]==='string'&&request.binding[x])||!Number.isSafeInteger(request.binding.updatedAt)||!Number.isSafeInteger(request.binding.leaseExpiresAt))refuse('invalid-cache-request','complete identity and lifecycle binding required');
 return request;
}
export function cacheGeneratedRequest(request) {
 validateCacheRequest(request);
 return {kind:'retire-generated-only',operationId:'cache-'+request.operationId,ownerEvidence:request.ownerEvidence,binding:Object.fromEntries(['id','path','owner','sourceCommit','durableSourceCommit','head','device','inode'].map(k=>[k,request.binding[k]])),paths:[request.cachePath]};
}
export function cacheStagingRoots(request,stateDirectory) {return generatedStagingRoots(cacheGeneratedRequest(request),stateDirectory);}
export function retireWorkspaceCache(context,request){
 try{
  validateCacheRequest(request);
  const current=()=>{
   const binding=context.binding();
   if(bindingKeys.some(k=>binding[k]!==request.binding[k]))refuse('cache-identity-changed','workspace/source/head/lifecycle binding changed');
   if(binding.leaseExpiresAt>Date.now())refuse('cache-writing-lease','writing lease remains active');
   context.classify(request);
  };
  current();
  const operation='cache-'+request.operationId;
  const inner=cacheGeneratedRequest(request);
  const db=context.database,sha=digest(JSON.stringify(request));
  db.exec('CREATE TABLE IF NOT EXISTS workspace_cache_retirement(operation_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, request_sha256 TEXT NOT NULL, original_json TEXT NOT NULL)');
  const prior=db.prepare('SELECT request_sha256 FROM workspace_cache_retirement WHERE operation_id=?').get(operation);
  if(prior&&prior.request_sha256!==sha)refuse('cache-operation-conflict','operation identity already has different request bytes');
  if(!prior)db.prepare('INSERT INTO workspace_cache_retirement VALUES(?,?,?,?)').run(operation,request.binding.id,sha,JSON.stringify(context.original()));
  db.exec('CREATE TABLE IF NOT EXISTS workspace_cache_retirement_request(operation_id TEXT PRIMARY KEY, request_json TEXT NOT NULL)');
  db.prepare('INSERT OR IGNORE INTO workspace_cache_retirement_request VALUES(?,?)').run(operation,JSON.stringify(request));
  const result=retireGeneratedOnly({...context,journalKind:'workspace-cache-retirement',inventoryPolicy:'unlink-cache-links',binding:()=>{current();return inner.binding;},custody:current,declarations:()=>[request.cachePath],safety:stages=>{
   const safety=context.safety(stages);
   if(!Number.isSafeInteger(safety?.observedAt)||Date.now()-safety.observedAt>60000||safety.observedAt>Date.now())refuse('cache-safety-unknown','fresh complete native and queued-work observation required');
   return safety;
  }},inner);
  if(!result.ok)return result;
  return {ok:true,value:{...result.value,kind:'workspace-cache-retired',sourcePreserved:true,lifecycleAndPlanPreserved:true}};
 }catch(error){return {ok:false,error:{code:error instanceof CacheRetirementError?error.code:'cache-retirement-io-error',detail:String(error.message)}};}
}

const tableExists=(db,name)=>Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
/** Read-only view of cache retirement journals, selected by workspace id or staging directory name. */
export function cacheRetirementStatus(db,selector){
 if(selector.workspaceId===undefined===(selector.stage===undefined))return {ok:false,error:{code:'invalid-cache-request',detail:'exactly one of --id or --stage required'}};
 if(!tableExists(db,'workspace_generated_retirement'))return {ok:true,value:{operations:[]}};
 const cacheRows=tableExists(db,'workspace_cache_retirement'),requestRows=tableExists(db,'workspace_cache_retirement_request');
 const rows=db.prepare("SELECT operation_id,workspace_id,journal_json FROM workspace_generated_retirement WHERE json_extract(journal_json,'$.kind')='workspace-cache-retirement' AND "+(selector.workspaceId!==undefined?'workspace_id=?':"EXISTS(SELECT 1 FROM json_each(journal_json,'$.entries') WHERE json_extract(value,'$.stage') LIKE '%/' || ?)")+' ORDER BY rowid').all(selector.workspaceId??selector.stage);
 const operations=rows.map(row=>{
  const journal=JSON.parse(row.journal_json),operation=row.operation_id;
  const requestSha256=cacheRows?db.prepare('SELECT request_sha256 FROM workspace_cache_retirement WHERE operation_id=?').get(operation)?.request_sha256??null:null;
  const stored=requestRows?db.prepare('SELECT request_json FROM workspace_cache_retirement_request WHERE operation_id=?').get(operation)?.request_json??null:null;
  const entries=journal.entries.map(e=>({relative:e.relative,stage:e.stage,phase:e.phase,stagePresent:fs.existsSync(e.stage),inventoryEntries:e.files.length,allocatedBytes:e.allocatedBytes,freedBytesSoFar:(e.freed?.measuredBytes??0)+(e.freed?.estimatedBytes??0)}));
  const resume=journal.state==='pending'?{command:`agent-workspace retire-cache --id ${journal.request.binding.id} --path ${journal.request.binding.path} --owner ${journal.request.binding.owner} --request REQUEST_FILE --request-sha256 ${requestSha256} --json`,requestFile:stored===null?'the original request file (its bytes must hash to requestSha256)':'write storedRequest byte-exactly to an absolute single-link file outside the workspace'}:null;
  return {operationId:operation,workspaceId:row.workspace_id,owner:journal.request.binding.owner,path:journal.request.binding.path,requestSha256,state:journal.state,entries,result:journal.result??null,resume,storedRequest:stored};
 });
 return {ok:true,value:{operations}};
}
