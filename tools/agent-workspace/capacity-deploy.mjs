// Tools-only immutable selective publication. Executed under host deploy lock and
// exclusive stable admission lock; no service, product or reservation mutation.
import fs from 'node:fs';import path from 'node:path';import {execFileSync} from 'node:child_process';import {inventory} from './deploy-custody-gate.mjs';
const [repo,baseCommit,expected,receipt,rollback,sourceRef]=process.argv.slice(2);
const git=(...a)=>execFileSync('git',['-C',repo,...a],{encoding:'utf8'}).trim();
if(!sourceRef&&git('status','--porcelain'))throw Error('unclean source');
const canonicalBase=git('rev-parse','--verify',baseCommit+'^{commit}');if(canonicalBase!==baseCommit)throw Error('full canonical base SHA required');
const head=git('rev-parse','--verify',(sourceRef??'HEAD')+'^{commit}');if(sourceRef&&head!==sourceRef)throw Error('full canonical source SHA required');const dest='/srv/pi/tools';
if(fs.realpathSync(dest)!==expected)throw Error('base CAS mismatch');
const before=inventory(expected),toolBefore=inventory(path.join(expected,'agent-workspace'));
for(const [name,entry]of Object.entries(toolBefore)){
 if(name==='.component-release.json')continue;
 const bytes=execFileSync('git',['-C',repo,'show',`${baseCommit}:tools/agent-workspace/${name}`]);
 const actual=fs.lstatSync(path.join(expected,'agent-workspace',name));
 if(actual.isSymbolicLink()?fs.readlinkSync(path.join(expected,'agent-workspace',name))!==bytes.toString():!fs.readFileSync(path.join(expected,'agent-workspace',name)).equals(bytes))throw Error('installed snapshot mismatch '+name);
}
// Canonical rebases may change unrelated repository trees; this publisher selects only
// this component, and independently proves every other installed byte unchanged below.
const leaves=git('diff','--name-only',baseCommit,head,'--','tools/agent-workspace').split('\n').filter(Boolean).filter(p=>!p.endsWith('/deploy'));
if(leaves.some(p=>!p.startsWith('tools/agent-workspace/')))throw Error('unrelated source');
// Recover historical selective installs that lost the executable rollback mode.
const rollbackLeaf='tools/agent-workspace/rollback-main';
if(!(fs.statSync(path.join(expected,'agent-workspace/rollback-main')).mode&0o111)&&!leaves.includes(rollbackLeaf))leaves.push(rollbackLeaf);
const target=path.join(path.dirname(expected),head),stage=target+'.stage';
if(fs.existsSync(target)||fs.existsSync(stage))throw Error('existing target reconcile first');
fs.cpSync(expected,stage,{recursive:true,verbatimSymlinks:true});
try{
 for(const p of leaves){const out=path.join(stage,p.replace(/^tools\//,''));if(git('ls-tree',head,'--',p)===''){fs.unlinkSync(out);continue;}fs.writeFileSync(out,execFileSync('git',['-C',repo,'show',`${head}:${p}`]));fs.chmodSync(out,git('ls-tree',head,'--',p).startsWith('100755 ')?0o755:0o644);}
 fs.writeFileSync(path.join(stage,'.pi-stack-commit'),head+'\n');
 fs.writeFileSync(path.join(stage,'.agent-workspace-component.json'),JSON.stringify({source:head,recoveredInstalledBase:baseCommit,originalObjectAvailable:false,rollback,scope:'agent-workspace only',receipt},null,2)+'\n');
 const after=inventory(stage),changed=new Set([...leaves.map(p=>p.replace(/^tools\//,'')),'.pi-stack-commit','.agent-workspace-component.json']);
 for(const p of new Set([...Object.keys(before),...Object.keys(after)]))if(!changed.has(p)&&JSON.stringify(before[p])!==JSON.stringify(after[p]))throw Error('unselected change '+p);
 if(fs.realpathSync(dest)!==expected||JSON.stringify(inventory(expected))!==JSON.stringify(before))throw Error('pre-CAS change');
 // Prepare a schema2-aware immutable rollback before selecting the candidate.
 const rb=target+'.serial-rollback';if(fs.existsSync(rb))throw Error('rollback target exists; reconcile');
 fs.cpSync(stage,rb,{recursive:true,verbatimSymlinks:true});fs.unlinkSync(path.join(rb,'agent-workspace/main'));fs.symlinkSync('rollback-main',path.join(rb,'agent-workspace/main'));
 fs.writeFileSync(path.join(rb,'.agent-workspace-component.json'),JSON.stringify({source:head,kind:'schema2-reservation-aware-serial-rollback',main:'rollback-main',noDowngrade:true},null,2)+'\n');
 execFileSync('/usr/local/bin/node',['--test',path.join(rb,'agent-workspace/capacity-recovery.test.mjs'),path.join(rb,'agent-workspace/capacity-diagnostics.test.mjs')],{timeout:15000});
 execFileSync(path.join(rb,'agent-workspace/main'),['--help'],{timeout:5000});
 fs.renameSync(stage,target);const ptr=dest+'.capacity-next';fs.symlinkSync(target,ptr);fs.renameSync(ptr,dest);
 fs.writeFileSync(receipt,JSON.stringify({source:head,baseCommit,selected:target,previous:expected,rollback:target+'.serial-rollback',otherToolsUnchanged:true,servicesChanged:false,workspaceLedgerChanged:false,leaves},null,2)+'\n');
}finally{if(fs.existsSync(stage))fs.rmSync(stage,{recursive:true,force:true});}
