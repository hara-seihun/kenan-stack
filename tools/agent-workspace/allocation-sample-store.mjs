import {createHash} from 'node:crypto';
import {recordGrowthSample} from './growth-policy-store.mjs';

const valid = value => Number.isSafeInteger(value) && value >= 0;
function parse(text) {
  try { return JSON.parse(text); } catch { return null; }
}
function validPrior(sample, current) {
  return sample?.ok === true && !sample.partial &&
    sample.rootPath === current.rootPath && sample.planSha256 === current.planSha256 &&
    sample.device === current.device && sample.inode === current.inode &&
    [sample.startedAt, sample.completedAt, sample.bytes, sample.allocatedBytes].every(valid) &&
    sample.startedAt <= sample.completedAt && sample.completedAt <= current.completedAt &&
    sample.bytes <= sample.allocatedBytes;
}

// The caller holds the checkout lock and, for successful observations, the actual
// device capacity lock. This helper never acquires locks or starts a filesystem walk.
// Both authoritative writes commit together, so a lock deadline or journal error
// cannot leave a newer successful cache without its growth history.
export function persistAllocationSample(db, row, sample) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const fresh = db.prepare(`SELECT w.path,w.state,w.created_at,c.device_id,c.plan_json
      FROM workspace w LEFT JOIN workspace_capacity c ON c.workspace_id=w.id
      WHERE w.id=? AND w.state!='released'`).get(row.id);
    if (!fresh) {
      db.exec('COMMIT');
      return sample;
    }
    const prior = parse(db.prepare('SELECT measurement_json FROM workspace_capacity_measurement WHERE workspace_id=?').get(row.id)?.measurement_json);
    let stored = sample;
    if (sample.ok) {
      if (fresh.path !== row.path || fresh.device_id !== row.device_id || sample.device !== fresh.device_id) {
        throw new Error('allocation sample workspace identity changed before publication');
      }
      const plan = JSON.parse(fresh.plan_json);
      stored = {...sample, rootPath:fresh.path,
        planSha256:createHash('sha256').update(fresh.plan_json).digest('hex')};
      const currentRow = {...row, ...fresh};
      if (validPrior(prior, stored)) recordGrowthSample(db, currentRow, plan, prior);
      recordGrowthSample(db, currentRow, plan, stored);
    }
    // A failed or interrupted observation must never erase a successful sample.
    if (sample.ok || !prior?.ok) {
      db.prepare('INSERT OR REPLACE INTO workspace_capacity_measurement(workspace_id,measurement_json) VALUES(?,?)')
        .run(row.id, JSON.stringify(stored));
    }
    db.exec('COMMIT');
    return stored;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
