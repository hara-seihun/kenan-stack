import './scratch-env.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync,execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync,statSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';

const entry = new URL('./workspace.mjs',import.meta.url).pathname;
const manager = spawnSync('systemctl',['--user','is-active','basic.target'],{encoding:'utf8',timeout:2000});
const options = {skip:manager.status !== 0,timeout:45_000};
const delay = ms => new Promise(resolve => setTimeout(resolve,ms));

function fixture(t) {
  const root=mkdtempSync(path.join(tmpdir(),'construction-measurement-'));
  const state=path.join(root,'state','registry.sqlite3'),source=path.join(root,'source'),pool=path.join(root,'pool');
  mkdirSync(source);
  const git=(...args)=>execFileSync('git',['-C',source,...args],{encoding:'utf8',timeout:3000}).trim();
  git('init','-q');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');
  mkdirSync(path.join(source,'docs'));writeFileSync(path.join(source,'docs','proof.txt'),'completed checkout allocation\n');
  writeFileSync(path.join(source,'excluded.txt'),'sparse selection excludes this\n');
  git('add','.');git('commit','-qm','construction fixture');
  const commit=git('rev-parse','HEAD');
  const env={...process.env,PI_WORKSPACE_STATE:state,PI_WORKSPACE_TEST_EXTERNAL_SAFETY:'empty',GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1'};
  for(const key of ['PI_WORKSPACE_CREATE_CHILD','PI_WORKSPACE_CHECKOUT_JOB','PI_WORKSPACE_CHECKOUT_STAGE','PI_WORKSPACE_SOURCE_JOB_DIR'])delete env[key];
  const cli=args=>spawnSync(process.execPath,[entry,...args],{env,encoding:'utf8',timeout:12_000});
  const args=['create','--root',pool,'--name','checkout','--repo',source,'--owner','construction-fixture','--intent','source-only','--headroom-gib','8','--growth-mib','512','--sparse-pattern','/docs/','--json'];
  t.after(()=>{
    if(existsSync(state)) {
      const db=new DatabaseSync(state);const rows=db.prepare('SELECT id FROM workspace').all();db.close();
      for(const {id} of rows) {
        const jobs=path.join(path.dirname(state),'checkout-jobs',id);
        if(!existsSync(jobs))continue;
        // The durable checkout is already terminal; stopping it prevents a test
        // cleanup from racing an ExecStopPost that still owns its staging path.
        for(const name of readdirSync(jobs)) {
          const attempt=path.join(jobs,name,'attempt.json');if(!existsSync(attempt))continue;
          const {unit}=JSON.parse(readFileSync(attempt,'utf8'));
          spawnSync('systemctl',['--user','stop',unit],{encoding:'utf8',timeout:3000});
        }
      }
    }
    rmSync(root,{recursive:true,force:true});
  });
  return {root,state,source,pool,commit,cli,args,destination:path.join(pool,'checkout')};
}

async function create(f) {
  const deadline=Date.now()+30_000;
  while(Date.now()<deadline) {
    const result=f.cli(f.args);
    assert.equal(result.error,undefined,result.error?.message);
    assert.ok([0,75].includes(result.status),`${result.stdout}\n${result.stderr}`);
    const receipt=JSON.parse(result.stdout);
    if(result.status===0) {assert.equal(receipt.state,'active');return receipt;}
    assert.ok(['preparing','creating'].includes(receipt.state));
    await delay(50);
  }
  assert.fail('checkout construction did not complete');
}

function assertMeasurement(f,receipt) {
  const db=new DatabaseSync(f.state);
  try {
    const row=db.prepare('SELECT w.*,c.plan_json,c.device_id FROM workspace w JOIN workspace_capacity c ON c.workspace_id=w.id WHERE w.id=?').get(receipt.id);
    const sample=JSON.parse(db.prepare('SELECT measurement_json FROM workspace_capacity_measurement WHERE workspace_id=?').get(receipt.id).measurement_json);
    const policy=JSON.parse(db.prepare('SELECT state_json FROM workspace_growth_policy WHERE workspace_id=?').get(receipt.id).state_json);
    const plan=JSON.parse(row.plan_json),stats=statSync(f.destination);
    assert.equal(row.state,'active');
    assert.equal(sample.ok,true);assert.equal(sample.partial,undefined);
    assert.equal(sample.rootPath,f.destination,'sample binds the final path, not the private staging path');
    assert.equal(sample.device,String(stats.dev));assert.equal(sample.device,row.device_id);
    assert.equal(sample.inode,String(stats.ino));
    assert.equal(sample.planSha256,createHash('sha256').update(row.plan_json).digest('hex'));
    assert.ok(sample.startedAt>=row.created_at);assert.ok(sample.completedAt>=sample.startedAt);
    assert.ok(Date.now()-sample.startedAt<30_000,'construction publishes its own fresh observation');
    assert.equal(plan.completedAllocationBytes,sample.allocatedBytes);
    assert.ok(sample.bytes>0);assert.ok(sample.bytes<=sample.allocatedBytes);
    assert.deepEqual(policy.allocationBinding,{rootPath:sample.rootPath,planSha256:sample.planSha256,device:sample.device,inode:sample.inode});
    assert.deepEqual(policy.samples.at(-1),{at:sample.completedAt,bytes:sample.bytes});
    assert.equal(policy.planGrowthBytes,plan.growthBytes);
    assert.equal(receipt.sourceCommit,f.commit);
    assert.ok(existsSync(path.join(f.destination,'docs','proof.txt')));
    assert.equal(existsSync(path.join(f.destination,'excluded.txt')),false);
    return {sample,policy};
  } finally {db.close();}
}

function pendingWithoutSample(f,id) {
  const db=new DatabaseSync(f.state);
  db.prepare("UPDATE workspace SET state='creating' WHERE id=?").run(id);
  db.prepare('DELETE FROM workspace_capacity_measurement WHERE workspace_id=?').run(id);
  db.prepare('DELETE FROM workspace_growth_policy WHERE workspace_id=?').run(id);
  return db;
}

test('successful native sparse construction publishes a final-root allocation and matching growth journal',options,async t=>{
  const f=fixture(t),receipt=await create(f);
  const before=assertMeasurement(f,receipt);
  const final=f.cli(['finalize-creation','--id',receipt.id,'--json']);
  assert.equal(final.status,0,final.stderr);
  const repeated=f.cli(f.args);assert.equal(repeated.status,0,repeated.stderr);
  assert.deepEqual(assertMeasurement(f,JSON.parse(repeated.stdout)),before,'completed replay does not invent another observation');
});

test('finalization of a materialized pending checkout repairs a missing construction observation',options,async t=>{
  const f=fixture(t),receipt=await create(f);
  pendingWithoutSample(f,receipt.id).close();
  const finalized=f.cli(['finalize-creation','--id',receipt.id,'--json']);
  assert.equal(finalized.status,0,finalized.stderr);
  assertMeasurement(f,JSON.parse(finalized.stdout));
});

test('a failed growth journal cannot activate a completed checkout without its matching sample',options,async t=>{
  const f=fixture(t),receipt=await create(f);
  const db=pendingWithoutSample(f,receipt.id);
  try {
    const before=db.prepare('SELECT plan_json FROM workspace_capacity WHERE workspace_id=?').get(receipt.id).plan_json;
    db.exec(`CREATE TRIGGER reject_completion_growth BEFORE INSERT ON workspace_growth_policy
      BEGIN SELECT RAISE(ABORT,'construction growth journal unavailable'); END;`);
    const failed=f.cli(['finalize-creation','--id',receipt.id,'--json']);
    assert.equal(failed.status,2,failed.stderr);
    assert.match(failed.stderr,/construction growth journal unavailable/);
    assert.equal(db.prepare('SELECT state FROM workspace WHERE id=?').get(receipt.id).state,'creating');
    assert.equal(db.prepare('SELECT plan_json FROM workspace_capacity WHERE workspace_id=?').get(receipt.id).plan_json,before);
    assert.equal(db.prepare('SELECT count(*) n FROM workspace_growth_policy WHERE workspace_id=?').get(receipt.id).n,0);
    db.exec('DROP TRIGGER reject_completion_growth');
    const resumed=f.cli(['finalize-creation','--id',receipt.id,'--json']);
    assert.equal(resumed.status,0,resumed.stderr);
    assertMeasurement(f,JSON.parse(resumed.stdout));
  } finally {db.close();}
});
