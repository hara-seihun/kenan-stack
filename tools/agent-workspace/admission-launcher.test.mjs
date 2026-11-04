import './scratch-env.mjs';
import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {spawn,spawnSync}from'node:child_process';
test('exclusive publication drains old admission; new launcher resolves successor only after release',async()=>{
 const r=fs.mkdtempSync(path.join(os.tmpdir(),'workspace-drain-'));const lock=path.join(r,'lock'),ready=path.join(r,'ready'),selected=path.join(r,'selected');
 for(const name of ['old','new']){fs.mkdirSync(path.join(r,name));fs.writeFileSync(path.join(r,name,'main'),'#!/bin/sh\necho '+name+'\n',{mode:0o755});}fs.symlinkSync(path.join(r,'old'),selected);
 const holder=spawn('flock',['-x',lock,'sh','-c',`touch '${ready}';sleep 1;ln -s '${r}/new' '${r}/next';mv -T '${r}/next' '${selected}'`]);
 try{while(!fs.existsSync(ready))await new Promise(res=>setTimeout(res,10));const x=spawnSync('/bin/sh',[new URL('./admission-launcher',import.meta.url).pathname,],{env:{...process.env,AGENT_WORKSPACE_ADMISSION_LOCK:lock,AGENT_WORKSPACE_SELECTED_ROOT:selected},encoding:'utf8'});assert.equal(x.status,0,x.stderr);assert.equal(x.stdout,'new\n');assert.equal(fs.readFileSync(path.join(r,'old','main'),'utf8'),'#!/bin/sh\necho old\n');}finally{await new Promise(res=>holder.exitCode===null?holder.once('exit',res):res());fs.rmSync(r,{recursive:true,force:true});}
});
test('a pending publisher prevents a stream of new readers from starving its exclusive admission',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'workspace-turnstile-')),lock=path.join(root,'lock'),ready=path.join(root,'ready'),gate=path.join(root,'gate'),order=path.join(root,'order'),selected=path.join(root,'selected');
 fs.mkdirSync(selected);fs.writeFileSync(path.join(selected,'main'),`#!/bin/sh\necho reader >> '${order}'\n`,{mode:0o755});
 const old=spawn('flock',['-s',lock,'sh','-c',`touch '${ready}';sleep 1`]);
 const wait=async file=>{const end=Date.now()+5000;while(!fs.existsSync(file)){if(Date.now()>end)throw Error('fixture did not start');await new Promise(resolve=>setTimeout(resolve,10));}};
 let publisher;
 try{
  await wait(ready);publisher=spawn('flock',['-x',lock+'.turnstile','sh','-c',`touch '${gate}';flock -x '${lock}' sh -c 'echo publisher >> "${order}"'`]);await wait(gate);
  const result=spawnSync('/bin/sh',[new URL('./admission-launcher',import.meta.url).pathname,],{env:{...process.env,AGENT_WORKSPACE_ADMISSION_LOCK:lock,AGENT_WORKSPACE_SELECTED_ROOT:selected},encoding:'utf8',timeout:5000});
  assert.equal(result.status,0,result.stderr);assert.equal(fs.readFileSync(order,'utf8'),'publisher\nreader\n');
 }finally{for(const child of [old,publisher].filter(Boolean))await new Promise(resolve=>child.exitCode===null?child.once('exit',resolve):resolve());fs.rmSync(root,{recursive:true,force:true});}
});
test('an admission timeout returns a typed machine refusal and never starts the requested command',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'workspace-busy-'));
 try{const bin=path.join(root,'bin'),selected=path.join(root,'selected');fs.mkdirSync(bin);fs.mkdirSync(selected);fs.writeFileSync(path.join(bin,'flock'),'#!/bin/sh\nexit 75\n',{mode:0o755});fs.writeFileSync(path.join(selected,'main'),'#!/bin/sh\necho should-not-run\n',{mode:0o755});
 const result=spawnSync('/bin/sh',[new URL('./admission-launcher',import.meta.url).pathname,'create','--json'],{env:{...process.env,PATH:bin+':/usr/bin:/bin',AGENT_WORKSPACE_ADMISSION_LOCK:path.join(root,'lock'),AGENT_WORKSPACE_SELECTED_ROOT:selected},encoding:'utf8',timeout:3000});assert.equal(result.status,75);assert.equal(JSON.parse(result.stdout).error.code,'workspace-admission-lock-busy');assert.doesNotMatch(result.stdout,/should-not-run/);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
for(const stages of ['turnstile','shared'])test(`one absolute admission budget covers real ${stages} contention before the caller tool deadline`,async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'workspace-budget-')),lock=path.join(root,'lock'),ready=path.join(root,'ready'),selected=path.join(root,'selected');fs.mkdirSync(selected);fs.writeFileSync(path.join(selected,'main'),'#!/bin/sh\necho forbidden\n',{mode:0o755});
 const held=stages==='turnstile'?lock+'.turnstile':lock;
 const holder=spawn('flock',['-x',held,'sh','-c',`touch '${ready}';sleep 24`]);
 try{const end=Date.now()+3000;while(!fs.existsSync(ready)&&Date.now()<end)await new Promise(r=>setTimeout(r,5));assert.equal(fs.existsSync(ready),true);const started=Date.now();const result=spawnSync('/bin/sh',[new URL('./admission-launcher',import.meta.url).pathname,'create','--json'],{env:{...process.env,AGENT_WORKSPACE_ADMISSION_LOCK:lock,AGENT_WORKSPACE_SELECTED_ROOT:selected},encoding:'utf8',timeout:23000});const elapsed=Date.now()-started;assert.equal(result.status,75,result.stderr);assert.ok(elapsed>=18000&&elapsed<23000,String(elapsed));const value=JSON.parse(result.stdout);assert.equal(value.error.code,'workspace-admission-lock-busy');assert.equal(value.error.commandStarted,false);assert.equal(value.error.waitBudgetSeconds,20);assert.doesNotMatch(result.stdout,/forbidden/);
 }finally{holder.kill('SIGTERM');await new Promise(r=>holder.exitCode===null?holder.once('exit',r):r());fs.rmSync(root,{recursive:true,force:true});}
});

test('only exact job observers bypass publication; generic status and mutations retain admission',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'workspace-observer-fence-'));
 try{
  const bin=path.join(root,'bin'),selected=path.join(root,'selected');fs.mkdirSync(bin);fs.mkdirSync(selected);
  fs.writeFileSync(path.join(bin,'flock'),'#!/bin/sh\nexit 75\n',{mode:0o755});
  fs.writeFileSync(path.join(selected,'main'),'#!/bin/sh\nprintf "%s\\n" "$1"\n',{mode:0o755});
  fs.writeFileSync(path.join(selected,'read-only-job-observation-v1'),'fixture contract');
  const env={...process.env,PATH:bin+':/usr/bin:/bin',AGENT_WORKSPACE_ADMISSION_LOCK:path.join(root,'lock'),AGENT_WORKSPACE_SELECTED_ROOT:selected};
  for(const command of ['job-status','source-status']){
   const result=spawnSync('/bin/sh',[new URL('./admission-launcher',import.meta.url).pathname,command,'--json'],{env,encoding:'utf8',timeout:3000});
   assert.equal(result.status,0,result.stderr);assert.equal(result.stdout,command+'\n');
  }
  fs.unlinkSync(path.join(selected,'read-only-job-observation-v1'));
  for(const command of ['job-status','source-status','status','create','source-prepare','job-status-extra','--json']){
   const result=spawnSync('/bin/sh',[new URL('./admission-launcher',import.meta.url).pathname,command,'job-status','--json'],{env,encoding:'utf8',timeout:3000});
   assert.equal(result.status,75,result.stderr);assert.equal(JSON.parse(result.stdout).error.commandStarted,false);
  }
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('real retained job observers remain read-only during exclusive publication and atomic reselection',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'workspace-observer-publication-'));
 const lock=path.join(root,'lock'),ready=path.join(root,'ready'),selected=path.join(root,'selected'),state=path.join(root,'registry.sqlite3');
 const component=new URL('.',import.meta.url).pathname;
 fs.symlinkSync(component,selected);
 // Block both publisher fences until the fixture closes stdin, without a timer.
 const holder=spawn('flock',['-x',lock+'.turnstile','flock','-x',lock,'sh','-c',`touch '${ready}';read release`],{stdio:['pipe','ignore','pipe']});
 try{
  const end=Date.now()+3000;while(!fs.existsSync(ready)&&Date.now()<end)await new Promise(r=>setTimeout(r,5));assert.ok(fs.existsSync(ready));
  const bin=path.join(root,'bin');fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin,'systemctl'),"#!/bin/sh\nprintf 'LoadState=loaded\\nActiveState=inactive\\nSubState=dead\\nResult=success\\nExecMainStatus=0\\n'\n",{mode:0o755});
  const env={...process.env,PATH:bin+':'+process.env.PATH,PI_WORKSPACE_STATE:state,AGENT_WORKSPACE_ADMISSION_LOCK:lock,AGENT_WORKSPACE_SELECTED_ROOT:selected};
  for(const [kind,command,digit] of [['source','source-status','a'],['checkout','job-status','b']]){
   const id=digit.repeat(64),directory=kind==='source'?path.join(root,'source-preparations','jobs',id):path.join(root,'checkout-jobs','owner',id);
   fs.mkdirSync(directory,{recursive:true});
   for(const [name,value] of Object.entries({'request.json':{id:'owner'},'attempt.json':{unit:'fixture.service',number:1},'progress.json':{state:'running'}}))fs.writeFileSync(path.join(directory,name),JSON.stringify(value));
   const snapshot=()=>Object.fromEntries(fs.readdirSync(directory).map(name=>[name,fs.readFileSync(path.join(directory,name),'utf8')]));
   const before=snapshot();const start=Date.now();
   const result=spawnSync('/bin/sh',[new URL('./admission-launcher',import.meta.url).pathname,command,'--job-id',id,'--json'],{env,encoding:'utf8',timeout:4000});
   assert.equal(result.error,undefined);assert.equal(result.status,2,result.stderr);assert.equal(JSON.parse(result.stdout).state,'interrupted');assert.ok(Date.now()-start<4000);assert.deepEqual(snapshot(),before);assert.equal(fs.existsSync(state),false);
   fs.writeFileSync(path.join(directory,'result.json'),JSON.stringify({state:'ready',value:{id:'owner'}}));
   const terminalBefore=snapshot();const terminal=spawnSync('/bin/sh',[new URL('./admission-launcher',import.meta.url).pathname,command,'--job-id',id,'--json'],{env,encoding:'utf8',timeout:4000});
   assert.equal(terminal.status,0,terminal.stderr);assert.equal(JSON.parse(terminal.stdout).state,'ready');assert.deepEqual(snapshot(),terminalBefore);
  }
  // An observer pins the immutable directory, not the mutable selection symlink.
  for(const version of ['old','new']){
   fs.mkdirSync(path.join(root,version));fs.writeFileSync(path.join(root,version,'read-only-job-observation-v1'),'fixture contract');fs.writeFileSync(path.join(root,version,'main'),'#!/bin/sh\nprintf "%s\\n" "$0"\n',{mode:0o755});
   fs.symlinkSync(path.join(root,version),path.join(root,'next'));fs.renameSync(path.join(root,'next'),selected);
   const result=spawnSync('/bin/sh',[new URL('./admission-launcher',import.meta.url).pathname,'job-status'],{env,encoding:'utf8',timeout:3000});
   assert.equal(result.status,0,result.stderr);assert.equal(result.stdout,path.join(root,version,'main')+'\n');
  }
  assert.ok(fs.existsSync(path.join(root,'old','main')));
 }finally{holder.stdin.end('release\n');await new Promise(r=>holder.exitCode===null?holder.once('exit',r):r());fs.rmSync(root,{recursive:true,force:true});}
});
