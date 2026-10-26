import './scratch-env.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
const {workspaceTesting: {inheritShallowBoundary}} = await import(process.env.SHALLOW_BOUNDARY_MODULE ?? './workspace.mjs');
function fixture(body) {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'shallow-boundary-'));
 const target=path.join(root,'target'),mirror=path.join(root,'mirror');
 fs.mkdirSync(target);fs.mkdirSync(mirror);
 try { body({target,mirror,write:(dir,bytes)=>fs.writeFileSync(path.join(dir,'shallow'),bytes),read:dir=>fs.readFileSync(path.join(dir,'shallow'),'utf8')}); }
 finally { fs.rmSync(root,{recursive:true,force:true}); }
}
const one='1'.repeat(40),two='2'.repeat(40);
test('actual donor boundaries are copied exactly and retries preserve existing boundaries',()=>fixture(f=>{
 f.write(f.mirror,one+'\n');inheritShallowBoundary(f.target,f.mirror);assert.equal(f.read(f.target),one+'\n');
 f.write(f.mirror,two+'\n');inheritShallowBoundary(f.target,f.mirror);assert.equal(f.read(f.target),one+'\n'+two+'\n');
 const before=fs.statSync(path.join(f.target,'shallow')).ino;inheritShallowBoundary(f.target,f.mirror);assert.equal(fs.statSync(path.join(f.target,'shallow')).ino,before);
 fs.unlinkSync(path.join(f.mirror,'shallow'));inheritShallowBoundary(f.target,f.mirror);assert.equal(f.read(f.target),one+'\n'+two+'\n');
}));
test('a complete donor never invents a shallow boundary',()=>fixture(f=>{
 inheritShallowBoundary(f.target,f.mirror);assert.equal(fs.existsSync(path.join(f.target,'shallow')),false);
}));
test('invalid donor metadata refuses before replacing existing boundaries',()=>fixture(f=>{
 f.write(f.target,one+'\n');f.write(f.mirror,'not-a-commit\n');assert.throws(()=>inheritShallowBoundary(f.target,f.mirror),/invalid shallow boundary/);assert.equal(f.read(f.target),one+'\n');
}));
test('an existing Git shallow transaction is never removed or overwritten',()=>fixture(f=>{
 f.write(f.mirror,one+'\n');fs.writeFileSync(path.join(f.target,'shallow.lock'),'other writer');
 assert.throws(()=>inheritShallowBoundary(f.target,f.mirror),{code:'EEXIST'});assert.equal(fs.readFileSync(path.join(f.target,'shallow.lock'),'utf8'),'other writer');assert.equal(fs.existsSync(path.join(f.target,'shallow')),false);
}));
