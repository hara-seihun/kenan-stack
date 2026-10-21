import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {fileURLToPath} from 'node:url';
import {MaintenanceJournal,priorDisposition} from './maintenance-journal.mjs';
const operation='11111111-1111-4111-8111-111111111111';
const second='22222222-2222-4222-8222-222222222222';
const binding={scope:{root:'/fixture'},prior:{originalOperationId:second,sha256:'a'.repeat(64)},protocol:1};
const mod=fileURLToPath(new URL('./maintenance-journal.mjs',import.meta.url));
function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'maintain-journal-offline-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return {root,journal:path.join(root,'journal.sqlite3'),counter:path.join(root,'effect')};}
function open(f,options={}){return new MaintenanceJournal(f.journal,operation,binding,{deadline:Date.now()+5000,...options});}
const spec={kind:'fixture-append',workspace:{id:'owned'},input:{value:'once'}};
for(const window of ['prepared','uncertain','effect-returned','settled','record-checkpoint'])test(`actual SIGKILL at ${window}: durable journal prevents replay`,t=>{
 const f=fixture(t);
 const code=`import fs from 'node:fs';import {MaintenanceJournal} from ${JSON.stringify('file://'+mod)};
 const j=new MaintenanceJournal(${JSON.stringify(f.journal)},${JSON.stringify(operation)},${JSON.stringify(binding)},{deadline:Date.now()+5000,hook:stage=>{if(stage===${JSON.stringify(window)})process.kill(process.pid,'SIGKILL')}});
 j.run({maxRecords:1,next:c=>c?null:{id:'owned'},inspect:()=>{},execute:()=>j.effect(${JSON.stringify(spec)},()=>{fs.appendFileSync(${JSON.stringify(f.counter)},'once\\n');return 'success'})});j.close();`;
 const child=spawnSync(process.execPath,['--input-type=module','-e',code],{timeout:2000,encoding:'utf8'});assert.equal(child.signal,'SIGKILL',child.stderr);
 let j=open(f,{resume:true});
 if(['uncertain','effect-returned'].includes(window)){
  assert.throws(()=>j.run({maxRecords:1,next:()=>{throw Error('must not traverse before reconciliation')},inspect:()=>{},execute:()=>{throw Error('must not execute')}}),/reconciliation-required/);
  assert.throws(()=>j.reconcile(()=>({kind:'unknown'})),/outcome-unknown/);
  if(window==='uncertain'){assert.equal(fs.existsSync(f.counter),false);assert.throws(()=>j.effect(spec,()=>{throw Error('duplicate')}),/outcome-unknown/);j.close();return;}
  j.reconcile(()=>({kind:'applied',evidence:'offline exact durable marker read after child cessation',result:'success'}));
 }
 j.run({maxRecords:1,next:c=>c?null:{id:'owned'},inspect:()=>{},execute:()=>j.effect(spec,()=>{fs.appendFileSync(f.counter,'once\n');return 'success'})});j.close();
 assert.equal(fs.readFileSync(f.counter,'utf8'),'once\n');
});
test('timeout inside effect remains uncertain even when the child wrote first',t=>{
 const f=fixture(t);const code=`import fs from 'node:fs';import {MaintenanceJournal} from ${JSON.stringify('file://'+mod)};const j=new MaintenanceJournal(${JSON.stringify(f.journal)},${JSON.stringify(operation)},${JSON.stringify(binding)},{deadline:Date.now()+10000});j.effect(${JSON.stringify(spec)},()=>{fs.writeFileSync(${JSON.stringify(f.counter)},'effect');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10000);});`;
 const child=spawnSync(process.execPath,['--input-type=module','-e',code],{timeout:200,killSignal:'SIGKILL',encoding:'utf8'});assert.equal(child.error.code,'ETIMEDOUT');const j=open(f,{resume:true});assert.equal(j.unknown().length,1);assert.throws(()=>j.effect(spec,()=>{}),/outcome-unknown/);assert.equal(fs.readFileSync(f.counter,'utf8'),'effect');j.close();
});
test('deadline before effect and after effect before settlement have different durable states',t=>{
 const f=fixture(t);let clock=0;let j=open(f,{now:()=>clock,deadline:1000,hook:stage=>{if(stage==='prepared')clock=900;}});assert.throws(()=>j.effect(spec,()=>{throw Error('never dispatched')}),/budget-exhausted/);assert.equal(j.unknown().length,0);j.close();clock=0;j=open(f,{resume:true,now:()=>clock,deadline:1000,hook:stage=>{if(stage==='effect-returned')clock=900;}});assert.throws(()=>j.effect(spec,()=>{fs.writeFileSync(f.counter,'once');return null;}),/budget-exhausted/);assert.equal(j.unknown().length,1);j.close();
});
test('hard page limit checkpoints and resumes without reapplying settled records',t=>{
 const f=fixture(t);let calls=0;const run=j=>j.run({maxRecords:2,next:c=>Number(c||0)<5?{id:String(Number(c||0)+1)}:null,inspect:()=>{},execute:r=>j.effect({kind:'fixture',input:r},()=>{calls++;return null;})});let j=open(f);assert.equal(run(j).cursor,'2');j.close();j=open(f,{resume:true});assert.equal(run(j).cursor,'4');assert.equal(run(j).state,'settled');assert.equal(calls,5);j.close();
});
test('conflicting operation binding and a second operation cannot bypass uncertainty',t=>{
 const f=fixture(t);let j=open(f);assert.throws(()=>j.effect(spec,()=>{throw Error('partial syscall')}),/partial/);j.close();assert.throws(()=>new MaintenanceJournal(f.journal,operation,{...binding,scope:{root:'/foreign'}},{resume:true,deadline:Date.now()+1000}),/identity-conflict/);assert.throws(()=>new MaintenanceJournal(f.journal,second,binding,{deadline:Date.now()+1000}),/other-operation-unsettled/);
});
test('missing, empty and malformed prior journals refuse; actual e2e retained unknown refuses',t=>{
 const f=fixture(t);const sha=x=>{const crypto=process.getBuiltinModule('crypto');return crypto.createHash('sha256').update(x).digest('hex');};
 for(const body of ['', 'not json',JSON.stringify({kind:'original-maintenance-retained-evidence-and-source-format-only',readOnlyReconciliation:{state:'INDETERMINATE_EFFECTS_PRESERVED'}}),JSON.stringify({kind:'maintenance-canonical-reconciliation',originalOperationId:second,state:'settled',effects:[]})]){const file=path.join(f.root,'prior');fs.writeFileSync(file,body);assert.throws(()=>priorDisposition(file,sha(body)),/maintenance-/);}
 const absent=path.join(f.root,'absent.sqlite3');assert.throws(()=>new MaintenanceJournal(absent,operation,binding,{resume:true,deadline:Date.now()+1000}),/journal-unknown/);assert.equal(fs.existsSync(absent),false);
});
test('frozen fetch inputs remain exact on resume despite changed producer refs',t=>{const f=fixture(t);let j=open(f);assert.deepEqual(j.freeze('refs',()=>['a']),['a']);j.close();j=open(f,{resume:true});assert.deepEqual(j.freeze('refs',()=>{throw Error('unbound new ref traversal')}),['a']);j.close();});

test('SQL transition constraints forbid invalid states and terminal overwrite',t=>{const f=fixture(t);let j=open(f);j.effect(spec,()=>null);j.close();const db=new DatabaseSync(f.journal);assert.throws(()=>db.prepare("UPDATE maintenance_effect SET state='uncertain',result=NULL").run(),/invalid-effect-transition/);assert.throws(()=>db.prepare("UPDATE maintenance_effect SET state='invented',result=NULL").run(),/invalid-effect-transition/);db.close();});
test('corrupt on-disk unknown state is a typed error before executing anything',t=>{const f=fixture(t);const j=open(f);j.effect(spec,()=>null);j.close();const db=new DatabaseSync(f.journal);db.exec('DROP TRIGGER maintain_transition; PRAGMA ignore_check_constraints=ON');db.prepare("UPDATE maintenance_effect SET state='future-state'").run();db.close();assert.throws(()=>open(f,{resume:true}),/journal-state-unknown/);});
