import {test} from 'node:test';
import assert from 'node:assert/strict';
import {releaseBudgetMs,RELEASE_INSPECTION_MS} from './release-budget.mjs';
import {releaseCaller} from './release-authority.mjs';
test('only authenticated foreground submission uses the short budget; physical release retains its finite bound',()=>{
 assert.equal(releaseBudgetMs({background:false}),20000);
 assert.equal(releaseBudgetMs({background:true}),150000);
 assert.equal(releaseBudgetMs(null),RELEASE_INSPECTION_MS);
});
test('a stale user-manager background wrapper cannot downgrade native custody to operator authority',()=>{
 const result=releaseCaller({caller:()=>null,pid:2,cgroup:()=>'/user.slice/user-1000.slice/kenan-bg-03b732a8-aw-release-case.service',argv:()=>['node'],parent:()=>1});
 assert.equal(result.ok,false);assert.equal(result.error.code,'release-caller-unverified');
});
