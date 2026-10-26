import './scratch-env.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync,spawnSync} from 'node:child_process';
import {sourceHandoff} from './source-handoff.mjs';
const hash=b=>createHash('sha256').update(b).digest('hex');
function fixture(fn){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'source-handoff-')),repo=path.join(root,'child'),remote=path.join(root,'remote.git'),state=path.join(root,'state','registry.sqlite3');
 const git=(...args)=>execFileSync('git',args,{encoding:'utf8',timeout:10000,stdio:['ignore','pipe','pipe']}).trim();
 try{git('init','--bare',remote);git('init','-b','main',repo);fs.writeFileSync(path.join(repo,'proof.txt'),'exact source bytes\n');git('-C',repo,'add','.');git('-C',repo,'-c','user.name=Fixture','-c','user.email=f@invalid','commit','-m','proof');git('-C',repo,'remote','add','origin',remote);git('-C',repo,'push','origin','HEAD:refs/heads/agent/frozen');
 const head=git('-C',repo,'rev-parse','HEAD');const record={id:'workspace-fixture',owner:'child',path:repo,state:'active'},request={id:record.id,path:repo,owner:record.owner,head,recipient:'parent',remote:'origin',branch:'agent/frozen'};return fn({root,repo,remote,state,git,record,request});
 }finally{fs.rmSync(root,{recursive:true,force:true});}
}
test('durable branch receipt survives child deletion and restores exact bytes into independent recipient custody',()=>fixture(f=>{
 const result=sourceHandoff(f.record,f.request,f.state);
 assert.equal(result.checkoutCustodyTransferred,false);assert.equal(result.checkoutMayDisappearAfterArchive,true);assert.ok(!result.artifact.path.startsWith(f.repo+'/'));
 assert.equal(hash(fs.readFileSync(result.artifact.path)),result.artifact.sha256);assert.equal(hash(fs.readFileSync(result.manifest.path)),result.manifest.sha256);
 assert.deepEqual(sourceHandoff(f.record,f.request,f.state),result,'repeat is the same receipt, not a renewed lease');
 fs.rmSync(f.repo,{recursive:true});assert.equal(JSON.parse(fs.readFileSync(result.artifact.path)).source.commit,f.request.head);
 const recipient=path.join(f.root,'parent');f.git('clone','--branch',f.request.branch,f.remote,recipient);
 assert.equal(f.git('-C',recipient,'rev-parse','HEAD'),f.request.head);assert.equal(fs.readFileSync(path.join(recipient,'proof.txt'),'utf8'),'exact source bytes\n');
}));
test('missing pushed tip, stale head, dirty output, recipient and owner mismatch refuse without durable success',()=>fixture(f=>{
 for(const request of [{...f.request,head:'a'.repeat(40)},{...f.request,owner:'other'},{...f.request,recipient:'child'},{...f.request,branch:'agent/absent'}])assert.throws(()=>sourceHandoff(f.record,request,f.state));
 fs.writeFileSync(path.join(f.repo,'untracked'),'not included');assert.throws(()=>sourceHandoff(f.record,f.request,f.state),{code:'handoff-dirty-source'});fs.rmSync(path.join(f.repo,'untracked'));
 fs.writeFileSync(path.join(f.repo,'proof.txt'),'unpublished');f.git('-C',f.repo,'add','.');f.git('-C',f.repo,'-c','user.name=F','-c','user.email=f@invalid','commit','-m','unpublished');
 assert.throws(()=>sourceHandoff(f.record,{...f.request,head:f.git('-C',f.repo,'rev-parse','HEAD')},f.state),{code:'handoff-source-not-pushed'});
 assert.equal(fs.existsSync(path.join(path.dirname(f.state),'source-handoffs')),false);
}));
test('CLI binds actual registry custody, never substitutes a label or leaves the receipt in a disappearing checkout',()=>fixture(f=>{
 fs.writeFileSync(path.join(f.repo,'.gitignore'),'node_modules/\ncustom-generated/\n');
 fs.writeFileSync(path.join(f.repo,'.agent-workspace-caches'),'custom-generated\n');
 f.git('-C',f.repo,'add','.');f.git('-C',f.repo,'-c','user.name=F','-c','user.email=f@invalid','commit','-m','generated policy');
 f.git('-C',f.repo,'push','origin','HEAD:refs/heads/agent/frozen');f.request.head=f.git('-C',f.repo,'rev-parse','HEAD');
 for(const name of ['node_modules','custom-generated']){fs.mkdirSync(path.join(f.repo,name));fs.writeFileSync(path.join(f.repo,name,'proof'),'regenerate me');}
 const entry=new URL('./workspace.mjs',import.meta.url).pathname;
 const run=(...args)=>spawnSync(process.execPath,[entry,...args],{env:{...process.env,PI_WORKSPACE_STATE:f.state},encoding:'utf8',timeout:20000});
 const register=run('register','--retained','--path',f.repo,'--owner','child','--json');assert.equal(register.status,0,register.stderr);const record=JSON.parse(register.stdout);
 const args=['source-handoff','--id',record.id,'--path',f.repo,'--owner','child','--expected-head',f.request.head,'--recipient','parent','--remote','origin','--branch','agent/frozen','--json'];
 const passed=run(...args);assert.equal(passed.status,0,passed.stderr);const receipt=JSON.parse(passed.stdout);assert.equal(receipt.workspaceId,record.id);assert.deepEqual(receipt.dependencyCustody.paths,['custom-generated','node_modules']);
 const wrong=[...args];wrong[wrong.indexOf('child')]='stranger';const refused=run(...wrong);assert.equal(refused.status,2);assert.equal(JSON.parse(refused.stdout).error.code,'handoff-stale-custody');
 fs.rmSync(f.repo,{recursive:true});assert.equal(hash(fs.readFileSync(receipt.artifact.path)),receipt.artifact.sha256);
}));
test('a pushed remote or receipt directory inside disposable managed custody is not a durable handoff',()=>fixture(f=>{
 assert.throws(()=>sourceHandoff(f.record,f.request,f.state,[f.repo,f.remote]),{code:'handoff-source-disposable'});
 assert.throws(()=>sourceHandoff(f.record,f.request,path.join(f.repo,'state','registry.sqlite3')),{code:'handoff-artifact-disposable'});
}));

test('ignored declared dependencies and build outputs remain local while exact source is handed off',()=>fixture(f=>{
 fs.writeFileSync(path.join(f.repo,'.gitignore'),'node_modules/\ndist/\nprivate-output/\n');
 f.git('-C',f.repo,'add','.gitignore');f.git('-C',f.repo,'-c','user.name=F','-c','user.email=f@invalid','commit','-m','ignore generated output');
 f.git('-C',f.repo,'push','origin','HEAD:refs/heads/agent/frozen');f.request.head=f.git('-C',f.repo,'rev-parse','HEAD');
 f.record.cachePaths=['node_modules','**/dist'];
 for(const name of ['node_modules','nested/dist']){fs.mkdirSync(path.join(f.repo,name),{recursive:true});fs.writeFileSync(path.join(f.repo,name,'generated'),'local dependency bytes');}
 const result=sourceHandoff(f.record,f.request,f.state);
 assert.deepEqual(result.dependencyCustody.paths,['nested/dist','node_modules']);
 assert.equal(result.dependencyCustody.disposition,'retained-in-child-checkout');
 assert.equal(result.dependencyCustody.transferred,false);
 assert.equal(fs.readFileSync(path.join(f.repo,'node_modules/generated'),'utf8'),'local dependency bytes');
 assert.deepEqual(sourceHandoff(f.record,f.request,f.state),result);
 fs.writeFileSync(path.join(f.repo,'proof.txt'),'modified source');
 assert.throws(()=>sourceHandoff(f.record,f.request,f.state),{code:'handoff-dirty-source'});
 f.git('-C',f.repo,'checkout','--','proof.txt');
 fs.writeFileSync(path.join(f.repo,'untracked'),'unique source');
 assert.throws(()=>sourceHandoff(f.record,f.request,f.state),{code:'handoff-dirty-source'});
 fs.rmSync(path.join(f.repo,'untracked'));
 fs.mkdirSync(path.join(f.repo,'private-output'));fs.writeFileSync(path.join(f.repo,'private-output/proof'),'unknown bytes');
 assert.throws(()=>sourceHandoff(f.record,f.request,f.state),{code:'handoff-unclassified-ignored'});
}));
