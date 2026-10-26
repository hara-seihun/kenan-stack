// A ctime change is not proof of a payload write. Only an identity-bound,
// before/after-stable SHA-256 observation plus an isolated link-count change may
// preserve a previously observed payload timestamp. Unknown evidence stays recent.
import fs from 'node:fs';
import {createHash} from 'node:crypto';
const encode=s=>Object.fromEntries(['dev','ino','birthtimeNs','mtimeNs','ctimeNs','nlink','size','blocks','mode','uid','gid'].map(k=>[k,String(s[k])]));
const same=(a,b,keys=Object.keys(a))=>keys.every(k=>a[k]===b[k]);
const payloadKeys=['dev','ino','birthtimeNs','mtimeNs','size','blocks','mode','uid','gid'];
const valid=r=>r?.version===1&&r.metadata&&/^[a-f0-9]{64}$/.test(r.sha256)&&Number.isSafeInteger(r.lastPayloadWriteAt)&&r.lastPayloadWriteAt>=0;
export function observeInodeContent(file,prior,{deadline=Date.now()+1000}={}) {
 const initial=fs.lstatSync(file,{bigint:true});const raw=Math.ceil(Number(initial.ctimeNs)/1e6);
 if(!initial.isFile())return {lastWriteAt:Math.max(raw,Math.ceil(Number(initial.mtimeNs)/1e6))};
 const metadata=encode(initial);
 // Large payloads remain conservative rather than exhausting every short slice.
 if(initial.size>64n*1024n*1024n)return {lastWriteAt:Math.max(raw,Math.ceil(Number(initial.mtimeNs)/1e6))};
 const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);let sha256;
 try{
  if(!same(metadata,encode(fs.fstatSync(fd,{bigint:true}))))throw Error('content identity changed before hashing');
  const hash=createHash('sha256'),buffer=Buffer.allocUnsafe(128*1024);let n;
  while((n=fs.readSync(fd,buffer,0,buffer.length,null))>0){if(Date.now()>=deadline)throw Object.assign(Error('content proof budget exhausted'),{code:'content-proof-deadline'});hash.update(buffer.subarray(0,n));}
  sha256=hash.digest('hex');
  if(!same(metadata,encode(fs.fstatSync(fd,{bigint:true})))||!same(metadata,encode(fs.lstatSync(file,{bigint:true}))))throw Error('content or link identity changed during hashing');
 }finally{fs.closeSync(fd);}
 if(valid(prior)&&same(metadata,prior.metadata)&&sha256===prior.sha256)return {lastWriteAt:prior.lastPayloadWriteAt,record:prior};
 const linkOnly=valid(prior)&&prior.metadata.nlink!==metadata.nlink&&same(metadata,prior.metadata,payloadKeys)&&sha256===prior.sha256;
 const lastPayloadWriteAt=linkOnly?prior.lastPayloadWriteAt:Math.max(raw,Math.ceil(Number(initial.mtimeNs)/1e6));
 const record={version:1,metadata,sha256,lastPayloadWriteAt,observedAt:Date.now(),
  ...(linkOnly?{linkOnlyProof:{previousMetadata:prior.metadata,previousSha256:prior.sha256,previousObservedAt:prior.observedAt,previousLastPayloadWriteAt:prior.lastPayloadWriteAt}}:{})};
 return {lastWriteAt:lastPayloadWriteAt,record};
}
export function contentObserver(database,{deadline=Date.now()+1000}={}) {
 database.exec('CREATE TABLE IF NOT EXISTS workspace_inode_content(identity TEXT PRIMARY KEY, evidence_json TEXT NOT NULL)');
 const read=database.prepare('SELECT evidence_json FROM workspace_inode_content WHERE identity=?'),write=database.prepare('INSERT OR REPLACE INTO workspace_inode_content VALUES(?,?)');
 const pending=new Map(),baselines=new Map();
 const observe=file=>{
  const s=fs.lstatSync(file,{bigint:true});
  if(!s.isFile())return Math.max(Math.ceil(Number(s.mtimeNs)/1e6),Math.ceil(Number(s.ctimeNs)/1e6));
  // Global inode custody is safe across hardlink paths: birth time and content
  // bind this actual inode, not a pathname. Root/plan binding remains separate.
  const key=`${s.dev}:${s.ino}:${s.birthtimeNs}`;let prior;try{prior=pending.get(key)??JSON.parse(read.get(key)?.evidence_json??'null');}catch{}
  if(!baselines.has(key))baselines.set(key,prior);
  const result=observeInodeContent(file,prior,{deadline});
  if(result.record&&result.record!==prior)pending.set(key,result.record);
  return result.lastWriteAt;
 };
 observe.flush=()=>{
  if(!pending.size)return;
  database.exec('BEGIN IMMEDIATE');
  try{
   for(const [key,record]of pending){
    let latest;try{latest=JSON.parse(read.get(key)?.evidence_json??'null');}catch{}
    // A different checkout may have observed this shared inode since our read.
    // Never overwrite a newer inode census or lower a proved payload timestamp.
    if(JSON.stringify(latest??null)!==JSON.stringify(baselines.get(key)??null))continue;
    const merged=valid(latest)?{...record,lastPayloadWriteAt:Math.max(record.lastPayloadWriteAt,latest.lastPayloadWriteAt)}:record;
    write.run(key,JSON.stringify(merged));
   }
   database.exec('COMMIT');pending.clear();
  }
  catch(error){database.exec('ROLLBACK');throw error;}
 };
 return observe;
}
export function withContentObservation(database,options,run){
 const observe=contentObserver(database,options);
 try{return run(observe);}finally{observe.flush();}
}
