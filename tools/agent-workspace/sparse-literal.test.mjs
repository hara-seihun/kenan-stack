import assert from 'node:assert/strict';
import {test} from 'node:test';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {literalSparseSelection} from './sparse-literal.mjs';

const names=['README.md','a','ab/x','a.b/y','compiler/x.py','compiler/sub/deep/z.bin','compiler2/w','tools/t.py','tools','dir/file','dir/sub/file','x/compiler/y'];

// Git's non-cone checkout of the same paths decides what a sparse checkout selects.
function gitSelection(patterns){
 const repo=mkdtempSync(path.join(tmpdir(),'sparse-literal-'));
 const git=(args,input)=>execFileSync('git',['-C',repo,'-c','core.fsync=none',...args],{encoding:'utf8',input}).trim();
 try{
  git(['init','-q']);
  const blob=git(['hash-object','-w','--stdin'],'');
  // "tools" is both a file and a directory in the list above, which Git can't hold; keep the directory.
  git(['update-index','--add','-z','--index-info'],names.filter(name=>name!=='tools').map(name=>`100644 ${blob}\t${name}\0`).join(''));
  const tree=git(['write-tree']);
  git(['read-tree','--empty']);
  writeFileSync(path.join(repo,'.git','info','sparse-checkout'),`${patterns.join('\n')}\n`);
  git(['-c','core.sparseCheckout=true','-c','core.sparseCheckoutCone=false','read-tree','-m','-u',tree]);
  return new Set(git(['ls-files','-t']).split('\n').filter(line=>line.startsWith('H ')).map(line=>line.slice(2)));
 }finally{rmSync(repo,{recursive:true,force:true});}
}

test('a literal anchored sparse selection matches what Git checks out',()=>{
 for(const patterns of [['/compiler/'],['/compiler'],['/a'],['/a/'],['/compiler/sub/','/tools/'],['/dir/file','/ab/'],['/a.b/'],['/missing/']]){
  const ours=literalSparseSelection(names.filter(name=>name!=='tools'),patterns);
  assert.deepEqual([...ours].sort(),[...gitSelection(patterns)].sort(),JSON.stringify(patterns));
 }
});

test('patterns Git interprets beyond a literal path go to Git',()=>{
 for(const patterns of [[],['compiler/'],['/*.py'],['/compiler/','!/compiler/sub/'],['/c?mpiler/'],['/'],['/a//b'],['/a/../b'],['/a '],['/a\\b'],['/[ab]/']])
  assert.equal(literalSparseSelection(names,patterns),null,JSON.stringify(patterns));
});

// The seinari tree has 508,155 paths; its literal selection must not take a scratch checkout's minutes.
test('a literal selection over half a million paths is immediate',()=>{
 const many=Array.from({length:500_000},(_,i)=>`research/d${i%997}/f${i}.json`).concat(Array.from({length:40_000},(_,i)=>`compiler/f${i}`));
 const start=performance.now();
 const selected=literalSparseSelection(many,['/compiler/','/tools/']);
 assert.equal(selected.size,40_000);
 assert.ok(performance.now()-start<5_000);
});
