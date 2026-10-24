import path from 'node:path';
import fs from 'node:fs';
import {boundedCommand} from './bounded-command.mjs';
const refuse=code=>{throw Object.assign(new Error(code),{code});};
export function writerRequest(v) {
 if(!v.id||!v.owner||!path.isAbsolute(v.path??'')||path.resolve(v.path)!==v.path||fs.realpathSync(v.path)!==v.path||!/^([a-f0-9]{40}|[a-f0-9]{64})$/.test(v['expected-head']??''))refuse('writer-invalid-binding');
 let command;try{command=JSON.parse(v['command-json']);}catch{refuse('writer-invalid-command');}
 if(!Array.isArray(command)||!command.length||command.some(x=>typeof x!=='string'||x.includes('\0'))||!command[0])refuse('writer-invalid-command');
 const timeout=Number(v['timeout-ms']);if(!Number.isSafeInteger(timeout)||timeout<1||timeout>3600000)refuse('writer-invalid-timeout');
 return {id:v.id,path:v.path,owner:v.owner,head:v['expected-head'],command,timeout};
}
export function assertWriterBinding(record,input,observed) {
 if(record.id!==input.id||record.path!==input.path||record.owner!==input.owner)refuse('writer-stale-custody');
 if(record.mode!=='writer'||record.state!=='active'||record.leaseExpiresAt<=Date.now())refuse('writer-inactive-custody');
 if(observed.frozen)refuse('writer-frozen-source');
 if(observed.head!==input.head)refuse('writer-stale-head');
}
export function runWriter(input,custodyFds) {
 // Pass open lock descriptions to the child. A killed CLI cannot unlock a still
 // running writer. Reap its process group before closing parent custody on return.
 const result=boundedCommand(input.command[0],input.command.slice(1),{cwd:input.path,timeout:input.timeout,maxBuffer:8*1024*1024,reapGroup:true,custodyFds});
 return {ok:result.status===0&&!result.error&&!result.signal,kind:'workspace-writer-result',binding:{id:input.id,path:input.path,owner:input.owner,head:input.head},exitCode:result.status,signal:result.signal,error:result.error?.code,stdout:result.stdout,stderr:result.stderr};
}
