import { test } from 'node:test';
import assert from 'node:assert/strict';
const {workspaceTesting:w}=await import(process.env.WORKSPACE_RELEASE_MODULE||'./workspace.mjs');
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {processSnapshot} from './safety-census.mjs';
const root='/fixture/checkout';
const unit={id:'release.service',mainPid:42,manager:'user',workingDirectory:'/fixture',execStart:`{ path=/bin/bash ; argv[]=/bin/bash -c agent-workspace release --path ${root} ; }`};
const context=()=>({command:'release',target:root,uid:1002,ancestors:new Set([42]),read:()=> 'Uid:\t1002 1002 1002 1002\n',link:p=>p.endsWith('/cwd')?'/fixture':'/usr/bin/bash'});
const refs=(u=unit,c=context())=>w.systemdReferences(root,{available:true,units:[u]},c).references;
test('exact own release ancestor path argument is not an external writer',()=>assert.equal(refs().length,0));
test('other unit even with identical arguments stays protected',()=>assert.equal(refs({...unit,mainPid:43}).length,1));
test('own ancestor with actual checkout cwd stays protected',()=>assert.equal(refs({...unit,workingDirectory:root}).length,1));
test('own ancestor actual executable or cwd in checkout stays protected',()=>{for(const value of [root,root+'/bin/worker']){const c=context();c.link=()=>value;assert.equal(refs(unit,c).length,1);}});
test('embedded executable or other descendant path stays protected',()=>assert.equal(refs({...unit,execStart:unit.execStart+' '+root+'/bin/worker'}).length,1));
test('unknown/mismatched identity and nonrelease commands fail closed',()=>{for(const c of [{...context(),read:()=> 'Uid:\t1003\n'},{...context(),read:()=>{throw Error('gone');}},{...context(),command:'prune'},{...context(),target:'/other'}])assert.equal(refs(unit,c).length,1);});
test('systemd MainPID parsed for authenticated ancestry, missing pid cannot bypass',()=>{const units=w.parseSystemdUnits('Id=release.service\nActiveState=active\nMainPID=42\nWorkingDirectory=/fixture\nExecStart='+unit.execStart,'user');assert.equal(units[0].mainPid,42);assert.equal(refs({...unit,mainPid:0}).length,1);});

const binding={agentId:'22222222-2222-4222-8222-222222222222',callId:'call_batch',channel:'beta'};
const batch={...unit,id:'kenan-bg-'+binding.agentId+'-release-many.service',manager:'system',execStart:`/usr/local/bin/kenan-bg --run release-many /var/tmp/batch.log /bin/bash -c 'for p in ${root} /fixture/other /fixture/third; do agent-workspace release --path "$p" --json; done'`};
const group='/user.slice/user-agents.slice/'+batch.id;
const batchContext=()=>({...context(),files:()=>[],wrapper:{...binding,binding,background:true,unit:batch.id,group},read:p=>p.endsWith('/cgroup')?'0::'+group+'\n':'Uid:\t1002 1002 1002 1002\n'});
test('only the actual authenticated multi-target cleanup wrapper is not its own consumer',()=>assert.equal(refs(batch,batchContext()).length,0));
test('foreign and unknown wrappers remain protected even with matching path arguments',()=>{
 for(const patch of [{wrapper:null},{wrapper:{...batchContext().wrapper,binding:{...binding,agentId:'foreign'}}},{wrapper:{...batchContext().wrapper,unit:'foreign.service'}},{read:p=>p.endsWith('/cgroup')?'0::/unknown\n':'Uid:\t1002\n'}])
  assert.equal(refs(batch,{...batchContext(),...patch}).length,1);
 assert.equal(refs({...batch,id:'foreign.service'},batchContext()).length,1);
 assert.equal(refs({...batch,mainPid:43},batchContext()).length,1);
});
test('authenticated wrapper never hides checkout cwd, executable or descendant references',()=>{
 assert.equal(refs({...batch,execStart:batch.execStart+' '+root+'/node_modules/cache'},batchContext()).length,1);
 assert.equal(refs({...batch,workingDirectory:root},batchContext()).length,1);
 for(const link of [()=>root+'/bin/worker',()=>null])assert.equal(refs(batch,{...batchContext(),link}).length,1);
});
test('a real child in the target checkout remains a process consumer',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'release-child-'));
 const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{cwd:dir,stdio:'ignore'});
 try {
  await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});
  const references=processSnapshot(false,dir).filter(p=>p.cwd===dir);
  assert.ok(references.some(p=>p.pid===child.pid),'the cleanup wrapper exemption must not alter process census');
 }finally{child.kill('SIGKILL');await new Promise(resolve=>child.once('exit',resolve));fs.rmSync(dir,{recursive:true});}
});

test('an authenticated batch ancestor holding checkout resources remains protected',()=>{
 assert.equal(refs(batch,{...batchContext(),files:()=>[root+'/node_modules/cache']} ).length,1);
 assert.equal(refs(batch,{...batchContext(),files:()=>{throw Error('unknown descriptors');}}).length,1);
});
