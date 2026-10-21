import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {spawn,spawnSync}from'node:child_process';
test('exclusive publication drains old admission; new launcher resolves successor only after release',async()=>{
 const r=fs.mkdtempSync(path.join(os.tmpdir(),'workspace-drain-'));const lock=path.join(r,'lock'),ready=path.join(r,'ready'),selected=path.join(r,'selected');
 for(const name of ['old','new']){fs.mkdirSync(path.join(r,name));fs.writeFileSync(path.join(r,name,'main'),'#!/bin/sh\necho '+name+'\n',{mode:0o755});}fs.symlinkSync(path.join(r,'old'),selected);
 const holder=spawn('flock',['-x',lock,'sh','-c',`touch '${ready}';sleep 1;ln -s '${r}/new' '${r}/next';mv -T '${r}/next' '${selected}'`]);
 try{while(!fs.existsSync(ready))await new Promise(res=>setTimeout(res,10));const x=spawnSync(new URL('./admission-launcher',import.meta.url).pathname,[],{env:{...process.env,AGENT_WORKSPACE_ADMISSION_LOCK:lock,AGENT_WORKSPACE_SELECTED_ROOT:selected},encoding:'utf8'});assert.equal(x.status,0,x.stderr);assert.equal(x.stdout,'new\n');assert.equal(fs.readFileSync(path.join(r,'old','main'),'utf8'),'#!/bin/sh\necho old\n');}finally{await new Promise(res=>holder.exitCode===null?holder.once('exit',res):res());fs.rmSync(r,{recursive:true,force:true});}
});
