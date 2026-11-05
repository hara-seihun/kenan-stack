import './scratch-env.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {hasNodeDependencyMetadata,localTrackedCacheText} from './cache-tree-metadata.mjs';
import {workspaceTesting} from './workspace.mjs';
const command=(name,args,options={})=>{const r=spawnSync(name,args,{encoding:'utf8',timeout:3000,...options,env:{...process.env,...options.env}});return {...r,stdout:(r.stdout??'').trim()};};
function fixture(action){
 const root=fs.mkdtempSync(path.join(tmpdir(),'cache-tree-'));
 const git=(...args)=>{const r=command('git',['-C',root,...args]);assert.equal(r.status,0,r.stderr);return r.stdout;};
 try{
  git('init','-b','main');git('config','user.email','fixture@example.invalid');git('config','user.name','Fixture');
  fs.writeFileSync(path.join(root,'.gitignore'),'node_modules/\n');fs.mkdirSync(path.join(root,'nested'));for(const name of ['package.json','bun.lock','nested/package.json'])fs.writeFileSync(path.join(root,name),JSON.stringify({name}));
  git('add','.');git('commit','-m','metadata fixture');action({root,git});
 }finally{fs.rmSync(root,{recursive:true,force:true});}
}
test('dependency classification uses one committed tree read without opening missing blobs or transports',()=>fixture(({root,git})=>{
 const marker=path.join(root,'transport-ran');
 git('config','remote.origin.url',`ext::sh -c touch% ${marker}`);git('config','remote.origin.promisor','true');
 for(const file of ['package.json','bun.lock','nested/package.json']){const hash=git('rev-parse','HEAD:'+file);fs.unlinkSync(path.join(root,'.git','objects',hash.slice(0,2),hash.slice(2)));}
 const calls=[];const observe=(...args)=>{calls.push(args);return command(...args);};
 assert.equal(hasNodeDependencyMetadata(root,'nested/node_modules',observe),true);
 assert.equal(calls.length,1);assert.ok(calls[0][1].includes('ls-tree'));assert.equal(calls[0][2].env.GIT_ALLOW_PROTOCOL,'');
 assert.equal(fs.existsSync(marker),false);
 fs.mkdirSync(path.join(root,'node_modules'));
 workspaceTesting.duringInspection(Date.now()+5000,()=>workspaceTesting.classifyWorkspaceCache({path:root,cachePaths:['**/node_modules']},{cachePath:'node_modules',classification:'node-dependencies'}));
 assert.throws(()=>localTrackedCacheText(root,'package.json',command),{code:'cache-metadata-unavailable'});
 assert.equal(fs.existsSync(marker),false);
}));
test('untracked manifests, missing lockfiles, and symlinked manifests do not qualify',()=>fixture(({root,git})=>{
 git('rm','bun.lock');git('commit','-m','remove lock');fs.writeFileSync(path.join(root,'bun.lock'),'untracked');
 assert.equal(hasNodeDependencyMetadata(root,'nested/node_modules',command),false);
 git('add','bun.lock');git('rm','package.json');fs.symlinkSync('nested/package.json',path.join(root,'package.json'));git('add','package.json');git('commit','-m','symlink is not manifest metadata');
 assert.equal(hasNodeDependencyMetadata(root,'node_modules',command),false);
 assert.equal(hasNodeDependencyMetadata(root,'nested/node_modules',command),false);
}));
test('absent declarations remain absent, present local declarations preserve exact bytes',()=>fixture(({root,git})=>{
 assert.equal(localTrackedCacheText(root,'.cache-paths',command),undefined);
 fs.writeFileSync(path.join(root,'.cache-paths'),'dist\n# retained declaration');git('add','.cache-paths');git('commit','-m','declaration');
 assert.equal(localTrackedCacheText(root,'.cache-paths',command),'dist\n# retained declaration');
 assert.throws(()=>hasNodeDependencyMetadata(root,'node_modules',()=>({status:128,stdout:''})),{code:'cache-metadata-unavailable'});
}));
