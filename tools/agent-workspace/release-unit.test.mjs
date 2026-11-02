import {test} from 'node:test';
import assert from 'node:assert/strict';
import {releaseUnitCessation} from './release-unit.mjs';
const row=unit=>({launch_json:JSON.stringify({started:unit}),binding_json:JSON.stringify({agentId:'manager:converge'}),unit_name:'aw-release-fixture'});
const active={status:0,stdout:'LoadState=loaded\nActiveState=active\nMainPID=123\nControlPID=0\n'};
test('a legacy manager release is observed in the user manager, never falsely ceased in the system manager',()=>{
 const result=releaseUnitCessation(row('kenan-bg-manager:-aw-release-fixture'),{execute:(cmd,args)=>{
  assert.equal(cmd,'systemctl');return args.includes('--user')?active:{status:0,stdout:'LoadState=not-found\n'};
 }});
 assert.equal(result.ceased,false);
});
for(const id of ['manager:converge','22222222-2222-4222-8222-222222222222'])
 test('a root-created '+id+' release is observed in the system manager',()=>{
  assert.equal(releaseUnitCessation(row('kenan-bg-'+id+'-aw-release-fixture'),{execute:(cmd,args)=>{
   assert.equal(args[0],'--system');assert.equal(args.at(-1),'kenan-bg-'+id+'-aw-release-fixture.service');return active;
  }}).ceased,false);
 });
test('only a successful complete cessation observation ends the wait',()=>{
 for(const stdout of ['LoadState=not-found\n','LoadState=loaded\nActiveState=inactive\nMainPID=0\nControlPID=0\n','LoadState=loaded\nActiveState=failed\nMainPID=0\nControlPID=0\n'])
  assert.equal(releaseUnitCessation(row('kenan-bg-manager:-aw-release-fixture'),{execute:()=>({status:0,stdout})}).ceased,true);
 for(const result of [{status:1,stdout:'LoadState=not-found\n'},{status:0,error:{code:'ETIMEDOUT'}},{status:0,signal:'SIGTERM'},{status:0,stdout:''},{status:0,stdout:'LoadState=loaded\nActiveState=inactive\n'}])
  assert.equal(releaseUnitCessation(row('kenan-bg-manager:-aw-release-fixture'),{execute:()=>result}).ceased,false);
 for(const r of [{},{launch_json:'partial'},row('untrusted-name')])assert.equal(releaseUnitCessation(r,{execute:()=>assert.fail('no guessed unit')}).ceased,false);
});
