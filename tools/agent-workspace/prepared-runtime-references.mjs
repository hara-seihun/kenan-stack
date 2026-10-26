// Read-only custody for prepared Original40 host configurations and explicit publisher adoptions.
// Process termination, archived source writers and file age never surrender prepared source.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';

export const DEFAULT_PREPARED_ROOT='/home/kenan/data/omni-loop-9681';
const RELEASE_ROOT='/home/kenan/data/converge-releases';
const SHA=/^[a-f0-9]{64}$/;
const absolute=value=>typeof value==='string'&&path.isAbsolute(value)&&path.normalize(value)===value&&value!=='/';
const overlaps=(a,b)=>a===b||a.startsWith(b+'/')||b.startsWith(a+'/');
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');

export function preparedRuntimeReferences(roots=null,options={}){
 const dataRoot=options.dataRoot??RELEASE_ROOT;
 const preparedRoot=options.preparedRuntimeRoot??(dataRoot===RELEASE_ROOT?DEFAULT_PREPARED_ROOT:path.join(dataRoot,'prepared-runtime'));
 const helperRoot=options.publisherHelperRoot??path.join(dataRoot,'p226','helper-custody');
 // These are actual publisher custody records, not status snapshots or a recursive evidence scan.
 // New publishers can add explicit records to publisher-custody instead of expanding discovery.
 const adoptionFiles=options.publisherAdoptionFiles??[
  path.join(dataRoot,'C497-CUSTODY-ADOPTION-A7.json'),
  path.join(dataRoot,'P226-COMPARISON-SOURCE-RESTORE.json'),
 ];
 const adoptionDir=options.publisherAdoptionDir??path.join(dataRoot,'publisher-custody');
 const limit={entries:1024,fileBytes:4*1024**2,totalBytes:32*1024**2,...options.preparedRuntimeLimits};
 const errors=[],references=[],released=[],observations=[];
 let total=0,entries=0;
 const deadline=options.deadline??Date.now()+5000;
 const check=()=>{if(Date.now()>=deadline)throw Error('prepared runtime census deadline exhausted');};
 const read=file=>{
  check();let stat;try{stat=fs.lstatSync(file);}catch(error){if(error.code==='ENOENT')return null;throw error;}
  if(!stat.isFile()||stat.size>limit.fileBytes)throw Error(file+': expected a bounded regular JSON file');
  total+=stat.size;if(total>limit.totalBytes)throw Error('prepared runtime census total byte bound exceeded');
  const bytes=fs.readFileSync(file);if(bytes.length>limit.fileBytes)throw Error(file+': file grew beyond byte bound');
  return {value:JSON.parse(bytes.toString('utf8')),sha256:hash(bytes)};
 };
 const listing=directory=>{
  check();let handle;try{handle=fs.opendirSync(directory);}catch(error){if(error.code==='ENOENT')return [];throw error;}
  const result=[];
  try{for(let entry;(entry=handle.readSync())!==null;){check();if(++entries>limit.entries)throw Error('prepared runtime census entry bound exceeded');result.push(entry);}}
  finally{handle.closeSync();}
  return result.sort((a,b)=>a.name.localeCompare(b.name));
 };
 const allPaths=value=>{
  const result=[];let visited=0;
  const walk=(v,depth)=>{
   check();if(++visited>4096||depth>20)throw Error('prepared runtime reference structure bound exceeded');
   if(typeof v==='string'&&v.startsWith('/')){if(!absolute(v))throw Error('prepared runtime reference is not an exact absolute path');result.push(v);}
   else if(Array.isArray(v))v.forEach(x=>walk(x,depth+1));
   else if(object(v))Object.values(v).forEach(x=>walk(x,depth+1));
  };walk(value,0);return [...new Set(result)].sort();
 };
 const disposition=(file,source,paths,kind)=>{
  const terminal=read(file+'.disposition.json');if(!terminal)return false;
  const v=terminal.value;
  if(!object(v)||v.version!==1||v.kind!==kind||v.sourcePath!==file||v.sourceSha256!==source.sha256||!['disposed','handed-over'].includes(v.disposition)||typeof v.owner!=='string'||!v.owner.trim()||typeof v.reason!=='string'||!v.reason.trim()||!Array.isArray(v.paths)||JSON.stringify([...v.paths].sort())!==JSON.stringify(paths))throw Error(file+': terminal custody disposition does not bind the exact source and paths');
  if(v.disposition==='handed-over'){
   if(!object(v.successor)||!absolute(v.successor.path)||!SHA.test(v.successor.sha256)||v.successor.path===file)throw Error(file+': exact successor custody required for handover');
   if(fs.existsSync(v.successor.path+'.disposition.json'))throw Error(file+': successor already carries a terminal disposition');
   const next=read(v.successor.path);if(!next||next.sha256!==v.successor.sha256)throw Error(file+': successor custody is absent or changed');
   // The destination must be another owning canonical record, not an arbitrary receipt or log.
   const successorConfig=path.dirname(path.dirname(v.successor.path))===preparedRoot&&path.basename(v.successor.path)==='CONFIG.json';
   const successorAdoption=adoptionFiles.includes(v.successor.path)||path.dirname(v.successor.path)===adoptionDir;
   if(kind==='prepared-runtime-disposition'?!successorConfig:!successorAdoption)throw Error(file+': handover successor is outside the owning custody records');
   if(kind==='prepared-runtime-disposition'&&!absolute(next.value?.candidateRoot))throw Error(file+': successor has no candidate root');
  }
  released.push({kind,id:file,paths,state:v.disposition,evidence:file+'.disposition.json'});return true;
 };
 const config=file=>{
  const record=read(file);if(!record)throw Error(file+': prepared configuration missing');
  const v=record.value;
  if(!object(v)||!absolute(v.candidateRoot)||typeof v.receiptId!=='string'||!v.receiptId||!absolute(v.runDirectory))throw Error(file+': prepared configuration lacks exact candidateRoot, receiptId or runDirectory');
  const paths=allPaths(v);
  if(disposition(file,record,paths,'prepared-runtime-disposition'))return;
  const claim=read(path.join(v.runDirectory,'HOST-CLAIM.json'));
  if(claim&&(claim.value?.configPath!==file||claim.value?.configSha256!==record.sha256))throw Error(file+': host claim contradicts the configuration identity');
  references.push({kind:'prepared_runtime_config',id:v.receiptId,state:claim?'claimed-unreleased':'prepared',resourceClass:'qualification-request',targetPath:v.candidateRoot,paths,configPath:file,configSha256:record.sha256});
 };
 const adoption=file=>{
  const record=read(file);if(!record)return;
  const v=record.value;if(!object(v))throw Error(file+': publisher adoption is not an object');
  // The restore request itself is an explicit publisher adoption of this exact destination.
  let paths;
  if(file.endsWith('/P226-COMPARISON-SOURCE-RESTORE.json')){
   if(!absolute(v.path)||typeof v.id!=='string'||typeof v.jobId!=='string')throw Error(file+': invalid publisher restore custody');
   paths=[v.path];
  }else{
   if(v.kind!=='operator-source-artifact-custody-adoption'||typeof v.operator!=='string'||!v.operator||!object(v.record)||!Array.isArray(v.record.records)||!v.record.records.length)throw Error(file+': invalid explicit publisher adoption');
   if(!v.record.records.every(r=>absolute(r.path)))throw Error(file+': adopted workspace has no exact path');
   // Registry root and historical pricing.measurementFailures are metadata, not borrowed source.
   paths=[...new Set([...v.record.records.map(r=>r.path),...allPaths(Object.fromEntries(Object.entries(v).filter(([key])=>['handoffPath','helperRoot','currentToolingDonor','toolingDonor','dependencies'].includes(key))))])].sort();
  }
  if(disposition(file,record,paths,'publisher-custody-disposition'))return;
  references.push({kind:'publisher_custody',id:file,state:'adopted-unreleased',resourceClass:'qualification-request',targetPath:paths[0],paths,sourceSha256:record.sha256});
 };
 try{
  if(roots!==null&&(!Array.isArray(roots)||roots.some(r=>!absolute(r))))throw Error('exact absolute reference roots required');
  const configs=[];
  for(const entry of listing(preparedRoot)){
   if(entry.isSymbolicLink())throw Error(path.join(preparedRoot,entry.name)+': symbolic link in owning preparation root');
   if(entry.isDirectory()&&entry.name.startsWith('host-preparation-')){
    const file=path.join(preparedRoot,entry.name,'CONFIG.json');configs.push(file);
   }
  }
  const pointer=path.join(preparedRoot,'CURRENT-HOST-CONFIG-PATH');
  if(fs.existsSync(pointer)){
   const stat=fs.lstatSync(pointer);if(!stat.isFile()||stat.size>4096)throw Error(pointer+': invalid current configuration pointer');
   const current=fs.readFileSync(pointer,'utf8').trim();
   if(!absolute(current)||path.basename(current)!=='CONFIG.json'||path.dirname(path.dirname(current))!==preparedRoot)throw Error(pointer+': current configuration is outside the canonical preparation root');
   if(!configs.includes(current))configs.push(current);
  }
  for(const file of configs)config(file);
  for(const file of adoptionFiles)adoption(file);
  for(const entry of listing(adoptionDir)){
   if(entry.isSymbolicLink())throw Error(path.join(adoptionDir,entry.name)+': symbolic link in publisher custody');
   if(!entry.isFile()||!entry.name.endsWith('.json')||entry.name.endsWith('.disposition.json'))continue;
   adoption(path.join(adoptionDir,entry.name));
  }
  if(fs.existsSync(helperRoot))references.push({kind:'publisher_helper_custody',id:helperRoot,state:'canonical-tooling-source',resourceClass:'qualification-request',targetPath:helperRoot,paths:[helperRoot]});
  observations.push({source:'prepared-runtime-and-publisher-custody',configs:configs.length,records:references.length,released:released.length,entries,bytes:total});
 }catch(error){errors.push(String(error.message));}
 return {errors,references:roots===null?references:Array.isArray(roots)&&roots.every(absolute)?references.filter(r=>r.paths.some(p=>roots.some(root=>overlaps(p,root)))):[],released,observations,complete:errors.length===0,observedAt:Date.now()};
}

// The qualification owner calls this wrapper on every return, including not-installed paths.
export function withPreparedRuntimeReferences(result,roots=null,options={}){
 const prepared=preparedRuntimeReferences(roots,options);
 const errors=[...(result.errors??[]),...prepared.errors];
 return {...result,errors,references:[...(result.references??[]),...prepared.references],released:[...(result.released??[]),...prepared.released],observations:[...(result.observations??[]),...prepared.observations],complete:result.complete!==false&&errors.length===0};
}
