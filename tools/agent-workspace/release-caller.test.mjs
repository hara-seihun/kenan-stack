import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {transientReleaseCaller} from './release-caller.mjs';
import {runReleaseWorker} from './release-retry.mjs';
const retained=pid=>({inspection:{classification:'referenced',processes:[{pid,matches:['cwd:/fixture']}],containers:[],systemdUnits:[]},error:{code:'retention-release-protected'}});
const result=(receipt,status=2)=>({stdout:JSON.stringify(receipt),status});
test('a real parent shell in the checkout is captured and its exit automatically continues the same worker',async()=>{
 const root=mkdtempSync(path.join(tmpdir(),'release-caller-'));
 const module=new URL('./release-caller.mjs',import.meta.url).href;
 const code=`import {captureReleaseCallers} from ${JSON.stringify(module)}; console.log(JSON.stringify(captureReleaseCallers(process.cwd())));`;
 const shell=spawn('/bin/bash',['-c','"$1" --input-type=module -e "$2"; read -r line','caller',process.execPath,code],{cwd:root,stdio:['pipe','pipe','pipe']});
 try {
  let text='';for await(const chunk of shell.stdout){text+=chunk;if(text.includes('\n'))break;}
  const callers=JSON.parse(text);assert.ok(callers.some(c=>c.pid===shell.pid));
  const receipt=retained(shell.pid);assert.equal(transientReleaseCaller(receipt,callers),true);
  let calls=0;
  const done=await runReleaseWorker(()=>++calls===1?result(receipt):result({action:'released'},0),{
   releaseCallers:callers,sleep:async()=>{const exited=once(shell,'exit');shell.stdin.end('exit\n');await exited;}
  });
  assert.equal(calls,2);assert.equal(done.exitCode,0);assert.equal(done.receipt.action,'released');
  for(const changed of [
   { ...receipt,inspection:{...receipt.inspection,processes:[{pid:shell.pid,matches:['fd:3']}] }},
   { ...receipt,inspection:{...receipt.inspection,processes:[{pid:1,matches:['cwd:/fixture']}] }},
   { ...receipt,inspection:{...receipt.inspection,containers:[{id:'build'}]}},
   { ...receipt,inspection:{...receipt.inspection,systemdUnits:[{id:'build.service'}]}},
   { ...receipt,inspection:{...receipt.inspection,sourceRetention:true}},
  ])assert.equal(transientReleaseCaller(changed,callers),false);
 }finally{shell.kill();rmSync(root,{recursive:true,force:true});}
});
test('a caller that stays alive remains protected after bounded observation; PID reuse is not a caller',async()=>{
 const stat=(await import('node:fs')).readFileSync(`/proc/${process.pid}/stat`,'utf8');
 const caller={pid:process.pid,uid:process.getuid(),start:stat.slice(stat.lastIndexOf(')')+2).split(' ')[19]};
 assert.equal(transientReleaseCaller(retained(process.pid),[{...caller,start:'wrong'}]),false);
 assert.equal(transientReleaseCaller(retained(process.pid),[{...caller,uid:caller.uid+1}]),false);
 let clock=0,calls=0;const receipt=retained(process.pid);
 const done=await runReleaseWorker(()=>{calls++;return result(receipt);},{releaseCallers:[caller],now:()=>clock,sleep:async ms=>{clock+=ms;},budgetMs:5000});
 assert.equal(calls,3);assert.equal(done.exitCode,2);assert.deepEqual(done.receipt,receipt);
});
// November 5 (disk-census-b511): `agent-workspace release --path CHECKOUT | tee FILE` from a
// shell inside the checkout retained it for the tee, a pipeline sibling, not an ancestor.
test('a pipeline sibling of the release in the caller shell is captured; unrelated same-user processes are not',async()=>{
 const root=mkdtempSync(path.join(tmpdir(),'release-caller-pipe-'));
 const module=new URL('./release-caller.mjs',import.meta.url).href;
 const code=`import {captureReleaseCallers} from ${JSON.stringify(module)};import {readFileSync} from 'node:fs';
  const callers=captureReleaseCallers(process.cwd());
  const comm=pid=>{try{return readFileSync('/proc/'+pid+'/comm','utf8').trim();}catch{return null;}};
  console.log(JSON.stringify({callers,commands:callers.map(c=>comm(c.pid)),shell:process.ppid}));`;
 const unrelated=spawn('/bin/sleep',['30'],{cwd:root,stdio:'ignore'});
 const shell=spawn('/bin/bash',['-c','"$1" --input-type=module -e "$2" | tee /dev/null; read -r line','caller',process.execPath,code],{cwd:root,stdio:['pipe','pipe','pipe']});
 try {
  let text='';for await(const chunk of shell.stdout){text+=chunk;if(text.includes('\n'))break;}
  const observed=JSON.parse(text);
  assert.ok(observed.callers.some(c=>c.pid===shell.pid),text);
  assert.ok(observed.commands.includes('tee'),text);
  assert.ok(!observed.callers.some(c=>c.pid===unrelated.pid),'a same-user process outside the caller pipeline is never a caller');
  // The sibling is only a bounded wait hint: while it lives the retained receipt stays retained after the budget.
  const tee=observed.callers[observed.commands.indexOf('tee')];
  assert.equal(transientReleaseCaller(retained(tee.pid),observed.callers),true);
  assert.equal(transientReleaseCaller({...retained(tee.pid),inspection:{...retained(tee.pid).inspection,processes:[{pid:tee.pid,matches:['write-fd:/x']}]}},observed.callers),false);
 }finally{shell.stdin.end('exit\n');shell.kill();unrelated.kill();rmSync(root,{recursive:true,force:true});}
});
