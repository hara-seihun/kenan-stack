import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {spawn} from 'node:child_process';
import {boundedCommand} from './bounded-command.mjs';

// Start the JS test runner/imports before measuring command deadlines. An IPC
// handshake, not a guessed Node startup delay, admits each isolated measurement.
function measuredFixture(kind) {
 return new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,['--input-type=module','-e',`
import {boundedCommand} from ${JSON.stringify(new URL('./bounded-command.mjs',import.meta.url).href)};
import {spawnSync} from 'node:child_process';
process.send('ready');
process.once('message',()=>{
 const options={encoding:'utf8',timeout:200,maxBuffer:262144,env:process.env};
 const started=Date.now();
 // Shell builtins establish the signal disposition before admitting workload;
 // no second cold Node process must install a handler inside a tiny deadline.
 const script=${JSON.stringify(kind==='grandchild' ? 'sleep 30 & child=$!; printf "%s\\n" "$child"; wait' : 'trap "" TERM; printf "%s\\n" "$$"; sleep 1')};
 const result=${kind==='baseline'?'spawnSync':'boundedCommand'}('/bin/sh',['-c',script],options);
 process.send({elapsed:Date.now()-started,status:result.status,signal:result.signal,error:result.error?.code,stdout:result.stdout});
 process.disconnect();
});
`],{stdio:['ignore','pipe','pipe','ipc']});
  let ready=false,result,stderr='';
  child.stderr.on('data',chunk=>stderr+=chunk);
  const timer=setTimeout(()=>{child.kill('SIGKILL');reject(Error('fixture startup/measurement exceeded 10s: '+stderr));},10000);
  child.on('message',message=>{
   if(message==='ready'){assert.equal(ready,false);ready=true;child.send('measure');}
   else result=message;
  });
  child.on('error',error=>{clearTimeout(timer);reject(error);});
  child.on('exit',(code,signal)=>{clearTimeout(timer);if(code!==0||!ready||!result)reject(Error(`fixture failed ${code}/${signal}: ${stderr}`));else resolve(result);});
 });
}
function assertCeased(pid) {
 assert.ok(pid>0,'fixture must actually admit a child, not pass on startup timeout');
 const until=Date.now()+2000;
 for(;;){try{const stat=fs.readFileSync('/proc/'+pid+'/stat','utf8');if(/\) [ZX] /.test(stat))return;if(Date.now()>=until)assert.fail('owned process survived hard deadline');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5);}catch(error){if(error.code==='ENOENT')return;throw error;}}
}
test('SIGTERM-ignoring baseline overruns; hard-deadline command returns and ceases',async()=>{
 const baseline=await measuredFixture('baseline');
 assert.equal(baseline.error,'ETIMEDOUT');assert.ok(Number(baseline.stdout.trim())>0);assert.ok(baseline.elapsed>=900,String(baseline.elapsed));
 const result=await measuredFixture('hard');
 assert.equal(result.error,'ETIMEDOUT');assert.ok(result.elapsed<900,String(result.elapsed));assertCeased(Number(result.stdout.trim()));
});
test('an inherited grandchild pipe cannot extend timeout or survive owned group cessation',async()=>{
 const result=await measuredFixture('grandchild');assert.equal(result.error,'ETIMEDOUT');assert.ok(result.elapsed<900,String(result.elapsed));assertCeased(Number(result.stdout.trim()));
});
test('bounded success and output failure stay distinct',()=>{
 const options={encoding:'utf8',timeout:5000,maxBuffer:262144,env:process.env};
 const success=boundedCommand('/bin/sh',['-c',"printf '[]\\n'"],options);assert.equal(success.status,0);assert.equal(success.stdout.trim(),'[]');
 const tooLarge=boundedCommand('/bin/sh',['-c',"printf '0123456789\\n'"],{...options,maxBuffer:4});assert.equal(tooLarge.error.code,'COMMAND_OUTPUT_LIMIT');
});
