import './scratch-env.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
const cli=new URL('./workspace.mjs',import.meta.url).pathname;
function fixture(){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'freeze-eligibility-')),repo=path.join(root,'repo'),state=path.join(root,'state/registry.sqlite3');
 const git=(p,...args)=>{const r=spawnSync('git',['-C',p,...args],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);return r.stdout.trim();};
 fs.mkdirSync(repo);git(repo,'init','-b','main');git(repo,'config','user.name','Fixture');git(repo,'config','user.email','fixture@example.invalid');git(repo,'remote','add','origin','https://example.invalid/owner/fixture.git');fs.writeFileSync(path.join(repo,'source'),'base');git(repo,'add','.');git(repo,'commit','-m','base');
 const call=(...args)=>spawnSync(process.execPath,[cli,...args],{env:{...process.env,PI_WORKSPACE_STATE:state},encoding:'utf8',timeout:30000});
 const reg=call('register','--path',repo,'--owner','original','--source-commit',git(repo,'rev-parse','HEAD'),'--json');assert.equal(reg.status,0,reg.stderr);const record=JSON.parse(reg.stdout);
 const marker=path.join(repo,'.git/pi-frozen-handoff.json');
 const command=(kind,owner='original')=>call(kind,'--id',record.id,'--path',repo,'--owner',owner,'--expected-head',git(repo,'rev-parse','HEAD'),...(kind==='freeze-source'?['--recipient','recipient','--authorization','regression handoff']:[]),'--json');
 const clean=()=>{if(fs.existsSync(marker)){const r=command('thaw-source',JSON.parse(fs.readFileSync(marker)).ownerAtFreeze==='original'?'recipient':'original');if(r.status!==0)command('thaw-source','original');}fs.rmSync(root,{recursive:true,force:true});};
 return {root,repo,state,git,record,marker,call,command,clean};
}
test('ineligible hardlink refuses before creating a writer fence, leaving source unchanged',()=>{
 const f=fixture();try{
  const outside=path.join(f.root,'outside');fs.writeFileSync(outside,'preserve');fs.linkSync(outside,path.join(f.repo,'.git/shared'));
  const r=f.command('freeze-source');assert.notEqual(r.status,0);assert.match(r.stderr+r.stdout,/snapshot nonprivate inode/);assert.equal(fs.existsSync(f.marker),false);
  fs.writeFileSync(path.join(f.repo,'source'),'still writable');assert.equal(fs.readFileSync(outside,'utf8'),'preserve');
 }finally{f.clean();}
});
test('unmanaged alternates refuse before writing a fence',()=>{
 const f=fixture();try{
  const mirror=path.join(f.root,'outside.git');f.git(f.root,'clone','--bare','--no-hardlinks',f.repo,mirror);fs.writeFileSync(path.join(f.repo,'.git/objects/info/alternates'),mirror+'/objects\n');
  const r=f.command('freeze-source');assert.notEqual(r.status,0);assert.equal(fs.existsSync(f.marker),false);fs.writeFileSync(path.join(f.repo,'source'),'mutable');
 }finally{f.clean();}
});
test('supported thaw clears an old rejected intent with no journal and preserves owner and bytes',()=>{
 const f=fixture();try{
  const head=f.git(f.repo,'rev-parse','HEAD');fs.writeFileSync(f.marker,JSON.stringify({kind:'frozen-source-intent',id:f.record.id,path:f.repo,head,ownerAtFreeze:'original'})+'\n');
  const r=f.command('thaw-source');assert.equal(r.status,0,r.stderr+r.stdout);assert.equal(JSON.parse(r.stdout).rollback.state,'unfrozen-intent');assert.equal(fs.existsSync(f.marker),false);assert.equal(f.git(f.repo,'rev-parse','HEAD'),head);assert.equal(fs.readFileSync(path.join(f.repo,'source'),'utf8'),'base');
  const writer=f.call('writer-run','--id',f.record.id,'--path',f.repo,'--owner','original','--expected-head',head,'--command-json','["true"]','--timeout-ms','1000','--json');assert.equal(writer.status,0,writer.stderr);
 }finally{f.clean();}
});
test('supported thaw reconciles an ended writing lease without reactivating it',()=>{
 const f=fixture();try{
  const head=f.git(f.repo,'rev-parse','HEAD');fs.writeFileSync(f.marker,JSON.stringify({kind:'frozen-source-intent',id:f.record.id,path:f.repo,head,ownerAtFreeze:'original'})+'\n');
  const release=f.call('release','--path',f.repo,'--json');assert.ok([0,2].includes(release.status),release.stderr+release.stdout);
  const r=f.command('thaw-source');assert.equal(r.status,0,r.stderr+r.stdout);assert.equal(JSON.parse(r.stdout).writingLeaseUnchanged,true);assert.equal(fs.existsSync(f.marker),false);
  const status=JSON.parse(f.call('status','--path',f.repo,'--json').stdout).records[0];assert.equal(status.leaseExpiresAt,0);assert.equal(status.state,'blocked');
 }finally{f.clean();}
});
test('a managed alternate pins borrowed closure and freezes local additions without importing mirror history',()=>{
 const f=fixture();let frozen=false;try{
  const mirror=path.join(f.root,'state/mirrors/source.git');fs.mkdirSync(path.dirname(mirror),{recursive:true});f.git(f.root,'clone','--bare','--no-hardlinks',f.repo,mirror);
  // A shared clone starts with no objects of its own. Keep its original registry binding.
  const old=path.join(f.root,'old-git');fs.renameSync(path.join(f.repo,'.git'),old);const donor=path.join(f.root,'donor');f.git(f.root,'clone','--shared',mirror,donor);fs.renameSync(path.join(donor,'.git'),path.join(f.repo,'.git'));f.git(f.repo,'remote','set-url','origin','https://example.invalid/owner/fixture.git');f.git(f.repo,'config','user.name','Fixture');f.git(f.repo,'config','user.email','fixture@example.invalid');
  fs.writeFileSync(path.join(f.repo,'addition'),'local only');f.git(f.repo,'add','.');f.git(f.repo,'commit','-m','local addition');const head=f.git(f.repo,'rev-parse','HEAD'),before=f.git(f.repo,'count-objects','-v');
  const r=f.command('freeze-source');assert.equal(r.status,0,r.stderr+r.stdout);frozen=true;const receipt=JSON.parse(r.stdout);assert.equal(receipt.snapshot.objectCustody.kind,'managed-mirror-pins');assert.ok(receipt.snapshot.objectCustody.pins.length>0);assert.equal(f.git(f.repo,'count-objects','-v'),before);assert.throws(()=>fs.writeFileSync(path.join(f.repo,'source'),'no'),/EPERM/);
  // Delete the donor's ordinary refs and expire/repack/prune; frozen boundary refs own recovery.
  for(const ref of f.git(mirror,'for-each-ref','--format=%(refname)').split('\n').filter(x=>x&&!x.startsWith('refs/pi-workspace-frozen/')))f.git(mirror,'update-ref','-d',ref);
  f.git(mirror,'reflog','expire','--expire=now','--all');f.git(mirror,'gc','--prune=now');assert.equal(f.git(f.repo,'show',head+':source'),'base');assert.equal(f.git(f.repo,'show',head+':addition'),'local only');f.git(f.repo,'fsck','--full','--no-dangling');
  const thaw=f.command('thaw-source','recipient');assert.equal(thaw.status,0,thaw.stderr);frozen=false;fs.writeFileSync(path.join(f.repo,'source'),'mutable again');
 }finally{if(frozen){const r=f.command('thaw-source','recipient');assert.equal(r.status,0,r.stderr);}f.clean();}
});
