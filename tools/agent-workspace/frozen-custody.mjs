import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {boundedCommand} from './bounded-command.mjs';
// Observation time scales with the tree: BASE_SECONDS plus PER_ENTRY_SECONDS for each entry seen (a 2,000 entries/second floor),
// never beyond CAP_SECONDS. The enclosing process timeout leaves room for the cap. Anything unfinished is FROZEN_CUSTODY_UNKNOWN.
export const FROZEN_OBSERVATION_BUDGET=Object.freeze({baseSeconds:20,perEntrySeconds:0.0005,capSeconds:900});
export function frozenCustody(target,{recursive=false,budget=FROZEN_OBSERVATION_BUDGET}={}) {
 if(!fs.existsSync(target))return null;
 if(fs.existsSync(path.join(target,'.git','pi-frozen-handoff.json')))return {code:'FROZEN_CUSTODY',reason:'frozen source handoff marker remains; preserve original snapshot'};
 const result=boundedCommand('/usr/bin/python3',[fileURLToPath(new URL('./frozen-custody.py',import.meta.url)),target,recursive?'recursive':'root',String(budget.baseSeconds),String(budget.perEntrySeconds),String(budget.capSeconds)],{timeout:Math.ceil(budget.capSeconds*1000)+10000,maxBuffer:16384});
 if(result.status!==0||result.error)return {code:'FROZEN_CUSTODY_UNKNOWN',reason:'filesystem immutable flag observation failed: '+String(result.stderr||result.error?.code||result.signal||result.status).slice(0,512)+'; no mutation authorized'};
 try{const value=JSON.parse(result.stdout);return value.frozen?{code:'FROZEN_CUSTODY',reason:'filesystem immutable flag remains at '+value.path}:null;}
 catch{return {code:'FROZEN_CUSTODY_UNKNOWN',reason:'invalid immutable flag observation; no mutation authorized'};}
}
export function assertUnfrozenCustody(target,options={}){const result=frozenCustody(target,{recursive:true,...options});if(result)throw Object.assign(new Error(result.reason),{code:result.code});}
