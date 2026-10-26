import './scratch-env.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {rootPlanReferences} from './root-plan-references.mjs';
import {qualificationReferences,protects} from './qualification-references.mjs';
import {workspaceTesting} from './workspace.mjs';
const sha='a'.repeat(40);
function fixture(fn){const root=fs.mkdtempSync(path.join(os.tmpdir(),'root-plan-custody-')),directory=path.join(root,'root-plans'),helper=path.join(root,'helper');fs.mkdirSync(directory);fs.mkdirSync(helper);const file=path.join(directory,'root-candidate.plan.json');const plan={state:'planned',commit:sha,checkout:path.join(root,'qualification'),candidate:{commit:sha,checkout:path.join(root,'smoke')},stages:{tests:{argv:['/usr/bin/python3','-B',helper+'/converge-root-precheck','tests',path.join(root,'qualification')]}},finish:['/usr/bin/python3',helper+'/converge-root-precheck','finish',path.join(root,'qualification')]};const write=p=>fs.writeFileSync(file,JSON.stringify(p));write(plan);try{fn({root,directory,helper,file,plan,write});}finally{fs.rmSync(root,{recursive:true,force:true});}}
test('native root plan argv protects a helper, root and smoke without a running process',()=>fixture(f=>{
 const r=qualificationReferences([f.helper],{dataRoot:f.root});assert.equal(r.complete,true,JSON.stringify(r.errors));assert.equal(r.references.length,1);assert.equal(r.references[0].kind,'native_root_plan');assert.equal(protects(r,f.helper),true);assert.equal(protects(r,f.helper+'/other'),false);
 const all=rootPlanReferences(null,{directory:f.directory});assert.equal(protects(all,f.plan.checkout),true);assert.equal(protects(all,f.plan.candidate.checkout),true);assert.equal(protects(all,f.root+'/unrelated'),false);
}));
test('ordinary supported release inspection preserves a helper referenced only by native plan',()=>fixture(f=>{
 const old=[process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY,process.env.PI_WORKSPACE_TEST_QUALIFICATION_ROOT];process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY='empty';process.env.PI_WORKSPACE_TEST_QUALIFICATION_ROOT=f.root;
 try{const held=workspaceTesting.inspectRecord({id:'r',path:f.helper,state:'active',leaseExpiresAt:0,checkoutType:'clone'},{safety:{currentStackQueue:{errors:[],references:[]}}});assert.equal(held.classification,'referenced');assert.equal(held.currentStackReferences[0].kind,'native_root_plan');assert.equal(fs.existsSync(f.helper),true);}finally{['PI_WORKSPACE_TEST_EXTERNAL_SAFETY','PI_WORKSPACE_TEST_QUALIFICATION_ROOT'].forEach((k,i)=>{if(old[i]===undefined)delete process.env[k];else process.env[k]=old[i];});}
}));
test('age and a terminal-looking plan state never waive execution custody',()=>fixture(f=>{
 f.write({...f.plan,state:'completed'});fs.utimesSync(f.file,new Date(2000,0,1),new Date(2000,0,1));const r=rootPlanReferences([f.helper],{directory:f.directory});assert.equal(r.references.length,1);assert.equal(r.complete,true);
}));
test('only a digest-bound explicit release covering every dependency ends plan custody',()=>fixture(f=>{
 const before=rootPlanReferences(null,{directory:f.directory});const paths=before.references[0].paths;const terminal={state:'released',owner:'publisher',reason:'All execution paths were adopted into durable replacement custody.',planSha256:crypto.createHash('sha256').update(fs.readFileSync(f.file)).digest('hex'),paths};
 fs.writeFileSync(f.file+'.custody-released.json',JSON.stringify({...terminal,paths:paths.slice(1)}));assert.equal(rootPlanReferences(null,{directory:f.directory}).complete,false);
 fs.writeFileSync(f.file+'.custody-released.json',JSON.stringify(terminal));let r=rootPlanReferences(null,{directory:f.directory});assert.equal(r.complete,true);assert.equal(r.references.length,0);assert.equal(r.released.length,1);
 f.write({...f.plan,extra:true});r=rootPlanReferences(null,{directory:f.directory});assert.equal(r.complete,false);assert.match(r.errors[0],/does not match/);
}));
test('malformed, symlinked and oversized plans retain custody conservatively',()=>fixture(f=>{
 f.write({...f.plan,stages:{tests:{argv:'not argv'}}});let r=rootPlanReferences([f.helper],{directory:f.directory});assert.equal(r.complete,false);assert.equal(protects(r,f.helper),true);
 f.write(f.plan);assert.equal(rootPlanReferences(null,{directory:f.directory,maxFileBytes:1}).complete,false);assert.equal(rootPlanReferences(null,{directory:f.directory,maxEntries:0}).complete,false);
 fs.renameSync(f.file,f.file+'.saved');fs.symlinkSync(f.file+'.saved',f.file);assert.equal(rootPlanReferences(null,{directory:f.directory}).complete,false);
}));
