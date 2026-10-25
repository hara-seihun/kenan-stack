import './scratch-env.mjs';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {recentImportBase,IMPORT_ANCESTOR_LIMIT} from './import-ancestors.mjs';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {workspaceTesting} from './workspace.mjs';
test('source ancestor search is finite and unknown closure is never accepted',()=>{
 let observed;const ids=['1'.repeat(40),'2'.repeat(40)];
 const options={git:(r,a)=>{observed=a;return ids.join('\n')},closure:()=>false};
 assert.equal(recentImportBase('/source',ids[0],'/mirror',options),null);
 assert.ok(observed.includes(`--max-count=${IMPORT_ANCESTOR_LIMIT}`));
 assert.equal(recentImportBase('/source',ids[0],'/mirror',{...options,closure:(_,id)=>id===ids[1]}),ids[1]);
 assert.throws(()=>recentImportBase('s','h','m',{...options,closure:()=>{throw Error('custody unknown')}}),/custody unknown/);
});
test('real mirror recent ancestor wins over 16 old lexical refs without changing source or charging zero',()=>{
 const root=mkdtempSync(path.join(tmpdir(),'recent-base-'));const source=path.join(root,'source'),mirror=path.join(root,'mirror.git');
 const run=(...a)=>execFileSync('git',a,{encoding:'utf8',stdio:['pipe','pipe','pipe']}).trim();
 const git=(...a)=>run('-C',source,...a);
 try {
  run('init',source);git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');
  writeFileSync(path.join(source,'f'),'base');git('add','.');git('commit','-m','base');const old=git('rev-parse','HEAD');
  for(let i=0;i<16;i++)git('branch',`a${String(i).padStart(2,'0')}`,old);
  for(let i=0;i<5;i++){writeFileSync(path.join(source,'f'),`version${i}`);git('commit','-am',`v${i}`);}
  const recent=git('rev-parse','HEAD');run('clone','--bare',source,mirror);
  writeFileSync(path.join(source,'f'),'new source');git('commit','-am','new');const head=git('rev-parse','HEAD');
  assert.deepEqual(workspaceTesting.importBaseCommits(source,head,mirror),[recent]);
  assert.notEqual(head,recent);assert.equal(git('status','--porcelain'),'');
  const objects=git('rev-list','--objects','--no-object-names',head,`^${recent}`);
  assert.ok(objects.split('\n').length>=3,'nonzero import is retained');
 }finally{rmSync(root,{recursive:true,force:true});}
});
