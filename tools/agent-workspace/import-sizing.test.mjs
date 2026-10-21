import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {historyImportBytes,HISTORY_SIZE_BATCH,commandFailureDetail} from './import-sizing.mjs';
const ids=n=>Array.from({length:n},(_,i)=>i.toString(16).padStart(40,'0')).join('\n');
test('all history objects charged exactly across bounded protocol batches',()=>{
 let calls=0,count=0;const n=HISTORY_SIZE_BATCH*2+17;
 const result=historyImportBytes(ids(n),input=>{const rows=input.trim().split('\n');assert.ok(rows.length<=HISTORY_SIZE_BATCH);calls++;count+=rows.length;return {status:0,stdout:rows.map(()=>1234).join('\n')};});
 assert.equal(calls,3);assert.equal(count,n);assert.equal(result,16*1024**2+n*2*(1234+2+128));
 assert.equal(historyImportBytes('',()=>assert.fail('empty history must not query missing empty object')),16*1024**2);
});
test('timeout/partial stdout remains typed bounded diagnosis, never accepts partial sizes',()=>{
 const partial='1234\n'.repeat(151371);
 assert.throws(()=>historyImportBytes(ids(1),()=>({status:1,error:{code:'ETIMEDOUT',message:'deadline'},signal:'SIGTERM',stdout:partial})),e=>e.message.includes('ETIMEDOUT')&&e.message.includes('signal=SIGTERM')&&e.message.length<300&&!e.message.includes('1234\n'));
 assert.ok(commandFailureDetail({status:1,stderr:'x'.repeat(1000000)}).length<1200);
});
test('actual timeout with partial cat-file-shaped output preserves failure identity',()=>{
 const result=spawnSync('/bin/sh',['-c',"printf '1234\\n'; sleep 2"],{encoding:'utf8',timeout:100,killSignal:'SIGKILL'});
 assert.equal(result.error?.code,'ETIMEDOUT');
 assert.throws(()=>historyImportBytes(ids(1),()=>result),/ETIMEDOUT.*SIGKILL/);
});
for(const stdout of ['', '1\n2', 'missing', '9007199254740992'])test('incomplete/malformed size response is refused '+JSON.stringify(stdout),()=>{
 assert.throws(()=>historyImportBytes(ids(1),()=>({status:0,stdout})),/incomplete or invalid/);
});
