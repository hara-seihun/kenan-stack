import './scratch-env.mjs';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {execFileSync,spawn,spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readdirSync,existsSync,rmSync,utimesSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import path from 'node:path';

const scratch=mkdtempSync(path.join(tmpdir(),'mirror-retirement-'));
process.env.AGENT_WORKSPACE_PACK_LOCK=path.join(scratch,'pack.lock');
const {shareMirrorPacks,removeStaleTemporaryPacks}=await import('./mirror-pack-sharing.mjs');
const {sourcesRewritten,classifyMirrors,lastActivityMs,hostMirrorBorrowers,markMirrorUse}=await import('./mirror-retirement.mjs');

const entry=new URL('./main',import.meta.url).pathname;
const sha=value=>createHash('sha256').update(value).digest('hex');
const run=(cwd,...args)=>execFileSync('git',args,{cwd,encoding:'utf8'}).trim();
const complete=(dir,commit)=>spawnSync('git',['--git-dir',dir,'rev-list','--objects','--missing=error',commit],{env:{...process.env,GIT_ALTERNATE_OBJECT_DIRECTORIES:''}}).status===0;
const packCount=dir=>readdirSync(path.join(dir,'objects','pack')).filter(name=>name.endsWith('.pack')).length;

function fixture(){
 const root=mkdtempSync(path.join(scratch,'f-'));
 const work=path.join(root,'work'),source=path.join(root,'source.git');
 mkdirSync(work);run(work,'init','-q','-b','main');run(work,'config','user.name','T');run(work,'config','user.email','t@example.invalid');
 run(root,'init','-q','--bare',source);run(work,'remote','add','origin',source);
 const commit=name=>{mkdirSync(path.join(work,name,'deep'),{recursive:true});writeFileSync(path.join(work,name,'deep','f'),`${name}\n`.repeat(4096));run(work,'add','.');run(work,'commit','-qm',name);run(work,'push','-qf','origin','HEAD:main');return run(work,'rev-parse','HEAD');};
 return {root,work,source,commit};
}

test('a mirror of a local source also takes the loose objects pushed since its last repack, so it holds the new commit without a fetch',()=>{
 const f=fixture();
 f.commit('a');run(f.source,'repack','-qad');
 const loose=f.commit('b'); // a small push stays loose in the source
 const mirror=path.join(f.root,'mirror.git');run(f.root,'init','-q','--bare',mirror);
 const shared=shareMirrorPacks({mirror,sources:[f.source],exclusive:action=>action()});
 assert.equal(shared.ok,true);
 assert.ok(shared.value.linkedLoose+shared.value.copiedLoose>0,JSON.stringify(shared.value));
 assert.ok(complete(mirror,loose),'the loose commit and its trees are present');
});

test('abandoned temporary packs older than an hour are removed and a live one is kept',()=>{
 const f=fixture();
 const mirror=path.join(f.root,'mirror.git');run(f.root,'init','-q','--bare',mirror);
 const dir=path.join(mirror,'objects','pack');
 writeFileSync(path.join(dir,'tmp_pack_dead'),'x'.repeat(8192));writeFileSync(path.join(dir,'tmp_pack_live'),'x');
 const old=(Date.now()-2*3600_000)/1000;utimesSync(path.join(dir,'tmp_pack_dead'),old,old);
 const result=removeStaleTemporaryPacks(mirror);
 assert.equal(result.removed,1);
 assert.ok(!existsSync(path.join(dir,'tmp_pack_dead')));assert.ok(existsSync(path.join(dir,'tmp_pack_live')));
});

test('a pack rewrite skips instead of waiting while another rewrite holds the host lock, and runs once it is free',async()=>{
 const f=fixture();
 const first=f.commit('a');f.commit('b');run(f.source,'repack','-qad');
 const mirror=path.join(f.root,'mirror.git');run(f.root,'init','-q','--bare',mirror);
 run(mirror,'-c','fetch.unpackLimit=1','fetch','-q',f.source,'+refs/heads/main:refs/heads/main');
 // The source rewrites history and prunes: the mirror's own pack is now only partly covered.
 run(f.work,'reset','-q','--hard',first);f.commit('c');
 run(f.source,'-c','gc.reflogExpire=now','reflog','expire','--all');run(f.source,'repack','-qad');run(f.source,'prune','--expire=now');
 const holder=spawn('flock',[process.env.AGENT_WORKSPACE_PACK_LOCK,'sleep','30'],{stdio:'ignore',detached:true});
 try {
  for (let i=0;i<50&&spawnSync('flock',['-n',process.env.AGENT_WORKSPACE_PACK_LOCK,'true']).status===0;i++) await new Promise(r=>setTimeout(r,50));
  const busy=shareMirrorPacks({mirror,sources:[f.source],exclusive:action=>action()});
  assert.equal(busy.value.rewriteBusy,true,JSON.stringify(busy.value));
  assert.equal(busy.value.rewrittenPacks,0);
 } finally {const exited=new Promise(r=>holder.on('exit',r));process.kill(-holder.pid,'SIGKILL');await exited;}
 const free=shareMirrorPacks({mirror,sources:[f.source],exclusive:action=>action()});
 assert.equal(free.value.rewrittenPacks,1,JSON.stringify(free.value));
 assert.ok(packCount(mirror)>=1);
});

test('prune-mirrors removes a mirror whose source is gone or that sat unused, keeps one a checkout still borrows, and create rebuilds a pruned mirror',()=>{
 const f=fixture();
 f.commit('a');run(f.source,'repack','-qad');
 const other=fixture();const otherCommit=other.commit('z');
 const state=path.join(f.root,'state','registry.sqlite3'),workspaces=path.join(f.root,'workspaces');mkdirSync(workspaces);
 const env={...process.env,PI_WORKSPACE_STATE:state,PI_WORKSPACE_TEST_EXTERNAL_SAFETY:'empty',AGENT_WORKSPACE_COLD_OWNERS:path.join(f.root,'no-cold-tier'),AGENT_WORKSPACE_MIRROR_SCAN_ROOTS:f.root};
 const cli=(...args)=>spawnSync(entry,args,{env,encoding:'utf8',timeout:60000});
 const create=(name,repo,commit)=>{
  const end=Date.now()+45000;let result;
  do{result=cli('create','--root',workspaces,'--name',name,'--repo',repo,'--ref',commit,'--owner','fixture','--intent','source-only','--headroom-gib','1','--growth-mib','512','--json');}
  while(result.status===75&&Date.now()<end);
  assert.equal(result.status,0,result.stderr+result.stdout);return JSON.parse(result.stdout);
 };
 const prune=(...extra)=>{const result=cli('prune-mirrors','--json',...extra);assert.equal(result.status,0,result.stderr+result.stdout);return JSON.parse(result.stdout);};
 const mirrorOf=repo=>path.join(f.root,'state','mirrors',sha(repo).slice(0,24)+'.git');
 const db=()=>new DatabaseSync(state);
 const release=name=>{const d=db();d.prepare("UPDATE workspace SET state='released' WHERE path=?").run(path.join(workspaces,name));d.close();};

 const head=run(f.source,'rev-parse','main');
 create('one',f.source,head);
 create('two',other.source,otherCommit);
 const gone=mirrorOf(f.source),unused=mirrorOf(other.source);
 assert.ok(existsSync(gone)&&existsSync(unused));

 // Source deleted, workspace released, but its checkout still exists and borrows the mirror's objects.
 rmSync(f.source,{recursive:true,force:true});release('one');
 const borrowedAlternates=readdirSync(path.join(workspaces,'one','.git','objects','info')).includes('alternates');
 let verdict=prune('--execute');
 if (borrowedAlternates) {
  assert.ok(existsSync(gone),'a borrowed mirror is kept');
  assert.equal(verdict.retired.some(r=>r.mirror===gone),false);
 }
 // Once nothing borrows it, a mirror whose source is gone goes.
 rmSync(path.join(workspaces,'one'),{recursive:true,force:true});
 verdict=prune('--execute');
 assert.deepEqual(verdict.retired.filter(r=>r.mirror===gone).map(r=>[r.reason,r.action]),[['source-gone','removed']]);
 assert.ok(!existsSync(gone));
 // A mirror an unreleased workspace names is kept even when idle; once released and idle it goes.
 assert.ok(existsSync(unused));
 assert.equal(prune('--execute','--unused-days','0').retired.some(r=>r.mirror===unused),false);
 release('two');rmSync(path.join(workspaces,'two'),{recursive:true,force:true});
 assert.equal(prune('--unused-days','0').retired.find(r=>r.mirror===unused)?.action,'would-remove');
 assert.ok(existsSync(unused),'a dry run removes nothing');
 assert.equal(prune('--execute','--unused-days','0').retired.find(r=>r.mirror===unused)?.action,'removed');
 assert.ok(!existsSync(unused));
 // The registry still has rows for that mirror's source; a new create simply rebuilds it.
 assert.equal(create('three',other.source,otherCommit).sourceCommit,otherCommit);
 assert.ok(complete(unused,otherCommit));
});

test('a mirror counts as rewritten only once its local source holds none of the commits it keeps custody of',()=>{
 const f=fixture();
 const old=f.commit('a');
 const mirror=path.join(f.root,'mirror.git');run(f.root,'init','-q','--bare',mirror);
 run(mirror,'fetch','-q',f.source,`${old}:refs/pi-workspace/sources/x`);
 assert.equal(sourcesRewritten(mirror,[f.source]),false);
 // The source's history is replaced (as a move of large files to LFS does) and the old commits are pruned.
 run(f.work,'checkout','-q','--orphan','fresh');f.commit('b');
 run(f.source,'-c','gc.reflogExpire=now','reflog','expire','--all');run(f.source,'gc','-q','--prune=now');
 assert.equal(sourcesRewritten(mirror,[f.source]),true);
});

// A bare mirror of `origin` whose every file looks `ageDays` old.
function agedMirror(root,name,origin,ageDays){
 const mirror=path.join(root,'mirrors',name);mkdirSync(path.dirname(mirror),{recursive:true});
 run(root,'init','-q','--bare',mirror);run(mirror,'remote','add','origin',origin);
 const when=(Date.now()-ageDays*86_400_000)/1000;
 const walk=dir=>{for(const entry of readdirSync(dir,{withFileTypes:true})){const file=path.join(dir,entry.name);if(entry.isDirectory())walk(file);utimesSync(file,when,when);}utimesSync(dir,when,when);};
 walk(mirror);return mirror;
}
const borrowFrom=(root,name,mirror)=>{const repo=path.join(root,name);run(root,'init','-q',repo);writeFileSync(path.join(repo,'.git','objects','info','alternates'),path.join(mirror,'objects')+'\n');return repo;};

test('of two mirrors of one origin the idle extra one is retired, and the one a checkout borrows is kept',()=>{
 const root=mkdtempSync(path.join(scratch,'dup-'));
 const kept=agedMirror(root,'a.git','https://example.invalid/r.git',5),extra=agedMirror(root,'b.git','https://example.invalid/r.git',3);
 const lone=agedMirror(root,'c.git','https://example.invalid/other.git',3);
 const checkout=borrowFrom(root,'checkout',kept);
 const verdicts=Object.fromEntries(classifyMirrors({mirrorRoot:path.join(root,'mirrors'),checkouts:[checkout],unusedDays:14}).map(v=>[path.basename(v.mirror),v]));
 assert.equal(verdicts['a.git'].reason,'borrowed');
 assert.deepEqual([verdicts['b.git'].retire,verdicts['b.git'].reason,verdicts['b.git'].duplicateOf],[true,'duplicate',kept]);
 assert.equal(verdicts['c.git'].reason,'recent','a mirror with no twin stays until it is unused');
 // An extra mirror used within the last day is left alone, so a create in flight keeps its mirror.
 markMirrorUse(extra);
 const again=classifyMirrors({mirrorRoot:path.join(root,'mirrors'),checkouts:[checkout],unusedDays:14}).find(v=>v.mirror===extra);
 assert.equal(again.reason,'recent');
 // With nothing borrowing either, the more recently used one is kept.
 const both=classifyMirrors({mirrorRoot:path.join(root,'mirrors'),checkouts:[],unusedDays:14,now:Date.now()+2*86_400_000});
 assert.deepEqual(both.filter(v=>v.origin==='https://example.invalid/r.git').map(v=>[path.basename(v.mirror),v.reason]),[['a.git','duplicate'],['b.git','recent']]);
});

test('relinking packs into a mirror is not use, and only the mirror create would read from counts as an unreleased workspace\'s',()=>{
 const root=mkdtempSync(path.join(scratch,'idle-'));
 const mirror=agedMirror(root,'m.git','https://example.invalid/m.git',30);
 const before=lastActivityMs(mirror);
 writeFileSync(path.join(mirror,'objects','pack','pack-x.keep'),'');
 assert.equal(lastActivityMs(mirror),before,'share-mirror-packs writes do not refresh a mirror');
 const classify=activeMirrors=>classifyMirrors({mirrorRoot:path.join(root,'mirrors'),checkouts:[],unusedDays:14,activeMirrors})[0];
 // An unreleased workspace whose repository merely appears among this mirror's sources no longer pins it.
 assert.equal(classify([path.join(root,'mirrors','other.git')]).reason,'unused');
 assert.equal(classify([mirror]).reason,'active-workspace');
});

test('the host scan finds a checkout outside the usual folders that borrows a mirror, by absolute or relative alternates',()=>{
 const root=mkdtempSync(path.join(scratch,'scan-'));
 const mirrorRoot=path.join(root,'state','mirrors');
 const a=agedMirror(path.join(root,'state'),'a.git','https://example.invalid/a.git',30),b=agedMirror(path.join(root,'state'),'b.git','https://example.invalid/b.git',30);
 agedMirror(path.join(root,'state'),'c.git','https://example.invalid/c.git',30);
 const far=path.join(root,'somewhere','deep','x');mkdirSync(far,{recursive:true});
 const absolute=borrowFrom(far,'abs',a);
 const relative=path.join(far,'rel');run(far,'init','-q',relative);
 writeFileSync(path.join(relative,'.git','objects','info','alternates'),path.relative(path.join(relative,'.git','objects'),path.join(b,'objects'))+'\n');
 const unrelated=path.join(far,'plain');run(far,'init','-q',unrelated);writeFileSync(path.join(unrelated,'.git','objects','info','alternates'),'');
 const found=hostMirrorBorrowers([path.join(root,'somewhere')],mirrorRoot);
 assert.deepEqual(found.gitDirectories,[path.join(absolute,'.git'),path.join(relative,'.git')].sort());
 const verdicts=classifyMirrors({mirrorRoot,checkouts:[],coldBorrowed:new Set(found.objectDirectories),unusedDays:14});
 assert.deepEqual(verdicts.map(v=>[path.basename(v.mirror),v.reason]),[['a.git','borrowed'],['b.git','borrowed'],['c.git','unused']]);
});

test.after(()=>rmSync(scratch,{recursive:true,force:true}));
