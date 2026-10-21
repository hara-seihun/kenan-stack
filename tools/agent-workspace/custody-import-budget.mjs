// Read-only prerequisite. No forecast is ledger credit, and no import starts on unknown input.
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
export class CustodyImportError extends Error {
  constructor(reason, details={}) {super(`CUSTODY_IMPORT_EXCEEDS_RECLAIM: ${reason}`);this.code='CUSTODY_IMPORT_EXCEEDS_RECLAIM';this.reason=reason;this.details=details;}
}
const refuse=(reason,details)=>{throw new CustodyImportError(reason,details)};
export function qualifyCustodyImport(values) {
  const {exclusiveAllocatedBytes,importBytes,peakBytes,freeBytes,protectedBytes}=values;
  if(Object.values({exclusiveAllocatedBytes,importBytes,peakBytes,freeBytes,protectedBytes}).some(x=>!Number.isSafeInteger(x)||x<0))refuse('UNMEASURED_OR_INVALID_ALLOCATION');
  if(peakBytes<importBytes)refuse('INVALID_IMPORT_PEAK');
  if(freeBytes-peakBytes<protectedBytes)refuse('INSUFFICIENT_PROTECTED_HEADROOM',values);
  if(exclusiveAllocatedBytes<=importBytes)refuse('NONPOSITIVE_PHYSICAL_RECLAIM',values);
  return {...values,qualifiedNetUpperBoundBytes:exclusiveAllocatedBytes-importBytes,actualPhysicalCreditBytes:0,requiresAfterMeasurement:true};
}
export function exclusiveAllocatedBytes(root) {
  const device=fs.lstatSync(root).dev;let total=0,entries=0;const seen=new Set(),deadline=Date.now()+2000;
  function visit(file) {
    if(++entries>50000||Date.now()>deadline)refuse('ALLOCATION_MEASUREMENT_BOUNDED');
    const s=fs.lstatSync(file);if(s.dev!==device)refuse('CROSS_DEVICE_ALLOCATION');
    if(s.isSymbolicLink())return;
    if(s.isDirectory()){for(const name of fs.readdirSync(file))visit(path.join(file,name));return;}
    if(!s.isFile())refuse('UNKNOWN_ALLOCATION_ENTRY');
    if(s.nlink!==1)return;const id=`${s.dev}:${s.ino}`;if(seen.has(id))return;seen.add(id);
    total+=s.blocks*512;if(!Number.isSafeInteger(total))refuse('ALLOCATION_OVERFLOW');
  }
  visit(root);return total;
}
function git(args,input,env={}) {
  const result=spawnSync('git',args,{encoding:'utf8',input,timeout:2000,maxBuffer:64*1024*1024,env:{...process.env,GIT_NO_LAZY_FETCH:'1',GIT_NO_REPLACE_OBJECTS:'1',GIT_OPTIONAL_LOCKS:'0',...env}});
  if(result.status!==0||result.error)refuse('OBJECT_CUSTODY_UNMEASURED');
  return result.stdout.trim();
}
export function measureCustodyImport(workspace,mirror,{protectedBytes=8*1024**3}={}) {
  try {
    if(fs.existsSync(path.join(mirror,'objects/info/alternates')))refuse('MIRROR_NOT_INDEPENDENT');
    // Enumerate exactly the ancestry potentially fetched by the existing HEAD/ref/reflog import.
    const roots=[git(['-C',workspace,'rev-parse','--verify','HEAD']),...git(['-C',workspace,'for-each-ref','--format=%(objectname)']).split('\n'),...git(['-C',workspace,'reflog','--all','--format=%H']).split('\n')].filter(Boolean);
    const objects=[...new Set(git(['-C',workspace,'rev-list','--objects','--no-object-names','--stdin'],roots.join('\n')+'\n').split('\n').filter(Boolean))];
    if(!objects.length||objects.some(x=>!/^([a-f0-9]{40}|[a-f0-9]{64})$/.test(x)))refuse('INVALID_OBJECT_CLOSURE');
    const sizes=git(['-C',workspace,'cat-file','--batch-check=%(objectname) %(objecttype) %(objectsize)'],objects.join('\n')+'\n').split('\n');
    const owned=fs.existsSync(mirror)?git(['--git-dir',mirror,'cat-file','--batch-check=%(objectname) %(objecttype) %(objectsize)'],objects.join('\n')+'\n',{GIT_ALTERNATE_OBJECT_DIRECTORIES:'',GIT_OBJECT_DIRECTORY:path.join(mirror,'objects')} ).split('\n'):objects.map(x=>`${x} missing`);
    if(sizes.length!==objects.length||owned.length!==objects.length)refuse('INCOMPLETE_OBJECT_MEASUREMENT');
    let missingBytes=0,missingObjects=0;
    for(let i=0;i<objects.length;i++) {
      const match=sizes[i].match(/^([a-f0-9]+) (blob|tree|commit|tag) ([0-9]+)$/);
      if(!match||match[1]!==objects[i]||!Number.isSafeInteger(Number(match[3])))refuse('SOURCE_OBJECT_UNAVAILABLE');
      if(owned[i]===`${objects[i]} missing`){missingObjects++;missingBytes+=Number(match[3])+4096;}
      else if(owned[i]!==sizes[i])refuse('MIRROR_OBJECT_MEASUREMENT_MISMATCH');
    }
    // Loose/header/index/pack slack, then simultaneous incoming pack + durable output.
    const importBytes=missingObjects?2*missingBytes+1024*1024:0,peakBytes=2*importBytes;
    const stat=fs.statfsSync(workspace);const freeBytes=stat.bavail*stat.bsize;
    // Only tracked materialization is guaranteed to leave with the checkout. Ignored
    // caches, detached outputs, private evidence and shared Git storage earn no forecast.
    const tracked=git(['-C',workspace,'ls-files','-z']).split('\0').filter(Boolean);let reclaim=0;
    if(tracked.length>50000)refuse('ALLOCATION_MEASUREMENT_BOUNDED');
    for(const name of new Set(tracked)){
      if(path.isAbsolute(name)||name.split('/').includes('..'))refuse('INVALID_TRACKED_PATH');
      const f=path.join(workspace,name);if(!fs.existsSync(f))continue;const s=fs.lstatSync(f);
      if(s.isSymbolicLink())continue;
      const relative=path.relative(fs.realpathSync(workspace),fs.realpathSync(f));
      if(relative.startsWith('..')||path.isAbsolute(relative))refuse('TRACKED_PATH_ESCAPES_WORKSPACE');
      if(s.dev!==fs.statSync(workspace).dev)refuse('CROSS_DEVICE_ALLOCATION');
      if(s.isFile()&&s.nlink===1)reclaim+=s.blocks*512;
    }
    return {...qualifyCustodyImport({exclusiveAllocatedBytes:reclaim,importBytes,peakBytes,freeBytes,protectedBytes}),missingObjects,objects:objects.length};
  }catch(error){if(error instanceof CustodyImportError)throw error;refuse('MEASUREMENT_FAILED',{cause:error.code??error.name});}
}
export function guardedCustodyImport(workspace,mirror,prepare,options) {
  const proof=measureCustodyImport(workspace,mirror,options);prepare();return proof;
}
