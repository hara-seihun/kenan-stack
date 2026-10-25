import './scratch-env.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {workspaceTesting as t} from './workspace.mjs';
test('installed reference traversal refuses expired budget rather than returning empty safety',()=>{
 assert.throws(()=>t.duringInspection(Date.now()-1,()=>t.installedReferenceSnapshot(['/srv'])),/budget exhausted/);
});
test('deadline unwind preserves live installed writer references',()=>{
 const root=mkdtempSync(path.join(tmpdir(),'installed-reference-'));
 try{
  writeFileSync(path.join(root,'launcher'),'exec /home/kenan/work/clones/live-writer/main');
  assert.throws(()=>t.duringInspection(Date.now()-1,()=>t.installedReferenceSnapshot([root])),/budget exhausted/);
  assert.equal(t.duringInspection(Date.now()+5000,()=>t.installedReferenceSnapshot([root]))[0].path,'/home/kenan/work/clones/live-writer/main');
  assert.equal(t.installedReferenceSnapshot([root]).length,1);
 }finally{rmSync(root,{recursive:true,force:true});}
});
