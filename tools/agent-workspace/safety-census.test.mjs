// target: release/reconcile safety census. level: unit + cross-process. intent: incident regression
// (2026-10-21 converge: 54.6 s serial census vs 35 s release deadline; release 81df3049 settled
// blocked on "database is locked" from an idle WAL thread database). size: small.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import * as census from "./safety-census.mjs";

function threadDatabase(root) {
  const file = path.join(root, "threads.sqlite3");
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE thread(id TEXT PRIMARY KEY, cwd TEXT NOT NULL, state TEXT NOT NULL, metadata TEXT NOT NULL DEFAULT '{}');
    CREATE TABLE thread_work(thread_id TEXT NOT NULL, status TEXT NOT NULL);
    CREATE TABLE thread_execution(thread_id TEXT NOT NULL, ended_at INTEGER);
    INSERT INTO thread VALUES ('live', '/home/agent/work/clones/live', 'running', '{}');`);
  db.close();
  return file;
}

// Another process holds the database exclusively, as WAL recovery by a concurrent
// read-only opener does, then lets go.
async function holdExclusively(file, holdMs) {
  const holder = spawn(process.execPath, ["--input-type=module", "-e", `
    import { DatabaseSync } from "node:sqlite";
    const db = new DatabaseSync(${JSON.stringify(file)});
    db.exec("PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE");
    db.prepare("SELECT count(*) FROM thread").get();
    process.stdout.write("held\\n");
    setTimeout(() => { db.exec("COMMIT"); db.close(); }, ${holdMs});`], { stdio: ["ignore", "pipe", "inherit"] });
  await new Promise((resolve, reject) => { holder.stdout.once("data", resolve); holder.once("error", reject); });
  return { exited: new Promise((resolve) => holder.once("exit", resolve)) };
}

test("a briefly locked thread database is waited for within the deadline, not reported as locked", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "census-busy-"));
  try {
    const file = threadDatabase(root);
    const released = await holdExclusively(file, 400);
    const started = Date.now();
    const rows = census.withCensusDeadline(Date.now() + 10_000, () => census.threadSnapshot([file]));
    assert.deepEqual(rows.map((row) => row.id), ["live"]);
    assert.ok(Date.now() - started >= 200, "the read waited for the holder");
    await released.exited;
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the busy wait never outlives the census deadline", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "census-busy-"));
  try {
    const file = threadDatabase(root);
    const released = await holdExclusively(file, 3_000);
    const started = Date.now();
    assert.throws(() => census.withCensusDeadline(Date.now() + 300, () => census.threadSnapshot([file])), /database is locked/);
    assert.ok(Date.now() - started < 2_000);
    await released.exited;
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("parallel censuses union complete results and refuse on any failure or the deadline", () => {
  const root = mkdtempSync(path.join(tmpdir(), "census-parallel-"));
  try {
    const file = threadDatabase(root);
    const observed = census.runCensuses({ threads: { paths: [file] }, gitDependencies: { rows: [] } }, Date.now() + 20_000);
    assert.deepEqual(observed.threads.map((row) => row.id), ["live"]);
    assert.deepEqual(observed.gitDependencies, { alternates: [], linkedWorktrees: [] });
    const corrupt = path.join(root, "corrupt.sqlite3");
    writeFileSync(corrupt, "not a database at all, padded ".repeat(200));
    assert.throws(() => census.runCensuses({ threads: { paths: [corrupt] }, gitDependencies: { rows: [] } }, Date.now() + 20_000),
      /threads census failed|not a database/);
    assert.throws(() => census.runCensuses({ threads: { paths: [file] } }, Date.now() - 1), (error) => error.code === "growth-observation-timeout");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("cached observations are reused only while every file identity is unchanged", () => {
  const root = mkdtempSync(path.join(tmpdir(), "census-cache-"));
  try {
    const installRoot = path.join(root, "srv"), cacheFile = path.join(root, "installed.json");
    mkdirSync(installRoot);
    writeFileSync(path.join(installRoot, "placeholder"), "");
    census.installedReferenceSnapshot([installRoot], { cacheFile });
    const fresh = JSON.parse(readFileSync(cacheFile, "utf8"));
    assert.deepEqual(Object.keys(fresh.entries), [], "files changed within the racy window are never cached");
    writeFileSync(path.join(installRoot, "launcher-a"), "exec /home/kenan/work/clones/first/main\n");
    const first = census.installedReferenceSnapshot([installRoot], { cacheFile, racyWindowNs: -60_000_000_000n });
    assert.deepEqual(first.map((reference) => reference.path), ["/home/kenan/work/clones/first/main"]);
    assert.ok(Object.keys(JSON.parse(readFileSync(cacheFile, "utf8")).entries).length > 0);
    writeFileSync(path.join(installRoot, "launcher-a"), "exec /home/kenan/work/clones/other/main\n");
    const second = census.installedReferenceSnapshot([installRoot], { cacheFile, racyWindowNs: -60_000_000_000n });
    assert.deepEqual(second.map((reference) => reference.path), ["/home/kenan/work/clones/other/main"]);

    const file = threadDatabase(root), threadCache = path.join(root, "threads.json");
    assert.deepEqual(census.threadSnapshot([file], { cacheFile: threadCache, racyWindowNs: -60_000_000_000n }).map((row) => row.id), ["live"]);
    const db = new DatabaseSync(file);
    db.exec("INSERT INTO thread VALUES ('queued', '/home/agent/work/clones/queued', 'idle', '{}'); INSERT INTO thread_work VALUES ('queued', 'queued')");
    db.close();
    assert.deepEqual(census.threadSnapshot([file], { cacheFile: threadCache, racyWindowNs: -60_000_000_000n }).map((row) => row.id).sort(), ["live", "queued"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("installed path extraction matches the reference expression byte for byte", () => {
  const expression = /\/home\/[A-Za-z0-9._@+-]+\/[A-Za-z0-9._\/@+-]+/gu;
  const alphabet = ["/home/", "/", "a", "Z", "9", ".", "_", "@", "+", "-", " ", "\0", "\xff", "=", "home", "//"];
  let seed = 17;
  const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let sample = 0; sample < 3000; sample += 1) {
    let text = "";
    for (let index = 0, length = Math.floor(random() * 40); index < length; index += 1) text += alphabet[Math.floor(random() * alphabet.length)];
    const data = Buffer.from(text, "latin1");
    assert.deepEqual(census.homePathMatches(data), [...data.toString("latin1").matchAll(expression)].map((match) => match[0]), JSON.stringify(text));
  }
});
