import './scratch-env.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {workspaceTesting as w} from './workspace.mjs';
import {withDonorView} from './donor-view.mjs';

function fixture(body) {
 const root = fs.mkdtempSync(path.join(os.tmpdir(), 'donor-view-test-'));
 const run = (...args) => execFileSync('git', args, {encoding:'utf8', stdio:['pipe','pipe','pipe']}).trim();
 const git = (repo, args, options = {}) => execFileSync('git', ['-C', repo, ...args], {encoding:'utf8', stdio:['pipe','pipe','pipe'], ...options}).trim();
 const source = path.join(root, 'source'), mirror = path.join(root, 'mirror.git'), donor = path.join(root, 'donor');
 try {
  run('init', source); git(source, ['config','user.name','Fixture']); git(source, ['config','user.email','fixture@example.invalid']);
  fs.writeFileSync(path.join(source,'f'),'first'); git(source,['add','.']); git(source,['commit','-qm','first']);
  fs.writeFileSync(path.join(source,'f'),'second'); git(source,['commit','-qam','second']);
  run('clone','--bare','--depth=1','file://' + source,mirror);
  const base = git(mirror,['rev-parse','HEAD']);
  run('init', donor); git(donor,['config','user.name','Fixture']); git(donor,['config','user.email','fixture@example.invalid']);
  fs.writeFileSync(path.join(donor,'.git','objects','info','alternates'),path.join(mirror,'objects')+'\n');
  git(donor,['update-ref','HEAD',base]); git(donor,['read-tree','-u','--reset',base]);
  fs.writeFileSync(path.join(donor,'f'),'third'); git(donor,['add','.']);
  const head = git(donor,['commit-tree',git(donor,['write-tree']),'-p',base,'-m','third']);
  git(donor,['update-ref','HEAD',head]);
  body({root, source, mirror, donor, base, head, git});
 } finally { fs.rmSync(root,{recursive:true,force:true}); }
}

test('missing mirror boundary is read through a private view for exact pricing and import without touching donor',()=>fixture(f=>{
 const shallow = path.join(f.donor,'.git','shallow');
 const alternate = fs.readFileSync(path.join(f.donor,'.git','objects','info','alternates'),'utf8');
 assert.equal(fs.existsSync(shallow),false);
 assert.throws(()=>f.git(f.donor,['rev-list','--first-parent',f.head]),/Command failed/);
 const plan = w.sourceCapacityPlan(f.donor,f.head,{intent:'source-only',headroomBytes:1024,growthBytes:1024},4096,f.mirror,[]);
 assert.deepEqual(plan.sourceImportBaseCommits,[f.base]);
 assert.ok(plan.sourceImportBytes>0);
 assert.equal(w.fetchSource(f.mirror,f.donor,f.head,[]),f.head);
 assert.equal(f.git(f.mirror,['rev-parse',w.sourceRefFor(f.donor,f.head)]),f.head);
 assert.equal(f.git(f.mirror,['rev-list','--count',f.head]),'2');
 assert.equal(fs.existsSync(path.join(f.mirror,'objects','info','alternates')),false);
 assert.equal(f.git(f.donor,['rev-parse','HEAD']),f.head);
 assert.equal(fs.existsSync(shallow),false);
 assert.equal(fs.readFileSync(path.join(f.donor,'.git','objects','info','alternates'),'utf8'),alternate);
 assert.throws(()=>f.git(f.donor,['rev-list','--first-parent',f.head]),/Command failed/);
}));

test('no boundary is invented for a missing parent without actual mirror metadata',()=>fixture(f=>{
 fs.unlinkSync(path.join(f.mirror,'shallow'));
 assert.throws(()=>w.sourceCapacityPlan(f.donor,f.head,{intent:'source-only',headroomBytes:1024,growthBytes:1024},4096,f.mirror,[]),/Could not read|Failed to traverse/);
 assert.equal(fs.existsSync(path.join(f.donor,'.git','shallow')),false);
}));

test('a complete donor is not truncated to the alternate mirror history',()=>fixture(f=>{
 // Restore the donor parent objects from its complete upstream, without changing mirror metadata.
 f.git(f.donor,['fetch','--refetch','--no-tags',f.source,'HEAD']);
 const command=(repo,args,options)=>{try{return {status:0,stdout:f.git(repo,args,options)}}catch{return {status:128,stdout:''}}};
 let selected;
 withDonorView(f.donor,f.mirror,f.head,{git:f.git,command},repo=>{selected=repo});
 assert.equal(selected,f.donor);
}));

test('private view is removed even when the consumer fails',()=>fixture(f=>{
 const command=(repo,args,options)=>{try{return {status:0,stdout:f.git(repo,args,options)}}catch{return {status:128,stdout:''}}};
 let selected;
 assert.throws(()=>withDonorView(f.donor,f.mirror,f.head,{git:f.git,command},repo=>{selected=repo;throw Error('consumer failed')}),/consumer failed/);
 assert.notEqual(selected,f.donor); assert.equal(fs.existsSync(selected),false);
 assert.equal(fs.existsSync(path.join(f.donor,'.git','shallow')),false);
}));

test('an unknown parent probe is not converted into a shallow boundary',()=>fixture(f=>{
 const command=(repo,args,options)=> args.includes('--batch-check') ? {status:124,stdout:''} : {status:0,stdout:f.git(repo,args,options)};
 assert.throws(()=>withDonorView(f.donor,f.mirror,f.head,{git:f.git,command},()=>assert.fail('unknown probe admitted')),/presence is unknown/);
 assert.equal(fs.existsSync(path.join(f.donor,'.git','shallow')),false);
}));
