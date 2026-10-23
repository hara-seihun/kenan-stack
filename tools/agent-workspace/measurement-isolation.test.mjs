import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync,spawn,spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {fileURLToPath} from 'node:url';
const tool=fileURLToPath(new URL('./main',import.meta.url));
async function heldLock(root,key) {
 const locks=path.join(root,'locks');fs.mkdirSync(locks,{recursive:true});
 const lock=path.join(locks,createHash('sha256').update(key).digest('hex'));
 const p=spawn('flock',['--exclusive',lock,process.execPath,'-e',"console.log('locked');setTimeout(()=>{},6000)"],{stdio:['ignore','pipe','pipe']});
 await new Promise((resolve,reject)=>{p.stdout.once('data',resolve);p.once('error',reject);});
 return ()=>{p.kill('SIGTERM');};
}
for(const same of [false,true])test(same?'same-checkout contention is bounded by sampler deadline, no stale credit':'independent sampler ignores old pool-wide lock, no30s wait',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'measure-isolation-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const source=path.join(root,'source');fs.mkdirSync(source);execFileSync('git',['init',source],{stdio:'ignore'});execFileSync('git',['-C',source,'-c','user.name=Fixture','-c','user.email=fixture@invalid','commit','--allow-empty','-m','fixture'],{stdio:'ignore'});
 const state=path.join(root,'registry.sqlite3'),env={...process.env,PI_WORKSPACE_STATE:state};
 const register=spawnSync(tool,['register','--path',source,'--owner','fixture','--json'],{encoding:'utf8',env,timeout:3000});assert.equal(register.status,0,register.stderr);const r=JSON.parse(register.stdout);
 const db=new DatabaseSync(state);db.prepare('INSERT INTO workspace_capacity(workspace_id,device_id,plan_json) VALUES(?,?,?)').run(r.id,String(fs.statSync(source).dev),JSON.stringify({intent:'budgeted',growthBytes:1024,headroomBytes:8*1024**3}));db.close();
 const release=await heldLock(root,same?'checkout:'+source:'capacity-measurement');t.after(release);
 const start=Date.now();const sample=spawnSync(tool,['measure-capacity','--id',r.id,'--budget-ms','1500','--json'],{env,timeout:3000,encoding:'utf8'});assert.equal(sample.status,0,sample.stderr);assert.ok(Date.now()-start<2600);
 const output=JSON.parse(sample.stdout);assert.equal(output[0].status,same?'error':'measured');
 if(same){assert.equal(output[0].ok,false);assert.match(output[0].error,/resource busy/);}
});
