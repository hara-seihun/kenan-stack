import './scratch-env.mjs';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';

// A clone whose origin is a local bare repository borrows that repository's objects after
// its mirror, so a fetch from origin moves refs only (2026-11-02: a Seinari clone's
// `git fetch origin` copied 143,207 objects it already had and ran for 115 s).
const entry=new URL('./main',import.meta.url).pathname;
const run=(cwd,...args)=>execFileSync('git',args,{cwd,encoding:'utf8'}).trim();
const ownObjects=dir=>Object.fromEntries(run(dir,'count-objects','-v').split('\n').map(line=>line.split(': ')).filter(([k])=>['count','in-pack'].includes(k)));

function fixture(){
 const root=mkdtempSync(path.join(tmpdir(),'origin-borrowing-'));
 const work=path.join(root,'work'),remote=path.join(root,'remote.git'),workspaces=path.join(root,'workspaces');
 mkdirSync(work);mkdirSync(workspaces);
 run(work,'init','-q','-b','main');run(work,'config','user.name','T');run(work,'config','user.email','t@example.invalid');
 run(root,'init','-q','--bare',remote);run(work,'remote','add','origin',remote);
 const commit=name=>{writeFileSync(path.join(work,name),`${name}\n`.repeat(4096));run(work,'add','.');run(work,'commit','-qm',name);run(work,'push','-qf','origin','HEAD:main');return run(work,'rev-parse','HEAD');};
 const env={...process.env,PI_WORKSPACE_STATE:path.join(root,'state','registry.sqlite3'),PI_WORKSPACE_TEST_EXTERNAL_SAFETY:'empty'};
 const create=(name,repo,ref)=>{
  const end=Date.now()+45000;let result;
  do{result=spawnSync(entry,['create','--root',workspaces,'--name',name,'--repo',repo,'--ref',ref,'--owner','fixture','--intent','source-only','--headroom-gib','1','--growth-mib','512','--json'],{env,encoding:'utf8',timeout:30000});}
  while(result.status===75&&Date.now()<end);
  assert.equal(result.status,0,result.stderr+result.stdout);return path.join(workspaces,name);
 };
 const alternates=clone=>readFileSync(path.join(clone,'.git','objects','info','alternates'),'utf8').split('\n').filter(Boolean);
 return {root,work,remote,commit,create,alternates,cleanup:()=>rmSync(root,{recursive:true,force:true})};
}

test('a clone of a checkout whose origin is a local bare repository borrows its objects and fetches only refs',()=>{
 const f=fixture();
 try {
  const first=f.commit('a');
  const clone=f.create('one',f.work,first);
  assert.equal(run(clone,'remote','get-url','origin'),f.remote);
  const [mirror,...borrowed]=f.alternates(clone);
  assert.equal(path.dirname(path.dirname(mirror)),path.join(f.root,'state','mirrors'));
  assert.deepEqual(borrowed,[path.join(realpathSync(f.remote),'objects')]);
  const before=ownObjects(clone);
  const second=f.commit('b');
  run(clone,'fetch','-q','origin','main');
  assert.equal(run(clone,'rev-parse','origin/main'),second);
  assert.deepEqual(ownObjects(clone),before,'the fetch copied no objects into the clone');
  assert.equal(spawnSync('git',['-C',clone,'fsck','--connectivity-only'],{encoding:'utf8'}).status,0);
 } finally {f.cleanup();}
});

test('a clone whose origin is a working checkout borrows only its mirror',()=>{
 const f=fixture();
 try {
  writeFileSync(path.join(f.work,'a'),'a\n');run(f.work,'add','.');run(f.work,'commit','-qm','a');run(f.work,'remote','remove','origin');
  const clone=f.create('one',f.work,run(f.work,'rev-parse','HEAD'));
  assert.equal(run(clone,'remote','get-url','origin'),f.work);
  const stores=f.alternates(clone);
  assert.equal(stores.length,1);assert.equal(path.dirname(path.dirname(stores[0])),path.join(f.root,'state','mirrors'));
 } finally {f.cleanup();}
});
