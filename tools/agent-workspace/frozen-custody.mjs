import fs from 'node:fs';
import path from 'node:path';
import {homedir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {boundedCommand} from './bounded-command.mjs';
// The scanner's CPU time may grow with the tree: BASE_SECONDS plus PER_ENTRY_SECONDS for each entry seen (a 2,000 entries per
// CPU-second floor). CPU time, not wall-clock time, so a saturated host only slows the scan. CAP_SECONDS bounds wall-clock time;
// the enclosing process timeout leaves room for it. Anything unfinished is FROZEN_CUSTODY_UNKNOWN.
export const FROZEN_OBSERVATION_BUDGET=Object.freeze({baseSeconds:20,perEntrySeconds:0.0005,capSeconds:900});
const SCANNER=fileURLToPath(new URL('./frozen-custody.py',import.meta.url));
const UNREADABLE=4;
// The scanner reads the immutable attribute with statx, which needs no read permission on files. A directory this
// account can't search exits UNREADABLE; the scan is then repeated once through the host's UID-preserving
// CAP_DAC_READ_SEARCH route (the same one the capacity sampler uses), which can read but never write.
function readSearchRoute(args){
 const uid=process.getuid?.(),gid=process.getgid?.();
 if(uid===undefined||uid===0)return null;
 return ['sudo',['-n','/usr/bin/setpriv',`--reuid=${uid}`,`--regid=${gid}`,'--init-groups','--bounding-set=-all,+dac_read_search','--inh-caps=+dac_read_search','--ambient-caps=+dac_read_search',
  '/usr/bin/env',`HOME=${homedir()}`,'PATH=/usr/bin:/bin','/usr/bin/python3',...args]];
}
export function frozenCustody(target,{recursive=false,budget=FROZEN_OBSERVATION_BUDGET,privileged=readSearchRoute}={}) {
 if(!fs.existsSync(target))return null;
 if(fs.existsSync(path.join(target,'.git','pi-frozen-handoff.json')))return {code:'FROZEN_CUSTODY',reason:'frozen source handoff marker remains; preserve original snapshot'};
 const args=[SCANNER,target,recursive?'recursive':'root',String(budget.baseSeconds),String(budget.perEntrySeconds),String(budget.capSeconds)];
 const options={timeout:Math.ceil(budget.capSeconds*1000)+10000,maxBuffer:16384};
 let result=boundedCommand('/usr/bin/python3',args,options),route='unprivileged';
 if(result.status===UNREADABLE&&!result.error){
  const elevated=privileged(args);
  if(elevated){result=boundedCommand(elevated[0],elevated[1],options);route='read-search-capability';}
 }
 if(result.status===UNREADABLE&&!result.error)return {code:'FROZEN_CUSTODY_UNKNOWN',reason:'filesystem immutable flag observation could not read '+String(result.stderr).trim().slice(0,400)+' ('+route+'); no mutation authorized'};
 if(result.status!==0||result.error)return {code:'FROZEN_CUSTODY_UNKNOWN',reason:'filesystem immutable flag observation failed: '+String(result.stderr||result.error?.code||result.signal||result.status).slice(0,512)+'; no mutation authorized'};
 try{const value=JSON.parse(result.stdout);return value.frozen?{code:'FROZEN_CUSTODY',reason:'filesystem immutable flag remains at '+value.path}:null;}
 catch{return {code:'FROZEN_CUSTODY_UNKNOWN',reason:'invalid immutable flag observation; no mutation authorized'};}
}
export function assertUnfrozenCustody(target,options={}){const result=frozenCustody(target,{recursive:true,...options});if(result)throw Object.assign(new Error(result.reason),{code:result.code});}
