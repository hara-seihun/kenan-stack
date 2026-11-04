#!/usr/bin/env node
import {spawnSync} from 'node:child_process';
import {finishSourceJob,writeSourceJobProgress} from './source-job.mjs';
const [statePath,...args]=process.argv.slice(2);
const directory=process.env.PI_WORKSPACE_SOURCE_JOB_DIR;
if(!directory||!process.env.PI_WORKSPACE_REPRICE_CONTINUATION)throw Error('missing repricing job binding');
writeSourceJobProgress(directory,{phase:'refreshing-and-repricing'});
let result;
try {
  // Use stable admission so tool publication drains the actual pricing command.
  const child=spawnSync('/usr/local/bin/agent-workspace',['reprice-capacity',...args,'--budget-ms=40000'],{
    env:{...process.env,PI_WORKSPACE_STATE:statePath},encoding:'utf8',timeout:65000,maxBuffer:1<<20});
  if(child.error||child.status!==0)throw Object.assign(Error(child.stderr||child.error?.message||`repricing exited ${child.status}`),{code:'reprice-continuation-failed'});
  result={state:'ready',value:JSON.parse(child.stdout)};
} catch(error) {
  result={state:'failed',error:{code:error.code??'reprice-failed',message:error.message}};
  process.exitCode=1;
}
const saved=finishSourceJob(directory,result);
if(!saved.ok)throw Error(saved.error.message);
