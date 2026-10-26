import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {boundedCommand} from './bounded-command.mjs';
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
export class SourceHandoffError extends Error {constructor(code,message){super(message);this.code=code;}}
const refuse=(code,message)=>{throw new SourceHandoffError(code,message);};
function git(repository,args){
 const result=boundedCommand('git',['-C',repository,...args],{encoding:'utf8',timeout:15000,maxBuffer:32*1024*1024,env:{...process.env,GIT_TERMINAL_PROMPT:'0'}});
 if(result.status!==0||result.error||result.signal)refuse('handoff-git-unavailable','source handoff could not establish fresh Git evidence');
 return result.stdout;
}
// Observe ignored roots without walking dependency trees. Only the owning workspace's
// established generated-output policy can exclude bytes from a source handoff.
function sourceStatus(record){
 const entries=git(record.path,['status','--porcelain=v1','-z','--untracked-files=normal','--ignored=matching']).split('\0').filter(Boolean);
 if(entries.some(entry=>!entry.startsWith('!! ')))refuse('handoff-dirty-source','handoff requires clean tracked source and no untracked files');
 const paths=entries.map(entry=>entry.slice(3).replace(/\/$/,'' )).sort();
 const declared=record.cachePaths??[];
 const matches=(candidate,policy)=>{
  if(policy.startsWith('**/'))return candidate.split('/').includes(policy.slice(3));
  return candidate===policy||candidate.startsWith(policy+'/');
 };
 if(paths.some(candidate=>!declared.some(policy=>matches(candidate,policy))))refuse('handoff-unclassified-ignored','ignored output is not declared dependency or build custody');
 return paths;
}
function publish(file,bytes){
 fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
 if(fs.existsSync(file)){if(!fs.readFileSync(file).equals(bytes))refuse('handoff-artifact-conflict','existing handoff artifact differs');return;}
 const temporary=file+'.'+process.pid+'.tmp';let fd;
 try{fd=fs.openSync(temporary,'wx',0o600);fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;
 // Atomic no-overwrite publication; a crash cannot expose a partial receipt.
 try{fs.linkSync(temporary,file);}catch(error){if(error.code!=='EEXIST')throw error;if(!fs.readFileSync(file).equals(bytes))refuse('handoff-artifact-conflict','concurrent receipt differs');}
 const directory=fs.openSync(path.dirname(file),'r');try{fs.fsyncSync(directory);}finally{fs.closeSync(directory);}
 }finally{if(fd!==undefined)fs.closeSync(fd);fs.rmSync(temporary,{force:true});}
}
export function sourceHandoff(record,request,statePath,workspacePaths=[record.path]){
 if(record.id!==request.id||record.path!==request.path||record.owner!==request.owner||record.state==='released')refuse('handoff-stale-custody','workspace identity, owner or custody changed');
 if(!/^[a-f0-9]{40,64}$/.test(request.head)||!request.recipient?.trim()||request.recipient===request.owner)refuse('handoff-invalid-request','handoff requires an exact commit and a distinct recipient');
 if(!request.remote||request.remote.startsWith('-')||!request.branch||request.branch.startsWith('-'))refuse('handoff-invalid-request','handoff requires a configured remote and branch');
 const check=git(record.path,['check-ref-format','refs/heads/'+request.branch]);
 if(check.trim())refuse('handoff-invalid-request','invalid handoff branch');
 const remotes=git(record.path,['remote']).trim().split('\n');
 if(!remotes.includes(request.remote))refuse('handoff-invalid-request','handoff remote must already be configured');
 if(git(record.path,['rev-parse','HEAD']).trim()!==request.head)refuse('handoff-stale-head','checkout HEAD changed');
 const dependencyPaths=sourceStatus(record);
 const under=(candidate,root)=>candidate===root||candidate.startsWith(root+path.sep);
 if(workspacePaths.some(root=>under(path.resolve(path.dirname(statePath)),root)))refuse('handoff-artifact-disposable','receipt storage must be outside all managed checkouts');
 const remoteUrl=git(record.path,['remote','get-url',request.remote]).trim();
 let localRemote=null;
 if(remoteUrl.startsWith('file://'))localRemote=new URL(remoteUrl).pathname;
 else if(!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(remoteUrl)&&!/^([^/]+@)?[^/:]+:/.test(remoteUrl))localRemote=path.resolve(record.path,remoteUrl);
 if(localRemote&&workspacePaths.some(root=>under(fs.realpathSync(localRemote),root)))refuse('handoff-source-disposable','a remote inside a managed checkout is not durable custody');
 const ref='refs/heads/'+request.branch,advertised=git(record.path,['ls-remote','--heads',request.remote,ref]).trim();
 if(advertised!==request.head+'\t'+ref)refuse('handoff-source-not-pushed','the exact branch tip is not present on the configured remote');
 // Store a durable locator, not a credential-bearing URL. The recipient uses its
 // own authorized repository route. Git tree identities bind all path bytes.
 const tree=git(record.path,['rev-parse',request.head+'^{tree}']).trim();
 const manifest=Buffer.from(git(record.path,['-c','core.quotePath=true','ls-tree','-r','--full-tree',request.head]),'utf8');
 if(git(record.path,['rev-parse','HEAD']).trim()!==request.head||JSON.stringify(sourceStatus(record))!==JSON.stringify(dependencyPaths))refuse('handoff-source-changed','source or dependency custody changed during handoff');
 const identity=digest(JSON.stringify({id:record.id,head:request.head,remote:request.remote,branch:request.branch,recipient:request.recipient}));
 const directory=path.join(path.dirname(statePath),'source-handoffs',record.id,identity);
 const manifestPath=path.join(directory,'git-tree.txt');
 const receipt={schemaVersion:1,kind:'durable-pushed-source-handoff',workspaceId:record.id,ownerAtHandoff:record.owner,recipient:request.recipient,source:{remote:request.remote,branch:request.branch,commit:request.head,tree},manifest:{path:manifestPath,sha256:digest(manifest),format:'git-ls-tree-r with core.quotePath=true; Git object identities, not SHA-256 file-byte hashes'},...(dependencyPaths.length?{dependencyCustody:{paths:dependencyPaths,disposition:'retained-in-child-checkout',transferred:false,nextAction:'The recipient regenerates dependencies in its own checkout. Existing workspace release and cache retirement policy owns later cleanup; this handoff deletes nothing.'}}:{}),checkoutCustodyTransferred:false,checkoutMayDisappearAfterArchive:true,nextAction:'Create a separately admitted recipient checkout from the pushed branch at the exact commit. The child checkout is disposable; this receipt grants no writing lease.'};
 const bytes=Buffer.from(JSON.stringify(receipt,null,2)+'\n'),receiptPath=path.join(directory,'receipt.json');
 publish(manifestPath,manifest);publish(receiptPath,bytes);
 return {ok:true,...receipt,artifact:{path:receiptPath,sha256:digest(bytes)}};
}
