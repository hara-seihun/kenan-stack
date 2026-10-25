import './scratch-env.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {allocationSlice} from './incremental-allocation.mjs';
import {workspaceTesting} from './workspace.mjs';

test('bounded slices resume a large walk without publishing partial totals, matching complete allocated blocks',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'allocation-slices-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 for(let i=0;i<40;i++){const d=path.join(root,'d'+i);fs.mkdirSync(d);for(let j=0;j<8;j++)fs.writeFileSync(path.join(d,'f'+j),'data');}
 fs.linkSync(path.join(root,'d0','f0'),path.join(root,'shared'));fs.symlinkSync('d0',path.join(root,'link'));
 const child=path.join(root,'d2'),device=String(fs.statSync(root).dev),opts={maxEntries:7,excludedPaths:[child]};
 let state,partial=0,result;
 for(let i=0;i<100;i++){result=allocationSlice(root,device,state,opts);if(result.ok)break;assert.equal(result.partial,true);assert.equal(result.ok,undefined);assert.ok(result.visited<=7);state=JSON.parse(JSON.stringify(result.state));partial++;}
 assert.ok(partial>30);assert.equal(result.ok,true);
 const full=workspaceTesting.allocatedWorkspaceBytes(root,device,{deadline:Date.now()+3000,excludedPaths:[child]});
 assert.equal(result.bytes,full.bytes);assert.equal(result.allocatedBytes,full.allocatedBytes);
});

test('exhausted slices preserve progress; root replacement resets rather than crediting the old inode',t=>{
 const parent=fs.mkdtempSync(path.join(os.tmpdir(),'allocation-reset-'));t.after(()=>fs.rmSync(parent,{recursive:true,force:true}));
 const root=path.join(parent,'root');fs.mkdirSync(root);fs.writeFileSync(path.join(root,'f'),'data');const device=String(fs.statSync(root).dev);
 const first=allocationSlice(root,device,null,{maxEntries:1});assert.equal(first.partial,true);
 const exhausted=allocationSlice(root,device,first.state,{deadline:0});assert.deepEqual(exhausted.state,first.state);
 fs.renameSync(root,root+'.old');fs.mkdirSync(root);
 const result=allocationSlice(root,device,first.state);assert.equal(result.ok,true);assert.equal(result.inode,String(fs.statSync(root).ino));assert.notEqual(result.inode,first.state.inode);
});
