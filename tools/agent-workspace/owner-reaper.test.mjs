import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {reapEndedOwners,ownerPage} from './owner-reaper.mjs';

test('binding completes before release and authentication failure never reaches release',()=>{
 const calls=[];
 const result=reapEndedOwners({bind:()=>{calls.push('bind');return {ok:true};},release:()=>{assert.deepEqual(calls,['bind']);calls.push('release');return {ok:true};}});
 assert.equal(result.ok,true);assert.deepEqual(calls,['bind','release']);
 const refused=reapEndedOwners({bind:()=>({ok:false}),release:()=>{throw Error('must not run');}});
 assert.equal(refused.ok,false);assert.equal(refused.release,null);
});
test('stable cursor wraps on timer passes and finishes explicit walks',()=>{
 const records=['a','b','c'].map(id=>({id,path:'/pool/'+id,root:'/pool'}));
 assert.deepEqual(ownerPage(records,records[1]).map(r=>r.id),['c','a','b']);
 assert.deepEqual(ownerPage(records,records[2],{wrap:false}),[]);
 assert.deepEqual(ownerPage(records,{id:'old',path:'/pool/bb',root:'/pool'},{wrap:false}).map(r=>r.id),['c']);
});
test('component service invokes supported reaper with one-minute cadence and finite timeout',()=>{
 const read=name=>fs.readFileSync(new URL(name,import.meta.url),'utf8');
 const service=read('agent-workspace-owner-liveness.service'),timer=read('agent-workspace-owner-liveness.timer'),install=read('install-owner-reaper');
 assert.match(service,/ExecStart=%h\/\.local\/bin\/agent-workspace reap-ended-owners --execute/);
 assert.match(service,/--bind-budget-ms 15000 --bind-max-records 128 --budget-ms 90000 --max-records 64/);
 assert.match(service,/TimeoutStartSec=120/);assert.match(service,/KillMode=control-group/);
 assert.match(timer,/OnUnitInactiveSec=1min/);assert.match(install,/node "\$component\/main" reap-ended-owners --help/);
});
