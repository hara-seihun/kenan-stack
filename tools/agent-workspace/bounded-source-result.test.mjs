import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {finishSourceJob,observeSourceJob} from './source-job.mjs';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
function fixture(action){const root=fs.mkdtempSync(path.join(os.tmpdir(),'bounded-source-result-'));try{action(root);}finally{fs.rmSync(root,{force:true,recursive:true});}}
const failure={state:'failed',error:{code:'workspace-capacity-refused',message:'133.46 GiB is free; 137.17 GiB is required.\ncapacity-detail:'+JSON.stringify({staleSamples:'x'.repeat(100000)}),detail:{census:'all original details'}}};
test('a verbose structured capacity refusal stays below the actual consumer boundary with its full diagnostics intact',()=>fixture(root=>{
 assert.deepEqual(finishSourceJob(root,failure),{ok:true});
 const result=JSON.parse(fs.readFileSync(root+'/result.json','utf8'));
 assert.equal(result.error.code,'workspace-capacity-refused');assert.equal(result.error.message,'133.46 GiB is free; 137.17 GiB is required.');
 for(const file of ['result.json','progress.json'])assert.ok(fs.statSync(root+'/'+file).size<65536);
 const details=result.error.detail;assert.equal(details.completeDiagnostic,true);
 const full=fs.readFileSync(details.diagnosticPath);assert.equal(full.length,details.bytes);assert.equal(hash(full),details.sha256);assert.deepEqual(JSON.parse(full),failure);
 assert.deepEqual(observeSourceJob(root),result);const original=fs.readFileSync(root+'/result.json','utf8');
 assert.deepEqual(finishSourceJob(root,failure),{ok:true});assert.equal(fs.readFileSync(root+'/result.json','utf8'),original);
 assert.equal(finishSourceJob(root,{...failure,error:{...failure.error,message:failure.error.message+'changed'}}).error.code,'source-job-result-conflict');
 assert.equal(fs.readFileSync(root+'/result.json','utf8'),original);
}));
test('small results retain the exact public contract and do not create extra diagnostic files',()=>fixture(root=>{
 const small={state:'failed',error:{code:'original-code',message:'original message',detail:{why:'original detail'}}};assert.deepEqual(finishSourceJob(root,small),{ok:true});assert.deepEqual(observeSourceJob(root),small);assert.deepEqual(fs.readdirSync(root).sort(),['progress.json','result.json']);
}));
test('existing oversized immutable outcomes are never rewritten or silently replayed',()=>fixture(root=>{
 const original=JSON.stringify(failure)+'\n';fs.writeFileSync(root+'/result.json',original);
 assert.equal(finishSourceJob(root,failure).error.code,'source-job-result-conflict');assert.equal(fs.readFileSync(root+'/result.json','utf8'),original);assert.deepEqual(observeSourceJob(root),failure);
}));
