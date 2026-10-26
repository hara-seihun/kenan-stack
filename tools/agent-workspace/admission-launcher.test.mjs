import './scratch-env.mjs';
import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {spawn,spawnSync}from'node:child_process';
test('exclusive publication drains old admission; new launcher resolves successor only after release',async()=>{
 const r=fs.mkdtempSync(path.join(os.tmpdir(),'workspace-drain-'));const lock=path.join(r,'lock'),ready=path.join(r,'ready'),selected=path.join(r,'selected');
 for(const name of ['old','new']){fs.mkdirSync(path.join(r,name));fs.writeFileSync(path.join(r,name,'main'),'#!/bin/sh\necho '+name+'\n',{mode:0o755});}fs.symlinkSync(path.join(r,'old'),selected);
 const holder=spawn('flock',['-x',lock,'sh','-c',`touch '${ready}';sleep 1;ln -s '${r}/new' '${r}/next';mv -T '${r}/next' '${selected}'`]);
 try{while(!fs.existsSync(ready))await new Promise(res=>setTimeout(res,10));const x=spawnSync(new URL('./admission-launcher',import.meta.url).pathname,[],{env:{...process.env,AGENT_WORKSPACE_ADMISSION_LOCK:lock,AGENT_WORKSPACE_SELECTED_ROOT:selected},encoding:'utf8'});assert.equal(x.status,0,x.stderr);assert.equal(x.stdout,'new\n');assert.equal(fs.readFileSync(path.join(r,'old','main'),'utf8'),'#!/bin/sh\necho old\n');}finally{await new Promise(res=>holder.exitCode===null?holder.once('exit',res):res());fs.rmSync(r,{recursive:true,force:true});}
});
test('a pending publisher prevents a stream of new readers from starving its exclusive admission',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'workspace-turnstile-')),lock=path.join(root,'lock'),ready=path.join(root,'ready'),gate=path.join(root,'gate'),order=path.join(root,'order'),selected=path.join(root,'selected');
 fs.mkdirSync(selected);fs.writeFileSync(path.join(selected,'main'),`#!/bin/sh\necho reader >> '${order}'\n`,{mode:0o755});
 const old=spawn('flock',['-s',lock,'sh','-c',`touch '${ready}';sleep 1`]);
 const wait=async file=>{const end=Date.now()+5000;while(!fs.existsSync(file)){if(Date.now()>end)throw Error('fixture did not start');await new Promise(resolve=>setTimeout(resolve,10));}};
 let publisher;
 try{
  await wait(ready);publisher=spawn('flock',['-x',lock+'.turnstile','sh','-c',`touch '${gate}';flock -x '${lock}' sh -c 'echo publisher >> "${order}"'`]);await wait(gate);
  const result=spawnSync(new URL('./admission-launcher',import.meta.url).pathname,[],{env:{...process.env,AGENT_WORKSPACE_ADMISSION_LOCK:lock,AGENT_WORKSPACE_SELECTED_ROOT:selected},encoding:'utf8',timeout:5000});
  assert.equal(result.status,0,result.stderr);assert.equal(fs.readFileSync(order,'utf8'),'publisher\nreader\n');
 }finally{for(const child of [old,publisher].filter(Boolean))await new Promise(resolve=>child.exitCode===null?child.once('exit',resolve):resolve());fs.rmSync(root,{recursive:true,force:true});}
});
test('an admission timeout returns a typed machine refusal and never starts the requested command',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'workspace-busy-'));
 try{const bin=path.join(root,'bin'),selected=path.join(root,'selected');fs.mkdirSync(bin);fs.mkdirSync(selected);fs.writeFileSync(path.join(bin,'flock'),'#!/bin/sh\nexit 75\n',{mode:0o755});fs.writeFileSync(path.join(selected,'main'),'#!/bin/sh\necho should-not-run\n',{mode:0o755});
 const result=spawnSync(new URL('./admission-launcher',import.meta.url).pathname,['create','--json'],{env:{...process.env,PATH:bin+':/usr/bin:/bin',AGENT_WORKSPACE_ADMISSION_LOCK:path.join(root,'lock'),AGENT_WORKSPACE_SELECTED_ROOT:selected},encoding:'utf8',timeout:3000});assert.equal(result.status,75);assert.equal(JSON.parse(result.stdout).error.code,'workspace-admission-lock-busy');assert.doesNotMatch(result.stdout,/should-not-run/);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
