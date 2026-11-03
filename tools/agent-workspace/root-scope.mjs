import fs from 'node:fs';

const native=/^agent-tool-[a-z][a-z0-9-]*-[a-f0-9-]{36}\.scope$/;
const background=/^kenan-bg-([a-f0-9-]{36}|manager:[a-z][a-z0-9-]{0,63})-[-A-Za-z0-9._]{1,60}\.service$/;
const same=(a,b)=>a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mtimeMs===b.mtimeMs&&a.ctimeMs===b.ctimeMs;

// A populated kernel scope and systemd's root-owned transient description are
// independent of the manager RPC queue. No argv, environment or writable file
// supplies identity. Background services use the same root and kernel proof.
export function rootScope(pid,group,unit,{io=fs}={}){
 const service=background.exec(unit);
 if(!Number.isSafeInteger(pid)||pid<=1||(!native.test(unit)&&!service)||group!==(service?`/user.slice/user-agents.slice/user-agents-kenanbg.slice/${unit}`:`/user.slice/user-agents.slice/${unit}`))return {kind:'unavailable'};
 const trusted=p=>{
  if(io.realpathSync(p)!==p)throw Error('scope-proof-symlink');
  const s=io.lstatSync(p);
  if(s.uid!==0||(s.mode&0o022)!==0||!s.isDirectory())throw Error('scope-proof-untrusted-directory');
 };
 const read=p=>{
  const fd=io.openSync(p,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
  try{
   const before=io.fstatSync(fd);
   if(before.uid!==0||(before.mode&0o022)!==0||!before.isFile())throw Error('scope-proof-untrusted-file');
   const buffer=Buffer.alloc(16385),n=io.readSync(fd,buffer,0,buffer.length,0);
   if(n===buffer.length||!same(before,io.fstatSync(fd))||!same(before,io.lstatSync(p)))throw Error('scope-proof-changed-file');
   return buffer.subarray(0,n).toString('utf8');
  }finally{io.closeSync(fd);}
 };
 try{
  for(const p of ['/run','/run/systemd','/run/systemd/transient','/run/systemd/units','/sys','/sys/fs','/sys/fs/cgroup','/sys/fs/cgroup/user.slice','/sys/fs/cgroup/user.slice/user-agents.slice',...(service?['/sys/fs/cgroup/user.slice/user-agents.slice/user-agents-kenanbg.slice']:[]),'/sys/fs/cgroup'+group])trusted(p);
  const invocation=()=>{
   const p='/run/systemd/units/invocation:'+unit,s=io.lstatSync(p);
   if(s.uid!==0||!s.isSymbolicLink())throw Error('scope-proof-untrusted-invocation');
   const id=io.readlinkSync(p);if(!/^[a-f0-9]{32}$/.test(id))throw Error('scope-proof-invalid-invocation');
   return id;
  };
  const id=invocation(),body=read('/run/systemd/transient/'+unit);
  const sections=new Map();let section;
  for(const line of body.split('\n')){
   if(!line||line.startsWith('#'))continue;
   if(/^\[[A-Za-z]+\]$/.test(line)){section=line.slice(1,-1);if(sections.has(section))throw Error('scope-proof-duplicate-section');sections.set(section,new Map());continue;}
   const at=line.indexOf('=');if(!section||at<1||/\r|\x00/.test(line)||line.endsWith('\\'))throw Error('scope-proof-invalid-unit');
   const entries=sections.get(section),key=line.slice(0,at);if(entries.has(key)&&(!service||['Description','Slice','User','BindsTo'].includes(key)))throw Error('scope-proof-duplicate-property');entries.set(key,line.slice(at+1));
  }
  const description=sections.get('Unit')?.get('Description');
  if(!description?.startsWith('kenan-tool-call:')||sections.get(service?'Service':'Scope')?.get('Slice')!==(service?'user-agents-kenanbg.slice':'user-agents.slice'))throw Error('scope-proof-invalid-description');
  const identity=JSON.parse(description.slice('kenan-tool-call:'.length));
  if(service){
   if(identity.background!==true||identity.agentId!==service[1]||!Number.isSafeInteger(identity.uid)||identity.uid<=0||sections.get('Service')?.get('User')!==String(identity.uid)||!/^[a-z][a-z0-9-]{0,23}$/.test(identity.channel??''))throw Error('scope-proof-background-mismatch');
  }else if(typeof identity.channel!=='string'||!unit.startsWith(`agent-tool-${identity.channel}-`)||(sections.get('Unit')?.has('BindsTo')&&sections.get('Unit').get('BindsTo')!==`kenan@${identity.channel}.service`))throw Error('scope-proof-channel-mismatch');
  const kernel='/sys/fs/cgroup'+group;
  if(!/^populated 1$/m.test(read(kernel+'/cgroup.events'))||!read(kernel+'/cgroup.procs').split('\n').includes(String(pid)))throw Error('scope-proof-caller-not-populated');
  if(!io.readFileSync(`/proc/${pid}/cgroup`,'utf8').trim().split('\n').includes('0::'+group)||invocation()!==id)throw Error('scope-proof-caller-moved');
  return {kind:'authenticated-kernel-scope',identity,invocationId:id};
 }catch(error){return error.code==='ENOENT'||error.code==='EACCES'?{kind:'unavailable'}:{kind:'refused',code:error.message};}
}
