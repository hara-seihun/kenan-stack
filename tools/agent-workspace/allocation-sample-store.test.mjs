import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {ensureGrowthPolicyStore} from './growth-policy-store.mjs';
import {persistAllocationSample} from './allocation-sample-store.mjs';

function fixture(fn) {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE workspace(id TEXT PRIMARY KEY,path TEXT,state TEXT,created_at INTEGER);
    CREATE TABLE workspace_capacity(workspace_id TEXT PRIMARY KEY,device_id TEXT,plan_json TEXT);
    CREATE TABLE workspace_capacity_measurement(workspace_id TEXT PRIMARY KEY,measurement_json TEXT);`);
  ensureGrowthPolicyStore(db);
  const row = {id:'workspace-one',path:'/fixture/source',device_id:'42',state:'active',created_at:1};
  const plan = {intent:'budgeted',growthBytes:1024,completedAllocationBytes:100};
  const planJson = JSON.stringify(plan);
  const hash = text => createHash('sha256').update(text).digest('hex');
  db.prepare('INSERT INTO workspace VALUES(?,?,?,?)').run(row.id,row.path,row.state,row.created_at);
  db.prepare('INSERT INTO workspace_capacity VALUES(?,?,?)').run(row.id,row.device_id,planJson);
  const sample = (bytes, at=200) => ({ok:true,bytes,allocatedBytes:bytes,startedAt:at-1,completedAt:at,device:'42',inode:'99'});
  const bound = value => ({...value,rootPath:row.path,planSha256:hash(planJson)});
  const cache = value => db.prepare('INSERT OR REPLACE INTO workspace_capacity_measurement VALUES(?,?)').run(row.id,JSON.stringify(value));
  const readCache = () => db.prepare('SELECT measurement_json FROM workspace_capacity_measurement WHERE workspace_id=?').get(row.id)?.measurement_json;
  const readPolicy = () => db.prepare('SELECT state_json FROM workspace_growth_policy WHERE workspace_id=?').get(row.id)?.state_json;
  try { fn({db,row,plan,planJson,hash,sample,bound,cache,readCache,readPolicy}); }
  finally { db.close(); }
}

test('successful publication atomically journals the prior valid observation and the new sample', () => fixture(f => {
  f.cache(f.bound(f.sample(120,100)));
  // The cache trigger proves that the journal already contains the new point at
  // the exact publication boundary, not merely after this helper returns.
  f.db.exec(`CREATE TRIGGER require_growth_history BEFORE INSERT ON workspace_capacity_measurement
    WHEN NOT EXISTS(SELECT 1 FROM workspace_growth_policy p WHERE p.workspace_id=NEW.workspace_id
      AND json_extract(p.state_json,'$.samples[#-1].at')=json_extract(NEW.measurement_json,'$.completedAt')
      AND json_extract(p.state_json,'$.samples[#-1].bytes')=json_extract(NEW.measurement_json,'$.bytes'))
    BEGIN SELECT RAISE(ABORT,'missing corresponding growth sample'); END;`);
  const result = persistAllocationSample(f.db,f.row,f.sample(140));
  assert.deepEqual(JSON.parse(f.readCache()),f.bound(f.sample(140)));
  assert.deepEqual(result,JSON.parse(f.readCache()));
  const policy = JSON.parse(f.readPolicy());
  assert.deepEqual(policy.samples,[{at:100,bytes:120},{at:200,bytes:140}]);
  assert.deepEqual(policy.allocationBinding,{rootPath:f.row.path,planSha256:f.hash(f.planJson),device:'42',inode:'99'});
  assert.equal(f.db.prepare('SELECT plan_json FROM workspace_capacity').get().plan_json,f.planJson);
}));

test('a growth-journal abort rolls back both writes and retains the exact old successful cache', () => fixture(f => {
  persistAllocationSample(f.db,f.row,f.sample(120,100));
  const cacheBefore = f.readCache(), policyBefore = f.readPolicy();
  f.db.exec(`CREATE TRIGGER reject_growth BEFORE INSERT ON workspace_growth_policy
    WHEN json_extract(NEW.state_json,'$.samples[#-1].at')=200
    BEGIN SELECT RAISE(ABORT,'growth journal unavailable'); END;`);
  assert.throws(() => persistAllocationSample(f.db,f.row,f.sample(140)),/growth journal unavailable/);
  assert.equal(f.readCache(),cacheBefore);
  assert.equal(f.readPolicy(),policyBefore);
  // Rollback leaves the connection usable; a later real observation can commit.
  f.db.exec('DROP TRIGGER reject_growth');
  persistAllocationSample(f.db,f.row,f.sample(140));
  assert.equal(JSON.parse(f.readCache()).completedAt,200);
}));

test('a cache write abort also rolls back the preceding growth-journal update', () => fixture(f => {
  persistAllocationSample(f.db,f.row,f.sample(120,100));
  const cacheBefore = f.readCache(), policyBefore = f.readPolicy();
  f.db.exec(`CREATE TRIGGER reject_cache BEFORE INSERT ON workspace_capacity_measurement
    BEGIN SELECT RAISE(ABORT,'cache publication unavailable'); END;`);
  assert.throws(() => persistAllocationSample(f.db,f.row,f.sample(140)),/cache publication unavailable/);
  assert.equal(f.readCache(),cacheBefore);
  assert.equal(f.readPolicy(),policyBefore);
}));

test('plan binding uses the exact current JSON read inside the transaction, not the stale input', () => fixture(f => {
  f.cache(f.bound(f.sample(120,100)));
  const currentJson = '{ "intent": "budgeted", "growthBytes": 2048, "completedAllocationBytes": 100 }';
  f.db.prepare('UPDATE workspace_capacity SET plan_json=?').run(currentJson);
  const untrustedBinding = {...f.sample(140),rootPath:'/wrong',planSha256:'stale'};
  const result = persistAllocationSample(f.db,f.row,untrustedBinding);
  assert.equal(result.planSha256,f.hash(currentJson));
  assert.equal(result.rootPath,f.row.path);
  assert.equal(untrustedBinding.planSha256,'stale');
  const policy = JSON.parse(f.readPolicy());
  assert.equal(policy.planGrowthBytes,2048);
  assert.equal(policy.allocationBinding.planSha256,f.hash(currentJson));
  assert.deepEqual(policy.samples,[{at:200,bytes:140}]);
}));

for (const [name, change] of [
  ['root', s => ({...s,rootPath:'/different'})],
  ['device', s => ({...s,device:'7'})],
  ['inode', s => ({...s,inode:'8'})],
  ['plan', s => ({...s,planSha256:'other-plan'})],
  ['time', s => ({...s,completedAt:300})],
  ['bytes', s => ({...s,bytes:-1})],
  ['partial observation', s => ({...s,partial:true})],
]) {
  test(`a prior sample with a mismatched or invalid ${name} cannot enter the new journal`, () => fixture(f => {
    f.cache(change(f.bound(f.sample(120,100))));
    persistAllocationSample(f.db,f.row,f.sample(140));
    assert.deepEqual(JSON.parse(f.readPolicy()).samples,[{at:200,bytes:140}]);
  }));
}

test('failed observations retain the prior successful sample and growth history unchanged', () => fixture(f => {
  persistAllocationSample(f.db,f.row,f.sample(120,100));
  const cacheBefore = f.readCache(), policyBefore = f.readPolicy();
  const failure = {ok:false,startedAt:199,completedAt:200,error:'capacity lock deadline expired'};
  assert.deepEqual(persistAllocationSample(f.db,f.row,failure),failure);
  assert.equal(f.readCache(),cacheBefore);
  assert.equal(f.readPolicy(),policyBefore);
}));

test('failed observations are recorded if no successful sample exists, without adding journal history', () => fixture(f => {
  const failure = {ok:false,startedAt:199,completedAt:200,error:'walk deadline expired'};
  persistAllocationSample(f.db,f.row,failure);
  assert.deepEqual(JSON.parse(f.readCache()),failure);
  assert.equal(f.readPolicy(),undefined);
}));

test('a released workspace cannot publish either a new cache or growth history', () => fixture(f => {
  persistAllocationSample(f.db,f.row,f.sample(120,100));
  const cacheBefore = f.readCache(), policyBefore = f.readPolicy();
  f.db.exec("UPDATE workspace SET state='released'");
  persistAllocationSample(f.db,f.row,f.sample(140));
  assert.equal(f.readCache(),cacheBefore);
  assert.equal(f.readPolicy(),policyBefore);
}));

test('a changed workspace identity is rejected without publishing an incorrectly bound observation', () => fixture(f => {
  f.db.exec("UPDATE workspace SET path='/replacement'");
  assert.throws(() => persistAllocationSample(f.db,f.row,f.sample(140)),/identity changed/);
  assert.equal(f.readCache(),undefined);
  assert.equal(f.readPolicy(),undefined);
}));
