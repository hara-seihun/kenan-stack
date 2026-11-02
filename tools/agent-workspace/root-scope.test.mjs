import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {rootScope} from './root-scope.mjs';
import {procScope,callerToolCall} from './cache-queue.mjs';
const unit='agent-tool-beta-11111111-1111-4111-8111-111111111111.scope',group='/user.slice/user-agents.slice/'+unit,pid=123;
const identity={version:1,channel:'beta',agentId:'owner',callId:'native-call'};
const globalUnit=unit,globalGroup=group,globalIdentity=identity;
function fixture({unit:unitOverride,identity:identityOverride}={}){
 const service=Boolean(unitOverride), unit=unitOverride??globalUnit,group=service?`/user.slice/user-agents.slice/user-agents-kenanbg.slice/${unit}`:globalGroup,identity=identityOverride??globalIdentity;
 const files=new Map([
  ['/run/systemd/transient/'+unit,`# Root systemd transient scope\n[Unit]\nDescription=kenan-tool-call:${JSON.stringify(identity)}\n${service?"": "BindsTo=kenan@beta.service\n"}[${service?"Service":"Scope"}]\nSlice=${service?"user-agents-kenanbg.slice":"user-agents.slice"}\n${service?"User="+identity.uid+"\nExecStart=\nExecStart=/usr/bin/true\n":""}`],
  ['/sys/fs/cgroup'+group+'/cgroup.events','populated 1\nfrozen 0\n'],
  ['/sys/fs/cgroup'+group+'/cgroup.procs',pid+'\n'],
  [`/proc/${pid}/cgroup`,'0::'+group+'\n']
 ]),fds=new Map(),changes=new Map();let next=10,invocations=0;
 const stat=(p,type='file')=>({uid:0,mode:type==='directory'?0o40755:0o100644,dev:1,ino:1,size:files.get(p)?.length??0,mtimeMs:1,ctimeMs:1,isDirectory:()=>type==='directory',isFile:()=>type==='file',isSymbolicLink:()=>type==='link',...changes.get(p)});
 const io={
  realpathSync:p=>p,
  lstatSync:p=>stat(p,p.includes('/invocation:')?'link':files.has(p)?'file':'directory'),
  openSync:(p,flags)=>{assert.ok(flags&fs.constants.O_NOFOLLOW);if(!files.has(p))throw Object.assign(Error('absent'),{code:'ENOENT'});const fd=++next;fds.set(fd,p);return fd;},
  fstatSync:fd=>stat(fds.get(fd)),
  readSync:(fd,buffer)=>buffer.write(files.get(fds.get(fd))),
  closeSync:fd=>fds.delete(fd),
  readFileSync:p=>files.get(p),
  readlinkSync:()=>{invocations++;return 'a'.repeat(32);}
 };
 return {io,files,changes,fds,invocations:()=>invocations,observe:()=>rootScope(pid,group,unit,{io})};
}
test('root transient metadata plus the populated exact kernel scope authenticates without a manager RPC',()=>{
 const f=fixture(),proof=f.observe();assert.equal(proof.kind,'authenticated-kernel-scope');assert.deepEqual(proof.identity,identity);assert.equal(f.fds.size,0);assert.equal(f.invocations(),2);
 const observed=procScope(pid,{read:()=>`0::${group}`,kernel:(p,g,u)=>rootScope(p,g,u,{io:f.io}),query:()=>assert.fail('RPC queue is not an identity prerequisite')});
 assert.equal(observed.callId,identity.callId);
 for(const patch of [{agentId:'not a valid agent'},{version:2},{channel:'production'}])assert.equal(callerToolCall({pid,scope:()=>({...observed,...patch}),parent:()=>9,argv:()=>['node','/srv/kenan/beta/dist/server/main.js'],uid:()=>0}),null);
 assert.equal(callerToolCall({pid,scope:()=>observed,parent:()=>9,argv:()=>['node','/srv/kenan/production/dist/server/main.js'],uid:()=>0}),null,'an authentic beta scope cannot claim a production server');
});
for(const [name,mutate] of [
 ['user-owned description',f=>f.changes.set('/run/systemd/transient/'+unit,{uid:1002})],
 ['writable directory',f=>f.changes.set('/run/systemd/transient',{mode:0o40777})],
 ['symlinked directory',f=>{f.io.realpathSync=()=>'/elsewhere';}],
 ['forged invocation',f=>{f.io.readlinkSync=()=>'/user/forged';}],
 ['root file substitution',f=>{const base=f.io.lstatSync;f.io.lstatSync=p=>({...base(p),...(p==='/run/systemd/transient/'+unit?{ino:9}:{})});}],
 ['empty scope',f=>f.files.set('/sys/fs/cgroup'+group+'/cgroup.events','populated 0\n')],
 ['another process in the scope',f=>f.files.set('/sys/fs/cgroup'+group+'/cgroup.procs','321\n')],
 ['moved caller',f=>f.files.set(`/proc/${pid}/cgroup`,'0::/foreign\n')],
 ['changed invocation',f=>{let n=0;f.io.readlinkSync=()=>++n===1?'a'.repeat(32):'b'.repeat(32);}],
 ['duplicate identity property',f=>f.files.set('/run/systemd/transient/'+unit,f.files.get('/run/systemd/transient/'+unit)+'Description=forged\nDescription=again\n')],
 ['wrong bound channel',f=>f.files.set('/run/systemd/transient/'+unit,f.files.get('/run/systemd/transient/'+unit).replace('BindsTo=kenan@beta','BindsTo=kenan@production'))]
])test('root scope refuses '+name,()=>{const f=fixture();mutate(f);assert.equal(f.observe().kind,'refused');assert.equal(f.fds.size,0);});
test('unsupported service and unavailable root metadata retain the existing manager observation route',()=>{
 const f=fixture();assert.equal(rootScope(pid,group,unit.replace('.scope','.service'),{io:f.io}).kind,'unavailable');
 f.files.delete('/run/systemd/transient/'+unit);assert.equal(f.observe().kind,'unavailable');
 let calls=0;const observed=procScope(pid,{read:()=>`0::${group}`,kernel:()=>f.observe(),query:()=>{calls++;return {status:0,stdout:`Description=kenan-tool-call:${JSON.stringify(identity)}\nControlGroup=${group}\nTransient=yes\nActiveState=active\n`};}});assert.equal(observed.agentId,'owner');assert.equal(calls,1);
});
test('invalid root evidence is refused, never replaced by another observation that grants identity',()=>{assert.equal(procScope(pid,{read:()=>`0::${group}`,kernel:()=>({kind:'refused',code:'untrusted'}),query:()=>assert.fail('no weaker route')}),null);});

const bgAgent='22222222-2222-4222-8222-222222222222',bgUnit=`kenan-bg-${bgAgent}-release.service`,bgGroup=`/user.slice/user-agents.slice/user-agents-kenanbg.slice/${bgUnit}`;
const bgIdentity={...identity,agentId:bgAgent,background:true,uid:1002};
test('background release proves its exact root-created invocation without a blocking manager query',()=>{
 const f=fixture({unit:bgUnit,identity:bgIdentity});
 const observed=procScope(pid,{read:()=>`0::${bgGroup}`,kernel:(p,g,u)=>rootScope(p,g,u,{io:f.io}),query:()=>assert.fail('background release must not need a manager RPC')});
 assert.equal(observed.agentId,bgAgent);
 assert.equal(callerToolCall({pid,scope:()=>observed,uid:()=>1002}).agentId,bgAgent);
 assert.equal(callerToolCall({pid,scope:()=>observed,uid:()=>1003}),null);
});
for(const [name,mutate] of [
 ['foreign owner',f=>f.files.set('/run/systemd/transient/'+bgUnit,f.files.get('/run/systemd/transient/'+bgUnit).replace(bgAgent,'33333333-3333-4333-8333-333333333333'))],
 ['wrong uid',f=>f.files.set('/run/systemd/transient/'+bgUnit,f.files.get('/run/systemd/transient/'+bgUnit).replace('User=1002','User=1003'))],
 ['duplicate uid',f=>f.files.set('/run/systemd/transient/'+bgUnit,f.files.get('/run/systemd/transient/'+bgUnit)+'User=1002\n')],
 ['writable metadata',f=>f.changes.set('/run/systemd/transient/'+bgUnit,{mode:0o100666})],
 ['empty kernel group',f=>f.files.set('/sys/fs/cgroup'+bgGroup+'/cgroup.events','populated 0\n')],
 ['changed invocation',f=>{let n=0;f.io.readlinkSync=()=>++n===1?'a'.repeat(32):'b'.repeat(32);}],
 ['moved process',f=>f.files.set(`/proc/${pid}/cgroup`,'0::/foreign\n')]
])test('background kernel identity refuses '+name,()=>{const f=fixture({unit:bgUnit,identity:bgIdentity});mutate(f);assert.equal(rootScope(pid,bgGroup,bgUnit,{io:f.io}).kind,'refused');});
