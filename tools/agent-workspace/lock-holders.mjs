import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

// Diagnostic custody records beside flock files. The flock is the only exclusion;
// a record names who holds it and in which phase, so a busy wait is attributable.
const self = (() => {
  const read = file => { try { return readFileSync(file, "utf8"); } catch { return null; } };
  const stat = read("/proc/self/stat");
  const startTime = stat === null ? null : stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? null;
  const cgroup = read("/proc/self/cgroup");
  const unit = cgroup?.split("\n").flatMap(line => line.split("/")).reverse().find(part => /\.(service|scope)$/u.test(part)) ?? null;
  return { startTime, unit };
})();

function processStartTime(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? null;
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ESRCH") return null;
    throw error;
  }
}

const alive = record => Number.isSafeInteger(record.pid) && record.startTime !== null && processStartTime(record.pid) === record.startTime;

function readRecord(file) {
  try { return JSON.parse(readFileSync(file, "utf8")); }
  catch (error) { if (error.code === "ENOENT" || error instanceof SyntaxError) return null; throw error; }
}

export function recordLockHolder(directory, lockName, value) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const prefix = `${lockName}.`;
  for (const name of readdirSync(directory)) {
    if (!name.startsWith(prefix) || !name.endsWith(".json")) continue;
    const record = readRecord(path.join(directory, name));
    if (record !== null && !alive(record)) rmSync(path.join(directory, name), { force: true });
  }
  const file = path.join(directory, `${prefix}${process.pid}.${randomUUID()}.json`);
  const temporary = `${file}.tmp`;
  writeFileSync(temporary, JSON.stringify({ ...value, pid: process.pid, startTime: self.startTime, unit: self.unit, acquiredAt: Date.now() }), { mode: 0o600 });
  renameSync(temporary, file);
  return () => rmSync(file, { force: true });
}

function holderPhase(job) {
  if (typeof job !== "string") return null;
  const progress = readRecord(path.join(job, "progress.json"));
  return progress?.value?.phase ?? progress?.state ?? null;
}

export function observeLockHolders(directory, lockName, now = Date.now()) {
  let names;
  try { names = readdirSync(directory); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
  const prefix = `${lockName}.`;
  return names.filter(name => name.startsWith(prefix) && name.endsWith(".json"))
    .map(name => readRecord(path.join(directory, name)))
    .filter(record => record !== null && alive(record))
    .map(record => ({
      key: record.key, mode: record.mode, pid: record.pid, unit: record.unit, job: record.job ?? null,
      phase: holderPhase(record.job) ?? record.phase ?? null, heldMs: now - record.acquiredAt,
    }))
    .sort((left, right) => right.heldMs - left.heldMs);
}
