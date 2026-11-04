import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
test('the installer owns the test slot before fencing and passes its resource hint to sudo',()=>{
 const script=readFileSync(new URL('./install-capacity-host',import.meta.url),'utf8');
 assert.ok(script.indexOf('install-test-slot.mjs')<script.indexOf('sudo install'));
 assert.match(script,/sudo env AGENT_WORKSPACE_TEST_SLOT_HELD="\$AGENT_WORKSPACE_TEST_SLOT_HELD" flock/);
});
test('the slot supervisor preserves argument boundaries and propagates installer failure',()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'install-slot-'));
 try{
  const script=path.join(dir,'fixture.sh');
  writeFileSync(script,'#!/bin/bash\n[[ $AGENT_WORKSPACE_TEST_SLOT_HELD && $1 == "a b" && $2 == test-slot-held ]] || exit 99\nexit 17\n');
  const env={...process.env,AGENT_WORKSPACE_TEST_SLOT_DIR:dir,AGENT_WORKSPACE_TEST_SLOTS:'1'};delete env.AGENT_WORKSPACE_TEST_SLOT_HELD;
  const result=spawnSync(process.execPath,[new URL('./install-test-slot.mjs',import.meta.url).pathname,script,'a b'],{env,timeout:5000});
  assert.equal(result.status,17,String(result.stderr));
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('the slot supervisor preserves the optional source scope on installer reentry',()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'install-scope-slot-'));
 try{
  const script=path.join(dir,'fixture.sh');
  writeFileSync(script,'#!/bin/bash\n[[ $5 == test-slot-held && $6 == "scope file" && $# == 6 ]] || exit 99\nexit 17\n');
  const env={...process.env,AGENT_WORKSPACE_TEST_SLOT_DIR:dir,AGENT_WORKSPACE_TEST_SLOTS:'1'};delete env.AGENT_WORKSPACE_TEST_SLOT_HELD;
  const r=spawnSync(process.execPath,[new URL('./install-test-slot.mjs',import.meta.url).pathname,script,'repo','base','selected','receipt','','scope file'],{env,timeout:5000});
  assert.equal(r.status,17,String(r.stderr));
 }finally{rmSync(dir,{recursive:true,force:true});}
});
