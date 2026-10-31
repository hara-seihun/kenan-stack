import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, openSync, closeSync } from "node:fs";
import { testSlotCount } from "./test-slot-policy.mjs";
export { testSlotCount } from "./test-slot-policy.mjs";
import path from "node:path";

// Host-wide cap on concurrently running heavy agent-workspace test processes. Each fixture process spawns dozens of
// `workspace create`, source-job and checkout-job children; 2026-10-29 an ad hoc `xargs -P 16` over the 128 shards,
// overlapping a second run, put ~290 of them on 16 cores (load 104). Whatever launches the tests, a process holds one
// slot for its lifetime: the flock sits on this process's own open descriptor, so it ends exactly when the process does.


function tryLock(file) {
  const descriptor = openSync(file, "a", 0o666);
  const result = spawnSync("flock", ["--exclusive", "--nonblock", "3"], { stdio: ["ignore", "ignore", "pipe", descriptor] });
  if (result.status === 0) return descriptor;
  closeSync(descriptor);
  if (result.status === 1) return null;
  throw Object.assign(new Error(`cannot take agent-workspace test slot ${file}: ${result.error?.message ?? result.stderr}`), { code: "test-slot-lock" });
}

export async function acquireTestSlot(env = process.env, log = text => process.stderr.write(text)) {
  const count = testSlotCount(env);
  const directory = env.AGENT_WORKSPACE_TEST_SLOT_DIR ?? "/var/tmp/agent-workspace-test-slots";
  mkdirSync(directory, { recursive: true });
  try { chmodSync(directory, 0o1777); } catch {}
  const started = Date.now();
  let announced = false;
  for (;;) {
    for (let index = 0; index < count; index++) {
      const descriptor = tryLock(path.join(directory, `slot-${index}`));
      if (descriptor !== null) {
        if (announced) log(`agent-workspace tests: got host test slot ${index + 1}/${count} after ${((Date.now() - started) / 1000).toFixed(1)}s\n`);
        return { index, descriptor };
      }
    }
    if (!announced) log(`agent-workspace tests: all ${count} host test slots are busy; waiting (AGENT_WORKSPACE_TEST_SLOTS sets the host-wide cap)\n`);
    announced = true;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
}

// A test process's own descendants share its slot rather than queueing behind it.
if (process.env.AGENT_WORKSPACE_TEST_SLOT_HELD === undefined) {
  await acquireTestSlot();
  process.env.AGENT_WORKSPACE_TEST_SLOT_HELD = String(process.pid);
}
