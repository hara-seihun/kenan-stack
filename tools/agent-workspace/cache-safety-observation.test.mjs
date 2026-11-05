import './scratch-env.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync, spawn} from 'node:child_process';
import {once} from 'node:events';
import assert from 'node:assert/strict';
import {test} from 'node:test';
const {workspaceTesting:w} = await import('./workspace.mjs');

// November 5, converge-kenan: cache retirements ran the growth-writer check and the native
// materialization check as two serial host observations (two privileged /proc scans, two
// Docker, systemd, thread and Git-dependency censuses) and lost their 35-second verdicts
// under load. One /proc pass now serves both; each check must keep its own semantics.
const proc=(pid,fields)=>({pid,ppid:1,command:'node',commandLine:['node','-e','x'],cwd:'/',executable:'/usr/bin/node',writableFiles:[],openFiles:[],...fields});

test('one shared process observation keeps writable-only growth and all-descriptor materialization semantics',()=>{
  const workspace='/w/checkout',borrower='/w/borrower',stage='/state/generated-retirement/abc';
  const snapshot=[
    proc(11,{openFiles:[`${stage}/pkg/index.js`]}),                                         // reader of the staged cache
    proc(12,{writableFiles:[`${workspace}/node_modules/.cache/x`],openFiles:[`${workspace}/node_modules/.cache/x`]}), // writer in the checkout
    proc(13,{cwd:borrower}),                                                                // shell inside a Git borrower
    proc(14,{openFiles:[`${workspace}/README.md`]}),                                        // reader of checkout source
    proc(15,{openFiles:['/elsewhere/file'],writableFiles:['/elsewhere/file']}),             // unrelated
  ];
  const observed=w.cacheProcessReferences([workspace,borrower],[workspace,stage],snapshot);
  const pids=rows=>rows.map(row=>`${row.pid}@${row.root}`).sort();
  // Growth: writable descriptors, cwd and arguments under the checkout and its borrowers.
  assert.deepEqual(pids(observed.growth),['12@/w/checkout','13@/w/borrower']);
  // Materialization: every descriptor under the checkout and staging roots, readers included.
  assert.deepEqual(pids(observed.materialization),['11@/state/generated-retirement/abc','12@/w/checkout','14@/w/checkout']);
  assert.ok(observed.materialization.find(row=>row.pid===11).matches.some(match=>match===`write-fd:${stage}/pkg/index.js`));
});

test('a process snapshot without all-descriptor detail fails closed instead of clearing readers',()=>{
  assert.throws(()=>w.cacheProcessReferences(['/w/a'],['/w/a'],[proc(21,{writableFiles:['/w/a/x'],openFiles:undefined})]),/all-descriptor observation missing/);
});

test('native cache-process-snapshot finds a staged-cache reader, a checkout writer and a borrower shell in one pass',async t=>{
  try { execFileSync('sudo',['-n','true'],{stdio:'ignore',timeout:5000}); } catch { t.skip('passwordless root observation grant unavailable'); return; }
  const base=fs.mkdtempSync(path.join(tmpdir(),'cache-observation-')),workspace=path.join(base,'checkout'),borrower=path.join(base,'borrower'),stage=path.join(base,'stage');
  for(const directory of [workspace,borrower,stage])fs.mkdirSync(directory);
  fs.writeFileSync(path.join(stage,'payload'),'staged');
  const hold=script=>spawn(process.execPath,['-e',`${script};console.log('ready');setInterval(()=>{},1000);`],{stdio:['ignore','pipe','ignore']});
  const reader=hold(`require('node:fs').openSync(${JSON.stringify(path.join(stage,'payload'))},'r')`);
  const writer=hold(`require('node:fs').openSync(${JSON.stringify(path.join(workspace,'write-held'))},'w')`);
  const shell=spawn(process.execPath,['-e',`console.log('ready');setInterval(()=>{},1000);`],{cwd:borrower,stdio:['ignore','pipe','ignore']});
  try {
    await Promise.all([reader,writer,shell].map(child=>once(child.stdout,'data')));
    const entry=new URL('./workspace.mjs',import.meta.url).pathname;
    const observed=JSON.parse(execFileSync('sudo',['-n',process.execPath,entry,'cache-process-snapshot','--growth-path',workspace,'--growth-path',borrower,'--path',workspace,'--path',stage],{encoding:'utf8',timeout:15000}));
    const has=(rows,pid,root)=>rows.some(row=>row.pid===pid&&row.root===root);
    assert.ok(has(observed.growth,writer.pid,workspace),JSON.stringify(observed.growth));
    assert.ok(has(observed.growth,shell.pid,borrower),JSON.stringify(observed.growth));
    assert.ok(!observed.growth.some(row=>row.pid===reader.pid),'a read-only staged descriptor is not a growth writer');
    assert.ok(has(observed.materialization,reader.pid,stage),JSON.stringify(observed.materialization));
    assert.ok(has(observed.materialization,writer.pid,workspace),JSON.stringify(observed.materialization));
  } finally {
    for(const child of [reader,writer,shell]){child.kill('SIGKILL');await once(child,'exit');}
    fs.rmSync(base,{recursive:true,force:true});
  }
});
