// Explicit archives cover vanished review refs without blessing arbitrary local commits.
import {createHash} from 'node:crypto';
import {writeFileSync,mkdirSync,mkdtempSync,rmSync,realpathSync,renameSync,openSync,closeSync,readSync,fstatSync,fsyncSync} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {hasUncoveredCommits} from './release-reachability.mjs';
const schema='agent-workspace.bundle-retention.v1';
const maxBytes=64*1024*1024;
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
function archive(bundle,workspace) {
 const file=realpathSync(bundle),root=realpathSync(workspace);
 if(file===root||file.startsWith(root+path.sep))throw new Error('bundle must be retained outside the checkout');
 // Bound both memory and reads even if an archive grows during observation.
 const fd=openSync(file,'r');let bytes;
 try {
  const size=fstatSync(fd).size;
  if(size>maxBytes)throw new Error('bundle exceeds the 64 MiB retention limit');
  const buffer=Buffer.alloc(size+1);let count=0;
  while(count<buffer.length){const n=readSync(fd,buffer,count,buffer.length-count,null);if(!n)break;count+=n;}
  if(count!==size)throw new Error('bundle changed size during observation');
  bytes=buffer.subarray(0,count);
  fsyncSync(fd);
 }finally{closeSync(fd);}
 const end=bytes.indexOf('\n\n');
 if(end<0)throw new Error('invalid bundle header');
 const header=bytes.subarray(0,end).toString('utf8').split('\n');
 if(!['# v2 git bundle','# v3 git bundle'].includes(header.shift()))throw new Error('unsupported bundle version');
 const prerequisites=[],heads=[];
 for(const line of header) {
  if(line.startsWith('@'))continue;
  const match=/^(-?)([a-f0-9]{40,64}) (.+)$/u.exec(line);
  if(!match)throw new Error('invalid bundle reference');
  (match[1]?prerequisites:heads).push(match[2]);
 }
 if(!heads.length)throw new Error('bundle has no retained tips');
 return {file,bytes,pack:bytes.subarray(end+2),sha256:hash(bytes),prerequisites,heads};
}
export function recordBundleRetention({git,run,workspace,commonDir,owner,workspaceId,bundle,durable}) {
 const a=archive(bundle,workspace);
 if(a.prerequisites.length&&hasUncoveredCommits(git,a.prerequisites,durable))throw new Error('bundle prerequisites are not independently durable');
 git(['bundle','verify',a.file]);
 const temp=mkdtempSync(path.join(tmpdir(),'workspace-bundle-'));
 try {
  run(['init','--bare',temp]);
  const objects=git(['rev-parse','--path-format=absolute','--git-path','objects']);
  writeFileSync(path.join(temp,'objects/info/alternates'),objects+'\n');
  const indexed=run(['-C',temp,'index-pack','--strict','--fix-thin','--stdin'],{input:a.pack});
  const pack=/^(?:pack\s+)?([a-f0-9]{40,64})$/u.exec(indexed);
  if(!pack)throw new Error('invalid indexed bundle pack');
  const listing=run(['verify-pack','-v',path.join(temp,'objects/pack',`pack-${pack[1]}.idx`)]);
  const packed=new Set(listing.split('\n').map(line=>/^([a-f0-9]{40,64}) /u.exec(line)?.[1]).filter(Boolean));
  const required=git(['rev-list','--objects','--no-object-names','--stdin'],{
   input:[...a.heads,...a.prerequisites.map(tip=>'^'+tip)].join('\n')+'\n'}).split('\n').filter(Boolean);
  if(required.some(object=>!packed.has(object)))throw new Error('bundle omits objects required by its advertised tips');
 }finally{rmSync(temp,{recursive:true,force:true});}
 const receipt={schema,workspaceId,owner,bundle:a.file,sha256:a.sha256,heads:a.heads,prerequisites:a.prerequisites,recordedAt:Date.now()};
 const directory=path.join(commonDir,'agent-workspace-bundle-retention');mkdirSync(directory,{recursive:true});
 const file=path.join(directory,a.sha256+'.json'),temporary=file+'.'+process.pid+'.tmp';
 writeFileSync(temporary,JSON.stringify(receipt,null,2)+'\n',{mode:0o600});
 const fd=openSync(temporary,'r');try{fsyncSync(fd);}finally{closeSync(fd);}
 renameSync(temporary,file);
 const dir=openSync(directory,'r');try{fsyncSync(dir);}finally{closeSync(dir);}
 return {receipt:file,...receipt};
}
export function retainedBundleTips({git,workspace,commonDir,durable,receipts}) {
 const tips=[];
 for(const receipt of receipts)try {
  if(receipt.schema!==schema)continue;
  const a=archive(receipt.bundle,workspace);
  if(a.sha256!==receipt.sha256)continue;
  if(a.prerequisites.length&&hasUncoveredCommits(git,a.prerequisites,durable))continue;
  git(['bundle','verify',a.file]);
  tips.push(...a.heads);
 }catch{/* Missing, changed or no longer recoverable archives cover nothing. */}
 return tips;
}
