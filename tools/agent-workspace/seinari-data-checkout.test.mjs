import './scratch-env.mjs';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';

const entry=new URL('./main',import.meta.url).pathname;
const hasSeinariData=spawnSync('seinari-data',['is-data','x.bin','1']).status!==null&&spawnSync('git',['config','--get','filter.seinari-data.process']).status===0;

// 2026-11-01: four /compiler/symbolic-search/ clones wrote 13 GiB of data each (10 GiB of research evidence nothing
// read) and root went from 76% to 83% in 15 minutes. A clone writes the data its code names, as research-clone does
// (2026-10-31: a /compiler/ clone that left instruction-schema.json as a pointer broke every reader), and admission
// prices exactly that.
test('a workspace checkout of a seinari-data repository writes the data its code reads and leaves other data as pointers',{skip:!hasSeinariData&&'seinari-data filter not installed'},()=>{
 const root=mkdtempSync(path.join(tmpdir(),'seinari-data-checkout-'));
 try {
  const env={...process.env,SEINARI_DATA_STORE:path.join(root,'store'),XDG_CACHE_HOME:path.join(root,'cache'),PI_WORKSPACE_STATE:path.join(root,'state','registry.sqlite3'),PI_WORKSPACE_TEST_EXTERNAL_SAFETY:'empty'};
  const run=(cwd,...args)=>execFileSync('git',args,{cwd,env,encoding:'utf8'}).trim();
  const work=path.join(root,'work');mkdirSync(path.join(work,'compiler','evidence'),{recursive:true});
  run(work,'init','-q','-b','main');run(work,'config','user.name','T');run(work,'config','user.email','t@example.invalid');
  writeFileSync(path.join(work,'.gitattributes'),'* filter=seinari-data\n');
  const bytes=Buffer.from('real data bytes, not a pointer\n'.repeat(64)),evidence=Buffer.alloc(3<<20,7);
  writeFileSync(path.join(work,'compiler','fixture.bin'),bytes);
  writeFileSync(path.join(work,'compiler','load.ts'),"export const fixture = new URL('./fixture.bin', import.meta.url);\n");
  writeFileSync(path.join(work,'compiler','evidence','run.bin'),evidence);
  run(work,'add','.');run(work,'commit','-qm','data');
  assert.match(run(work,'show','HEAD:compiler/fixture.bin'),/^version https:\/\/git-lfs/u,'fixture must commit a pointer');
  const workspaces=path.join(root,'workspaces');mkdirSync(workspaces);
  const end=Date.now()+45000;let result;
  do{result=spawnSync(entry,['create','--root',workspaces,'--name','data','--repo',work,'--owner','fixture','--intent','source-only','--headroom-gib','1','--growth-mib','512','--sparse-pattern','/compiler/','--json'],{env,encoding:'utf8',timeout:40000});}
  while(result.status===75&&Date.now()<end);
  assert.equal(result.status,0,result.stderr+result.stdout);
  const clone=path.join(workspaces,'data');
  assert.deepEqual(readFileSync(path.join(clone,'compiler','fixture.bin')),bytes);
  assert.match(readFileSync(path.join(clone,'compiler','evidence','run.bin'),'utf8'),/^version https:\/\/git-lfs/u);
  assert.equal(run(clone,'status','--porcelain'),'');
  assert.equal(run(clone,'config','--get','seinari-data.selective'),'true');
  const blobBytes=Number(/"materializedBlobBytes":\s*(\d+)/u.exec(result.stdout)[1]);
  assert.ok(blobBytes<evidence.length,`priced ${blobBytes} bytes; the unread ${evidence.length}-byte file is a pointer`);
  assert.ok(blobBytes>=bytes.length,`priced ${blobBytes} bytes; the read file has ${bytes.length}`);
 } finally {rmSync(root,{recursive:true,force:true});}
});
