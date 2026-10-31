import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const slot = new URL("./test-slot.mjs", import.meta.url).href;

function holder(env, marks) {
  const body = `import { appendFileSync } from "node:fs"; await import(${JSON.stringify(slot)}); const start = Date.now();
await new Promise(resolve => setTimeout(resolve, 300)); appendFileSync(${JSON.stringify(marks)}, start + " " + Date.now() + "\\n");`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", body], { env, stdio: "ignore" });
    child.on("error", reject);
    child.on("exit", code => code === 0 ? resolve() : reject(new Error(`holder exited ${code}`)));
  });
}

test("concurrent test processes never exceed the host slot count", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "aw-test-slot-"));
  try {
    const marks = path.join(root, "marks");
    const env = { ...process.env, AGENT_WORKSPACE_TEST_SLOTS: "1", AGENT_WORKSPACE_TEST_SLOT_DIR: path.join(root, "slots") };
    delete env.AGENT_WORKSPACE_TEST_SLOT_HELD;
    await Promise.all([holder(env, marks), holder(env, marks), holder(env, marks)]);
    const spans = readFileSync(marks, "utf8").trim().split("\n").map(line => line.split(" ").map(Number)).sort((a, b) => a[0] - b[0]);
    assert.equal(spans.length, 3);
    for (let i = 1; i < spans.length; i++) assert.ok(spans[i][0] >= spans[i - 1][1], `slot holders overlapped: ${JSON.stringify(spans)}`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an invalid slot count is a typed error", async () => {
  const { testSlotCount } = await import("./test-slot.mjs");
  assert.throws(() => testSlotCount({ AGENT_WORKSPACE_TEST_SLOTS: "0" }), error => error.code === "test-slot-config");
  assert.equal(testSlotCount({ AGENT_WORKSPACE_TEST_SLOTS: "3" }), 3);
});

import { workspaceCheckConcurrency } from './check.mjs';
test('normal runner does not queue fixture processes inside their execution deadlines', () => {
  assert.equal(workspaceCheckConcurrency({PI_STACK_CHECK_CONCURRENCY:'4',AGENT_WORKSPACE_TEST_SLOTS:'1'}),1);
  assert.equal(workspaceCheckConcurrency({PI_STACK_CHECK_CONCURRENCY:'2',AGENT_WORKSPACE_TEST_SLOTS:'4'}),2);
});
