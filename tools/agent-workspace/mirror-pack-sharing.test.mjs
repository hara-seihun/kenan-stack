import './scratch-env.mjs';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readdirSync,statSync,rmSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {shareMirrorPacks} from './mirror-pack-sharing.mjs';

const entry=new URL('./main',import.meta.url).pathname;
const sha=value=>createHash('sha256').update(value).digest('hex');
const run=(cwd,...args)=>execFileSync('git',args,{cwd,encoding:'utf8'}).trim();
const packs=dir=>readdirSync(path.join(dir,'objects','pack')).filter(name=>name.endsWith('.pack')).map(name=>statSync(path.join(dir,'objects','pack',name)));
const inodes=dir=>new Set(packs(dir).map(s=>s.ino));
const complete=(dir,commit)=>spawnSync('git',['--git-dir',dir,'rev-list','--objects','--missing=error',commit],{env:{...process.env,GIT_ALTERNATE_OBJECT_DIRECTORIES:''}}).status===0;

function fixture(){
 const root=mkdtempSync(path.join(tmpdir(),'mirror-pack-sharing-'));
 const work=path.join(root,'work'),source=path.join(root,'source.git');
 mkdirSync(work);run(work,'init','-q','-b','main');run(work,'config','user.name','T');run(work,'config','user.email','t@example.invalid');
 run(root,'init','-q','--bare',source);run(work,'remote','add','origin',source);
 const commit=name=>{writeFileSync(path.join(work,name),`${name}\n`.repeat(4096));run(work,'add','.');run(work,'commit','-qm',name);run(work,'push','-qf','origin','HEAD:main');return run(work,'rev-parse','HEAD');};
 return {root,work,source,commit,cleanup:()=>rmSync(root,{recursive:true,force:true})};
}

test('a same-filesystem mirror holds its source packs by hard link and drops its own copies, staying complete after the source repacks and prunes',()=>{
 const f=fixture();
 try {
  const first=f.commit('a'),second=f.commit('b');
  run(f.source,'repack','-qad');
  const mirror=path.join(f.root,'mirror.git');run(f.root,'init','-q','--bare',mirror);
  run(mirror,'-c','fetch.unpackLimit=1','fetch','-q',f.source,'+refs/heads/main:refs/heads/main');
  assert.equal(packs(mirror).every(s=>s.nlink===1),true);
  const shared=shareMirrorPacks({mirror,sources:[f.source],exclusive:action=>action()});
  assert.equal(shared.ok,true);assert.equal(shared.value.state,'shared');
  assert.ok(shared.value.freedBytes>0,JSON.stringify(shared.value));
  assert.deepEqual(inodes(mirror),inodes(f.source));
  assert.ok(complete(mirror,second));

  // The source rewrites history away and prunes; the mirror's link keeps every object.
  run(f.work,'reset','-q','--hard',first);const third=f.commit('c');
  run(f.source,'-c','gc.reflogExpire=now','reflog','expire','--all');run(f.source,'repack','-qad');run(f.source,'prune','--expire=now');
  assert.ok(!complete(f.source,second));assert.ok(complete(mirror,second));

  // A mirror object the source no longer has survives in a residue pack; the rest is shared again.
  const again=shareMirrorPacks({mirror,sources:[f.source],exclusive:action=>action()});
  assert.equal(again.value.rewrittenPacks,1,JSON.stringify(again.value));
  assert.ok(complete(mirror,second));
  for (const ino of inodes(f.source)) assert.ok(inodes(mirror).has(ino));
  assert.equal(packs(mirror).filter(s=>!inodes(f.source).has(s.ino)).length,1);
  assert.ok(spawnSync('git',['--git-dir',mirror,'cat-file','-e',`${third}^{commit}`]).status===0);
 } finally {f.cleanup();}
});

test('a local import of a packed source copies no object bytes and a later commit shares the new pack',()=>{
 const f=fixture();
 try {
  const first=f.commit('a');run(f.source,'repack','-qad');
  const state=path.join(f.root,'state','registry.sqlite3'),workspaces=path.join(f.root,'workspaces');mkdirSync(workspaces);
  const env={...process.env,PI_WORKSPACE_STATE:state,PI_WORKSPACE_TEST_EXTERNAL_SAFETY:'empty'};
  const create=(name,commit)=>{
   const end=Date.now()+45000;let result;
   do{result=spawnSync(entry,['create','--root',workspaces,'--name',name,'--repo',f.source,'--ref',commit,'--owner','fixture','--intent','source-only','--headroom-gib','1','--growth-mib','512','--json'],{env,encoding:'utf8',timeout:30000});}
   while(result.status===75&&Date.now()<end);
   assert.equal(result.status,0,result.stderr+result.stdout);return JSON.parse(result.stdout);
  };
  const mirror=path.join(f.root,'state','mirrors',sha(f.source).slice(0,24)+'.git');
  assert.equal(create('one',first).sourceCommit,first);
  assert.deepEqual(inodes(mirror),inodes(f.source));
  const second=f.commit('b');run(f.source,'repack','-qad');
  assert.equal(create('two',second).sourceCommit,second);
  assert.deepEqual(inodes(mirror),inodes(f.source),'the superseded pack was dropped and the new one shared');
  assert.equal(spawnSync('git',['-C',path.join(workspaces,'one'),'fsck','--connectivity-only'],{encoding:'utf8'}).status,0);
 } finally {f.cleanup();}
});
