import './scratch-env.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {main,workspaceTesting} from './workspace.mjs';
import {bindNativeOwner,nativeOwnerBinding} from './native-owner.mjs';
import {awaitSubmittedRelease} from './release-await.mjs';

// Regressions from October 29 (goal f2ddb677):
//  - worker 86eeef72 was refused release-owner-mismatch for a checkout its manager held after the
//    creating worker ended, although release-ended-owners would have handed it custody;
//  - worker b101d217's foreground release returned exit 75 ("release-submitted") and the release
//    completed three seconds later in the background; the manager's later release of the same,
//    already removed checkout was refused release-owner-mismatch instead of "already released";
//  - the manager, as parent of an archived worker, could not release that worker's checkout.
const CREATOR='22222222-2222-4222-8222-222222222222',SUCCESSOR='88888888-8888-4888-8888-888888888888',
  STRANGER='99999999-9999-4999-8999-999999999999',OTHER_PARENT='manager:other',MANAGER='manager:converge';
const authenticate=pairs=>({errors:[],confirmed:new Map(pairs.map(p=>[p.agentId+'\0'+p.callId,['beta']]))});
const native=agentId=>({caller:()=>({ok:true,kind:'native',binding:{agentId,channel:'beta',callId:'call-'+agentId.replace(':','-')}}),authenticate});

function fixture(action){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'release-owner-adoption-')),source=path.join(root,'checkout'),remote=path.join(root,'remote.git'),
    state=path.join(root,'registry.sqlite3'),liveness=path.join(root,'native.json');
  const previous=[process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY,process.env.PI_WORKSPACE_TEST_OWNER_LIVENESS];
  process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY='empty';process.env.PI_WORKSPACE_TEST_OWNER_LIVENESS=liveness;
  const git=(...a)=>execFileSync('git',a,{encoding:'utf8',timeout:5000,stdio:['ignore','pipe','pipe']}).trim();let db;
  const run=(argv,dependencies)=>{let out='';const write=process.stdout.write,exit=process.exitCode;process.exitCode=undefined;
    process.stdout.write=x=>{out+=x;return true;};
    try{main(argv,state,{releaseAuthorityDependencies:dependencies,releaseScopeOverride:{background:true}});return {result:JSON.parse(out),exitCode:process.exitCode??0};}
    finally{process.stdout.write=write;process.exitCode=exit;}};
  try{
    git('init','--bare',remote);git('clone',remote,source);git('-C',source,'checkout','-b','main');
    git('-C',source,'config','user.name','Fixture');git('-C',source,'config','user.email','fixture@example.invalid');
    fs.writeFileSync(path.join(source,'proof'),'published');git('-C',source,'add','.');git('-C',source,'commit','-m','published');git('-C',source,'push','origin','main');
    // A free task label, as workers pass it; the creator is bound from its authenticated tool scope.
    const record=run(['register','--path',source,'--root',root,'--owner','awareness-list-1bab','--source-commit',git('-C',source,'rev-parse','HEAD'),'--json'],{caller:()=>({ok:true,kind:'operator'})}).result;
    db=workspaceTesting.openRegistry(state);
    bindNativeOwner(db,record.id,{agentId:CREATOR,channel:'beta',callId:'call-creator'},'caller-scope',{command:'create'});
    const agents=(list,wakes=[])=>fs.writeFileSync(liveness,JSON.stringify({errors:[],agents:list,wakes,observations:[],observedAt:Date.now()}));
    const manager={id:MANAGER,channel:'beta',role:'manager',state:'running',archived:false};
    action({source,record,db,run,agents,manager});
  }finally{db?.close();['PI_WORKSPACE_TEST_EXTERNAL_SAFETY','PI_WORKSPACE_TEST_OWNER_LIVENESS'].forEach((key,i)=>{if(previous[i]===undefined)delete process.env[key];else process.env[key]=previous[i];});fs.rmSync(root,{recursive:true,force:true});}
}
const release=(f,agentId)=>f.run(['release','--id',f.record.id,'--json'],native(agentId));

test('the creating worker releases its own checkout and anyone may then read that it is already released',()=>fixture(f=>{
  f.agents([{id:CREATOR,parentAgentId:MANAGER,channel:'beta',role:'worker',state:'running',archived:false},f.manager]);
  const own=release(f,CREATOR);
  assert.equal(own.result.action,'released',JSON.stringify(own.result));assert.equal(own.exitCode,0);assert.equal(fs.existsSync(f.source),false);
  for(const caller of [MANAGER,STRANGER]){
    const again=release(f,caller);
    assert.equal(again.result.action,'already-released',JSON.stringify(again.result));assert.equal(again.exitCode,0);
  }
}));

test('the manager releases the checkout of its archived worker through guarded parent custody',()=>fixture(f=>{
  f.agents([{id:CREATOR,parentAgentId:MANAGER,channel:'beta',role:'worker',state:'idle',archived:true,goalId:'goal-1'},f.manager]);
  const result=release(f,MANAGER);
  assert.equal(result.result.action,'released',JSON.stringify(result.result));assert.equal(result.exitCode,0);
  assert.equal(JSON.parse(f.db.prepare('SELECT authorization FROM workspace_reassignment WHERE workspace_id=? ORDER BY sequence DESC').get(f.record.id).authorization).kind,'native-ended-child-parent-custody');
  assert.equal(fs.existsSync(f.source),false);
}));

test('a worker of the manager that holds an ended worker\'s checkout adopts and releases it',()=>fixture(f=>{
  f.agents([{id:CREATOR,parentAgentId:MANAGER,channel:'beta',role:'worker',state:'stopped',archived:true,goalId:'goal-1'},f.manager]);
  // The periodic owner sweep already moved custody to the manager (blitz-tenant-companion).
  const sweep=workspaceTesting.releaseEndedOwnersCommand(f.db,{positional:[],named:new Map([['id',[f.record.id]],['execute',['true']]])},
    path.join(path.dirname(f.source),'registry.sqlite3'),{caller:()=>({ok:true,kind:'operator'})}).results[0];
  assert.equal(sweep.action,'transferred-to-parent',JSON.stringify(sweep));
  assert.equal(f.db.prepare('SELECT owner FROM workspace WHERE id=?').get(f.record.id).owner,MANAGER);
  f.agents([{id:CREATOR,parentAgentId:MANAGER,channel:'beta',role:'worker',state:'stopped',archived:true,goalId:'goal-1'},f.manager,
    {id:SUCCESSOR,parentAgentId:MANAGER,channel:'beta',role:'worker',state:'running',archived:false}]);
  const result=release(f,SUCCESSOR);
  assert.equal(result.result.action,'released',JSON.stringify(result.result));
  assert.equal(JSON.parse(f.db.prepare('SELECT authorization FROM workspace_reassignment WHERE workspace_id=? ORDER BY sequence DESC').get(f.record.id).authorization).kind,'native-ended-owner-requester-custody');
  assert.equal(fs.existsSync(f.source),false);
}));

test('a live custodian keeps its checkout: the mismatch stays refused and nothing changes',()=>fixture(f=>{
  f.agents([{id:CREATOR,parentAgentId:MANAGER,channel:'beta',role:'worker',state:'running',archived:false},f.manager]);
  const before=f.db.prepare('SELECT * FROM workspace WHERE id=?').get(f.record.id);
  for(const caller of [MANAGER,SUCCESSOR]){
    const result=release(f,caller);
    assert.equal(result.exitCode,2);assert.equal(result.result.error.code,'release-owner-mismatch',JSON.stringify(result.result));
    assert.equal(result.result.custodyAdoption.transferred,false);
  }
  assert.deepEqual(f.db.prepare('SELECT * FROM workspace WHERE id=?').get(f.record.id),before);
  assert.equal(nativeOwnerBinding(f.db,f.record.id).agentId,CREATOR);assert.equal(fs.existsSync(f.source),true);
}));

test('a manager that is not the ended worker\'s parent cannot take or release its checkout',()=>fixture(f=>{
  f.agents([{id:CREATOR,parentAgentId:OTHER_PARENT,channel:'beta',role:'worker',state:'stopped',archived:true},
    {id:OTHER_PARENT,channel:'beta',role:'manager',state:'running',archived:false},f.manager]);
  const result=release(f,MANAGER);
  assert.equal(result.exitCode,2);assert.equal(result.result.error.code,'release-owner-mismatch',JSON.stringify(result.result));
  assert.equal(fs.existsSync(f.source),true);
  assert.notEqual(f.db.prepare('SELECT owner FROM workspace WHERE id=?').get(f.record.id).owner,MANAGER);
}));

test('a worker that is not a child of the custodian manager cannot adopt its checkout',()=>fixture(f=>{
  f.db.prepare('UPDATE workspace SET owner=? WHERE id=?').run(MANAGER,f.record.id);
  f.agents([{id:CREATOR,parentAgentId:MANAGER,channel:'beta',role:'worker',state:'running',archived:false},f.manager,
    {id:STRANGER,parentAgentId:OTHER_PARENT,channel:'beta',role:'worker',state:'running',archived:false}]);
  const result=release(f,STRANGER);
  assert.equal(result.exitCode,2);assert.equal(result.result.error.code,'release-owner-mismatch');assert.equal(fs.existsSync(f.source),true);
}));

test('a submitted foreground release reports the background outcome instead of exit 75',()=>{
  const clock=()=>{let t=0;return {now:()=>t,sleep:ms=>{t+=ms;}};};
  const states=[{submissionState:'submitted',recordState:'active',pathExists:true},{submissionState:'submitted',recordState:'released',pathExists:false,settlementKind:'completed'}];
  let c=clock(),i=0;
  assert.equal(awaitSubmittedRelease({read:()=>states[Math.min(i++,1)],...c}).kind,'completed');
  c=clock();
  assert.equal(awaitSubmittedRelease({read:()=>({submissionState:'terminal-known',recordState:'referenced',pathExists:true,terminal:{exitCode:0}}),...c}).kind,'terminal');
  c=clock();
  const pending=awaitSubmittedRelease({read:()=>({submissionState:'submitted',recordState:'active',pathExists:true}),budgetMs:1000,...c});
  assert.equal(pending.kind,'pending');assert.ok(c.now()>=1000&&c.now()<1300,'the observation is bounded');
  c=clock();
  assert.equal(awaitSubmittedRelease({read:()=>({submissionState:'launch-unknown'}),...c}).kind,'pending','an unknown launch is reported, never waited on');
});

test('the foreground observation of a submitted release reports completion, a ceased unit and still-running work',()=>fixture(f=>{
  f.db.exec(`CREATE TABLE IF NOT EXISTS workspace_release_submission (workspace_id TEXT PRIMARY KEY, request_id TEXT NOT NULL, request_json TEXT NOT NULL,
    binding_json TEXT NOT NULL, unit_name TEXT NOT NULL, state TEXT NOT NULL, launch_json TEXT, terminal_json TEXT, continuations_json TEXT)`);
  f.db.prepare("INSERT INTO workspace_release_submission VALUES(?,?,?,?,?,?,?,NULL,NULL)").run(f.record.id,'request-1','{}',JSON.stringify({agentId:CREATOR,channel:'beta',callId:'c'}),'aw-release-x','submitted',JSON.stringify({started:'unit-x',log:'/log/x',event:'job:x'}));
  const submitted={ok:true,action:'release-submitted',completed:false,unitName:'aw-release-x',launch:{log:'/log/x',event:'job:x'}};
  const fast={budgetMs:600,sleep:()=>{}};
  const running=workspaceTesting.finishSubmittedRelease(f.db,f.record,submitted,{...fast,observeUnit:()=>({ceased:false})});
  assert.equal(running.action,'release-submitted');assert.equal(running.completed,false);assert.match(running.note,/not a failure/);
  const ceased=workspaceTesting.finishSubmittedRelease(f.db,f.record,submitted,{...fast,observeUnit:()=>({ceased:true})});
  assert.equal(ceased.action,'release-retained');assert.equal(ceased.ok,false);assert.match(ceased.note,/\/log\/x/);
  fs.rmSync(f.source,{recursive:true,force:true});f.db.prepare("UPDATE workspace SET state='released' WHERE id=?").run(f.record.id);
  const uncommitted=workspaceTesting.finishSubmittedRelease(f.db,f.record,submitted,{budgetMs:0,observeUnit:()=>({ceased:false})});
  assert.equal(uncommitted.completed,false);assert.equal(uncommitted.action,'release-submitted');
  f.db.exec('CREATE TABLE IF NOT EXISTS workspace_release_attempt(sequence INTEGER PRIMARY KEY,workspace_id TEXT,receipt_json TEXT)');
  f.db.prepare('INSERT INTO workspace_release_attempt(workspace_id,receipt_json) VALUES(?,?)').run(f.record.id,JSON.stringify({kind:'completed'}));
  const done=workspaceTesting.finishSubmittedRelease(f.db,f.record,submitted,{...fast,observeUnit:()=>({ceased:false})});
  assert.equal(done.action,'release-completed');assert.equal(done.completed,true);
}));

test('a waiting foreground release CLI does not retain the checkout it names, but other references still do',()=>{
  const target='/w/checkout',record=(commandLine,extra={})=>({pid:7,command:'node',commandLine,cwd:'/',executable:'/usr/bin/node',writableFiles:[],...extra});
  const refs=list=>workspaceTesting.processReferences(target,list);
  assert.deepEqual(refs([record(['/usr/local/bin/node','/srv/pi/tools/agent-workspace/main','release','--path',target,'--json'])]),[]);
  assert.deepEqual(refs([record(['node','/srv/pi/.pi-stack-releases/tools/abc/agent-workspace/workspace.mjs','release','--id','x','--path='+target])]),[]);
  assert.equal(refs([record(['/usr/local/bin/node','/srv/pi/tools/agent-workspace/main','release','--path',target],{cwd:target})]).length,1,'a cwd inside still counts');
  assert.equal(refs([record(['/usr/local/bin/node','/srv/pi/tools/agent-workspace/main','heartbeat','--path',target])]).length,1,'other commands still count');
  assert.equal(refs([record(['/usr/local/bin/node','/tmp/main','release','--path',target])]).length,1,'only the agent-workspace CLI is exempt');
  assert.equal(refs([record(['bash','build.sh',target+'/x'])]).length,1);
});

// October 30 (goal b4181c22): agents run the CLI through the `agent-workspace` symlink on PATH, so the waiting
// foreground release's argv was `node ~/.local/bin/agent-workspace release --path X` and checkout-guard was retained
// four times by "1 process" that nobody could find; `timeout 250 agent-workspace release ...` retained its checkout the same way.
test('a foreground release run through a PATH symlink, and the processes waiting on it, are the requester; the retained reason names any real reference',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'aw-symlink-cli-')),prior=process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY;
  process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY='empty';
  try{
    const target=path.join(root,'checkout');fs.mkdirSync(target);
    const tool=path.join(root,'tools','agent-workspace');fs.mkdirSync(tool,{recursive:true});fs.writeFileSync(path.join(tool,'workspace.mjs'),'');
    fs.symlinkSync('workspace.mjs',path.join(tool,'main'));
    const bin=path.join(root,'bin');fs.mkdirSync(bin);fs.symlinkSync(path.join(tool,'main'),path.join(bin,'agent-workspace'));
    fs.writeFileSync(path.join(root,'other.mjs'),'');fs.symlinkSync(path.join(root,'other.mjs'),path.join(bin,'not-the-cli'));
    const record=(commandLine,extra={})=>({pid:7,command:'node',commandLine,cwd:'/',executable:'/usr/bin/node',writableFiles:[],...extra});
    const refs=list=>workspaceTesting.processReferences(target,list);
    assert.deepEqual(refs([record(['node',path.join(bin,'agent-workspace'),'release','--path',target,'--json'])]),[]);
    assert.deepEqual(refs([record(['node','bin/agent-workspace','release','--path',target],{cwd:root})]),[],'a relative invocation resolves against its cwd');
    assert.equal(refs([record(['node',path.join(bin,'not-the-cli'),'release','--path',target])]).length,1,'another script named on the command line still counts');
    const cli=record(['node',path.join(bin,'agent-workspace'),'release','--path',target],{pid:11,ppid:10});
    const waiting=record(['timeout','250','agent-workspace','release','--path',target],{pid:10,ppid:9});
    const shell=record(['bash','-c','timeout 250 agent-workspace release --path '+target],{pid:9,ppid:1});
    assert.deepEqual(refs([shell,waiting,cli]),[],'the processes waiting on the release CLI are the requester too');
    assert.deepEqual(refs([{...shell,cwd:target},waiting,cli]).map(reference=>reference.pid),[9],'a waiting ancestor whose cwd is inside still counts');
    assert.deepEqual(refs([waiting,record(['timeout','250','agent-workspace','heartbeat','--path',target],{pid:12,ppid:1})]).map(reference=>reference.pid),[10,12],'without a release CLI below it, a wrapper still counts');
    const consumer=record(['bash','build.sh',target+'/x'],{pid:4242});
    const inspection=workspaceTesting.inspectRecord({id:'r',path:target,state:'active',leaseExpiresAt:0,checkoutType:'worktree'},
      {ignoreLease:true,safety:{processes:[consumer],docker:{containers:[],available:true},systemd:{units:[],available:true}}});
    assert.equal(inspection.classification,'referenced',inspection.reason);
    assert.match(inspection.reason,/process 4242 \(bash build\.sh .*checkout\/x\) by argument/);
  }finally{
    if(prior===undefined)delete process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY;else process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY=prior;
    fs.rmSync(root,{recursive:true,force:true});
  }
});

// October 31: the authenticated foreground release inherited the source child's cwd,
// and its background worker correctly retained it as a physical consumer. Move the
// administrative submitter, rather than teaching safety to ignore real cwd references.
test('the foreground submitter vacates its checkout before launching physical release',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'release-own-cwd-'));
  const before=process.cwd();
  try {
    process.chdir(root);
    workspaceTesting.leaveReleaseDirectory();
    assert.equal(process.cwd(),fs.realpathSync(os.homedir()));
    const record={pid:7,ppid:1,command:'node',commandLine:['node','/srv/pi/tools/agent-workspace/main','release','--path',root],cwd:process.cwd(),executable:process.execPath,writableFiles:[]};
    assert.deepEqual(workspaceTesting.processReferences(root,[record]),[]);
    assert.equal(workspaceTesting.processReferences(root,[{...record,cwd:root}]).length,1,'a shell or unvacated CLI remains a real reference');
    assert.equal(workspaceTesting.processReferences(root,[{...record,writableFiles:[root+'/output']}]).length,1,'held descriptors are not administrative references');
    assert.equal(workspaceTesting.processReferences(root,[{...record,executable:root+'/node'}]).length,1,'an executable in the checkout remains protected');
  } finally {process.chdir(before);fs.rmSync(root,{recursive:true,force:true});}
});

for(const named of [false,true])test(`parent custody adoption accepts a ${named?'path-naming':'goal-only'} held trigger without deleting source`,()=>fixture(f=>{
 f.agents([{id:CREATOR,parentAgentId:MANAGER,channel:'beta',role:'worker',state:'idle',archived:true,goalId:'goal-1'},f.manager],
  [{id:'trigger',agentId:MANAGER,channel:'beta',held:true,goalId:'goal-1',text:named?`continue in ${f.source}`:'continue independent ranking'}]);
 const result=f.run(['release','--id',f.record.id,'--preserve-runtime','--json'],native(MANAGER));
 assert.equal(f.db.prepare('SELECT owner FROM workspace WHERE id=?').get(f.record.id).owner,MANAGER,JSON.stringify(result.result));
 assert.equal(fs.existsSync(f.source),true,'Custody adoption and explicit handoff must not delete source');
 assert.equal(result.result.runtimeHandoff.kind,'settled');
}));


test('an explicit successor release is not blocked by a historical path mention in a handed-off trigger',()=>fixture(f=>{
 f.agents([{id:CREATOR,parentAgentId:MANAGER,channel:'beta',role:'worker',state:'idle',archived:true,goalId:'goal-1'},f.manager,
  {id:SUCCESSOR,parentAgentId:MANAGER,channel:'beta',role:'worker',state:'running',archived:false}],
  [{id:'new-held-trigger',agentId:MANAGER,channel:'beta',held:true,goalId:'goal-1',text:`Release of workspace ${path.basename(f.source)} went to the repair worker; the router has nothing to do there.`}]);
 const result=release(f,SUCCESSOR);
 assert.equal(f.db.prepare('SELECT owner FROM workspace WHERE id=?').get(f.record.id).owner,SUCCESSOR,JSON.stringify(result.result));
 assert.equal(result.result.action,'released',JSON.stringify(result.result));
 assert.equal(fs.existsSync(f.source),false);
}));
