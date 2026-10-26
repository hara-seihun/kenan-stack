#!/usr/bin/env node
import {spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {nativeCaller} from './native-owner.mjs';
import {setTimeout} from 'node:timers/promises';
const [cli,state,...argv]=process.argv.slice(2);
// The immutable worker inherits only the root-created background identity; main
// authenticates it normally. Busy acquisition never begins a physical transition.
let known=false,lastReceipt;
for(let attempt=0;attempt<20;attempt++){
 const result=spawnSync(process.execPath,[cli,...argv],{encoding:'utf8',env:{...process.env,PI_WORKSPACE_STATE:state},timeout:180000,maxBuffer:8<<20});
 process.stdout.write(result.stdout??'');process.stderr.write(result.stderr??'');
 try{lastReceipt=JSON.parse(result.stdout);}catch{lastReceipt=null;}
 if(result.error||result.signal){console.error(JSON.stringify({ok:false,code:'release-worker-outcome-unknown',retry:false,next:'Reconcile the original release journal before continuation.'}));process.exitCode=75;break;}
 if(result.status!==75){process.exitCode=result.status;known=Boolean(lastReceipt)&&(result.status===0||result.status===2);break;}
 let receipt;try{receipt=JSON.parse(result.stdout);}catch{}
 if(receipt?.error?.code!=='release-resource-busy'){process.exitCode=75;break;}
 if(attempt===19){process.exitCode=75;known=true;break;}
 await setTimeout(250);
}

if(known){
 const database=new DatabaseSync(state);try{
  database.exec('PRAGMA busy_timeout=1000');
  const id=argv[argv.indexOf('--id')+1],row=database.prepare('SELECT * FROM workspace_release_submission WHERE workspace_id=?').get(id),caller=nativeCaller();
  const attempts=database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='workspace_release_attempt'").get();
  const latest=attempts?database.prepare('SELECT receipt_json FROM workspace_release_attempt WHERE workspace_id=? ORDER BY sequence DESC LIMIT 1').get(id):null;
  const unsettled=latest&&JSON.parse(latest.receipt_json).kind==='owned-retention';
  if(row&&caller&&!unsettled){const original=JSON.parse(row.binding_json);if(original.agentId===caller.agentId&&original.channel===caller.channel)
   database.prepare("UPDATE workspace_release_submission SET state='terminal-known',terminal_json=? WHERE workspace_id=? AND request_id=?")
    .run(JSON.stringify({exitCode:process.exitCode??0,finishedAt:Date.now(),binding:caller}),id,row.request_id);}
 }finally{database.close();}
}
