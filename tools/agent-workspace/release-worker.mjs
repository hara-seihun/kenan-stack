#!/usr/bin/env node
import {spawnSync} from 'node:child_process';
import {setTimeout} from 'node:timers/promises';
const [cli,state,...argv]=process.argv.slice(2);
// The immutable worker inherits only the root-created background identity; main
// authenticates it normally. Busy acquisition never begins a physical transition.
for(let attempt=0;attempt<20;attempt++){
 const result=spawnSync(process.execPath,[cli,...argv],{encoding:'utf8',env:{...process.env,PI_WORKSPACE_STATE:state},timeout:180000,maxBuffer:8<<20});
 process.stdout.write(result.stdout??'');process.stderr.write(result.stderr??'');
 if(result.error||result.signal){console.error(JSON.stringify({ok:false,code:'release-worker-outcome-unknown',retry:false,next:'Reconcile the original release journal before continuation.'}));process.exitCode=75;break;}
 if(result.status!==75){process.exitCode=result.status;break;}
 let receipt;try{receipt=JSON.parse(result.stdout);}catch{}
 if(receipt?.error?.code!=='release-resource-busy'){process.exitCode=75;break;}
 if(attempt===19){process.exitCode=75;break;}
 await setTimeout(250);
}
