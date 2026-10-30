import './scratch-env.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync, spawn} from 'node:child_process';
import {once} from 'node:events';
import {DatabaseSync} from 'node:sqlite';
import {digest} from './growth-lifecycle.mjs';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {unlinkDeclaredCacheSymlink} from './cache-symlink.mjs';
const {main, workspaceTesting:w} = await import(process.env.WORKSPACE_SYMLINK_MODULE || './workspace.mjs');

function fixture(action) {
  const base=fs.mkdtempSync(path.join(tmpdir(),'cache-link-')),root=path.join(base,'source'),external=path.join(base,'canonical/node_modules');
  fs.mkdirSync(path.join(root,'products/kenan'),{recursive:true});fs.mkdirSync(external,{recursive:true});
  fs.writeFileSync(path.join(external,'payload'),'external original bytes');
  const target=path.join(root,'products/kenan/node_modules');fs.symlinkSync(external,target);
  const git=(...args)=>execFileSync('git',['-C',root,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  git('init','-b','main');git('config','user.email','fixture@example.invalid');git('config','user.name','Fixture');
  fs.writeFileSync(path.join(root,'.gitignore'),'node_modules\nignored-link\n');fs.writeFileSync(path.join(root,'source'),'durable');git('add','.');git('commit','-m','source');
  const clear=()=>({errors:[],references:[],retainedBorrowers:[],observedAt:Date.now()});
  const context={root,target,declarations:['**/node_modules'],tracked:()=>false,ignored:()=>true,observe:clear,invalidateCapacity:()=>{}};
  try {return action({base,root,target,external,git,context,clear});} finally {fs.rmSync(base,{recursive:true,force:true});}
}
function unchanged(f) {assert.equal(fs.lstatSync(f.target).isSymbolicLink(),true);assert.equal(fs.readFileSync(path.join(f.external,'payload'),'utf8'),'external original bytes');}

test('recursive cache discovery includes exact matching symlink entries without following any aliases',()=>fixture(f=>{
  fs.symlinkSync(f.external,path.join(f.root,'ignored-link'));
  const reads=[];const targets=[...w.cacheTargets(f.root,['**/node_modules'],(p,o)=>{reads.push(p);return fs.readdirSync(p,o);})];
  assert.deepEqual(targets,[f.target]);assert.equal(reads.includes(f.target),false);assert.equal(reads.includes(f.external),false);assert.equal(reads.includes(path.join(f.root,'ignored-link')),false);
}));

test('declared ignored owned link is unlinked after exact lexical and real-target checks; external inode and bytes survive',()=>fixture(f=>{
  const before=fs.statSync(f.external),payload=fs.statSync(path.join(f.external,'payload'));let invalidated=0,observed;
  assert.equal(unlinkDeclaredCacheSymlink({...f.context,observe:roots=>{observed=roots;return f.clear();},invalidateCapacity:()=>invalidated++}),true);
  assert.deepEqual(observed,[f.target,f.external]);assert.equal(invalidated,1);assert.equal(fs.existsSync(f.target),false);
  assert.equal(fs.statSync(f.external).ino,before.ino);assert.equal(fs.statSync(path.join(f.external,'payload')).ino,payload.ino);assert.equal(fs.readFileSync(path.join(f.external,'payload'),'utf8'),'external original bytes');
}));

for(const kind of ['unknown','tracked','not-ignored','stale','future','errors','references','attributed-real-target','pidless-real-target','borrowers','malformed','replaced-link','replaced-parent','changed-ignore','dangling','loop'])
 test(`cache symlink removal preserves ${kind} custody`,()=>fixture(f=>{
  let calls=0;
  const context={...f.context};
  if(kind==='unknown')context.declarations=['**/dist'];
  if(kind==='tracked')context.tracked=()=>true;
  if(kind==='not-ignored')context.ignored=()=>false;
  if(kind==='changed-ignore')context.ignored=()=>++calls===1;
  context.observe=()=>{
    const safety=f.clear();
    if(kind==='stale')safety.observedAt=Date.now()-61000;
    if(kind==='future')safety.observedAt=Date.now()+61000;
    if(kind==='errors')safety.errors=['unknown runtime'];
    if(kind==='references')safety.references=[{root:f.target,pid:42,kind:'alias-argument'}];
    if(kind==='attributed-real-target')safety.references=[{root:f.external,pid:42,kind:'real-target-read-fd'},{root:f.target,pid:42,kind:'alias-argument'}];
    if(kind==='pidless-real-target')safety.references=[{root:f.external,kind:'queued-stack-custody'}];
    if(kind==='borrowers')safety.retainedBorrowers=[{path:f.external}];
    if(kind==='malformed')return {};
    if(kind==='replaced-link'){fs.unlinkSync(f.target);fs.symlinkSync(f.external+'/payload',f.target);}
    if(kind==='replaced-parent'){fs.renameSync(path.dirname(f.target),path.dirname(f.target)+'.old');fs.mkdirSync(path.dirname(f.target));fs.symlinkSync(f.external,f.target);}
    return safety;
  };
  if(kind==='dangling'){fs.unlinkSync(f.target);fs.symlinkSync(f.external+'/missing',f.target);}
  if(kind==='loop'){fs.unlinkSync(f.target);fs.symlinkSync('node_modules',f.target);}
  assert.equal(unlinkDeclaredCacheSymlink(context),false);unchanged(f);
 }));

test('a reader of the shared real target alone does not retain the alias; its bytes and inode survive',()=>fixture(f=>{
  const payload=fs.statSync(path.join(f.external,'payload'));
  const references=[{root:f.external,pid:42,command:'bun test',matches:['fd:'+path.join(f.external,'payload')]}];
  assert.equal(unlinkDeclaredCacheSymlink({...f.context,observe:()=>({...f.clear(),references})}),true);
  assert.equal(fs.existsSync(f.target),false);
  assert.equal(fs.statSync(path.join(f.external,'payload')).ino,payload.ino);assert.equal(fs.readFileSync(path.join(f.external,'payload'),'utf8'),'external original bytes');
}));

test('a real target inside the checkout keeps every reference strict',()=>fixture(f=>{
  const inside=path.join(f.root,'vendor-deps');fs.mkdirSync(inside);fs.unlinkSync(f.target);fs.symlinkSync(inside,f.target);
  assert.equal(unlinkDeclaredCacheSymlink({...f.context,observe:()=>({...f.clear(),references:[{root:inside,pid:42}]})}),false);
  assert.equal(fs.lstatSync(f.target).isSymbolicLink(),true);
}));

test('foreign-owned cache symlink is retained without observing or changing its target',()=>fixture(f=>{
  execFileSync('sudo',['-n','chown','-h','65534:65534',f.target]);
  let observed=false;
  assert.equal(unlinkDeclaredCacheSymlink({...f.context,observe:()=>{observed=true;return f.clear();}}),false);
  assert.equal(observed,false);unchanged(f);
}));

for (const route of ['ordinary','group','terminal-retention']) test(`supported ${route} release removes a nested ignored dependency link and leaves canonical target intact`,()=>fixture(f=>{
  const state=path.join(f.base,'registry.sqlite3'),old=process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY;process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY='empty';
  const run=args=>{let out='';const write=process.stdout.write,code=process.exitCode;process.stdout.write=chunk=>{out+=chunk;return true;};try{main(args,state);}finally{process.stdout.write=write;process.exitCode=code;}return JSON.parse(out);};
  try {
    const record=run(['register','--path',f.root,'--root',f.base,'--owner','fixture','--source-commit',f.git('rev-parse','HEAD'),...(route==='group'?['--group','cache-links']:[]),'--json']);
    if (route==='group') {
      const peer=path.join(f.base,'peer');execFileSync('git',['clone',f.root,peer],{stdio:'ignore'});
      run(['register','--path',peer,'--root',f.base,'--owner','fixture','--source-commit',f.git('rev-parse','HEAD'),'--group','cache-links','--json']);
    }
    let terminal=[];
    if (route==='terminal-retention') {
      const db=new DatabaseSync(state);
      const plan=JSON.stringify({intent:'budgeted',constructionBytes:0,growthBytes:0,headroomBytes:8589934592,growthLifecycle:{kind:'retired-future-growth',remainingGrowthBytes:0,retainedUse:'source',dispositionSha256:'a'.repeat(64),retiredAt:Date.now()}});
      db.prepare('INSERT OR REPLACE INTO workspace_capacity(workspace_id,device_id,plan_json) VALUES(?,?,?)').run(record.id,String(fs.statSync(f.root).dev),plan);
      db.prepare('UPDATE workspace SET lease_expires_at=0 WHERE id=?').run(record.id);db.close();
      terminal=['--end-retention','--owner','fixture','--expected-plan-sha256',digest(plan)];
    }
    // Use the explicitly injected fixture operator, never the real running worker's
    // foreground context (which would detach physical effects outside this fixture).
    const db=w.openRegistry(state),named=new Map([['id',[record.id]],['json',['true']]]);
    for(let i=0;i<terminal.length;i++){const key=terminal[i].slice(2);named.set(key,[terminal[i+1]?.startsWith('--')||!terminal[i+1]?'true':terminal[++i]]);}
    let text='',output;const write=process.stdout.write;process.stdout.write=x=>{text+=x;return true;};try{w.releaseCommand(db,{positional:[],named},state,{caller:()=>({ok:true,kind:'operator'})});output=JSON.parse(text);}finally{process.stdout.write=write;db.close();}
    const result=route==='group'?output.find(r=>r.record.id===record.id):output;
    assert.equal(result.action,route==='group'?'released-group':'released',JSON.stringify(result));assert.ok(result.removedCaches.includes('products/kenan/node_modules'));
    assert.equal(fs.readFileSync(path.join(f.external,'payload'),'utf8'),'external original bytes');
  } finally {if(old===undefined)delete process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY;else process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY=old;}
}));

test('unknown ignored and tracked symlinks remain protected by the release Git contract',()=>fixture(f=>{
  fs.symlinkSync(f.external,path.join(f.root,'ignored-link'));
  const record={path:f.root,id:'fixture',cachePaths:['**/node_modules'],durableSourceCommit:f.git('rev-parse','HEAD'),checkoutType:'clone',leaseExpiresAt:0,state:'active'};
  const removed=w.stripCaches(record,path.join(f.base,'registry.sqlite3'),()=>{},()=>f.clear());
  assert.deepEqual(removed,['products/kenan/node_modules']);
  assert.equal(fs.lstatSync(path.join(f.root,'ignored-link')).isSymbolicLink(),true);
  const safety={processes:[],threads:[],installed:[],docker:{containers:[]},systemd:{units:[]},gitAlternates:[],linkedWorktrees:[]};
  const old=process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY;process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY='empty';
  try {assert.equal(w.inspectRecord(record,{safety,ignoreLease:true}).classification,'repair-required');}
  finally {if(old===undefined)delete process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY;else process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY=old;}
  fs.symlinkSync(f.external,f.target);f.git('add','-f','products/kenan/node_modules');f.git('commit','-m','tracked link');
  assert.deepEqual(w.stripCaches(record,path.join(f.base,'registry.sqlite3'),()=>{},()=>f.clear()),[]);unchanged(f);
}));

test('native all-FD observer: a real-target reader retains the alias only when attributed to it',async()=>{
  const base=fs.mkdtempSync(path.join(tmpdir(),'cache-link-native-')),root=path.join(base,'source'),external=path.join(base,'canonical');
  fs.mkdirSync(root);fs.mkdirSync(external);fs.writeFileSync(path.join(external,'payload'),'external');const target=path.join(root,'node_modules');fs.symlinkSync(external,target);
  // Open then erase the spelling from argv: /proc resolves this read FD to canonical.
  const child=spawn(process.execPath,['-e',`const f=require('node:fs');process.stdin.once('data',p=>{f.openSync(p.toString(),'r');console.log('ready');});setInterval(()=>{},1000);`],{stdio:['pipe','pipe','pipe']});
  try {
    child.stdin.end(path.join(target,'payload'));await once(child.stdout,'data');
    const entry=new URL('./workspace.mjs',import.meta.url).pathname;
    const refs=JSON.parse(execFileSync('sudo',['-n',process.execPath,entry,'materialization-process-snapshot','--path',target,'--path',external],{encoding:'utf8',timeout:15000}));
    assert.ok(refs.some(r=>r.pid===child.pid&&r.root===external&&r.matches.some(m=>m.includes('payload'))),JSON.stringify(refs));
    // The same descriptor plus the alias spelling in this process's arguments is attributed.
    const attributed=spawn(process.execPath,['-e',`setInterval(()=>{},1000)`,target],{stdio:'ignore'});
    try {
      await new Promise(resolve=>setTimeout(resolve,200));
      const named=JSON.parse(execFileSync('sudo',['-n',process.execPath,entry,'materialization-process-snapshot','--path',target,'--path',external],{encoding:'utf8',timeout:15000}));
      assert.ok(named.some(r=>r.pid===attributed.pid&&r.root===target),JSON.stringify(named));
      assert.equal(unlinkDeclaredCacheSymlink({root,target,declarations:['node_modules'],tracked:()=>false,ignored:()=>true,observe:()=>({errors:[],references:named,retainedBorrowers:[],observedAt:Date.now()}),invalidateCapacity:()=>assert.fail('referenced link cannot invalidate allocation')}),false);
      assert.equal(fs.lstatSync(target).isSymbolicLink(),true);
    } finally {attributed.kill('SIGKILL');await once(attributed,'exit');}
    // An unattributed reader keeps its descriptor; unlinking the alias never touches the target.
    assert.equal(unlinkDeclaredCacheSymlink({root,target,declarations:['node_modules'],tracked:()=>false,ignored:()=>true,observe:()=>({errors:[],references:refs,retainedBorrowers:[],observedAt:Date.now()}),invalidateCapacity:()=>{}}),true);
    assert.equal(fs.existsSync(target),false);assert.equal(fs.readFileSync(path.join(external,'payload'),'utf8'),'external');
  } finally {child.kill('SIGKILL');await once(child,'exit');fs.rmSync(base,{recursive:true,force:true});}
});

test('explicit cache declarations cannot delete or unlink through an aliased ancestor',()=>fixture(f=>{
  const alias=path.join(f.root,'alias');fs.symlinkSync(path.dirname(f.external),alias);
  const record={path:f.root,id:'fixture',cachePaths:['alias/node_modules']};
  let observed=false;
  assert.deepEqual(w.stripCaches(record,path.join(f.base,'registry.sqlite3'),()=>{},()=>{observed=true;return f.clear();}),['products/kenan/node_modules']);
  // Only the independently declared, owned original link was observed.
  assert.equal(observed,true);assert.equal(fs.lstatSync(alias).isSymbolicLink(),true);
  assert.equal(fs.readFileSync(path.join(f.external,'payload'),'utf8'),'external original bytes');
}));

test('unclassified dangling or empty-target ignored symlinks cannot disappear in a release inspection',()=>fixture(f=>{
  const record={path:f.root,id:'fixture',cachePaths:[],durableSourceCommit:f.git('rev-parse','HEAD'),checkoutType:'clone',leaseExpiresAt:0,state:'active'};
  const safety={processes:[],threads:[],installed:[],docker:{containers:[]},systemd:{units:[]},gitAlternates:[],linkedWorktrees:[]};
  const old=process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY;process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY='empty';
  fs.unlinkSync(f.target);
  try {
    for(const kind of ['absent','empty']) {
      const destination=path.join(f.base,kind);if(kind==='empty')fs.mkdirSync(destination);
      const link=path.join(f.root,'ignored-link');fs.symlinkSync(destination,link);
      assert.equal(w.inspectRecord(record,{safety,ignoreLease:true}).classification,'repair-required');
      assert.equal(fs.lstatSync(link).isSymbolicLink(),true);fs.unlinkSync(link);
    }
  } finally {if(old===undefined)delete process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY;else process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY=old;}
}));

import {cacheAliasInstalledReferences} from './cache-symlink.mjs';
test('canonical installed dependencies do not borrow an unused root alias, but lexical alias references do',()=>fixture(f=>{
  const rootAlias=path.join(f.root,'node_modules');fs.symlinkSync(f.external,rootAlias);
  const canonical=[{file:'/opt/sender/bundle.js',path:path.join(f.external,'payload')}];
  const selected=cacheAliasInstalledReferences(rootAlias,canonical);
  assert.deepEqual(selected,[]);
  assert.equal(unlinkDeclaredCacheSymlink({root:f.root,target:rootAlias,declarations:['node_modules'],tracked:()=>false,ignored:()=>true,
    observe:()=>({...f.clear(),references:selected}),invalidateCapacity:()=>{}}),true);
  assert.equal(fs.readFileSync(path.join(f.external,'payload'),'utf8'),'external original bytes');
  fs.symlinkSync(f.external,rootAlias);
  const lexical={file:'/opt/sender/alias.js',path:path.join(rootAlias,'payload')};
  const refs=cacheAliasInstalledReferences(rootAlias,[...canonical,lexical,{path:rootAlias+'-other/payload'}]);
  assert.deepEqual(refs,[lexical]);
  assert.equal(unlinkDeclaredCacheSymlink({root:f.root,target:rootAlias,declarations:['node_modules'],tracked:()=>false,ignored:()=>true,
    observe:()=>({...f.clear(),references:refs}),invalidateCapacity:()=>assert.fail('borrowed alias')}),false);
  assert.equal(fs.lstatSync(rootAlias).isSymbolicLink(),true);
}));
