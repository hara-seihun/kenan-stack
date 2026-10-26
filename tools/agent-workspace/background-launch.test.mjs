import {test} from 'node:test';
import assert from 'node:assert/strict';
import {backgroundSpec} from './background-launch.mjs';
import {callerToolCall,procScope} from './cache-queue.mjs';
const binding={channel:'beta',callId:'exact-call',agentId:'11111111-1111-4111-8111-111111111111'};
const input={agentId:binding.agentId,name:'fixture',argv:['/bin/true'],cwd:'/tmp',env:[],umask:'0077',after:'/bin/true'};
const spec=backgroundSpec(input,binding,1000,1000),group='/user.slice/user-agents.slice/'+spec.unit;
const properties={Description:spec.description,ControlGroup:group,Transient:'yes',ActiveState:'active',User:'1000',InvocationID:'a'.repeat(32)};
const observe=(patch={},cg=group)=>procScope(100,{read:()=>`0::${cg}\n`,query:()=>({status:0,stdout:Object.entries({...properties,...patch}).map(([k,v])=>k+'='+v).join('\n')})});
test('a root-created background launch preserves the exact native identity after server ancestry is gone',()=>{
 assert.deepEqual(callerToolCall({pid:100,scope:()=>observe(),uid:()=>1000,parent:()=>1}),binding);
 assert.equal(callerToolCall({pid:100,scope:()=>observe(),uid:()=>1001,parent:()=>1}),null);
 assert.equal(callerToolCall({pid:100,scope:()=>observe(),uid:()=>1000,parent:()=>1,background:false}),null);
});
test('stale, forged, wrong worker and wrong launch metadata cannot authenticate a background caller',()=>{
 for(const patch of [{ActiveState:'inactive'},{Transient:'no'},{InvocationID:''},{User:'1001'},{Description:'untrusted-user-metadata'},{Description:'kenan-tool-call:'+JSON.stringify({...binding,version:1,background:true,uid:1000,agentId:'22222222-2222-4222-8222-222222222222'})},{ControlGroup:group+'-other'}])assert.equal(observe(patch),null);
 assert.equal(observe({},group.replace('fixture','different-launch')),null);
 assert.equal(observe({},'/user.slice/user-1000.slice/'+spec.unit),null);
 assert.throws(()=>backgroundSpec({...input,agentId:'other'},binding,1000,1000),/owner_mismatch/);
 assert.throws(()=>backgroundSpec(input,null,1000,1000),/caller_required/);
 assert.throws(()=>backgroundSpec(input,binding,0,0),/caller_required/);
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
test('the installed symlink invokes the actual CLI rather than silently doing nothing',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'background-cli-'));
 try{const file=path.join(root,'linked.mjs');fs.symlinkSync(new URL('./background-launch.mjs',import.meta.url).pathname,file);const r=spawnSync(process.execPath,[file,'launch'],{input:'{}',encoding:'utf8',timeout:5000});assert.equal(r.status,2);assert.match(r.stderr,/background_(root|native_caller)_required/);}finally{fs.rmSync(root,{recursive:true,force:true});}
});
