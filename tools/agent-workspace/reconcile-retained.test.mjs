import './scratch-env.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {workspaceTesting} from './workspace.mjs';
import {digest} from './growth-lifecycle.mjs';

for (const execute of [false,true]) test(`single retained workspace reconciliation preserves custody (execute=${execute})`,()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'reconcile-retained-'));
 let db;
 try {
  execFileSync('git',['init','-q',root]);
  fs.writeFileSync(path.join(root,'valuable-source'),'unpublished source');
  db=workspaceTesting.openRegistry(path.join(root,'registry.sqlite3'));
  const record={id:'retained-single',path:root,owner:'fixture',groupId:null,leaseExpiresAt:0};
  const plan=JSON.stringify({intent:'budgeted',constructionBytes:4096,growthBytes:4096,headroomBytes:8*1024**3,
   growthLifecycle:{kind:'retired-future-growth',remainingGrowthBytes:0,retainedUse:'source',dispositionSha256:'a'.repeat(64),retiredAt:1}});
  db.prepare('INSERT INTO workspace_capacity(workspace_id,device_id,plan_json) VALUES(?,?,?)').run(record.id,'fixture',plan);
  const before=db.prepare('SELECT * FROM workspace_capacity').all();
  const result=workspaceTesting.reconcileRecord(db,record,{execute,reapExpired:true});
  assert.equal(result.record,record);
  assert.equal(result.action,'none');
  assert.equal(result.inspection.classification,'blocked');
  assert.equal(result.nextAction.kind,'end-retention');
  assert.equal(result.nextAction.planSha256,digest(plan));
  assert.deepEqual(result.nextAction.argv,['agent-workspace','release','--id',record.id,'--end-retention','--owner',record.owner,'--expected-plan-sha256',digest(plan),'--json']);
  assert.deepEqual(db.prepare('SELECT * FROM workspace_capacity').all(),before);
  assert.equal(fs.readFileSync(path.join(root,'valuable-source'),'utf8'),'unpublished source');
 } finally {db?.close();fs.rmSync(root,{recursive:true,force:true});}
});
