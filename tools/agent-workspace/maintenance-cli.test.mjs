import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync,execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {MaintenanceJournal,digest,priorDisposition} from './maintenance-journal.mjs';
const tool=fileURLToPath(new URL('./workspace.mjs',import.meta.url));
const operation='11111111-1111-4111-8111-111111111111',priorOperation='22222222-2222-4222-8222-222222222222';
const sha=x=>createHash('sha256').update(x).digest('hex');
function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'maintenance-cli-offline-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const source=path.join(root,'source'),borrower=path.join(root,'borrower');fs.mkdirSync(source);const git=(...args)=>execFileSync('git',args,{timeout:2000,encoding:'utf8',stdio:['ignore','pipe','pipe']});git('init',source);git('-C',source,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','--allow-empty','-m','fixture');git('clone','--shared',source,borrower);
 const state=path.join(root,'state','registry.sqlite3');fs.mkdirSync(path.dirname(state));const env={...process.env,PI_WORKSPACE_STATE:state,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_SYSTEM:'/dev/null'};
 const cli=args=>spawnSync(fileURLToPath(new URL('./main',import.meta.url)),args,{env,timeout:6000,encoding:'utf8'});
 const register=cli(['register','--path',borrower,'--owner','fixture','--json']);assert.equal(register.status,0,register.stderr);const record=JSON.parse(register.stdout);
 // Reintroduce a normal reference clone only inside this disposable fixture.
 fs.writeFileSync(path.join(borrower,'.git/objects/info/alternates'),path.join(source,'.git/objects')+'\n');git('-C',borrower,'config','core.commitGraph','true');
 const priorJournal=path.join(root,'prior.sqlite3'),prior=new MaintenanceJournal(priorJournal,priorOperation,{scope:{root:null,id:record.id,path:borrower},protocol:1},{deadline:Date.now()+5000});const spec={kind:'fixture-only',input:'original canonical predecessor'};
 prior.run({next:c=>c?null:{id:'previous'},inspect:()=>{},maxRecords:2,execute:()=>prior.effect(spec,()=>({fixture:'settled'}))});prior.close();
 const receipt=path.join(root,'receipt.json');fs.writeFileSync(receipt,JSON.stringify({kind:'maintenance-settled-effect',operationId:priorOperation,effectId:digest(spec),specDigest:digest(spec),resultDigest:digest({fixture:'settled'})}));
 const priorFile=path.join(root,'prior.json');fs.writeFileSync(priorFile,JSON.stringify({kind:'maintenance-canonical-reconciliation',originalOperationId:priorOperation,state:'settled',journal:priorJournal,effects:[{effectId:digest(spec),state:'applied',canonicalReceipt:receipt,receiptSha256:sha(fs.readFileSync(receipt))}]}));
 const args=['maintain','--path',borrower,'--execute','--operation-id',operation,'--budget-ms','5000','--max-records','1','--prior-state',priorFile,'--prior-state-sha256',sha(fs.readFileSync(priorFile)),'--json'];
 return {root,source,borrower,state,env,cli,args,git,record,priorFile};
}
test('actual owning CLI executes only disposable Git effects and checkpoints; exact resume never replays',t=>{
 const f=fixture(t);let run=f.cli(f.args);assert.ok([0,75].includes(run.status),run.stderr);let result=JSON.parse(run.stdout);assert.equal(result.operationId,operation);assert.equal(result.state,'checkpointed');
 const db=new DatabaseSync(path.join(path.dirname(f.state),'maintenance-journal.sqlite3'));const effects=db.prepare('SELECT * FROM maintenance_effect').all();const specs=effects.map(row=>JSON.parse(row.spec));assert.ok(specs.some(spec=>spec.kind==='alternates-replacement'));assert.ok(specs.some(spec=>spec.kind==='git'&&spec.input.args.includes('fetch')));assert.ok(effects.every(row=>row.state==='settled'));const eventCount=db.prepare('SELECT count(*) AS n FROM maintenance_event').get().n;
 run=f.cli([...f.args,'--resume']);assert.equal(run.status,0,run.stderr);assert.equal(JSON.parse(run.stdout).state,'settled');assert.equal(db.prepare('SELECT count(*) AS n FROM maintenance_event').get().n,eventCount);assert.equal(f.git('-C',f.borrower,'config','core.commitGraph').trim(),'false');assert.ok(fs.readFileSync(path.join(f.borrower,'.git/objects/info/alternates'),'utf8').includes('/mirrors/'));db.close();
});
test('actual CLI cannot accept empty stdout or original retained indeterminate record as a prior journal',t=>{
 const f=fixture(t);const original=path.join(f.root,'original.json');for(const text of ['',JSON.stringify({kind:'original-maintenance-retained-evidence-and-source-format-only'})]){fs.writeFileSync(original,text);const args=[...f.args];args[args.indexOf('--prior-state')+1]=original;args[args.indexOf('--prior-state-sha256')+1]=sha(text);const run=f.cli(args);assert.notEqual(run.status,0);assert.match(run.stderr,/maintenance-(prior-state-unknown|original-effects-indeterminate)/);assert.equal(f.git('-C',f.borrower,'config','core.commitGraph').trim(),'true');}
});
test('prior canonical report with forged receipt or omitted effect does not authorize future execution',t=>{const f=fixture(t);const v=JSON.parse(fs.readFileSync(f.priorFile));v.effects[0].receiptSha256='0'.repeat(64);fs.writeFileSync(f.priorFile,JSON.stringify(v));assert.throws(()=>priorDisposition(f.priorFile,sha(fs.readFileSync(f.priorFile))),/evidence-conflict/);v.effects=[];fs.writeFileSync(f.priorFile,JSON.stringify(v));assert.throws(()=>priorDisposition(f.priorFile,sha(fs.readFileSync(f.priorFile))),/prior-state-unknown/);});
test('actual CLI requires explicit finite budgets and operation identity, no implicit maintenance retry',t=>{const f=fixture(t);for(const args of [['maintain','--path',f.borrower,'--execute'],['maintain','--path',f.borrower,'--execute','--budget-ms','50000','--max-records','1']]){const run=f.cli(args);assert.notEqual(run.status,0);assert.match(run.stderr,/maintenance-explicit-bounds-required/);}assert.equal(f.git('-C',f.borrower,'config','core.commitGraph').trim(),'true');});

test('owning CLI command deadline kills inherited-pipe grandchild; original effect stays uncertain, never replayed',t=>{
 const f=fixture(t),bin=path.join(f.root,'bin'),marker=path.join(f.root,'partial-effect');fs.mkdirSync(bin);
 const real=execFileSync('which',['git'],{timeout:1000,encoding:'utf8'}).trim();
 const wrapper=path.join(bin,'git');fs.writeFileSync(wrapper,`#!${process.execPath}\nconst fs=require('node:fs'),cp=require('node:child_process'),args=process.argv.slice(2);if(args.includes('--replace-all')){fs.writeFileSync(${JSON.stringify(marker)},'dispatched');const child=cp.spawn(process.execPath,['-e','setTimeout(()=>{},20000)'],{stdio:'inherit'});fs.writeFileSync(${JSON.stringify(marker+'.pid')},String(child.pid));setTimeout(()=>{},20000);}else{const r=cp.spawnSync(${JSON.stringify(real)},args,{stdio:'inherit'});process.exit(r.status??1);}`);fs.chmodSync(wrapper,0o755);
 const args=[...f.args];args[args.indexOf('--budget-ms')+1]='5000';const start=Date.now();const run=spawnSync(fileURLToPath(new URL('./main',import.meta.url)),args,{env:{...f.env,PATH:bin+':'+f.env.PATH},timeout:7000,encoding:'utf8'});
 assert.equal(run.status,75,run.stderr);assert.ok(Date.now()-start<6500);assert.equal(JSON.parse(run.stdout).state,'uncertain');assert.equal(fs.readFileSync(marker,'utf8'),'dispatched');
 const pid=Number(fs.readFileSync(marker+'.pid','utf8'));const alive=()=>{try{return !['Z','X'].includes(fs.readFileSync('/proc/'+pid+'/stat','utf8').slice(fs.readFileSync('/proc/'+pid+'/stat','utf8').lastIndexOf(')')+2).split(' ')[0]);}catch(error){if(error.code==='ENOENT')return false;throw error;}};for(let n=0;n<40&&alive();n++)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5);assert.equal(alive(),false,'owned grandchild continued after worker returned');
 const db=new DatabaseSync(path.join(path.dirname(f.state),'maintenance-journal.sqlite3'));assert.equal(db.prepare("SELECT count(*) AS n FROM maintenance_effect WHERE state='uncertain'").get().n,1);db.close();
});

test('outer whole-worker bound covers a synchronous prior-journal read that never returns',t=>{
 const f=fixture(t),preload=path.join(f.root,'hang-read.mjs'),marker=path.join(f.root,'read-entered');
 fs.writeFileSync(preload,`import fs from 'node:fs';const read=fs.readFileSync;fs.readFileSync=function(file,...args){if(typeof file==='number'&&process.env.PI_WORKSPACE_MAINTAIN_WORKER){fs.writeFileSync(${JSON.stringify(marker)},'read-entered');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20000);}return read.call(this,file,...args);};`);
 const args=[...f.args];args[args.indexOf('--budget-ms')+1]='1000';const started=Date.now();const run=spawnSync(fileURLToPath(new URL('./main',import.meta.url)),args,{env:{...f.env,NODE_OPTIONS:'--import='+preload},encoding:'utf8',timeout:5000});assert.equal(run.status,75,run.stderr);assert.equal(JSON.parse(run.stdout).state,'unknown');assert.ok(Date.now()-started<3500);assert.equal(fs.readFileSync(marker,'utf8'),'read-entered');
});

test('a real settled predecessor for another scope cannot clear this maintenance scope',t=>{const f=fixture(t);const db=new DatabaseSync(path.join(f.root,'prior.sqlite3'));db.prepare('UPDATE maintenance_operation SET binding=?').run(JSON.stringify({scope:{root:'/foreign',id:null,path:null},protocol:1}));db.close();const run=f.cli(f.args);assert.notEqual(run.status,0);assert.match(run.stderr,/maintenance-prior-scope-conflict/);assert.equal(f.git('-C',f.borrower,'config','core.commitGraph').trim(),'true');});
