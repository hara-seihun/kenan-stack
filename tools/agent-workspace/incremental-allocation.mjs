// A resumable allocated-block census. Only a finished walk becomes an allocation
// sample; partial totals never reduce a reservation. Each slice advances durable
// traversal state, so a large tree cannot exhaust every fleet pass from its root.
import fs from 'node:fs';
import path from 'node:path';
export function allocationSlice(root,device,prior,{deadline=Date.now()+1000,maxEntries=200000,excludedPaths=[],observeContent}={}) {
 const stat=fs.lstatSync(root),inode=String(stat.ino);
 if(!stat.isDirectory()||String(stat.dev)!==device)throw Error('workspace root changed filesystem or type');
 let state=prior;
 if(!state||state.version!==3||state.root!==root||state.inode!==inode||state.device!==device||JSON.stringify(state.excludedPaths)!==JSON.stringify(excludedPaths))state={version:3,writeObservationComplete:true,lastWriteAt:0,root,device,inode,excludedPaths,startedAt:Date.now(),pending:[root],seen:[],bytes:0,allocatedBytes:0,entries:0};
 const seen=new Set(state.seen),excluded=new Set(excludedPaths);let visited=0;
 while(state.pending.length && visited<maxEntries && Date.now()<deadline){
  const file=state.pending.pop();visited++;
  if(excluded.has(file))continue;
  let s;try{s=fs.lstatSync(file);}catch(error){if(error.code==='ENOENT')continue;throw error;}
  if(String(s.dev)!==device)continue;
  const key=`${s.dev}:${s.ino}`;if(seen.has(key))continue;let writeAt;
  try{writeAt=observeContent?observeContent(file):Math.max(Math.ceil(s.mtimeMs),Math.ceil(s.ctimeMs));}
  catch(error){if(error.code==='content-proof-deadline'){state.pending.push(file);break;}throw error;}
  seen.add(key);state.entries++;
  if(state.entries>2000000)throw Error('allocated-block traversal entry bound exceeded');
  state.lastWriteAt=Math.max(state.lastWriteAt,writeAt);
  const bytes=s.blocks*512;if(!Number.isSafeInteger(bytes)||bytes<0)throw Error('invalid allocated blocks');
  state.allocatedBytes+=bytes;if(s.isDirectory()||s.nlink===1)state.bytes+=bytes;
  if(!Number.isSafeInteger(state.allocatedBytes))throw Error('allocation total exceeds supported range');
  if(s.isDirectory()){
   const dir=fs.opendirSync(file);try{let e;while((e=dir.readSync())!==null){state.pending.push(path.join(file,e.name));if(state.pending.length>2000000)throw Error('allocated-block pending entry bound exceeded');}}finally{dir.closeSync();}
  }
 }
 const after=fs.lstatSync(root);if(String(after.ino)!==inode||String(after.dev)!==device)throw Error('workspace root changed during measurement');
 state.writeObservationComplete=state.writeObservationComplete!==false&&observeContent?.complete!==false;
 state.seen=[...seen];
 if(state.pending.length)return {partial:true,state,visited};
 return {ok:true,writeObservationComplete:state.writeObservationComplete,lastWriteAt:state.lastWriteAt,bytes:state.bytes,allocatedBytes:state.allocatedBytes,device,inode,startedAt:state.startedAt,completedAt:Date.now(),visited};
}
