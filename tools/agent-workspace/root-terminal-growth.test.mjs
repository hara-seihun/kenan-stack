import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {terminalRootPaths,authoritySnapshot,nativeTerminalRootPaths,rootTerminalSafety} from './root-terminal-growth.mjs';
const A='a'.repeat(40),B='b'.repeat(40),now=200000;
function fixture(){
 const root='/fixture/root-precheck-'+A.slice(0,12),candidate='/fixture/root-smoke-'+A.slice(0,12)+'-'+B.slice(0,12);
 const plan={state:'planned',planComplete:true,commit:A,workspaceId:'root-id',checkout:root,
  candidate:{state:'ready',commit:B,workspaceId:'candidate-id',checkout:candidate},requiredStages:['compile','tests','smoke'],stages:{
   compile:{argv:['/usr/bin/env','-C',root,'bun','compile.ts']},tests:{argv:['/usr/bin/env','-C',root,'python3','tests',root]},
   smoke:{argv:['/usr/bin/env','-C',root,'bun',root+'/smoke.ts','--candidate',candidate]}}};
 const rows=[{id:'root-id',path:root,state:'active',created_at:1000},{id:'candidate-id',path:candidate,state:'active',created_at:1000}];
 const authorities=Object.values(plan.stages).map(s=>({state:'terminal',settled:true,created:10,terminal:100,spec:{cwd:root,source:A,argv:s.argv}}));
 const options={plans:[plan],authorities,now,safe:()=>true,head:p=>p===root?A:B};
 return {plan,rows,options,project:()=>terminalRootPaths(rows,options)};
}
test('all exact settled native stages project zero future writes without changing execution source, plans or grants',()=>{
 const f=fixture(),before=JSON.stringify(f);const result=f.project();
 assert.deepEqual([...result],f.rows.map(r=>[r.path,100000]));assert.equal(JSON.stringify(f),before);
});
test('pushed source, elapsed leases and plan completion are not terminal evidence',()=>{
 const f=fixture();f.options.authorities=[];f.rows.forEach(r=>r.lease_expires_at=0);assert.equal(f.project().size,0);
});
test('missing tests, changed argv, changed source, wrong workspace identity and creating roots retain full growth',()=>{
 for(const change of [f=>f.options.authorities.splice(1,1),f=>f.options.authorities[0].spec={...f.options.authorities[0].spec,argv:['different']},
  f=>f.options.authorities[0].spec.source=B,f=>f.plan.workspaceId='foreign',f=>f.rows.forEach(r=>r.state='creating'),
  f=>f.options.head=()=>B,f=>f.plan.requiredStages=['compile','smoke']]){
  const f=fixture();change(f);assert.equal(f.project().has(f.rows[0].path),false);
 }
});
test('pending, live or uncertain consumer blocks historical terminal evidence, including nested output paths',()=>{
 for(const state of ['granted','dispatched','consumed','unverifiable']){
  const f=fixture();f.options.authorities.push({state,settled:false,spec:{cwd:f.rows[0].path+'/output',argv:[]}});assert.equal(f.project().has(f.rows[0].path),false);
 }
 const f=fixture();f.options.authorities.push({state:'consumed',settled:false,spec:{cwd:'/different',argv:['test','--source',f.rows[1].path]}});assert.equal(f.project().has(f.rows[1].path),false);
});
test('fresh consumer census excludes active and frozen roots; immutable inputs remain byte-for-byte',()=>{
 const f=fixture();const before=JSON.stringify(f.options.plans);let observed=[];
 f.options.safe=row=>{observed.push(row.path);return false;};assert.equal(f.project().size,0);assert.equal(observed.length,2);assert.equal(JSON.stringify(f.options.plans),before);
});
test('every plan sharing a root must be terminal; one candidate cannot borrow another candidate smoke',()=>{
 const f=fixture(),other=structuredClone(f.plan);other.candidate.checkout+='/another';other.candidate.workspaceId='other';
 other.stages.smoke.argv=other.stages.smoke.argv.map(a=>a===f.plan.candidate.checkout?other.candidate.checkout:a);
 f.options.plans.push(other);assert.equal(f.project().has(f.rows[0].path),false);
});
test('terminal evidence predating creation or future-dated grants cannot settle a new checkout',()=>{
 for(const terminal of [201,0]){const f=fixture();f.options.authorities[0].terminal=terminal;f.options.authorities[0].created=0;assert.equal(f.project().size,0);}
 const f=fixture();f.rows.forEach(r=>r.created_at=11000);assert.equal(f.project().size,0);
});
test('native census is bounded, root-owned, non-secret and fails closed on damaged records',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'terminal-proof-'));
 try{
  const file=path.join(dir,'fixture.authority');fs.writeFileSync(file,JSON.stringify({version:1,state:'terminal',created:10,terminal:100,boot:'boot',settler:{boot:'boot'},unit:'unit.service',invocation:'a'.repeat(32),token:'DO-NOT-EMIT',issuer:{call:'private'},spec:{cwd:'/fixture',source:A,operation:'11111111-2222-4333-8444-555555555555',job:'11111111-2222-4333-8444-555555555556',argv:['test'],dispatcher:{argv:['private']}}}));
  const snapshot=authoritySnapshot(dir,{secure:false});assert.equal(snapshot[0].settled,true);assert.equal(JSON.stringify(snapshot).includes('private'),false);assert.equal(JSON.stringify(snapshot).includes('DO-NOT-EMIT'),false);
  fs.chmodSync(file,0o644);assert.throws(()=>authoritySnapshot(dir));
  fs.writeFileSync(path.join(dir,'bad.plan.json'),'{');assert.equal(nativeTerminalRootPaths(fixture().rows,{planRoot:dir,authorities:()=>snapshot}).size,0);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('unrelated pools never invoke privileged root authority observation',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'terminal-no-plan-'));try{
  assert.equal(nativeTerminalRootPaths(fixture().rows,{planRoot:dir,authorities:()=>{throw new Error('should not call');}}).size,0);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('production terminal safety preserves frozen, active, unknown and queued consumers without invoking any effect',()=>{
 const row=fixture().rows[0];let called=0;
 const observe=()=>{called++;return {errors:[],references:[]};};
 assert.equal(rootTerminalSafety(row,{frozen:()=>({code:'FROZEN_CUSTODY'}),observe}),false);assert.equal(called,0);
 assert.equal(rootTerminalSafety(row,{frozen:()=>({code:'FROZEN_CUSTODY_UNKNOWN'}),observe}),false);assert.equal(called,0);
 for(const references of [[{kind:'write-fd'}],[{kind:'queued-tool'}],[{kind:'borrower-writing-lease'}],[{kind:'systemd-runtime'}]]){
  assert.equal(rootTerminalSafety(row,{frozen:()=>null,observe:()=>({errors:[],references})}),false);
 }
 assert.equal(rootTerminalSafety(row,{frozen:()=>null,observe:()=>({errors:['incomplete'],references:[]})}),false);
 assert.equal(rootTerminalSafety(row,{frozen:()=>null,observe:()=>{throw Error('unreadable');}}),false);
 assert.equal(rootTerminalSafety(row,{frozen:()=>null,observe}),true);
});
