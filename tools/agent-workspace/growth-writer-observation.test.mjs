import assert from 'node:assert/strict';
import {test} from 'node:test';
import {spawn} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,symlinkSync,rmSync,chmodSync,openSync,closeSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {observeGrowthWriters,parseFdFlags,parseStartIdentity,resolveUnitPids} from './growth-writer-observation.mjs';
import {validateRetirement} from './growth-lifecycle.mjs';

const stat=start=>`1 (we ird) name) S 0 0 0 0 0 0 0 0 0 0 0 0 0 0 20 0 1 0 ${start} 0 0`;
function fixture(){
 const dir=mkdtempSync(path.join(tmpdir(),'gwo-'));const proc=path.join(dir,'proc');mkdirSync(proc);
 const root=path.join(dir,'checkout');mkdirSync(root);
 const addPid=(pid,{start='100',fds=[],cwd,exe,cmdline})=>{
  const p=path.join(proc,String(pid));mkdirSync(path.join(p,'fd'),{recursive:true});mkdirSync(path.join(p,'fdinfo'));
  writeFileSync(path.join(p,'stat'),stat(start));
  for(const [fd,target,flags] of fds){symlinkSync(target,path.join(p,'fd',String(fd)));if(flags!==undefined)writeFileSync(path.join(p,'fdinfo',String(fd)),`pos:\t0\nflags:\t${flags}\nmnt_id:\t1\n`);}
  if(cwd)symlinkSync(cwd,path.join(p,'cwd'));if(exe)symlinkSync(exe,path.join(p,'exe'));
  if(cmdline)writeFileSync(path.join(p,'cmdline'),cmdline.join('\0')+'\0');
  return p;};
 return {dir,proc,root:realpathSync(root),addPid,clean:()=>rmSync(dir,{recursive:true,force:true})};
}
test('parsers handle comm with parentheses and malformed flags',()=>{
 assert.equal(parseStartIdentity(stat('777')),'777');assert.equal(parseStartIdentity('garbage'),null);
 assert.equal(parseFdFlags('flags:\t02100002\n'),0o2100002);assert.equal(parseFdFlags('flags:\tzz\n'),null);assert.equal(parseFdFlags(''),null);
});
test('synthetic proc: read-only fd, cwd, exe and parent directory are not writers; write fds are',()=>{
 const f=fixture();try{
  f.addPid(10,{fds:[[3,`${f.root}/a.txt`,'0100000'],[4,f.root,'0200000'],[5,'/elsewhere/x','0100002']],cwd:f.root,exe:`${f.root}/bin/tool`,cmdline:['node',`${f.root}/x.js`]});
  f.addPid(11,{fds:[[3,`${f.root}/out.log`,'0100001']]});
  f.addPid(12,{fds:[[3,`${f.root}/db (deleted)`,'0100002']]});
  const ro=observeGrowthWriters({roots:[f.root],pids:[10],procRoot:f.proc});
  assert.equal(ro.complete,true);assert.deepEqual(ro.errors,[]);
  assert.ok(ro.references.length>=4);assert.ok(ro.references.every(r=>r.access==='read-only'));
  for(const pid of [11,12]){const w=observeGrowthWriters({roots:[f.root],procRoot:f.proc});
   assert.ok(w.references.some(r=>r.pid===pid&&r.access==='write'));}
  const all=observeGrowthWriters({roots:[f.root],procRoot:f.proc});
  assert.deepEqual(all.observedPids,[10,11,12]);
 }finally{f.clean();}
});
test('synthetic proc: malformed flags stay unknown (a vanished fdinfo means the fd closed)',()=>{
 const f=fixture();try{
  const p=f.addPid(20,{fds:[[3,`${f.root}/a`,'bogus'],[4,`${f.root}/b`]]});
  const r=observeGrowthWriters({roots:[f.root],procRoot:f.proc});
  assert.equal(r.complete,false);assert.equal(r.errors.length,1);assert.ok(r.references.every(x=>x.access==='unknown'));
  assert.throws(()=>validateRetirement(disp(),binding,{references:[],errors:[],growthWriters:r}),{code:'growth-writer-unknown'});
 }finally{f.clean();}
});
test('synthetic proc: permission error is unknown, not read-only',(t)=>{
 if(process.getuid()===0)return t.skip('root ignores directory modes');
 const f=fixture();try{
  const p=f.addPid(30,{fds:[[3,`${f.root}/a`,'0100000']]});chmodSync(path.join(p,'fd'),0o000);
  const r=observeGrowthWriters({roots:[f.root],procRoot:f.proc});
  assert.equal(r.complete,false);assert.match(r.errors.join(),/pid 30 fd list EACCES/);
  chmodSync(path.join(p,'fd'),0o700);
 }finally{f.clean();}
});
test('changed pid identity during scan stays unknown',()=>{
 const f=fixture();try{
  f.addPid(40,{fds:[[3,`${f.root}/a`,'0100000']]});
  let calls=0;
  const fs=awaitFs();
  const wrapped={...fs,readFileSync:(p,...a)=>{if(String(p).endsWith('/40/stat')){calls++;if(calls===2)return stat('999');}return fs.readFileSync(p,...a);}};
  const r=observeGrowthWriters({roots:[f.root],procRoot:f.proc,io:wrapped});
  assert.equal(r.complete,false);assert.match(r.errors.join(),/identity changed/);assert.ok(r.references.every(x=>x.access==='unknown'));
 }finally{f.clean();}
});
import * as realFs from 'node:fs';
function awaitFs(){return {readdirSync:realFs.readdirSync,readlinkSync:realFs.readlinkSync,readFileSync:realFs.readFileSync,realpathSync:realFs.realpathSync};}
test('vanished process is not an error and exited writers are not active',()=>{
 const f=fixture();try{
  const r=observeGrowthWriters({roots:[f.root],pids:[424242],procRoot:f.proc});
  assert.equal(r.complete,true);assert.deepEqual(r.references,[]);
 }finally{f.clean();}
});
test('bounds are enforced and reported as incomplete',()=>{
 const f=fixture();try{
  f.addPid(50,{fds:[[3,`${f.root}/a`,'0100000'],[4,`${f.root}/b`,'0100000'],[5,`${f.root}/c`,'0100000']]});
  const r=observeGrowthWriters({roots:[f.root],procRoot:f.proc,bounds:{maxFdsPerPid:2}});
  assert.equal(r.complete,false);assert.match(r.errors.join(),/fd bound/);
  assert.equal(observeGrowthWriters({roots:[],procRoot:f.proc}).complete,false);
 }finally{f.clean();}
});
test('unit resolution: resolved units add their pids; an unknown unit is unknown without failing others',()=>{
 const f=fixture();try{
  f.addPid(60,{fds:[[3,`${f.root}/w`,'0100001']]});
  const resolveUnit=u=>u==='a.service'?{id:u,state:'resolved',pids:[60]}:{id:u,state:'unknown',pids:[],error:'unit not found'};
  const r=observeGrowthWriters({roots:[f.root],pids:[],units:['a.service','b.service'],procRoot:f.proc,resolveUnit});
  assert.ok(r.references.some(x=>x.pid===60&&x.access==='write'));assert.match(r.errors.join(),/unit b.service unknown/);
  const u=resolveUnitPids('x.service',{systemctl:()=>({LoadState:'loaded',ActiveState:'active',MainPID:'7',ControlGroup:'/system.slice/x'}),io:{readFileSync:()=> '7\n8\nnot\n'}});
  assert.deepEqual(u,{id:'x.service',state:'resolved',pids:[7,8]});
  assert.equal(resolveUnitPids('y',{systemctl:()=>{throw Object.assign(new Error('x'),{code:'exit1'})}}).state,'unknown');
  assert.equal(resolveUnitPids('y',{systemctl:()=>({LoadState:'not-found'})}).state,'unknown');
 }finally{f.clean();}
});
const binding={borrowersSha256:'f'.repeat(64),id:'id',path:'/source',owner:'o',sourceCommit:'a'.repeat(40),durableSourceCommit:'b'.repeat(40),head:'c'.repeat(40),state:'referenced',updatedAt:1,leaseExpiresAt:0,device:'1',inode:'2',planSha256:'d'.repeat(64),sampleSha256:'e'.repeat(64)};
const disp=()=>({kind:'retire-future-growth',retainedUse:'source',remainingGrowthBytes:0,growthWriters:'none',writingLease:'retire',reason:'done',ownerEvidence:'owner receipt',observedAt:Date.now(),binding:{...binding}});
test('actual child: read-only fd allows retirement, writable fd refuses, close allows again',async()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'gwo-real-'));const root=realpathSync(dir);const file=path.join(root,'f.txt');writeFileSync(file,'x');
 const script=`const fs=require('fs');const fd=fs.openSync(process.argv[1],process.argv[2]);process.stdout.write('ready\\n');process.stdin.on('data',()=>{});process.stdin.on('end',()=>process.exit(0));`;
 const run=async mode=>{const c=spawn(process.execPath,['-e',script,file,mode],{stdio:['pipe','pipe','inherit']});
  await new Promise(r=>c.stdout.once('data',r));return c;};
 try{
  const ro=await run('r');
  const a=observeGrowthWriters({roots:[root],pids:[ro.pid]});
  assert.equal(a.complete,true);assert.ok(a.references.some(r=>r.kind==='fd'&&r.access==='read-only'));
  assert.doesNotThrow(()=>validateRetirement(disp(),binding,{references:[{pid:ro.pid,root}],errors:[],growthWriters:a}));
  assert.throws(()=>validateRetirement(disp(),binding,{references:[{pid:ro.pid,root}],errors:[]}),{code:'growth-writer-active'});
  ro.stdin.end();
  const rw=await run('r+');
  const b=observeGrowthWriters({roots:[root],pids:[rw.pid]});
  assert.ok(b.references.some(r=>r.kind==='fd'&&r.access==='write'));
  assert.throws(()=>validateRetirement(disp(),binding,{references:[],errors:[],growthWriters:b}),{code:'growth-writer-active'});
  rw.stdin.end();
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('validateRetirement: absent proof keeps conservative refs; uncovered refs and incomplete proofs are refused',()=>{
 const ok={complete:true,references:[{pid:1,access:'read-only',kind:'cwd'}],errors:[],units:[{id:'u.service',state:'resolved',pids:[]}],observedPids:[1]};
 assert.doesNotThrow(()=>validateRetirement(disp(),binding,{references:[{pid:1},{id:'u.service'}],errors:[],growthWriters:ok}));
 assert.throws(()=>validateRetirement(disp(),binding,{references:[{pid:1}],errors:[]}),{code:'growth-writer-active'});
 assert.throws(()=>validateRetirement(disp(),binding,{references:[{pid:2}],errors:[],growthWriters:ok}),{code:'growth-writer-active'});
 assert.throws(()=>validateRetirement(disp(),binding,{references:[{id:'z.service'}],errors:[],growthWriters:ok}),{code:'growth-writer-active'});
 assert.throws(()=>validateRetirement(disp(),binding,{references:[{kind:'thread'}],errors:[],growthWriters:ok}),{code:'growth-writer-active'});
 assert.throws(()=>validateRetirement(disp(),binding,{references:[],errors:[],growthWriters:{...ok,complete:false}}),{code:'growth-writer-unknown'});
 assert.throws(()=>validateRetirement(disp(),binding,{references:[],errors:[],growthWriters:{...ok,errors:['x']}}),{code:'growth-writer-unknown'});
 assert.throws(()=>validateRetirement(disp(),binding,{references:[],errors:[],growthWriters:{...ok,references:[{pid:1,access:'unknown'}]}}),{code:'growth-writer-unknown'});
 assert.throws(()=>validateRetirement(disp(),binding,{references:[],errors:[],growthWriters:{}}),{code:'growth-writer-unknown'});
 assert.throws(()=>validateRetirement({...disp(),growthWriters:'unknown'},binding,{references:[],errors:[],growthWriters:ok}),{code:'invalid-growth-disposition'});
});
