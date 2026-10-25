import './scratch-env.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync,execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,statfsSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {tmpdir} from 'node:os';
import path from 'node:path';
const modulePath=process.env.REGISTER_CAPACITY_MODULE??new URL('./workspace.mjs',import.meta.url).pathname;
const G=1024**3;
function fixture(action) {
 const root=mkdtempSync(path.join(tmpdir(),'register-capacity-')),pool=path.join(root,'pool'),repo=path.join(pool,'checkout'),state=path.join(root,'state','registry.sqlite3');
 mkdirSync(repo,{recursive:true});
 const git=(...args)=>execFileSync('git',['-C',repo,...args],{encoding:'utf8',timeout:5000}).trim();
 git('init','-q','-b','main');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');writeFileSync(path.join(repo,'one.txt'),'immutable source');git('add','.');git('commit','-qm','fixture');
 const invoke=(...args)=>spawnSync(process.execPath,[modulePath,...args],{encoding:'utf8',timeout:20000,env:{...process.env,PI_WORKSPACE_STATE:state,PI_WORKSPACE_CREATE_CHILD:''}});
 const register=(...args)=>invoke('register','--path',repo,'--owner','fixture','--json',...args);
 try { action({root,pool,repo,state,git,invoke,register}); } finally {rmSync(root,{recursive:true,force:true});}
}
test('a refused create cannot be bypassed by cloning and registering a new writer',()=>fixture(f=>{
 const head=f.git('rev-parse','HEAD'),before=readFileSync(path.join(f.repo,'.git/config'));
 const flags=['--intent','source-only','--headroom-gib','1000000','--growth-mib','512'];
 const create=f.invoke('create','--root',f.pool,'--name','refused','--repo',f.repo,'--ref',head,'--owner','fixture',...flags,'--json');
 assert.equal(create.status,2,create.stderr);assert.match(create.stderr,/capacity-detail:/);
 const result=f.register(...flags);assert.equal(result.status,2,result.stderr);
 const c=JSON.parse(result.stderr.split('\n').find(l=>l.startsWith('capacity-detail: ')).slice('capacity-detail: '.length));
 assert.ok(c.requiredBytes>c.freeBytes);assert.equal(c.breakdown.growthBytes,512*1024**2);assert.equal(c.breakdown.effectiveHeadroomBytes,1000000*G);
 const db=new DatabaseSync(f.state,{readOnly:true});assert.equal(db.prepare('SELECT count(*) n FROM workspace').get().n,0);assert.equal(db.prepare('SELECT count(*) n FROM workspace_capacity').get().n,0);db.close();
 assert.deepEqual(readFileSync(path.join(f.repo,'.git/config')),before);assert.equal(f.git('rev-parse','HEAD'),head);assert.equal(readFileSync(path.join(f.repo,'one.txt'),'utf8'),'immutable source');
}));
test('new writer registration accounts future growth once, and explicit accounted adoption never reacquires or expands it',()=>fixture(f=>{
 const result=f.register('--intent','budgeted','--headroom-gib','8','--growth-mib','512');assert.equal(result.status,0,result.stderr);const record=JSON.parse(result.stdout);
 assert.equal(record.capacity.intent,'budgeted');assert.equal(record.capacity.growthBytes,512*1024**2);assert.equal(record.capacity.constructionBytes,0);assert.ok(record.capacity.completedAllocationBytes>0);
 // A later oversubscribed ledger must not make adoption of the SAME already
 // accounted path fail or manufacture new writing capacity.
 const db=new DatabaseSync(f.state);const original=JSON.parse(db.prepare('SELECT plan_json FROM workspace_capacity WHERE workspace_id=?').get(record.id).plan_json);
 db.prepare('UPDATE workspace_capacity SET plan_json=? WHERE workspace_id=?').run(JSON.stringify({...original,headroomBytes:1000000*G}),record.id);db.close();
 const adopted=f.register('--adopt-accounted');assert.equal(adopted.status,0,adopted.stderr);const same=JSON.parse(adopted.stdout);
 assert.equal(same.id,record.id);assert.equal(same.leaseExpiresAt,record.leaseExpiresAt);assert.equal(same.capacity.headroomBytes,1000000*G);
 const expansion=f.register('--adopt-accounted','--intent','budgeted','--headroom-gib','8','--growth-mib','2048');assert.equal(expansion.status,2);assert.match(expansion.stderr,/reprice-capacity/);
 const after=new DatabaseSync(f.state,{readOnly:true});assert.equal(after.prepare('SELECT count(*) n FROM workspace_capacity').get().n,1);after.close();
}));
test('unregistered adoption cannot assert that its future growth was already accounted',()=>fixture(f=>{
 const result=f.register('--adopt-accounted');assert.equal(result.status,2);assert.match(result.stderr,/existing unreleased capacity reservation/);
 const db=new DatabaseSync(f.state,{readOnly:true});assert.equal(db.prepare('SELECT count(*) n FROM workspace').get().n,0);db.close();
}));
test('unpriced legacy writer registration is repaired through the same admission, not silently grandfathered',()=>fixture(f=>{
 const r=f.register('--min-free-gib','1');assert.equal(r.status,0,r.stderr);const id=JSON.parse(r.stdout).id;
 const db=new DatabaseSync(f.state);db.prepare('DELETE FROM workspace_capacity WHERE workspace_id=?').run(id);db.close();
 const refusal=f.register('--intent','source-only','--headroom-gib','1000000','--growth-mib','512');assert.equal(refusal.status,2);assert.match(refusal.stderr,/capacity-detail:/);
 const after=new DatabaseSync(f.state,{readOnly:true});assert.equal(after.prepare('SELECT count(*) n FROM workspace_capacity').get().n,0);assert.equal(after.prepare('SELECT id FROM workspace').get().id,id);after.close();
}));
test('preservation-only registration remains available with no writing lease or growth claim',()=>fixture(f=>{
 const r=f.register('--retained');assert.equal(r.status,0,r.stderr);const record=JSON.parse(r.stdout);assert.equal(record.leaseExpiresAt,0);assert.equal(record.state,'referenced');assert.equal(record.capacity,null);
}));
test('external writer registration shares the same device lock as concurrent create admission',async()=>{
 const root=mkdtempSync(path.join(tmpdir(),'register-device-lock-')),repo=path.join(root,'source'),state=path.join(root,'state','registry.sqlite3');
 const {spawn}=await import('node:child_process'),{createHash}=await import('node:crypto'),{statSync,existsSync}=await import('node:fs');
 let holder,child;
 try {
 mkdirSync(repo);execFileSync('git',['init','-q',repo]);execFileSync('git',['-C',repo,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-q','--allow-empty','-m','fixture']);
 const env={...process.env,PI_WORKSPACE_STATE:state};
 const initialized=spawnSync(process.execPath,[modulePath,'status','--json'],{env,encoding:'utf8',timeout:5000});assert.equal(initialized.status,0,initialized.stderr);
 const locks=path.join(root,'state','locks');mkdirSync(locks,{recursive:true});const name=createHash('sha256').update('capacity:'+String(statSync(repo).dev)).digest('hex'),gate=path.join(root,'held');
 holder=spawn('flock',['--exclusive',path.join(locks,name),'sh','-c','touch "$1"; sleep 1','fixture',gate],{stdio:'ignore'});
 for(let n=0;n<100&&!existsSync(gate);n++)await new Promise(r=>setTimeout(r,10));assert.ok(existsSync(gate));
 child=spawn(process.execPath,[modulePath,'register','--path',repo,'--owner','fixture','--intent','source-only','--headroom-gib','8','--growth-mib','512','--json'],{env,stdio:['ignore','pipe','pipe']});let out='',err='';child.stdout.on('data',d=>out+=d);child.stderr.on('data',d=>err+=d);const ended=new Promise(r=>child.on('exit',r));
 await new Promise(r=>setTimeout(r,250));assert.equal(holder.exitCode,null);assert.equal(child.exitCode,null);assert.equal(out,'');
 const db=new DatabaseSync(state,{readOnly:true});assert.equal(db.prepare('SELECT count(*) n FROM workspace').get().n,0);db.close();
 assert.equal(await ended,0,err);assert.equal(JSON.parse(out).capacity.growthBytes,512*1024**2);
 }finally{if(holder?.exitCode===null)holder.kill();if(child?.exitCode===null)child.kill();rmSync(root,{recursive:true,force:true});}
});
