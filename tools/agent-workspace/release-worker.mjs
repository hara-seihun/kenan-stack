#!/usr/bin/env node
import {spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {nativeCaller} from './native-owner.mjs';
import {runReleaseWorker} from './release-retry.mjs';
const [cli,state,...argv]=process.argv.slice(2);
// The immutable worker inherits only the root-created background identity; main
// authenticates it normally. Busy acquisition never begins a physical transition.
const outcome=await runReleaseWorker(()=>spawnSync(process.execPath,[cli,...argv],{encoding:'utf8',env:{...process.env,PI_WORKSPACE_STATE:state},timeout:180000,maxBuffer:8<<20}));
const {known,receipt:lastReceipt,result}=outcome;
process.stdout.write(result.stdout??'');process.stderr.write(result.stderr??'');
process.exitCode=outcome.exitCode;
if(result.error||result.signal)console.error(JSON.stringify({ok:false,code:'release-worker-outcome-unknown',retry:false,next:'Reconcile the original release journal before continuation.'}));

// A refusal before any authorization-dependent effect leaves nothing to reconcile; record it so the
// original custodian's authenticated rerun can continue instead of waiting on a unit that never ran.
const refusedUnauthenticated=lastReceipt?.error?.code==='release-caller-unverified'&&process.exitCode===2;
if(known||refusedUnauthenticated){
 const database=new DatabaseSync(state);try{
  database.exec('PRAGMA busy_timeout=15000');
  const id=argv[argv.indexOf('--id')+1],row=database.prepare('SELECT * FROM workspace_release_submission WHERE workspace_id=?').get(id),caller=nativeCaller();
  const attempts=database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='workspace_release_attempt'").get();
  const latest=attempts?database.prepare('SELECT receipt_json FROM workspace_release_attempt WHERE workspace_id=? ORDER BY sequence DESC LIMIT 1').get(id):null;
  const unsettled=latest&&JSON.parse(latest.receipt_json).kind==='owned-retention';
  if(row&&refusedUnauthenticated&&row.state==='submitted'){database.prepare("UPDATE workspace_release_submission SET state='terminal-known',terminal_json=? WHERE workspace_id=? AND request_id=?").run(JSON.stringify({exitCode:2,finishedAt:Date.now(),refused:'release-caller-unverified'}),id,row.request_id);}
  else if(row&&caller&&!unsettled){const original=JSON.parse(row.continuations_json??'[]').at(-1)?.binding??JSON.parse(row.binding_json);if(original.agentId===caller.agentId&&original.channel===caller.channel)
   database.prepare("UPDATE workspace_release_submission SET state='terminal-known',terminal_json=? WHERE workspace_id=? AND request_id=?")
    .run(JSON.stringify({exitCode:process.exitCode??0,finishedAt:Date.now(),binding:caller}),id,row.request_id);}
 }finally{database.close();}
}
