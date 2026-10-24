import {test} from 'node:test';
import assert from 'node:assert/strict';
import {finalizeTerminal,completedOneshot} from './terminal-finalizer.mjs';
const unit={unit:'finished.service',invocationId:'a'.repeat(32),manager:'user'};
const inert={InvocationID:unit.invocationId,Type:'oneshot',RemainAfterExit:'yes',Restart:'no',ActiveState:'active',SubState:'exited',MainPID:'0',ControlPID:'0',ControlGroup:'',ExecStop:'',ExecStopPost:'',TriggeredBy:'',Triggers:'',Result:'success'};
function fixture(){
 const binding={owner:'owner',path:'/preserve-unpublished',planSha256:'1'};
 const request={kind:'terminal-growth-finalization',owner:'owner',path:binding.path,frozen:false,futureWrites:'none',deleteSource:false,units:[unit],holder:{bootId:'boot',cgroup:'/finished.service'},disposition:{kind:'retire-future-growth',binding,retainedUse:'source',remainingGrowthBytes:0,growthWriters:'none',writingLease:'retire',reason:'complete',ownerEvidence:'original explicit owner receipt',observedAt:100}};
 let stops=0,retires=0;const io={now:()=>100,bootId:()=>'boot',growth:async()=>({binding,plan:{}}),show:async()=>stops?{...inert,ActiveState:'inactive',SubState:'dead'}:inert,stop:async()=>{stops++},cessation:async()=>({complete:true,members:[],bootId:'boot',cgroup:'/finished.service'}),safety:async()=>({safety:{references:[],errors:[]}}),retire:async()=>{retires++;return {ok:true}}};return {request,io,counts:()=>({stops,retires})};
}
test('terminal finalizer retires only native budget, never source/rollback/dependencies',async()=>{const f=fixture();const r=await finalizeTerminal(f.request,f.io);assert.equal(r.state,'retired');assert.equal(r.sourceDeleted,false);assert.deepEqual(f.counts(),{stops:1,retires:1});});
for(const [key,value] of Object.entries({MainPID:'44',ControlPID:'45',ControlGroup:'/live',InvocationID:'b'.repeat(32),ExecStop:'delete',ExecStopPost:'cleanup',Restart:'always',TriggeredBy:'timer',Type:'simple',Result:'failed',SubState:'running'}))test('reject unit '+key,()=>assert.throws(()=>completedOneshot(unit,{...inert,[key]:value})));
for(const patch of [{frozen:true},{deleteSource:true},{futureWrites:'maybe'},{owner:'other'},{holder:{bootId:'other'}}])test('preservation/owner refusal '+JSON.stringify(patch),async()=>{const f=fixture();Object.assign(f.request,patch);await assert.rejects(finalizeTerminal(f.request,f.io));assert.deepEqual(f.counts(),{stops:0,retires:0});});
test('concurrent new writer after oneshot cleanup prevents retirement',async()=>{const f=fixture();f.io.safety=async()=>({safety:{references:[{pid:99}],errors:[]}});await assert.rejects(finalizeTerminal(f.request,f.io),{code:'growth-writer-active'});assert.equal(f.counts().retires,0);});
test('unit restarts between preflight and effect, never stopped',async()=>{const f=fixture();let calls=0;f.io.show=async()=>++calls===1?inert:{...inert,MainPID:'99'};await assert.rejects(finalizeTerminal(f.request,f.io));assert.deepEqual(f.counts(),{stops:0,retires:0});});
test('original descendant or unknown census never authorizes retirement',async()=>{for(const cessation of [{complete:false,members:[]},{complete:true,members:[88]}]){const f=fixture();f.io.cessation=async()=>cessation;await assert.rejects(finalizeTerminal(f.request,f.io));assert.equal(f.counts().retires,0);}});
test('concurrent plan edit refuses before stopping a unit',async()=>{const f=fixture();f.io.growth=async()=>({binding:{...f.request.disposition.binding,planSha256:'new'}});await assert.rejects(finalizeTerminal(f.request,f.io));assert.equal(f.counts().stops,0);});

test('native adapter retires real private SQLite/Git fixture while preserving unpublished source and dependencies',async()=>{
 const fs=await import('node:fs'),os=await import('node:os'),path=await import('node:path');
 const {execFileSync}=await import('node:child_process');const {DatabaseSync}=await import('node:sqlite');
 const {main}=await import('./workspace.mjs');const {digest}=await import('./growth-lifecycle.mjs');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'terminal-finalizer-native-')),source=path.join(root,'source'),state=path.join(root,'registry.sqlite3');
 const old=process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY;process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY='empty';
 try {
  fs.mkdirSync(source);const git=(...args)=>execFileSync('git',args,{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  git('init',source);fs.writeFileSync(path.join(source,'proof'),'unpublished source');fs.writeFileSync(path.join(source,'.gitignore'),'node_modules/\n');git('-C',source,'add','.');git('-C',source,'-c','user.name=Fixture','-c','user.email=fixture@invalid','commit','-m','unpublished');
  fs.mkdirSync(path.join(source,'node_modules'));fs.writeFileSync(path.join(source,'node_modules','keep'),'operator dependency');const head=git('-C',source,'rev-parse','HEAD');
  const run=args=>{let text='';const write=process.stdout.write,exit=process.exitCode;process.stdout.write=c=>{text+=c;return true;};try{main(args,state);return JSON.parse(text);}finally{process.stdout.write=write;process.exitCode=exit;}};
  const r=run(['register','--path',source,'--root',root,'--owner','owner','--source-commit',head,'--json']);
  const db=new DatabaseSync(state);const dev=String(fs.statSync(source).dev);db.prepare('INSERT INTO workspace_capacity(workspace_id,device_id,plan_json) VALUES(?,?,?)').run(r.id,dev,JSON.stringify({intent:'budgeted',constructionBytes:4096,growthBytes:1000000,headroomBytes:8*1024**3,completedAllocationBytes:4096}));db.close();
  run(['measure-capacity','--id',r.id,'--json']);const growth=()=>run(['growth-status','--id',r.id,'--path',source,'--json']);
  const f=fixture();Object.assign(f.request,{path:source,owner:'owner'});f.request.disposition.binding=growth().binding;f.request.disposition.observedAt=Date.now();f.io.now=Date.now;f.io.growth=growth;
  f.io.retire=()=>{const file=path.join(root,'disposition.json'),text=JSON.stringify(f.request.disposition);fs.writeFileSync(file,text);return run(['retire-growth','--id',r.id,'--path',source,'--owner','owner','--disposition',file,'--disposition-sha256',digest(text),'--json']);};
  const result=await finalizeTerminal(f.request,f.io);assert.equal(result.state,'retired');assert.equal(growth().plan.growthLifecycle.remainingGrowthBytes,0);
  assert.equal(fs.readFileSync(path.join(source,'proof'),'utf8'),'unpublished source');assert.equal(fs.readFileSync(path.join(source,'node_modules','keep'),'utf8'),'operator dependency');assert.equal(git('-C',source,'rev-parse','HEAD'),head);
 } finally {if(old===undefined)delete process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY;else process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY=old;fs.rmSync(root,{recursive:true,force:true});}
});
