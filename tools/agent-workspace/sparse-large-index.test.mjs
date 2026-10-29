import './scratch-env.mjs';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {spawnSync,execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const modulePath=fileURLToPath(new URL('./workspace.mjs',import.meta.url));

// 2026-10-29: a sparse create against the renia research remote failed with ENOBUFS because the sparse selection read
// `git ls-files -t -z` (over 16 MiB) through one spawnSync buffer. The selection must stream any index size.
test('sparse capacity estimate streams an index listing over 16 MiB',()=>{
 const root=mkdtempSync(path.join(tmpdir(),'sparse-large-index-'));const repo=path.join(root,'repo'),pool=path.join(root,'pool'),state=path.join(root,'state','registry.sqlite3');
 const git=(args,input)=>execFileSync('git',args,{encoding:'utf8',timeout:60_000,input,maxBuffer:1<<30,env:{...process.env,GIT_INDEX_FILE:path.join(repo,'.git','index')}}).trim();
 try{
  mkdirSync(repo);mkdirSync(pool);git(['init','-q','-b','main',repo]);
  const blob=git(['-C',repo,'hash-object','-w','--stdin'],'x');
  const stem='d'.repeat(180);const count=90_000;let listing='';
  for(let i=0;i<count;i++)listing+=`100644 ${blob}\t${stem}/${String(i).padStart(8,'0')}.txt\0`;
  listing+=`100644 ${blob}\tone.txt\0`;
  assert.ok(Buffer.byteLength(listing)>16*1024*1024);
  git(['-C',repo,'update-index','--add','-z','--index-info'],listing);
  const tree=git(['-C',repo,'write-tree']);
  const head=git(['-C',repo,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit-tree',tree,'-m','large index']);
  git(['-C',repo,'update-ref','refs/heads/main',head]);
  const result=spawnSync(process.execPath,[modulePath,'create','--root',pool,'--name','refused','--repo',repo,'--ref',head,'--owner','fixture','--mode','writer','--intent','source-only','--headroom-gib','1000000','--growth-mib','2','--sparse-pattern','/one.txt','--json'],{encoding:'utf8',timeout:120_000,env:{...process.env,PI_WORKSPACE_STATE:state,PI_WORKSPACE_CREATE_CHILD:''}});
  assert.doesNotMatch(result.stderr,/ENOBUFS|maxBuffer/);
  assert.equal(result.status,2,result.stderr);
  assert.match(result.stderr,/capacity-detail: /,'the create got past the sparse estimate to the capacity decision');
  assert.equal(existsSync(path.join(pool,'refused')),false);
 }finally{rmSync(root,{recursive:true,force:true});}
});
