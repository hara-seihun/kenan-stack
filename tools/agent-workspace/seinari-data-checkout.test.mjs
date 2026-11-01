import './scratch-env.mjs';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';

const entry=new URL('./main',import.meta.url).pathname;
const hasSeinariData=spawnSync('seinari-data',['is-data','x.bin','1']).status!==null&&spawnSync('git',['config','--get','filter.seinari-data.process']).status===0;

// 2026-10-31: the host git template made new clones selective, so a sparse /compiler/ workspace of seinari.git
// held git-lfs pointer files for its archives and its 13 MB instruction-schema.json, and every reader failed.
test('a workspace checkout of a seinari-data repository writes the bytes of every data file it selects',{skip:!hasSeinariData&&'seinari-data filter not installed'},()=>{
 const root=mkdtempSync(path.join(tmpdir(),'seinari-data-checkout-'));
 try {
  const env={...process.env,SEINARI_DATA_STORE:path.join(root,'store'),PI_WORKSPACE_STATE:path.join(root,'state','registry.sqlite3'),PI_WORKSPACE_TEST_EXTERNAL_SAFETY:'empty'};
  const run=(cwd,...args)=>execFileSync('git',args,{cwd,env,encoding:'utf8'}).trim();
  const work=path.join(root,'work');mkdirSync(path.join(work,'compiler'),{recursive:true});
  run(work,'init','-q','-b','main');run(work,'config','user.name','T');run(work,'config','user.email','t@example.invalid');
  writeFileSync(path.join(work,'.gitattributes'),'* filter=seinari-data\n');
  const bytes=Buffer.from('real data bytes, not a pointer\n'.repeat(64));
  writeFileSync(path.join(work,'compiler','fixture.bin'),bytes);
  run(work,'add','.');run(work,'commit','-qm','data');
  assert.match(run(work,'show','HEAD:compiler/fixture.bin'),/^version https:\/\/git-lfs/u,'fixture must commit a pointer');
  const workspaces=path.join(root,'workspaces');mkdirSync(workspaces);
  const end=Date.now()+45000;let result;
  do{result=spawnSync(entry,['create','--root',workspaces,'--name','data','--repo',work,'--owner','fixture','--intent','source-only','--headroom-gib','1','--growth-mib','512','--sparse-pattern','/compiler/','--json'],{env,encoding:'utf8',timeout:40000});}
  while(result.status===75&&Date.now()<end);
  assert.equal(result.status,0,result.stderr+result.stdout);
  assert.deepEqual(readFileSync(path.join(workspaces,'data','compiler','fixture.bin')),bytes);
 } finally {rmSync(root,{recursive:true,force:true});}
});
