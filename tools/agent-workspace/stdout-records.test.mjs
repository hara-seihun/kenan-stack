import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { foldRecords, withStdoutFile } from "./stdout-records.mjs";

const producer = "const rec='x'.repeat(99)+'\\0';const n=400000;for(let i=0;i<n;i+=1000)process.stdout.write(rec.repeat(1000));";

test("a listing larger than the old 16 MiB buffer overflows a buffered read but folds from a file", () => {
  const buffered = spawnSync(process.execPath, ["-e", producer], { maxBuffer: 16 * 1024 * 1024 });
  assert.equal(buffered.error?.code, "ENOBUFS");
  let records = 0;
  let bytes = 0;
  const result = withStdoutFile(descriptor => {
    const launched = spawnSync(process.execPath, ["-e", producer], { stdio: ["ignore", descriptor, "pipe"] });
    foldRecords(descriptor, "\0", record => { records++; bytes += record.length; });
    return launched;
  });
  assert.equal(result.status, 0);
  assert.equal(records, 400000);
  assert.equal(bytes, 400000 * 99);
});

test("records split across chunk boundaries and a final unterminated record are preserved", () => {
  const seen = [];
  withStdoutFile(descriptor => {
    spawnSync(process.execPath, ["-e", "process.stdout.write('a'.repeat(1500000)+'\\n'+'b\\n'+'c')"], { stdio: ["ignore", descriptor, "pipe"] });
    foldRecords(descriptor, "\n", record => seen.push(record.length + record[0]));
  });
  assert.deepEqual(seen, ["1500000a", "1b", "1c"]);
});
