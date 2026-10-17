import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
import {boundedCommand} from './bounded-command.mjs';

const options={encoding:'utf8',timeout:80,maxBuffer:262144,env:process.env};
test('SIGTERM-ignoring baseline overruns; hard-deadline command returns and ceases',()=>{
 const script="process.on('SIGTERM',()=>{});process.stdout.write(String(process.pid));setTimeout(()=>process.exit(0),700)";
 let start=Date.now();const baseline=spawnSync(process.execPath,['-e',script],options),old=Date.now()-start;assert.ok(old>=650);assert.equal(baseline.error.code,'ETIMEDOUT');
 start=Date.now();const result=boundedCommand(process.execPath,['-e',script],options),elapsed=Date.now()-start;
 assert.equal(result.error.code,'ETIMEDOUT');assert.ok(elapsed<500,String(elapsed));assert.equal(fs.existsSync('/proc/'+result.stdout),false);
});
test('an inherited grandchild pipe cannot extend timeout or survive owned group cessation',()=>{
 const script="const{spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setTimeout(()=>{},2000)'],{stdio:['ignore','inherit','inherit']});console.log(child.pid);setInterval(()=>{},1000)";
 const start=Date.now(),result=boundedCommand(process.execPath,['-e',script],options);assert.equal(result.error.code,'ETIMEDOUT');assert.ok(Date.now()-start<500);
 const child=Number(result.stdout.trim());assert.ok(child>0);
 const until=Date.now()+200;for(;;){try{const stat=fs.readFileSync('/proc/'+child+'/stat','utf8');if(/\) [ZX] /.test(stat))break;if(Date.now()>=until)assert.fail('owned child did not cease after SIGKILL');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5);}catch(error){if(error.code==='ENOENT')break;throw error;}}
});
test('bounded success and output failure stay distinct',()=>{
 const success=boundedCommand(process.execPath,['-e',"console.log('[]')"],{...options,timeout:1000});assert.equal(success.status,0);assert.equal(success.stdout.trim(),'[]');
 const tooLarge=boundedCommand(process.execPath,['-e',"console.log('0123456789')"],{...options,timeout:1000,maxBuffer:4});assert.equal(tooLarge.error.code,'COMMAND_OUTPUT_LIMIT');
});
