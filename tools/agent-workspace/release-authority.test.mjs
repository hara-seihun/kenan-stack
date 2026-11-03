import './scratch-env.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync,spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const workspaceModule=process.env.WORKSPACE_RELEASE_MODULE??new URL('./workspace.mjs',import.meta.url).href;
const {main,workspaceTesting}=await import(workspaceModule);
import {bindNativeOwner,unbindNativeOwner,nativeOwnerBinding,nativeCaller} from './native-owner.mjs';
import {releaseCaller,authorizeWorkspaceRelease} from './release-authority.mjs';

const PARENT='11111111-1111-4111-8111-111111111111';
const CHILD='22222222-2222-4222-8222-222222222222';
const identity=agentId=>({agentId,channel:'beta',callId:'call-'+agentId});
const authenticate=pairs=>({errors:[],confirmed:new Map(pairs.map(p=>[p.agentId+'\0'+p.callId,['beta']]))});
const authority=(agentId,more={})=>({delegate:()=>({allowed:false}),caller:()=>({ok:true,kind:'native',binding:identity(agentId)}),authenticate,...more});
const args=entries=>({positional:[],named:new Map(entries.map(([k,v])=>[k,[String(v)]]))});
function capture(action) {
  let out='';const write=process.stdout.write,exit=process.exitCode;
  process.stdout.write=x=>{out+=x;return true;};
  try {action();return {result:JSON.parse(out),exitCode:process.exitCode};}
  finally {process.stdout.write=write;process.exitCode=exit;}
}
function fixture(action) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'release-authority-'));
  const remote=path.join(root,'remote.git'),source=path.join(root,'source'),state=path.join(root,'registry.sqlite3');
  const old=process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY;process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY='empty';
  const git=(...a)=>execFileSync('git',a,{encoding:'utf8',timeout:5000,stdio:['ignore','pipe','pipe']}).trim();
  let db;
  try {
    git('init','--bare',remote);git('clone',remote,source);git('-C',source,'checkout','-b','main');
    git('-C',source,'config','user.name','Fixture');git('-C',source,'config','user.email','fixture@example.invalid');
    fs.writeFileSync(path.join(source,'proof'),'parent source');fs.writeFileSync(path.join(source,'.gitignore'),'node_modules/\n');
    git('-C',source,'add','.');git('-C',source,'commit','-m','published source');git('-C',source,'push','origin','main');
    const register=(dir,owner='parent-task',group=[])=>capture(()=>main(['register','--path',dir,'--root',root,'--owner',owner,...group,'--json'],state)).result;
    const record=register(source);db=workspaceTesting.openRegistry(state);
    const bind=(r=record,owner=PARENT)=>bindNativeOwner(db,r.id,identity(owner),'caller-scope',{fixture:true});bind();
    fs.mkdirSync(path.join(source,'node_modules'));fs.writeFileSync(path.join(source,'node_modules','cache'),'valuable cache');
    const invoke=(dependencies,extra=[])=>capture(()=>workspaceTesting.releaseCommand(db,args([['id',record.id],['json',true],['preserve-runtime',true],...extra]),state,dependencies));
    const sql=()=>Object.fromEntries(db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(({name})=>[name,db.prepare('SELECT * FROM '+JSON.stringify(name)+' ORDER BY rowid').all()]));
    const files=(dir=source)=> {
      const values=[];
      const walk=p=> {const s=fs.lstatSync(p);values.push({path:path.relative(dir,p),ino:s.ino,mode:s.mode,mtime:s.mtimeMs,
        content:s.isFile()?createHash('sha256').update(fs.readFileSync(p)).digest('hex'):s.isSymbolicLink()?fs.readlinkSync(p):null});
        if(s.isDirectory())for(const name of fs.readdirSync(p).sort())walk(path.join(p,name));};walk(dir);return values;
    };
    const snapshot=()=>({rows:sql(),files:files()});
    action({root,remote,source,state,record,db,git,register,bind,invoke,snapshot,files});
  } finally {db?.close();if(old===undefined)delete process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY;else process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY=old;fs.rmSync(root,{recursive:true,force:true});}
}

for(const registered of ['parent-task',PARENT])for(const flags of [[],[['reap-expired',true]],[['end-retention',true],['owner',registered],['expected-plan-sha256','a'.repeat(64)]]])
  test('a child cannot release '+registered+' custody with '+JSON.stringify(flags),()=>fixture(f=>{
    f.db.prepare('UPDATE workspace SET owner=? WHERE id=?').run(registered,f.record.id);
    const before=f.snapshot();assert.ok(before.rows.workspace[0].lease_expires_at>Date.now());
    const result=f.invoke(authority(CHILD),flags);
    assert.equal(result.exitCode,2);assert.equal(result.result.error.code,'release-owner-mismatch');
    assert.deepEqual(f.snapshot(),before,'a rejected release must not change any registry row or checkout inode/bytes');
  }));

test('the authenticated owner still performs an ordinary published source release',()=>fixture(f=>{
  const result=f.invoke(authority(PARENT));assert.equal(result.result.record.state,'released',JSON.stringify(result));
  assert.equal(fs.existsSync(f.source),false);assert.equal(result.result.leaseRelease.kind,'released');
}));
test('an authentic non-native operator keeps the historical release route',()=>fixture(f=>{
  const result=f.invoke({caller:()=>({ok:true,kind:'operator'}),authenticate:()=>assert.fail('non-native operator has no native call')});
  assert.equal(result.result.record.state,'released');assert.equal(fs.existsSync(f.source),false);
}));
for(const caller of [PARENT,CHILD])test('mixed group custody protects every member from caller '+caller,()=>fixture(f=>{
  const peer=path.join(f.root,'peer');f.git('clone',f.remote,peer);f.git('-C',peer,'checkout','main');
  const second=f.register(peer,'child-task',['--group','paired']);f.bind(second,CHILD);
  f.db.prepare('UPDATE workspace SET group_id=? WHERE id=?').run('paired',f.record.id);
  const before=f.snapshot(),peerBefore=f.files(peer);
  const result=f.invoke(authority(caller));assert.equal(result.result.error.code,'release-owner-mismatch');
  assert.deepEqual(f.snapshot(),before);assert.deepEqual(f.files(peer),peerBefore);
}));
test('caller authentication failure refuses before lease, release-journal or filesystem changes',()=>fixture(f=>{
  for(const authenticate of [()=>({errors:['database unavailable'],confirmed:new Map()}),()=>({errors:[],confirmed:new Map()}),
    pairs=>({errors:[],confirmed:new Map(pairs.map(p=>[p.agentId+'\0'+p.callId,['beta','production']]))})]) {
    const before=f.snapshot();assert.equal(f.invoke(authority(PARENT,{authenticate})).result.error.code,'release-caller-unverified');assert.deepEqual(f.snapshot(),before);
  }
}));
test('unbound historical admission receipts are authenticated read-only, never rebound on rejection',()=>fixture(f=>{
  unbindNativeOwner(f.db,f.record.id);
  const request='{"task":"parent"}';f.db.prepare('UPDATE workspace SET creation_request=? WHERE id=?').run(request,f.record.id);
  const job=path.join(f.root,'checkout-jobs',f.record.id,'original-job');fs.mkdirSync(job,{recursive:true});
  fs.writeFileSync(path.join(job,'environment.json'),JSON.stringify({KENAN_AGENT:PARENT,KENAN_TOOL_CALL_ID:'admission-call'}));
  fs.writeFileSync(path.join(job,'request.json'),JSON.stringify({id:f.record.id,request}));
  const before=f.snapshot();assert.equal(f.invoke(authority(CHILD)).result.error.code,'release-owner-mismatch');assert.deepEqual(f.snapshot(),before);
  assert.deepEqual(nativeOwnerBinding(f.db,f.record.id),{state:'unset'});
  assert.equal(f.invoke(authority(PARENT)).result.record.state,'released');
}));
test('unknown, conflicting or unconfirmed ownership is not an implicit grant to a native caller',()=>fixture(f=>{
  unbindNativeOwner(f.db,f.record.id);
  let before=f.snapshot();assert.equal(f.invoke(authority(CHILD)).result.error.code,'release-owner-unbound');assert.deepEqual(f.snapshot(),before);
  f.db.prepare('UPDATE workspace SET creation_request=? WHERE id=?').run('original',f.record.id);
  const job=path.join(f.root,'checkout-jobs',f.record.id,'job');fs.mkdirSync(job,{recursive:true});
  fs.writeFileSync(path.join(job,'environment.json'),JSON.stringify({KENAN_AGENT:PARENT,KENAN_TOOL_CALL_ID:'old-call'}));
  fs.writeFileSync(path.join(job,'request.json'),JSON.stringify({id:f.record.id,request:'wrong'}));
  before=f.snapshot();assert.equal(f.invoke(authority(CHILD)).result.error.code,'release-owner-unverified');assert.deepEqual(f.snapshot(),before);
  fs.writeFileSync(path.join(job,'request.json'),JSON.stringify({id:f.record.id,request:'original'}));before=f.snapshot();
  const onlyCaller=pairs=>authenticate(pairs.filter(p=>p.callId!=='old-call'));
  assert.equal(f.invoke(authority(CHILD,{authenticate:onlyCaller})).result.error.code,'release-owner-unverified');assert.deepEqual(f.snapshot(),before);
}));
test('registered native custody takes precedence over a different creating caller binding',()=>fixture(f=>{
  f.db.prepare('UPDATE workspace SET owner=? WHERE id=?').run(PARENT,f.record.id);f.bind(f.record,CHILD);
  const before=f.snapshot();assert.equal(f.invoke(authority(CHILD)).result.error.code,'release-owner-mismatch');assert.deepEqual(f.snapshot(),before);
  assert.equal(f.invoke(authority(PARENT)).result.record.state,'released');
}));
test('the ordinary retained-growth continuation authenticates custody before terminal release',()=>fixture(f=>{
  f.db.prepare('UPDATE workspace SET owner=?,source_commit=? WHERE id=?').run(PARENT,f.git('-C',f.source,'rev-parse','HEAD'),f.record.id);
  f.bind(f.record,CHILD);
  fs.writeFileSync(path.join(f.source,'proof'),'unpublished parent work');f.git('-C',f.source,'commit','-am','parent work');
  const stat=fs.statSync(f.source),now=Date.now();
  const plan={intent:'budgeted',estimate:'whole-tree-upper-bound',constructionBytes:4096,growthBytes:4*1024**3,headroomBytes:8*1024**3,completedAllocationBytes:4096};
  f.db.prepare('INSERT OR REPLACE INTO workspace_capacity(workspace_id,device_id,plan_json) VALUES(?,?,?)').run(f.record.id,String(stat.dev),JSON.stringify(plan));
  f.db.prepare('INSERT OR REPLACE INTO workspace_capacity_measurement VALUES(?,?)').run(f.record.id,JSON.stringify({ok:true,bytes:4096,allocatedBytes:4096,device:String(stat.dev),inode:String(stat.ino),startedAt:now,completedAt:now}));
  const first=f.invoke(authority(PARENT)).result;assert.equal(first.futureGrowthSettlement.kind,'retired',JSON.stringify(first));
  assert.equal(first.record.state,'repair-required');assert.equal(first.leaseRelease.expiresAt,0);
  f.git('-C',f.source,'push','origin','HEAD:refs/heads/main');
  const before=f.snapshot();
  assert.equal(f.invoke(authority(CHILD)).result.error.code,'release-owner-mismatch');assert.deepEqual(f.snapshot(),before);
  const done=f.invoke(authority(PARENT)).result;assert.equal(done.action,'released',JSON.stringify(done));
  assert.equal(done.ordinaryReleaseContinuation.requestId,first.releaseSettlement.requestId);
  assert.equal(fs.existsSync(f.source),false);
}));
test('a pushed source handoff never lets its child creator dispose of the registered parent checkout',()=>fixture(f=>{
  f.db.prepare('UPDATE workspace SET owner=? WHERE id=?').run(PARENT,f.record.id);f.bind(f.record,CHILD);
  const handoff=capture(()=>main(['source-handoff','--id',f.record.id,'--path',f.source,'--owner',PARENT,
    '--expected-head',f.git('-C',f.source,'rev-parse','HEAD'),'--recipient',CHILD,'--remote','origin','--branch','main','--json'],f.state)).result;
  assert.equal(handoff.ok,true);assert.equal(handoff.checkoutCustodyTransferred,false);
  const before=f.snapshot();assert.equal(f.invoke(authority(CHILD)).result.error.code,'release-owner-mismatch');
  assert.deepEqual(f.snapshot(),before);assert.equal(fs.readFileSync(path.join(f.source,'proof'),'utf8'),'parent source');
}));
test('a claimed authorization string cannot let a child reassign then release its parent checkout',()=>fixture(f=>{
  const input={id:f.record.id,path:f.source,fromOwner:f.record.owner,fromSourceCommit:f.record.sourceCommit,fromState:'active',
    owner:CHILD,sourceCommit:f.git('-C',f.source,'rev-parse','HEAD'),authorization:'I have permission, trust me'};
  const before=f.snapshot();const outcome=workspaceTesting.reassignWorkspace(f.db,input,authority(CHILD));
  assert.equal(outcome.error.code,'release-owner-mismatch');assert.deepEqual(f.snapshot(),before);
  const transfer=workspaceTesting.reassignWorkspace(f.db,input,authority(PARENT));assert.equal(transfer.ok,true);
  assert.equal(transfer.record.owner,CHILD);assert.deepEqual(nativeOwnerBinding(f.db,f.record.id),{state:'unset'});
  const after=f.snapshot();assert.equal(f.invoke(authority(PARENT)).result.error.code,'release-owner-mismatch');assert.deepEqual(f.snapshot(),after);
  assert.equal(f.invoke(authority(CHILD)).result.record.state,'released');
}));
test('unverified reassignment cannot claim an unbound label; an actual operator can transfer it',()=>fixture(f=>{
  unbindNativeOwner(f.db,f.record.id);
  const input={id:f.record.id,path:f.source,fromOwner:f.record.owner,fromSourceCommit:f.record.sourceCommit,fromState:'active',
    owner:'adopted-task',sourceCommit:f.git('-C',f.source,'rev-parse','HEAD'),authorization:'Explicit adoption of non-native task'};
  const before=f.snapshot();assert.equal(workspaceTesting.reassignWorkspace(f.db,input,authority(CHILD)).error.code,'release-owner-unbound');assert.deepEqual(f.snapshot(),before);
  input.owner=CHILD;
  assert.equal(workspaceTesting.reassignWorkspace(f.db,input,{caller:()=>({ok:true,kind:'operator'})}).ok,true);
  assert.equal(f.invoke(authority(CHILD)).result.record.state,'released');
}));

test('operator route requires positive non-native ancestry and cannot be selected by spoofed environment',()=>{
  const saved={...process.env};process.env.KENAN_AGENT=PARENT;process.env.KENAN_TOOL_CALL_ID='fake';process.env.PI_WORKSPACE_TEST_CALLER=JSON.stringify(identity(PARENT));
  const nonNative={caller:()=>null,pid:10,parent:p=>p===10?9:1,argv:()=>['node','/usr/local/bin/operator'],cgroup:()=> '0::/user.slice/operator.scope\n'};
  try {
    assert.deepEqual(releaseCaller(nonNative),{ok:true,kind:'operator'});
    assert.equal(releaseCaller({...nonNative,cgroup:()=> '0::/user.slice/agent-tool-beta-example.scope\n'}).error.code,'release-caller-unverified');
    assert.equal(releaseCaller({...nonNative,argv:p=>p===9?['node','/srv/kenan/beta/dist/server/main.js']:['bash']}).error.code,'release-caller-unverified');
    assert.equal(releaseCaller({...nonNative,cgroup:()=>{throw Error('unreadable');}}).error.code,'release-caller-unverified');
    assert.equal(releaseCaller({...nonNative,parent:()=>10}).error.code,'release-caller-unverified');
    assert.deepEqual(releaseCaller({caller:()=>identity(CHILD)}),{ok:true,kind:'native',binding:identity(CHILD)});
  } finally {process.env=saved;}
});
test('rejected authorization does not create an ownership table in a historical registry',()=>fixture(f=>{
  f.db.exec('DROP TABLE workspace_native_owner');const before=f.snapshot();
  const result=authorizeWorkspaceRelease(f.db,[f.record],f.state,authority(CHILD));assert.equal(result.error.code,'release-owner-unbound');assert.deepEqual(f.snapshot(),before);
}));

test('the actual native CLI rejects a foreign registered custodian without changing its checkout',t=>{
  const self=nativeCaller();
  if(self===null){t.skip('This proof requires an actual native tool scope; the synthetic route checks still run.');return;}
  fixture(f=>{
    const foreign=self.agentId===PARENT?CHILD:PARENT;
    f.db.prepare('UPDATE workspace SET owner=? WHERE id=?').run(foreign,f.record.id);
    const before=f.snapshot();
    const cli=new URL(workspaceModule).pathname;
    // Clear all purported identity overrides: the real root scope, not these variables,
    // must identify this process and the exact current native message-store call.
    const env={...process.env,PI_WORKSPACE_STATE:f.state,KENAN_AGENT:foreign,KENAN_TOOL_CALL_ID:'forged',PI_WORKSPACE_TEST_CALLER:JSON.stringify(identity(foreign))};
    const result=spawnSync(process.execPath,[cli,'release','--path',f.source,'--json'],{env,encoding:'utf8',timeout:30000});
    assert.equal(result.status,2,result.stderr);assert.equal(JSON.parse(result.stdout).error.code,'release-owner-mismatch',result.stdout);
    assert.deepEqual(f.snapshot(),before);
    const plain=spawnSync(process.execPath,[cli,'release','--path',f.source],{env,encoding:'utf8',timeout:30000});
    assert.equal(plain.status,2);assert.equal(plain.stdout,'');assert.match(plain.stderr,/release-owner-mismatch/);
    assert.deepEqual(f.snapshot(),before);
  });
});

test('the actual native CLI releases its own pushed source with identity environment variables absent',t=>{
  const self=nativeCaller();
  if(self===null){t.skip('This proof requires an actual native tool scope; the synthetic route checks still run.');return;}
  fixture(f=>{
    // Only disposable fixture custody changes here. The current real scope and native
    // message store, not injected caller or authentication functions, authorize the CLI.
    f.db.prepare('UPDATE workspace SET owner=? WHERE id=?').run(self.agentId,f.record.id);
    unbindNativeOwner(f.db,f.record.id);
    const env={...process.env,PI_WORKSPACE_STATE:f.state};
    for(const key of ['KENAN_TOOL_CALL_ID','PI_WORKSPACE_TEST_CALLER'])delete env[key];
    // The background event router needs an address, not an authentication grant.
    // nativeCaller still binds this address to the real root scope and native store.
    env.KENAN_AGENT=self.agentId;
    const result=spawnSync(process.execPath,[new URL(workspaceModule).pathname,'release','--path',f.source,'--json'],{env,encoding:'utf8',timeout:30000});
    const submission=JSON.parse(result.stdout);
    if(result.status===75){
      assert.equal(submission.action,'release-submitted',result.stdout);assert.ok(submission.launch?.started,result.stdout);
      const deadline=Date.now()+30000;
      while(fs.existsSync(f.source)&&Date.now()<deadline)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,100);
      const status=spawnSync(process.execPath,[new URL(workspaceModule).pathname,'status','--id',f.record.id,'--json'],{env,encoding:'utf8',timeout:5000});
      assert.equal(status.status,0,status.stderr);const record=JSON.parse(status.stdout).records[0];
      assert.equal(record.state,'released',status.stdout);assert.equal(record.releaseSettlement.kind,'completed');assert.equal(record.releaseSettlement.result.physicalDisposition.kind,'removed');
    }else{
      assert.equal(result.status,0,result.stderr+'\n'+result.stdout);
      // A native foreground call reports its background release once it completed (October 29).
      if(submission.action==='release-completed'){assert.equal(submission.completed,true);assert.equal(submission.releaseSettlement.result.physicalDisposition.kind,'removed');}
      else {assert.equal(submission.action,'released');assert.equal(submission.leaseRelease.kind,'released');}
    }
    assert.equal(fs.existsSync(f.source),false);
  });
});

test('caller authentication exposes sanitized query cause and channel count without private SQL',()=>fixture(f=>{
 const result=f.invoke(authority(PARENT,{authenticate:()=>({errors:['native tool-call observation unavailable: beta: ERROR: cannot extract elements from a scalar'],confirmed:new Map()})}));
 assert.equal(result.result.error.code,'release-caller-unverified');
 assert.equal(result.result.diagnostic.code,'caller-tool-store-unavailable');
 assert.equal(result.result.diagnostic.channelCount,0);
 assert.match(result.result.diagnostic.errors[0],/cannot extract elements from a scalar/);
}));


test('reassign reports every missing binding and the authorization evidence source without mutation',()=>fixture(f=>{
  const before=f.snapshot();
  assert.throws(()=>main(['reassign','--id',f.record.id,'--owner',CHILD,'--json'],f.state),error=>{
    for(const flag of ['path','from-owner','from-source-commit','from-state','source-commit','authorization'])assert.ok(error.message.includes('--'+flag),error.message);
    assert.match(error.message,/existing task, message or handoff evidence/);
    assert.match(error.message,/not a separately issued credential/);
    assert.match(error.message,/authenticated current custodian/);
    return true;
  });
  assert.deepEqual(f.snapshot(),before);
}));

test('a caller whose tool-call row lands a moment late is still authenticated',()=>fixture(f=>{
  let calls=0;
  const late=pairs=>++calls<3?{errors:[],confirmed:new Map()}:authenticate(pairs);
  const result=authorizeWorkspaceRelease(f.db,[f.record],f.state,authority(PARENT,{authenticate:late}));
  assert.equal(result.ok,true);assert.equal(calls,3);
}));

test('a tool call that never appears is refused after the bounded wait',()=>fixture(f=>{
  const never=()=>({errors:[],confirmed:new Map()});
  const started=Date.now();
  const result=authorizeWorkspaceRelease(f.db,[f.record],f.state,authority(PARENT,{authenticate:never,confirmWaitMs:600}));
  assert.equal(result.error.code,'release-caller-unverified');assert.ok(Date.now()-started>=500);
}));

// November 2: manager-owned checkouts must be releasable by the worker doing its work.
test('an authenticated delegated worker releases published manager custody without reassigning it',()=>fixture(f=>{
 f.db.prepare('UPDATE workspace SET owner=? WHERE id=?').run('manager:converge',f.record.id);
 const result=f.invoke(authority(CHILD,{delegate:(binding,owner)=>{
  assert.equal(binding.agentId,CHILD);assert.equal(owner,'manager:converge');return {allowed:true,kind:'custodian-child'};
 }})).result;
 assert.equal(result.action,'released',JSON.stringify(result));assert.equal(result.record.owner,'manager:converge');
 assert.equal(fs.existsSync(f.source),false);
 assert.equal(f.db.prepare('SELECT count(*) AS n FROM workspace_reassignment').get().n,0);
}));
test('delegated ordinary cleanup never grants reassignment or explicit end-retention authority',()=>fixture(f=>{
 const deps=authority(CHILD,{delegate:()=>({allowed:true,kind:'custodian-goal'})});
 const input={id:f.record.id,path:f.source,fromOwner:f.record.owner,fromSourceCommit:f.record.sourceCommit,fromState:'active',
  owner:CHILD,sourceCommit:f.git('-C',f.source,'rev-parse','HEAD'),authorization:'a shared goal is not a source transfer'};
 const before=f.snapshot();assert.equal(workspaceTesting.reassignWorkspace(f.db,input,deps).error.code,'release-owner-mismatch');assert.deepEqual(f.snapshot(),before);
 const result=f.invoke(deps,[['end-retention',true],['owner',f.record.owner],['expected-plan-sha256','a'.repeat(64)]]);
 assert.equal(result.result.error.code,'release-owner-mismatch');assert.deepEqual(f.snapshot(),before);
}));
test('delegated cleanup preserves dirty manager work in the normal recovery archive',()=>fixture(f=>{
 f.db.prepare('UPDATE workspace SET owner=? WHERE id=?').run('manager:converge',f.record.id);
 fs.writeFileSync(path.join(f.source,'proof'),'unpublished manager work');
 const result=f.invoke(authority(CHILD,{delegate:()=>({allowed:true})})).result;
 assert.equal(result.physicalDisposition.kind,'removed',JSON.stringify(result));
 assert.equal(execFileSync('tar',['--zstd','-xOf',result.workingTreeArchive,'proof'],{encoding:'utf8'}),'unpublished manager work');
}));
test('a shared goal does not cross an authenticated custody channel',()=>fixture(f=>{
 bindNativeOwner(f.db,f.record.id,{...identity(PARENT),channel:'production'},'caller-scope',{});
 const before=f.snapshot();
 const result=f.invoke(authority(CHILD,{delegate:()=>assert.fail('cross-channel delegation is forbidden')})).result;
 assert.equal(result.error.code,'release-owner-mismatch');assert.deepEqual(f.snapshot(),before);
}));

test('delegated cleanup still retains unpublished commits and their generated cache',()=>fixture(f=>{
 f.db.prepare('UPDATE workspace SET owner=? WHERE id=?').run('manager:converge',f.record.id);
 fs.writeFileSync(path.join(f.source,'proof'),'unpublished committed manager work');f.git('-C',f.source,'commit','-am','private work');
 const result=f.invoke(authority(CHILD,{delegate:()=>({allowed:true})})).result;
 assert.equal(result.physicalDisposition.kind,'retained',JSON.stringify(result));
 assert.equal(fs.readFileSync(path.join(f.source,'proof'),'utf8'),'unpublished committed manager work');
 assert.equal(fs.existsSync(path.join(f.source,'node_modules','cache')),true);
}));

test('the actual native worker releases its own manager custody through the native assignment',t=>{
 const self=nativeCaller();
 if(self===null){t.skip('This proof requires an actual native tool scope.');return;}
 // A Converge fixture: real parent/goal rows and exact native tool-call authentication,
 // not an injected release caller or an owner-label authorization string.
 fixture(f=>{
  f.db.prepare('UPDATE workspace SET owner=? WHERE id=?').run('manager:converge',f.record.id);
  unbindNativeOwner(f.db,f.record.id);
  const result=spawnSync(process.execPath,[new URL(workspaceModule).pathname,'release','--path',f.source,'--json'],{
   env:{...process.env,PI_WORKSPACE_STATE:f.state,KENAN_AGENT:self.agentId},encoding:'utf8',timeout:30000});
  assert.equal(result.status,0,result.stdout+'\n'+result.stderr);
  const response=JSON.parse(result.stdout);
  assert.ok(['released','release-completed'].includes(response.action),result.stdout);
  assert.equal(fs.existsSync(f.source),false);
  assert.equal(f.db.prepare('SELECT owner FROM workspace WHERE id=?').get(f.record.id).owner,'manager:converge');
 });
});

test('historical goal UUID labels do not strand the authentic creator or authorize that UUID',()=>fixture(f=>{
 f.db.prepare('UPDATE workspace SET owner=? WHERE id=?').run(CHILD,f.record.id);
 const records=[{...f.record,owner:CHILD}];
 assert.equal(authorizeWorkspaceRelease(f.db,records,f.state,authority(PARENT,{goalLabel:()=>true})).ok,true);
 assert.equal(authorizeWorkspaceRelease(f.db,records,f.state,authority(CHILD,{goalLabel:()=>true})).error.code,'release-owner-mismatch');
}));
