#!/usr/bin/env node
// Narrow committed component publication. Never edits selected bodies in place.
import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';import {execFileSync,spawnSync} from 'node:child_process';import {createHash,randomUUID} from 'node:crypto';
const sha=b=>createHash('sha256').update(b).digest('hex');
export function inventory(root){const entries={};function walk(dir){for(const name of fs.readdirSync(dir).sort()){const f=path.join(dir,name),s=fs.lstatSync(f),rel=path.relative(root,f);if(s.isDirectory())walk(f);else if(s.isFile()||s.isSymbolicLink())entries[rel]={mode:s.mode&0o777,link:s.isSymbolicLink()?fs.readlinkSync(f):null,sha256:s.isSymbolicLink()?null:sha(fs.readFileSync(f))};else throw Error('unsupported entry');}}walk(root);return entries;}
const childEnvironment=()=>Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('NODE_TEST_')));
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
function sync(file){const fd=fs.openSync(file,'r');try{fs.fsyncSync(fd)}finally{fs.closeSync(fd)}}
export function deployGate({repository,destination,expectedBase,lockPath,receipt}) {
 // Process-level flock is held across proof, copy and CAS; caller cannot supply a bypass flag.
 const run=spawnSync('flock',['-n',lockPath,process.execPath,fileURLToPath(import.meta.url),'--locked',repository,destination,expectedBase,receipt],{encoding:'utf8',timeout:30000,maxBuffer:4*1024*1024,env:childEnvironment()});
 if(run.status!==0)throw Error(run.stderr||run.stdout||'publication lock unavailable');return JSON.parse(run.stdout);
}
function locked(repository,destination,expectedBase,receipt){
 const git=(...args)=>execFileSync('git',['-C',repository,...args],{encoding:'utf8',timeout:3000}).trim();
 if(git('status','--porcelain'))throw Error('unclean source');
 const commit=git('rev-parse','HEAD');const proof=JSON.parse(fs.readFileSync(path.join(repository,'RECOVERY.json'),'utf8'));
 const base=fs.realpathSync(destination);if(base!==expectedBase)throw Error('selected base CAS mismatch');
 const recovery=git('rev-list','--max-parents=0','HEAD');git('merge-base','--is-ancestor',recovery,commit);
 const allowed=new Set(['tools/agent-workspace/workspace.mjs','tools/agent-workspace/custody-import-budget.mjs','tools/agent-workspace/custody-import-budget.test.mjs','tools/agent-workspace/deploy-custody-gate.mjs','tools/agent-workspace/deploy-custody-gate.test.mjs','tools/agent-workspace/cleanup-custody-budget.mjs','tools/agent-workspace/cleanup-custody-budget.test.mjs','tools/agent-workspace/README.md','tools/agent-workspace/check.mjs','tools/agent-workspace/release-reachability.mjs','tools/agent-workspace/release-reachability.test.mjs','tools/agent-workspace/release-custody.test.mjs']);
 const changes=git('diff','--name-only',recovery,commit).split('\n').filter(Boolean);if(!changes.length||changes.some(x=>!allowed.has(x)))throw Error('non-gate source changes refused');
 const installedRecovery=path.join(base,'agent-workspace');
 const selectedSource=fs.readFileSync(path.join(base,'.pi-stack-commit'),'utf8').trim();
 const knownSelected=spawnSync('git',['-C',repository,'cat-file','-e',selectedSource+'^{commit}']).status===0;
 if(knownSelected){git('merge-base','--is-ancestor',selectedSource,commit);}
 const observed=inventory(installedRecovery);
 if(!knownSelected&&base!==proof.observedInstalledRoot)throw Error('unproven selected base');
 if(!knownSelected)for(const [name,entry]of Object.entries(proof.inventory)){const p=name.replace(/^tools\/agent-workspace\//,'');const actual=observed[p];if(!actual||actual.link!==entry.symlink||actual.mode!==Number(entry.mode)||(!actual.link&&actual.sha256!==entry.sha256))throw Error('installed recovery inventory changed');}
 if(!knownSelected&&Object.keys(observed).length!==Object.keys(proof.inventory).length)throw Error('installed recovery inventory additions');
 if(knownSelected){const entries=git('ls-tree','-r',selectedSource,'--','tools/agent-workspace').split('\n').filter(Boolean);if(entries.length!==Object.keys(observed).length)throw Error('selected inventory count changed');for(const row of entries){const [meta,name]=row.split('\t'),[mode,,oid]=meta.split(' '),rel=name.replace('tools/agent-workspace/',''),file=path.join(installedRecovery,rel),bytes=execFileSync('git',['-C',repository,'show',selectedSource+':'+name]);if(!observed[rel]||(mode==='120000'?fs.readlinkSync(file)!==bytes.toString():observed[rel].sha256!==sha(bytes)))throw Error('selected source inventory changed');}}
 const before=inventory(base),target=path.join(path.dirname(base),commit);if(fs.existsSync(target))throw Error('existing target requires reconciliation');
 const stage=path.join(path.dirname(base),`.${commit}.stage-${randomUUID()}`);fs.cpSync(base,stage,{recursive:true,verbatimSymlinks:true});
 try{
  for(const name of changes){const rel=name.replace(/^tools\//,''),out=path.join(stage,rel);fs.writeFileSync(out,execFileSync('git',['-C',repository,'show',`${commit}:${name}`]));fs.chmodSync(out,name.endsWith('workspace.mjs')?0o755:0o644);}
  const tests=fs.existsSync(path.join(stage,'agent-workspace/cleanup-custody-budget.test.mjs'))?['cleanup-custody-budget.test.mjs','custody-import-budget.test.mjs']:['custody-import-budget.test.mjs'];
  for (const name of ['release-reachability.test.mjs','release-custody.test.mjs']) if(fs.existsSync(path.join(stage,'agent-workspace',name))) tests.push(name);
  const test=spawnSync(process.execPath,['--test',...tests.map(x=>path.join(stage,'agent-workspace',x))],{encoding:'utf8',timeout:15000,maxBuffer:1024*1024,env:{...childEnvironment(),WORKSPACE_IMPORT_MODULE:fs.readFileSync(path.join(stage,'agent-workspace/workspace.mjs'),'utf8').includes('maintainReferenceClone')?new URL('file://'+path.join(stage,'agent-workspace/workspace.mjs')).href:''}});
  fs.writeFileSync(receipt+'.tests.log',test.stdout+test.stderr);if(test.status!==0||!/pass [1-9]/.test(test.stdout)||!/fail 0/.test(test.stdout))throw Error('staged gate tests failed');
  fs.writeFileSync(path.join(stage,'.pi-stack-commit'),commit+'\n');
  const after=inventory(stage),changed=new Set(changes.map(x=>x.replace(/^tools\//,'')));changed.add('.pi-stack-commit');
  for(const name of new Set([...Object.keys(before),...Object.keys(after)]))if(!changed.has(name)&&!equal(before[name],after[name]))throw Error('unselected tool changed:'+name);
  for(const name of changed)if(fs.existsSync(path.join(stage,name)))sync(path.join(stage,name));sync(path.join(stage,'agent-workspace'));sync(stage);
  if(fs.realpathSync(destination)!==base||!equal(inventory(base),before))throw Error('base changed before CAS');
  fs.renameSync(stage,target);const pointer=destination+'.next-'+randomUUID();fs.symlinkSync(target,pointer);fs.renameSync(pointer,destination);sync(path.dirname(destination));sync(path.dirname(target));
  if(fs.realpathSync(destination)!==target)throw Error('selection verification failed');
  const result={source:commit,recoveredSource:recovery,selected:target,rollback:base,changedPaths:changes,tests:'staged nativeJS gate fixtures pass; deployment fixtures qualified at source',servicesChanged:false,workspaceLedgerChanged:false,otherToolsUnchanged:true,physicalCapacityCreditBytes:0};fs.writeFileSync(receipt,JSON.stringify(result,null,2)+'\n');return result;
 }finally{if(fs.existsSync(stage))fs.rmSync(stage,{recursive:true,force:true});}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{if(process.argv[2]==='--locked'){if(process.argv.length!==7)throw Error('usage');const parent=fs.readFileSync(`/proc/${process.ppid}/comm`,'utf8').trim();if(parent!=='flock')throw Error('lock parent required');console.log(JSON.stringify(locked(...process.argv.slice(3))));}else{if(process.argv.length!==7)throw Error('usage: deploy-custody-gate REPOSITORY DEST EXPECTED_BASE LOCK RECEIPT');console.log(JSON.stringify(deployGate(Object.fromEntries(['repository','destination','expectedBase','lockPath','receipt'].map((x,i)=>[x,process.argv[i+2]])))));}}catch(e){console.error(e.message);process.exitCode=65;}
}
