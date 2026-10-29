import{test}from'node:test';import assert from'node:assert/strict';import fs from'node:fs';import os from'node:os';import path from'node:path';import{execFileSync}from'node:child_process';import{DatabaseSync}from'node:sqlite';
const{main,workspaceTesting}=await import(process.env.WORKSPACE_RELEASE_MODULE||'./workspace.mjs');
function fixture(action){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'release-custody-')),source=path.join(root,'source'),remote=path.join(root,'remote.git'),state=path.join(root,'registry.sqlite3');const previous=process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY;process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY='empty';let db;
 const git=(...a)=>execFileSync('git',a,{encoding:'utf8',timeout:5000,stdio:['ignore','pipe','pipe']}).trim();
 const run=args=>{let out='';const write=process.stdout.write,exit=process.exitCode;process.stdout.write=x=>{out+=x;return true;};try{if(args[0]==='release'){const named=new Map();for(let i=1;i<args.length;i++){const key=args[i].slice(2);named.set(key,[args[i+1]?.startsWith('--')||i+1===args.length?'true':args[++i]]);}workspaceTesting.releaseCommand(db,{positional:[],named},state,{caller:()=>({ok:true,kind:'operator'})});}else main(args,state);}finally{process.stdout.write=write;process.exitCode=exit;}return JSON.parse(out);};
 try{
  git('init','--bare',remote);git('clone',remote,source);git('-C',source,'checkout','-b','main');git('-C',source,'config','user.name','Fixture');git('-C',source,'config','user.email','fixture@example.invalid');fs.writeFileSync(path.join(source,'.gitignore'),'node_modules/\nprivate-evidence/\n');fs.writeFileSync(path.join(source,'proof'),'initial');git('-C',source,'add','.');git('-C',source,'commit','-m','initial');git('-C',source,'push','origin','main');const initial=git('-C',source,'rev-parse','HEAD');
  const record=run(['register','--path',source,'--root',root,'--owner','fixture','--source-commit',initial,'--json']);fs.mkdirSync(path.join(source,'node_modules'));fs.writeFileSync(path.join(source,'node_modules','receipt'),'generated cache');db=workspaceTesting.openRegistry(state);
  const commit=()=>{fs.writeFileSync(path.join(source,'proof'),'new unique work');git('-C',source,'commit','-am','unique');return git('-C',source,'rev-parse','HEAD');};const release=()=>run(['release','--id',record.id,'--preserve-runtime','--json']);
  action({root,source,remote,state,record,db,git,run,commit,release});
 }finally{db?.close();if(previous===undefined)delete process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY;else process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY=previous;fs.rmSync(root,{recursive:true,force:true});}
}
for(const kind of ['unpublished','dirty'])test('ordinary release preserves generated cache with '+kind+' source custody',()=>fixture(f=>{
 if(kind==='unpublished')f.commit();else fs.writeFileSync(path.join(f.source,'proof'),'dirty unique work');
 const result=f.release();assert.equal(result.record.state,'repair-required',JSON.stringify(result));assert.equal(result.physicalDisposition.kind,'retained');assert.equal(result.leaseRelease.kind,'released');assert.equal(result.cacheDisposition.kind,'none-selected');assert.equal(result.action,'none');assert.equal(fs.readFileSync(path.join(f.source,'node_modules','receipt'),'utf8'),'generated cache');assert.equal(fs.readFileSync(path.join(f.source,'proof'),'utf8'),kind==='unpublished'?'new unique work':'dirty unique work');
}));
test('published exact branch with stale tracking refs is verified read-only before source/cache disposal',()=>fixture(f=>{
 const head=f.commit();f.git('-C',f.source,'push',f.remote,'HEAD:refs/heads/main');assert.notEqual(f.git('-C',f.source,'rev-parse','refs/remotes/origin/main'),head);
 const result=f.release();assert.equal(result.record.state,'released',JSON.stringify(result));assert.equal(result.physicalDisposition.kind,'removed');assert.equal(result.cacheDisposition.kind,'detached-for-retirement');assert.deepEqual(result.cacheDisposition.paths,['node_modules']);assert.equal(result.cacheDisposition.physicalReclaim,'not-measured');
}));
test('a commit pushed under a different remote branch name is durable even with stale local refs',()=>fixture(f=>{
 const head=f.commit();f.git('-C',f.source,'push',f.remote,'HEAD:refs/heads/kenan/leaf-'+head.slice(0,8));assert.equal(f.git('-C',f.source,'for-each-ref','--format=%(refname)','refs/remotes').includes('leaf'),false);
 const result=f.release();assert.equal(result.record.state,'released',JSON.stringify(result));assert.equal(result.physicalDisposition.kind,'removed');
}));
test('a remote tip absent locally covers nothing: unique local work stays retained',()=>fixture(f=>{
 const other=path.join(f.root,'other');f.git('clone',f.remote,other);f.git('-C',other,'config','user.name','O');f.git('-C',other,'config','user.email','o@example.invalid');fs.writeFileSync(path.join(other,'x'),'x');f.git('-C',other,'add','x');f.git('-C',other,'commit','-m','remote only');f.git('-C',other,'push','origin','HEAD:refs/heads/elsewhere');
 f.commit();const result=f.release();assert.equal(result.physicalDisposition.kind,'retained');assert.match(result.inspection.reason,/absent from remote refs/);
}));
test('a different unpublished local branch still protects all cache/source even when current HEAD is published',()=>fixture(f=>{
 const unique=f.commit();f.git('-C',f.source,'branch','private-work',unique);f.git('-C',f.source,'checkout','main');f.git('-C',f.source,'reset','--hard','refs/remotes/origin/main');const result=f.release();assert.equal(result.physicalDisposition.kind,'retained');assert.equal(result.cacheDisposition.kind,'none-selected');assert.equal(f.git('-C',f.source,'rev-parse','private-work'),unique);assert.equal(fs.existsSync(path.join(f.source,'node_modules','receipt')),true);
}));
test('unknown remote custody retains source and cache instead of performing speculative cleanup',()=>fixture(f=>{
 f.commit();f.git('-C',f.source,'remote','set-url','origin',path.join(f.root,'missing.git'));const result=f.release();assert.equal(result.physicalDisposition.kind,'retained');assert.equal(result.cacheDisposition.kind,'none-selected');assert.match(result.inspection.reason,/remote custody observation unavailable/);assert.equal(fs.existsSync(path.join(f.source,'node_modules','receipt')),true);
}));
test('retained unclassified evidence and actual declared-cache detachment have separate typed effects',()=>fixture(f=>{
 fs.mkdirSync(path.join(f.source,'private-evidence'));fs.writeFileSync(path.join(f.source,'private-evidence','proof'),'preserve evidence');const result=f.release();assert.equal(result.physicalDisposition.kind,'retained');assert.equal(result.record.state,'repair-required',JSON.stringify(result));assert.equal(result.cacheDisposition.kind,'detached-for-retirement');assert.deepEqual(result.cacheDisposition.paths,['node_modules']);assert.equal(fs.readFileSync(path.join(f.source,'private-evidence','proof'),'utf8'),'preserve evidence');
}));
test('group reconciliation also retains cache when unique source prevents release',()=>fixture(f=>{
 f.commit();f.db.prepare('UPDATE workspace SET lease_expires_at=0 WHERE id=?').run(f.record.id);
 const safety={processes:[],threads:[],docker:{available:false,containers:[]},systemd:{available:false,units:[]},gitAlternates:[],linkedWorktrees:[],currentStackQueue:{errors:[],references:[],observedAt:Date.now()}};
 const result=workspaceTesting.groupReconciliation(f.db,[{...f.record,leaseExpiresAt:0}],{execute:true,ignoreLease:true,reapExpired:false,preserveRuntime:true,safety,statePath:f.state,terminalSourceTransfer:true,deadline:Date.now()+5000});assert.equal(result[0].action,'none');assert.deepEqual(result[0].removedCaches,[]);assert.equal(fs.existsSync(path.join(f.source,'node_modules','receipt')),true);
}));
test('timed-out union walk retains source, cache, foreign refs and release custody',()=>fixture(f=>{
 f.commit();const foreign=f.git('-C',f.source,'rev-parse','HEAD');f.git('-C',f.source,'branch','foreign-work',foreign);
 const bin=path.join(f.root,'bin');fs.mkdirSync(bin);
 // Only the release graph probe is delayed; this does not alter the checkout.
 const originalPath=process.env.PATH;const native=execFileSync('which',['git'],{encoding:'utf8'}).trim();
 fs.writeFileSync(path.join(bin,'git'),'#!/bin/sh\nif [ "$3" = "rev-list" ]; then sleep 2; fi\nexec '+JSON.stringify(native)+' "$@"\n',{mode:0o755});
 process.env.PATH=bin+':'+originalPath;
 try {
  const safety={processes:[],threads:[],docker:{available:false,containers:[]},systemd:{available:false,units:[]},gitAlternates:[],linkedWorktrees:[],currentStackQueue:{errors:[],references:[],observedAt:Date.now()}};
  assert.throws(()=>workspaceTesting.groupReconciliation(f.db,[{...f.record,leaseExpiresAt:0}],{execute:true,ignoreLease:true,reapExpired:false,preserveRuntime:true,safety,statePath:f.state,terminalSourceTransfer:true,deadline:Date.now()+700}),/timed out|budget exhausted/);
 }finally{process.env.PATH=originalPath;}
 assert.equal(f.git('-C',f.source,'rev-parse','foreign-work'),foreign);
 assert.equal(fs.existsSync(path.join(f.source,'node_modules','receipt')),true);
 assert.equal(fs.readFileSync(path.join(f.source,'proof'),'utf8'),'new unique work');
}));

test('ordinary release preserves an undispatched qualification and paired train before any cache disposal',()=>fixture(f=>{
 const data=path.join(f.root,'release-data'),id='74551659-ca7f-47cc-92ff-c3e4b786e9e9',owner='226bb31d-e421-4f2b-99bb-ced3e5606ad9',base=f.git('-C',f.source,'rev-parse','HEAD');
 for(const d of ['qualification-authority-requests','prepared-qualifications','merge-queue','producer-admission','release-launcher'])fs.mkdirSync(path.join(data,d),{recursive:true});
 const put=(p,x)=>fs.writeFileSync(path.join(data,p),JSON.stringify(x));
 const request={version:1,root:f.source,rootSource:base,name:'current-paired-train',pipeline:{operation:id,owner,base,leaves:[base]}};
 put('qualification-authority-requests/'+id+'.json',request);put('prepared-qualifications/'+id+'.json.workspace.json',{id:f.record.id,path:f.source});put('prepared-qualifications/'+id+'.json.assembly.json',{request,candidate:base});
 put('merge-queue/state.json',{batches:[{name:request.name,leaves:[base],owners:[owner]}]});
 const before=process.env.PI_WORKSPACE_TEST_QUALIFICATION_ROOT;process.env.PI_WORKSPACE_TEST_QUALIFICATION_ROOT=data;
 try {
  let result=f.release();assert.equal(result.physicalDisposition.kind,'retained');assert.equal(result.cacheDisposition.kind,'not-attempted');assert.equal(result.inspection.currentStackQueueProtected,true);assert.ok(result.inspection.currentStackReferences.some(r=>r.kind==='qualification_request'));assert.ok(fs.existsSync(path.join(f.source,'node_modules','receipt')));
  put('producer-admission/'+id+'.completed.json',{state:'completed',identity:request.pipeline});
  result=f.release();assert.equal(result.physicalDisposition.kind,'retained','the train still owns the prepared root after request settlement');assert.ok(result.inspection.currentStackReferences.some(r=>r.kind==='queue_train'));
  put('merge-queue/state.json',{batches:[]});result=f.release();assert.equal(result.physicalDisposition.kind,'removed','exact settlement and absence of a current train permit ordinary release');
 }finally {if(before===undefined)delete process.env.PI_WORKSPACE_TEST_QUALIFICATION_ROOT;else process.env.PI_WORKSPACE_TEST_QUALIFICATION_ROOT=before;}
}));

test('one transition shares remote custody, but rechecks every local branch and never caches across snapshots',()=>fixture(f=>{
 const head=f.commit();f.git('-C',f.source,'push',f.remote,'HEAD:refs/heads/published-elsewhere');
 const bin=path.join(f.root,'count-bin'),log=path.join(f.root,'remote-calls');fs.mkdirSync(bin);
 const native=execFileSync('which',['git'],{encoding:'utf8'}).trim(),oldPath=process.env.PATH;
 fs.writeFileSync(path.join(bin,'git'),'#!/bin/sh\nif [ "$3" = "ls-remote" ]; then echo read >> '+JSON.stringify(log)+'; fi\nexec '+JSON.stringify(native)+' "$@"\n',{mode:0o755});
 process.env.PATH=bin+':'+oldPath;
 try {
  const safety=workspaceTesting.safetySnapshot(f.db),inspect=()=>workspaceTesting.inspectRecord(f.record,{ignoreLease:true,safety,deadline:Date.now()+5000,terminalSourceTransfer:true});
  for(let i=0;i<4;i++){const result=inspect();assert.equal(result.classification,'repair-required');assert.equal(result.sourceRetention,false);}
  assert.equal(fs.readFileSync(log,'utf8').trim().split('\n').length,1);
  // A later private branch cannot borrow the earlier successful HEAD verdict.
  f.git('-C',f.source,'commit','--allow-empty','-m','foreign private work');const unique=f.git('-C',f.source,'rev-parse','HEAD');
  f.git('-C',f.source,'branch','foreign-private',unique);f.git('-C',f.source,'reset','--hard',head);
  assert.equal(inspect().sourceRetention,true);assert.equal(f.git('-C',f.source,'rev-parse','foreign-private'),unique);
  const next=workspaceTesting.safetySnapshot(f.db);
  assert.equal(workspaceTesting.inspectRecord(f.record,{ignoreLease:true,safety:next,deadline:Date.now()+5000,terminalSourceTransfer:true}).sourceRetention,true);
  assert.equal(fs.readFileSync(log,'utf8').trim().split('\n').length,2);
  fs.writeFileSync(path.join(f.source,'proof'),'dirty source');assert.equal(inspect().sourceRetention,true);
  assert.equal(fs.readFileSync(path.join(f.source,'node_modules','receipt'),'utf8'),'generated cache');
 }finally{process.env.PATH=oldPath;}
}));

for(const prepare of ['husky','husky install','husky || true','husky install || :'])test('tracked Husky prepare "'+prepare+'" owns only ignored internal hooks, not arbitrary ignored evidence',()=>fixture(f=>{
 fs.writeFileSync(path.join(f.source,'package.json'),JSON.stringify({scripts:{prepare}}));
 fs.appendFileSync(path.join(f.source,'.gitignore'),'\.husky/_/\n');
 f.git('-C',f.source,'add','.');f.git('-C',f.source,'commit','-m','tracked prepare');f.git('-C',f.source,'push','origin','main');
 fs.mkdirSync(path.join(f.source,'.husky/_'),{recursive:true});fs.writeFileSync(path.join(f.source,'.husky/_/h'),'generated hooks');
 fs.mkdirSync(path.join(f.source,'private-evidence'));fs.writeFileSync(path.join(f.source,'private-evidence/proof'),'valuable');
 const result=f.release();assert.equal(result.physicalDisposition.kind,'retained');assert.ok(result.cacheDisposition.paths.includes('.husky/_'));
 assert.equal(fs.existsSync(path.join(f.source,'.husky/_')),false);assert.equal(fs.readFileSync(path.join(f.source,'private-evidence/proof'),'utf8'),'valuable');
}));
for(const kind of ['untracked','different-generator','chained-command'])test('Husky inference refuses '+kind+' prepare source',()=>fixture(f=>{
 fs.appendFileSync(path.join(f.source,'.gitignore'),'.husky/_/\n');f.git('-C',f.source,'commit','-am','ignore generated');
 fs.writeFileSync(path.join(f.source,'package.json'),JSON.stringify({scripts:{prepare:kind==='untracked'?'husky':kind==='chained-command'?'husky && custom-tool':'custom-tool'}}));
 if(kind!=='untracked'){f.git('-C',f.source,'add','package.json');f.git('-C',f.source,'commit','-m','different generator');}f.git('-C',f.source,'push','origin','main');
 fs.mkdirSync(path.join(f.source,'.husky/_'),{recursive:true});fs.writeFileSync(path.join(f.source,'.husky/_/proof'),'preserve');
 assert.equal(f.release().physicalDisposition.kind,'retained');assert.equal(fs.existsSync(path.join(f.source,'.husky/_/proof')),true);
}));
test('a detached pushed checkout transfers and releases without attaching a synthetic branch',()=>fixture(f=>{
 const head=f.git('-C',f.source,'rev-parse','HEAD');f.git('-C',f.source,'checkout','--detach',head);
 const record=f.db.prepare('SELECT state FROM workspace WHERE id=?').get(f.record.id);
 const result=workspaceTesting.reassignWorkspace(f.db,{id:f.record.id,path:f.source,fromOwner:'fixture',fromSourceCommit:head,fromState:record.state,owner:'repair',sourceCommit:head,authorization:'test detached handoff'},{caller:()=>({ok:true,kind:'operator'})});
 assert.equal(result.ok,true,JSON.stringify(result));assert.equal(f.release().physicalDisposition.kind,'removed');
}));

test('ordinary clean pushed Converge-shaped detached checkout releases with 14000 remote heads and 29 generated outputs',()=>fixture(f=>{
 const outputs=Array.from({length:29},(_,i)=>`products/product${i}/src/client.generated.ts`);
 fs.writeFileSync(path.join(f.source,'.agent-workspace-caches'),outputs.join('\n')+'\n');
 fs.appendFileSync(path.join(f.source,'.gitignore'),outputs.join('\n')+'\n');
 f.git('-C',f.source,'add','.');f.git('-C',f.source,'commit','-m','tracked generated output contracts');f.git('-C',f.source,'push','origin','main');
 const head=f.git('-C',f.source,'rev-parse','HEAD');
 const refs=Array.from({length:14000},(_,i)=>`create refs/heads/remote-${i} ${head}`).join('\n')+'\n';
 execFileSync('git',['--git-dir',f.remote,'update-ref','--stdin'],{input:refs,timeout:10000,stdio:['pipe','pipe','pipe']});
 f.git('-C',f.source,'update-ref','-d','refs/remotes/origin/main');f.git('-C',f.source,'checkout','--detach',head);
 for(const output of outputs){fs.mkdirSync(path.dirname(path.join(f.source,output)),{recursive:true});fs.writeFileSync(path.join(f.source,output),'generated');}
 const start=Date.now(),result=f.release();
 assert.equal(result.physicalDisposition.kind,'removed',JSON.stringify(result));assert.equal(fs.existsSync(f.source),false);
 assert.equal(result.cacheDisposition.paths.length,30);assert.ok(Date.now()-start<150000,'physical release must finish inside its unchanged background bound');
}));

// Link backend (blitz2-link-liminal-be, 33b3fad0): swagger-autogen outputs are regenerable,
// but only where committed scripts run the tracked generator and Git ignores the outputs.
for(const kind of ['generator','no-dependency'])test('swagger-autogen outputs are generated only with the tracked generator ('+kind+')',()=>fixture(f=>{
 fs.mkdirSync(path.join(f.source,'src/docs'),{recursive:true});
 fs.writeFileSync(path.join(f.source,'src/docs/swagger.js'),'// generator');fs.writeFileSync(path.join(f.source,'src/docs/swaggerUtils.js'),'// definitions');
 fs.writeFileSync(path.join(f.source,'package.json'),JSON.stringify({scripts:{swagger:'node ./src/docs/swagger.js'},dependencies:kind==='generator'?{'swagger-autogen':'2.23.7'}:{}}));
 fs.appendFileSync(path.join(f.source,'.gitignore'),'src/docs/swagger-output.json\nsrc/docs/definitions/\n/swagger-output.json\n');
 f.git('-C',f.source,'add','.');f.git('-C',f.source,'commit','-m','swagger');f.git('-C',f.source,'push','origin','main');
 fs.writeFileSync(path.join(f.source,'src/docs/swagger-output.json'),'{}');fs.mkdirSync(path.join(f.source,'src/docs/definitions'));fs.writeFileSync(path.join(f.source,'src/docs/definitions/A.json'),'{}');
 const result=f.release();
 if(kind==='generator'){assert.ok(result.cacheDisposition?.paths?.includes('src/docs/definitions'),JSON.stringify(result));assert.equal(fs.existsSync(path.join(f.source,'src/docs/swagger-output.json')),false);}
 else {assert.equal(result.physicalDisposition.kind,'retained');assert.equal(fs.existsSync(path.join(f.source,'src/docs/definitions/A.json')),true);}
}));
