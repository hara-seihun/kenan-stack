import './scratch-env.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
for(const status of [75,124])test(`installer reports exact ${status} without replaying or hiding a failed lock/publication attempt`,()=>{
 const root=mkdtempSync(path.join(tmpdir(),'installer-conflict-'));
 try{
  mkdirSync(path.join(root,'bin'));mkdirSync(path.join(root,'.local/bin'),{recursive:true});
  writeFileSync(path.join(root,'bin/sudo'),`#!/bin/sh\nif [ "$1" = env ]; then shift 2; fi\nif [ "$1" = flock ]; then exit ${status}; fi\nexit 0\n`,{mode:0o755});
  const r=spawnSync('/bin/bash',[new URL('./install-capacity-host',import.meta.url).pathname,fileURLToPath(new URL('../../',import.meta.url)),'base','expected',path.join(root,'receipt')],{encoding:'utf8',timeout:5000,env:{...process.env,HOME:root,PATH:path.join(root,'bin')+':/usr/bin:/bin'}});
  assert.equal(r.status,status,r.stderr);const report=JSON.parse(r.stderr.trim());assert.equal(report.ok,false);
  assert.equal(report.error.code,status===75?'host-tool-install-lock-busy':'host-tool-install-failed');
  if(status===124)assert.equal(report.error.exitCode,status);
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('installation allows the existing 240-second sampler to finish without killing or replaying it',()=>{
 const source=readFileSync(new URL('./install-capacity-host',import.meta.url),'utf8');
 const [,outer,wait]=source.match(/timeout (\d+) flock --exclusive --wait (\d+)/);
 assert.ok(Number(wait)>240);assert.ok(Number(outer)>=Number(wait)+80);
 assert.match(source,/no PID or systemd unit is killed/);
});

test('locked installer reentry uses Bash even when the committed script is not executable',()=>{
 const source=readFileSync(new URL('./install-capacity-host',import.meta.url),'utf8');
 assert.match(source,/agent-workspace-admission\.lock \/bin\/bash "\$0" "\$repo" "\$base" "\$expected" "\$receipt" locked/);
});
