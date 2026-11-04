import './scratch-env.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
const launcher=new URL('./admission-launcher',import.meta.url).pathname;
const helper=new URL('./admission-continuation.py',import.meta.url).pathname;
const wait=async f=>{const end=Date.now()+8000;while(!fs.existsSync(f)){assert.ok(Date.now()<end,'fixture deadline: '+f);await new Promise(r=>setTimeout(r,10));}};
test('long shared holder and publication queue heartbeat and release without selecting old code or starving publisher',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'admission-custody-')),lock=path.join(root,'lock'),ready=path.join(root,'ready'),draining=path.join(root,'draining'),selected=path.join(root,'selected'),order=path.join(root,'order');
 const env={...process.env,XDG_STATE_HOME:path.join(root,'state'),AGENT_WORKSPACE_ADMISSION_LOCK:lock,AGENT_WORKSPACE_SELECTED_ROOT:selected};
 for(const name of ['old','new']){fs.mkdirSync(path.join(root,name));fs.writeFileSync(path.join(root,name,'main'),`#!/bin/sh\necho '${name} '"$1" >> '${order}'\nprintf '{"ok":true,"command":"%s"}\\n' "$1"\n`,{mode:0o755});}fs.symlinkSync(path.join(root,'old'),selected);
 const old=spawn('flock',['-s',lock,'sh','-c',`touch '${ready}';read finish`],{stdio:['pipe','ignore','pipe']});let publisher;const jobs=[];
 try{
  await wait(ready);
  publisher=spawn('flock',['-x',lock+'.turnstile','sh','-c',`touch '${draining}';flock -x '${lock}' sh -c 'echo publisher >> "${order}"; ln -s "${root}/new" "${root}/next"; mv -T "${root}/next" "${selected}"'`]);await wait(draining);
  for(const command of ['heartbeat','release']){
   const result=spawnSync('/bin/sh',[launcher,command,'--path',root,'--owner','fixture','--json'],{env,encoding:'utf8',timeout:4000});assert.equal(result.status,75,result.stderr);
   const receipt=JSON.parse(result.stdout);assert.equal(receipt.state,'pending');assert.equal(receipt.commandStarted,false);jobs.push(receipt);assert.ok(!fs.existsSync(order));
   const observation=spawnSync('/bin/sh',[launcher,'admission-status','--job-id',receipt.jobId,'--json'],{env,encoding:'utf8',timeout:4000});assert.equal(observation.status,75,observation.stderr);
  }
  // The caller is already gone. Keep a genuine shared holder longer than the
  // old foreground budget, then allow the original publisher to finish.
  await new Promise(r=>setTimeout(r,21000));assert.ok(!fs.existsSync(order));old.stdin.end('finish\n');
  for(const receipt of jobs){await wait(receipt.resultPath);const result=JSON.parse(fs.readFileSync(receipt.resultPath));assert.equal(result.state,'completed');assert.equal(result.component,path.join(root,'new'));assert.equal(result.exitCode,0);assert.equal(JSON.parse(fs.readFileSync(result.stdoutPath)).ok,true);
   // Even an accidental service activation cannot replay its effect.
   const again=spawnSync('/usr/bin/python3',[helper,'run',receipt.jobId,path.join(root,'state/pi-workspaces/admission-jobs')],{env,encoding:'utf8'});assert.notEqual(again.status,0);
  }
  const lines=fs.readFileSync(order,'utf8').trim().split('\n');assert.equal(lines[0],'publisher');assert.deepEqual(lines.slice(1).sort(),['new heartbeat','new release']);
 }finally{old.stdin.end('finish\n');for(const c of [old,publisher].filter(Boolean))await new Promise(r=>c.exitCode===null?c.once('exit',r):r());for(const j of jobs)spawnSync('systemctl',['--user','stop','agent-workspace-admission-'+j.jobId]);fs.rmSync(root,{recursive:true,force:true});}
});
