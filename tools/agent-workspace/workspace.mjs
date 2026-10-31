#!/usr/bin/env node
import {unlinkDeclaredCacheSymlink, cacheAliasInstalledReferences} from './cache-symlink.mjs';
import {reapEndedOwners,ownerPage} from './owner-reaper.mjs';
import {persistAllocationSample} from './allocation-sample-store.mjs';
import {staleAllocationForecast} from './stale-allocation.mjs';
import {ownerFutureWrites,observeCapacityChildren,capacityOwnerProjection} from './capacity-owner-forecast.mjs';
import {admitWithRefresh} from './admission-refresh.mjs';
import {nativeTerminalRootPaths,rootTerminalSafety} from './root-terminal-growth.mjs';
import {assertIdleGrowth,assertIdleObservation} from './idle-growth.mjs';
import {withContentObservation,pruneInodeContent} from './inode-content.mjs';
import {allocationSlice} from './incremental-allocation.mjs';
import {prepareFrozenObjectCustody} from './frozen-object-custody.mjs';
import {sourceHandoff,SourceHandoffError} from './source-handoff.mjs';
import {literalSparseSelection} from './sparse-literal.mjs';
import {ensureGrowthPolicyStore,projectGrowthPolicy,recordGrowthSample,restoreGrowthPolicy} from "./growth-policy-store.mjs";
import {frozenCustody, assertUnfrozenCustody} from "./frozen-custody.mjs";
import {writerRequest, assertWriterBinding, runWriter} from './writer-custody.mjs';
import {executionCommand, executionRows, executionCessation} from './execution-capacity.mjs';
import {historyImportBytes, commandFailureDetail} from './import-sizing.mjs';
import {withStdoutFile, foldRecords} from './stdout-records.mjs';
import {hasUncoveredCommits, observedRemoteHeads, publishedTreesCover} from './release-reachability.mjs';
import {classifyLocalMerges,disposedMergesCoverRelease,recordMergeDisposal} from './local-merge-disposal.mjs';
import {assertNoAmplifyingCleanupImport} from './cleanup-custody-budget.mjs';
import {workingTreeChanges as listWorkingTreeChanges, ignoredOutput, withIgnoredOutput, archiveWorkingTree, WORKING_TREE_ARCHIVE_MAX_BYTES} from './working-tree-archive.mjs';
import {MaintenanceJournal, MaintenanceError, priorDisposition, digest as maintenanceDigest} from './maintenance-journal.mjs';
import {boundedCommand} from './bounded-command.mjs';
import {selectedArguments,selectorSyntax,futureGrowthAction} from './cli-contract.mjs';
import {cacheStagingRoots} from './cache-retirement.mjs';
import {referenceSummaries} from './generated-retirement.mjs';
import { recentImportBase } from "./import-ancestors.mjs";
import { refPinPath, pinnedSourceCommit, clearRefPin } from "./ref-pin.mjs";
import { movedToColdStorage } from "./cold-storage.mjs";
import { shareMirrorPacks, configuredLocalSources, removeStaleTemporaryPacks } from "./mirror-pack-sharing.mjs";
import { checkoutsUnder, classifyMirrors, coldBorrowedObjectDirectories, removeMirror, removeParkedMirrors } from "./mirror-retirement.mjs";
import { observeLockHolders, recordLockHolder } from "./lock-holders.mjs";
import {awaitSubmittedRelease,RELEASE_AWAIT_MS} from './release-await.mjs';
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  fsyncSync,
  accessSync,
  constants,
  closeSync,
  existsSync,
  openSync,
  opendirSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  statfsSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import * as census from "./safety-census.mjs";
import { CensusFailure, withCensusDeadline, processAncestry, readLink, within } from "./safety-census.mjs";
import { pathToFileURL } from "node:url";
import { runSourceJob, readSourceJobRequest, writeSourceJobProgress, finishSourceJob, sourceJobId, abandonSourceJob } from "./source-job.mjs";
import { capacityRecovery } from "./capacity-recovery.mjs";
import { retireWorkspaceCache, validateCacheRequest, CacheRetirementError, cacheRetirementStatus } from "./cache-retirement.mjs";
import { procScope, currentStackQueueReferences } from "./cache-queue.mjs";
import { qualificationReferences } from "./qualification-references.mjs";
import { NATIVE_CUSTODIAN_ID, OWNER_AGENT_ID, observeOwnerLiveness, classifyOwner, pendingWakeReferences, parentCustody } from "./owner-liveness.mjs";
import { nativeCaller, bindNativeOwner, reassignNativeOwner, nativeOwnerBinding, canonicalNativeOwner, admissionReceipts, authenticateToolCalls, receiptBinding, ensureNativeOwnerTable } from "./native-owner.mjs";
import {adoptEndedActions} from "./actions-adoption.mjs";
import {submitRelease} from './release-submission.mjs';
import {releaseBudgetMs} from './release-budget.mjs';
import {authorizeWorkspaceRelease} from "./release-authority.mjs";
import { retireSourceMaterialization, validateMaterializationRequest, MaterializationError } from "./source-materialization.mjs";
import { jobObserveCommand, observeWorkspaceJob } from "./job-observation.mjs";
import { GrowthLifecycleError, digest, growthError, retainedGrowth, validateRetirement, validateReduction, validateRetainedHeadroom } from "./growth-lifecycle.mjs";

import {readPermit,authenticatedAbandonCaller,validateAbandonPermit,sourceJobCgroupSnapshot,sha,refuse} from './source-job-abandon.mjs';

class SourcePreparationRequired extends Error {}
let sourcePreparationMode = null;
let sourcePreparationDeadline = Infinity;
let sourceJobDirectory = null;

const DEFAULT_STATE = process.env.PI_WORKSPACE_STATE ?? path.join(
  process.env.XDG_STATE_HOME ?? path.join(homedir(), ".local", "state"),
  "pi-workspaces",
  "registry.sqlite3",
);
const DEFAULT_CACHE_PATHS = [
  "node_modules",
  "**/node_modules",
  "dist",
  "**/dist",
  ".nx",
  ".react-router",
  "**/.react-router",
  ".converge-cache",
  "build",
  "**/build",
  ".gradle",
  "**/.gradle",
  "**/__pycache__",
  "**/.pytest_cache",
  "**/.mypy_cache",
  "**/.ruff_cache",
  ".lake",
  "**/.lake",
  // Cargo's build directory. Without it every Rust checkout fails release with "unclassified
  // ignored output" the first time anyone builds in it, which is every time. `stripCaches`
  // refuses to remove anything holding tracked files, so a repository that really does track a
  // directory called `target` is unaffected.
  "target",
  "**/target",
];
const DEFAULT_LEASE_SECONDS = 6 * 60 * 60;
const DEFAULT_MAX_COUNT = 0;
const DEFAULT_MIN_FREE_GIB = 30;
const DEFAULT_MIN_FREE_INODES_PERCENT = 10;
const DEFAULT_CREATION_TIMEOUT_SECONDS = 300;
const ORIGIN_FETCH_REFSPEC = "+refs/heads/*:refs/remotes/origin/*";

function creationTimeout(args) {
  const seconds = numberFlag(args, "creation-timeout-seconds", DEFAULT_CREATION_TIMEOUT_SECONDS);
  if (seconds < 1 || seconds > 86400) fail("--creation-timeout-seconds must be between 1 and 86400");
  return seconds * 1000;
}

// How long one create call keeps repeating itself while its source or checkout job runs.
// PI_WORKSPACE_CREATE_WAIT_SECONDS=0 restores the single-attempt behaviour (tests use it).
function createWaitMs() {
  const value = process.env.PI_WORKSPACE_CREATE_WAIT_SECONDS ?? "150";
  const seconds = Number(value);
  if (!/^\d+$/u.test(value) || seconds > 3600) fail("PI_WORKSPACE_CREATE_WAIT_SECONDS must be an integer from 0 to 3600");
  return seconds * 1000;
}

// The result file a pending create receipt is waiting on, or null when the receipt is not a pending job.
function pendingJobResult(stdout) {
  let receipt;
  try { receipt = JSON.parse(stdout); } catch { return null; }
  if (receipt?.state === "preparing" && typeof receipt.resultPath === "string") return receipt.resultPath;
  if (receipt?.state === "creating" && typeof receipt.progressPath === "string") return path.join(path.dirname(receipt.progressPath), "result.json");
  return null;
}

class CliError extends Error {}
class ResourceBusyError extends CliError {}
class RegistrationMismatchError extends CliError {
  constructor(field, requested, recorded) {
    super(`registration metadata mismatch for ${field}: requested ${requested}, recorded ${recorded}; use reassign for an authorized owner/source handoff`);
    this.code = "registration-metadata-mismatch";
    this.field = field;
    this.requested = requested;
    this.recorded = recorded;
  }
}

let maintenanceContext;
function maintenanceEffect(kind, input, execute) {
  if (!maintenanceContext) return execute();
  return maintenanceContext.journal.effect({kind, workspace: maintenanceContext.record, input}, execute);
}
let inspectionDeadline;
let creationDeadline;
function duringInspection(deadline, inspect) {
  const previous = inspectionDeadline;
  inspectionDeadline = deadline;
  try { return inspect(); } finally { inspectionDeadline = previous; }
}

function fail(message) {
  throw new CliError(message);
}
// An observation deadline ended before any safety verdict, so nothing was changed. Typed,
// so a --json release reports it on stdout and its background worker records a known,
// continuable refusal instead of an unreconcilable submission.
function inspectionTimeout(message) {
  throw Object.assign(new CliError(message), {code: "inspection-timeout"});
}

function parseArgs(argv) {
  const positional = [];
  const named = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("--")) {
      positional.push(value);
      continue;
    }
    const equals = value.indexOf("=");
    const name = equals === -1 ? value.slice(2) : value.slice(2, equals);
    let argument;
    if (equals !== -1) argument = value.slice(equals + 1);
    else if (argv[index + 1] !== undefined && !argv[index + 1].startsWith("--")) {
      argument = argv[index + 1];
      index += 1;
    } else argument = "true";
    const values = named.get(name) ?? [];
    values.push(argument);
    named.set(name, values);
  }
  return { positional, named };
}

function one(args, name, fallback) {
  const values = args.named.get(name);
  if (values === undefined) return fallback;
  if (values.length !== 1) fail(`--${name} may be supplied only once`);
  return values[0];
}

function required(args, name) {
  const value = one(args, name);
  if (value === undefined || value.length === 0 || value === "true") fail(`--${name} is required`);
  return value;
}

function many(args, name) {
  return args.named.get(name) ?? [];
}

function bool(args, name) {
  const value = one(args, name, "false");
  if (value === "true") return true;
  if (value === "false") return false;
  fail(`--${name} must be true or false`);
}

function numberFlag(args, name, fallback) {
  const raw = one(args, name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) fail(`--${name} must be a non-negative number`);
  return value;
}

function assertOnly(args, names) {
  const accepted = new Set(names);
  for (const name of args.named.keys()) if (!accepted.has(name)) fail(`unknown flag --${name}`);
}

function currentDirectory() {
  try {
    return process.cwd();
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return undefined;
  }
}

function command(executable, commandArgs, options = {}) {
  const remaining = Math.min(maintenanceContext?.journal.deadline ?? Infinity, inspectionDeadline ?? Infinity, creationDeadline ?? Infinity, sourcePreparationDeadline) - Date.now() - (maintenanceContext ? 250 : 0);
  if (sourcePreparationMode === "foreground" && remaining <= 0) throw new SourcePreparationRequired();
  if (remaining <= 0 && creationDeadline === undefined) inspectionTimeout("workspace inspection budget exhausted; no safety verdict was established");
  if (remaining <= 0) fail("creation budget exhausted; checkout retained; repeat the same create command to resume");
  const launch = stdout => spawnSync(executable, commandArgs, {
    // Git operands are resolved before launch; a released caller directory may vanish mid-command.
    cwd: options.cwd ?? homedir(),
    encoding: "utf8",
    input: options.input,
    stdio: ["pipe", stdout ?? "pipe", "pipe", ...heldResourceLocks.values()],
    env: { ...process.env, ...options.env, GIT_TERMINAL_PROMPT: "0" },
    maxBuffer: 16 * 1024 * 1024,
    timeout: Math.max(1, Math.min(options.timeout ?? 30_000, maintenanceContext ? 2000 : Infinity, remaining)),
    ...(inspectionDeadline === undefined ? {} : { killSignal: "SIGKILL" }),
  });
  let result;
  if (options.records === undefined) result = launch(undefined);
  else {
    const { separator, onRecord } = options.records;
    result = withStdoutFile(descriptor => {
      const launched = launch(descriptor);
      if (launched.status === 0 && !launched.error) foldRecords(descriptor, separator, onRecord);
      return launched;
    });
  }
  if (sourcePreparationMode === "foreground" && result.error?.code === "ETIMEDOUT") throw new SourcePreparationRequired();
  if (inspectionDeadline !== undefined && result.error?.code === "ETIMEDOUT") {
    inspectionTimeout(`workspace inspection timed out: ${executable} ${commandArgs.join(" ")}; no safety verdict was established`);
  }
  if (creationDeadline !== undefined && result.error?.code === "ETIMEDOUT") {
    fail("creation command timed out; repeat the same create command to retry, optionally increasing --creation-timeout-seconds (maximum 86400)");
  }
  return {
    status: result.status ?? 1,
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? "").trim(),
    error: result.error,
    signal: result.signal,
  };
}

function run(executable, commandArgs, options = {}) {
  if (maintenanceContext && !options.maintenanceDispatched && executable === 'git') {
    const args=commandArgs.filter((_,i)=>!((commandArgs[i-1]==='-C')||(commandArgs[i-1]==='--git-dir'))).filter(x=>!['-C','--git-dir'].includes(x));
    const readOnly=['rev-parse','for-each-ref','reflog','show-ref'].includes(args[0]) || (args[0]==='config' && args.some(x=>['--list','--get','--get-all'].includes(x)));
    if (!readOnly) return maintenanceEffect('git', {args:commandArgs}, ()=>run(executable,commandArgs,{...options,maintenanceDispatched:true}));
  }
  const result = command(executable, commandArgs, options);
  if (result.status !== 0) {
    const detail = commandFailureDetail(result);
    fail(`${executable} ${commandArgs.join(" ")} failed: ${detail}`);
  }
  return result.stdout;
}

function streamRecords(executable, commandArgs, separator, onRecord, options = {}) {
  run(executable, commandArgs, { ...options, records: { separator, onRecord } });
}

function git(workspace, args, options = {}) {
  return run("git", ["-C", workspace, ...args], options);
}

const registryPaths = new WeakMap();

const REGISTRY_SCHEMA_VERSION = 2;

function hasPendingIndex(database) {
  return database.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='workspace_pending'").get() !== undefined;
}

function registrySchemaVersion(database) {
  const version = database.prepare("PRAGMA user_version").get().user_version;
  if (version > REGISTRY_SCHEMA_VERSION) fail(`workspace registry schema ${version} needs a newer agent-workspace`);
  return version;
}

function hasCapacityLedger(database) {
  return database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='workspace_capacity'").get() !== undefined;
}

function hasCapacityMeasurements(database) {
  return database.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type='table' AND name IN ('workspace_capacity_measurement','workspace_capacity_repricing')").get().count === 2;
}

function hasReassignmentLedger(database) {
  return database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='workspace_reassignment'").get() !== undefined;
}

const ASSIGNMENT_SOURCE = `(SELECT new_source_commit FROM workspace_reassignment
  WHERE workspace_id = workspace.id ORDER BY sequence DESC LIMIT 1) AS assignment_source_commit`;

function initializeRegistry(database) {
  database.exec(`CREATE TABLE IF NOT EXISTS workspace_reassignment (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id TEXT NOT NULL, path TEXT NOT NULL,
    old_owner TEXT NOT NULL, old_source_commit TEXT,
    new_owner TEXT NOT NULL, new_source_commit TEXT NOT NULL,
    authorization TEXT NOT NULL, occurred_at INTEGER NOT NULL
  ); CREATE INDEX IF NOT EXISTS workspace_reassignment_record ON workspace_reassignment(workspace_id, sequence)`);
  database.exec(`CREATE TABLE IF NOT EXISTS workspace_source_capacity (
    destination TEXT PRIMARY KEY, device_id TEXT NOT NULL, plan_json TEXT NOT NULL, receipt TEXT NOT NULL
  )`);
  database.exec(`CREATE TABLE IF NOT EXISTS workspace_capacity (
    workspace_id TEXT PRIMARY KEY, device_id TEXT NOT NULL, plan_json TEXT NOT NULL
  ); CREATE INDEX IF NOT EXISTS workspace_capacity_device ON workspace_capacity(device_id)`);
  database.exec(`CREATE TABLE IF NOT EXISTS workspace_capacity_measurement (
    workspace_id TEXT PRIMARY KEY, measurement_json TEXT NOT NULL
  ); CREATE TABLE IF NOT EXISTS workspace_capacity_repricing (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id TEXT NOT NULL, occurred_at INTEGER NOT NULL,
    old_plan_json TEXT NOT NULL, new_plan_json TEXT NOT NULL, measurement_json TEXT NOT NULL
  )`);
  ensureGrowthPolicyStore(database);
  if (database.prepare("PRAGMA journal_mode").get().journal_mode !== "wal") {
    database.exec("PRAGMA journal_mode = WAL");
  }
  if (registrySchemaVersion(database) === REGISTRY_SCHEMA_VERSION) {
    database.exec("CREATE INDEX IF NOT EXISTS workspace_pending ON workspace(root, path) WHERE state='creating'");
    return;
  }
  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec(`
      CREATE TABLE IF NOT EXISTS workspace (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL UNIQUE,
        root TEXT NOT NULL,
        kind TEXT NOT NULL,
        mode TEXT NOT NULL CHECK (mode IN ('writer', 'review')),
        owner TEXT NOT NULL,
        repository TEXT,
        source_commit TEXT,
        checkout_type TEXT NOT NULL CHECK (checkout_type IN ('clone', 'worktree')),
        cache_paths TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        lease_expires_at INTEGER NOT NULL,
        state TEXT NOT NULL,
        detail TEXT NOT NULL,
        group_id TEXT,
        creation_request TEXT
      );
      CREATE INDEX IF NOT EXISTS workspace_root ON workspace(root);
      CREATE INDEX IF NOT EXISTS workspace_lease ON workspace(lease_expires_at);
    `);
    const columns = database.prepare("PRAGMA table_info(workspace)").all();
    if (!columns.some((column) => column.name === "group_id")) {
      database.exec("ALTER TABLE workspace ADD COLUMN group_id TEXT");
    }
    if (!columns.some((column) => column.name === "creation_request")) {
      database.exec("ALTER TABLE workspace ADD COLUMN creation_request TEXT");
    }
    database.exec(`CREATE INDEX IF NOT EXISTS workspace_group ON workspace(group_id);
      CREATE INDEX IF NOT EXISTS workspace_pending ON workspace(root, path) WHERE state='creating';
      PRAGMA user_version = ${REGISTRY_SCHEMA_VERSION}; COMMIT`);
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

// How long one registry statement waits for another process's write lock. Under host saturation a
// writer can hold it for seconds; one second turned ordinary releases into 'database is locked'.
const REGISTRY_BUSY_MS = 15000;
function openRegistry(statePath = DEFAULT_STATE, deadline) {
  mkdirSync(path.dirname(statePath), { recursive: true, mode: 0o700 });
  const database = new DatabaseSync(statePath);
  registryPaths.set(database, statePath);
  try {
    database.exec(`PRAGMA busy_timeout = ${deadline===undefined?REGISTRY_BUSY_MS:Math.max(0,Math.min(REGISTRY_BUSY_MS,deadline-Date.now()))}`);
    if (registrySchemaVersion(database) !== REGISTRY_SCHEMA_VERSION || !hasPendingIndex(database) || !hasCapacityLedger(database) || !hasCapacityMeasurements(database) || !hasReassignmentLedger(database) || !database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='workspace_growth_policy'").get() ||
      database.prepare("PRAGMA journal_mode").get().journal_mode !== "wal") {
      withResourceLock(statePath, "registry-schema", () => initializeRegistry(database),deadline);
    }
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

function rowToRecord(row) {
  return {
    id: row.id,
    path: row.path,
    root: row.root,
    kind: row.kind,
    mode: row.mode,
    owner: row.owner,
    repository: row.repository,
    sourceCommit: row.assignment_source_commit ?? row.source_commit,
    durableSourceCommit: row.source_commit,
    checkoutType: row.checkout_type,
    cachePaths: JSON.parse(row.cache_paths),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    leaseExpiresAt: row.lease_expires_at,
    state: row.state,
    detail: row.detail,
    groupId: row.group_id ?? null,
    ...(row.state === "creating" ? { creation: JSON.parse(row.creation_request) } : {}),
  };
}

function recordBy(database, selector) {
  const row = selector.id !== undefined
    ? database.prepare(`SELECT workspace.*, ${ASSIGNMENT_SOURCE} FROM workspace WHERE id = ?`).get(selector.id)
    : database.prepare(`SELECT workspace.*, ${ASSIGNMENT_SOURCE} FROM workspace WHERE path = ?`).get(path.resolve(selector.path));
  if (row === undefined) fail(`workspace not registered: ${selector.id ?? selector.path}`);
  return rowToRecord(row);
}

function listRecords(database, root) {
  const rows = root === undefined
    ? database.prepare(`SELECT workspace.*, ${ASSIGNMENT_SOURCE} FROM workspace ORDER BY root, path`).all()
    : database.prepare(`SELECT workspace.*, ${ASSIGNMENT_SOURCE} FROM workspace WHERE root = ? ORDER BY path`).all(path.resolve(root));
  return rows.map(rowToRecord);
}

function gitInfo(workspacePath) {
  const resolved = path.resolve(workspacePath);
  if (!existsSync(resolved)) fail(`workspace does not exist: ${resolved}`);
  if (git(resolved, ["rev-parse", "--is-inside-work-tree"]) !== "true") fail(`not a Git checkout: ${resolved}`);
  const top = path.resolve(git(resolved, ["rev-parse", "--show-toplevel"]));
  if (top !== resolved) fail(`workspace must be the Git root: ${resolved}`);
  const gitDirectory = path.resolve(git(resolved, ["rev-parse", "--absolute-git-dir"]));
  const rawCommon = git(resolved, ["rev-parse", "--git-common-dir"]);
  const commonDirectory = path.resolve(resolved, rawCommon);
  const repositoryResult = command("git", ["-C", resolved, "remote", "get-url", "origin"]);
  return {
    checkoutType: gitDirectory === commonDirectory ? "clone" : "worktree",
    repository: repositoryResult.status === 0 ? repositoryResult.stdout : null,
    head: git(resolved, ["rev-parse", "HEAD"]),
  };
}

function normalizeCachePath(value) {
  if (path.isAbsolute(value) || value.split(path.sep).includes("..")) fail(`cache path must be relative: ${value}`);
  const normalized = value.replace(/^\.\//, "").replace(/\/$/, "");
  if (!normalized || /[?\[\]]/u.test(normalized) || (normalized.includes("*") && !/^\*\*\/[^*]+$/u.test(normalized))) {
    fail(`cache path supports only an exact path or **/directory: ${value}`);
  }
  return normalized;
}

function normalizeCachePaths(values) {
  const selected = [
    ...DEFAULT_CACHE_PATHS,
    ...values.flatMap((value) => value.split(",")),
  ];
  return [...new Set(selected.map((value) => value.trim()).filter(Boolean).map(normalizeCachePath))];
}

function repositoryOwnedCachePaths(repository, values) {
  const specifications = values.map((value) => {
    const separator = value.indexOf("=");
    if (separator < 1 || separator === value.length - 1) fail(`cache owner must be OUTPUT=TRACKED_SOURCE: ${value}`);
    const output = normalizeCachePath(value.slice(0, separator).trim());
    const source = normalizeCachePath(value.slice(separator + 1).trim());
    if (source.includes("*")) fail(`cache owner source must be an exact path: ${source}`);
    return { output, source, probes: [output, `${output}/.agent-workspace-cache-probe`] };
  });
  if (specifications.length === 0) return [];
  const sources = [...new Set(specifications.map(({ source }) => source))];
  const tracked = new Set();
  streamRecords("git", ["-C", repository, "ls-files", "-z", "--", ...sources], "\0", name => { if (name) tracked.add(name); });
  const probes = [...new Set(specifications.flatMap(({ output, probes: candidates, source }) =>
    tracked.has(source) && !output.startsWith("**/") ? candidates : []))];
  const ignored = probes.length === 0 ? new Set() : new Set(command("git", [
    "-C", repository, "check-ignore", "--no-index", "-z", "--stdin",
  ], { input: `${probes.join("\0")}\0` }).stdout.split("\0").filter(Boolean));
  return specifications
    .filter(({ output, source, probes: candidates }) => tracked.has(source)
      && (output.startsWith("**/") || candidates.some((candidate) => ignored.has(candidate))))
    .map(({ output }) => output);
}

function cachePathsForRepository(repository, args) {
  return normalizeCachePaths([
    ...many(args, "cache"),
    ...repositoryOwnedCachePaths(repository, many(args, "cache-owned")),
  ]);
}

const REFERENCE_CLONE_CONFIG = {
  "core.commitGraph": "false",
  "gc.writeCommitGraph": "false",
  "fetch.writeCommitGraph": "false",
  "gc.auto": "0",
  "maintenance.auto": "false",
};
const REFERENCE_GC_WARNINGS = new Set([
  "warning: attempting to write a commit-graph, but 'core.commitGraph' is disabled",
  "warning: There are too many unreachable loose objects; run 'git prune' to remove them.",
]);

function maintainReferenceClone(workspace, execute, statePath) {
  const gitDirectory = path.join(workspace, ".git");
  const alternates = path.join(gitDirectory, "objects", "info", "alternates");
  if (!existsSync(alternates) || !readFileSync(alternates, "utf8").trim()) return null;
  const configuration = git(workspace, ["config", "--local", "--null", "--list"]);
  const values = new Map(configuration.split("\0").filter(Boolean).map((entry) => {
    const separator = entry.indexOf("\n");
    return [entry.slice(0, separator), entry.slice(separator + 1)];
  }));
  const settings = Object.entries(REFERENCE_CLONE_CONFIG)
    .filter(([name, value]) => values.get(name.toLowerCase()) !== value);
  if (execute) for (const [name, value] of settings) git(workspace, ["config", "--local", "--replace-all", name, value]);
  const log = path.join(gitDirectory, "gc.log");
  let gcLog = "absent";
  if (existsSync(log)) {
    const contents = readFileSync(log, "utf8").trim();
    if (!contents || !contents.split(/\r?\n/u).every((line) => REFERENCE_GC_WARNINGS.has(line))) {
      fail(`unrecognized Git maintenance failure retained at ${log}; inspect it before repair`);
    }
    if (existsSync(path.join(gitDirectory, "gc.pid"))) {
      fail(`Git maintenance still owns ${gitDirectory}/gc.pid; retry after it finishes`);
    }
    gcLog = execute ? "removed-diagnosed-warning" : "would-remove-diagnosed-warning";
    if (execute) maintenanceEffect('gc-warning-removal', {file:log,sha256:createHash('sha256').update(readFileSync(log)).digest('hex')},()=>{if(existsSync(path.join(gitDirectory,'gc.pid'))||readFileSync(log,'utf8').trim()!==contents)throw new MaintenanceError('maintenance-warning-preimage-changed');rmSync(log);return null;});
  }
  const objectCustody = stabilizeObjectCustody(workspace, alternates, execute, statePath);
  return { path: workspace, settings: settings.map(([name]) => name), gcLog, objectCustody };
}

function register(database, input) {
  return withWorkspaceLock(database, input.path, () => {
    const existing = database.prepare("SELECT * FROM workspace WHERE path=?").get(input.path);
    if (!input.retained && existing !== undefined && recordRetainsCustody(database,existing.id)) growthError("growth-admission-required","retained custody cannot register/adopt until fresh resume-growth admission");
    const accounted = existing?.state !== "released" && existing !== undefined && recordedCapacity(database, existing.id) !== null;
    if (input.adoptAccounted && !accounted) growthError("adoption-capacity-missing", "--adopt-accounted requires an existing unreleased capacity reservation");
    const pricingRequested = ["intent","headroom-gib","growth-mib","min-free-gib"].some(flag => one(input.capacityArgs,flag) !== undefined);
    if (pricingRequested && (input.retained || input.mode !== "writer" || accounted)) growthError("registration-pricing-conflict", "preservation/review registration grants no growth; use reprice-capacity for an existing reservation");
    if (input.retained || input.mode !== "writer" || accounted) {
      database.exec("BEGIN IMMEDIATE");
      try { const result=registerWorkspace(database,input); database.exec("COMMIT"); return result; }
      catch(e) { database.exec("ROLLBACK"); throw e; }
    }
    // External source already occupies physical disk. Price its FUTURE writes,
    // not another construction/import, through create's device admission fence.
    // Admission precedes registrationInspection, which may mutate Git custody.
    const root = path.resolve(input.root ?? path.dirname(input.path));
    const info = gitInfo(input.path);
    const intent = capacityIntent(input.capacityArgs);
    const plan = intent === null
      ? { intent:"unestimated", estimate:"unknown", constructionBytes:Math.ceil(numberFlag(input.capacityArgs,"min-free-gib",DEFAULT_MIN_FREE_GIB)*1024**3), growthBytes:0, headroomBytes:0 }
      : { ...intent, estimate:"whole-tree-upper-bound", constructionBytes:0, sourceImportBytes:0, sourceCommit:info.head };
    const device = String(statSync(input.path).dev);
    if (String(statSync(root).dev) !== device) fail("registration root and checkout must share a filesystem");
    return withCapacityAdmission(database, registryPaths.get(database), device, () => {
      plan.admission = assertCapacity(root,input.capacityArgs,database,input.path,plan);
      const measurement = workspaceAllocationSample(input.path,device,{deadline:Date.now()+10_000,maxEntries:1_000_000});
      if (!measurement.ok) growthError("registration-allocation-unavailable",measurement.error);
      // An absent baseline could make later samples spend future growth on
      // already-existing files. Unknown allocation therefore admits no writer.
      plan.completedAllocationBytes = measurement.allocatedBytes;
      measurement.planSha256 = createHash("sha256").update(JSON.stringify(plan)).digest("hex");
      measurement.rootPath = input.path;
      const inspected = registrationInspection(input.path,registryPaths.get(database));
      if (inspected.head !== info.head) growthError("registration-source-changed","checkout changed during registration admission");
      database.exec("BEGIN IMMEDIATE");
      try {
        const record = registerWorkspace(database,input,inspected);
        database.prepare("INSERT INTO workspace_capacity(workspace_id,device_id,plan_json) VALUES(?,?,?)").run(record.id,device,JSON.stringify(plan));
        database.prepare("INSERT OR REPLACE INTO workspace_capacity_measurement(workspace_id,measurement_json) VALUES(?,?)").run(record.id,JSON.stringify(measurement));
        database.exec("COMMIT");
        return record;
      } catch(e) { database.exec("ROLLBACK"); throw e; }
    });
  }, input.groupId);
}

function registrationInspection(workspace, statePath) {
  const info = gitInfo(workspace);
  maintainReferenceClone(workspace, true, statePath);
  return info;
}

function registerWorkspace(database, input, inspectedInfo) {
  const now = Date.now();
  const existing = database.prepare(`SELECT workspace.*, ${ASSIGNMENT_SOURCE} FROM workspace WHERE path = ?`).get(path.resolve(input.path));
  if (!input.retained && existing !== undefined && recordRetainsCustody(database, existing.id)) growthError("growth-admission-required", "retained custody cannot register/adopt until fresh resume-growth admission");
  if (existing !== undefined && existing.state !== "released") {
    const recorded = rowToRecord(existing);
    for (const [field, requested] of Object.entries(input.assertMetadata ?? {})) {
      if (recorded[field] !== requested) throw new RegistrationMismatchError(field, requested, recorded[field]);
    }
  }
  if (existing?.state === "creating") return rowToRecord(existing);
  if (!input.retained && retainedParent(database,input.path)) growthError("growth-admission-required", "shared Git parent growth is retired");
  const info = inspectedInfo ?? (input.retained ? gitInfo(input.path) : registrationInspection(input.path, registryPaths.get(database)));
  if (input.retained && existing !== undefined) growthError("retained-registration-existing", "use end-writing with a fresh exact binding for existing rows");
  if (existing !== undefined && existing.state !== "released") {
    if (input.groupId != null && existing.group_id !== null && existing.group_id !== input.groupId) {
      fail(`workspace ${path.resolve(input.path)} already belongs to group ${existing.group_id}; requested ${input.groupId}`);
    }
    const cachePaths = input.replaceCachePaths
      ? input.cachePaths
      : [...new Set([...JSON.parse(existing.cache_paths), ...input.cachePaths])];
    const groupId = input.groupId ?? existing.group_id;
    database.prepare("UPDATE workspace SET checkout_type = ?, cache_paths = ?, group_id = ?, updated_at = ? WHERE id = ?")
      .run(info.checkoutType, JSON.stringify(cachePaths), groupId, now, existing.id);
    return recordBy(database, { id: existing.id });
  }
  if (existing !== undefined) database.prepare("DELETE FROM workspace WHERE id = ?").run(existing.id);
  const record = {
    id: randomUUID(),
    path: path.resolve(input.path),
    root: path.resolve(input.root ?? path.dirname(input.path)),
    kind: input.kind,
    mode: input.mode,
    owner: input.owner,
    repository: info.repository,
    sourceCommit: input.sourceCommit ?? null,
    durableSourceCommit: input.sourceCommit ?? null,
    checkoutType: info.checkoutType,
    cachePaths: input.cachePaths,
    createdAt: now,
    updatedAt: now,
    leaseExpiresAt: input.retained ? 0 : input.leaseExpiresAt ?? now + input.leaseSeconds * 1000,
    state: input.retained ? "referenced" : "active",
    detail: input.retained ? "preservation-only retained custody" : "lease registered",
    groupId: input.groupId ?? null,
  };
  database.prepare(`
    INSERT INTO workspace (
      id, path, root, kind, mode, owner, repository, source_commit,
      checkout_type, cache_paths, created_at, updated_at,
      lease_expires_at, state, detail, group_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    record.id, record.path, record.root, record.kind, record.mode, record.owner,
    record.repository, record.sourceCommit, record.checkoutType,
    JSON.stringify(record.cachePaths), record.createdAt, record.updatedAt,
    record.leaseExpiresAt, record.state, record.detail, record.groupId,
  );
  if (input.retained) markSourceRetained(database, record.id);
  if (input.nativeCaller) bindNativeOwner(database, record.id, input.nativeCaller, "caller-scope", { command: "register" });
  return record;
}

function selectorFrom(args, command) {
  const selected=selectedArguments(command,{id:one(args,'id'),path:one(args,'path')});
  if(!selected.ok)throw Object.assign(new GrowthLifecycleError(selected.error.code,selected.error.detail),{nextAction:selected.error.nextAction});
  return selected.value;
}

function updateState(database, record, state, detail) {
  const now = Date.now();
  database.prepare("UPDATE workspace SET state = ?, detail = ?, updated_at = ? WHERE id = ?")
    .run(state, detail, now, record.id);
  return { ...record, state, detail, updatedAt: now };
}

// Safety observations live in safety-census.mjs so release can run them in parallel
// worker threads; these bind them to the current inspection deadline.
function censusBound(action) {
  try { return withCensusDeadline(inspectionDeadline, action); }
  catch (error) { if (error instanceof CensusFailure && /timed out|budget exhausted/.test(error.message)) inspectionTimeout(error.message); if (error instanceof CensusFailure) fail(error.message); throw error; }
}
function assertSafetyBudget(phase) { return censusBound(() => census.assertSafetyBudget(phase)); }
function processSnapshot(...args) { return censusBound(() => census.processSnapshot(...args)); }
function dockerSnapshot(execute, options) { return censusBound(() => census.dockerSnapshot(execute, options)); }
function systemdManagerSnapshot(manager, execute) { return censusBound(() => census.systemdManagerSnapshot(manager, execute)); }
function systemdSnapshot() { return censusBound(() => census.systemdSnapshot()); }
function installedReferenceSnapshot(roots, options) { return censusBound(() => census.installedReferenceSnapshot(roots, options)); }
function threadSnapshot(paths, options) { return censusBound(() => census.threadSnapshot(paths, options)); }

// Stream only topology; cache/creation JSON is large and irrelevant here. The
// statement is drained before any observation so no read transaction outlives it.
function workspaceTopology(database) {
  const rows = [];
  for (const row of database.prepare("SELECT id,path,checkout_type AS checkoutType FROM workspace ORDER BY path,id").iterate())
    rows.push({ id: row.id, path: row.path, checkoutType: row.checkoutType });
  return rows;
}
function gitDependencySnapshot(database) {
  const rows = workspaceTopology(database);
  return censusBound(() => census.gitDependencyCensus(rows, undefined, { cacheFile: observationCache(database, "cold-git-dependencies.v1.json") }));
}

// Observation caches beside the registry; each entry is reused only after its
// file identities are revalidated (see safety-census.mjs).
function observationCache(database, name) {
  const statePath = typeof database.location === "function" ? database.location() : null;
  return statePath === null ? undefined : path.join(path.dirname(statePath), name);
}

function safetySnapshot(database) {
  const isolated = process.env.NODE_TEST_CONTEXT !== undefined &&
    process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY === "empty";
  const threadsObserved = !isolated || Boolean(process.env.PI_THREAD_DATABASE);
  const tasks = {
    gitDependencies: { rows: workspaceTopology(database), cacheFile: observationCache(database, "cold-git-dependencies.v1.json") },
    ...(threadsObserved ? { threads: { paths: census.ownerThreadDatabases(), cacheFile: observationCache(database, "thread-references.v1.json") } } : {}),
    ...(isolated ? {} : {
      process: {}, docker: {}, systemdUser: {}, systemdSystem: {},
      installed: { roots: census.INSTALL_ROOTS, cacheFile: observationCache(database, "installed-references.v1.json") },
    }),
  };
  const observed = censusBound(() => census.runCensuses(tasks, inspectionDeadline));
  return {
    processes: isolated ? [] : observed.process,
    docker: isolated ? { containers: [], available: false } : observed.docker,
    systemd: isolated ? { units: [], available: false } : census.unionSystemd(observed.systemdUser, observed.systemdSystem),
    threads: threadsObserved ? observed.threads : [],
    gitAlternates: observed.gitDependencies.alternates,
    linkedWorktrees: observed.gitDependencies.linkedWorktrees,
    installed: isolated ? [] : observed.installed,
    // One transition owns this snapshot. Immutable advertised commit identities
    // can be reused while local HEAD, branches and source bytes are rechecked.
    remoteCustody: new Map(),
  };
}

// The CLI is recognised by the file node runs, not by the name it was invoked under: agents run it through
// the `agent-workspace` symlink on PATH (October 30: that argv retained checkout-guard), operators through
// /srv/.../agent-workspace/main, and both resolve to agent-workspace/workspace.mjs.
function workspaceReleaseCommand(processRecord) {
  const [interpreter, script, command] = processRecord.commandLine;
  if (typeof interpreter !== "string" || !path.basename(interpreter).startsWith("node") || typeof script !== "string" || command !== "release") return false;
  const invoked = path.resolve(processRecord.cwd ?? "/", script);
  let resolved = invoked;
  try { resolved = realpathSync(invoked); } catch {}
  return ["main", "workspace.mjs"].includes(path.basename(resolved)) && path.basename(path.dirname(resolved)) === "agent-workspace";
}

// The foreground release CLI waiting for its background unit names the checkout only in its arguments, and so
// do the processes waiting on it (`timeout 250 agent-workspace release --path X`, the agent's `bash -c`). They
// are the requester, not consumers: a release CLI for this path and its ancestors are exempt when an argument is
// their only reference. A cwd, executable or writable descriptor inside the checkout still counts, and so does
// any other command naming it.
function processReferences(workspacePath, snapshot = processSnapshot()) {
  const references = snapshot.map((processRecord) => {
    const matches = (processRecord.writableFiles ?? []).filter(file => within(workspacePath, file)).map(file => `write-fd:${file}`);
    if (processRecord.cwd !== null && within(workspacePath, processRecord.cwd)) matches.push(`cwd:${processRecord.cwd}`);
    if (processRecord.executable !== null && within(workspacePath, processRecord.executable)) matches.push(`exe:${processRecord.executable}`);
    if (processRecord.commandLine.some((argument) => argument === workspacePath || argument.includes(`${workspacePath}/`) || argument.includes(`=${workspacePath}`))) matches.push("argument");
    return { processRecord, matches };
  });
  const parents = new Map(snapshot.map((processRecord) => [processRecord.pid, processRecord.ppid]));
  const requesters = new Set();
  for (const { processRecord, matches } of references) {
    if (!(matches.length === 1 && matches[0] === "argument" && workspaceReleaseCommand(processRecord))) continue;
    for (let pid = processRecord.pid; pid > 1 && !requesters.has(pid); pid = parents.get(pid) ?? 0) requesters.add(pid);
  }
  return references.flatMap(({ processRecord, matches }) => {
    if (matches.length === 0 || (requesters.has(processRecord.pid) && matches.length === 1 && matches[0] === "argument")) return [];
    return [{ pid: processRecord.pid, command: processRecord.command, commandLine: processRecord.commandLine.join(" ").slice(0, 300), matches }];
  });
}

// The retained-checkout reason names every reference so the person reading it can act without a second census.
function referenceNames(processes, containers, units) {
  const names = [
    ...processes.map((reference) => `process ${reference.pid} (${reference.commandLine ?? reference.command}) by ${reference.matches.join(", ")}`),
    ...containers.map((reference) => `container ${reference.name}`),
    ...units.map((reference) => `${reference.manager} systemd unit ${reference.id}`),
  ];
  return names.length === 0 ? "" : `: ${names.join("; ")}`;
}

function dockerReferences(workspacePath, snapshot = dockerSnapshot()) {
  if (snapshot.error !== undefined) return { references: [], available: snapshot.available, error: snapshot.error };
  const references = [];
  for (const container of snapshot.containers) {
    const state = container?.State?.Status ?? "unknown";
    const restart = container?.HostConfig?.RestartPolicy?.Name ?? "unknown";
    if (state === "exited" && restart === "no") continue;
    const workingDirectory = container?.Config?.Labels?.["com.docker.compose.project.working_dir"];
    const mounts = Array.isArray(container?.Mounts) ? container.Mounts : [];
    const sources = mounts
      .filter((mount) => mount?.Type === "bind" && typeof mount?.Source === "string" && within(workspacePath, mount.Source))
      .map((mount) => mount.Source);
    if ((typeof workingDirectory !== "string" || !within(workspacePath, workingDirectory)) && sources.length === 0) continue;
    references.push({
      id: container.Id,
      name: String(container.Name ?? "unknown").replace(/^\//u, ""),
      state,
      restart,
      workingDirectory: typeof workingDirectory === "string" ? workingDirectory : null,
      sources,
    });
  }
  return { references, available: snapshot.available };
}

function serializedPathReference(serialized, workspacePath) {
  return serialized === workspacePath || serialized.includes(`${workspacePath}/`) ||
    serialized.includes(`=${workspacePath}`) || serialized.includes(` ${workspacePath} `);
}

// A release unit necessarily names its target in --path. Ignore only that exact
// authenticated ancestor, never another unit, a checkout cwd or executable.
let currentReleaseAuthority = null;
function ownReleaseUnit(unit, workspacePath, context) {
  if (!context || context.command !== "release" || context.target !== workspacePath ||
      !Number.isSafeInteger(unit.mainPid) || unit.mainPid <= 1 ||
      !context.ancestors.has(unit.mainPid) ||
      unit.workingDirectory === null || within(workspacePath, unit.workingDirectory) ||
      unit.execStart.includes(`${workspacePath}/`)) return false;
  const wrapper=context.wrapper;
  const authenticatedBatch=wrapper?.background===true && wrapper.unit===unit.id && unit.manager==='system' &&
    wrapper.binding?.agentId===wrapper.agentId && wrapper.binding?.callId===wrapper.callId && wrapper.binding?.channel===wrapper.channel;
  if (!authenticatedBatch && (unit.execStart.split(workspacePath).length !== 2 || !unit.execStart.includes(`--path ${workspacePath} `))) return false;
  try {
    if (authenticatedBatch && context.read(`/proc/${unit.mainPid}/cgroup`).trim()!==`0::${wrapper.group}`) return false;
    if (authenticatedBatch) {
      // Admission shells are ancestors too. A bare argv mention is harmless, but
      // an actual resource held by any member of this wrapper ancestry is not.
      for (const pid of context.ancestors) {
        if (context.read(`/proc/${pid}/cgroup`).trim()!==`0::${wrapper.group}`) continue;
        if (context.files(pid).some(file=>within(workspacePath,file))) return false;
        const cwd=context.link(`/proc/${pid}/cwd`),exe=context.link(`/proc/${pid}/exe`);
        if(cwd===null||exe===null||within(workspacePath,cwd)||within(workspacePath,exe))return false;
      }
    }
    const status = context.read(`/proc/${unit.mainPid}/status`);
    if (Number(status.match(/^Uid:\s+(\d+)/mu)?.[1]) !== context.uid) return false;
    const cwd = context.link(`/proc/${unit.mainPid}/cwd`);
    const executable = context.link(`/proc/${unit.mainPid}/exe`);
    return cwd !== null && executable !== null && !within(workspacePath, cwd) && !within(workspacePath, executable);
  } catch { return false; }
}
function releaseInspectionContext(authority=currentReleaseAuthority) {
  const args = process.argv.slice(2);
  if (args[0] !== "release") return null;
  const index = args.indexOf("--path");
  const target = index < 0 ? args.find(arg => arg.startsWith("--path="))?.slice(7) : args[index + 1];
  if (!target || !path.isAbsolute(target)) return null;
  let wrapper=null;
  if(authority?.kind==='native') {
    try {
      const observed=procScope(process.pid);
      if(observed?.background===true) wrapper={...observed,binding:authority.binding};
    } catch { /* Unknown scope identity never permits a batch exemption. */ }
  }
  return { wrapper, command: "release", target: path.resolve(target), uid: process.getuid?.(),
    ancestors: processAncestry(), read: file => readFileSync(file, "utf8"), link: readLink,
    files: pid=>readdirSync(`/proc/${pid}/fd`).flatMap(fd=>{
      try { const file=readlinkSync(`/proc/${pid}/fd/${fd}`).replace(/ \(deleted\)$/u,''); return path.isAbsolute(file)?[file]:[]; }
      catch(error) { if(error.code==='ENOENT')return []; throw error; }
    }) };
}
function systemdReferences(workspacePath, snapshot = systemdSnapshot(), context = releaseInspectionContext()) {
  if (snapshot.error !== undefined) return { references: [], available: snapshot.available, error: snapshot.error };
  return {
    available: snapshot.available,
    references: snapshot.units.filter((unit) =>
      (unit.workingDirectory !== null && within(workspacePath, unit.workingDirectory)) ||
      (serializedPathReference(unit.execStart, workspacePath) && !ownReleaseUnit(unit, workspacePath, context))),
  };
}

function installedReferences(workspacePath, snapshot = []) {
  return snapshot.filter((reference) => within(workspacePath, reference.path));
}

function freshThreadSafety(database, safety) {
  if (process.env.NODE_TEST_CONTEXT !== undefined && process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY === "empty" &&
    !process.env.PI_THREAD_DATABASE) return safety;
  return { ...safety, threads: [...(safety?.threads ?? []), ...threadSnapshot(undefined, { cacheFile: observationCache(database, "thread-references.v1.json") })] };
}

function directoryHasEntries(directory) {
  const pending = [directory];
  while (pending.length > 0) {
    const current = pending.pop();
    let entries;
    try { entries = readdirSync(current, { withFileTypes: true }); } catch { return true; }
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.isSymbolicLink()) pending.push(path.join(current, entry.name));
      else return true;
    }
  }
  return false;
}

function gitStatusExcludingNested(record, args, nestedWorkspaces = []) {
  const exclusions = nestedWorkspaces.flatMap((workspace) => {
    const relative = path.relative(record.path, workspace);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) fail(`nested workspace is outside ${record.path}: ${workspace}`);
    return [`:(exclude,top,literal)${relative}`, `:(exclude,top,glob)${relative}/**`];
  });
  return git(record.path, [...args, "--", ".", ...exclusions]);
}

function nestedExclusions(record, nestedWorkspaces) {
  return nestedWorkspaces.flatMap((workspace) => {
    const relative = path.relative(record.path, workspace);
    return [`:(exclude,top,literal)${relative}`, `:(exclude,top,glob)${relative}/**`];
  });
}

// archiveChanges: an explicit release of one checkout copies uncommitted files into a
// released-work archive (working-tree-archive.mjs) instead of keeping the whole checkout for them.
function gitDisposition(record, nestedWorkspaces = [], remoteCustody, archiveChanges = false) {
  const lines = gitStatusExcludingNested(record, ["status", "--porcelain=v1", "--ignored=matching", "--untracked-files=normal"], nestedWorkspaces).split("\n");
  const changed = lines.filter((line) => line && !line.startsWith("!! "));
  let workingTreeChanges = null;
  if (changed.length > 0) {
    if (!archiveChanges) return { safe: false, sourceRetention: true, reason: `working tree has changes: ${changed.slice(0, 8).join(" | ")}` };
    workingTreeChanges = listWorkingTreeChanges(record.path, [".", ...nestedExclusions(record, nestedWorkspaces)]);
    if (workingTreeChanges.bytes > WORKING_TREE_ARCHIVE_MAX_BYTES)
      return { safe: false, sourceRetention: true, reason: `working tree has ${workingTreeChanges.bytes} bytes of uncommitted files, more than release archives (${WORKING_TREE_ARCHIVE_MAX_BYTES}); commit, publish or delete them: ${changed.slice(0, 8).join(" | ")}` };
  }
  const archived = (result) => workingTreeChanges === null || !result.safe ? result
    : { ...result, workingTreeChanges, reason: `${result.reason}; ${workingTreeChanges.files.length} uncommitted or ignored file(s) and ${workingTreeChanges.deleted.length} deletion(s) are archived before removal${workingTreeChanges.droppedBuildProducts?.length ? `, ${workingTreeChanges.droppedBuildProducts.length} build product(s) dropped` : ""}` };
  const nestedRelativePaths = nestedWorkspaces.map((workspace) => path.relative(record.path, workspace));
  const ignored = lines
    .filter((line) => line.startsWith("!! "))
    .filter((line) => !nestedRelativePaths.includes(line.slice(3).replace(/\/$/u, "")))
    .filter((line) => {
      const candidate = path.resolve(record.path, line.slice(3).replace(/\/$/u, ""));
      try { return lstatSync(candidate).isSymbolicLink() || directoryHasEntries(candidate); } catch (error) { return error.code !== "ENOENT"; }
    });
  const head = git(record.path, ["rev-parse", "HEAD"]);
  // Snapshot names and object IDs together; do not walk the graph per branch.
  const inventory = git(record.path, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads", "refs/remotes"])
    .split("\n").filter(Boolean).map(line => line.split(" "));
  const knownHeads = new Map(record.checkoutType === "clone"
    ? inventory.filter(([ref]) => ref.startsWith("refs/heads/")) : []);
  const candidates = [...knownHeads.values(), head];
  const durable = inventory.filter(([ref]) => ref.startsWith("refs/remotes/")).map(([,sha]) => sha);
  if (record.durableSourceCommit !== null) durable.push(record.durableSourceCommit);
  const uncovered = () => hasUncoveredCommits((args, options) => git(record.path, args, options), candidates, durable);
  const initiallyUncovered = uncovered();
  // Recorded disposal of candidate-local merges: never covers ordinary commits, edits or
  // conflict resolutions; re-verified against current durable remote tips on every call.
  const recordedMergesCover = () => {
    try { return disposedMergesCoverRelease((args, options) => git(record.path, args, options), path.resolve(record.path, git(record.path, ["rev-parse", "--git-common-dir"])), candidates, durable); }
    catch { return false; }
  };
  // Local remote-tracking refs can be stale: a commit pushed under any other branch name is
  // durable too. Every head each remote advertises now is read before calling a commit unique.
  if (initiallyUncovered) {
    const observed = remoteCustody?.get(record.path) ?? observedRemoteHeads(command, record.path);
    if (observed.ok) remoteCustody?.set(record.path, observed);
    if (!observed.ok && observed.code !== "remote-custody-absent") return {safe:false, sourceRetention:true, reason:`remote custody observation unavailable: ${observed.detail}; checkout and generated caches retained`, head};
    if (observed.ok) durable.push(...observed.durable);
    const publishedTrees = () => {
      try { return publishedTreesCover((args, options) => git(record.path, args, options), candidates, durable); }
      catch { return false; }
    };
    if (uncovered() && !recordedMergesCover() && !publishedTrees()) return {safe:false, sourceRetention:true, reason:"checkout has commits absent from remote refs or durable source ancestry", head};
  }
  if (ignored.length > 0) {
    if (!archiveChanges) return { safe: false, sourceRetention: false, reason: `checkout has unclassified ignored output: ${ignored.slice(0, 8).join(" | ")}`, head };
    // An explicit release drops regenerable build products and archives other ignored files.
    const output = ignoredOutput(record.path, [".", ...nestedExclusions(record, nestedWorkspaces)]);
    workingTreeChanges = withIgnoredOutput(workingTreeChanges ?? { files: [], deleted: [], bytes: 0 }, output);
    if (workingTreeChanges.bytes > WORKING_TREE_ARCHIVE_MAX_BYTES)
      return { safe: false, sourceRetention: true, reason: `checkout has ${workingTreeChanges.bytes} bytes of uncommitted and ignored non-build files, more than release archives (${WORKING_TREE_ARCHIVE_MAX_BYTES}); commit, publish, move or delete them: ${output.archived.slice(0, 8).join(" | ")}`, head };
  }
  if (head === record.durableSourceCommit) return archived({ safe: true, sourceRetention: false, reason: "checkout remains at its durable source commit", head });
  return archived({ safe: true, sourceRetention: false, reason: "every local branch commit exists on a remote ref or in durable source ancestry", head });
}

function gcDestination(statePath, record, suffix) {
  const root = path.join(path.dirname(statePath), "gc");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  return path.join(root, `${record.id}-${suffix}-${Date.now()}`);
}

function spawnRemoval(target) {
  const script = [
    "const fs = require('node:fs');",
    "const os = require('node:os');",
    "const cp = require('node:child_process');",
    "try { os.setPriority(0, 19); } catch {}",
    "try { fs.rmSync(process.argv[1], { recursive: true, force: true }); }",
    "catch { cp.spawnSync('sudo', ['-n', 'rm', '-rf', '--', process.argv[1]], { stdio: 'ignore' }); }",
  ].join("");
  const child = spawn(process.execPath, ["-e", script, target], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

function drainGc(statePath, scopedIds) {
  const root = path.join(path.dirname(statePath), "gc");
  if (!existsSync(root)) return;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (scopedIds !== undefined && !scopedIds.some(id => entry.name.startsWith(`${id}-`))) continue;
    if (entry.isDirectory() || entry.isFile() || entry.isSymbolicLink()) spawnRemoval(path.join(root, entry.name));
  }
}

function repairCacheOwnership(target) {
  assertUnfrozenCustody(target);
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (uid === undefined || gid === undefined) fail(`cannot repair cache ownership without a numeric user and group: ${target}`);
  run("sudo", ["-n", "chown", "-R", `${uid}:${gid}`, "--", target], { timeout: 120_000 });
}

function moveToGc(target, destination) {
  assertUnfrozenCustody(target);
  try {
    renameSync(target, destination);
    spawnRemoval(destination);
  } catch (error) {
    if (error?.code === "EACCES" || error?.code === "EPERM") {
      repairCacheOwnership(target);
      renameSync(target, destination);
      spawnRemoval(destination);
      return;
    }
    if (error?.code !== "EXDEV") throw error;
    rmSync(target, { recursive: true, force: true });
  }
}

function* cacheTargets(workspacePath, cachePaths, readDirectory = readdirSync) {
  const directoryNames = new Set();
  for (const relative of cachePaths) {
    if (relative.startsWith("**/")) directoryNames.add(relative.slice(3));
    else yield path.resolve(workspacePath, relative);
  }
  const pending = directoryNames.size === 0 ? [] : [workspacePath];
  while (pending.length > 0) {
    const current = pending.pop();
    let entries;
    try {
      entries = readDirectory(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name === ".git") continue;
      const candidate = path.join(current, entry.name);
      // A **/name declaration names generated output wherever it appears: a
      // directory such as node_modules or a single file such as
      // client.generated.ts. Tracked files are protected by the consumer.
      if (directoryNames.has(entry.name)) yield candidate;
      if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
      // The consumer removes generated trees before traversal resumes. Tracked
      // directories stay in place and may contain other generated caches.
      if (existsSync(candidate)) pending.push(candidate);
    }
  }
}

/* A declared cache path may collide with a directory the repository actually tracks, such as a
 * committed `build`. Generated output is never tracked, so tracked content is not the cache. */
function holdsTrackedFiles(target) {
  const directory = lstatSync(target).isDirectory();
  const cwd = directory ? target : path.dirname(target);
  const pathspec = directory ? "." : `:(literal)${path.basename(target)}`;
  const result = command("git", ["-C", cwd, "ls-files", "--", pathspec]);
  if (result.status !== 0) return true;
  return result.stdout.length > 0;
}

const REPOSITORY_CACHE_MANIFEST = ".agent-workspace-caches";

/* A repository can declare its own generated output in a tracked manifest, one cache path per
 * line, `#` comments allowed. Reading it from HEAD rather than the working tree means an agent
 * cannot launder unique work by dropping an untracked manifest into the checkout; the
 * declaration has to be part of the repository's history. Every caller that creates a workspace
 * for that repository then classifies its output the same way, without repeating `--cache`. */
function repositoryManifestCachePaths(workspacePath) {
  const result = command("git", ["-C", workspacePath, "show", `HEAD:${REPOSITORY_CACHE_MANIFEST}`]);
  if (result.status !== 0) return [];
  const declared = result.stdout
    .split("\n")
    .map((line) => line.replace(/#.*$/u, "").trim())
    .filter(Boolean);
  const accepted = [];
  for (const value of declared) {
    try {
      accepted.push(normalizeCachePath(value));
    } catch {
      process.stderr.write(`agent-workspace: ignoring invalid ${REPOSITORY_CACHE_MANIFEST} entry in ${workspacePath}: ${value}\n`);
    }
  }
  return accepted;
}

function repositoryPrepareCachePaths(workspacePath) {
  const manifest = command("git", ["-C", workspacePath, "show", "HEAD:package.json"]);
  if (manifest.status !== 0) return [];
  try {
    const pkg = JSON.parse(manifest.stdout);
    // Only the known Husky generator owns this exact internal directory. Read
    // committed source, never an untracked or locally edited prepare script.
    // Also the common tolerant forms ("husky || true", "husky install || :"), which only
    // suppress a failure when Git hooks cannot be installed (blitz2-link-liminal-be).
    const owned = [];
    if (/^husky(?: install)?(?:\s*\|\|\s*(?:true|:|exit 0))?$/.test((pkg.scripts?.prepare ?? "").trim())) owned.push(".husky/_=package.json");
    // swagger-autogen in Link's backend: committed scripts run src/docs/swagger.js, which writes
    // swagger-output.json, and the integration suites write src/docs/definitions through
    // swaggerUtils.js. Each output still has to be Git-ignored and its owner tracked at HEAD.
    const dependencies = {...pkg.dependencies, ...pkg.devDependencies};
    if (dependencies["swagger-autogen"] !== undefined && Object.values(pkg.scripts ?? {}).some(script => /\bnode\s+(?:\.\/)?src\/docs\/swagger\.js\b/.test(script)))
      owned.push("src/docs/swagger-output.json=src/docs/swagger.js", "swagger-output.json=src/docs/swagger.js", "src/docs/definitions=src/docs/swaggerUtils.js");
    return owned.length ? repositoryOwnedCachePaths(workspacePath, owned) : [];
  } catch { return []; }
}
function effectiveCachePaths(record) {
  return [...new Set([...DEFAULT_CACHE_PATHS, ...record.cachePaths, ...repositoryManifestCachePaths(record.path), ...repositoryPrepareCachePaths(record.path)])];
}

function stripCaches(record, statePath, invalidateCapacity, observeLink) {
  const removed = [];
  const seen = new Set();
  for (const target of cacheTargets(record.path, effectiveCachePaths(record))) {
    if (seen.has(target) || !within(record.path, target) || target === record.path || !existsSync(target)) continue;
    seen.add(target);
    // Explicit declarations must not reach through an aliased parent either.
    if (realpathSync(record.path) !== record.path || realpathSync(path.dirname(target)) !== path.dirname(target)) continue;
    if (lstatSync(target).isSymbolicLink()) {
      if (unlinkDeclaredCacheSymlink({root:record.path, target, declarations:effectiveCachePaths(record),
        tracked:holdsTrackedFiles, ignored:relative => command("git",["-C",record.path,"check-ignore","--quiet","--",relative]).status === 0,
        observe:observeLink, invalidateCapacity})) removed.push(path.relative(record.path, target));
      continue;
    }
    if (holdsTrackedFiles(target)) continue;
    const cacheKey = createHash("sha256").update(path.relative(record.path, target)).digest("hex").slice(0, 12);
    const destination = gcDestination(statePath, record, `${path.basename(target)}-${cacheKey}`);
    invalidateCapacity();
    moveToGc(target, destination);
    removed.push(path.relative(record.path, target));
  }
  return removed;
}

function removeWorkspace(record, statePath) {
  if (record.checkoutType === "worktree") {
    assertUnfrozenCustody(record.path);
    const rawCommon = git(record.path, ["rev-parse", "--git-common-dir"]);
    const common = path.resolve(record.path, rawCommon);
    const branchResult = command("git", ["-C", record.path, "symbolic-ref", "--quiet", "--short", "HEAD"]);
    run("git", [`--git-dir=${common}`, "worktree", "remove", "--force", record.path]);
    if (branchResult.status === 0) run("git", [`--git-dir=${common}`, "branch", "--delete", "--force", branchResult.stdout]);
    return;
  }
  const destination = gcDestination(statePath, record, "workspace");
  moveToGc(record.path, destination);
}

function removeEmptyWorkspaceContainer(record) {
  const container = path.dirname(record.path);
  if (path.dirname(container) !== record.root) return;
  try { rmdirSync(container); } catch (error) {
    if (!["ENOENT", "ENOTEMPTY"].includes(error?.code)) throw error;
  }
}

function stackQueueSafety(roots,safety,resourceKind,deadline) {
  if(process.env.NODE_TEST_CONTEXT!==undefined && process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY==="empty") {
    const observed=safety?.currentStackQueue??{errors:[],references:[],observedAt:Date.now()};
    const qualifications=process.env.PI_WORKSPACE_TEST_QUALIFICATION_ROOT ? qualificationReferences(roots,{dataRoot:process.env.PI_WORKSPACE_TEST_QUALIFICATION_ROOT}) : {errors:[],references:[]};
    return {...observed,errors:[...observed.errors,...qualifications.errors],references:[...observed.references.filter(ref=>resourceKind==="source"||ref.resourceClass!=="source-intent"),...qualifications.references]};
  }
  const native = currentStackQueueReferences(roots,{resourceKind,deadline});
  const qualifications = qualificationReferences(roots);
  return {...native, errors:[...native.errors,...qualifications.errors], references:[...native.references,...qualifications.references], qualificationObservation:qualifications.observations};
}
function stackQueueInspection(queued) {
  if(queued.errors.length) return {classification:"blocked",reason:`current Stack queue observation unavailable: ${queued.errors.join("; ")}`,processes:[],containers:[],systemdUnits:[],currentStackQueueProtected:true};
  if(queued.references.length) return {classification:"referenced",reason:"current/queued/uncertain Stack workspace custody remains",currentStackReferences:queued.references,currentStackQueueObservations:queued.observations??[],processes:[],containers:[],systemdUnits:[],currentStackQueueProtected:true};
  return null;
}
function inspectRecord(record, options = {}) {
  if (record.state === "creating") {
    return { classification: "blocked", reason: "creation is pending; repeat the original create command to resume", processes: [], containers: [], systemdUnits: [] };
  }
  const now = options.now ?? Date.now();
  if (!existsSync(record.path)) return { classification: "missing", reason: "checkout path is absent", processes: [], containers: [], systemdUnits: [] };
  const frozen = frozenCustody(record.path);
  if (frozen) return {classification:"blocked",...frozen,processes:[],containers:[],systemdUnits:[]};
  if (record.leaseExpiresAt > now && !options.ignoreLease) {
    return { classification: "active", reason: `lease valid until ${new Date(record.leaseExpiresAt).toISOString()}`, processes: [], containers: [], systemdUnits: [] };
  }
  const stackProtection=stackQueueInspection(stackQueueSafety([record.path],options.safety,options.terminalSourceTransfer===true?"physical-checkout":"source",options.deadline));
  if(stackProtection!==null) return stackProtection;
  const threads = (options.safety?.threads ?? []).filter((thread) => within(record.path, thread.cwd));
  if (threads.length > 0) {
    return { classification: "referenced", reason: `${threads.length} thread(s) with unfinished custody use this checkout: ${threads.map((thread) => thread.id).join(", ")}`,
      threads, processes: [], containers: [], systemdUnits: [] };
  }
  const installed = installedReferences(record.path, options.safety?.installed);
  if (installed.length > 0) {
    const files = [...new Set(installed.map((reference) => reference.file))];
    return { classification: "referenced", reason: `${files.length} installed file(s) under /opt, /srv or /etc/systemd name this checkout: ${files.slice(0, 4).join(", ")}`,
      installed, processes: [], containers: [], systemdUnits: [] };
  }
  const processes = processReferences(record.path, options.safety?.processes);
  const docker = dockerReferences(record.path, options.safety?.docker);
  const systemd = systemdReferences(record.path, options.safety?.systemd);
  const objectDirectory = record.checkoutType === "clone" ? path.join(record.path, ".git", "objects") : null;
  const gitDependents = objectDirectory === null ? [] : (options.safety?.gitAlternates ?? [])
    .filter((reference) => reference.recordId !== record.id && reference.objectDirectory === objectDirectory);
  const linkedDependents = record.checkoutType === "clone" ? (options.safety?.linkedWorktrees ?? [])
    .filter((reference) => reference.recordId !== record.id && reference.commonDirectory === path.join(record.path, ".git")) : [];
  if (gitDependents.length > 0 || linkedDependents.length > 0) {
    return {
      classification: "referenced",
      reason: linkedDependents.length === 0
        ? `${gitDependents.length} registered Git checkout(s) still borrow this checkout's objects: ${gitDependents.map((reference) => reference.workspacePath).join(", ")}`
        : `${linkedDependents.length} registered linked worktree(s) still use this checkout's Git directory: ${linkedDependents.map((reference) => reference.workspacePath).join(", ")}${gitDependents.length ? `; ${gitDependents.length} alternate object borrower(s)` : ""}`,
      processes,
      containers: docker.references,
      systemdUnits: systemd.references,
      gitDependents: [...gitDependents, ...linkedDependents],
    };
  }
  if (docker.error !== undefined) return { classification: "blocked", reason: `cannot prove container safety: ${docker.error}`, processes, containers: [], systemdUnits: [] };
  if (systemd.error !== undefined) return { classification: "blocked", reason: `cannot prove systemd safety: ${systemd.error}`, processes, containers: docker.references, systemdUnits: [] };
  if (processes.length > 0 || docker.references.length > 0 || systemd.references.length > 0) {
    return {
      classification: "referenced",
      reason: `${processes.length} process, ${docker.references.length} container, and ${systemd.references.length} systemd references remain${referenceNames(processes, docker.references, systemd.references)}`,
      processes,
      containers: docker.references,
      systemdUnits: systemd.references,
    };
  }
  const disposition = duringInspection(options.deadline, () => gitDisposition(record, options.nestedWorkspaces, options.safety?.remoteCustody, options.archiveWorkingTree === true));
  return {
    classification: disposition.safe ? "reclaimable" : "repair-required",
    reason: disposition.reason,
    sourceRetention: disposition.sourceRetention,
    ...(disposition.workingTreeChanges ? { workingTreeChanges: disposition.workingTreeChanges } : {}),
    processes,
    containers: docker.references,
    systemdUnits: systemd.references,
    head: disposition.head,
  };
}

function reconcileRecord(database, record, options) {
  if (generatedOnlySourceCustody(database, record.id) || recordRetainsCustody(database, record.id) || retainedParent(database,record.path)) return retainedCustodyResult(record);
  let safety = options.safety;
  let inspection = inspectRecord(record, { ignoreLease: options.ignoreLease, safety, deadline: options.deadline, terminalSourceTransfer: options.terminalSourceTransfer === true, archiveWorkingTree: options.archiveWorkingTree === true });
  if (inspection.classification === "active") return { record, inspection, action: "none" };
  if (inspection.currentStackQueueProtected) return {record,inspection,action:"none"};
  if(inspection.sourceRetention===true){
    if(options.execute)updateState(database,record,"repair-required",inspection.reason);
    return {record,inspection,action:"none",removedCaches:[]};
  }
  if (inspection.classification === "missing") {
    if (options.execute) {
      updateState(database, record, "released", inspection.reason);
      removeEmptyWorkspaceContainer(record);
    }
    return { record, inspection, action: options.execute ? "forgot-missing" : "would-forget-missing" };
  }
  if (inspection.classification === "referenced" || inspection.classification === "blocked") {
    if (options.execute) updateState(database, record, inspection.classification, inspection.reason);
    return { record, inspection, action: "none" };
  }
  let removedCaches = [];
  if (options.execute) {
    safety = freshThreadSafety(database, safety);
    inspection = inspectRecord(record, { ignoreLease: true, safety, deadline: options.deadline, terminalSourceTransfer: options.terminalSourceTransfer === true, archiveWorkingTree: options.archiveWorkingTree === true });
    if (inspection.classification === "referenced" || inspection.classification === "blocked") {
      updateState(database, record, inspection.classification, inspection.reason);
      return { record, inspection, action: "none" };
    }
    if(inspection.sourceRetention===true){updateState(database,record,"repair-required",inspection.reason);return {record,inspection,action:"none",removedCaches:[]};}
    removedCaches = stripCaches(record, options.statePath, () => database.prepare("DELETE FROM workspace_capacity_measurement WHERE workspace_id=?").run(record.id), roots => cacheSymlinkSafety(database, record, roots));
    inspection = inspectRecord(record, { ignoreLease: true, safety, deadline: options.deadline, terminalSourceTransfer: options.terminalSourceTransfer === true, archiveWorkingTree: options.archiveWorkingTree === true });
  }
  if (inspection.classification === "repair-required") {
    if (options.execute) updateState(database, record, "repair-required", inspection.reason);
    return { record, inspection, removedCaches, action: removedCaches.length > 0 ? `removed-caches:${removedCaches.join(",")}` : "none" };
  }
  if (inspection.classification !== "reclaimable") return { record, inspection, removedCaches, action: "none" };
  if (!options.execute) return { record, inspection, action: "would-release" };
  const current = recordBy(database, { id: record.id });
  if (!options.ignoreLease && current.leaseExpiresAt > Date.now()) return { record: current, inspection: inspectRecord(current), action: "lease-renewed" };
  const latest = inspectRecord(current, { ignoreLease: true, safety: freshThreadSafety(database, safety), deadline: options.deadline, terminalSourceTransfer: options.terminalSourceTransfer === true, archiveWorkingTree: options.archiveWorkingTree === true });
  if (latest.classification !== "reclaimable") {
    updateState(database, current, latest.classification, latest.reason);
    return { record: current, inspection: latest, removedCaches, action: "none" };
  }
  assertUnfrozenCustody(current.path);
  let workingTreeArchive = null;
  if (latest.workingTreeChanges) {
    workingTreeArchive = archiveWorkingTree({ root: current.path, directory: path.join(path.dirname(options.statePath), "released-work"),
      name: `${path.basename(current.path)}-${current.id.slice(0, 8)}`, changes: latest.workingTreeChanges,
      manifest: { workspaceId: current.id, path: current.path, owner: current.owner, head: latest.head, releasedAt: new Date().toISOString(),
        restore: `git clone the checkout's remote at head, then: tar --zstd -xf THIS_FILE -C CHECKOUT and delete the listed deleted paths` } });
  }
  const reason = workingTreeArchive ? `${latest.reason}; uncommitted files archived to ${workingTreeArchive}` : inspection.reason;
  updateState(database, current, "reclaiming", reason);
  removeWorkspace(current, options.statePath);
  removeEmptyWorkspaceContainer(current);
  updateState(database, current, "released", reason);
  return { record: current, inspection: workingTreeArchive ? latest : inspection, removedCaches, action: "released", ...(workingTreeArchive ? { workingTreeArchive } : {}) };
}

function recordsInGroup(database, record) {
  if (record.groupId === null) return [record];
  return database.prepare(`SELECT workspace.*, ${ASSIGNMENT_SOURCE} FROM workspace WHERE group_id = ? ORDER BY root, path`)
    .all(record.groupId)
    .map(rowToRecord)
    .filter((candidate) => candidate.state !== "released" || existsSync(candidate.path));
}

function groupInspectionOptions(record, records, options) {
  return {
    ...options,
    nestedWorkspaces: records
      .filter((candidate) => candidate.id !== record.id && within(record.path, candidate.path))
      .map((candidate) => candidate.path),
  };
}

function groupReconciliation(database, records, options) {
  if (records.some(record => generatedOnlySourceCustody(database, record.id) || recordRetainsCustody(database, record.id) || retainedParent(database,record.path))) return records.map(retainedCustodyResult);
  const now = Date.now();
  let safety = options.safety;
  const groupId = records[0]?.groupId;
  if (!options.ignoreLease && records.some((record) => record.leaseExpiresAt > now)) {
    const expires = Math.max(...records.map((record) => record.leaseExpiresAt));
    return records.map((record) => ({
      record,
      inspection: { classification: "active", reason: `group lease valid until ${new Date(expires).toISOString()}`, processes: [], containers: [], systemdUnits: [] },
      action: "none",
    }));
  }

  let inspections = records.map((record) => inspectRecord(record,
    groupInspectionOptions(record, records, { ignoreLease: true, safety, deadline: options.deadline,terminalSourceTransfer:options.terminalSourceTransfer===true })));
  if(inspections.some(inspection=>inspection.currentStackQueueProtected)) return records.map((record,index)=>({record,inspection:inspections[index],action:"none"}));

  const preserveKnownSource = inspections.some((inspection)=>inspection.sourceRetention===true);
  const removedCaches = new Map();
  if (options.execute && !preserveKnownSource && !inspections.some((inspection) => ["referenced", "blocked"].includes(inspection.classification)||inspection.sourceRetention===true)) {
    safety = freshThreadSafety(database, safety);
    inspections = records.map((record) => inspectRecord(record,
      groupInspectionOptions(record, records, { ignoreLease: true, safety, deadline: options.deadline,terminalSourceTransfer:options.terminalSourceTransfer===true })));
  }
  if (options.execute && !preserveKnownSource && !inspections.some((inspection) => ["referenced", "blocked"].includes(inspection.classification)||inspection.sourceRetention===true)) {
    records.forEach((record, index) => {
      if (inspections[index].classification !== "missing") {
        removedCaches.set(record.id, stripCaches(record, options.statePath, () => database.prepare("DELETE FROM workspace_capacity_measurement WHERE workspace_id=?").run(record.id), roots => cacheSymlinkSafety(database, record, roots)));
      }
    });
    inspections = records.map((record) => inspectRecord(record,
      groupInspectionOptions(record, records, { ignoreLease: true, safety, deadline: options.deadline,terminalSourceTransfer:options.terminalSourceTransfer===true })));
  }

  if (options.execute && !preserveKnownSource && !inspections.some((inspection) => ["referenced", "blocked"].includes(inspection.classification)||inspection.sourceRetention===true)) {
    safety = freshThreadSafety(database, safety);
    inspections = records.map((record) => inspectRecord(record,
      groupInspectionOptions(record, records, { ignoreLease: true, safety, deadline: options.deadline,terminalSourceTransfer:options.terminalSourceTransfer===true })));
  }
  const releasable = inspections.every((inspection) => ["missing", "reclaimable"].includes(inspection.classification));
  if (!releasable) {
    if (options.execute) {
      records.forEach((record, index) => {
        const inspection = inspections[index];
        const state = inspection.classification === "reclaimable" ? "blocked" : inspection.classification;
        updateState(database, record, state, `workspace group ${groupId} retained: ${inspection.reason}`);
      });
    }
    return records.map((record, index) => ({
      record,
      inspection: inspections[index],
      removedCaches:removedCaches.get(record.id)??[],
      action: (removedCaches.get(record.id) ?? []).length > 0
        ? `removed-caches:${removedCaches.get(record.id).join(",")}`
        : "none",
    }));
  }
  if (!options.execute) {
    return records.map((record, index) => ({ record, inspection: inspections[index], action: "would-release-group" }));
  }

  for (const record of records) if (existsSync(record.path)) assertUnfrozenCustody(record.path);
  database.exec("BEGIN IMMEDIATE");
  try {
    const current = records.map((record) => recordBy(database, { id: record.id }));
    if (!options.ignoreLease && current.some((record) => record.leaseExpiresAt > Date.now())) {
      database.exec("ROLLBACK");
      return groupReconciliation(database, current, { ...options, execute: false });
    }
    const statement = database.prepare("UPDATE workspace SET state = 'reclaiming', detail = ?, updated_at = ? WHERE id = ?");
    const updatedAt = Date.now();
    for (const record of current) statement.run(`workspace group ${groupId} is reclaiming`, updatedAt, record.id);
    database.exec("COMMIT");
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch {}
    throw error;
  }

  records
    .map((record, index) => ({ record, inspection: inspections[index] }))
    .sort((left, right) => right.record.path.length - left.record.path.length)
    .forEach(({ record, inspection }) => {
      if (inspection.classification === "reclaimable" && existsSync(record.path)) removeWorkspace(record, options.statePath);
      updateState(database, record, "released", `workspace group ${groupId} released: ${inspection.reason}`);
    });
  for (const record of records) removeEmptyWorkspaceContainer(record);
  return records.map((record, index) => ({ record, inspection: inspections[index], removedCaches:removedCaches.get(record.id)??[], action: "released-group" }));
}

function blockedReconciliation(database, records, error, execute) {
  const detail = error instanceof Error ? error.message : String(error);
  return records.map((record) => {
    const current = execute && record.state !== "creating" && !(error instanceof ResourceBusyError)
      ? updateState(database, record, "blocked", detail) : record;
    return {
      record: current,
      inspection: { classification: "blocked", reason: detail, ...(error.code?.startsWith("FROZEN_CUSTODY") ? {code:error.code}:{}), processes: [], containers: [], systemdUnits: [] },
      cacheDisposition:{kind:"unknown",reason:"interrupted reconciliation; no cache-effect inference"},
      action: "none",
    };
  });
}

function reconcileRecords(database, selected, options) {
  const results = [];
  const visited = new Set();
  let inspectedGroups = 0;
  let after = options.after ?? "";
  for (const selectedRecord of selected) {
    if (visited.has(selectedRecord.id)) continue;
    const records = recordsInGroup(database, selectedRecord);
    records.forEach((record) => visited.add(record.id));
    if (inspectedGroups >= (options.maxGroups ?? Infinity) || Date.now() >= (options.deadline ?? Infinity)) {
      results.push(...records.map((record) => ({
        record,
        inspection: { classification: "deferred", reason: `inspection budget reached; not inspected; resume with --after ${after || "start"}`, processes: [], containers: [], systemdUnits: [] },
        action: "none",
        continuationAfter: after || "start",
      })));
      continue;
    }
    inspectedGroups += 1;
    if (records.some((record) => movedToColdStorage(record.path))) {
      results.push(...records.map((record) => ({ record, inspection: {
        classification: "cold", reason: "moved to the Storage Box by kenan-cold; read-only, so not inspected",
        processes: [], containers: [], systemdUnits: [],
      }, action: "none" })));
      after = selectedRecord.id;
      options.onProgress?.(after);
      continue;
    }
    if (records.some((record) => record.state === "creating")) {
      results.push(...records.map((record) => ({ record, inspection: {
        classification: "blocked", reason: "workspace creation is pending; repeat its original create command",
        processes: [], containers: [], systemdUnits: [],
      }, action: "none" })));
      after = selectedRecord.id;
      options.onProgress?.(after);
      continue;
    }
    try {
      results.push(...withWorkspaceLock(database, selectedRecord.path, () => {
        const current = recordsInGroup(database, recordBy(database, { id: selectedRecord.id }));
        const queuedProtection=stackQueueInspection(stackQueueSafety(current.map(record=>record.path),options.safety,options.terminalSourceTransfer===true?"physical-checkout":"source",options.deadline));
        if(queuedProtection!==null) return current.map(record=>({record,inspection:queuedProtection,action:"none"}));
        const retainsCustody = (record) => generatedOnlySourceCustody(database, record.id) || recordRetainsCustody(database, record.id) || retainedParent(database, record.path);
        const maintain = (records) => duringInspection(options.deadline, () => new Map(records.map((record) => [record.id, retainsCustody(record) ? "retained-custody" : maintainReferenceClone(record.path, options.execute, options.statePath)])));
        const reconcile = () => current.length > 1 ? groupReconciliation(database, current, options)
          : current.length === 1 ? [reconcileRecord(database, current[0], options)] : [];
        if (!options.execute) {
          const maintenance = maintain(current);
          return reconcile().map((result) => ({ ...result, gitMaintenance: maintenance.get(result.record.id) }));
        }
        // Object custody (importing borrowed objects into an independent mirror) only matters
        // for a checkout that stays. Removing a checkout whose work is published loses nothing,
        // so reconcile first and stabilise custody only for the checkouts that remain.
        const reconciled = reconcile();
        const removed = new Set(reconciled.filter((result) => result.action === "released" || result.action === "forgot-missing").map((result) => result.record.id));
        const kept = current.filter((record) => !removed.has(record.id) && existsSync(record.path));
        let maintenance;
        try {
          for (const record of kept) if (!retainsCustody(record)) assertNoAmplifyingCleanupImport(record.path, options.statePath);
          maintenance = maintain(kept);
        } catch (error) {
          if (error instanceof ResourceBusyError) throw error;
          // A checkout kept for its own reason (uncommitted or unpublished work, a running process)
          // keeps that reason: object maintenance failing says nothing about why it stays
          // (2026-10-31: rf-long-tail's edited files showed up as CUSTODY_IMPORT_EXCEEDS_RECLAIM).
          const keptForOwnReason = new Set(reconciled.filter((result) => result.inspection?.classification !== "reclaimable").map((result) => result.record.id));
          const blocked = new Map(blockedReconciliation(database, kept.filter((record) => !keptForOwnReason.has(record.id)), error, true).map((result) => [result.record.id, result]));
          const skipped = { kind: "skipped", reason: String(error.message).slice(0, 500) };
          return reconciled.map((result) => blocked.get(result.record.id) ?? { ...result, record: recordBy(database, { id: result.record.id }), gitMaintenance: removed.has(result.record.id) ? "removed" : skipped });
        }
        return reconciled.map((result) => ({
          ...result,
          record: recordBy(database, { id: result.record.id }),
          gitMaintenance: removed.has(result.record.id) ? "removed" : maintenance.get(result.record.id) ?? null,
        }));
      }, selectedRecord.groupId, options.deadline));
    } catch (error) {
      results.push(...blockedReconciliation(database, records, error, error instanceof ResourceBusyError ? false : options.execute));
    }
    after = selectedRecord.id;
    options.onProgress?.(after);
  }
  return results;
}

function print(value, json) {
  if (json) {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    return;
  }
  const items = Array.isArray(value) ? value : [value];
  if (items.every((item) => item?.record !== undefined && item?.inspection !== undefined)) {
    for (const item of items) {
      process.stdout.write(`${item.record.id}\t${item.inspection.classification}\t${item.record.path}\t${item.action}\t${item.inspection.reason}${item.leaseRelease?`\tlease:${item.leaseRelease.kind}\tphysical:${item.physicalDisposition.kind}`:""}\n`);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) process.stdout.write(`${item.id}\t${item.state}\t${item.path}\t${item.detail}\n`);
    return;
  }
  process.stdout.write(`${value.path ?? value.id}\n`);
}

function registerCommand(database, args) {
  assertOnly(args, ["path", "root", "kind", "mode", "owner", "group", "source-commit", "lease-seconds", "cache", "cache-owned", "replace-cache", "retained", "adopt-accounted", "intent", "headroom-gib", "growth-mib", "min-free-gib", "max-count", "min-free-inodes-percent", "json"]);
  if (bool(args,"retained") && one(args,"lease-seconds") !== undefined) growthError("invalid-request","retained registration never takes a writing lease");
  const mode = one(args, "mode", "writer");
  if (!["writer", "review"].includes(mode)) fail("--mode must be writer or review");
  const selectedPath = path.resolve(required(args, "path"));
  const record = register(database, {
    path: selectedPath,
    retained: bool(args,"retained"),
    adoptAccounted: bool(args,"adopt-accounted"),
    capacityArgs: args,
    root: one(args, "root"),
    kind: one(args, "kind", "agent"),
    mode,
    owner: one(args, "owner", "unowned"),
    nativeCaller: nativeCaller(),
    groupId: one(args, "group"),
    sourceCommit: one(args, "source-commit"),
    assertMetadata: Object.fromEntries([
      ["owner", one(args, "owner")], ["sourceCommit", one(args, "source-commit")],
      ["mode", one(args, "mode")], ["kind", one(args, "kind")],
      ["root", one(args, "root") === undefined ? undefined : path.resolve(one(args, "root"))],
    ].filter(([, value]) => value !== undefined)),
    leaseSeconds: numberFlag(args, "lease-seconds", DEFAULT_LEASE_SECONDS),
    cachePaths: cachePathsForRepository(selectedPath, args),
    replaceCachePaths: bool(args, "replace-cache"),
  });
  print(creationRecord(database, record.id), bool(args, "json"));
}

/** @typedef {'workspace-not-registered' | 'path-mismatch' | 'state-not-reassignable' | 'state-mismatch' | 'mode-not-writer' | 'owner-mismatch' | 'source-mismatch' | 'assignment-unchanged' | 'assignment-history-mismatch' | 'checkout-type-mismatch' | 'repository-mismatch' | 'writer-branch-unknown' | 'head-mismatch' | 'checkout-inspection-failed' | 'resource-busy' | 'reassignment-failed' | 'release-caller-unverified' | 'release-owner-unverified' | 'release-owner-unbound' | 'release-owner-mismatch'} ReassignmentErrorCode */
/** @typedef {{ok: true, record: object, transfer: object} | {ok: false, error: {code: ReassignmentErrorCode, detail: string}}} ReassignmentResult */

/** @returns {ReassignmentResult} */
function reassignWorkspace(database, input, authorityDependencies) {
  const refuse = (code, detail) => ({ ok: false, error: { code, detail } });
  const row = database.prepare(`SELECT workspace.*, ${ASSIGNMENT_SOURCE} FROM workspace WHERE id = ?`).get(input.id);
  if (row === undefined) return refuse("workspace-not-registered", input.id);
  const record = rowToRecord(row);
  if (!input.frozenSourceTransfer && existsSync(path.join(record.path,".git","pi-frozen-handoff.json"))) return refuse("state-not-reassignable","frozen source snapshot; use freeze-source transfer or explicit thaw-source");
  if (recordRetainsCustody(database, record.id)) return refuse("growth-admission-required", "resume-growth admission required before reassignment");
  if (record.path !== input.path) return refuse("path-mismatch", `recorded ${record.path}, requested ${input.path}`);
  if (!["active", "referenced", "blocked", "repair-required"].includes(record.state)) {
    return refuse("state-not-reassignable", record.state);
  }
  if (record.state !== input.fromState) return refuse("state-mismatch", `recorded ${record.state}, expected ${input.fromState}`);
  if (record.mode !== "writer") return refuse("mode-not-writer", record.mode);
  if (record.owner !== input.fromOwner) return refuse("owner-mismatch", `recorded ${record.owner}, expected ${input.fromOwner}`);
  if (record.sourceCommit !== input.fromSourceCommit) {
    return refuse("source-mismatch", `recorded ${record.sourceCommit}, expected ${input.fromSourceCommit}`);
  }
  if (record.owner === input.owner && record.sourceCommit === input.sourceCommit) {
    return refuse("assignment-unchanged", "owner and source already match; no handoff recorded");
  }
  const last = database.prepare("SELECT new_owner, new_source_commit FROM workspace_reassignment WHERE workspace_id = ? ORDER BY sequence DESC LIMIT 1").get(record.id);
  if (last !== undefined && (last.new_owner !== record.owner || last.new_source_commit !== record.sourceCommit)) {
    return refuse("assignment-history-mismatch", "current assignment differs from its last handoff");
  }
  let info;
  try {
    info = gitInfo(record.path);
    if (retainedParent(database,record.path)) return refuse("growth-admission-required", "shared Git parent growth is retired");
    if (info.checkoutType !== record.checkoutType) return refuse("checkout-type-mismatch", `recorded ${record.checkoutType}, observed ${info.checkoutType}`);
    if (info.repository === null || info.repository !== record.repository) {
      return refuse("repository-mismatch", `recorded ${record.repository}, observed ${info.repository}`);
    }
    const branch = command("git", ["-C", record.path, "symbolic-ref", "--quiet", "HEAD"]);
    if (branch.status !== 0 && branch.status !== 1) return refuse("writer-branch-unknown", "writer HEAD observation failed");
    if (info.head !== input.sourceCommit) return refuse("head-mismatch", `observed ${info.head}, requested ${input.sourceCommit}`);
  } catch (error) {
    return refuse("checkout-inspection-failed", error instanceof Error ? error.message : String(error));
  }
  const authority = authorizeWorkspaceRelease(database, [record], registryPaths.get(database), authorityDependencies);
  if (!authority.ok) return authority;
  const transfer = {
    workspaceId: record.id, path: record.path,
    oldOwner: record.owner, oldSourceCommit: record.sourceCommit,
    newOwner: input.owner, newSourceCommit: input.sourceCommit,
    authorization: input.authorization, occurredAt: Date.now(),
  };
  const event = database.prepare(`INSERT INTO workspace_reassignment
    (workspace_id, path, old_owner, old_source_commit, new_owner, new_source_commit, authorization, occurred_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(record.id, record.path, record.owner, record.sourceCommit,
    input.owner, input.sourceCommit, input.authorization, transfer.occurredAt);
  // source_commit stays immutable so clients from an earlier release cannot discard a new, unpublished baseline.
  database.prepare("UPDATE workspace SET owner = ?, updated_at = ? WHERE id = ?").run(input.owner, transfer.occurredAt, record.id);
  const caller = authority.kind === "native" ? authority.binding : null;
  // An owner-issued transfer to another native UUID makes that recipient canonical. Free
  // label changes keep the authenticated custodian; a label is never an identity grant.
  const recipient = OWNER_AGENT_ID.test(input.owner) && input.owner !== caller?.agentId ? null : caller;
  reassignNativeOwner(database, record.id, recipient, { command: "reassign", sequence: Number(event.lastInsertRowid) });
  return { ok: true, record: recordBy(database, { id: record.id }), transfer: { sequence: Number(event.lastInsertRowid), ...transfer } };
}

function thawSourceCommand(database,args) {
  assertOnly(args,["id","path","owner","expected-head","json"]);
  const input={id:required(args,"id"),path:path.resolve(required(args,"path")),owner:required(args,"owner"),head:required(args,"expected-head")};
  return withWorkspaceLock(database,input.path,()=>{
    const record=recordBy(database,{id:input.id});
    // A rejected intent can outlive its writing lease or an ordinary release refusal.
    // Thaw repairs exact physical custody; it never grants a new writing lease.
    if(record.id!==input.id||record.path!==input.path||record.owner!==input.owner||record.mode!=="writer"||record.state==="released") fail("writer-stale-custody");
    if(realpathSync(input.path)!==input.path||gitInfo(input.path).head!==input.head) fail("writer-stale-head");
    const marker=path.join(input.path,".git","pi-frozen-handoff.json");
    if(!existsSync(marker)) fail("snapshot-intent-required");
    const intent=JSON.parse(readFileSync(marker,"utf8"));
    if(intent.kind!=="frozen-source-intent"||intent.id!==input.id||intent.path!==input.path||intent.head!==input.head) fail("snapshot-marker-conflict");
    const stat=lstatSync(input.path);
    const result=spawnSync("sudo",["-n","/usr/bin/python3",new URL("./frozen-source.py",import.meta.url).pathname],{input:JSON.stringify({kind:"rollback-source-snapshot",path:input.path,device:stat.dev,inode:stat.ino}),encoding:"utf8",timeout:25000,maxBuffer:1048576});
    if(result.status!==0) fail("snapshot-rollback-unaccepted: "+(result.stderr||result.error?.message));
    rmSync(path.join(input.path,".git","pi-frozen-handoff.json"),{force:true});
    database.prepare("UPDATE workspace SET detail = ?, updated_at = ? WHERE id = ?").run("source freeze intent reconciled; existing state and writing lease unchanged",Date.now(),record.id);
    print({ok:true,binding:input,writingLeaseUnchanged:true,rollback:JSON.parse(result.stdout),ownerUnchanged:true},true);
  });
}

function sourceHandoffCommand(database,args) {
  assertOnly(args,["id","path","owner","expected-head","recipient","remote","branch","json"]);
  const request={id:required(args,"id"),path:path.resolve(required(args,"path")),owner:required(args,"owner"),head:required(args,"expected-head"),recipient:required(args,"recipient"),remote:required(args,"remote"),branch:required(args,"branch")};
  return withWorkspaceLock(database,request.path,()=>{
    const record=recordBy(database,{id:request.id});
    print(sourceHandoff({...record,cachePaths:effectiveCachePaths(record)},request,registryPaths.get(database),database.prepare("SELECT path FROM workspace WHERE state!='released'").all().map(row=>row.path)),true);
  });
}

function freezeSourceCommand(database,args) {
  assertOnly(args,["id","path","owner","expected-head","recipient","authorization","json"]);
  const input={id:required(args,"id"),path:path.resolve(required(args,"path")),owner:required(args,"owner"),head:required(args,"expected-head")};
  return withWorkspaceLock(database,input.path,()=>{
    const record=recordBy(database,{id:input.id}), marker=path.join(input.path,".git","pi-frozen-handoff.json");
    const previous=existsSync(marker)?JSON.parse(readFileSync(marker,"utf8")):null;
    assertWriterBinding(record,input,{head:gitInfo(input.path).head,frozen:false});
    const authority = authorizeWorkspaceRelease(database,[record],registryPaths.get(database));
    if (!authority.ok) growthError(authority.error.code,authority.error.detail);
    if (recordRetainsCustody(database,record.id)||retainedParent(database,record.path)) fail("writer-growth-admission-required");
    if (realpathSync(input.path)!==input.path || lstatSync(path.join(input.path,".git")).isSymbolicLink()) fail("snapshot-private-git-required");
    const clean=command("git",["-C",input.path,"status","--porcelain","--untracked-files=all","--ignored"]);
    if (clean.status!==0 || clean.stdout) fail("snapshot-clean-source-required; no generated/build files allowed");
    if (previous && (previous.id!==input.id||previous.head!==input.head)) fail("snapshot-marker-conflict");
    const recipient=required(args,"recipient"), authorization=required(args,"authorization");
    if(recipient===input.owner||!authorization.trim()) fail("snapshot-recipient-transfer-required");
    const stat=lstatSync(input.path);
    // Managed imports serialize mirror mutation with this same resource key.
    // Keep it through eligibility, preservation refs and physical freeze.
    const alternateFile=path.join(input.path,".git","objects","info","alternates");
    const alternate=existsSync(alternateFile)?readFileSync(alternateFile,"utf8").trim():null;
    const freeze=()=>{
    let objectCustody=prepareFrozenObjectCustody({path:input.path,head:input.head,id:input.id,statePath:registryPaths.get(database),dryRun:true});
    const helperRequest={path:input.path,device:stat.dev,inode:stat.ino,uid:stat.uid,objectCustody};
    const helperCall=kind=>spawnSync("sudo",["-n","/usr/bin/python3",new URL("./frozen-source.py",import.meta.url).pathname],{input:JSON.stringify({...helperRequest,kind}),encoding:"utf8",timeout:25000,maxBuffer:1048576});
    const preflight=helperCall("validate-source-snapshot");
    if(preflight.status!==0) fail("snapshot-ineligible: "+(preflight.stderr||preflight.error?.message));
    objectCustody=prepareFrozenObjectCustody({path:input.path,head:input.head,id:input.id,statePath:registryPaths.get(database)});
    helperRequest.objectCustody=objectCustody;
    if(!previous) writeFileSync(marker,JSON.stringify({kind:"frozen-source-intent",id:input.id,path:input.path,head:input.head,ownerAtFreeze:input.owner,objectCustody})+"\n",{flag:"wx",mode:0o600});
    const helper=helperCall("freeze-source-snapshot");
    if(helper.status!==0) {
      // Reconcile the exact helper journal. Never remove an uncertain physical fence.
      const rollback=helperCall("rollback-source-snapshot");
      if(rollback.status===0) rmSync(marker,{force:true});
      fail("snapshot-freeze-unaccepted: "+(helper.stderr||helper.error?.message)+(rollback.status===0?"; intent reconciled":"; immutable custody retained for thaw-source"));
    }
    const after=command("git",["-C",input.path,"status","--porcelain","--untracked-files=all","--ignored"]);
    if(gitInfo(input.path).head!==input.head||after.status!==0||after.stdout) fail("snapshot-head-raced; immutable source retained for reconciliation");
    database.exec("BEGIN IMMEDIATE");
    let transfer;
    try {
      transfer=reassignWorkspace(database,{id:input.id,path:input.path,fromOwner:input.owner,fromSourceCommit:record.sourceCommit,fromState:record.state,owner:recipient,sourceCommit:input.head,authorization,frozenSourceTransfer:true});
      if(!transfer.ok) fail("snapshot-transfer-failed: "+transfer.error.code);
      database.exec("COMMIT");
    }catch(error){database.exec("ROLLBACK");throw error;}
    print({ok:true,binding:{...input,owner:recipient},transfer:transfer.transfer,snapshot:{...JSON.parse(helper.stdout),objectCustody},nextAction:"create a separately admitted writable build workspace from this frozen exact Git source; never bootstrap this snapshot"},true);
    };
    return alternate?withResourceLock(registryPaths.get(database),`mirror:${path.dirname(alternate)}`,freeze):freeze();
  });
}

function writerRunCommand(database, args) {
  assertOnly(args, ["id", "path", "owner", "expected-head", "command-json", "timeout-ms", "json"]);
  const input = writerRequest(Object.fromEntries([...args.named].map(([k]) => [k, one(args,k)])));
  return withWorkspaceLock(database, input.path, () => {
    const record = recordBy(database, {id:input.id});
    assertWriterBinding(record,input,{head:gitInfo(input.path).head, frozen: existsSync(path.join(input.path,".git","pi-frozen-handoff.json"))});
    if (recordRetainsCustody(database,record.id) || retainedParent(database,record.path)) fail("writer-growth-admission-required");
    const result = runWriter(input,[...heldResourceLocks.values()]);
    print(result,true); process.exitCode = result.ok ? 0 : result.exitCode || 1;
  });
}

function adoptEndedActionsCommand(database,args,statePath) {
  assertOnly(args,["id","path","repository","run","attempt","source-commit","json"]);
  const selected=growthSelected(database,args,"adopt-ended-actions");
  const input={repository:required(args,"repository"),run:required(args,"run"),attempt:required(args,"attempt"),sourceCommit:required(args,"source-commit")};
  const result=withWorkspaceLock(database,selected.path,()=>{
    const record=recordBy(database,{id:selected.id});
    const head=git(record.path,["rev-parse","HEAD"]),branch=git(record.path,["symbolic-ref","--short","HEAD"]);
    database.exec("BEGIN IMMEDIATE");
    try{const result=adoptEndedActions(database,record,statePath,input,{head,branch});database.exec(result.ok?"COMMIT":"ROLLBACK");return result;}
    catch(error){database.exec("ROLLBACK");throw error;}
  },selected.groupId);
  print(result,true);if(!result.ok)process.exitCode=2;
}

function reassignCommand(database, args) {
  assertOnly(args, ["id", "path", "from-owner", "from-source-commit", "from-state", "owner", "source-commit", "authorization", "json"]);
  const requiredFlags = ["id", "path", "from-owner", "from-source-commit", "from-state", "owner", "source-commit", "authorization"];
  const missing = requiredFlags.filter(flag => one(args, flag) === undefined);
  if (missing.length) fail(`reassign is missing required flags: ${missing.map(flag => `--${flag}`).join(", ")}. ` +
    "Read the current values with agent-workspace status --id ID --json. " +
    "--authorization is a reference to the existing task, message or handoff evidence authorizing this transfer; it is not a separately issued credential. " +
    "The authenticated current custodian must run this command; the reference does not grant custody.");
  const fromSource = required(args, "from-source-commit");
  const sourceCommit = required(args, "source-commit");
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(sourceCommit) ||
    (fromSource !== "unset" && !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(fromSource))) {
    fail("source commits must be full lowercase Git object IDs; --from-source-commit may also be unset");
  }
  const input = {
    id: required(args, "id"), path: path.resolve(required(args, "path")),
    fromOwner: required(args, "from-owner"), fromSourceCommit: fromSource === "unset" ? null : fromSource,
    fromState: required(args, "from-state"), owner: required(args, "owner"), sourceCommit,
    authorization: required(args, "authorization"),
  };
  if ([input.fromOwner, input.owner, input.authorization].some(value => !value.trim())) {
    fail("handoff owners and authorization must be nonempty");
  }
  let result;
  try {
    result = withWorkspaceLock(database, input.path, () => {
      database.exec("BEGIN IMMEDIATE");
      try {
        const outcome = reassignWorkspace(database, input);
        database.exec(outcome.ok ? "COMMIT" : "ROLLBACK");
        return outcome;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    });
  } catch (error) {
    result = { ok: false, error: {
      code: error instanceof ResourceBusyError ? "resource-busy" : "reassignment-failed",
      detail: error instanceof Error ? error.message : String(error),
    } };
  }
  if (bool(args, "json")) print(result, true);
  else if (result.ok) print(result.record, false);
  if (!result.ok) {
    process.stderr.write(`agent-workspace: ${result.error.code}: ${result.error.detail}\n`);
    process.exitCode = result.error.code === "resource-busy" ? 75 : 2;
  }
}

function gitRoot(candidate) {
  const probe = command("git", ["-C", candidate, "rev-parse", "--show-toplevel"]);
  return probe.status === 0 && path.resolve(probe.stdout) === candidate;
}

function adoptedGroupId(container) {
  return `adopted-${createHash("sha256").update(container).digest("hex").slice(0, 20)}`;
}

function directNestedGitRoots(container) {
  let entries;
  try { entries = readdirSync(container, { withFileTypes: true }); } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .map((entry) => path.join(container, entry.name))
    .filter((candidate) => existsSync(path.join(candidate, ".git")) && gitRoot(candidate));
}

function adoptionCandidates(root, nestedGroups) {
  const candidates = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || /^\..+\.creating-[0-9a-f-]{36}(?:-\d+-\d+)?$/.test(entry.name)) continue;
    const candidate = path.join(root, entry.name);
    if (!existsSync(candidate)) continue;
    const candidateIsGitRoot = gitRoot(candidate);
    if (!nestedGroups) {
      if (candidateIsGitRoot) candidates.push({ path: candidate, groupId: null });
      continue;
    }
    const nested = directNestedGitRoots(candidate);
    if (candidateIsGitRoot && nested.length === 0) {
      candidates.push({ path: candidate, groupId: null });
      continue;
    }
    const groupId = adoptedGroupId(candidate);
    if (candidateIsGitRoot) candidates.push({ path: candidate, groupId });
    candidates.push(...nested.map((nestedPath) => ({ path: nestedPath, groupId })));
  }
  return candidates;
}

function withAdoptionLocks(database, candidates, action, index = 0) {
  if (index >= candidates.length) return action();
  const candidate = candidates[index];
  return withWorkspaceLock(
    database,
    candidate.path,
    () => withAdoptionLocks(database, candidates, action, index + 1),
    candidate.groupId,
  );
}

function adoptCommand(database, args, statePath) {
  assertOnly(args, ["root", "kind", "mode", "owner", "group", "nested-groups", "lease-seconds", "cache", "cache-owned", "replace-cache", "execute", "reap-expired", "json"]);
  const root = path.resolve(required(args, "root"));
  const mode = one(args, "mode", "writer");
  if (!["writer", "review"].includes(mode)) fail("--mode must be writer or review");
  if (!existsSync(root)) fail(`root does not exist: ${root}`);
  const records = [];
  const requestedGroup = one(args, "group");
  const candidates = adoptionCandidates(root, bool(args, "nested-groups"));
  const desiredGroups = candidates.map((candidate) => requestedGroup ?? candidate.groupId);
  const existingCandidates = candidates.map((candidate) =>
    database.prepare("SELECT group_id, state, lease_expires_at FROM workspace WHERE path = ?").get(path.resolve(candidate.path)));
  const inheritedGroupLeases = new Map();
  candidates.forEach((candidate, index) => {
    const existing = existingCandidates[index];
    const desired = desiredGroups[index];
    if (existing !== undefined && existing.state !== "released" && desired !== null
      && existing.group_id !== null && existing.group_id !== desired) {
      fail(`workspace ${path.resolve(candidate.path)} already belongs to group ${existing.group_id}; requested ${desired}`);
    }
    if (existing !== undefined && existing.state !== "released" && desired !== null) {
      inheritedGroupLeases.set(desired, Math.max(inheritedGroupLeases.get(desired) ?? 0, existing.lease_expires_at));
    }
  });
  const registrations = candidates.map((candidate, index) => ({
    path: candidate.path,
    root,
    kind: one(args, "kind", "agent"),
    mode,
    owner: one(args, "owner", "unowned"),
    groupId: desiredGroups[index],
    sourceCommit: null,
    leaseSeconds: numberFlag(args, "lease-seconds", 0),
    leaseExpiresAt: desiredGroups[index] === null ? undefined : inheritedGroupLeases.get(desiredGroups[index]),
    replaceCachePaths: bool(args, "replace-cache"),
  }));
  withAdoptionLocks(database, registrations, () => {
    for (const registration of registrations) {
      const row = database.prepare("SELECT id FROM workspace WHERE path=?").get(registration.path);
      if ((row && recordRetainsCustody(database,row.id)) || retainedParent(database,registration.path)) growthError("growth-admission-required", "retained custody cannot be adopted or maintained before admission");
    }
    const prepared = registrations
      .filter((registration) => existsSync(registration.path) && gitRoot(registration.path))
      .map((registration) => ({
        ...registration,
        cachePaths: cachePathsForRepository(registration.path, args),
        inspection: registrationInspection(registration.path, statePath),
      }));
    database.exec("BEGIN IMMEDIATE");
    try {
      for (const { inspection, ...registration } of prepared) {
        records.push(registerWorkspace(database, registration, inspection));
      }
      database.exec("COMMIT");
    } catch (error) {
      try { database.exec("ROLLBACK"); } catch {}
      throw error;
    }
  });
  const execute = bool(args, "execute");
  const safety = execute ? safetySnapshot(database) : undefined;
  const results = execute
    ? reconcileRecords(database, records, { execute, reapExpired: bool(args, "reap-expired"), ignoreLease: false, statePath, safety })
    : records;
  print(results, bool(args, "json"));
}

function capacityIntent(args) {
  const intent = one(args, "intent");
  if (intent === undefined) {
    if (one(args, "headroom-gib") !== undefined || one(args, "growth-mib") !== undefined) fail("--headroom-gib and --growth-mib require explicit --intent source-only or budgeted");
    return null;
  }
  if (!["source-only", "budgeted"].includes(intent)) fail("--intent must be source-only or budgeted");
  if (one(args, "min-free-gib") !== undefined) fail("budgeted intent uses --headroom-gib, not --min-free-gib");
  required(args, "headroom-gib");
  required(args, "growth-mib");
  const headroomBytes = Math.ceil(numberFlag(args, "headroom-gib") * 1024 ** 3);
  const growthBytes = Math.ceil(numberFlag(args, "growth-mib") * 1024 ** 2);
  if (!Number.isSafeInteger(headroomBytes) || headroomBytes <= 0 || !Number.isSafeInteger(growthBytes)) fail("capacity budgets require positive headroom and nonnegative growth within the supported byte range");
  return { intent, headroomBytes, growthBytes };
}

function sparseSourcePaths(entries, patterns) {
  if (patterns.length === 0) return null;
  const literal = literalSparseSelection(entries.map(entry => entry.name), patterns);
  if (literal !== null) return literal;
  const scratch = mkdtempSync(path.join(tmpdir(), "pi-workspace-selection-"));
  try {
    run("git", ["init", "--quiet", scratch]);
    const empty = git(scratch, ["hash-object", "-w", "--stdin"], { input: "" });
    const symlink = git(scratch, ["hash-object", "-w", "--stdin"], { input: "." });
    const topology = entries.map(({ mode, type, hash, name }) =>
      `${mode} ${type === "commit" ? hash : mode === "120000" ? symlink : empty}\t${name}\0`).join("");
    git(scratch, ["update-index", "--add", "-z", "--index-info"], { input: topology });
    const tree = git(scratch, ["write-tree"]);
    git(scratch, ["read-tree", "--empty"]);
    const rules = path.join(scratch, ".git", "info", "sparse-checkout");
    writeFileSync(rules, `${patterns.join("\n")}\n`, { mode: 0o600 });
    // Ask checkout itself: ignore-pattern queries disagree on directory reinclusions.
    // Identical path/mode topology with tiny blobs avoids opening any source blob.
    git(scratch, ["-c", "core.sparseCheckout=true", "-c", "core.sparseCheckoutCone=false", "read-tree", "-m", "-u", tree]);
    // Streamed: a large repository's index listing exceeds any spawnSync buffer (renia: over 16 MiB, ENOBUFS).
    const selected = new Set();
    streamRecords("git", ["-C", scratch, "ls-files", "-t", "-z"], "\0", entry => { if (entry.startsWith("H ")) selected.add(entry.slice(2)); });
    return selected;
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

function sourceCapacityPlan(repository, sourceCommit, intent, blockSize, mirror, sparsePatterns = []) {
  if (!existsSync(repository)) {
    if (!mirror || !existsSync(mirror) || existsSync(path.join(mirror, "objects", "info", "alternates"))) {
      fail("source capacity estimate unknown: remote commit needs independent durable mirror custody; remote import remains unestimated");
    }
    const resolved = command("git", ["--git-dir", mirror, "rev-parse", "--verify", `${sourceCommit}^{commit}`]);
    if (resolved.status !== 0 || resolved.stdout !== sourceCommit || !hasObjectClosure(mirror, sourceCommit, sparsePatterns)) {
      fail("source capacity estimate unknown: remote commit closure is absent from durable mirror custody; remote import remains unestimated (refetch through that route)");
    }
    repository = mirror;
  }
  const plan = sourceCheckoutCapacity(repository, sourceCommit, intent, blockSize, sparsePatterns);
  const imported = sourceImportCapacity(repository, sourceCommit, mirror, sparsePatterns);
  const sourceImportBytes = imported.bytes;
  const constructionBytes = plan.constructionBytes + sourceImportBytes;
  if (!Number.isSafeInteger(constructionBytes)) fail("source capacity estimate exceeds supported byte range");
  return { ...plan, constructionBytes, sourceImportBytes, sourceImportBaseCommits: imported.baseCommits };
}

// A configured filter driver only runs on paths an attribute assigns it to, so a driver
// in the system configuration (git-lfs install --system, 2026-10-30) changes nothing by
// itself. The tree's own .gitattributes are checked by sourceCheckoutCapacity; this
// checks the attribute files outside the tree.
// Filter drivers whose committed blobs are git-lfs-format pointer files and whose
// checkout writes the file the pointer names: seinari.git's data filter (2026-10-30).
// A checkout of such a file is priced at the pointer's size line.
const POINTER_FILTERS = new Set(["filter=seinari-data", "filter=lfs"]);
const transformingAttributes = text => text.split("\n").filter(line => !/^\s*#/u.test(line))
  .flatMap(line => line.match(/(?:working-tree-encoding|filter)=\S+/gu) ?? []);

function pricePointerFiles(repository, entries, selected) {
  // A pointer file is about 130 bytes; nothing outside this range can be one.
  const candidates = entries.filter(entry => entry.type === "blob" && entry.size !== undefined && Number(entry.size) >= 80 && Number(entry.size) <= 400
    && (selected === null || selected.has(entry.name)));
  if (candidates.length === 0) return;
  const unique = [...new Set(candidates.map(entry => entry.hash))];
  const result = spawnSync("git", ["-C", repository, "cat-file", "--batch"], { env: { ...process.env, ...closureEnvironment }, input: unique.join("\n") + "\n", maxBuffer: 1 << 30, timeout: 120_000 });
  if (result.error?.code === "ETIMEDOUT") fail(`source capacity estimate unknown: reading ${unique.length} possible data pointer files took over 120 s; a sparse selection (--sparse-pattern '/DIR/') reads only the selected ones`);
  if (result.status !== 0) fail("source capacity estimate unknown: selected source object is unavailable");
  const out = result.stdout, sizes = new Map();
  let offset = 0;
  while (offset < out.length) {
    const end = out.indexOf(10, offset);
    const [hash, , length] = out.toString("latin1", offset, end).split(" ");
    const body = out.toString("latin1", end + 1, end + 1 + Number(length));
    offset = end + 1 + Number(length) + 1;
    const pointer = /^version https:\/\/git-lfs\.github\.com\/spec\/v1\n(?:[^\n]*\n)*?size (\d+)\n/u.exec(body);
    if (pointer) sizes.set(hash, pointer[1]);
  }
  for (const entry of candidates) if (sizes.has(entry.hash) && Number(sizes.get(entry.hash)) > Number(entry.size)) entry.size = sizes.get(entry.hash);
}

function assertSourceCheckoutFilters(repository) {
  const located = command("git", ["-C", repository, "rev-parse", "--path-format=absolute", "--git-path", "info/attributes"]);
  const configured = command("git", ["-C", repository, "config", "--path", "--get", "core.attributesFile"]);
  const home = process.env.HOME || "";
  const files = [located.status === 0 ? located.stdout.trim() : null, "/etc/gitattributes",
    configured.status === 0 ? configured.stdout.trim() : path.join(process.env.XDG_CONFIG_HOME || path.join(home, ".config"), "git", "attributes")];
  for (const file of files.filter(Boolean)) {
    let text;
    try { text = readFileSync(file, "utf8"); } catch (error) { if (error.code === "ENOENT" || error.code === "ENOTDIR") continue; throw error; }
    if (transformingAttributes(text).some(value => !POINTER_FILTERS.has(value))) fail(`source capacity estimate unknown: ${file} assigns a checkout filter; it needs an independently budgeted installer`);
  }
}

function sourceCheckoutCapacity(repository, sourceCommit, intent, blockSize, sparsePatterns = []) {
  if (!Number.isSafeInteger(blockSize) || blockSize <= 0) fail("source capacity estimate unknown: invalid filesystem allocation unit");
  assertSourceCheckoutFilters(repository);
  const { entries, selected } = sourceTree(repository, sourceCommit, sparsePatterns);
  let pointerFilter = false;
  for (const { name } of entries) {
    if (!name.endsWith(".gitattributes")) continue;
    const transforms = transformingAttributes(git(repository, ["show", `${sourceCommit}:${name}`]));
    if (transforms.some(value => !POINTER_FILTERS.has(value))) fail("source capacity estimate unknown: checkout attribute transformation");
    if (transforms.length > 0) pointerFilter = true;
  }
  if (pointerFilter) pricePointerFiles(repository, entries, selected);
  const checkoutAllocation = checkoutConstructionCapacity(entries, selected, blockSize);
  return { ...intent, estimate: selected === null ? "whole-tree-upper-bound" : "git-sparse-upper-bound",
    constructionBytes: checkoutAllocation.totalBytes, checkoutAllocation, checkoutPricingVersion: 4, sourceImportBytes: 0, sourceCommit };
}

function checkoutConstructionCapacity(entries, selected, blockSize) {
  if (!Number.isSafeInteger(blockSize) || blockSize <= 0) fail("invalid filesystem allocation unit");
  let indexBytes = 0, materializedBlobBytes = 0, materializedMetadataBytes = 0;
  const topologyDirectories = new Set(), materializedDirectories = new Set();
  for (const { name, size } of entries) {
    // Excluded files occupy records in a shared index, not separate inodes.
    // Four uncompressed index/tree records cover index rewrites and the
    // temporary same-topology selector. Keep full path bytes even for v4 indexes.
    indexBytes += 4 * (128 + Buffer.byteLength(name));
    const materialized = selected === null || selected.has(name);
    for (let at = name.indexOf("/"); at !== -1; at = name.indexOf("/", at + 1)) {
      const directory = name.slice(0, at);
      topologyDirectories.add(directory);
      if (materialized) materializedDirectories.add(directory);
    }
    if (materialized) {
      materializedBlobBytes += size === undefined ? 0 : 2 * Math.ceil(Number(size) / blockSize) * blockSize;
      materializedMetadataBytes += 4 * blockSize;
    }
  }
  // The selector writes a Git tree object for every source directory. Only
  // selected paths need filesystem directories in the checkout/staging tree.
  const topologyBytes = topologyDirectories.size * 4 * blockSize;
  materializedMetadataBytes += materializedDirectories.size * 4 * blockSize;
  const fixedBytes = 16 * 1024 ** 2;
  const totalBytes = fixedBytes + indexBytes + topologyBytes + materializedMetadataBytes + materializedBlobBytes;
  if (!Number.isSafeInteger(totalBytes)) fail("source capacity estimate exceeds supported byte range");
  return { fixedBytes, indexBytes, topologyBytes, materializedMetadataBytes, materializedBlobBytes,
    sourcePaths: entries.length, sourceDirectories: topologyDirectories.size, materializedDirectories: materializedDirectories.size, totalBytes };
}

function importBaseCommits(repository, sourceCommit, mirror) {
  const baseCommits = [];
  if (mirror && existsSync(mirror) && !existsSync(path.join(mirror, "objects", "info", "alternates"))) {
    // A recent source ancestor often has durable custody even when lexical
    // mirror tips predate thousands of merges. Bound this search independently
    // of mirror ref cardinality; closure qualification is never inferred.
    const recent = recentImportBase(repository, sourceCommit, mirror, {git,
      closure: (store, tip) => command("git", ["--git-dir", store, "cat-file", "-e", `${tip}^{commit}`]).status === 0 && hasObjectClosure(store, tip)});
    if (recent !== null) return [recent];
    const tips = [...new Set(git(mirror, ["for-each-ref", "--count=16", "--format=%(objectname)"]).split("\n").filter(Boolean))];
    // Import bases are an optional capacity optimisation. Do not sort by commit
    // date: that dereferences every retained tip (24k on Converge) before the
    // existing 16-tip limit and can exhaust the Git deadline. Lexical candidates
    // are sufficient: omitting newer/better bases only overestimates import.
    for (const tip of tips.slice(0, 16)) {
      const common = command("git", ["-C", repository, "merge-base", "--all", tip, sourceCommit]);
      if (common.status !== 0) continue;
      for (const base of common.stdout.split("\n").filter(Boolean)) {
        if (!baseCommits.includes(base) && hasObjectClosure(mirror, base)) baseCommits.push(base);
      }
    }
  }
  return baseCommits;
}

function sourceImportCapacity(repository, sourceCommit, mirror, sparsePatterns) {
  if (mirror && existsSync(mirror) && hasObjectClosure(mirror, sourceCommit, sparsePatterns)) return { bytes: 0, baseCommits: [sourceCommit] };
  const baseCommits = importBaseCommits(repository, sourceCommit, mirror);
  const objects = [];
  streamRecords("git", ["-C", repository, "rev-list", "--objects", "--no-object-names", sourceCommit, ...baseCommits.map(tip => `^${tip}`)], "\n", id => { if (id.trim() !== "") objects.push(id.trim()); });
  const bytes = historyImportBytes(objects, input => command("git", ["-C", repository, "cat-file", "--batch-check=%(objectsize)"], { input }));
  return { bytes, baseCommits };
}

function capacityRequirement(plan, reservations, sharedHeadroomBytes = 0) {
  for (const value of [plan.constructionBytes, plan.growthBytes, plan.headroomBytes, sharedHeadroomBytes, ...reservations]) {
    if (!Number.isSafeInteger(value) || value < 0) fail("invalid capacity ledger byte budget");
  }
  const unestimated = plan.intent === "unestimated";
  const constructionBytes = unestimated ? 0 : plan.constructionBytes;
  const headroomBytes = unestimated ? Math.max(plan.constructionBytes, plan.headroomBytes) : plan.headroomBytes;
  const requiredBytes = constructionBytes + plan.growthBytes + Math.max(headroomBytes, sharedHeadroomBytes) + reservations.reduce((sum, bytes) => sum + bytes, 0);
  if (!Number.isSafeInteger(requiredBytes)) fail("capacity ledger total exceeds supported byte range");
  return requiredBytes;
}

function creationFenceBusy(database, workspacePath) {
  const statePath = registryPaths.get(database) ?? database.prepare("PRAGMA database_list").all().find(row => row.name === "main")?.file;
  if (!statePath) fail("capacity estimate unknown: creation fence registry path unavailable");
  const directory = path.join(path.dirname(statePath), "locks");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, createHash("sha256").update(`checkout:${path.resolve(workspacePath)}`).digest("hex"));
  const descriptor = openSync(file, "a", 0o600);
  try {
    const result = spawnSync("flock", ["--exclusive", "--nonblock", "3"], { stdio: ["ignore", "pipe", "pipe", descriptor], timeout: 1000 });
    if (result.status === 0) return false;
    if (result.status === 1) return true;
    fail("capacity estimate unknown: cannot inspect pending creation fence");
  } finally { closeSync(descriptor); }
}

function allocatedWorkspaceBytes(workspacePath, device, { deadline = Date.now() + 500, maxEntries = 50_000, excludedPaths = [], observeContent } = {}) {
  const excluded = new Set(excludedPaths);
  const seen = new Set();
  let entries = 0;
  let bytes = 0;
  let allocatedBytes = 0;
  let lastWriteAt = 0;
  function walk(file) {
    if (excluded.has(file)) return;
    if (++entries > maxEntries || Date.now() >= deadline) throw new Error("allocated-block measurement budget exhausted");
    const stats = lstatSync(file);
    if (String(stats.dev) !== device) {
      if (file === workspacePath) throw new Error("workspace moved to another filesystem");
      return;
    }
    const inode = `${stats.dev}:${stats.ino}`;
    if (seen.has(inode)) return;
    seen.add(inode);
    lastWriteAt=Math.max(lastWriteAt,observeContent?observeContent(file):Math.max(Math.ceil(stats.mtimeMs),Math.ceil(stats.ctimeMs)));
    const blocks = stats.blocks * 512;
    if (!Number.isSafeInteger(blocks) || blocks < 0) throw new Error("invalid allocated-block count");
    allocatedBytes += blocks;
    // Shared inodes cannot spend two workspaces' growth budgets.
    if (stats.isDirectory() || stats.nlink === 1) bytes += blocks;
    if (!Number.isSafeInteger(allocatedBytes)) throw new Error("allocated-block total exceeds supported byte range");
    if (!stats.isDirectory()) return;
    const directory = opendirSync(file);
    try {
      let entry;
      while ((entry = directory.readSync()) !== null) walk(path.join(file, entry.name));
    } finally { directory.closeSync(); }
  }
  try {
    walk(workspacePath);
    return { ok: true, bytes, allocatedBytes, lastWriteAt };
  } catch (error) {
    return { ok: false, error: `${error.code ?? "measurement-unavailable"}: ${error.message}` };
  }
}

function remainingCapacityBytes(plan, state, measurement) {
  capacityRequirement(plan, []);
  if (retainedGrowth(plan)) {
    if (state === "creating") growthError("invalid-growth-lifecycle", "pending creation cannot have retired growth");
    return 0;
  }
  const budget = plan.growthBytes + (state === "creating" ? plan.constructionBytes : 0);
  if (!Number.isSafeInteger(budget)) fail("capacity ledger total exceeds supported byte range");
  if (budget === 0 || !measurement.ok) return budget;
  if (!Number.isSafeInteger(measurement.bytes) || measurement.bytes < 0) fail("invalid capacity allocated-block measurement");
  return Math.max(0, budget - Math.max(0, measurement.bytes - capacityAllocationBaseline(plan, state)));
}

// What one plan holds in the device ledger: unspent growth plus the headroom it
// imposes on every other admission. capacityReservations and reprice admission
// both read a plan through this projection.
function ledgerLiability(plan, state, measurement) {
  return { reservedBytes: remainingCapacityBytes(plan, state, measurement),
    headroomBytes: Math.max(plan.headroomBytes, plan.intent === "unestimated" ? plan.constructionBytes : 0) };
}

function capacityAllocationBaseline(plan, state) {
  const sourceImportBytes = plan.sourceImportBytes ?? 0;
  if (!Number.isSafeInteger(sourceImportBytes) || sourceImportBytes < 0 || sourceImportBytes > plan.constructionBytes) fail("invalid capacity source import budget");
  const baseline = state === "creating" ? 0 : plan.completedAllocationBytes ?? (plan.constructionBytes - sourceImportBytes);
  if (!Number.isSafeInteger(baseline) || baseline < 0) fail("invalid capacity completed allocation baseline");
  return baseline;
}

const CAPACITY_MEASUREMENT_MAX_AGE_MS = 15 * 60_000;
const CAPACITY_MEASUREMENT_MARGIN_BYTES = 64 * 1024 ** 2;

function workspaceAllocationSample(workspacePath, device, options) {
  const startedAt = Date.now();
  try {
    const before = lstatSync(workspacePath);
    if (!before.isDirectory() || String(before.dev) !== device) return { ok: false, startedAt, completedAt: Date.now(), error: "workspace root is not a directory on the reserved filesystem" };
    const allocation = allocatedWorkspaceBytes(workspacePath, device, options);
    if (!allocation.ok) return { ...allocation, startedAt, completedAt: Date.now() };
    const after = lstatSync(workspacePath);
    if (after.dev !== before.dev || after.ino !== before.ino) return { ok: false, startedAt, completedAt: Date.now(), error: "workspace root changed during measurement" };
    return { ...allocation, startedAt, completedAt: Date.now(), device, inode: String(before.ino) };
  } catch (error) {
    return { ok: false, startedAt, completedAt: Date.now(), error: `${error.code ?? "measurement-unavailable"}: ${error.message}` };
  }
}

function cachedWorkspaceAllocation(database, workspaceId, workspacePath, device, now = Date.now()) {
  const row = database.prepare("SELECT measurement_json FROM workspace_capacity_measurement WHERE workspace_id=?").get(workspaceId);
  if (row === undefined) return { ok: false, code: "allocated-block-cache-missing", error: "allocated-block cache missing" };
  let sample;
  try { sample = JSON.parse(row.measurement_json); } catch { return {ok:false,code:"allocated-block-cache-invalid",error:"malformed allocated-block cache"}; }
  if (!sample || typeof sample !== "object" || sample.partial) return {ok:false,code:"allocated-block-cache-invalid",error:"incomplete allocated-block cache"};
  if (sample.ok !== true) return { ok: false, code: "allocated-block-measurement-failed", error: `allocated-block measurement failed: ${sample.error}` };
  for (const value of [sample.startedAt, sample.completedAt, sample.bytes, sample.allocatedBytes]) {
    if (!Number.isSafeInteger(value) || value < 0) return {ok:false,code:"allocated-block-cache-invalid",error:"invalid capacity allocation cache"};
  }
  if (sample.bytes > sample.allocatedBytes) return {ok:false,code:"allocated-block-cache-invalid",error:"exclusive bytes exceed allocated bytes"};
  if (sample.completedAt < sample.startedAt || sample.completedAt > now) return { ok: false, code: "allocated-block-cache-future-dated", error: `allocated-block cache future-dated (completed ${sample.completedAt}, observed ${now})` };
  try {
    const stats = lstatSync(workspacePath);
    if (!stats.isDirectory() || String(stats.dev) !== device || sample.device !== device || String(stats.ino) !== sample.inode) return { ok: false, code: "allocated-block-cache-root-changed", error: "allocated-block cache root identity changed" };
  } catch (error) { return { ok: false, code: "allocated-block-cache-root-unavailable", error: `allocated-block cache root unavailable: ${error.code ?? error.message}` }; }
  if (now - sample.startedAt > CAPACITY_MEASUREMENT_MAX_AGE_MS) {
    const plan = database.prepare("SELECT plan_json FROM workspace_capacity WHERE workspace_id=?").get(workspaceId);
    if (!plan || sample.rootPath !== workspacePath || sample.planSha256 !== createHash("sha256").update(plan.plan_json).digest("hex")) return {ok:false,code:"allocated-block-cache-plan-changed",error:"stale allocation is not bound to the current capacity plan"};
    return { ok: false, code: "allocated-block-cache-stale", ageMs: now - sample.startedAt,
    lastObservation: sample, error: `allocated-block cache stale (age ${Math.round((now - sample.startedAt) / 1000)} s; limit ${CAPACITY_MEASUREMENT_MAX_AGE_MS / 1000} s)` };
  }
  const marginBytes = Math.max(CAPACITY_MEASUREMENT_MARGIN_BYTES, Math.ceil(sample.bytes / 100));
  return { ok: true, bytes: Math.max(0, sample.bytes - marginBytes), rawBytes: sample.bytes, allocatedBytes: sample.allocatedBytes,
    startedAt: sample.startedAt, completedAt: sample.completedAt, marginBytes };
}

// The bytes a plan charges in full unless a current allocated-block sample credits its
// growth. Zero means the ledger never reads a measurement for it: retired future growth,
// or a plan with no growth and no pending construction. The sampler uses the same rule.
function measuredBudgetBytes(plan, state) {
  if (retainedGrowth(plan)) return 0;
  return plan.growthBytes + (state === "creating" ? plan.constructionBytes : 0);
}

let nativeTerminalProjection=null;
function terminalQualificationPaths(rows, database) {
  const census = qualificationReferences(rows.map(row=>row.path), process.env.PI_WORKSPACE_TEST_QUALIFICATION_ROOT ? {dataRoot:process.env.PI_WORKSPACE_TEST_QUALIFICATION_ROOT} : {});
  if (!census.complete) return new Map();
  const settled=new Map();
  for(const item of census.released){
    const row=rows.find(row=>row.path===item.preparedPath&&row.id===item.workspaceId);
    if(!row||row.state==='creating'||census.references.some(ref=>ref.paths.some(q=>q===row.path||q.startsWith(row.path+path.sep)||row.path.startsWith(q+path.sep))))continue;
    try{const at=statSync(item.evidence).mtimeMs;if(row.created_at===undefined||row.created_at<=at)settled.set(row.path,at);}catch{}
  }
  if (database===undefined) return settled;
  const statePath=registryPaths.get(database);
  const holdsDevice=[...heldResourceLocks.keys()].some(key=>key.startsWith(`${statePath}\0capacity:`));
  if(holdsDevice){
    if(nativeTerminalProjection?.database===database)for(const [root,at] of nativeTerminalProjection.paths)
      if(!census.references.some(ref=>ref.paths.some(q=>q===root||q.startsWith(root+path.sep)||root.startsWith(q+path.sep))))settled.set(root,at);
    return settled;
  }
  // Native root-precheck plans are a separate consumer format. Preserve all
  // execution files and plans; only project zero future writes after exact native
  // settlement and a fresh complete writer/consumer observation. Frozen roots are
  // deliberately ineligible, even when every payload has ended.
  const censusDeadline=Date.now()+3000;
  const roots = nativeTerminalRootPaths(rows.filter(row => {
    try { return !retainedGrowth(JSON.parse(row.plan_json)); } catch { return false; }
  }), {
    head: root => git(root,["rev-parse","HEAD"]),
    safe: row => rootTerminalSafety(row,{
      frozen: root => {
        if(Date.now()>=censusDeadline)throw Error('terminal census budget exhausted');
        return frozenCustody(root,{recursive:true,budget:{baseSeconds:1,perEntrySeconds:0,capSeconds:1}});
      },
      observe: row => {
        const deadline=censusDeadline;
        const record=recordBy(database,{id:row.id});
        return duringInspection(deadline,()=>terminalSafety(database,record,deadline));
      },
    }),
  });
  for (const [root,at] of roots) if (!census.references.some(ref=>ref.paths.some(q=>q===root||q.startsWith(root+path.sep)||root.startsWith(q+path.sep)))) settled.set(root,at);
  return settled;
}

function capacityReservations(database, device, reservedPath, measure, observationOptions = {}) {
  if (database === undefined) return { priced: [], headroomBytes: 0, unpricedDormant: 0 };
  const unknown = database.prepare(`SELECT w.path, w.root FROM workspace w LEFT JOIN workspace_capacity c ON c.workspace_id=w.id
    WHERE w.state='creating' AND c.workspace_id IS NULL AND w.path!=?`).all(reservedPath ?? "");
  let unpricedDormant = 0;
  for (const row of unknown) {
    let ancestor = row.root;
    while (!existsSync(ancestor) && ancestor !== path.dirname(ancestor)) ancestor = path.dirname(ancestor);
    if (String(statSync(ancestor).dev) !== device) continue;
    if (creationFenceBusy(database, row.path)) fail(`capacity estimate unknown: active legacy creation at ${row.path}; await its owning creator`);
    unpricedDormant += 1;
  }
  let headroomBytes = 0;
  const measurementFailures = [], growthRepricing=[], staleAllocationForecasts=[];
  const rows = database.prepare(`SELECT c.plan_json, w.id, w.owner, w.state, w.path, w.created_at FROM workspace_capacity c JOIN workspace w ON w.id=c.workspace_id
    WHERE c.device_id=? AND w.path!=? AND w.state!='released' ORDER BY w.created_at DESC, w.id`)
    .all(device, reservedPath ?? "");
  const settled = terminalQualificationPaths(rows, database);
  const now = Date.now(), deadline = now + 3000;
  const owners = new Map(rows.map(row => [row.id, canonicalNativeOwner(database, row)]));
  const nativeOwners = [...new Set([...owners.values()].filter(owner => OWNER_AGENT_ID.test(owner)))];
  let ownerObservation = null;
  if (nativeOwners.length) {
    try { ownerObservation = observationOptions.owners ?? ownerLivenessObservation(nativeOwners, deadline); }
    catch (error) { ownerObservation = {errors:[String(error.message)],owners:nativeOwners,agents:[],wakes:[]}; }
  }
  const inactiveRows = rows.filter(row => row.state !== 'creating' && ownerFutureWrites(owners.get(row.id), ownerObservation, now).kind === 'inactive');
  const children = inactiveRows.length ? (observationOptions.children ?? observeCapacityChildren(inactiveRows.map(row => row.path), {deadline})) : null;
  const priced = rows.map(row => {
      const plan = JSON.parse(row.plan_json);
      if (!["source-only", "budgeted", "unestimated"].includes(plan.intent) ||
        !(plan.intent === "unestimated" ? ["unknown"] : ["whole-tree-upper-bound", "git-sparse-upper-bound"]).includes(plan.estimate)) fail("invalid capacity ledger intent or estimate");
      capacityRequirement(plan, []);
      let restored=false;
      try{restored=(JSON.parse(database.prepare('SELECT state_json FROM workspace_growth_policy WHERE workspace_id=?').get(row.id)?.state_json??'{}').restoreAt??0)>settled.get(row.path);}catch{restored=true;}
      const terminal = row.state!=='creating' && settled.has(row.path) && !restored;
      const ownerForecast = capacityOwnerProjection(row, owners.get(row.id), ownerObservation, children, now);
      const budget = terminal || ownerForecast.zero || movedToColdStorage(row.path) ? 0 : measuredBudgetBytes(plan, row.state);
      const unmeasured = budget === 0;
      const measurement = unmeasured ? {ok:false} : measure === undefined ? cachedWorkspaceAllocation(database, row.id, row.path, device) : measure(row.path, device);
      if (!unmeasured && !measurement.ok) measurementFailures.push({ path: row.path, ...(measurement.code ? { code: measurement.code } : {}), error: measurement.error, reservedBytes: budget });
      // Only the pricing projection may use a stale forecast. cachedWorkspaceAllocation
      // remains false for lifecycle reductions and for fair on-demand sampling.
      let forecast = null;
      if (measurement.code === 'allocated-block-cache-stale') {
        try {
          const history = JSON.parse(database.prepare('SELECT state_json FROM workspace_growth_policy WHERE workspace_id=?').get(row.id)?.state_json ?? 'null');
          const last = measurement.lastObservation;
          const binding = {rootPath:last.rootPath,planSha256:last.planSha256,device:last.device,inode:last.inode};
          if (history?.version === 1 && history.planGrowthBytes === plan.growthBytes && history.samples?.length <= 512 &&
              JSON.stringify(history.allocationBinding) === JSON.stringify(binding) &&
              last.startedAt >= row.created_at && history.samples[0]?.at >= row.created_at &&
              (history.restoreAt === undefined || Number.isSafeInteger(history.restoreAt) && history.restoreAt >= 0 && history.restoreAt <= Date.now()))
            forecast = staleAllocationForecast(measurement.lastObservation, plan, row.state, Date.now(), history.samples);
        } catch {} // Missing or malformed history never produces forecast credit.
      }
      if (forecast) staleAllocationForecasts.push({id:row.id,path:row.path,...forecast});
      const liability = ledgerLiability(plan, row.state, forecast ? {ok:true,bytes:forecast.bytes} : measurement);
      const trustworthy = measurement.ok || measurement.code === 'allocated-block-cache-stale' && forecast !== null;
      const policyEligible = row.state !== 'creating' && ['source-only','budgeted'].includes(plan.intent) && plan.growthBytes > 0 && !plan.growthLifecycle;
      const policy = ownerForecast.zero ? {effectiveRemainingBytes:0,fullReservation:false,reason:ownerForecast.code} : terminal ? {effectiveRemainingBytes:0,fullReservation:false,reason:'terminal-qualification'} : !policyEligible ? null : trustworthy
        ? projectGrowthPolicy(database,row,plan,measurement.ok ? {...measurement,bytes:measurement.rawBytes??measurement.bytes} : measurement.lastObservation)
        : {effectiveRemainingBytes:plan.growthBytes,fullReservation:true,reason:'measurement-unavailable'};
      if (policy!==null) {
        // Forecast uncertainty discounts historical consumed-allocation credit;
        // it must not become a second floor on the independent future-write rate.
        liability.reservedBytes=policy.reason==='fresh-workspace' ? liability.reservedBytes : policy.effectiveRemainingBytes??plan.growthBytes;
        growthRepricing.push({id:row.id,path:row.path,originalGrowthBytes:plan.growthBytes,...policy,
          ...(forecast ? {effectiveRemainingBytes:liability.reservedBytes, forecastUncertaintyBytes:forecast.uncertaintyBytes} : {})});
      }
      headroomBytes = Math.max(headroomBytes, liability.headroomBytes);
      return liability.reservedBytes;
    }).filter(bytes => bytes > 0);
  // Source imports reserve before releasing the device fence. A killed importer
  // retains liability until its original operation reconciles; elapsed time is not credit.
  const sources = database.prepare("SELECT destination,receipt,plan_json FROM workspace_source_capacity WHERE device_id=? AND destination!=?").all(device, reservedPath ?? "");
  for (const row of sources) {
    const plan = JSON.parse(row.plan_json);
    capacityRequirement(plan, []);
    headroomBytes = Math.max(headroomBytes, plan.headroomBytes, plan.intent === "unestimated" ? plan.constructionBytes : 0);
    priced.push(plan.growthBytes + (plan.intent === "unestimated" ? 0 : plan.constructionBytes));
  }
  // Non-Git execution reservations share this exact device ledger and fence.
  // Charge the full operator budget until native cessation AND physical cleanup;
  // no TTL, cached measurement or process restart silently grants capacity.
  for (const execution of executionRows(database, device)) {
    if (execution.state === "released") continue;
    priced.push(execution.growthBytes);
    headroomBytes = Math.max(headroomBytes, execution.headroomBytes);
  }
  return { priced, headroomBytes, unpricedDormant, growthRepricing, ...(staleAllocationForecasts.length ? {staleAllocationForecasts} : {}), sourceImports: sources.map(({destination, receipt}) => ({destination, receipt})), ...(measurementFailures.length ? { measurementFailures } : {}) };
}

// Repricing does not need other checkouts' allocation histories or consumer
// censuses. Full outstanding promises are a conservative upper bound on their
// remaining reservation, NOT a claim about their current physical allocation.
// Physical usage is independently reflected in statfs. Read only this ledger
// under the device fence; never acquire another checkout lock or sample it.
function repriceReservations(database, device, reservedPath) {
  const priced = [], sourceImports = [];
  let headroomBytes = 0;
  const rows = database.prepare(`SELECT c.plan_json,w.state FROM workspace_capacity c JOIN workspace w ON w.id=c.workspace_id
    WHERE c.device_id=? AND w.path!=? AND w.state!='released'`).all(device, reservedPath);
  for (const row of rows) {
    const plan = JSON.parse(row.plan_json);
    capacityRequirement(plan, []);
    const liability = ledgerLiability(plan, row.state, {ok:false});
    priced.push(liability.reservedBytes);
    headroomBytes = Math.max(headroomBytes, liability.headroomBytes);
  }
  for (const row of database.prepare("SELECT destination,receipt,plan_json FROM workspace_source_capacity WHERE device_id=? AND destination!=?").all(device,reservedPath)) {
    const plan=JSON.parse(row.plan_json);
    capacityRequirement(plan,[]);
    priced.push(plan.growthBytes+(plan.intent==='unestimated'?0:plan.constructionBytes));
    headroomBytes=Math.max(headroomBytes,plan.headroomBytes,plan.intent==='unestimated'?plan.constructionBytes:0);
    sourceImports.push({destination:row.destination,receipt:row.receipt});
  }
  for (const plan of executionRows(database,device)) if(plan.state!=='released') {
    priced.push(plan.growthBytes); headroomBytes=Math.max(headroomBytes,plan.headroomBytes);
  }
  // Unknown legacy promises are unchanged by a shrink. Increases retain the
  // original nonblocking legacy-creation check, without walking any checkout.
  const unknown=database.prepare(`SELECT w.path,w.root FROM workspace w LEFT JOIN workspace_capacity c ON c.workspace_id=w.id
    WHERE w.state='creating' AND c.workspace_id IS NULL AND w.path!=?`).all(reservedPath);
  return {priced,headroomBytes,unpricedDormant:0,unknown,sourceImports,observation:'conservative-ledger-promises'};
}

// Only a pre-effect admission refusal may retry. Acquire the device fence for
// each decision/commit, but release it before acquiring another checkout's fence.
// Missing directories have no growth to measure. Settle completed records and
// proven failed creations using the cancellation safety check,
// under the checkout fence and then the filesystem fence (never the reverse).
// lstat distinguishes genuine absence from unreadable roots and dangling symlinks.
function settleMissingCapacity(database, statePath, device, deadline = Date.now() + 5000, selectedIds = null) {
  const rows = database.prepare(`SELECT w.id,w.path,w.group_id FROM workspace w
    JOIN workspace_capacity c ON c.workspace_id=w.id
    WHERE c.device_id=? AND w.state!='released'`).all(device);
  const results = [];
  for (const row of rows) {
    if (selectedIds && !selectedIds.has(row.id)) continue;
    if (Date.now() >= deadline) break;
    const absent = () => { try { lstatSync(row.path); return false; } catch (error) { return error.code === 'ENOENT'; } };
    if (!absent()) continue;
    try {
      const result = withWorkspaceLock(database, row.path, () => {
        if (!absent()) return null;
        return withResourceLock(statePath, `capacity:${device}`, () => {
          const record = recordBy(database, {id:row.id});
          if (record.state==='released' || !absent()) return null;
          if (record.state==='creating') {
            if (!record.detail?.startsWith('creation failed;')) return null;
            assertCreationCancellationSafe(database,record);
          }
          const plan = database.prepare('SELECT plan_json FROM workspace_capacity WHERE workspace_id=?').get(row.id);
          database.exec('BEGIN IMMEDIATE');
          try {
            database.exec(`CREATE TABLE IF NOT EXISTS workspace_retention_release (
              sequence INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id TEXT NOT NULL, occurred_at INTEGER NOT NULL,
              record_json TEXT NOT NULL, plan_json TEXT NOT NULL, inspection_json TEXT NOT NULL)`);
            const inspection = {classification:'missing',reason:'checkout path is absent',bytes:0,growthBytes:0,newWritesAuthorized:false};
            database.prepare('INSERT INTO workspace_retention_release(workspace_id,occurred_at,record_json,plan_json,inspection_json) VALUES(?,?,?,?,?)')
              .run(row.id,Date.now(),JSON.stringify(record),plan.plan_json,JSON.stringify(inspection));
            // Use the existing missing-path settlement, retaining source and plan history.
            database.prepare('UPDATE workspace SET lease_expires_at=0 WHERE id=?').run(row.id);
            updateState(database,record,'released',inspection.reason);
            database.exec('COMMIT');
            return {id:row.id,path:row.path,kind:'missing-path-settled',...inspection};
          } catch (error) { database.exec('ROLLBACK'); throw error; }
        },deadline);
      },row.group_id,deadline);
      if(result) results.push(result);
    } catch { /* Busy or uncertain records retain their entire liability. */ }
  }
  return results;
}

function withCapacityAdmission(database, statePath, device, action) {
  return withCapacityRefresh(database, statePath, device,
    () => withResourceLock(statePath, `capacity:${device}`, action));
}

function withCapacityRefresh(database, statePath, device, action, options = {}) {
  settleMissingCapacity(database,statePath,device);
  try{return admitWithRefresh({
    ...options,
    decide: () => {try{return action();}finally{nativeTerminalProjection=null;}},
    candidates: error => {
      const failures=error.capacity?.breakdown?.measurementFailures??[];
      const charged=new Map((error.capacity?.breakdown?.automaticGrowthRepricing??[]).map(item=>[item.path,item.effectiveRemainingBytes]));
      const candidates=failures.filter(item=>['allocated-block-cache-stale','allocated-block-cache-missing','allocated-block-measurement-failed','allocated-block-cache-plan-changed','allocated-block-cache-invalid'].includes(item.code)
        && (charged.get(item.path)??item.reservedBytes)>0)
        .sort((a,b)=>(charged.get(b.path)??b.reservedBytes)-(charged.get(a.path)??a.reservedBytes));
      if(!candidates.length)return [];
      // Foreground preparation owns 1.5 seconds; its original durable worker
      // performs slow observations under the same request identity.
      if(sourcePreparationMode==='foreground')throw new SourcePreparationRequired();
      return [{path:'native-terminal-projection',terminal:true},...candidates];
    },
    refresh: (candidate,deadline) => {
      if(candidate.terminal){
        const rows=database.prepare(`SELECT c.plan_json,w.id,w.state,w.path,w.created_at FROM workspace_capacity c JOIN workspace w ON w.id=c.workspace_id
          WHERE c.device_id=? AND w.state!='released'`).all(device);
        // Only the immediately following decisions may reuse this observation.
        // Every explicit growth restoration continues to override terminal credit.
        nativeTerminalProjection={database,paths:terminalQualificationPaths(rows,database)};
        return {kind:'terminal-projection',settled:nativeTerminalProjection.paths.size};
      }
      const row=database.prepare("SELECT * FROM workspace WHERE path=? AND state!='creating' AND state!='released'").get(candidate.path);
      if(!row)return {kind:'not-eligible'};
      const record=recordBy(database,{id:row.id});
      return refreshEndedOwnerSample(database,record,deadline,statePath,{incremental:true});
    },
  });}finally{nativeTerminalProjection=null;}
}

// Diagnostic projection of the same reservations used by the refusal.
function capacityRefusalDetails(plan, reservations) {
  const requiredBytes = capacityRequirement(plan, reservations.priced, reservations.headroomBytes);
  const unestimated = plan.intent === "unestimated";
  return {
    requiredBytes,
    constructionBytes: unestimated ? 0 : plan.constructionBytes,
    growthBytes: plan.growthBytes,
    requestedHeadroomBytes: plan.headroomBytes,
    sharedHeadroomBytes: reservations.headroomBytes,
    effectiveHeadroomBytes: Math.max(plan.headroomBytes, reservations.headroomBytes,
      unestimated ? plan.constructionBytes : 0),
    otherReservationsBytes: reservations.priced.reduce((sum, bytes) => sum + bytes, 0),
    otherReservationBytes: [...reservations.priced],
    sourceImports: reservations.sourceImports ?? [],
    ...(reservations.observation ? {otherReservationsObservation:reservations.observation,otherAllocationSamplesRead:reservations.samplesRead===true} : {}),
    unpricedDormant: reservations.unpricedDormant,
    measurementFailures: reservations.measurementFailures === undefined ? [] : reservations.measurementFailures,
    automaticGrowthRepricing: reservations.growthRepricing??[],
    staleAllocationForecasts: reservations.staleAllocationForecasts??[],
    sourceImport: plan.sourceImportBytes === undefined ? { state: "unset" } : { state: "set", bytes: plan.sourceImportBytes },
    sourceForecast: unestimated ? { state: "unset" } : { state: "set", plan },
  };
}

// prior: undefined for a new reservation; {kind:"reduction", plan} for an owner's
// monotone reduction; {kind:"reprice", liability} when an existing reservation is
// re-priced, so only its increment over what it already holds is charged.
function assertCapacity(root, args, database, reservedPath, plan, prior) {
  mkdirSync(root, { recursive: true });
  const maxCount = numberFlag(args, "max-count", DEFAULT_MAX_COUNT);
  if (maxCount > 0) {
    const pending = database?.prepare("SELECT path FROM workspace WHERE root=? AND state='creating'").all(root) ?? [];
    const count = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && path.join(root, entry.name) !== reservedPath).length +
      pending.filter((record) => record.path !== reservedPath && !existsSync(record.path)).length;
    if (count >= maxCount) fail(`workspace root has ${count} checkouts; limit is ${maxCount}. Reconcile it before creating another.`);
  }
  const device = String(statSync(root).dev);
  const reservations = prior?.reservations ?? capacityReservations(database, device, reservedPath);
  for (const failure of reservations.measurementFailures ?? []) {
    process.stderr.write(`capacity measurement unavailable at ${failure.path}; original budget ${(failure.reservedBytes / 1024 ** 3).toFixed(2)} GiB (current pricing is in capacity-detail): ${failure.error}\n`);
  }
  const stats = statfsSync(root);
  const freeBytes = stats.bavail * stats.bsize;
  const minimum = Math.ceil(numberFlag(args, "min-free-gib", DEFAULT_MIN_FREE_GIB) * 1024 ** 3);
  const requirement = capacityRequirement(plan ?? { intent: "unestimated", constructionBytes: minimum, headroomBytes: 0, growthBytes: 0 }, reservations.priced, reservations.headroomBytes);
  let priorEvidence;
  if (prior?.kind === "reduction") {
    const replacedPlan = prior.plan;
    // Both requirements use ONE physical observation and ONE unchanged set of
    // other reservations. This retires existing liability; it creates no space
    // and grants no new writes even when the host is already oversubscribed.
    const previousRequiredBytes = capacityRequirement(replacedPlan, reservations.priced, reservations.headroomBytes);
    const deficitBytesBefore = Math.max(0, previousRequiredBytes - freeBytes);
    const deficitBytesAfter = Math.max(0, requirement - freeBytes);
    if (plan.constructionBytes !== 0 || replacedPlan.constructionBytes !== 0 ||
        plan.growthBytes >= replacedPlan.growthBytes || requirement >= previousRequiredBytes ||
        plan.headroomBytes < Math.max(replacedPlan.headroomBytes, 8 * 1024 ** 3) ||
        deficitBytesAfter > deficitBytesBefore) {
      growthError("unsafe-growth-reduction", "replacement must strictly lower existing liability without worsening the capacity deficit");
    }
    priorEvidence = {kind:"monotone-reduction", previousRequiredBytes, deficitBytesBefore, deficitBytesAfter,
      releasedReservationBytes:previousRequiredBytes-requirement, newWritesAuthorized:false};
  } else if (prior?.kind === "reprice") {
    // ONE physical observation and ONE set of other reservations price both the
    // liability this workspace already holds and the one it asks for. A re-price
    // that adds nothing is admitted even on an oversubscribed device: it cannot
    // worsen the deficit. Any real increment must fit the whole ledger.
    const { reservedBytes, headroomBytes } = prior.liability;
    for (const value of [reservedBytes, headroomBytes]) if (!Number.isSafeInteger(value) || value < 0) fail("invalid prior capacity liability");
    const previousRequiredBytes = reservedBytes + Math.max(headroomBytes, reservations.headroomBytes) +
      reservations.priced.reduce((sum, bytes) => sum + bytes, 0);
    const incrementalBytes = requirement - previousRequiredBytes;
    priorEvidence = {kind: incrementalBytes <= 0 ? "reprice-within-reservation" : "reprice-increment",
      previousRequiredBytes, incrementalBytes, deficitBytesBefore: Math.max(0, previousRequiredBytes - freeBytes),
      deficitBytesAfter: Math.max(0, requirement - freeBytes)};
  }
  if (prior?.kind !== "reduction" && priorEvidence?.kind !== "reprice-within-reservation") {
    for(const row of reservations.unknown??[]) {
      let ancestor=row.root;
      while(!existsSync(ancestor)&&ancestor!==path.dirname(ancestor))ancestor=path.dirname(ancestor);
      if(String(statSync(ancestor).dev)!==device)continue;
      if(creationFenceBusy(database,row.path))growthError('capacity-reservation-unknown','active legacy creation has no priced promise; reconcile its original admission');
      reservations.unpricedDormant++;
    }
  }
  if (prior?.kind !== "reduction" && !(priorEvidence?.kind === "reprice-within-reservation") && freeBytes < requirement) {
    const capacity = { freeBytes, requiredBytes: requirement, device, observedAt: Date.now(),
      breakdown: capacityRefusalDetails(plan ?? { intent: "unestimated", constructionBytes: minimum, headroomBytes: 0, growthBytes: 0 }, reservations),
      ...(priorEvidence === undefined ? {} : { reprice: priorEvidence }) };
    // The guarded create wrapper preserves stderr but not thrown object fields.
    // Carry the complete typed observation in both retained forecast and stderr,
    // without another filesystem/reservation read or a new admission attempt.
    throw Object.assign(new CliError(`${(freeBytes / 1024 ** 3).toFixed(2)} GiB is free; ${(requirement / 1024 ** 3).toFixed(2)} GiB is required${plan?.intent !== undefined && plan.intent !== "unestimated" ? " (source forecast + declared growth + operating headroom + other reservations)" : " (unestimated full work + other reservations)"}\ncapacity-detail: ${JSON.stringify(capacity)}`),
      { code: "workspace-capacity-refused", capacity });
  }
  const freeInodes = stats.files > 0 ? 100 * stats.ffree / stats.files : 100;
  const minFreeInodes = numberFlag(args, "min-free-inodes-percent", DEFAULT_MIN_FREE_INODES_PERCENT);
  if (freeInodes < minFreeInodes) fail(`${freeInodes.toFixed(2)}% of inodes are free; ${minFreeInodes.toFixed(2)}% is required`);
  return { ...priorEvidence, freeBytes, requiredBytes: requirement, reservedBytes: reservations.priced.reduce((sum, bytes) => sum + bytes, 0),
    sharedHeadroomBytes: reservations.headroomBytes, unpricedDormant: reservations.unpricedDormant,
    ...(reservations.observation ? {otherReservationsObservation:reservations.observation,otherAllocationSamplesRead:reservations.samplesRead===true} : {}),
    ...(reservations.measurementFailures ? { measurementFailures: reservations.measurementFailures } : {}) };
}

function safeName(value) {
  const result = value.replace(/[^a-zA-Z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 100);
  if (result.length === 0) fail("workspace name is empty after normalization");
  return result;
}

function mirrorFor(statePath, repository) {
  const digest = createHash("sha256").update(repository).digest("hex").slice(0, 24);
  return path.join(path.dirname(statePath), "mirrors", `${digest}.git`);
}

function repositoryLocation(value, directory) {
  if (path.isAbsolute(value) || /^[^/\s]+:/u.test(value)) return value;
  if (directory === undefined) {
    fail("the current directory was removed; --repo must be an absolute path or a Git URL");
  }
  return path.resolve(directory, value);
}

function repositoryRemotes(repository) {
  if (!existsSync(repository)) return { fetch: repository, push: repository };
  const valid = command("git", ["-C", repository, "rev-parse", "--git-dir"]);
  if (valid.status !== 0) return { fetch: repository, push: repository };
  const fetch = command("git", ["-C", repository, "remote", "get-url", "origin"]);
  if (fetch.status !== 0 || fetch.stdout.length === 0) return { fetch: repository, push: repository };
  const push = command("git", ["-C", repository, "remote", "get-url", "--push", "origin"]);
  const explicitPush = command("git", ["-C", repository, "config", "--get-all", "remote.origin.pushurl"]);
  const directory = realpathSync(repository);
  return {
    explicitPush: explicitPush.status === 0 && explicitPush.stdout.length > 0,
    fetch: repositoryLocation(fetch.stdout, directory),
    push: repositoryLocation(push.status === 0 && push.stdout.length > 0 ? push.stdout : fetch.stdout, directory),
  };
}

// Do not turn an effective host pushInsteadOf route into an explicit grant. Explicit
// source grants remain intact, except Converge's redundant HTTPS default: pinning it
// disables the host's work deploy-key route (including workflow-file pushes).
function needsExplicitPushUrl(upstream) {
  const convergeDefault = /^https:\/\/github\.com\/owi-link\/converge(?:\.git)?$/u.test(upstream.fetch)
    && upstream.push === upstream.fetch;
  return !convergeDefault && (upstream.explicitPush ?? upstream.push !== upstream.fetch);
}

function configurePushUrl(gitArgs, upstream) {
  if (needsExplicitPushUrl(upstream)) {
    run("git", [...gitArgs, "remote", "set-url", "--push", "origin", upstream.push]);
  } else if (command("git", [...gitArgs, "config", "--get", "remote.origin.pushurl"]).status === 0) {
    run("git", [...gitArgs, "config", "--unset-all", "remote.origin.pushurl"]);
  }
}

const heldResourceLocks = new Map();

function withWorkspaceLock(database, workspacePath, action, requestedGroupId, deadline) {
  const statePath = registryPaths.get(database);
  const resolved = path.resolve(workspacePath);
  const existing = database.prepare("SELECT group_id, state FROM workspace WHERE path = ?").get(resolved);
  const groupId = existing?.state !== "released" ? existing?.group_id ?? requestedGroupId : requestedGroupId;
  const checkout = () => withResourceLock(statePath, `checkout:${resolved}`, action, deadline);
  return groupId ? withResourceLock(statePath, `group:${groupId}`, checkout, deadline) : checkout();
}

const heldResourceModes = new Map();
let sourcePreparationPhase = null;

function publishSourcePhase(value) {
  sourcePreparationPhase = value.phase;
  if (sourceJobDirectory !== null) writeSourceJobProgress(sourceJobDirectory, value);
}

// Shared holders of one key run concurrently; an exclusive holder excludes everyone.
// A busy wait carries every live recorded holder with its current phase.
function withResourceLock(statePath, key, action, deadline, { mode = "exclusive", waitMs: budgetMs = 30_000 } = {}) {
  const identity = `${statePath}\0${key}`;
  if (heldResourceLocks.has(identity)) {
    if (heldResourceModes.get(identity) === "shared" && mode === "exclusive") throw new Error(`defect: lock upgrade requested for ${key}`);
    return action();
  }
  const directory = path.join(path.dirname(statePath), "locks");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const name = createHash("sha256").update(key).digest("hex");
  const file = path.join(directory, name);
  const holders = path.join(path.dirname(statePath), "lock-holders");
  const descriptor = openSync(file, "a", 0o600);
  let releaseRecord = null;
  try {
    const effectiveDeadline=maintenanceContext?.journal.deadline ?? deadline;
    const waitMs = effectiveDeadline === undefined ? budgetMs : Math.max(0, Math.min(100, effectiveDeadline - Date.now()-250));
    const started = Date.now();
    const result = spawnSync("flock", [mode === "shared" ? "--shared" : "--exclusive", "--wait", String(waitMs / 1000), "3"], {
      stdio: ["ignore", "pipe", "pipe", descriptor], encoding: "utf8", timeout: waitMs + 1000,
    });
    if (result.status !== 0) {
      const error = new ResourceBusyError(`workspace resource busy: ${key}: ${result.error?.message || result.stderr?.trim() || `${waitMs}ms lock budget exhausted`}`);
      // flock exit 1 with no diagnostic is an exhausted wait, not a failed import.
      // Mark only the capacity acquisition boundary, never action() or mirror failures.
      if (/^capacity:[0-9]+$/u.test(key) && result.status === 1 && !result.error && !result.stderr?.trim()) error.code = "workspace-capacity-lock-busy";
      if (/^mirror(-source)?:/u.test(key) && result.status === 1 && !result.error && !result.stderr?.trim()) error.code = "workspace-mirror-lock-busy";
      error.detail = { lock: key, mode, waitedMs: Date.now() - started, waiterPhase: sourcePreparationPhase,
        waiterJob: sourceJobDirectory, holders: observeLockHolders(holders, name) };
      throw error;
    }
    heldResourceLocks.set(identity, descriptor);
    heldResourceModes.set(identity, mode);
    releaseRecord = recordLockHolder(holders, name, { key, mode, job: sourceJobDirectory, phase: sourcePreparationPhase });
    return action();
  } finally {
    releaseRecord?.();
    heldResourceLocks.delete(identity);
    heldResourceModes.delete(identity);
    closeSync(descriptor);
  }
}

function sourceRefFor(repository, ref) {
  return `refs/pi-workspace/sources/${createHash("sha256").update(`${repository}\0${ref}`).digest("hex")}`;
}

function renameAlternate(file, objectSource) {
  if (maintenanceContext) return maintenanceEffect('alternates-replacement', {file,objectSource}, () => {
    const temporary=`${file}.maintain-${maintenanceContext.journal.operation}`;
    const descriptor=openSync(temporary,'wx',0o600);
    try{writeFileSync(descriptor,`${objectSource}\n`);fsyncSync(descriptor);}finally{closeSync(descriptor);}
    renameSync(temporary,file);const parent=openSync(path.dirname(file),'r');try{fsyncSync(parent);}finally{closeSync(parent);}return null;
  });
  const temporary = `${file}.${randomUUID()}`;
  try {
    writeFileSync(temporary, `${objectSource}\n`, { flag: "wx", mode: 0o600 });
    renameSync(temporary, file);
  } finally { rmSync(temporary, { force: true }); }
}

function stabilizeObjectCustody(workspace, alternates, execute, statePath) {
  if (!statePath) fail("reference clone custody requires the owning workspace registry");
  const mirrorRoot = path.join(path.dirname(statePath), "mirrors");
  const objectDirectory = path.dirname(path.dirname(alternates));
  const stores = readFileSync(alternates, "utf8").split("\n").filter(Boolean)
    .map(value => path.resolve(objectDirectory, value));
  if (stores.every(store => existsSync(store) && path.basename(store) === "objects"
    && path.dirname(path.dirname(store)) === mirrorRoot
    && !existsSync(path.join(store, "info", "alternates")))) return "durable-mirror";
  if (!execute) return "would-import-durable-mirror";
  const upstream = repositoryRemotes(workspace);
  const mirror = mirrorFor(statePath, upstream.fetch);
  withResourceLock(statePath, `mirror:${mirror}`, () => {
    prepareMirror(statePath, mirror, workspace, upstream);
    const collectObjects = () => [...new Set([
      git(workspace, ["rev-parse", "--verify", "HEAD"]),
      ...git(workspace, ["for-each-ref", "--format=%(objectname)"]).split("\n"),
      ...git(workspace, ["reflog", "--all", "--format=%H"]).split("\n"),
].filter(Boolean))];
    const objects=maintenanceContext ? maintenanceContext.journal.freeze(`objects:${workspace}`,collectObjects) : collectObjects();
    const refs = [...objects].map(object => `+${object}:refs/pi-workspace/objects/${object}`);
    for (let index = 0; index < refs.length; index += 128) {
      run("git", ["--git-dir", mirror, "fetch", "--no-tags", "--no-auto-maintenance", workspace,
        ...refs.slice(index, index + 128)], { timeout: 120_000 });
    }
    renameAlternate(alternates, path.join(mirror, "objects"));
  });
  return "imported-durable-mirror";
}

const closureEnvironment = { GIT_NO_LAZY_FETCH: "1", GIT_NO_REPLACE_OBJECTS: "1", GIT_ALTERNATE_OBJECT_DIRECTORIES: "" };

const IMMUTABLE_PACK_FILE = /^pack-[0-9a-f]{40,64}\.(pack|idx|rev|bitmap)$/u;

// Same-filesystem local sources lend their packs to the mirror by hard link
// (mirror-pack-sharing.mjs), so a local import copies no object bytes.
function shareLocalMirrorPacks(statePath, mirror, sources) {
  const shared = shareMirrorPacks({ mirror, sources: [...sources, ...configuredLocalSources(mirror)],
    exclusive: action => {
      try { return withResourceLock(statePath, `mirror-pack-share:${mirror}`, action, undefined, { waitMs: 1000 }); }
      catch (error) { if (error instanceof ResourceBusyError) return null; throw error; }
    } });
  if (!shared.ok) process.stderr.write(`agent-workspace: mirror pack sharing skipped for ${mirror}: ${shared.error.code}: ${shared.error.detail}\n`);
  return shared;
}

function objectStoreStamp(mirror) {
  const objects = path.join(mirror, "objects");
  if (!existsSync(objects)) return null;
  const digest = createHash("sha256");
  const add = file => {
    try {
      const s = statSync(file, { bigint: true });
      digest.update(`${file}\0${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}\n`);
    } catch (error) { if (error.code !== "ENOENT") throw error; digest.update(`${file}\0absent\n`); }
  };
  // Pack files never change in place. A source sharing them by hard link freshens
  // their times on every push; that is not a change to the mirror's objects.
  const addImmutable = file => {
    try {
      const s = statSync(file, { bigint: true });
      digest.update(`${file}\0${s.dev}:${s.ino}:${s.size}\n`);
    } catch (error) { if (error.code !== "ENOENT") throw error; digest.update(`${file}\0absent\n`); }
  };
  add(objects);
  for (let byte = 0; byte < 256; byte++) add(path.join(objects, byte.toString(16).padStart(2, "0")));
  for (const directory of ["pack", "info"]) {
    const root = path.join(objects, directory); add(root);
    if (existsSync(root)) for (const name of readdirSync(root).sort()) (directory === "pack" && IMMUTABLE_PACK_FILE.test(name) ? addImmutable : add)(path.join(root, name));
  }
  for (const name of ["shallow", "config"]) add(path.join(mirror, name));
  return digest.digest("hex");
}

function sourceTree(repository, commit, sparsePatterns) {
  const entries = [];
  streamRecords("git", ["-C", repository, "ls-tree", "-rz", commit], "\0", entry => {
    const match = entry.match(/^(\d+) (blob|commit) ([0-9a-f]+)\t(.+)$/su);
    if (match === null) fail("source capacity estimate unknown: malformed Git tree entry");
    const [, mode, type, hash, name] = match;
    entries.push({ mode, type, hash, name });
  }, { env: closureEnvironment });
  const selected = sparseSourcePaths(entries, sparsePatterns);
  const needed = entries.filter(entry => entry.type === "blob" && (selected === null || selected.has(entry.name) || entry.name.endsWith(".gitattributes")));
  const rows = [];
  if (needed.length > 0) {
    const result = command("git", ["-C", repository, "cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"],
      { env: closureEnvironment, input: needed.map(entry => entry.hash).join("\n") + "\n",
        records: { separator: "\n", onRecord: row => { if (row !== "") rows.push(row); } } });
    if (result.status !== 0 || result.error) fail("source capacity estimate unknown: selected source object is unavailable");
  }
  if (rows.length !== needed.length) fail("source capacity estimate unknown: selected source object is unavailable");
  for (let index = 0; index < needed.length; index++) {
    const match = rows[index].match(/^([0-9a-f]+) blob (\d+)$/u);
    if (match === null || match[1] !== needed[index].hash) fail("source capacity estimate unknown: selected source object is unavailable");
    needed[index].size = match[2];
  }
  return { entries, selected };
}

function hasObjectClosure(mirror, commit, sparsePatterns = [], refresh = false) {
  if (!existsSync(mirror) || existsSync(path.join(mirror, "objects", "info", "alternates"))) return false;
  const before = objectStoreStamp(mirror);
  if (before === null) return false;
  const key = createHash("sha256").update(JSON.stringify([commit, sparsePatterns])).digest("hex");
  const directory = path.join(mirror, "pi-workspace-closure");
  const file = path.join(directory, `${key}.json`);
  if (existsSync(file)) {
    const cached = JSON.parse(readFileSync(file, "utf8"));
    if (!refresh && cached.version === 1 && cached.stamp === before && cached.commit === commit) return true;
  }
  let verified;
  if (sparsePatterns.length === 0) {
    verified = command("git", ["--git-dir", mirror, "rev-list", "--objects", "--quiet", "--missing=error", `${commit}^{commit}`],
      { env: closureEnvironment }).status === 0;
  } else {
    const root = command("git", ["--git-dir", mirror, "cat-file", "-e", `${commit}^{tree}`], { env: closureEnvironment });
    if (root.status !== 0) return false;
    try { sourceTree(mirror, commit, sparsePatterns); verified = true; }
    catch (error) { if (!(error instanceof CliError)) throw error; return false; }
  }
  if (!verified) return false;
  // Concurrent imports only add objects; a moved stamp invalidates memoization, not the proof.
  if (objectStoreStamp(mirror) !== before) return true;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}`;
  writeFileSync(temporary, JSON.stringify({ version: 1, commit, sparsePatterns, stamp: before }), { mode: 0o600 });
  renameSync(temporary, file);
  return true;
}

function cachedImmutableSource(mirror, repository, ref, sparsePatterns) {
  if (!/^[0-9a-f]{40}$/u.test(ref) || !existsSync(mirror)) return null;
  if (existsSync(path.join(mirror, "objects", "info", "alternates"))) fail(`shared mirror must own its objects independently: ${mirror}`);
  const cached = command("git", ["--git-dir", mirror, "rev-parse", "--verify", `${sourceRefFor(repository, ref)}^{commit}`]);
  return cached.status === 0 && cached.stdout === ref && hasObjectClosure(mirror, ref, sparsePatterns) ? ref : null;
}

function resolveRequestedSource(repository, ref) {
  if (existsSync(repository)) {
    const resolved = command("git", ["-C", repository, "rev-parse", "--verify", `${ref}^{commit}`]);
    if (resolved.status !== 0) fail(`cannot resolve source ${ref}: ${resolved.stderr}`);
    ref = resolved.stdout;
  } else if (!/^[0-9a-f]{4,40}$/u.test(ref)) {
    const candidates = [ref, `refs/heads/${ref}`, `refs/tags/${ref}`];
    const advertised = run("git", ["ls-remote", "--exit-code", repository,
      ...candidates.flatMap(candidate => [candidate, `${candidate}^{}`])]);
    const refs = new Map(advertised.split("\n").map(line => {
      const [commit, name] = line.split(/\s+/u);
      return [name, commit];
    }));
    const named = candidates.find(candidate => refs.has(candidate));
    if (named === undefined) fail(`cannot resolve source ${ref}; provide an exact remote ref or full commit`);
    ref = refs.get(`${named}^{}`) ?? refs.get(named);
  }
  return ref;
}

// The mirror object store is shared custody: imports of different commits hold it
// shared and run concurrently (Git object writes are content-addressed and atomic).
// Only one import per commit runs; its peers wait for that in-flight result instead
// of failing a fixed budget. Exclusive mirror holders (maintenance import) still fence all.
const SOURCE_IMPORT_TIMEOUT_MS = 1_800_000;

function mirrorSourceLock(statePath, mirror, ref, action) {
  const foreground = sourcePreparationMode === "foreground";
  const deadline = foreground ? sourcePreparationDeadline : undefined;
  try {
    return withResourceLock(statePath, `mirror:${mirror}`, () =>
      withResourceLock(statePath, `mirror-source:${mirror}:${ref}`, action, deadline,
        { waitMs: sourcePreparationMode === "worker" ? SOURCE_IMPORT_TIMEOUT_MS + 60_000 : 30_000 }),
    deadline, { mode: "shared" });
  } catch (error) {
    if (foreground && error instanceof ResourceBusyError) throw new SourcePreparationRequired();
    throw error;
  }
}

function resolveSource(statePath, mirror, repository, upstream, ref, sparsePatterns = []) {
  ref = resolveRequestedSource(repository, ref);
  const cached = cachedImmutableSource(mirror, repository, ref, sparsePatterns);
  if (cached !== null) return cached;
  publishSourcePhase({ phase: "awaiting-mirror", commit: ref });
  return mirrorSourceLock(statePath, mirror, ref, () => {
    const shared = cachedImmutableSource(mirror, repository, ref, sparsePatterns);
    if (shared !== null) return shared;
    if (existsSync(path.join(mirror, "objects", "info", "alternates"))) fail(`shared mirror must own its objects independently: ${mirror}`);
    const existed = existsSync(mirror);
    if (existed) shareLocalMirrorPacks(statePath, mirror, [repository, upstream?.fetch]);
    if (/^[0-9a-f]{40}$/u.test(ref) && existed
      && hasObjectClosure(mirror, ref, sparsePatterns)) {
      return ensureSourceCustody(mirror, repository, ref, ref, sparsePatterns);
    }
    if (sourcePreparationMode === "foreground") throw new SourcePreparationRequired();
    publishSourcePhase({ phase: "importing", commit: ref });
    prepareMirror(statePath, mirror, repository, upstream);
    if (!existed) shareLocalMirrorPacks(statePath, mirror, [repository, upstream?.fetch]);
    if (/^[0-9a-f]{4,39}$/u.test(ref)) {
      withResourceLock(statePath, `mirror-origin:${mirror}`, () =>
        run("git", ["--git-dir", mirror, "fetch", "--prune", "--no-tags", "--no-write-fetch-head", "origin"], { timeout: 120_000 }));
    }
    return fetchSource(mirror, repository, ref, sparsePatterns);
  });
}

function prepareMirror(statePath, mirror, repository, upstream) {
  maintenanceEffect('mirror-directory',{directory:path.dirname(mirror)},()=>{mkdirSync(path.dirname(mirror), { recursive: true, mode: 0o700 });return null;});
  const configure = () => {
    if (!existsSync(mirror)) run("git", ["init", "--bare", mirror]);
    if (existsSync(path.join(mirror, "objects", "info", "alternates"))) fail(`shared mirror must own its objects independently: ${mirror}`);
    const readConfig = () => {
      const listed = command("git", ["--git-dir", mirror, "config", "--local", "--list", "-z"]);
      if (listed.status !== 0) fail(`cannot read mirror configuration: ${listed.stderr || listed.error?.message || `exit ${listed.status}`}`);
      const values = new Map();
      for (const entry of listed.stdout.split("\0").filter(Boolean)) {
        const split = entry.indexOf("\n");
        const name = split < 0 ? entry : entry.slice(0, split);
        values.set(name, [...(values.get(name) ?? []), split < 0 ? "" : entry.slice(split + 1)]);
      }
      return values;
    };
    // Observed under the configuration fence each time, so a resumed operation writes only what is still missing.
    const current = readConfig();
    const has = (name, value) => { const values = current.get(name.toLowerCase()); return values?.length === 1 && values[0] === value; };
    for (const [name, value] of Object.entries({ ...REFERENCE_CLONE_CONFIG, "fetch.unpackLimit": "1" })) {
      if (!has(name, value)) run("git", ["--git-dir", mirror, "config", "--local", name, value]);
    }
    for (const [name, url] of [["origin", upstream.fetch], ["workspace-source", repository]]) {
      if (has(`remote.${name}.url`, url)) continue;
      run("git", ["--git-dir", mirror, "remote", current.has(`remote.${name}.url`) ? "set-url" : "add", name, url]);
    }
    const explicitPush = needsExplicitPushUrl(upstream);
    if (explicitPush ? !has("remote.origin.pushurl", upstream.push) : current.has("remote.origin.pushurl")) {
      configurePushUrl(["--git-dir", mirror], upstream);
    }
    if (!has("remote.origin.mirror", "false")) run("git", ["--git-dir", mirror, "config", "remote.origin.mirror", "false"]);
    if (!has("remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*")) run("git", [
      "--git-dir", mirror, "config", "--replace-all", "remote.origin.fetch",
      "+refs/heads/*:refs/remotes/origin/*",
    ]);
  };
  // Git's config.lock refuses concurrent writers; mirror configuration has its own short fence.
  return statePath ? withResourceLock(statePath, `mirror-config:${mirror}`, configure) : configure();
}

// A successful fetch is object transport, not a durable source-ref commit. An
// interrupted import may have all objects but no ref. Recover only the exact
// independently verified closure, never a mutable donor HEAD or another ref.
function ensureSourceCustody(mirror, repository, ref, expected, sparsePatterns = []) {
  if (!/^[0-9a-f]{40}$/u.test(expected) || !hasObjectClosure(mirror, expected, sparsePatterns)) {
    fail(`fetched source has incomplete object closure: ${expected}`);
  }
  const sourceRef = sourceRefFor(repository, ref);
  const current = command("git", ["--git-dir", mirror, "rev-parse", "--verify", `${sourceRef}^{commit}`]);
  if (current.status === 0 && current.stdout !== expected) fail(`source custody conflict at ${sourceRef}: expected ${expected}, observed ${current.stdout}`);
  if (current.status !== 0) {
    // No blind overwrite: another producer's publication must agree. Fsync the
    // reference transaction (and imported objects) before publishing READY.
    const published = command("git", ["-c", "core.fsync=loose-object,pack,reference", "-c", "core.fsyncMethod=fsync",
      "--git-dir", mirror, "update-ref", sourceRef, expected, ""]);
    if (published.status !== 0) {
      const peer = command("git", ["--git-dir", mirror, "rev-parse", "--verify", `${sourceRef}^{commit}`]);
      if (peer.status !== 0 || peer.stdout !== expected) fail(`source custody publication failed at ${sourceRef}: ${commandFailureDetail(published)}`);
    }
  }
  const committed = run("git", ["--git-dir", mirror, "rev-parse", "--verify", `${sourceRef}^{commit}`]);
  if (committed !== expected) fail(`source custody changed at ${sourceRef}: expected ${expected}, observed ${committed}`);
  return expected;
}

const isLocalRepository = repository => path.isAbsolute(repository) && existsSync(repository);

// A local source has every object, so a gap in the mirror is filled by packing just the missing objects from it
// straight into the mirror's pack directory. --refetch would copy the commit's entire history instead: on
// 2026-10-30 it wrote a 22 GiB temporary pack of the 52 GiB seinari remote into its mirror until root ran out.
// A missing tree hides its children from rev-list, so repeat until nothing is missing (bounded by tree depth).
function copyMissingObjects(mirror, repository, commit) {
  for (let round = 0; round < 64; round++) {
    // Only the missing names come back: a whole tree's listing can pass the output buffer.
    const listed = command("sh", ["-c", 'set -o pipefail; git --git-dir "$1" rev-list --objects --no-object-names --missing=print "$2^{commit}" | { grep "^?" || test $? = 1; }',
      "sh", mirror, commit], { env: closureEnvironment, timeout: SOURCE_IMPORT_TIMEOUT_MS });
    if (listed.status !== 0) return false;
    const missing = listed.stdout.split("\n").filter(line => line.startsWith("?")).map(line => line.slice(1));
    if (missing.length === 0) return true;
    const packed = command("git", ["-C", repository, "pack-objects", "--quiet", path.join(mirror, "objects", "pack", "pack")],
      { input: missing.join("\n") + "\n", timeout: SOURCE_IMPORT_TIMEOUT_MS });
    if (packed.status !== 0) return false;
  }
  return false;
}

function fetchSource(mirror, repository, ref, sparsePatterns) {
  let resolved = ref;
  if (/^[0-9a-f]{4,39}$/u.test(ref)) {
    const source = existsSync(repository) ? ["-C", repository] : ["--git-dir", mirror];
    const commit = command("git", [...source, "rev-parse", "--verify", `${ref}^{commit}`]);
    if (commit.status !== 0) fail(`cannot resolve abbreviated source ${ref}; provide an unambiguous full commit or remote ref: ${commit.stderr}`);
    resolved = commit.stdout;
  }
  const sourceRef = sourceRefFor(repository, ref);
  // Negotiate from independently complete ancestry when there is one, else from the mirror's refs.
  // Git skips wanting a commit object it already has, so a present commit with missing trees or blobs is repaired only by --refetch.
  const commitPresent = /^[0-9a-f]{40,64}$/u.test(resolved) && command("git", ["--git-dir", mirror, "cat-file", "-e", `${resolved}^{commit}`]).status === 0;
  // Fetch the request's own repository, not the shared remote name another import may be rewriting.
  const fetch = negotiation => run("git", ["--git-dir", mirror, "-c", "core.fsync=loose-object,pack,reference", "-c", "core.fsyncMethod=fsync", "fetch", ...negotiation, "--update-shallow", "--no-tags", "--no-auto-maintenance", "--no-write-fetch-head", repository, `+${resolved}:${sourceRef}`], { timeout: sourcePreparationMode === "worker" ? SOURCE_IMPORT_TIMEOUT_MS : 120_000 });
  // A present commit with its whole closure needs no transfer (shared local packs land here).
  // Otherwise fetch incrementally and prove the closure. A gap left by a local source is
  // filled by copying just the missing objects; only a remote gap (or a failed copy) pays for --refetch,
  // which copies the commit's entire history.
  if (!(commitPresent && hasObjectClosure(mirror, resolved, sparsePatterns))) {
    if (!commitPresent) fetch((existsSync(repository) ? importBaseCommits(repository, resolved, mirror) : []).map(tip => `--negotiation-tip=${tip}`));
    if (!hasObjectClosure(mirror, resolved, sparsePatterns) && !(isLocalRepository(repository) && copyMissingObjects(mirror, repository, resolved)
      && hasObjectClosure(mirror, resolved, sparsePatterns))) fetch(["--refetch"]);
  }
  publishSourcePhase({ phase: "verifying", commit: resolved });
  return ensureSourceCustody(mirror, repository, ref, resolved, sparsePatterns);
}

// Clone uses a temporary source remote, so Git does not create origin's fetch mapping.
// Install it before materialization, and repair older interrupted clones at either exit.
// Preserve explicit caller mappings and never invent a published remote-tracking ref.
function ensureOriginFetch(destination) {
  const current = command("git", ["-C", destination, "config", "--local", "--get-all", "remote.origin.fetch"]);
  if (current.status === 0 && current.stdout.length > 0) return;
  if (current.status !== 0 && current.status !== 1) fail(`cannot read origin fetch configuration: ${current.stderr || current.error?.message}`);
  git(destination, ["config", "--local", "--replace-all", "remote.origin.fetch", ORIGIN_FETCH_REFSPEC]);
}

function cloneSourceTag(statePath, mirror, sourceCommit) {
  const name = `pi-workspace-source-${sourceCommit}`;
  const ref = `refs/tags/${name}`;
  const read = () => command("git", ["--git-dir", mirror, "rev-parse", "--verify", ref]);
  const existing = read();
  if (existing.status === 0 && existing.stdout === sourceCommit) return name;
  return mirrorSourceLock(statePath, mirror, sourceCommit, () => {
    const current = read();
    if (current.status === 0 && current.stdout !== sourceCommit) fail(`clone source custody differs at ${ref}`);
    if (current.status !== 0) run("git", ["--git-dir", mirror, "update-ref", ref, sourceCommit, ""]);
    return name;
  });
}

function inheritShallowBoundary(directory, mirror) {
  const read = file => {
    try { return readFileSync(file, "utf8").split("\n").filter(Boolean); }
    catch (error) { if (error.code === "ENOENT") return []; throw error; }
  };
  const inherited = read(path.join(mirror, "shallow"));
  if (inherited.length === 0) return;
  const target = path.join(directory, "shallow");
  const existing = read(target);
  const boundaries = [...new Set([...existing, ...inherited])];
  if (boundaries.some(id => !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(id))) {
    fail("shared source has invalid shallow boundary metadata");
  }
  if (boundaries.length === existing.length) return;
  // Alternates share objects, not Git's shallow metadata. Publish the actual
  // donor boundaries before refs, never invent a boundary at a missing parent.
  const lock = `${target}.lock`;
  const descriptor = openSync(lock, "wx", 0o600);
  try {
    try { writeFileSync(descriptor, `${boundaries.join("\n")}\n`); fsyncSync(descriptor); }
    finally { closeSync(descriptor); }
    renameSync(lock, target);
    const parent = openSync(directory, "r");
    try { fsyncSync(parent); } finally { closeSync(parent); }
  } finally { rmSync(lock, { force: true }); }
}

function prepareSharedSourceClone(destination, repository, sourceCommit, input, mirror) {
  const objectSource = path.join(mirror, "objects");
  if (!existsSync(path.join(destination, ".git"))) {
    if (existsSync(destination) && readdirSync(destination).length !== 0) fail("pending shared-source directory has non-Git files");
    run("git", ["init", "-b", input.branch, destination]);
  }
  const rawDirectory = git(destination, ["rev-parse", "--absolute-git-dir"]);
  if (rawDirectory !== path.join(destination, ".git")) fail("pending shared source is not an independent clone");
  const alternates = path.join(rawDirectory, "objects", "info", "alternates");
  if (existsSync(alternates) && readFileSync(alternates, "utf8") !== `${objectSource}\n`) {
    fail("pending shared source object store differs; use maintain --path with --execute to import its current refs before resuming");
  }
  const head = command("git", ["-C", destination, "rev-parse", "--verify", "HEAD"]);
  if (head.status !== 0 && (existsSync(path.join(rawDirectory, "index")) || readdirSync(destination).some(name => name !== ".git"))) {
    fail("pending shared source lacks HEAD but contains materialized work; preserve it for repair");
  }
  const readOrigin = command("git", ["-C", destination, "config", "--local", "--get", "remote.origin.url"]);
  if (![0, 1].includes(readOrigin.status)) fail("cannot inspect pending shared source origin");
  const origin = readOrigin.status === 1 ? null : readOrigin.stdout;
  if (head.status !== 0 && git(destination, ["for-each-ref", "--format=%(refname)"]).split("\n").filter(Boolean)
    .some(name => name !== `refs/tags/pi-workspace-source-${sourceCommit}`)) fail("pending shared source lacks HEAD but has other source refs; preserve it for repair");
  if (origin !== null && origin !== repository) {
    if (head.status !== 0) fail("pending shared source origin differs");
    return;
  }
  if (!existsSync(alternates)) writeFileSync(alternates, `${objectSource}\n`);
  inheritShallowBoundary(rawDirectory, mirror);
  if (origin === null) git(destination, ["remote", "add", "origin", repository]);
  ensureOriginFetch(destination);
  for (const [name, value] of Object.entries({ ...REFERENCE_CLONE_CONFIG, "core.hooksPath": "/dev/null", "submodule.recurse": "false" })) {
    git(destination, ["config", "--local", name, value]);
  }
  const custodyRef = `refs/tags/pi-workspace-source-${sourceCommit}`;
  const custody = command("git", ["-C", destination, "rev-parse", "--verify", custodyRef]);
  if (custody.status === 0 && custody.stdout !== sourceCommit) fail("pending shared source custody tag differs");
  if (custody.status !== 0) git(destination, ["update-ref", custodyRef, sourceCommit, ""]);
  if (head.status !== 0) git(destination, ["update-ref", "--no-deref", "HEAD", sourceCommit]);
}

function prepareSourceValue(database, args, request) {
  const { statePath, root, destination, repository, upstream, mirror, intent, sparsePatterns, sourceCommit } = request;
  publishSourcePhase({ phase: "forecasting", commit: sourceCommit });
  const blockSize = statfsSync(root).bsize;
  const forecastPath = `${request.receipt}.forecast.json`;
  const inputs = { version: 4, repository, sourceCommit, intent, sparsePatterns, blockSize, stamp: objectStoreStamp(mirror) };
  const cached = existsSync(forecastPath) ? JSON.parse(readFileSync(forecastPath, "utf8")) : null;
  const fingerprint = sourceJobId("source-forecast", inputs);
  let plan = cached !== null && cached.fingerprint === fingerprint ? cached.plan : intent === null
    ? { intent: "unestimated", estimate: "unknown", constructionBytes: Math.ceil(numberFlag(args, "min-free-gib", DEFAULT_MIN_FREE_GIB) * 1024 ** 3), growthBytes: 0, headroomBytes: 0 }
    : sourceCapacityPlan(repository, sourceCommit, intent, blockSize, mirror, sparsePatterns);
  if (cached !== null && cached.fingerprint === fingerprint && intent !== null) {
    assertSourceCheckoutFilters(existsSync(repository) ? repository : mirror);
  }
  const forecast = { inputs, fingerprint, plan };
  writePreparationReceipt(forecastPath, forecast);
  const device = String(statSync(root).dev);
  let resolvedCommit;
  withCapacityAdmission(database, statePath, device, () => {
    const priorImport = database.prepare("SELECT receipt FROM workspace_source_capacity WHERE destination=?").get(destination);
    if (priorImport && priorImport.receipt !== request.receipt) throw new ResourceBusyError("source import retains capacity under a different original request; reconcile that operation first");
    try { plan.admission = assertCapacity(root, args, database, destination, plan); }
    catch (error) {
      if (error.code === "workspace-capacity-refused") writePreparationReceipt(forecastPath,
        { ...forecast, refusal: { code: error.code, capacity: error.capacity } });
      throw error;
    }
    // Reserve all priced liability atomically, then release the device fence before
    // mirror-lock waits, closure traversal and Git import. Independent mirrors proceed.
    database.prepare("INSERT OR REPLACE INTO workspace_source_capacity(destination,device_id,plan_json,receipt) VALUES(?,?,?,?)")
      .run(destination, device, JSON.stringify(plan), request.receipt);
  });
  try {
    const importSource = () => resolveSource(statePath, mirror, repository, upstream, sourceCommit, sparsePatterns);
    // Reservation-aware emergency rollback: retain schema2/accounting and serialize transport.
    resolvedCommit = process.env.PI_WORKSPACE_SERIAL_IMPORT === "1"
      ? withResourceLock(statePath, `capacity:${device}`, importSource) : importSource();
    if (!resolvedCommit.startsWith(sourceCommit)) fail("source preparation changed the requested commit");
    return { sourceCommit: resolvedCommit, plan, stamp: objectStoreStamp(mirror) };
  } finally {
    try {
      withResourceLock(statePath, `capacity:${device}`, () => {
        database.prepare("DELETE FROM workspace_source_capacity WHERE destination=? AND receipt=?").run(destination, request.receipt);
      });
    } catch (error) {
      // Import may already have happened. Never misclassify cleanup contention as
      // pre-import acquisition and authorize another generation from that receipt.
      throw Object.assign(new CliError(`source import capacity settlement failed; original liability retained: ${error.message}`), { code: "source-import-settlement-failed" });
    }
  }
}

// Object-store stamps invalidate closure memoization, not an immutable completed request.
// Refresh the proof before reusing a READY plan; never refetch merely because unrelated
// commits/config writes changed the shared mirror. Admission still recomputes capacity.
function revalidatePreparedSource(value, input, sourceCommit) {
  const priorMode = sourcePreparationMode, priorDeadline = sourcePreparationDeadline;
  sourcePreparationMode = "foreground";
  sourcePreparationDeadline = Math.min(priorDeadline, Date.now() + 1500);
  try { return revalidatePreparedSourceWithinBudget(value, input, sourceCommit); }
  finally { sourcePreparationMode = priorMode; sourcePreparationDeadline = priorDeadline; }
}
function revalidatePreparedSourceWithinBudget(value, input, sourceCommit, fenced = false) {
  if (value?.sourceCommit !== sourceCommit || value.plan?.sourceCommit !== sourceCommit) return null;
  const stamp = objectStoreStamp(input.mirror);
  if (stamp === null) return null;
  assertSourceCheckoutFilters(existsSync(input.repository) ? input.repository : input.mirror);
  assertSourceCheckoutFilters(input.mirror);
  if (!hasObjectClosure(input.mirror, sourceCommit, input.sparsePatterns, fenced)) return null;
  if (!fenced && objectStoreStamp(input.mirror) !== stamp) throw new SourcePreparationRequired();
  assertSourceCheckoutFilters(existsSync(input.repository) ? input.repository : input.mirror);
  assertSourceCheckoutFilters(input.mirror);
  if (existsSync(path.join(input.mirror, "objects", "info", "alternates"))) return null;
  return { ...value, stamp: objectStoreStamp(input.mirror) };
}

// A foreground deadline is not failed closure evidence. Continue the read-only
// proof in a durable child of the completed request, leaving its pointer, result,
// import identity and capacity accounting untouched.
function refreshCompletedSource(value, input, sourceCommit, receipt, key, originalJobId = null, args = null) {
  try {
    const refreshed = revalidatePreparedSource(value, input, sourceCommit);
    return refreshed === null ? null : { state: "ready", value: refreshed };
  } catch (error) {
    if (!(error instanceof SourcePreparationRequired)) throw error;
  }
  const continuationPath = `${receipt}.revalidation.json`;
  let request = existsSync(continuationPath) ? JSON.parse(readFileSync(continuationPath, "utf8")) : null;
  const jobs = path.join(path.dirname(receipt), "jobs");
  if (request !== null && existsSync(path.join(jobs, sourceJobId(`${key}:revalidation`, request), "result.json"))) request = null;
  if (request === null) {
    request = { kind: "completed-source-revalidation", input, sourceCommit, value,
      receipt, originalJobId, args: args?.named.has("root") && args.named.has("name") ? [...args.named] : null, observedStamp: objectStoreStamp(input.mirror) };
    writePreparationReceipt(continuationPath, request);
  }
  const job = runSourceJob({ directory: jobs,
    key: `${key}:revalidation`, request,
    command: [process.execPath, new URL(import.meta.url).pathname, "source-revalidate"],
    waitMs: 2000, restartInterrupted: true });
  if (job.state === "failed" || job.state === "interrupted" || job.state === "abandoned")
    fail(`completed source revalidation ${job.state}: ${job.error?.message ?? "automatic retry prohibited"}`);
  if (job.state !== "ready") return job;
  if (job.value === null) return null;
  if (job.value.stamp !== objectStoreStamp(input.mirror)) {
    // The next observation starts only another read-only proof, never an import.
    return { state: "pending", jobId: sourceJobId(`${key}:revalidation`, request),
      progressPath: path.join(path.dirname(receipt), "jobs", sourceJobId(`${key}:revalidation`, request), "progress.json"),
      resultPath: path.join(path.dirname(receipt), "jobs", sourceJobId(`${key}:revalidation`, request), "result.json") };
  }
  assertSourceCheckoutFilters(existsSync(input.repository) ? input.repository : input.mirror);
  assertSourceCheckoutFilters(input.mirror);
  return job;
}

function sourceRevalidationWorker() {
  const directory = process.env.PI_WORKSPACE_SOURCE_JOB_DIR;
  const loaded = readSourceJobRequest(directory);
  if (!loaded.ok) fail(loaded.error.message);
  const { input, value, sourceCommit, receipt, args: named } = loaded.value;
  sourcePreparationMode = "worker";
  const database = openRegistry(input.statePath);
  try {
    // Complete validation and the original admission in one mirror transaction.
    // A later foreground observer sees the admitted row, not an obsolete global
    // stamp. Imports cannot starve this proof and no new import is performed.
    const refreshed = withWorkspaceLock(database, input.destination, () =>
      withResourceLock(input.statePath, `source-preparation:${input.destination}`, () =>
        withResourceLock(input.statePath, `mirror:${input.mirror}`, () => {
          const proof = revalidatePreparedSourceWithinBudget(value, input, sourceCommit, true);
          if (proof !== null && named !== null && named !== undefined) {
            const args = { named: new Map(named), positional: [] };
            reservePreparedCreation(database, args, input.statePath, { ...input, sourceCommit }, proof);
          }
          return proof;
        })), named ? one({ named: new Map(named) }, "group") : undefined);
    if (refreshed !== null) writePreparationReceipt(receipt, refreshed);
    const result = finishSourceJob(directory, { state: "ready", value: refreshed });
    if (!result.ok) fail(result.error.message);
  } catch (error) {
    finishSourceJob(directory, { state: "failed", error: { code: "source-revalidation-failed", message: error.message } });
    throw error;
  } finally { database.close(); }
}

function prepareCreationSource(database, args, input) {
  let sourceCommit = input.sourceCommit ?? resolveRequestedSource(input.repository, input.ref);
  if (input.intent !== null && !/^[0-9a-f]{40}$/u.test(sourceCommit)) {
    const resolved = command("git", ["--git-dir", input.mirror, "rev-parse", "--verify", `${sourceCommit}^{commit}`]);
    if (resolved.status !== 0) fail("source capacity estimate unknown: remote commit is absent from durable mirror custody; remote import remains unestimated");
    sourceCommit = resolved.stdout;
  }
  const request = { ...input, sourceCommit, args: [...args.named], capacityPricingVersion: 4 };
  const key = createHash("sha256").update(JSON.stringify(request)).digest("hex");
  const directory = path.join(path.dirname(input.statePath), "source-preparations");
  const receipt = path.join(directory, `${key}.json`);
  const stamp = objectStoreStamp(input.mirror);
  if (stamp !== null && existsSync(receipt)) {
    const value = JSON.parse(readFileSync(receipt, "utf8"));
    if (value.sourceCommit === sourceCommit && value.stamp === stamp) {
      assertSourceCheckoutFilters(existsSync(input.repository) ? input.repository : input.mirror);
      assertSourceCheckoutFilters(input.mirror);
      return { state: "ready", value };
    }
    const refreshed = refreshCompletedSource(value, input, sourceCommit, receipt, key, null, args);
    if (refreshed !== null) {
      if (refreshed.state === "ready") writePreparationReceipt(receipt, refreshed.value);
      return refreshed;
    }
  }
  const pointerPath = path.join(directory, `${key}.job.json`);
  let pointer = existsSync(pointerPath) ? JSON.parse(readFileSync(pointerPath, "utf8")) : null;
  const observeJob = () => runSourceJob({ directory: path.join(directory, "jobs"), key,
    request: { ...request, initialStamp: pointer.initialStamp, receipt, ...(pointer.recovery ? { recovery: pointer.recovery } : {}) },
    command: [process.execPath, new URL(import.meta.url).pathname, "source-prepare"], env: {}, waitMs: 2000, restartInterrupted: true });
  const accepted = job => {
    if (job.jobId && pointer.jobId !== job.jobId) writePreparationReceipt(pointerPath, { ...pointer, jobId: job.jobId });
    if (job.state === "abandoned") fail("source job explicitly ABANDONED; historical effects UNKNOWN_RETAINED; automatic retry prohibited");
    if (job.state === "failed" || job.state === "interrupted") fail(`source preparation ${job.state}: ${job.error?.code}: ${job.error?.message}; job ${pointer.jobId}; progress ${job.progressPath ?? path.join(directory, "jobs", pointer.jobId, "progress.json")}${job.error?.detail ? `; lock detail ${JSON.stringify(job.error.detail)}` : ""}`);
    return job;
  };
  if (pointer !== null && !pointer.jobId) {
    pointer = { ...pointer, jobId: sourceJobId(key, { ...request, initialStamp: pointer.initialStamp, receipt,
      ...(pointer.recovery ? { recovery: pointer.recovery } : {}) }) };
    writePreparationReceipt(pointerPath, pointer);
  }
  if (pointer !== null && pointer.jobId) {
    const terminalPath = path.join(directory, "jobs", pointer.jobId, "result.json");
    if (!existsSync(terminalPath)) return accepted(observeJob());
    const terminal = JSON.parse(readFileSync(terminalPath, "utf8"));
    if (terminal.state !== "ready") {
      const stats = statfsSync(input.root);
      const observation = { observedAt: Date.now(), device: String(statSync(input.root).dev),
        freeBytes: stats.bavail * stats.bsize, freeInodes: stats.ffree, totalInodes: stats.files };
      const recovery = capacityRecovery(terminal, pointer.jobId, observation, input.mirror);
      if (recovery.state === "invalid") fail(`${recovery.error.code}: ${recovery.error.message}`);
      if (recovery.state !== "retry") return accepted(observeJob());
      try {
        sourcePreparationMode = "foreground";
        sourcePreparationDeadline = Date.now() + 1500;
        const fresh = prepareSourceValue(database, args, { ...request, receipt });
        recovery.value.admission = fresh.plan.admission;
      } catch (error) {
        if (!(error instanceof SourcePreparationRequired)) throw error;
      } finally {
        sourcePreparationMode = null;
        sourcePreparationDeadline = Infinity;
      }
      const previous = pointer;
      pointer = { initialStamp: objectStoreStamp(input.mirror), recovery: recovery.value };
      writePreparationReceipt(path.join(directory, "recoveries", `${recovery.value.id}.json`), { previous, next: pointer });
      writePreparationReceipt(pointerPath, pointer);
    }
    if (terminal.state === "ready") {
      const refreshed = refreshCompletedSource(terminal.value, input, sourceCommit, receipt, key, pointer.jobId, args);
      if (refreshed !== null) {
        if (refreshed.state === "ready") writePreparationReceipt(receipt, refreshed.value);
        return refreshed;
      }
      if (terminal.value.stamp !== stamp) pointer = null;
    }
  }
  let value;
  try {
    sourcePreparationMode = "foreground";
    sourcePreparationDeadline = Date.now() + 1500;
    if (!pointer?.recovery) value = prepareSourceValue(database, args, { ...request, receipt });
  } catch (error) {
    if (!(error instanceof SourcePreparationRequired)) throw error;
  } finally {
    sourcePreparationMode = null;
    sourcePreparationDeadline = Infinity;
  }
  if (value !== undefined) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writePreparationReceipt(receipt, value);
    return { state: "ready", value };
  }
  if (pointer === null) {
    pointer = { initialStamp: stamp };
    writePreparationReceipt(pointerPath, pointer);
  }
  const jobRequest = { ...request, initialStamp: pointer.initialStamp, receipt,
    ...(pointer.recovery ? { recovery: pointer.recovery } : {}) };
  pointer = { ...pointer, jobId: sourceJobId(key, jobRequest) };
  writePreparationReceipt(pointerPath, pointer);
  const job = accepted(observeJob());
  if (job.state !== "ready" || job.value.stamp === objectStoreStamp(input.mirror)) return job;
  // Concurrent imports of other commits move the shared stamp; re-prove this source instead of failing.
  const refreshed = refreshCompletedSource(job.value, input, sourceCommit, receipt, key, pointer.jobId, args);
  if (refreshed === null) fail("source changed during preparation; repeat the original request");
  if (refreshed.state === "ready") writePreparationReceipt(receipt, refreshed.value);
  return refreshed;
}

function writePreparationReceipt(file, value) {
  const temporary = `${file}.${randomUUID()}`;
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
  renameSync(temporary, file);
}

function sourcePreparationWorker() {
  const directory = process.env.PI_WORKSPACE_SOURCE_JOB_DIR;
  const loaded = readSourceJobRequest(directory);
  if (!loaded.ok) fail(loaded.error.message);
  const request = loaded.value;
  const database = openRegistry(request.statePath);
  sourcePreparationMode = "worker";
  sourceJobDirectory = directory;
  try {
    const value = prepareSourceValue(database, { named: new Map(request.args), positional: [] }, request);
    writePreparationReceipt(request.receipt, value);
    const result = finishSourceJob(directory, { state: "ready", value });
    if (!result.ok) fail(result.error.message);
  } catch (error) {
    finishSourceJob(directory, { state: "failed", error: { code: ["workspace-capacity-refused", "workspace-capacity-lock-busy", "workspace-mirror-lock-busy"].includes(error.code) ? error.code : "source-preparation-failed", message: error.message,
      ...(error instanceof ResourceBusyError && error.detail ? { detail: error.detail } : {}) } });
    throw error;
  } finally { database.close(); }
}

function creationRequest(args, repository) {
  const name = safeName(required(args, "name"));
  const sparsePatterns = many(args, "sparse-pattern");
  const intent = capacityIntent(args);
  return JSON.stringify({ repository, ref: one(args, "ref", "HEAD"), mode: one(args, "mode", "writer"),
    strategy: one(args, "strategy", "clone"), branch: one(args, "branch", `agent/${name}`),
    owner: one(args, "owner", name), kind: one(args, "kind", "agent"), groupId: one(args, "group", null),
    cachePaths: normalizeCachePaths(many(args, "cache")),
    ...(sparsePatterns.length ? { sparsePatterns } : {}), ...(intent === null ? {} : { capacity: intent }),
    leaseSeconds: numberFlag(args, "lease-seconds", DEFAULT_LEASE_SECONDS) });
}

function createCommand(database, args, statePath) {
  assertOnly(args, ["root", "name", "repo", "ref", "branch", "kind", "mode", "owner", "group", "strategy", "lease-seconds", "cache", "max-count", "min-free-gib", "min-free-inodes-percent", "creation-timeout-seconds", "sparse-pattern", "intent", "headroom-gib", "growth-mib", "json"]);
  const destination = path.join(path.resolve(required(args, "root")), safeName(required(args, "name")));
  const pending = database.prepare("SELECT id,creation_request FROM workspace WHERE path=? AND state='creating'").get(destination);
  if (pending && process.env.PI_WORKSPACE_CHECKOUT_JOB !== pending.id) {
    const request = creationRequest(args, repositoryLocation(required(args, "repo"), currentDirectory()));
    if (request !== pending.creation_request) fail(`workspace already exists with a different creation request: ${destination}`);
    const directory = path.join(path.dirname(statePath), "checkout-jobs", pending.id);
    if (existsSync(directory)) for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const job = path.join(directory, entry.name);
      if (existsSync(path.join(job, "result.json")) || !existsSync(path.join(job, "attempt.json"))) continue;
      const attempt = JSON.parse(readFileSync(path.join(job, "attempt.json"), "utf8"));
      const active = command("systemctl", ["--user", "show", attempt.unit, "--property=ActiveState", "--value"], { timeout: 2500 });
      if (active.status === 0 && ["active", "activating", "deactivating"].includes(active.stdout)) {
        print({ ok: true, state: "creating", id: pending.id, path: destination,
          jobId: entry.name, jobKind: "checkout", progressPath: path.join(job, "progress.json"),
          observeCommand: jobObserveCommand(entry.name),
          nextAction: "Use job-status for read-only checkout observation; repeat create only to recover interrupted or failed work" }, true);
        process.exitCode = 75;
        return;
      }
    }
  }
  return withWorkspaceLock(database, destination, () => createWorkspace(database, args, statePath), one(args, "group"));
}

function reservePreparedCreation(database, args, statePath, source, prepared) {
  const { root, destination, repository, ref, intent, sparsePatterns } = source;
  if (path.join(path.resolve(required(args, "root")), safeName(required(args, "name"))) !== destination
    || repositoryLocation(required(args, "repo"), currentDirectory()) !== repository
    || one(args, "ref", "HEAD") !== ref
    || ["intent", "growthBytes", "headroomBytes"].some(key => capacityIntent(args)?.[key] !== intent?.[key])
    || JSON.stringify(many(args, "sparse-pattern")) !== JSON.stringify(sparsePatterns))
    fail("completed source admission arguments differ from the original request");
  if (!prepared.sourceCommit.startsWith(source.sourceCommit ?? resolveRequestedSource(repository, ref)))
    fail("completed source admission no longer names the original commit");
  const request = creationRequest(args, repository), input = JSON.parse(request);
  const mode = input.mode, strategy = input.strategy;
  const existing = database.prepare("SELECT * FROM workspace WHERE path=?").get(destination);
  if (existing && existing.state !== "released") {
    if (existing.creation_request !== request || existing.source_commit !== prepared.sourceCommit)
      fail("completed source admission conflicts with an existing creation");
    return;
  }
  if (existsSync(destination)) fail(`workspace already exists: ${destination}`);
  const { sourceCommit, plan } = prepared;
  const device = String(statSync(root).dev);
  const caller = nativeCaller();
  withCapacityAdmission(database, statePath, device, () => {
    plan.admission = assertCapacity(root, args, database, destination, plan);
    database.exec("BEGIN IMMEDIATE");
    try {
      const now = Date.now();
      database.prepare(`INSERT INTO workspace
        (id,path,root,kind,mode,owner,repository,source_commit,checkout_type,cache_paths,
         created_at,updated_at,lease_expires_at,state,detail,group_id,creation_request)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?, 'creating','creation reserved',?,?)
        ON CONFLICT(path) DO UPDATE SET id=excluded.id, kind=excluded.kind, mode=excluded.mode,
        owner=excluded.owner, repository=excluded.repository, source_commit=excluded.source_commit,
        checkout_type=excluded.checkout_type, cache_paths=excluded.cache_paths,
        created_at=excluded.created_at, updated_at=excluded.updated_at, lease_expires_at=excluded.lease_expires_at,
        state=excluded.state, detail=excluded.detail, group_id=excluded.group_id, creation_request=excluded.creation_request
        WHERE workspace.state='released'`).run(randomUUID(), destination, root, input.kind, mode,
        input.owner, repository, sourceCommit, strategy, JSON.stringify(input.cachePaths), now, now,
        now + input.leaseSeconds * 1000, input.groupId, request);
      const reserved = database.prepare("SELECT id, creation_request FROM workspace WHERE path=?").get(destination);
      if (reserved.creation_request !== request) fail(`workspace creation was claimed by another request: ${destination}`);
      database.prepare("INSERT OR REPLACE INTO workspace_capacity(workspace_id,device_id,plan_json) VALUES(?,?,?)")
        .run(reserved.id, device, JSON.stringify(plan));
      if (caller) bindNativeOwner(database, reserved.id, caller, "caller-scope", { command: "create" });
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  });
}

function createWorkspace(database, args, statePath) {
  const intent = capacityIntent(args);
  const checkoutTimeout = creationTimeout(args);
  const root = path.resolve(required(args, "root"));
  const name = safeName(required(args, "name"));
  const destination = path.join(root, name);
  const repository = repositoryLocation(required(args, "repo"), currentDirectory());
  const ref = one(args, "ref", "HEAD");
  const mode = one(args, "mode", "writer");
  if (!["writer", "review"].includes(mode)) fail("--mode must be writer or review");
  const strategy = one(args, "strategy", "clone");
  if (!["clone", "worktree"].includes(strategy)) fail("--strategy must be clone or worktree");
  if (intent !== null && strategy !== "clone") fail("budgeted intent requires a shared-object clone; worktree capacity is unestimated");
  const sparsePatterns = many(args, "sparse-pattern");
  if (sparsePatterns.some(pattern => !pattern.trim() || pattern === "true" || /[\r\n\0]/u.test(pattern))) {
    fail("--sparse-pattern requires a nonempty single-line Git non-cone pattern");
  }
  if (sparsePatterns.length && strategy !== "clone") fail("--sparse-pattern currently requires --strategy clone");
  const branch = one(args, "branch", `agent/${name}`);
  const request = creationRequest(args, repository);
  const input = JSON.parse(request);
  const upstream = repositoryRemotes(repository);
  const mirror = mirrorFor(statePath, intent === null ? repository : upstream.fetch);
  let row = database.prepare("SELECT * FROM workspace WHERE path = ?").get(destination);
  if (row !== undefined && recordRetainsCustody(database, row.id)) growthError("growth-admission-required", "retained growth requires fresh resume-growth admission");
  const pinFile = refPinPath(statePath, destination, request);
  if (row !== undefined && row.state !== "released") {
    clearRefPin(pinFile);
    if (row.creation_request !== request) fail(`workspace already exists with a different creation request: ${destination}${row.state === "creating" ? "; resume the original request, or use cancel-creation if its destination is absent" : ""}`);
    if (row.state === "active" && existsSync(destination)) {
      print(creationRecord(database, row.id), bool(args, "json"));
      return;
    }
    if (row.state !== "creating") fail(`workspace cannot resume creation from state ${row.state}: ${destination}`);
  } else {
    if (existsSync(destination)) fail(`workspace already exists: ${destination}`);
    mkdirSync(root, { recursive: true });
    const resolvedCommit = resolveRequestedSource(repository, ref);
    const pinnedCommit = resolvedCommit === ref ? resolvedCommit : pinnedSourceCommit({ file: pinFile, resolved: resolvedCommit,
      isAncestor: (pinned, resolved) => {
        const local = existsSync(repository);
        const result = command("git", [...(local ? ["-C", repository] : ["--git-dir", mirror]), "merge-base", "--is-ancestor", pinned, resolved]);
        return result.status === 0 ? true : result.status === 1 || local ? false : null;
      } });
    const preparation = withResourceLock(statePath, `source-preparation:${destination}`, () =>
      prepareCreationSource(database, args, { statePath, root, destination, repository, ref, upstream, mirror, intent, sparsePatterns, sourceCommit: pinnedCommit }));
    if (preparation.state !== "ready") {
      print({ ok: true, state: "preparing", jobKind: "source", jobId: preparation.jobId, progressPath: preparation.progressPath, resultPath: preparation.resultPath,
        observeCommand: `agent-workspace source-status --job-id ${preparation.jobId} --json`,
        nextAction: "Use source-status for authoritative terminal observation; repeat this exact create request to continue admission" }, true);
      process.exitCode = 75;
      return;
    }
    reservePreparedCreation(database, args, statePath,
      { root, destination, repository, mirror, ref, intent, sparsePatterns, sourceCommit: pinnedCommit }, preparation.value);
    clearRefPin(pinFile);
    row = database.prepare("SELECT * FROM workspace WHERE path = ?").get(destination);
    if (row.creation_request !== request) fail(`workspace creation was claimed by another request: ${destination}`);
  }
  let sourceCommit = row.source_commit;
  if (database.prepare("SELECT 1 FROM workspace_capacity WHERE workspace_id=?").get(row.id) === undefined) {
    mkdirSync(root, { recursive: true });
    if (intent !== null && sourceCommit === null) fail("budgeted pending creation has no immutable source custody");
    const plan = intent === null
      ? { intent: "unestimated", estimate: "unknown", constructionBytes: Math.ceil(numberFlag(args, "min-free-gib", DEFAULT_MIN_FREE_GIB) * 1024 ** 3), growthBytes: 0, headroomBytes: 0 }
      : sourceCapacityPlan(repository, sourceCommit, intent, statfsSync(root).bsize, mirror, sparsePatterns);
    const device = String(statSync(root).dev);
    withCapacityAdmission(database, statePath, device, () => {
      plan.admission = assertCapacity(root, args, database, destination, plan);
      database.prepare("INSERT INTO workspace_capacity(workspace_id,device_id,plan_json) VALUES(?,?,?)")
        .run(row.id, device, JSON.stringify(plan));
    });
  }
  if (sourceCommit === null) {
    sourceCommit = resolveSource(statePath, mirror, repository, upstream, ref, sparsePatterns);
    database.prepare("UPDATE workspace SET source_commit=?, updated_at=? WHERE id=?")
      .run(sourceCommit, Date.now(), row.id);
  }
  if (intent !== null) resolveSource(statePath, mirror, repository, upstream, sourceCommit, sparsePatterns);
  const staged = strategy === "clone" && !existsSync(destination);
  const staging = process.env.PI_WORKSPACE_CHECKOUT_JOB === row.id
    ? process.env.PI_WORKSPACE_CHECKOUT_STAGE
    : path.join(root, `.${name}.creating-${row.id}`);
  if (staged && process.env.PI_WORKSPACE_CHECKOUT_JOB !== row.id) {
    if (!args.named.has("creation-timeout-seconds")) {
      let fileCount = 0;
      streamRecords("git", ["-C", mirror, "ls-tree", "-r", "--name-only", "-z", sourceCommit], "\0", name => { if (name !== "") fileCount++; });
      const plan = JSON.parse(database.prepare("SELECT plan_json FROM workspace_capacity WHERE workspace_id=?").get(row.id).plan_json);
      const bytes = plan.intent === "unestimated" ? 0 : plan.constructionBytes;
      args.named.set("creation-timeout-seconds", [String(Math.min(86400,
        Math.max(DEFAULT_CREATION_TIMEOUT_SECONDS, Math.ceil(60 + fileCount / 100 + bytes / (8 * 1024 ** 2)))))]);
    }
    const jobBudget = creationTimeout(args);
    const normalized = [...args.named].flatMap(([flag, values]) => values.map(value => `--${flag}=${value}`));
    const jobDirectory = path.join(path.dirname(statePath), "checkout-jobs", row.id);
    mkdirSync(jobDirectory, { recursive: true, mode: 0o700 });
    const generationFile = path.join(jobDirectory, "generation");
    const generation = existsSync(generationFile) ? Number(readFileSync(generationFile, "utf8")) : 0;
    if (!Number.isSafeInteger(generation) || generation < 0) fail("invalid checkout job generation");
    const candidate = `${staging}-${generation}-${jobBudget}`;
    const job = runSourceJob({
      directory: jobDirectory,
      key: `checkout:${row.id}:${jobBudget}:${generation}`, request: { id: row.id, sourceCommit, request },
      command: [process.execPath, new URL("checkout-job.mjs", import.meta.url).pathname,
        statePath, row.id, candidate, String(jobBudget), ...normalized],
      waitMs: 0, restartInterrupted: true, restartAbnormal: true,
      cleanupCommand: [process.execPath, new URL("checkout-job.mjs", import.meta.url).pathname, "--cleanup", candidate],
    });
    if (job.state === "ready") {
      print(creationRecord(database, row.id), bool(args, "json"));
      return;
    }
    if (job.state === "failed") {
      if(job.error.code==="checkout-cessation-unknown") {
        const repair=command(process.execPath,[new URL("checkout-job.mjs",import.meta.url).pathname,"--cleanup",candidate],{timeout:5000});
        if(repair.status!==0)fail(`checkout cessation unresolved; original staging/custody retained: ${repair.stderr||job.error.message}`);
      }
      const next = `${generationFile}.tmp`;
      writeFileSync(next, String(generation + 1), { mode: 0o600 });
      renameSync(next, generationFile);
      database.prepare("UPDATE workspace SET detail=?,updated_at=? WHERE id=? AND state='creating'")
        .run(`checkout failed; private staging cleaned: ${job.error.message}`, Date.now(), row.id);
      fail(`checkout failed (${job.error.code}): ${job.error.message}; repeat the same create request to retry`);
    }
    print({ ok: true, state: "creating", id: row.id, path: destination,
      jobId: job.jobId, jobKind: "checkout", progressPath: job.progressPath,
      observeCommand: jobObserveCommand(job.jobId),
      nextAction: "Use job-status for read-only checkout observation; repeat create only to recover interrupted or failed work" }, true);
    process.exitCode = 75;
    return;
  }
  const materialization = staged ? staging : destination;
  if (staged) rmSync(staging, { recursive: true, force: true });
  try {
    if (!existsSync(materialization) || readdirSync(materialization).length === 0) {
      const plan = database.prepare("SELECT plan_json FROM workspace_capacity WHERE workspace_id=?").get(row.id);
      // Source preparation and reservation admission can precede this durable
      // child by minutes. Revalidate through the same bounded stale-sample repair
      // here, before any Git materialization, rather than bypassing it on resume.
      withCapacityAdmission(database, statePath, String(statSync(root).dev), () =>
        assertCapacity(root, args, database, destination, plan === undefined ? undefined : JSON.parse(plan.plan_json)));
      if (strategy === "worktree") {
        const worktreeArgs = ["--git-dir", mirror, "worktree", "add"];
        if (mode === "review") worktreeArgs.push("--detach", destination, sourceCommit);
        else worktreeArgs.push("-b", branch, destination, sourceCommit);
        run("git", worktreeArgs, { timeout: checkoutTimeout });
      } else if (intent !== null) {
        prepareSharedSourceClone(materialization, repository, sourceCommit, input, mirror);
      } else {
        const sourceTag = cloneSourceTag(statePath, mirror, sourceCommit);
        run("git", ["clone", "--no-local", ...Object.entries(REFERENCE_CLONE_CONFIG)
          .flatMap(([name, value]) => ["--config", `${name}=${value}`]),
          "--config", `remote.origin.url=${repository}`, "--config", `remote.origin.fetch=${ORIGIN_FETCH_REFSPEC}`,
          "--origin", "workspace-source",
          "--reference-if-able", mirror, "--no-checkout", "--no-tags", "--single-branch", "--branch", sourceTag,
          mirror, materialization], { timeout: checkoutTimeout });
      }
    }
    if (intent !== null) prepareSharedSourceClone(materialization, repository, sourceCommit, input, mirror);
    const info = gitInfo(materialization);
    if (info.checkoutType !== strategy) fail("pending checkout type changed");
    if (strategy === "clone") {
      prepareSparseCheckout(materialization, input);
      resumeCloneCheckout(materialization, input, sourceCommit, upstream, checkoutTimeout);
    }
    const head = git(materialization, ["rev-parse", "HEAD"]);
    const selectedBranch = command("git", ["-C", materialization, "symbolic-ref", "--quiet", "--short", "HEAD"]);
    if (head !== sourceCommit || (mode === "writer" ? selectedBranch.stdout !== branch : selectedBranch.status === 0)) {
      fail("pending checkout HEAD or branch differs from the reserved source");
    }
    assertPendingClean(materialization);
    if (strategy === "clone") {
      git(materialization, ["remote", "set-url", "origin", upstream.fetch]);
      ensureOriginFetch(materialization);
      configurePushUrl(["-C", materialization], upstream);
      const cloneSource = command("git", ["-C", materialization, "config", "--local", "--get", "remote.workspace-source.url"]);
      if (cloneSource.status === 0 && cloneSource.stdout === mirror) git(materialization, ["remote", "remove", "workspace-source"]);
      maintainReferenceClone(materialization, true, statePath);
    }
    if (staged) {
      try {
        lstatSync(destination);
        fail("checkout destination appeared during materialization; candidate not published");
      } catch (error) { if (error.code !== "ENOENT") throw error; }
      renameSync(staging, destination);
    }
    completeCreation(database, row.id, upstream.fetch, input.leaseSeconds, "creation completed", args);
  } catch (error) {
    if (staged) rmSync(staging, { recursive: true, force: true });
    database.prepare("UPDATE workspace SET detail=?, updated_at=? WHERE id=? AND state='creating'")
      .run(`${staged ? "creation failed; private staging removed" : "creation retained"}: ${error.message}`, Date.now(), row.id);
    throw error;
  }
}

// Write the selection before the first worktree checkout: no large excluded blob is opened.
// Retrying must not silently overwrite a caller's changed sparse selection or existing index.
function prepareSparseCheckout(destination, input) {
  if (!input.sparsePatterns?.length) return;
  const file = path.join(destination, ".git", "info", "sparse-checkout");
  const content = `${input.sparsePatterns.join("\n")}\n`;
  if (existsSync(file)) {
    if (readFileSync(file, "utf8") !== content) fail("pending sparse selection differs; preserve and repair it before resuming creation");
  } else {
    if (git(destination, ["ls-files", "--stage"])) fail("pending sparse checkout has an index but no recorded selection; preserve and repair it before resuming creation");
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content, { flag: "wx", mode: 0o600 });
  }
  git(destination, ["config", "--local", "core.sparseCheckout", "true"]);
  git(destination, ["config", "--local", "core.sparseCheckoutCone", "false"]);
}

function resumeCloneCheckout(destination, input, sourceCommit, upstream, checkoutTimeout) {
  const head = git(destination, ["rev-parse", "HEAD"]);
  const selected = command("git", ["-C", destination, "symbolic-ref", "--quiet", "--short", "HEAD"]);
  const correctBranch = input.mode === "review" ? selected.status !== 0 : selected.stdout === input.branch;
  const refuse = reason => fail(`pending checkout cannot resume: ${reason}; preserve and repair it before resuming creation`);
  const origin = repositoryLocation(git(destination, ["config", "--local", "--get", "remote.origin.url"]), destination);
  if (![input.repository, upstream.fetch].includes(origin)) refuse("origin differs from the creation request");
  ensureOriginFetch(destination);
  if (head === sourceCommit && correctBranch && existsSync(path.join(destination, ".git", "index"))) return;
  const unique = git(destination, ["rev-list", "--branches", "HEAD", "--not", "--remotes", sourceCommit]);
  if (unique) refuse("commits absent from remote refs and reserved source");
  const branch = command("git", ["-C", destination, "rev-parse", "--verify", `refs/heads/${input.branch}`]);
  if (input.mode === "writer" && branch.status === 0 && branch.stdout !== sourceCommit) {
    refuse("reserved branch has different source");
  }
  const tree = new Map();
  streamRecords("git", ["-C", destination, "ls-tree", "-rz", sourceCommit], "\0", entry => {
    if (entry === "") return;
    const [metadata, name] = entry.split(/\t(.*)/su);
    const [mode, type, object] = metadata.split(" ");
    tree.set(name, { mode, type, object });
  });
  const index = git(destination, ["ls-files", "--stage", "-z"]).split("\0").filter(Boolean);
  // A killed first checkout leaves no index, or the completed reserved tree, never arbitrary staging.
  if (index.length && (index.length !== tree.size || index.some(entry => {
    const [metadata, name] = entry.split(/\t(.*)/su);
    const [mode, object, stage] = metadata.split(" ");
    const expected = tree.get(name);
    return stage !== "0" || expected?.mode !== mode || expected?.object !== object;
  }))) refuse("index differs from the reserved tree");
  const untracked = git(destination, ["ls-files", "--others", "--exclude-standard", "-z"]);
  if (untracked.split("\0").filter(Boolean).some(name => !tree.has(name))) {
    refuse("untracked files are not creation leftovers");
  }
  const algorithm = git(destination, ["rev-parse", "--show-object-format"]);
  const directories = new Set();
  for (const [name, expected] of tree) {
    const components = name.split("/");
    for (let length = 1; length < components.length; length++) {
      const parent = components.slice(0, length).join("/");
      if (directories.has(parent)) continue;
      directories.add(parent);
      try {
        if (!lstatSync(path.join(destination, parent)).isDirectory()) refuse(`non-directory at ${parent}`);
      } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    const file = path.join(destination, name);
    let stat;
    try { stat = lstatSync(file); } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    if (expected.type !== "blob" || (expected.mode === "120000" ? !stat.isSymbolicLink() : !stat.isFile())) {
      refuse(`file type differs at ${name}`);
    }
    const bytes = expected.mode === "120000" ? readlinkSync(file, { encoding: "buffer" }) : readFileSync(file);
    const object = createHash(algorithm).update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
    if (object !== expected.object || (expected.mode !== "120000"
      && Boolean(stat.mode & 0o111) !== (expected.mode === "100755"))) {
      refuse(`file differs from the reserved tree at ${name}`);
    }
  }
  git(destination, input.mode === "review"
    ? ["checkout", "--force", "--detach", sourceCommit]
    : ["checkout", "--force", "-B", input.branch, sourceCommit], { timeout: checkoutTimeout });
}

function assertPendingClean(destination) {
  const changes = git(destination, ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (changes) fail(`pending checkout contains changes: ${changes.split("\n").slice(0, 8).join(" | ")}; preserve and repair them before resuming creation`);
}

function recordedCapacity(database, id) {
  const row = database.prepare("SELECT plan_json FROM workspace_capacity WHERE workspace_id=?").get(id);
  return row === undefined ? null : JSON.parse(row.plan_json);
}

function creationRecord(database, id) {
  return { ...recordBy(database, { id }), capacity: recordedCapacity(database, id) };
}

function completeCreation(database, id, repository, leaseSeconds, detail, args) {
  const statePath = registryPaths.get(database);
  const initial = database.prepare("SELECT path,group_id FROM workspace WHERE id=? AND state='creating'").get(id);
  if (initial === undefined) fail("pending creation changed before completion");
  return withWorkspaceLock(database, initial.path, () => {
    const row = database.prepare(`SELECT w.id,w.path,w.state,w.created_at,w.group_id,c.device_id,c.plan_json
      FROM workspace w JOIN workspace_capacity c ON c.workspace_id=w.id
      WHERE w.id=? AND w.state='creating'`).get(id);
    if (row === undefined) fail("pending creation capacity changed before completion");
    const paths = database.prepare("SELECT path FROM workspace WHERE state!='released'").all().map(item => item.path);
    // Construction owns this checkout, not the device. Large completed trees must
    // get their own bounded full observation rather than a 500 ms best effort.
    // The sampler takes the device fence only to publish, never while walking.
    const measurement = measureWorkspaceRow(database, row, paths, Date.now() + 60_000, statePath, false, false);
    if (!measurement.ok || measurement.partial) {
      fail(`creation allocation measurement unavailable at ${row.path}; pending creation retained for resume: ${measurement.error ?? "incomplete observation"}`);
    }
    return withResourceLock(statePath, `capacity:${row.device_id}`, () => {
      const current = database.prepare(`SELECT w.path,w.state,c.device_id,c.plan_json
        FROM workspace w JOIN workspace_capacity c ON c.workspace_id=w.id WHERE w.id=?`).get(id);
      const root = lstatSync(row.path);
      if (current?.state !== "creating" || current.path !== row.path || current.device_id !== row.device_id ||
          current.plan_json !== row.plan_json || !root.isDirectory() || String(root.dev) !== measurement.device ||
          String(root.ino) !== measurement.inode) fail("pending creation or allocation root changed before completion");
      const plan = JSON.parse(current.plan_json);
      plan.completedAllocationBytes = measurement.allocatedBytes;
      delete plan.completedAllocationError;
      const planJson = JSON.stringify(plan);
      const bound = { ...measurement, rootPath: row.path,
        planSha256: createHash("sha256").update(planJson).digest("hex") };
      const now = Date.now();
      database.exec("BEGIN IMMEDIATE");
      try {
        database.prepare("UPDATE workspace_capacity SET plan_json=? WHERE workspace_id=?").run(planJson, id);
        database.prepare("UPDATE workspace SET repository=?, state='active', detail=?, updated_at=?, lease_expires_at=? WHERE id=? AND state='creating'")
          .run(repository, detail, now, now + leaseSeconds * 1000, id);
        // Activation changes the plan binding. Rebind the complete observation
        // and journal it atomically with activation, not as another tree walk.
        recordGrowthSample(database, { ...row, state: "active" }, plan, bound);
        database.prepare("INSERT OR REPLACE INTO workspace_capacity_measurement(workspace_id,measurement_json) VALUES(?,?)")
          .run(id, JSON.stringify(bound));
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
      print(creationRecord(database, id), bool(args, "json"));
    });
  }, initial.group_id);
}

function finalizeCreationCommand(database, args, statePath) {
  assertOnly(args, ["id", "path", "json"]);
  const record = recordBy(database, selectorFrom(args, 'finalize-creation'));
  if (record.state === "active") {
    print(creationRecord(database, record.id), bool(args, "json"));
    return;
  }
  if (record.state !== "creating") fail(`workspace cannot finalize creation from state ${record.state}`);
  if (record.sourceCommit === null) fail("pending creation has no recorded source commit; repeat the original create command first");
  const input = record.creation;
  const info = gitInfo(record.path);
  if (info.checkoutType !== input.strategy) fail("pending checkout type changed");
  if (info.checkoutType === "worktree") {
    const common = path.resolve(record.path, git(record.path, ["rev-parse", "--git-common-dir"]));
    if (realpathSync(common) !== realpathSync(mirrorFor(statePath, input.repository))) fail("pending worktree has a different source mirror");
  } else {
    const upstream = repositoryRemotes(input.repository);
    const origin = git(record.path, ["config", "--local", "--get", "remote.origin.url"]);
    if (![input.repository, upstream.fetch].includes(repositoryLocation(origin, record.path))) {
      fail("pending checkout origin differs from the creation request");
    }
  }
  const ancestry = command("git", ["-C", record.path, "merge-base", "--is-ancestor", record.sourceCommit, info.head]);
  if (ancestry.status !== 0) fail("pending checkout HEAD is not descended from the recorded source commit");
  const branch = command("git", ["-C", record.path, "symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (input.mode === "writer" ? branch.status !== 0 : branch.status === 0) fail("pending checkout branch mode differs from the creation request; repeat the original create command for an untouched checkout, or restore the intended branch and clean index before finalize-creation; no files have been removed");
  assertPendingClean(record.path);
  if (info.checkoutType === "clone") {
    ensureOriginFetch(record.path);
    maintainReferenceClone(record.path, true, statePath);
  }
  completeCreation(database, record.id, info.repository ?? record.repository, input.leaseSeconds,
    "creation finalized; existing HEAD, branches, remotes and ignored output preserved; origin fetch mapping verified", args);
}

function cancelCreationCommand(database, args) {
  assertOnly(args, ["id", "path", "json"]);
  const record = recordBy(database, selectorFrom(args, 'cancel-creation'));
  if (record.state !== "creating") fail(`workspace cannot cancel creation from state ${record.state}`);
  assertCreationCancellationSafe(database,record);
  database.prepare("UPDATE workspace SET state='released', lease_expires_at=0, updated_at=?, detail='creation cancelled; destination absent' WHERE id=? AND state='creating'")
    .run(Date.now(), record.id);
  print(recordBy(database, { id: record.id }), bool(args, "json"));
}

function assertCreationCancellationSafe(database,record) {
  const statePath = registryPaths.get(database);
  const jobs = path.join(path.dirname(statePath), "checkout-jobs", record.id);
  if (existsSync(jobs)) for (const entry of readdirSync(jobs, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const attemptFile = path.join(jobs, entry.name, "attempt.json");
    if (!existsSync(attemptFile)) continue;
    const attempt = JSON.parse(readFileSync(attemptFile, "utf8"));
    const observed = command("systemctl", ["--user", "show", attempt.unit, "--property=ActiveState", "--value"]);
    if (observed.status !== 0 || !["inactive", "failed"].includes(observed.stdout)) {
      fail("pending checkout has a durable job still running or stopping; repeat create to observe completion before cancellation");
    }
  }
  // lstat also protects dangling symlinks. Cancellation never removes filesystem entries.
  try {
    lstatSync(record.path);
    fail(`pending checkout exists; repeat the original create command or use finalize-creation for a clean descendant checkout: ${record.path}`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

function heartbeatCommand(database, args, statePath) {
  assertOnly(args, ["id", "path", "lease-seconds", "growth-mib", "json"]);
  const record = recordBy(database, selectorFrom(args, 'heartbeat'));
  if (["released", "reclaiming", "creating"].includes(record.state)) fail(`workspace cannot renew from state ${record.state}`);
  if (!existsSync(record.path)) fail(`workspace path is absent: ${record.path}`);
  const now = Date.now();
  const expires = now + numberFlag(args, "lease-seconds", DEFAULT_LEASE_SECONDS) * 1000;
  const records = recordsInGroup(database, record);
  if (records.some((candidate) => candidate.state === "creating")) fail("workspace group has a pending creation; resume it before renewal");
  for (const candidate of records) assertGrowthWritable(database,candidate);
  if (one(args,"growth-mib")!==undefined) {
    const requested=Math.ceil(numberFlag(args,"growth-mib",0)*1024**2);
    if(!Number.isSafeInteger(requested)||requested<=0)fail("heartbeat --growth-mib must be a positive byte-representable amount");
    // The explicit request applies to the selected workspace; other group leases are renewed,
    // not silently expanded. Admission precedes every source/lease/policy change.
    const row=database.prepare("SELECT device_id,plan_json FROM workspace_capacity WHERE workspace_id=?").get(record.id);
    if(!row)fail("heartbeat growth restoration requires an existing priced workspace");
    const old=JSON.parse(row.plan_json);
    withWorkspaceLock(database,record.path,()=>withCapacityAdmission(database,statePath,row.device_id,()=>{
      const sample=cachedWorkspaceAllocation(database,record.id,record.path,row.device_id);
      const current=database.prepare("SELECT created_at FROM workspace WHERE id=?").get(record.id);
      const policy=projectGrowthPolicy(database,{...current,id:record.id,state:record.state},old,sample.ok?{...sample,bytes:sample.rawBytes}:sample);
      const next={...old,growthBytes:Math.max(old.growthBytes,requested)};
      const liability={...ledgerLiability(old,record.state,sample),reservedBytes:policy?.effectiveRemainingBytes??ledgerLiability(old,record.state,sample).reservedBytes};
      const admission=assertCapacity(path.dirname(record.path),args,database,record.path,{...next,constructionBytes:0},{kind:"reprice",liability});
      database.exec("BEGIN IMMEDIATE");try{
        if(next.growthBytes!==old.growthBytes)database.prepare("UPDATE workspace_capacity SET plan_json=? WHERE workspace_id=? AND plan_json=?").run(JSON.stringify(next),record.id,row.plan_json);
        restoreGrowthPolicy(database,{id:record.id},next,now);
        database.exec("COMMIT");
      }catch(error){database.exec("ROLLBACK");throw error;}
    }));
  }
  const statement = database.prepare("UPDATE workspace SET lease_expires_at = ?, updated_at = ?, state = 'active', detail = 'lease renewed' WHERE id = ?");
  for (const candidate of records) statement.run(expires, now, candidate.id);
  const renewed = records.map((candidate) => recordBy(database, { id: candidate.id }));
  print(renewed.length === 1 ? renewed[0] : renewed, bool(args, "json"));
}

function endWritingCommand(database,args) {
  assertOnly(args,["id","path","owner","disposition","disposition-sha256","json"]);
  const record=growthSelected(database,args),deadline=Date.now()+25000;
  const bytes=readFileSync(required(args,"disposition"),"utf8");
  if(digest(bytes)!==required(args,"disposition-sha256")) growthError("growth-evidence-changed","disposition changed");
  const d=JSON.parse(bytes);
  duringInspection(deadline,()=>withWorkspaceLock(database,record.path,()=>withGrowthBorrowerLocks(database,record,()=>{
    const b=cacheBinding(database,record.id);
    if(b.owner!==required(args,"owner"))growthError("stale-growth-disposition","owner changed");
    if(database.prepare("SELECT 1 FROM workspace_capacity WHERE workspace_id=?").get(record.id))growthError("priced-workspace","use retire-growth for priced workspace");
    const safety=terminalSafety(database,record,deadline,true);
    validateRetirement(d,b,safety);
    database.exec("BEGIN IMMEDIATE");
    try {
      validateRetirement(d,cacheBinding(database,record.id),safety);
      const n=database.prepare("UPDATE workspace SET lease_expires_at=0,state='referenced',detail='preservation-only retained custody',updated_at=? WHERE id=? AND updated_at=? AND lease_expires_at=?").run(Date.now(),record.id,b.updatedAt,b.leaseExpiresAt).changes;
      if(n!==1)growthError("stale-growth-disposition","lease CAS failed");
      markSourceRetained(database,record.id);
      database.exec("CREATE TABLE IF NOT EXISTS workspace_writing_ended(sequence INTEGER PRIMARY KEY, workspace_id TEXT, disposition_json TEXT, safety_json TEXT)");
      database.prepare("INSERT INTO workspace_writing_ended(workspace_id,disposition_json,safety_json) VALUES(?,?,?)").run(record.id,bytes,JSON.stringify(safety));
      database.exec("COMMIT");
      print({ok:true,kind:"writing-ended-source-retained",newWritesAuthorized:false,record:creationRecord(database,record.id),safety},true);
    }catch(e){database.exec("ROLLBACK");throw e;}
  },deadline),record.groupId,deadline));
}

function generatedOnlySourceCustody(database, id) {
  if (!database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='workspace_generated_retirement'").get()) return false;
  return database.prepare("SELECT 1 FROM workspace_generated_retirement WHERE workspace_id=? AND json_extract(journal_json,'$.kind')!='workspace-cache-retirement'").get(id) !== undefined;
}
function generatedRetirementPending(database, id) {
  if (!database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='workspace_generated_retirement'").get()) return false;
  return database.prepare("SELECT 1 FROM workspace_generated_retirement WHERE workspace_id=? AND json_extract(journal_json,'$.state')='pending'").get(id) !== undefined;
}
function markSourceRetained(database,id) {
  database.exec("CREATE TABLE IF NOT EXISTS workspace_source_retention(workspace_id TEXT PRIMARY KEY,occurred_at INTEGER NOT NULL)");
  database.prepare("INSERT OR REPLACE INTO workspace_source_retention VALUES(?,?)").run(id,Date.now());
}
function explicitSourceRetention(database, id) {
  return Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='workspace_source_retention'").get() && database.prepare("SELECT 1 FROM workspace_source_retention WHERE workspace_id=?").get(id));
}
function recordRetainsCustody(database, id) {
  if (explicitSourceRetention(database, id)) return true;
  if (generatedRetirementPending(database, id)) return true;
  const row = database.prepare("SELECT plan_json FROM workspace_capacity WHERE workspace_id=?").get(id);
  return row !== undefined && retainedGrowth(JSON.parse(row.plan_json));
}
function retainedParent(database, workspacePath) {
  if (!existsSync(workspacePath)) return false;
  const common = path.resolve(workspacePath, git(workspacePath,["rev-parse","--git-common-dir"]));
  if (common === path.join(workspacePath,".git")) return false;
  const parent = database.prepare("SELECT id FROM workspace WHERE path=?").get(path.dirname(common));
  return parent !== undefined && recordRetainsCustody(database,parent.id);
}
function assertGrowthWritable(database, record) {
  if (recordRetainsCustody(database,record.id) || retainedParent(database,record.path)) growthError("growth-admission-required", "workspace or shared Git parent retains custody; fresh resume-growth admission required");
}
function withGrowthBorrowerLocks(database,record,action,deadline) {
  const dependencies = gitDependencySnapshot(database);
  const ids = new Set([...dependencies.alternates.filter(value => value.recordId !== record.id && within(record.path,value.objectDirectory)),
    ...dependencies.linkedWorktrees.filter(value => value.recordId !== record.id && within(record.path,value.commonDirectory))].map(value => value.recordId));
  const borrowers = [...ids].sort().map(id => recordBy(database,{id}));
  const next = index => index === borrowers.length ? action() : withWorkspaceLock(database,borrowers[index].path,()=>next(index+1),borrowers[index].groupId,deadline);
  return next(0);
}
function retainedCustodyResult(record) {
  return {record, action:"none", inspection:{classification:"blocked", reason:"explicit retained source/runtime custody; resume-growth admission required before cleanup or writing", processes:[], containers:[], systemdUnits:[]}};
}

// Owners whose custody the current owner holds through recorded ended-owner transfers
// (release-ended-owners to a live parent or an authenticated requester), with the source
// commit and path unchanged. The current owner is always a member. An adopter therefore
// continues the original owner's retired ordinary release instead of being refused as if
// the plan had changed; any other reassignment ends the lineage.
const ENDED_CUSTODY_KINDS = new Set(["native-ended-child-parent-custody", "native-ended-owner-requester-custody"]);
function endedCustodyLineage(database, record) {
  const owners = new Set([record.owner]);
  if (!database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='workspace_reassignment'").get()) return owners;
  const rows = database.prepare("SELECT * FROM workspace_reassignment WHERE workspace_id=? ORDER BY sequence DESC LIMIT 64").all(record.id);
  let current = record.owner;
  for (const row of rows) {
    let evidence;
    try { evidence = JSON.parse(row.authorization); } catch { break; }
    if (row.new_owner !== current || row.path !== record.path || !ENDED_CUSTODY_KINDS.has(evidence?.kind) || evidence.parent !== row.new_owner ||
        row.old_source_commit !== record.sourceCommit || row.new_source_commit !== record.sourceCommit) break;
    owners.add(row.old_owner);
    if (typeof evidence.child === "string") owners.add(evidence.child);
    current = row.old_owner;
  }
  return owners;
}

function terminalRetentionRelease(database, selected, args, statePath, automatic = false) {
  const owner = required(args, "owner");
  const expectedPlan = required(args, "expected-plan-sha256");
  const deadline = Date.now() + 60_000;
  return duringInspection(deadline, () => withWorkspaceLock(database, selected.path, () => {
    const record = recordBy(database, {id:selected.id});
    const row = database.prepare("SELECT plan_json FROM workspace_capacity WHERE workspace_id=?").get(record.id);
    if (!row || digest(row.plan_json) !== expectedPlan || record.owner !== owner) {
      // Name the stale part and where its current value is read. The plan digest is
      // growth-status binding.planSha256; a dispositionSha256 is a different object.
      const stale = [record.owner !== owner ? `--owner is not the current custodian ${record.owner}` : null,
        !row ? "no capacity plan is recorded" : digest(row.plan_json) !== expectedPlan ? "--expected-plan-sha256 is not the current capacity plan digest (growth-status binding.planSha256, not a dispositionSha256)" : null].filter(Boolean);
      growthError("stale-retention-release", `owner or capacity plan changed; read the current binding: ${stale.join("; ")}`);
    }
    if (!automatic && !retainedGrowth(JSON.parse(row.plan_json))) throw Object.assign(new GrowthLifecycleError("future-growth-not-retired", "future growth is not retired"),{nextAction:futureGrowthAction(record)});
    if (existsSync(record.path) && generatedOnlySourceCustody(database, record.id)) growthError("retention-release-source-custody", "separate generated/source materialization retention remains");
    if (record.groupId !== null) growthError("retention-release-group", "group retention requires an explicit disposition for every member");
    if (!automatic && record.leaseExpiresAt !== 0) growthError("retention-release-active", "a writing lease remains");
    if (record.state === "released" && !existsSync(record.path)) {
      return {ok:true, record, action:"already-released", inspection:{classification:"missing", reason:"terminal retained release already completed", processes:[], containers:[], systemdUnits:[]}};
    }
    if (!["active", "referenced", "blocked", "repair-required", "reclaiming"].includes(record.state)) {
      growthError("invalid-retention-release", `cannot end retention from ${record.state}`);
    }
    if (retainedParent(database, record.path)) growthError("retention-release-parent", "shared Git parent still retains custody");
    const protect = inspection => ({ok:false, record:recordBy(database,{id:record.id}), action:"none", inspection,
      error:{code:inspection.code ?? "retention-release-protected", message:inspection.reason}});
    const observe = () => {
      // One parallel whole-host census per freshness pass, shared with the growth
      // writer check. Previously that check did a serial second census first and
      // exhausted the deadline before its thread query even began.
      const snapshot = safetySnapshot(database);
      {
        const safety = growthSafety(database, record, {snapshot});
        if (safety.errors.length || safety.references.length) return {classification:"blocked",
          reason:safety.errors.length ? `cannot prove terminal retention safety: ${safety.errors.join("; ")}` : "runtime/thread/process/borrower writing references remain",
          processes:safety.references, containers:[], systemdUnits:[]};
      }
      const protection = stackQueueInspection(stackQueueSafety([record.path], snapshot, automatic ? "source" : "physical-checkout", deadline));
      if (protection) return protection;
      return inspectRecord(record, {ignoreLease:true, safety:snapshot, deadline,terminalSourceTransfer:!automatic});
    };
    return withGrowthBorrowerLocks(database, record, () => {
      let inspection = observe();
      if (["referenced", "blocked", "active"].includes(inspection.classification) || inspection.sourceRetention) return protect(inspection);
      const frozen = frozenCustody(record.path, {recursive:true});
      if (frozen) return protect({classification:"blocked",...frozen,processes:[],containers:[],systemdUnits:[]});
      let removedCaches = [];
      if (inspection.classification === "repair-required") {
        removedCaches = stripCaches(record, statePath, () => database.prepare("DELETE FROM workspace_capacity_measurement WHERE workspace_id=?").run(record.id), roots => cacheSymlinkSafety(database, record, roots));
      }
      inspection = observe();
      if (!["reclaimable", "missing"].includes(inspection.classification)) return {...protect(inspection), removedCaches};
      if (Date.now() >= deadline) growthError("retention-release-timeout", "terminal retention safety budget exhausted");
      database.exec("BEGIN IMMEDIATE");
      try {
        const current = recordBy(database, {id:record.id});
        const currentPlan = database.prepare("SELECT plan_json FROM workspace_capacity WHERE workspace_id=?").get(record.id);
        if (current.owner !== owner || current.leaseExpiresAt !== record.leaseExpiresAt || current.updatedAt !== record.updatedAt || currentPlan?.plan_json !== row.plan_json) {
          growthError("stale-retention-release", "record or plan changed before terminal release");
        }
        database.exec(`CREATE TABLE IF NOT EXISTS workspace_retention_release (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id TEXT NOT NULL, occurred_at INTEGER NOT NULL,
          record_json TEXT NOT NULL, plan_json TEXT NOT NULL, inspection_json TEXT NOT NULL)`);
        database.prepare("INSERT INTO workspace_retention_release(workspace_id,occurred_at,record_json,plan_json,inspection_json) VALUES(?,?,?,?,?)")
          .run(record.id, Date.now(), JSON.stringify(record), row.plan_json, JSON.stringify(inspection));
        database.prepare("UPDATE workspace SET lease_expires_at=0 WHERE id=?").run(record.id);
        updateState(database, current, "reclaiming", "owner ended retained custody; terminal release qualified");
        database.exec("COMMIT");
      } catch (error) { database.exec("ROLLBACK"); throw error; }
      if (inspection.classification !== "missing") removeWorkspace(record, statePath);
      removeEmptyWorkspaceContainer(record);
      updateState(database, record, "released", `terminal retained custody released: ${inspection.reason}`);
      return {ok:true, record:recordBy(database,{id:record.id}), action:"released", inspection, removedCaches};
    }, deadline);
  }, selected.groupId, deadline));
}

function releaseSettlement(database, workspaceId) {
  if (!database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='workspace_release_attempt'").get()) return { kind: "unset" };
  const row = database.prepare("SELECT receipt_json FROM workspace_release_attempt WHERE workspace_id=? ORDER BY sequence DESC LIMIT 1").get(workspaceId);
  return row === undefined ? { kind: "unset" } : JSON.parse(row.receipt_json);
}

function beginOrdinaryRelease(database, records, args) {
  const previous = records.map(record => releaseSettlement(database, record.id));
  if (previous.some(receipt => receipt.kind === "owned-retention")) {
    const requestId = previous[0].requestId;
    if (previous.some(receipt => receipt.kind !== "owned-retention" || receipt.requestId !== requestId))
      fail("ordinary release group changed while original settlement is retained");
    const rows = database.prepare("SELECT workspace_id,request_json FROM workspace_release_attempt WHERE request_id=?").all(requestId);
    if (rows.length !== records.length) fail("ordinary release retained group membership changed");
    for (const record of records) {
      const row = rows.find(row => row.workspace_id === record.id);
      if (row === undefined) fail("ordinary release retained group membership changed");
      const original = JSON.parse(row.request_json);
      if (original.record.owner !== record.owner || original.record.path !== record.path || original.record.sourceCommit !== record.sourceCommit
        || original.settle.includes("--reap-expired") !== bool(args,"reap-expired")
        || original.settle.includes("--preserve-runtime") !== bool(args,"preserve-runtime"))
        fail("ordinary release retained request binding changed; inspect original status settlement before continuing");
    }
    database.exec("BEGIN IMMEDIATE");
    try {
      for (const record of records) database.prepare("UPDATE workspace SET lease_expires_at=0,state='repair-required',updated_at=?,detail=? WHERE id=?")
        .run(Date.now(), `ordinary release ${requestId}: owned retention until a complete verdict is recorded`, record.id);
      database.exec("COMMIT");
    } catch (error) { database.exec("ROLLBACK"); throw error; }
    return requestId;
  }
  const requestId = randomUUID(), startedAt = Date.now();
  database.exec(`CREATE TABLE IF NOT EXISTS workspace_release_attempt (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT, request_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
    request_json TEXT NOT NULL, receipt_json TEXT NOT NULL, UNIQUE(request_id, workspace_id));
    CREATE INDEX IF NOT EXISTS workspace_release_record ON workspace_release_attempt(workspace_id, sequence)`);
  database.exec("BEGIN IMMEDIATE");
  try {
    for (const record of records) {
      const settle = ["agent-workspace", "release", "--id", record.id,
        ...(bool(args, "reap-expired") ? ["--reap-expired"] : []),
        ...(bool(args, "preserve-runtime") ? ["--preserve-runtime"] : []), "--json"];
      const receipt = { kind: "owned-retention", requestId, workspaceId: record.id, owner: record.owner, startedAt,
        reason: "Release has no completed safety/physical verdict; the registered owner retains settlement responsibility",
        physicalDisposition: { kind: "unsettled" },
        nextAction: { observe: ["agent-workspace", "status", "--id", record.id, "--json"], settle } };
      database.prepare("INSERT INTO workspace_release_attempt(request_id,workspace_id,request_json,receipt_json) VALUES(?,?,?,?)")
        .run(requestId, record.id, JSON.stringify({ record, settle }), JSON.stringify(receipt));
      database.prepare("UPDATE workspace SET lease_expires_at=0,state='repair-required',updated_at=?,detail=? WHERE id=?")
        .run(startedAt, `ordinary release ${requestId}: owned retention until a complete verdict is recorded`, record.id);
    }
    database.exec("COMMIT");
    return requestId;
  } catch (error) { database.exec("ROLLBACK"); throw error; }
}

function finishOrdinaryRelease(database, requestId, results) {
  database.exec("BEGIN IMMEDIATE");
  try {
    for (const result of results) {
      const receipt = { kind: "completed", requestId, workspaceId: result.record.id, owner: result.record.owner,
        completedAt: Date.now(), result };
      const changed = database.prepare("UPDATE workspace_release_attempt SET receipt_json=? WHERE request_id=? AND workspace_id=? AND json_extract(receipt_json,'$.kind')='owned-retention'")
        .run(JSON.stringify(receipt), requestId, result.record.id).changes;
      if (changed !== 1) throw new Error("ordinary release settlement identity changed");
    }
    database.exec("COMMIT");
  } catch (error) { database.exec("ROLLBACK"); throw error; }
  return results.map(result => ({ ...result, releaseSettlement: releaseSettlement(database, result.record.id) }));
}

// Ordinary release is an explicit end-writing request, not lease expiry or archive.
// A retained dirty/unpublished tree is irreplaceable source, not future allocation.
// Never infer cessation from the lease: the shared transition independently observes
// every runtime/native/borrower reference and refuses uncertainty under exact locks.
function settleReleasedFutureGrowth(database, item, requestId, statePath) {
  if (item.physicalDisposition?.kind !== "retained" || item.record.leaseExpiresAt !== 0 ||
      item.record.state !== "repair-required") return item;
  const plan = recordedCapacity(database, item.record.id);
  if (!plan || !["source-only", "budgeted"].includes(plan.intent) || retainedGrowth(plan)) return item;
  try {
    const record = recordBy(database, {id:item.record.id});
    const row = database.prepare(`SELECT w.id,w.path,w.state,w.created_at,w.group_id,c.device_id,c.plan_json
      FROM workspace w JOIN workspace_capacity c ON c.workspace_id=w.id WHERE w.id=?`).get(record.id);
    // Release owns the sample it needs, rather than leaving an unrecoverable
    // growth-status instruction. The caller already holds the reentrant checkout
    // lock; sample before taking the capacity fence used by retirement.
    if (!cachedWorkspaceAllocation(database, record.id, record.path, row.device_id).ok) {
      const paths = database.prepare("SELECT path FROM workspace WHERE state!='released'").all().map(value => value.path);
      const deadline = Math.min(inspectionDeadline ?? Infinity, Date.now()+60_000);
      const sample = measureWorkspaceRow(database, row, paths, deadline, statePath, false, false);
      if (!sample.ok) growthError("growth-sample-required", sample.error ?? "release allocation sample failed");
    }
    const {binding} = growthBinding(database, record);
    const disposition = {kind:"retire-future-growth", retainedUse:"source", remainingGrowthBytes:0,
      growthWriters:"none", writingLease:"retire", observedAt:Date.now(), binding,
      reason:"Explicit ordinary release ended local writing; retained source and all generated bytes remain untouched",
      ownerEvidence:`Original ordinary release ${requestId} by registered owner ${record.owner}; fresh locked runtime/unit/native/borrower cessation required; archive/expiry are not evidence`};
    const retirement = retireGrowthEvidence(database, record, record.owner, JSON.stringify(disposition), statePath);
    return {...item, record:retirement.record, futureGrowthSettlement:{kind:"retired", requestId,
      sequence:retirement.sequence, dispositionSha256:retirement.dispositionSha256, sourceDeleted:false}};
  } catch (error) {
    return {...item, futureGrowthSettlement:{kind:"retained", requestId, sourceDeleted:false,
      code:error.code ?? "growth-settlement-unknown", detail:error.message,
      nextAction:{observe:["agent-workspace","growth-status","--id",item.record.id,"--path",item.record.path,"--json"],
        settle:["agent-workspace","release","--id",item.record.id,"--preserve-runtime","--json"]}}};
  }
}

// A release that reports a blocked outcome did not release: callers must see a nonzero status.
const BLOCKED_RELEASE_EXIT = 2;

function releaseCommand(database, args, statePath, authorityDependencies) {
  const previous=currentReleaseAuthority;
  currentReleaseAuthority=null;
  try { return ownedReleaseCommand(database,args,statePath,authorityDependencies); }
  finally { currentReleaseAuthority=previous; }
}
function ownedReleaseCommand(database, args, statePath, authorityDependencies) {
  assertOnly(args, ["id", "path", "reap-expired", "preserve-runtime", "json", "end-retention", "owner", "expected-plan-sha256"]);
  const record = recordBy(database, selectorFrom(args, 'release'));
  const records = recordsInGroup(database, record);
  const authority = authorizeWorkspaceRelease(database, records.length ? records : [record], statePath, {deadline:inspectionDeadline??Date.now()+30000,...authorityDependencies});
  if (!authority.ok) {
    if (bool(args, "json")) print(authority, true);
    else process.stderr.write(`agent-workspace: ${authority.error.code}: ${authority.error.detail}\n`);
    process.exitCode = BLOCKED_RELEASE_EXIT;
    return;
  }
  currentReleaseAuthority=authority;
  if (bool(args, "end-retention")) {
    if (bool(args, "reap-expired")) growthError("invalid-retention-release", "terminal retained release never stops runtime references");
    const result = terminalRetentionRelease(database, recordBy(database, selectorFrom(args, 'release')), args, statePath);
    print(result, bool(args, "json"));
    if (!result.ok) process.exitCode = 2;
    return;
  }
  if (one(args, "owner") !== undefined || one(args, "expected-plan-sha256") !== undefined) {
    growthError("invalid-retention-release", "owner/plan binding requires explicit --end-retention");
  }
  const previous = releaseSettlement(database, record.id);
  const planRow = database.prepare("SELECT plan_json FROM workspace_capacity WHERE workspace_id=?").get(record.id);
  // An ordinary release may retire growth while a temporary consumer retains the tree.
  // Retrying that same end-writing intent needs terminal safety, not new growth admission.
  if (records.length === 1 && ["repair-required", "released"].includes(record.state) && record.leaseExpiresAt === 0 &&
      previous.kind === "completed" && endedCustodyLineage(database, record).has(previous.owner) &&
      previous.result?.futureGrowthSettlement?.kind === "retired" &&
      previous.result.futureGrowthSettlement.requestId === previous.requestId &&
      previous.result.record?.path === record.path &&
      previous.result.record?.sourceCommit === record.sourceCommit &&
      planRow && retainedGrowth(JSON.parse(planRow.plan_json)) &&
      !explicitSourceRetention(database, record.id) && !generatedRetirementPending(database, record.id) &&
      !generatedOnlySourceCustody(database, record.id)) {
    const terminalArgs = {positional:[], named:new Map([["owner",[record.owner]], ["expected-plan-sha256",[digest(planRow.plan_json)]]])};
    const result = terminalRetentionRelease(database, record, terminalArgs, statePath);
    if (result.ok && result.record.state === "released") {
      // Keep the original retained verdict immutable, but record this linked physical
      // completion so foreground observers do not return the old retention as current.
      const requestId = randomUUID();
      const completed = {...result, physicalDisposition:{kind:"removed"},
        ordinaryReleaseContinuation:{requestId:previous.requestId, basis:"original ordinary release retired future growth"}};
      const receipt = {kind:"completed", requestId, workspaceId:record.id, owner:record.owner,
        completedAt:Date.now(), result:completed};
      database.prepare("INSERT INTO workspace_release_attempt(request_id,workspace_id,request_json,receipt_json) VALUES(?,?,?,?)")
        .run(requestId, record.id, JSON.stringify({record, continuationOf:previous.requestId}), JSON.stringify(receipt));
      print({...completed, releaseSettlement:receipt}, bool(args,"json"));
      return;
    }
    print({...result, ordinaryReleaseContinuation:{requestId:previous.requestId, basis:"original ordinary release retired future growth"}}, bool(args,"json"));
    if (!result.ok) process.exitCode = BLOCKED_RELEASE_EXIT;
    return;
  }
  if (records.some(candidate => generatedOnlySourceCustody(database, candidate.id) || recordRetainsCustody(database, candidate.id) || retainedParent(database,candidate.path))) {
    const results = records.map(retainedCustodyResult);
    print(results.length === 1 ? results[0] : results, bool(args,"json"));
    process.exitCode = BLOCKED_RELEASE_EXIT;
    return;
  }
  const settled = ordinaryRelease(database, records, args, statePath, settleReleasedFutureGrowth, Infinity, false, records.length === 1);
  print(settled.length === 1 ? settled[0] : settled, bool(args, "json"));
  if (settled.some(item => item.inspection?.classification === "blocked")) process.exitCode = BLOCKED_RELEASE_EXIT;
}

// The ordinary release transition shared by an owner's explicit release and by the
// owner-liveness release of an authentically ended native owner. Only the future-growth
// settlement (and its owner evidence) differs; every safety observation is identical.
// archiveWorkingTree: only an explicit release of a single checkout archives its uncommitted files;
// the ended-owner release and groups keep a dirty checkout as before.
function ordinaryRelease(database, records, args, statePath, settle, outerDeadline = Infinity, protectSourceIntent = false, archiveWorkingTree = false) {
  const requestId = beginOrdinaryRelease(database, records, args);
  const current = records.map((candidate) => recordBy(database, { id: candidate.id }));
  const deadline=Math.min(inspectionDeadline??Date.now()+35_000, outerDeadline);
  // Snapshot failure is a completed *non-destructive* refusal, not an orphaned
  // release. Never substitute partial/empty reference observations.
  let result;
  try {
    result = duringInspection(deadline,()=>reconcileRecords(database, current, {
      deadline,
      execute: true,
      reapExpired: bool(args, "reap-expired"),
      preserveRuntime: bool(args, "preserve-runtime"),
      ignoreLease: true,
      statePath,
      safety: safetySnapshot(database),
      terminalSourceTransfer:!protectSourceIntent,
      archiveWorkingTree,
    })).map(leaseReleaseDisposition);
  } catch (error) {
    result = blockedReconciliation(database, current, error, true).map(leaseReleaseDisposition);
  }
  result = result.map(item => settle(database, item, requestId, statePath));
  return finishOrdinaryRelease(database, requestId, result);
}

// Owner-liveness release: a registered owner that is an authentically stopped or archived
// Kenan Stack native worker can never declare its own ordinary release, so its checkouts kept
// their reservations forever. This performs exactly that ordinary --preserve-runtime release on
// the ended owner's behalf. The native verdict replaces only the owner's end-of-writing
// declaration; it is never evidence that nothing runs in the checkout. The shared transition
// still observes running tool calls, live workers naming the path, processes, units,
// containers, threads and Git borrowers; dirty and unpublished source is retained, and only its
// future growth is settled through the shared locked retire-growth transition.
const ENDED_OWNER_STATES = ["active", "referenced", "blocked", "repair-required", "reclaiming"];
function ownerLivenessObservation(owners, deadline) {
  if (process.env.NODE_TEST_CONTEXT !== undefined && process.env.PI_WORKSPACE_TEST_OWNER_LIVENESS !== undefined) {
    let fixture = JSON.parse(readFileSync(process.env.PI_WORKSPACE_TEST_OWNER_LIVENESS, "utf8"));
    if (Array.isArray(fixture.sequence)) {
      const [next, ...rest] = fixture.sequence;
      writeFileSync(process.env.PI_WORKSPACE_TEST_OWNER_LIVENESS, JSON.stringify({ sequence: rest.length ? rest : [next] }));
      fixture = next;
    }
    return { errors: [], agents: [], wakes: [], observations: [], ...fixture, owners: [...new Set(owners.filter(owner => OWNER_AGENT_ID.test(owner)))].sort(), observedAt: Date.now() };
  }
  return observeOwnerLiveness(owners, { deadline });
}
function endedOwnerEvidence(verdict, requestId) {
  const rows = verdict.agents.map(agent => `${agent.channel}:${agent.state}${agent.archived ? "+archived" : ""}`).join(",");
  return `Owner-liveness release ${requestId}: registered native owner ${verdict.owner} is ${verdict.code} (${rows}) in a complete observation of every serving Kenan Stack channel, with no pending wake owned by or held for it; this ends the owner's writing intent only. Fresh locked runtime/unit/native/borrower cessation is still required; archive/stop are not cessation evidence`;
}
function settleEndedOwnerFutureGrowth(verdicts) {
  return (database, item, requestId, statePath) => {
    if (item.physicalDisposition?.kind !== "retained") return item;
    const retained = (code, detail) => ({ ...item, futureGrowthSettlement: { kind: "retained", requestId, sourceDeleted: false, code, detail,
      nextAction: { observe: ["agent-workspace", "growth-status", "--id", item.record.id, "--path", item.record.path, "--json"],
        settle: ["agent-workspace", "release-ended-owners", "--id", item.record.id, "--execute", "--json"] } } });
    // Live native intent and uncertain observations stay charged; Git/unit references get the
    // retire-growth transition's own fresh terminal writer observation, which refuses on any writer.
    if (item.inspection?.currentStackQueueProtected || item.inspection?.classification === "blocked") return retained("owner-liveness-protected", item.inspection.reason);
    const plan = recordedCapacity(database, item.record.id);
    if (!plan || !["source-only", "budgeted"].includes(plan.intent) || retainedGrowth(plan)) return item;
    try {
      const record = recordBy(database, { id: item.record.id });
      const verdict = verdicts.get(record.id);
      if (!verdict || verdict.kind !== "ended" || verdict.owner !== canonicalNativeOwner(database, record)) return retained("owner-liveness-changed", "owner changed during release");
      if (record.leaseExpiresAt !== 0 || !ENDED_OWNER_STATES.includes(record.state)) return retained("owner-liveness-state", `state ${record.state}`);
      const { binding } = growthBinding(database, record);
      const disposition = { kind: "retire-future-growth", retainedUse: "source", remainingGrowthBytes: 0,
        growthWriters: "none", writingLease: "retire", observedAt: Date.now(), binding,
        reason: "Native owner ended; owner-liveness release retained source and all generated bytes untouched",
        ownerEvidence: endedOwnerEvidence(verdict, requestId) };
      const retirement = retireGrowthEvidence(database, record, record.owner, JSON.stringify(disposition), statePath);
      return { ...item, record: retirement.record, futureGrowthSettlement: { kind: "retired", basis: "native-owner-ended", requestId,
        sequence: retirement.sequence, dispositionSha256: retirement.dispositionSha256, sourceDeleted: false } };
    } catch (error) {
      return retained(error.code ?? "growth-settlement-unknown", error.message);
    }
  };
}
// Retirement needs a current allocated-block sample. A recurring release must not wait for the
// fleet sampler to happen to visit this checkout, so a stale priced, unretired sample is refreshed
// here, before any lifecycle lock, through the host's supported UID-preserving read-capability
// route (falling back to an unprivileged walk). Only the measurement cache changes; retirement
// still validates freshness, root identity and its own terminal writer observation.
function refreshEndedOwnerSample(database, record, deadline, statePath, {incremental=false} = {}) {
  const row = database.prepare(`SELECT w.id,w.path,w.state,w.created_at,w.group_id,c.device_id,c.plan_json FROM workspace w
    JOIN workspace_capacity c ON c.workspace_id=w.id WHERE w.id=?`).get(record.id);
  if (!row) return { kind: "unpriced" };
  const plan = JSON.parse(row.plan_json);
  if (!["source-only", "budgeted"].includes(plan.intent) || retainedGrowth(plan)) return { kind: "not-needed" };
  if (cachedWorkspaceAllocation(database, record.id, record.path, row.device_id).ok) return { kind: "fresh" };
  // Admission must not spend its whole budget restarting one large tree. Keep
  // durable traversal progress and give the next deciding reservation a turn.
  const budget = incremental ? Math.min(1000,deadline-Date.now()-1000) : Math.min(60_000, deadline - Date.now() - 10_000);
  if (budget < (incremental ? 100 : 1000)) return { kind: "deferred", detail: "remaining budget too small for a measurement" };
  const isolated = process.env.NODE_TEST_CONTEXT !== undefined && process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY === "empty";
  let route = "unprivileged";
  if (!isolated && process.getuid?.() !== 0) {
    const uid = process.getuid(), gid = process.getgid();
    const measured = boundedCommand("sudo", ["-n", "/usr/bin/setpriv", `--reuid=${uid}`, `--regid=${gid}`, "--init-groups",
      "--bounding-set=-all,+dac_read_search", "--inh-caps=+dac_read_search", "--ambient-caps=+dac_read_search",
      "/usr/bin/env", `HOME=${homedir()}`, `PI_WORKSPACE_STATE=${statePath}`, "PATH=/usr/local/bin:/usr/bin:/bin",
      process.execPath, new URL(import.meta.url).pathname, "measure-capacity", "--id", record.id, "--budget-ms", String(budget), ...(incremental ? ["--incremental"] : []), "--json"],
      { encoding: "utf8", timeout: budget + (incremental ? 1000 : 5_000), maxBuffer: 1 << 20, reapGroup: true });
    if (measured.status === 0 && !measured.error) {
      if(cachedWorkspaceAllocation(database, record.id, record.path, row.device_id).ok)return {kind:'measured',route:'read-capability'};
      if(incremental){try{if(JSON.parse(measured.stdout).results.some(item=>item.status==='partial'))return {kind:'partial',route:'read-capability'};}catch{}}
    }
    route = "unprivileged-after-read-capability-failure";
  }
  const paths = database.prepare("SELECT path FROM workspace WHERE state!='released'").all().map(value => value.path);
  const sample = measureWorkspaceRow(database, row, paths, Math.min(deadline - (incremental ? 100 : 5_000), Date.now() + budget),statePath,incremental);
  if(sample.partial)return {kind:'partial',route};
  return sample.ok && cachedWorkspaceAllocation(database, record.id, record.path, row.device_id).ok ? { kind: "measured", route } : { kind: "failed", route, detail: sample.error ?? "sample not current" };
}
function endedReleaseOwner(database, record) {
  const owner = canonicalNativeOwner(database, record);
  if (OWNER_AGENT_ID.test(owner)) return owner;
  if (!owner.startsWith("manager:") || !NATIVE_CUSTODIAN_ID.test(owner) || !database.prepare("SELECT 1 FROM sqlite_master WHERE name='workspace_parent_custody'").get()) return owner;
  const custody = database.prepare('SELECT * FROM workspace_parent_custody WHERE workspace_id=?').get(record.id);
  const last = database.prepare('SELECT * FROM workspace_reassignment WHERE workspace_id=? ORDER BY sequence DESC LIMIT 1').get(record.id);
  let evidence; try { evidence = JSON.parse(custody?.evidence_json ?? 'null'); } catch { return owner; }
  const matches = last ? last.new_owner === owner && last.old_owner === custody.child_owner && last.authorization === custody.evidence_json
    : record.sourceCommit === null;
  return custody?.parent_owner === owner && matches && ['transfer','native-ended-child-parent-custody'].includes(evidence?.kind) &&
    evidence.parent === owner && OWNER_AGENT_ID.test(evidence.child ?? '') ? evidence.child : owner;
}
function endedOwnerSummary(record) {
  return { id: record.id, path: record.path, owner: record.owner, state: record.state, groupId: record.groupId };
}
function endedOwnerRefusal(database, group, verdicts, observation, deadline, requester) {
  if (group.some(record => !ENDED_OWNER_STATES.includes(record.state))) return { code: "state-not-eligible" };
  if (observation.errors.length) return { code: "owner-unknown" };
  const unended = verdicts.find((verdict, index) => verdict.kind !== "ended" && (existsSync(group[index].path) || verdict.kind === "live"));
  if (unended) return { code: unended.kind === "live" ? "owner-live" : "owner-unknown" };
  const directWake = observation.wakes.some(wake => wake.held !== true && group.some(record => wake.agentId === endedReleaseOwner(database, record) || wake.heldFor === endedReleaseOwner(database, record)));
  if (directWake) return { code: "pending-owner-wake" };
  // A held trigger for the ended owner's goal keeps its checkouts for a successor. An
  // authenticated live requester taking custody is such a successor, and a transfer deletes
  // nothing, so only a trigger that names this checkout (path or basename) still refuses it.
  const wakes = group.flatMap((record, index) => pendingWakeReferences(record.path, observation, verdicts[index]))
    .filter(wake => !(requester && wake.match === "owner-goal-held-trigger"));
  if (wakes.length) return { code: "pending-wake-reference", pendingWakeReferences: wakes };
  if (group.some(candidate => existsSync(candidate.path) && (generatedOnlySourceCustody(database, candidate.id) || retainedParent(database, candidate.path))))
    return { code: "retained-custody" };
  if (Date.now() >= deadline) return { code: "deferred" };
  return null;
}
function lockedEndedOwnerVerdicts(database, group, deadline, requester) {
  // Fresh native readback and record CAS under the checkout lock; no earlier verdict is reused.
  const current = recordsInGroup(database, recordBy(database, { id: group[0].id }));
  const fresh = ownerLivenessObservation([...current.map(record => endedReleaseOwner(database, record)), ...(requester ? [requester.agentId] : [])], deadline);
  const verdicts = current.map(record => classifyOwner(endedReleaseOwner(database, record), fresh));
  const changed = current.length !== group.length || current.some(record => {
    const before = group.find(candidate => candidate.id === record.id);
    return !before || before.owner !== record.owner || before.path !== record.path || before.sourceCommit !== record.sourceCommit;
  });
  return { current, fresh, verdicts, changed };
}
function releaseEndedOwnerGroup(database, group, observation, options) {
  const verdicts = group.map(record => classifyOwner(endedReleaseOwner(database, record), observation));
  const refusal = endedOwnerRefusal(database, group, verdicts, observation, options.deadline, options.requester);
  if (refusal) return group.map((record, index) => ({ record: endedOwnerSummary(record), ownerLiveness: verdicts[index], action: "none", ...refusal }));
  if (!options.execute) return group.map((record, index) => ({ record: endedOwnerSummary(record), ownerLiveness: verdicts[index], action: "would-release-ended-owner" }));
  if (options.deadline - Date.now() < 10_000) return group.map((record, index) => ({ record: endedOwnerSummary(record), ownerLiveness: verdicts[index], action: "none", code: "deferred" }));
  const released = withWorkspaceLock(database, group[0].path, () => {
    const locked = lockedEndedOwnerVerdicts(database, group, options.deadline, options.requester);
    const freshRefusal = locked.changed ? { code: "owner-liveness-changed" } : endedOwnerRefusal(database, locked.current, locked.verdicts, locked.fresh, options.deadline, options.requester);
    if (freshRefusal) return { refused: locked.current.map((record, index) => ({ record: endedOwnerSummary(record), ownerLiveness: locked.verdicts[index], action: "none", ...freshRefusal })) };
    const byId = new Map(locked.current.map((record, index) => [record.id, locked.verdicts[index]]));
    const requester = options.requester;
    if (requester) {
      const rows = locked.fresh.agents.filter(a => a.id === requester.agentId);
      if (locked.current.some(record => !OWNER_AGENT_ID.test(canonicalNativeOwner(database,record)) && rows[0]?.parentAgentId !== canonicalNativeOwner(database,record)) ||
          rows.length !== 1 || rows[0].channel !== requester.channel || rows[0].role !== 'worker' ||
          rows[0].archived || rows[0].state === 'stopped')
        return {refused:locked.current.map(record=>({record:endedOwnerSummary(record),action:'none',code:'requester-not-live'}))};
    }
    const parents=locked.current.map(record=>requester ? {kind:'transfer',parent:requester.agentId,
      channel:requester.channel,child:endedReleaseOwner(database,record),observedAt:locked.fresh.observedAt}
      : parentCustody(endedReleaseOwner(database,record),locked.fresh));
    if(parents.some(p=>p.kind==='unknown'))return {refused:locked.current.map(record=>({record:endedOwnerSummary(record),action:'none',code:'parent-custody-unknown'}))};
    if(parents.some(p=>p.kind==='transfer')){
      // Group custody cannot be split by cleanup. Transfer only a complete proved group.
      if(parents.some(p=>p.kind!=='transfer'))return {refused:locked.current.map(record=>({record:endedOwnerSummary(record),action:'none',code:'parent-custody-group-incomplete'}))};
      database.exec(`CREATE TABLE IF NOT EXISTS workspace_parent_custody(workspace_id TEXT PRIMARY KEY,child_owner TEXT NOT NULL,parent_owner TEXT NOT NULL,evidence_json TEXT NOT NULL,occurred_at INTEGER NOT NULL)`);
      database.exec('BEGIN IMMEDIATE');
      try{
        const results=locked.current.map((record,index)=>{
          const parent=parents[index],now=Date.now();
          const authorization=JSON.stringify({...parent,kind:requester?'native-ended-owner-requester-custody':'native-ended-child-parent-custody'});
          if(record.sourceCommit!==null)database.prepare(`INSERT INTO workspace_reassignment(workspace_id,path,old_owner,old_source_commit,new_owner,new_source_commit,authorization,occurred_at) VALUES(?,?,?,?,?,?,?,?)`)
            .run(record.id,record.path,record.owner,record.sourceCommit,parent.parent,record.sourceCommit,authorization,now);
          database.prepare(`INSERT INTO workspace_parent_custody(workspace_id,child_owner,parent_owner,evidence_json,occurred_at) VALUES(?,?,?,?,?) ON CONFLICT(workspace_id) DO UPDATE SET child_owner=excluded.child_owner,parent_owner=excluded.parent_owner,evidence_json=excluded.evidence_json,occurred_at=excluded.occurred_at`).run(record.id,record.owner,parent.parent,authorization,now);
          database.prepare('UPDATE workspace SET owner=?,updated_at=? WHERE id=?').run(parent.parent,now,record.id);
          // The parent relationship is native evidence, never a fabricated parent tool call.
          reassignNativeOwner(database,record.id,requester??null,authorization);
          return {record:endedOwnerSummary(recordBy(database,{id:record.id})),action:requester?'transferred-to-requester':'transferred-to-parent',custody:parent,sourceDeleted:false};
        });
        database.exec('COMMIT');return {refused:results};
      }catch(error){database.exec('ROLLBACK');throw error;}
    }
    // Custody adoption on behalf of a release request never disposes anything by itself.
    if (options.transferOnly) return {refused:locked.current.map(record=>({record:endedOwnerSummary(record),action:'none',code:'no-custody-transfer'}))};
    // Ending a reservation does not require admitting new growth. The same terminal
    // release checks source reachability and strict runtime cessation before deletion.
    // Missing paths have no bytes to delete, even when their historical owner is unknown.
    if (locked.current.length === 1 && (!existsSync(locked.current[0].path) || recordRetainsCustody(database, locked.current[0].id))) {
      const record = locked.current[0];
      const row = database.prepare("SELECT plan_json FROM workspace_capacity WHERE workspace_id=?").get(record.id);
      if (row) {
        const args = {positional: [], named: new Map([["owner", [record.owner]], ["expected-plan-sha256", [digest(row.plan_json)]]])};
        return {byId, fresh: locked.fresh, settled: [terminalRetentionRelease(database, record, args, options.statePath, true)]};
      }
    }
    const releaseArgs = { positional: [], named: new Map([["preserve-runtime", ["true"]]]) };
    return { byId, fresh: locked.fresh, settled: ordinaryRelease(database, locked.current, releaseArgs, options.statePath, settleEndedOwnerFutureGrowth(byId), options.deadline, true) };
  }, group[0].groupId, options.deadline);
  if (released.refused) return released.refused;
  // A retained tree whose sample was stale is measured outside every lifecycle lock, then the
  // same settlement runs again under the checkout lock with a fresh native verdict.
  const samples = new Map();
  const settled = released.settled.map(item => {
    if (item.futureGrowthSettlement?.kind !== "retained" || item.futureGrowthSettlement.code !== "growth-sample-required") return item;
    const sample = refreshEndedOwnerSample(database, item.record, options.deadline, options.statePath);
    samples.set(item.record.id, sample);
    if (sample.kind !== "measured") return item;
    try {
      return withWorkspaceLock(database, item.record.path, () => {
        const locked = lockedEndedOwnerVerdicts(database, group, options.deadline, options.requester);
        const index = locked.current.findIndex(record => record.id === item.record.id);
        const again = locked.changed || index < 0 ? { code: "owner-liveness-changed" }
          : locked.verdicts[index].kind !== "ended" ? { code: locked.verdicts[index].kind === "live" ? "owner-live" : "owner-unknown" }
          : pendingWakeReferences(item.record.path, locked.fresh, locked.verdicts[index]).length ? { code: "pending-wake-reference" } : null;
        if (again) return { ...item, futureGrowthSettlement: { ...item.futureGrowthSettlement, code: again.code, detail: "owner liveness changed before settlement after measurement" } };
        released.byId.set(item.record.id, locked.verdicts[index]);
        return settleEndedOwnerFutureGrowth(released.byId)(database, { ...item, record: recordBy(database, { id: item.record.id }) }, item.releaseSettlement?.requestId ?? "unknown", options.statePath);
      }, item.record.groupId, options.deadline);
    } catch (error) {
      return { ...item, futureGrowthSettlement: { ...item.futureGrowthSettlement, code: error.code ?? "growth-settlement-unknown", detail: error.message } };
    }
  });
  database.exec(`CREATE TABLE IF NOT EXISTS workspace_owner_liveness_release (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id TEXT NOT NULL, request_id TEXT NOT NULL, occurred_at INTEGER NOT NULL,
    owner TEXT NOT NULL, verdict_json TEXT NOT NULL, observation_json TEXT NOT NULL, result_json TEXT NOT NULL)`);
  const insert = database.prepare("INSERT INTO workspace_owner_liveness_release(workspace_id,request_id,occurred_at,owner,verdict_json,observation_json,result_json) VALUES(?,?,?,?,?,?,?)");
  return settled.map(item => {
    const verdict = released.byId.get(item.record.id), requestId = item.releaseSettlement?.requestId ?? randomUUID();
    insert.run(item.record.id, requestId, Date.now(), verdict.owner, JSON.stringify(verdict),
      JSON.stringify({ observations: released.fresh.observations, observedAt: released.fresh.observedAt }),
      JSON.stringify({ action: item.action, physicalDisposition: item.physicalDisposition, futureGrowthSettlement: item.futureGrowthSettlement ?? null, capacitySample: samples.get(item.record.id) ?? null,
        inspection: { classification: item.inspection?.classification, reason: item.inspection?.reason } }));
    return { ...item, ownerLiveness: verdict, capacitySample: samples.get(item.record.id) ?? null };
  });
}
// Binds existing records whose registered owner is not a native worker id to the native worker
// that created them, from authenticated checkout-job admission receipts only. Idempotent.
function ownerCursor(database, args, scope, targeted) {
  // A targeted request never reads or writes a cursor, so it leaves the schema untouched.
  if (!targeted) database.exec("CREATE TABLE IF NOT EXISTS reconciliation_cursor (scope TEXT PRIMARY KEY, after_id TEXT NOT NULL)");
  const saved = bool(args,"execute") && !targeted ? database.prepare("SELECT after_id FROM reconciliation_cursor WHERE scope=?").get(scope)?.after_id : undefined;
  const after=one(args,"after",saved??"start");
  const anchor=after==="start"?null:database.prepare("SELECT id,root,path FROM workspace WHERE id=?").get(after);
  if(one(args,"after")!==undefined&&after!=="start"&&(!anchor||(one(args,"root")!==undefined&&anchor.root!==path.resolve(one(args,"root")))))fail("--after workspace is not in the selected pool: "+after);
  return {after,anchor,save:id=>{
    if(bool(args,"execute")&&!targeted)database.prepare("INSERT INTO reconciliation_cursor(scope,after_id) VALUES(?,?) ON CONFLICT(scope) DO UPDATE SET after_id=excluded.after_id").run(scope,id);
  }};
}

function bindNativeOwnersCommand(database, args, statePath, {authenticate=authenticateToolCalls}={}) {
  assertOnly(args, ["root", "id", "path", "execute", "budget-ms", "max-records", "after", "json"]);
  const maxRecords=numberFlag(args,"max-records",128);
  if(!Number.isSafeInteger(maxRecords)||maxRecords<1||maxRecords>512)fail("--max-records must be between 1 and 512");
  const budget = numberFlag(args, "budget-ms", 30_000);
  if (!Number.isSafeInteger(budget) || budget < 1000 || budget > 120_000) fail("--budget-ms must be between 1000 and 120000");
  const execute = bool(args, "execute"), deadline = Date.now() + budget;
  const targeted = one(args, "id") !== undefined || one(args, "path") !== undefined;
  if (targeted && one(args, "root") !== undefined) fail("bind-native-owners accepts --root or a single --id/--path selector");
  ensureNativeOwnerTable(database);
  const scope="native-owner-binding:"+(one(args,"root")===undefined?"*":path.resolve(one(args,"root")));
  const cursor=ownerCursor(database,args,scope,targeted), explicitWalk=one(args,"after")!==undefined;
  // Do not deserialize every historical creation request just to authenticate one small page.
  database.function("workspace_native_id",{deterministic:true},value=>OWNER_AGENT_ID.test(value??"")?1:0);
  const root=one(args,"root")===undefined?null:path.resolve(one(args,"root"));
  // A creation receipt names the original creator. Once release-ended-owners has moved custody
  // (to a parent or a requester), that creator is history, not the owner: re-binding it made the
  // sweep hand the checkout back down to the ended child and up to its parent again, forever
  // (workspace d639034e, October 29). Records with recorded custody transfer are never re-bound.
  const custodyTable=database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='workspace_parent_custody'").get()!==undefined;
  const predicate="state!='released' AND workspace_native_id(owner)=0 AND NOT EXISTS(SELECT 1 FROM workspace_native_owner n WHERE n.workspace_id=workspace.id)"+
    (custodyTable?" AND NOT EXISTS(SELECT 1 FROM workspace_parent_custody c WHERE c.workspace_id=workspace.id)":"")+" AND (? IS NULL OR root=?)";
  const candidates=targeted?1:database.prepare("SELECT count(*) AS count FROM workspace WHERE "+predicate).get(root,root).count;
  let page;
  if(targeted)page=[recordBy(database,selectorFrom(args,"bind-native-owners"))];
  else {
    const query=(comparison,limit)=>database.prepare(`SELECT workspace.*, ${ASSIGNMENT_SOURCE} FROM workspace WHERE ${predicate}${cursor.anchor?` AND (root,path,id) ${comparison} (?,?,?)`:""} ORDER BY root,path,id LIMIT ?`)
      .all(root,root,...(cursor.anchor?[cursor.anchor.root,cursor.anchor.path,cursor.anchor.id]:[]),limit).map(rowToRecord);
    page=query(">",maxRecords);
    if(cursor.anchor&&!explicitWalk&&page.length<maxRecords)page.push(...query("<=",maxRecords-page.length));
  }
  const results = [], pending = [];
  let last, examined=0, pairs=0;
  for (const record of page) {
    if(Date.now()>=deadline)break;
    const summary = { id: record.id, path: record.path, owner: record.owner, state: record.state };
    if (OWNER_AGENT_ID.test(record.owner)) { last=record.id;examined++;results.push({ record: summary, outcome: "native-registered-owner" }); continue; }
    const existing = nativeOwnerBinding(database, record.id);
    if (existing.state === "set") { last=record.id;examined++;results.push({ record: summary, outcome: "already-bound", binding: existing }); continue; }
    if (custodyTable && database.prepare("SELECT 1 FROM workspace_parent_custody WHERE workspace_id=?").get(record.id)) { last=record.id;examined++;results.push({ record: summary, outcome: "custody-transferred" }); continue; }
    const row = database.prepare("SELECT creation_request FROM workspace WHERE id=?").get(record.id);
    const receipt = row?.creation_request ? admissionReceipts(statePath, record.id, row.creation_request, {deadline}) : { kind: "none", code: "no-creation-request" };
    // Every receipt for a record must authenticate together. Do not split a record's proof.
    if(receipt.kind==="receipt"&&pairs+receipt.pairs.length>512)break;
    last=record.id;examined++;
    if (receipt.kind !== "receipt") { results.push({ record: summary, outcome: "unbound", code: receipt.code }); continue; }
    pairs+=receipt.pairs.length;
    pending.push({ record, summary, receipt });
  }
  const authentication = pending.length ? authenticate(pending.flatMap(item => item.receipt.pairs), { deadline }) : { errors: [], confirmed: new Map() };
  for (const { record, summary, receipt } of pending) {
    const verdict = receiptBinding(receipt, authentication);
    if (verdict.kind !== "bindable") { results.push({ record: summary, outcome: "unbound", code: verdict.code, ...(verdict.detail ? { detail: verdict.detail } : {}) }); continue; }
    if (!execute) { results.push({ record: summary, outcome: "would-bind", binding: verdict.binding }); continue; }
    if(Date.now()>=deadline){results.push({record:summary,outcome:"unbound",code:"binding-deferred"});continue;}
    withWorkspaceLock(database, record.path, () => {
      const current = recordBy(database, { id: record.id });
      if (current.owner !== record.owner || current.state === "released" || nativeOwnerBinding(database, record.id).state === "set") {
        results.push({ record: summary, outcome: "unbound", code: "record-changed" });
        return;
      }
      const currentRequest = database.prepare("SELECT creation_request FROM workspace WHERE id=?").get(record.id)?.creation_request;
      const currentReceipt = currentRequest ? admissionReceipts(statePath, record.id, currentRequest, {deadline}) : {kind:"none"};
      if (JSON.stringify(currentReceipt) !== JSON.stringify(receipt)) {
        results.push({record: summary, outcome: "unbound", code: "receipt-changed"}); return;
      }
      bindNativeOwner(database, record.id, verdict.binding, "admission-receipt", verdict.evidence);
      results.push({ record: summary, outcome: "bound", binding: verdict.binding });
    }, record.groupId, deadline);
  }
  const counts = {};
  for (const item of results) { const key = item.outcome === "unbound" ? `unbound:${item.code}` : item.outcome; counts[key] = (counts[key] ?? 0) + 1; }
  if(last!==undefined)cursor.save(last);
  return { ok: authentication.errors.length === 0, kind: "native-owner-binding", execute, candidates, examined, maxRecords, authenticatedPairs:pairs, counts,
    nextAfter:last!==undefined&&database.prepare("SELECT 1 FROM workspace WHERE "+predicate+" AND (root,path,id)>(SELECT root,path,id FROM workspace WHERE id=?) LIMIT 1").get(root,root,last)?last:null,
    observation: { errors: authentication.errors }, results };
}

function releaseEndedOwnersCommand(database, args, statePath, authorityDependencies, {transferOnly=false}={}) {
  assertOnly(args, ["root", "id", "path", "execute", "budget-ms", "max-records", "after", "json"]);
  const budget = numberFlag(args, "budget-ms", 30_000), maxRecords = numberFlag(args, "max-records", 16);
  if (!Number.isSafeInteger(budget) || budget < 1000 || budget > 40_000) fail("--budget-ms must be between 1000 and 40000");
  if (!Number.isSafeInteger(maxRecords) || maxRecords < 1 || maxRecords > 64) fail("--max-records must be between 1 and 64");
  const execute = bool(args, "execute"), deadline = Date.now() + budget;
  const targeted = one(args, "id") !== undefined || one(args, "path") !== undefined;
  if (targeted && one(args, "root") !== undefined) fail("release-ended-owners accepts --root or a single --id/--path selector");
  let requester;
  if (targeted && execute) {
    const authority = authorizeWorkspaceRelease(database, [], statePath, {deadline,...authorityDependencies});
    if (!authority.ok) return authority;
    if (authority.kind === 'native' && OWNER_AGENT_ID.test(authority.binding.agentId)) requester = authority.binding;
  }
  let records = targeted ? [recordBy(database, selectorFrom(args, "release-ended-owners"))] : listRecords(database, one(args, "root"));
  // A checkout whose native owner was never bound (only its admission receipt names the creator) was
  // invisible here while release itself already named that creator as custodian (kenan-bg-fast,
  // 2026-10-30). Bind the one targeted record first, so an ended creator's custody can move.
  if (targeted && execute && !OWNER_AGENT_ID.test(canonicalNativeOwner(database, records[0]))) {
    bindNativeOwnersCommand(database, {positional:[], named:new Map([["id",[records[0].id]],["execute",["true"]],["budget-ms",[String(Math.max(1000, Math.min(15_000, deadline - Date.now() - 1000)))]]])}, statePath,
      authorityDependencies?.authenticate ? {authenticate:authorityDependencies.authenticate} : {});
    records = [recordBy(database, {id:records[0].id})];
  }
  records = records.filter(record => ENDED_OWNER_STATES.includes(record.state) && (OWNER_AGENT_ID.test(canonicalNativeOwner(database, record)) || (requester && OWNER_AGENT_ID.test(endedReleaseOwner(database, record))) || !existsSync(record.path)));
  const scope = `owner-liveness:${one(args, "root") === undefined ? "*" : path.resolve(one(args, "root"))}`;
  const cursor=ownerCursor(database,args,scope,targeted), explicitWalk=one(args,"after")!==undefined;
  const ordered=records.map(record=>record.id);
  const pool=records;
  records=ownerPage(records,cursor.anchor,{wrap:!explicitWalk});
  // Look beyond the action page before choosing it, so live owners cannot consume every slot.
  // A separate persisted scan cursor covers registries larger than the 512-owner SQL bound.
  const scan=ownerCursor(database,{...args,named:new Map([...args.named].filter(([name])=>name!=="after"))},scope+":scan",targeted||explicitWalk);
  const window=(explicitWalk||pool.length<=512?records:ownerPage(pool,scan.anchor)).slice(0,512);
  const observedMembers=window.flatMap(record=>recordsInGroup(database,record));
  const owners=[...new Set(observedMembers.map(record=>endedReleaseOwner(database,record)).filter(owner=>OWNER_AGENT_ID.test(owner)))];
  // Large groups cannot overflow native authentication; retain them instead of weakening proof.
  const observation=ownerLivenessObservation(owners.slice(0,512),deadline);
  const priority=record=>classifyOwner(endedReleaseOwner(database,record),observation).kind==="ended"?0:1;
  // A large scan window can contain more ended owners than one action page. Remember actual
  // attempts, not just the window anchor, so repeatedly retained trees cannot starve its tail.
  if(!targeted)database.exec("CREATE TABLE IF NOT EXISTS workspace_owner_sweep_attempt(sequence INTEGER PRIMARY KEY AUTOINCREMENT, scope TEXT NOT NULL, workspace_id TEXT NOT NULL, UNIQUE(scope,workspace_id))");
  const attempts=targeted?new Map():new Map(database.prepare("SELECT workspace_id,sequence FROM workspace_owner_sweep_attempt WHERE scope=?").all(scope).map(row=>[row.workspace_id,row.sequence]));
  const page=(explicitWalk?window:window.toSorted((a,b)=>priority(a)-priority(b)||(attempts.get(a.id)??0)-(attempts.get(b.id)??0)||records.indexOf(a)-records.indexOf(b))).slice(0,maxRecords);
  if(window.length&&observation.errors.length===0)scan.save(window.at(-1).id);
  const results = [], visited = new Set();
  let last;
  for (const record of page) {
    if (visited.has(record.id)) continue;
    const group = recordsInGroup(database, record);
    for (const member of group) visited.add(member.id);
    try {
      results.push(...releaseEndedOwnerGroup(database, group, observation, { execute, deadline, statePath, requester, transferOnly }));
    } catch (error) {
      results.push(...group.map(member => ({ record: endedOwnerSummary(member), action: "none", code: error instanceof ResourceBusyError ? "resource-busy" : error.code ?? "owner-liveness-release-failed", detail: error.message })));
    }
    last = record.id;
    if(results.at(-1)?.code!=="deferred"){
      cursor.save(last);
      if(execute&&!targeted&&!explicitWalk)database.prepare("INSERT OR REPLACE INTO workspace_owner_sweep_attempt(scope,workspace_id) VALUES(?,?)").run(scope,record.id);
    }
  }
  const counts = {};
  // An executed release that retained the tree reports action "none" without a refusal code.
  const outcome = item => item.action !== "none" ? item.action : item.code ?? `release-retained:${item.inspection?.classification ?? "unknown"}`;
  for (const item of results) counts[outcome(item)] = (counts[outcome(item)] ?? 0) + 1;
  return { ok: observation.errors.length === 0, kind: "owner-liveness-release", execute, candidates: records.length, examined: results.length, counts,
    observation: { errors: observation.errors, observations: observation.observations, observedAt: observation.observedAt },
    // Explicit walks are pool-order pagination, not the timer's priority order.
    nextAfter: last !== undefined && ordered.indexOf(last) < ordered.length - 1 ? last : null, results };
}

function reapEndedOwnersCommand(database,args,statePath,dependencies={}) {
  assertOnly(args,["root","execute","json","bind-budget-ms","bind-max-records","budget-ms","max-records"]);
  const flags=(budget,max)=>({positional:[],named:new Map([
    ...(one(args,"root")===undefined?[]:[["root",[one(args,"root")]]]),
    ...(bool(args,"execute")?[["execute",["true"]]]:[]),["budget-ms",[String(budget)]],["max-records",[String(max)]],["json",["true"]]])});
  // Validate both phases before the first mutation, even if binding later refuses.
  const totalBudget=numberFlag(args,"budget-ms",90000),bindBudget=numberFlag(args,"bind-budget-ms",Math.min(15000,totalBudget-1000));
  const releaseBudget=Math.min(40000,totalBudget-bindBudget);
  const bindMax=numberFlag(args,"bind-max-records",128),releaseMax=numberFlag(args,"max-records",64);
  if(!Number.isSafeInteger(totalBudget)||totalBudget<2000||totalBudget>120000||!Number.isSafeInteger(bindBudget)||bindBudget<1000||bindBudget>30000||releaseBudget<1000||!Number.isSafeInteger(bindMax)||bindMax<1||bindMax>512||!Number.isSafeInteger(releaseMax)||releaseMax<1||releaseMax>64)fail("owner reaper requires a 2000..120000 ms total budget, binding (1..512 records, 1000..30000 ms) and release (1..64 records, at most 40000 ms)");
  return reapEndedOwners({bind:()=>bindNativeOwnersCommand(database,flags(bindBudget,bindMax),statePath,dependencies),
    release:()=>releaseEndedOwnersCommand(database,flags(releaseBudget,releaseMax),statePath)});
}

// A released workspace whose tree is gone is history, not state. Keep a month
// of it for questions like "what happened to that checkout" and no more; a
// busy fleet registers thousands of checkouts and each one used to stay forever.
const RELEASED_RETENTION_MS = 30 * 24 * 60 * 60_000;
function pruneReleased(database, now = Date.now(), root) {
  const stale = root === undefined
    ? database.prepare("SELECT id, path FROM workspace WHERE state = 'released' AND updated_at < ?").all(now - RELEASED_RETENTION_MS)
    : database.prepare("SELECT id, path FROM workspace WHERE state = 'released' AND updated_at < ? AND root=?").all(now - RELEASED_RETENTION_MS, path.resolve(root));
  const remove = database.prepare("DELETE FROM workspace WHERE id = ?");
  let pruned = 0;
  for (const row of stale) {
    if (existsSync(row.path)) continue;
    remove.run(row.id);
    pruned += 1;
  }
  database.exec("DELETE FROM workspace_capacity WHERE workspace_id NOT LIKE 'execution:%' AND NOT EXISTS (SELECT 1 FROM workspace WHERE workspace.id=workspace_capacity.workspace_id)");
  database.exec("DELETE FROM workspace_capacity_measurement WHERE NOT EXISTS (SELECT 1 FROM workspace WHERE workspace.id=workspace_capacity_measurement.workspace_id)");
  if(database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='workspace_growth_policy'").get()) database.exec("DELETE FROM workspace_growth_policy WHERE NOT EXISTS (SELECT 1 FROM workspace WHERE workspace.id=workspace_growth_policy.workspace_id)");
  return pruned;
}

function assertRepriceSnapshot(before,current) {
  if(JSON.stringify(current.record)!==JSON.stringify(before.record)||current.row?.device_id!==before.row.device_id||current.row?.plan_json!==before.row.plan_json||current.sampleText!==before.sampleText)
    growthError('capacity-reprice-conflict','workspace identity, owner, sample or reservation changed before repricing commit');
}

function repriceCapacityCommand(database, args, statePath, resume = false) {
  const commandName=resume?"resume-growth":"reprice-capacity";
  assertOnly(args, ["id", "path", "intent", "headroom-gib", "growth-mib", "budget-ms", "json", ...(resume ? ["owner", "expected-plan-sha256"] : ["owner", "reduction", "reduction-sha256"])]);
  const budgetMs = numberFlag(args, "budget-ms", 25_000);
  if (!Number.isSafeInteger(budgetMs) || budgetMs < 1 || budgetMs > 40_000) growthError("invalid-observation-budget", "--budget-ms must be an integer between 1 and 40000");
  const deadline = Date.now() + budgetMs;
  const intent = capacityIntent(args);
  if (intent === null) growthError("invalid-capacity-request", `${commandName} requires explicit intent, headroom and remaining growth`);
  const reducing = !resume && args.named.has("reduction");
  let reduction = null;
  let reductionSha256 = null;
  if (reducing) {
    const bytes = readFileSync(required(args, "reduction"), "utf8");
    reductionSha256 = digest(bytes);
    if (reductionSha256 !== required(args, "reduction-sha256")) growthError("growth-evidence-changed", "reduction bytes changed");
    try { reduction = JSON.parse(bytes); } catch { growthError("invalid-growth-reduction", "reduction must be JSON"); }
  } else if (!resume && (args.named.has("owner") || args.named.has("reduction-sha256"))) growthError("invalid-growth-reduction", "reduction evidence is required with reduction options");
  const selection=selectedArguments(commandName,{id:one(args,'id'),path:one(args,'path')});
  if(!reducing&&!selection.ok)throw Object.assign(new GrowthLifecycleError(selection.error.code,selection.error.detail),{nextAction:selection.error.nextAction});
  const selected = reducing ? growthSelected(database, args) : recordBy(database, selection.value.id===undefined?{path:selection.value.path}:{id:selection.value.id});
  if(resume&&selection.value.path!==undefined&&selected.path!==path.resolve(selection.value.path))growthError("growth-identity-changed", "resume-growth id and path do not name the same workspace");
  const device = database.prepare("SELECT device_id FROM workspace_capacity WHERE workspace_id=?").get(selected.id)?.device_id;
  settleMissingCapacity(database,statePath,device,deadline);
  const decide = () => duringInspection(deadline, () => withWorkspaceLock(database, selected.path, () => {
    const record = recordBy(database, { id: selected.id });
    if (!["active", "referenced", "blocked", "repair-required"].includes(record.state)) fail(`workspace cannot reprice capacity from state ${record.state}`);
    const row = database.prepare("SELECT device_id,plan_json FROM workspace_capacity WHERE workspace_id=?").get(record.id);
    if (row === undefined) fail("capacity repricing requires an existing capacity plan");
    const oldPlan = JSON.parse(row.plan_json);
    const retired = retainedGrowth(oldPlan);
    if (retainedParent(database,record.path)) growthError("growth-admission-required", "shared Git parent requires resume-growth admission");
    if (retired !== resume) growthError("growth-admission-required", retired ? "use explicit resume-growth admission" : "growth is not retired");
    if (resume && (record.owner !== required(args, "owner") || digest(row.plan_json) !== required(args, "expected-plan-sha256"))) growthError("stale-growth-disposition", "resume owner or plan changed");
    if (reducing && oldPlan.intent === "budgeted" && intent.intent === "source-only") {
      throw Object.assign(new GrowthLifecycleError("capacity-intent-downgrade", "active budget reduction does not prove build/database writers ceased; preserve budgeted intent and reduce only the remaining allowance"), {
        nextAction: {kind:"preserve-active-intent", intent:"budgeted", newWritesAuthorized:false,
          detail:"Read a fresh growth-status binding; submit owner-bound reduction with --intent budgeted. Zero-future-growth completed work uses retire-growth."}
      });
    }
    const expandingBudget = ["source-only", "budgeted"].includes(oldPlan.intent) && (intent.intent === "budgeted" || (reducing && intent.intent === oldPlan.intent) || (resume && oldPlan.intent === "source-only" && intent.intent === "source-only"));
    if (oldPlan.intent !== "unestimated" && !expandingBudget) growthError("invalid-capacity-transition", resume ? "resume-growth accepts retired source-only to source-only or source-only/budgeted to budgeted admission" : "reprice-capacity accepts unestimated plans or source-only/budgeted to budgeted expansion");
    capacityRequirement(oldPlan, []);
    if (record.durableSourceCommit === null) fail("capacity repricing requires immutable source custody");
    const creationRequest = database.prepare("SELECT creation_request FROM workspace WHERE id=?").get(record.id).creation_request;
    const sparsePatterns = creationRequest === null ? [] : JSON.parse(creationRequest).sparsePatterns ?? [];
    const plan = expandingBudget ? { ...oldPlan, ...intent } : sourceCheckoutCapacity(record.path,
      record.durableSourceCommit, intent, statfsSync(record.path).bsize, sparsePatterns);
    if (!expandingBudget) plan.completedAllocationBytes = plan.constructionBytes;
    if (resume) { delete plan.growthLifecycle; delete plan.retainedHeadroom; }
    withResourceLock(statePath, `capacity:${row.device_id}`, () => {
      const measurement = cachedWorkspaceAllocation(database, record.id, record.path, row.device_id);
      if (!measurement.ok) fail(`capacity repricing requires a fresh allocated-block sample: ${measurement.error}; run measure-capacity first`);
      const sampleText = database.prepare("SELECT measurement_json FROM workspace_capacity_measurement WHERE workspace_id=?").get(record.id).measurement_json;
      const sample = JSON.parse(sampleText);
      // Recheck actual allocation under the same filesystem fence. Keep the bound
      // cache immutable, and never credit a deletion behind that cache implicitly.
      const currentSample = reducing ? workspaceAllocationSample(record.path, row.device_id, {deadline:deadline - 2_000,maxEntries:2_000_000}) : sample;
      if (!currentSample.ok) growthError("growth-sample-required", currentSample.error);
      const baseline = capacityAllocationBaseline(plan, record.state);
      const sampledGrowthBytes = Math.max(0, Math.max(sample.bytes, currentSample.bytes) - baseline);
      // The ledger reads growth through the margin-discounted cache, so the bytes
      // inside that margin are still reserved by the existing plan. Booking the
      // raw sample on top would charge them twice. A reduction's fresh complete
      // walk is exact, so it books the raw sample.
      const accountedGrowthBytes = reducing ? sampledGrowthBytes : Math.max(0, measurement.bytes - baseline);
      plan.growthBytes += accountedGrowthBytes;
      capacityRequirement(plan, []);
      if (reducing) {
        validateReduction(reduction, growthBinding(database, record).binding, required(args, "owner"), intent.growthBytes);
        if (!expandingBudget || plan.growthBytes >= oldPlan.growthBytes || plan.headroomBytes < Math.max(oldPlan.headroomBytes, 8 * 1024 ** 3)) {
          growthError("unsafe-growth-reduction", "reduction must lower total future budget, preserve headroom and retain the 8 GiB floor");
        }
      }
      const existingLiability = ledgerLiability(oldPlan, record.state, measurement);
      const priorLiability = {...existingLiability};
      // A target whose original budget was automatically discounted cannot
      // silently restore that discount through the no-increase lane.
      if(!resume) {
        const policy=projectGrowthPolicy(database,{id:record.id,state:record.state,created_at:record.createdAt},oldPlan,{...measurement,bytes:measurement.rawBytes??measurement.bytes});
        if(policy&&policy.reason!=='fresh-workspace')priorLiability.reservedBytes=policy.effectiveRemainingBytes??oldPlan.growthBytes;
      }
      if (expandingBudget && (plan.headroomBytes < oldPlan.headroomBytes || (!resume && !reducing &&
        remainingCapacityBytes(plan, record.state, measurement) < existingLiability.reservedBytes))) {
        fail("budget expansion cannot reduce headroom or total growth budget");
      }
      plan.repricing = { priorIntent: oldPlan.intent, sampledGrowthBytes, accountedGrowthBytes, remainingGrowthBytes: intent.growthBytes,
        measurementStartedAt: sample.startedAt, measurementCompletedAt: sample.completedAt, marginBytes: measurement.marginBytes };
      if (reducing) {
        plan.repricing.reduction = { ...reduction, sha256: reductionSha256 };
        plan.repricing.currentMeasurement = currentSample;
      }
      // A true no-increase replacement needs only ledger promises. An actual
      // increase must use CREATE's exact cache/history projection, not rebook
      // already consumed allocation as if it were still future demand. This
      // projection reads bound samples only; it never starts a filesystem walk.
      let reservations = resume ? undefined : repriceReservations(database,row.device_id,record.path);
      if(!resume&&!reducing) {
        const after=capacityRequirement({...plan,constructionBytes:0,growthBytes:remainingCapacityBytes(plan,record.state,measurement)},reservations.priced,reservations.headroomBytes);
        const before=priorLiability.reservedBytes+Math.max(priorLiability.headroomBytes,reservations.headroomBytes)+reservations.priced.reduce((a,b)=>a+b,0);
        if(after>before)reservations={...capacityReservations(database,row.device_id,record.path),observation:'create-sampled-ledger',samplesRead:true};
      }
      if (!reducing) plan.admission = assertCapacity(record.root, args, database, record.path, {
        ...plan, constructionBytes: 0, growthBytes: remainingCapacityBytes(plan, record.state, measurement),
      }, {kind:"reprice", liability:priorLiability, reservations});
      database.exec("BEGIN IMMEDIATE");
      try {
        const current = recordBy(database, {id:record.id});
        const currentCapacity=database.prepare("SELECT device_id,plan_json FROM workspace_capacity WHERE workspace_id=?").get(record.id);
        const currentSampleText=database.prepare("SELECT measurement_json FROM workspace_capacity_measurement WHERE workspace_id=?").get(record.id)?.measurement_json;
        assertRepriceSnapshot({record,row,sampleText},{record:current,row:currentCapacity,sampleText:currentSampleText});
        if (reducing) {
          validateReduction(reduction, growthBinding(database, current).binding, required(args, "owner"), intent.growthBytes);
          const fresh = cachedWorkspaceAllocation(database, record.id, record.path, row.device_id);
          if (!fresh.ok) growthError("growth-sample-required", fresh.error);
          plan.admission = assertCapacity(record.root, args, database, record.path,
            {...plan, constructionBytes:0, growthBytes:remainingCapacityBytes(plan, current.state, fresh)},
            {kind:"reduction", plan:{...oldPlan, constructionBytes:0, growthBytes:Math.min(priorLiability.reservedBytes,remainingCapacityBytes(oldPlan, current.state, fresh))}, reservations});
        }
        const changed = database.prepare("UPDATE workspace_capacity SET plan_json=? WHERE workspace_id=? AND plan_json=?")
          .run(JSON.stringify(plan), record.id, row.plan_json).changes;
        if (changed !== 1) fail("capacity repricing conflicts with another plan change");
        database.prepare("INSERT INTO workspace_capacity_repricing(workspace_id,occurred_at,old_plan_json,new_plan_json,measurement_json) VALUES(?,?,?,?,?)")
          .run(record.id, Date.now(), row.plan_json, JSON.stringify(plan), JSON.stringify(sample));
        database.exec("COMMIT");
      } catch (error) { database.exec("ROLLBACK"); throw error; }
    }, deadline);
    print(creationRecord(database, record.id), bool(args, "json"));
  }, selected.groupId, deadline));
  // Ordinary increases use the same sampled projection as CREATE, but never
  // run unrelated tree refresh loops inside their bounded observation budget.
  // Explicit resume keeps its existing refusal-driven admission route.
  return !resume ? decide() : withCapacityRefresh(database, statePath, device, decide,
    {budgetMs: Math.max(0, deadline - Date.now())});
}


function growthBinding(database, record) {
  const row = database.prepare("SELECT device_id,plan_json FROM workspace_capacity WHERE workspace_id=?").get(record.id);
  const measurement = database.prepare("SELECT measurement_json FROM workspace_capacity_measurement WHERE workspace_id=?").get(record.id);
  if (!row || !measurement) growthError("growth-sample-required", "existing plan and allocated-block sample required");
  const plan = JSON.parse(row.plan_json);
  capacityRequirement(plan, []);
  retainedGrowth(plan);
  const root = lstatSync(record.path);
  if (!root.isDirectory() || String(root.dev) !== row.device_id) growthError("growth-identity-changed", "root is not the reserved directory/filesystem");
  const dependencies = gitDependencySnapshot(database);
  const borrowerRows = [...new Set([...dependencies.alternates.filter(value => value.recordId !== record.id && within(record.path,value.objectDirectory)),
    ...dependencies.linkedWorktrees.filter(value => value.recordId !== record.id && within(record.path,value.commonDirectory))].map(value => value.recordId))]
    .sort().map(id => recordBy(database,{id}));
  const binding = { gitInventorySha256:digest(git(record.path,["worktree","list","--porcelain"])+"\n"+git(record.path,["for-each-ref","--format=%(refname) %(objectname)","refs/heads"])), borrowersSha256:digest(JSON.stringify(borrowerRows)), id: record.id, path: record.path, owner: record.owner, sourceCommit: record.sourceCommit,
    durableSourceCommit: record.durableSourceCommit, head:git(record.path, ["rev-parse", "HEAD"]), state: record.state, updatedAt: record.updatedAt,
    leaseExpiresAt: record.leaseExpiresAt, device: row.device_id, inode: String(root.ino),
    planSha256: digest(row.plan_json), sampleSha256: digest(measurement.measurement_json) };
  return { binding, row, plan, measurement };
}

function growthSelected(database, args, commandName = 'retire-growth') {
  const selected=selectedArguments(commandName,{id:one(args,'id'),path:one(args,'path')});
  if(!selected.ok)throw Object.assign(new GrowthLifecycleError(selected.error.code,selected.error.detail),{nextAction:selected.error.nextAction});
  const record = recordBy(database, selected.value.id === undefined ? { path: selected.value.path } : { id: selected.value.id });
  if (selected.value.path !== undefined && record.path !== path.resolve(selected.value.path)) growthError("growth-identity-changed", "id and path do not name the same workspace");
  return record;
}

function growthStatusCommand(database, args, statePath) {
  assertOnly(args, ["id", "path", "json"]);
  const selected = growthSelected(database, args, "growth-status");
  withWorkspaceLock(database, selected.path, () => {
    const {binding, plan, measurement} = growthBinding(database, recordBy(database, {id:selected.id}));
    const sampleStatus = cachedWorkspaceAllocation(database, selected.id, selected.path, binding.device);
    print({ok:true, binding, plan, sample:JSON.parse(measurement.measurement_json), sampleStatus}, bool(args, "json"));
  }, selected.groupId);
}

function growthProcessReferences(paths) {
  const snapshot = processSnapshot(true,paths);
  return paths.flatMap(root => processReferences(root,snapshot).map(reference => ({...reference,root})));
}
function growthSafety(database, record, {preservationOnly=false,snapshot}={}) {
  const isolated = process.env.NODE_TEST_CONTEXT !== undefined && process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY === "empty";
  const dependencies = snapshot === undefined ? gitDependencySnapshot(database) :
    {alternates:snapshot.gitAlternates,linkedWorktrees:snapshot.linkedWorktrees};
  const retainedBorrowers = [...dependencies.alternates.filter(value => value.recordId !== record.id && within(record.path, value.objectDirectory)),
    ...dependencies.linkedWorktrees.filter(value => value.recordId !== record.id && within(record.path, value.commonDirectory))];
  const borrowers = new Map(retainedBorrowers.map(value => [value.workspacePath, recordBy(database,{id:value.recordId})]));
  // Include Git's complete linked-worktree list, not just registered borrowers.
  const common = existsSync(record.path) ? path.resolve(record.path, git(record.path,["rev-parse","--git-common-dir"])) : null;
  if (common === path.join(record.path,".git")) for (const line of git(record.path,["worktree","list","--porcelain"]).split("\n")) {
    if (!line.startsWith("worktree ")) continue;
    const borrowerPath = line.slice(9);
    if (borrowerPath !== record.path && !borrowers.has(borrowerPath)) {
      if(!preservationOnly)growthError("growth-writer-unknown", `unregistered linked borrower ${borrowerPath}`);
      borrowers.set(borrowerPath,null); // Retain every byte; observe its execution, not its registration.
    }
  }
  const paths = [record.path,...borrowers.keys()];
  let processes = [];
  if (!isolated) {
    if (process.getuid?.() === 0) processes = growthProcessReferences(paths);
    else {
      const observed = command("sudo", ["-n", process.execPath, new URL(import.meta.url).pathname,
        "growth-process-snapshot", ...paths.flatMap(value => ["--path",value])], {timeout:10_000});
      if (observed.status !== 0) growthError("growth-writer-unknown", `privileged process observation failed: ${observed.stderr}`);
      try { processes = JSON.parse(observed.stdout); } catch { growthError("growth-writer-unknown", "invalid process observation"); }
      if (!Array.isArray(processes)) growthError("growth-writer-unknown", "process observation is not an array");
    }
  }
  const docker = snapshot?.docker ?? (isolated ? {containers:[], available:false} : dockerSnapshot());
  const systemd = snapshot?.systemd ?? (isolated ? {units:[], available:false} : systemdSnapshot());
  const threads = snapshot?.threads ?? (isolated && !process.env.PI_THREAD_DATABASE ? [] :
    threadSnapshot(undefined, {cacheFile:observationCache(database, "thread-references.v1.json")}));
  const containers = dockerReferences(record.path, docker);
  const units = systemdReferences(record.path, systemd);
  return {errors:[docker.error, systemd.error].filter(value => value !== undefined),
    references:[...processes, ...containers.references, ...units.references,
      ...threads.filter(thread => paths.some(root => within(root, thread.cwd))),
      ...[...borrowers.values()].filter(borrower => !preservationOnly && borrower && borrower.leaseExpiresAt > Date.now()).map(borrower => ({kind:"borrower-writing-lease",id:borrower.id})),
      ...[...borrowers.keys()].flatMap(root => [...dockerReferences(root,docker).references, ...systemdReferences(root,systemd).references])],
    // Borrowing Git objects is retention, not a growth writer in the parent's checkout.
    retainedBorrowers, executionRoots:paths,
    observedAt:Date.now()};
}

function terminalSafety(database,record,deadline,preservationOnly=false) {
  const safety=growthSafety(database,record,{preservationOnly});
  const roots=safety.executionRoots??[record.path,...new Set(safety.retainedBorrowers.map(b=>b.workspacePath))];
  const isolated=process.env.NODE_TEST_CONTEXT!==undefined && process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY==="empty";
  const native=isolated?{errors:[],references:[],observations:[]}:currentStackQueueReferences(roots,{resourceKind:"physical-checkout",deadline});
  return {...safety,errors:[...safety.errors,...native.errors],references:[...safety.references,...native.references],nativeObservations:native.observations};
}
function verifiedRemoteCustody(record) {
  const observed=observedRemoteHeads(command,record.path);
  if(!observed.ok)growthError(observed.code==="remote-custody-absent"?"retained-source-unpublished":"retained-source-unknown",observed.detail);
  const {durable,observations}=observed;
  const candidates=[git(record.path,["rev-parse","HEAD"]),...git(record.path,["for-each-ref","--format=%(objectname)","refs/heads"]).split("\n").filter(Boolean)];
  if(!durable.length||hasUncoveredCommits((a,o)=>git(record.path,a,o),candidates,durable))growthError("retained-source-unpublished","local HEAD/branches not covered by current remote heads");
  return observations;
}

function materializationProcessReferences(roots) {
  const snapshot = processSnapshot(true, roots, "all");
  return roots.flatMap(root => processReferences(root, snapshot).map(reference => ({...reference, root})));
}
function materializationSafety(database, parent, roots, resourceKind, cacheRoots) {
  if(!["source","generated-cache"].includes(resourceKind)) throw new MaterializationError("materialization-safety-unknown","explicit resource kind required");
  if (!Array.isArray(roots) || (resourceKind==="source"?roots.length!==2:roots.length<1||roots.length>65) || roots.some(root => typeof root !== "string" || !path.isAbsolute(root)))
    throw new MaterializationError("materialization-safety-unknown", "exact original and staging roots required");
  if (process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY !== undefined || process.env.NODE_TEST_CONTEXT !== undefined)
    throw new MaterializationError("materialization-safety-unknown", "native materialization safety has no test override");
  let processes;
  if (process.getuid?.() === 0) processes = materializationProcessReferences(roots);
  else {
    const observed = command("sudo", ["-n", process.execPath, new URL(import.meta.url).pathname,
      "materialization-process-snapshot", ...roots.flatMap(root => ["--path", root])], {timeout: 10000});
    if (observed.status !== 0) throw new MaterializationError("materialization-safety-unknown", `privileged all-FD observer failed: ${observed.stderr}`);
    try { processes = JSON.parse(observed.stdout); } catch { throw new MaterializationError("materialization-safety-unknown", "invalid process observation JSON"); }
    if (!Array.isArray(processes) || processes.some(row => !row || !Number.isSafeInteger(row.pid) || !Array.isArray(row.matches)))
      throw new MaterializationError("materialization-safety-unknown", "invalid process observations");
  }
  const docker = dockerSnapshot(), systemd = systemdSnapshot(), threads = threadSnapshot();
  const dependencies = gitDependencySnapshot(database);
  const retainedBorrowers = [...dependencies.alternates, ...dependencies.linkedWorktrees].filter(value =>
    value.recordId !== parent.id && roots.some(root =>
      typeof value.objectDirectory === "string" && within(root, value.objectDirectory) ||
      typeof value.commonDirectory === "string" && within(root, value.commonDirectory)));
  const queued=currentStackQueueReferences(roots,{resourceKind,cacheRoots,deadline:inspectionDeadline});
  return {errors: [docker.error, systemd.error,...queued.errors].filter(value => value !== undefined),
    references: [...processes,...queued.references, ...roots.flatMap(root => [...dockerReferences(root, docker).references, ...systemdReferences(root, systemd).references]),
      ...threads.filter(thread => typeof thread.cwd !== "string" || roots.some(root => within(root, thread.cwd)))],
    retainedBorrowers, observedAt: Date.now()};
}
function cacheSymlinkSafety(database, record, roots) {
  if (process.env.NODE_TEST_CONTEXT !== undefined && process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY === "empty")
    return {errors:[], references:[], retainedBorrowers:[], observedAt:Date.now()};
  const safety = materializationSafety(database, record, roots, "generated-cache", roots);
  const installed = installedReferenceSnapshot(census.INSTALL_ROOTS);
  const qualifications = qualificationReferences(roots);
  return {...safety, errors:[...safety.errors, ...qualifications.errors],
    references:[...safety.references, ...cacheAliasInstalledReferences(roots[0], installed), ...qualifications.references], observedAt:Date.now()};
}

function cacheBinding(database, id) {
  const record=recordBy(database,{id});
  if (!["active","referenced","blocked","repair-required"].includes(record.state)) throw new CacheRetirementError("cache-lifecycle-protected", "workspace lifecycle is not retained/ended");
  const stat=lstatSync(record.path,{bigint:true});
  return {id:record.id,path:record.path,owner:record.owner,sourceCommit:record.sourceCommit,durableSourceCommit:record.durableSourceCommit,
    head:git(record.path,["rev-parse","HEAD"]),device:String(stat.dev),inode:String(stat.ino),updatedAt:record.updatedAt,leaseExpiresAt:record.leaseExpiresAt};
}
function classifyWorkspaceCache(record, request) {
  const relative=request.cachePath;
  const target=path.join(record.path,relative);
  const tracked=command("git",["-C",record.path,"ls-files","-z","--",`:(top,literal)${relative}`]);
  if(tracked.status!==0 || tracked.stdout) throw new CacheRetirementError("cache-source-protected","selected output contains tracked source");
  const ignored=command("git",["-C",record.path,"check-ignore","--quiet","--",relative+"/"]);
  if(ignored.status!==0) throw new CacheRetirementError("unclassified-cache","selected cache must be Git-ignored");
  const declared=[...record.cachePaths,...repositoryManifestCachePaths(record.path)];
  if(!declared.some(d=>d===relative || d.startsWith("**/") && path.basename(relative)===d.slice(3))) throw new CacheRetirementError("unclassified-cache","selected path is not an existing generated declaration");
  if(request.classification==="declared-build-cache") {
    if(!repositoryManifestCachePaths(record.path).includes(relative)) throw new CacheRetirementError("unclassified-cache","build output requires an exact tracked repository cache declaration");
  } else {
    if(path.basename(relative)!=="node_modules") throw new CacheRetirementError("unclassified-cache","node dependency class requires exact node_modules root");
    let directory=path.dirname(relative),qualified=false;
    while(true){
      const prefix=directory==="."?"":directory+"/";
      const manifest=command("git",["-C",record.path,"cat-file","-e",`HEAD:${prefix}package.json`]);
      if(manifest.status===0 && ["package-lock.json","bun.lock","bun.lockb","pnpm-lock.yaml","yarn.lock"].some(lock=>command("git",["-C",record.path,"cat-file","-e",`HEAD:${prefix}${lock}`]).status===0)){qualified=true;break;}
      if(directory===".") break; directory=path.dirname(directory);
    }
    if(!qualified) throw new CacheRetirementError("unclassified-cache","tracked package manifest and lockfile required");
  }
  if(existsSync(target) && (lstatSync(target).isSymbolicLink() || !lstatSync(target).isDirectory())) throw new CacheRetirementError("unclassified-cache","cache root must be a directory, never an alias");
}
function workspaceCacheSafety(database,selected,stages,cacheRoots) {
  const growth=growthSafety(database,recordBy(database,{id:selected.id}));
  const native=materializationSafety(database,selected,[selected.path,...stages],"generated-cache",cacheRoots);
  return {errors:[...growth.errors,...native.errors],references:[...growth.references,...native.references],retainedBorrowers:growth.retainedBorrowers,observedAt:Date.now()};
}
function cacheSafetyCommand(database,args,statePath) {
  assertOnly(args,["id","path","owner","cache","request","request-sha256","json"]);
  const selected=growthSelected(database,args),deadline=Date.now()+35_000;
  if(selected.owner!==required(args,"owner")) throw new CacheRetirementError("cache-owner-changed","registered owner mismatch");
  let relative,stages=[];
  if(one(args,"request")!==undefined) {
    if(one(args,"cache")!==undefined) throw new CacheRetirementError("invalid-cache-request","choose exact cache path or exact request, never both");
    const file=required(args,"request"),stat=lstatSync(file);
    if(!path.isAbsolute(file)||realpathSync(file)!==file||!stat.isFile()||stat.nlink!==1||stat.size>65536||within(selected.path,file)) throw new CacheRetirementError("invalid-cache-request","independent single-link exact request required");
    const bytes=readFileSync(file);if(digest(bytes)!==required(args,"request-sha256"))throw new CacheRetirementError("cache-request-changed","request bytes changed");
    const request=JSON.parse(bytes);validateCacheRequest(request);
    if(request.binding.id!==selected.id||request.binding.path!==selected.path||request.binding.owner!==selected.owner)throw new CacheRetirementError("cache-owner-changed","request does not select original workspace");
    relative=request.cachePath;stages=cacheStagingRoots(request,path.dirname(statePath));
  }else{
    if(one(args,"request-sha256")!==undefined)throw new CacheRetirementError("invalid-cache-request","request hash requires exact request file");
    relative=required(args,"cache");if(path.isAbsolute(relative)||path.posix.normalize(relative)!==relative||relative.split('/').some(p=>p==='..'))throw new CacheRetirementError("invalid-cache-request","exact relative cache required");
  }
  const raw=duringInspection(deadline,()=>withWorkspaceLock(database,selected.path,()=>withGrowthBorrowerLocks(database,selected,()=>workspaceCacheSafety(database,selected,stages,[path.join(selected.path,relative),...stages]),deadline),selected.groupId,deadline));
  const observation={workspaceId:selected.id,path:selected.path,stagingRoots:stages,observedAt:raw.observedAt,errors:raw.errors,references:referenceSummaries(raw.references),retainedBorrowers:referenceSummaries(raw.retainedBorrowers),effect:"none",scope:"read-only borrower observation; no cache classification/inode retirement qualification"};
  print({ok:true,value:{kind:raw.errors.length?"safety-unknown":raw.references.length||raw.retainedBorrowers.length?"protected":"unreferenced",...observation}},true);
}
function leaseReleaseDisposition(item) {
  const cacheDisposition=item.cacheDisposition!==undefined?item.cacheDisposition:item.removedCaches===undefined?{kind:"not-attempted"}:item.removedCaches.length?{kind:"detached-for-retirement",paths:item.removedCaches,physicalReclaim:"not-measured"}:{kind:"none-selected",paths:[]};
  return {...item,cacheDisposition,leaseRelease:item.record.leaseExpiresAt===0?{kind:"released",expiresAt:0}:{kind:"active",expiresAt:item.record.leaseExpiresAt},physicalDisposition:existsSync(item.record.path)?{kind:"retained",reason:item.inspection.reason}:{kind:"removed"}};
}
function workspaceCacheCommand(database,args,statePath,planning) {
  const flags=planning?["id","path","owner","cache","classification","operation-id","evidence","json"]:["id","path","owner","request","request-sha256","json"];
  assertOnly(args,flags);
  const selected=growthSelected(database,args);
  const deadline=Date.now()+35_000;
  try {
    if(selected.owner!==required(args,"owner")) throw new CacheRetirementError("cache-owner-changed","registered owner mismatch");
    let request;
    if(planning) request={kind:"retire-workspace-cache",operationId:required(args,"operation-id"),binding:cacheBinding(database,selected.id),cachePath:required(args,"cache"),classification:required(args,"classification"),ownerEvidence:required(args,"evidence")};
    else {
      const file=required(args,"request"),stat=lstatSync(file);
      if(!path.isAbsolute(file)||realpathSync(file)!==file||!stat.isFile()||stat.nlink!==1||stat.size>65536||within(selected.path,file)) throw new CacheRetirementError("invalid-cache-request","independent single-link request <=64KiB required");
      const bytes=readFileSync(file);if(digest(bytes)!==required(args,"request-sha256")) throw new CacheRetirementError("cache-request-changed","request bytes changed");
      request=JSON.parse(bytes);
    }
    validateCacheRequest(request);
    if(request.binding.id!==selected.id||request.binding.path!==selected.path||request.binding.owner!==selected.owner) throw new CacheRetirementError("cache-owner-changed","request does not select original workspace");
    const result=duringInspection(deadline,()=>withWorkspaceLock(database,selected.path,()=>withGrowthBorrowerLocks(database,selected,()=>{
      classifyWorkspaceCache(recordBy(database,{id:selected.id}),request);
      const binding=()=>cacheBinding(database,selected.id);
      if(binding().leaseExpiresAt>Date.now()) throw new CacheRetirementError("cache-writing-lease","writing lease still active");
      const safety=stages=>workspaceCacheSafety(database,selected,stages,[path.join(selected.path,request.cachePath),...stages]);
      if(planning) return {ok:true,value:{request,requestSha256:digest(JSON.stringify(request)),effect:"none",nextCommand:"retire-cache with an independently retained exact request and its byte SHA256"}};
      return retireWorkspaceCache({database,stateDirectory:path.dirname(statePath),deadline,binding,
        classify:r=>classifyWorkspaceCache(recordBy(database,{id:selected.id}),r),safety,
        tracked:target=>{const rel=path.relative(selected.path,target);const r=command("git",["-C",selected.path,"ls-files","-z","--",`:(top,literal)${rel}`]);return r.status!==0||Boolean(r.stdout);},
        original:()=>({record:recordBy(database,{id:selected.id}),capacity:database.prepare("SELECT * FROM workspace_capacity WHERE workspace_id=?").get(selected.id)??null,measurement:database.prepare("SELECT * FROM workspace_capacity_measurement WHERE workspace_id=?").get(selected.id)??null}),
        invalidate:()=>database.prepare("DELETE FROM workspace_capacity_measurement WHERE workspace_id=?").run(selected.id),
      },request);
    },deadline),selected.groupId,deadline));
    print(result,true);if(!result.ok)process.exitCode=2;
  }catch(error){print({ok:false,error:{code:error.code??"cache-retirement-io-error",detail:String(error.message)}},true);process.exitCode=2;}
}

function retireSourceMaterializationCommand(database, args, statePath) {
  assertOnly(args, ["id", "path", "owner", "request", "request-sha256", "repository", "json"]);
  if (!bool(args, "json")) throw new MaterializationError("materialization-invalid-request", "--json is required");
  const selected = growthSelected(database, args), requestPath = required(args, "request");
  const repository = one(args, "repository");
  if (repository !== undefined && (repository !== "owi-link/converge" || !["https://github.com/owi-link/converge.git", "git@github.com:owi-link/converge.git", "ssh://git@github.com/owi-link/converge.git"].includes(selected.repository)))
    throw new MaterializationError("materialization-custody-required", "explicit Converge repository scope does not match registered parent");
  if (!path.isAbsolute(requestPath) || path.normalize(requestPath) !== requestPath || realpathSync(requestPath) !== requestPath)
    throw new MaterializationError("materialization-invalid-request", "unaliased absolute request path required");
  const stat = lstatSync(requestPath);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > 65536)
    throw new MaterializationError("materialization-invalid-request", "single-link request file <=64KiB required");
  const bytes = readFileSync(requestPath);
  if (digest(bytes) !== required(args, "request-sha256")) throw new MaterializationError("materialization-evidence-changed", "request SHA256 mismatch");
  let request;
  try { request = JSON.parse(bytes); } catch { throw new MaterializationError("materialization-invalid-request", "request must be JSON"); }
  validateMaterializationRequest(request);
  if (request.parent.id !== selected.id || request.parent.path !== selected.path || request.parent.owner !== required(args, "owner") || selected.owner !== request.parent.owner)
    throw new MaterializationError("materialization-identity-changed", "id/path/owning release mismatch");
  if (within(selected.path, requestPath)) throw new MaterializationError("materialization-invalid-request", "request must be independently retained outside parent");
  const deadline = Date.now() + 150000;
  const result = duringInspection(deadline, () => withWorkspaceLock(database, selected.path, () =>
    withResourceLock(statePath, `source-materialization:${request.source.path}`, () => retireSourceMaterialization({
      database, stateDirectory: path.dirname(statePath),
      parentBinding: () => {
        const record = recordBy(database, {id: selected.id});
        if (["creating", "reclaiming", "released"].includes(record.state)) throw new MaterializationError("materialization-identity-changed", "parent lifecycle changed");
        const current = lstatSync(record.path, {bigint: true});
        return {id: record.id, path: record.path, owner: record.owner, head: git(record.path, ["rev-parse", "HEAD"]), device: String(current.dev), inode: String(current.ino)};
      },
      safety: roots => materializationSafety(database, recordBy(database, {id: selected.id}), roots,"source"),
      invalidate: () => database.prepare("DELETE FROM workspace_capacity_measurement WHERE workspace_id=?").run(selected.id),
    }, request), deadline), selected.groupId, deadline));
  print(result, true);
  if (!result.ok) process.exitCode = 2;
}

// Explicit, owner-bound, recorded disposal of candidate-local merge commits whose
// parents are durable on remotes. Verification refuses unique source; see
// local-merge-disposal.mjs. Records a receipt only; nothing is deleted here.
function disposeLocalMergesCommand(database, args) {
  assertOnly(args, ["id", "path", "owner", "json"]);
  const selected = growthSelected(database, args, "dispose-local-merges");
  const owner = required(args, "owner");
  withWorkspaceLock(database, selected.path, () => {
    const record = recordBy(database, {id: selected.id});
    if (!record.owner || record.owner !== owner) growthError("stale-merge-disposal", "current owning identity required");
    if (!["active", "referenced", "blocked", "repair-required"].includes(record.state)) growthError("invalid-merge-disposal-state", `cannot dispose merges of a ${record.state} workspace`);
    const head = git(record.path, ["rev-parse", "HEAD"]);
    const inventory = git(record.path, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads", "refs/remotes"])
      .split("\n").filter(Boolean).map(line => line.split(" "));
    const candidates = [...inventory.filter(([ref]) => ref.startsWith("refs/heads/")).map(([, sha]) => sha), head];
    const durable = inventory.filter(([ref]) => ref.startsWith("refs/remotes/")).map(([, sha]) => sha);
    if (record.durableSourceCommit !== null) durable.push(record.durableSourceCommit);
    const observed = observedRemoteHeads(command, record.path);
    if (!observed.ok && observed.code !== "remote-custody-absent") growthError("merge-disposal-refused", `${observed.detail}; unique source is never disposed`);
    if (observed.ok) durable.push(...observed.durable);
    const gitRun = (a, o) => git(record.path, a, o);
    const verdict = classifyLocalMerges(gitRun, candidates, durable);
    if (!verdict.ok) growthError("merge-disposal-refused", `${verdict.reason}; unique source is never disposed`);
    if (verdict.merges.length === 0) { print({ok: true, workspaceId: record.id, disposed: [], reason: "no commits are absent from remotes; nothing to dispose"}, bool(args, "json")); return; }
    const commonDir = path.resolve(record.path, git(record.path, ["rev-parse", "--git-common-dir"]));
    const recorded = recordMergeDisposal({gitCommonDir: commonDir, workspaceId: record.id, owner, head, merges: verdict.merges, durable});
    print({ok: true, workspaceId: record.id, disposed: verdict.merges, receipt: recorded.file, receiptSha256: recorded.sha256,
      next: "release re-verifies these merges against remote tips; no source was deleted"}, bool(args, "json"));
  }, selected.groupId);
}

function retireGrowthCommand(database, args, statePath) {
  assertOnly(args, ["id", "path", "owner", "disposition", "disposition-sha256", "json"]);
  const selected = growthSelected(database, args);
  const evidence = readFileSync(required(args, "disposition"), "utf8");
  const evidenceSha256 = digest(evidence);
  if (evidenceSha256 !== required(args, "disposition-sha256")) growthError("growth-evidence-changed", "disposition bytes do not match the expected SHA256");
  let disposition;
  try { disposition = JSON.parse(evidence); } catch { growthError("invalid-growth-disposition", "disposition must be JSON"); }
  const result = retireGrowthEvidence(database, selected, required(args,"owner"), evidence, statePath);
  print(result, bool(args,"json"));
}

// Shared locked transition: explicit release and explicit retire use identical CAS,
// fresh process/unit/native/borrower observations and durable journal semantics.
function retireGrowthEvidence(database, selected, owner, evidence, statePath, automatic = false, budgetDeadline) {
  const evidenceSha256 = digest(evidence), disposition = JSON.parse(evidence);
  const deadline = Math.min(Date.now()+25_000,budgetDeadline??Infinity);
  return duringInspection(deadline,()=>withWorkspaceLock(database, selected.path, () => {
    const record = recordBy(database, {id:selected.id});
    if (!["active", "referenced", "blocked", "repair-required"].includes(record.state)) growthError("invalid-growth-state", `cannot retire growth from ${record.state}`);
    if (record.owner !== owner || !record.owner || !record.durableSourceCommit) growthError("stale-growth-disposition", "current owning identity and immutable source required");
    const initial = growthBinding(database, record);
    return withGrowthBorrowerLocks(database,record,()=>withResourceLock(statePath, `capacity:${initial.binding.device}`, () => {
      const {binding, plan, row, measurement} = growthBinding(database, record);
      if (!["source-only", "budgeted"].includes(plan.intent)) growthError("invalid-growth-state", "retirement requires an explicitly priced plan");
      if (retainedGrowth(plan)) growthError("growth-already-retired", "growth is already retired; no replay");
      const cached = cachedWorkspaceAllocation(database, record.id, record.path, row.device_id);
      if (!cached.ok) growthError("growth-sample-required", cached.error);
      let safety = terminalSafety(database, record, deadline,automatic);
      if(!automatic && safety.references.length && !safety.errors.length){
        const pids=[...new Set(safety.references.map(r=>r.pid).filter(pid=>Number.isSafeInteger(pid)&&pid>0))];
        const units=[...new Set(safety.references.map(r=>r.id).filter(id=>typeof id==="string"&&id.endsWith(".service")))];
        const observer=new URL("./growth-writer-observation.mjs",import.meta.url).href;
        const input=JSON.stringify({roots:[record.path],pids,units});
        const script=`import {observeGrowthWriters} from ${JSON.stringify(observer)};console.log(JSON.stringify(observeGrowthWriters(JSON.parse(process.argv[1]))));`;
        const observed=command("sudo",["-n",process.execPath,"--input-type=module","-e",script,input],{timeout:Math.max(1,Math.min(8000,deadline-Date.now()-1000))});
        try{safety.growthWriters=observed.status===0?JSON.parse(observed.stdout):{complete:false,references:[],errors:[observed.stderr||"growth writer observer failed"]};}
        catch{safety.growthWriters={complete:false,references:[],errors:["growth writer observation invalid"]};}
      }
      if (Date.now() >= deadline) growthError("growth-observation-timeout", "retirement observation budget exhausted");
      if(automatic) {
        validateIdleGrowth(database,record,plan,measurement.measurement_json,safety);
        const expected=JSON.parse(measurement.measurement_json);
        const exclusions=database.prepare("SELECT path FROM workspace WHERE state!='released'").all().map(r=>r.path).filter(p=>p.startsWith(record.path+path.sep));
        const verify=withContentObservation(database,{deadline:deadline-1000},observeContent=>workspaceAllocationSample(record.path,row.device_id,{deadline:deadline-1000,maxEntries:2_000_000,excludedPaths:exclusions,observeContent}));
        assertIdleObservation(expected,verify);
        safety=terminalSafety(database,record,deadline,true);
        validateIdleGrowth(database,record,plan,measurement.measurement_json,safety);
      }
      validateRetirement(disposition, binding, safety);
      const next = {...plan, growthLifecycle:{kind:"retired-future-growth", remainingGrowthBytes:0,
        retainedUse:disposition.retainedUse, dispositionSha256:evidenceSha256, retiredAt:Date.now()}};
      database.exec("BEGIN IMMEDIATE");
      try {
        const current = growthBinding(database, recordBy(database, {id:record.id}));
        if(automatic) validateIdleGrowth(database,recordBy(database,{id:record.id}),plan,current.measurement.measurement_json,safety);
        validateRetirement(disposition, current.binding, safety);
        const fresh = cachedWorkspaceAllocation(database, record.id, record.path, row.device_id);
        if (!fresh.ok) growthError("growth-sample-required", fresh.error);
        database.exec(`CREATE TABLE IF NOT EXISTS workspace_growth_retirement (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id TEXT NOT NULL, occurred_at INTEGER NOT NULL,
          record_json TEXT NOT NULL, old_plan_json TEXT NOT NULL, new_plan_json TEXT NOT NULL,
          measurement_json TEXT NOT NULL, disposition_json TEXT NOT NULL, safety_json TEXT NOT NULL)`);
        const changed = database.prepare("UPDATE workspace_capacity SET plan_json=? WHERE workspace_id=? AND plan_json=?")
          .run(JSON.stringify(next), record.id, row.plan_json).changes;
        if (changed !== 1) growthError("stale-growth-disposition", "capacity plan CAS failed");
        const journal = database.prepare("INSERT INTO workspace_growth_retirement(workspace_id,occurred_at,record_json,old_plan_json,new_plan_json,measurement_json,disposition_json,safety_json) VALUES(?,?,?,?,?,?,?,?)")
          .run(record.id, Date.now(), JSON.stringify(record), row.plan_json, JSON.stringify(next), measurement.measurement_json, evidence, JSON.stringify(safety));
        const relinquished = database.prepare("UPDATE workspace SET lease_expires_at=0,updated_at=? WHERE id=? AND lease_expires_at=? AND updated_at=?")
          .run(Date.now(), record.id, record.leaseExpiresAt, record.updatedAt).changes;
        if (relinquished !== 1) growthError("stale-growth-disposition", "writing lease CAS failed");
        database.exec("COMMIT");
        return {ok:true, kind:"retired-future-growth", sequence:Number(journal.lastInsertRowid),
          record:creationRecord(database, record.id), dispositionSha256:evidenceSha256, safety};
      } catch (error) { database.exec("ROLLBACK"); throw error; }
    },deadline),deadline);
  }, selected.groupId,deadline));
}

// Durable round-robin progress prevents busy early rows from starving later work.
function validateIdleGrowth(database,record,plan,text,safety) {
  const saved=database.prepare("SELECT state_json FROM workspace_growth_policy WHERE workspace_id=?").get(record.id);
  return assertIdleGrowth({record,plan,sample:JSON.parse(text),history:JSON.parse(saved?.state_json??"null"),safety,
    planSha256:digest(database.prepare("SELECT plan_json FROM workspace_capacity WHERE workspace_id=?").get(record.id).plan_json)});
}
function retireIdleGrowthCommand(database,args,statePath) {
  assertOnly(args,["root","budget-ms","max-records","json"]);
  const budget=numberFlag(args,"budget-ms",90000),limit=numberFlag(args,"max-records",128);
  if(!Number.isSafeInteger(budget)||budget<1||budget>300000||!Number.isSafeInteger(limit)||limit<1||limit>4096)fail("invalid idle growth sweep bounds");
  const deadline=Date.now()+budget,scope=one(args,"root")?path.resolve(one(args,"root")):"*";
  database.exec("CREATE TABLE IF NOT EXISTS workspace_idle_growth_cursor(scope TEXT PRIMARY KEY, after_id TEXT NOT NULL)");
  const after=database.prepare("SELECT after_id FROM workspace_idle_growth_cursor WHERE scope=?").get(scope)?.after_id??"";
  const rows=database.prepare(`SELECT w.id,w.path,w.state,w.created_at,w.group_id,c.device_id,c.plan_json FROM workspace w
    JOIN workspace_capacity c ON c.workspace_id=w.id WHERE w.state!='released' AND w.state!='creating' AND (?='*' OR w.root=?) ORDER BY w.id`).all(scope,scope)
    .filter(row=>{try{const p=JSON.parse(row.plan_json);return ['source-only','budgeted'].includes(p.intent)&&p.growthBytes>0&&!p.growthLifecycle;}catch{return false;}});
  const ordered=[...rows.filter(r=>r.id>after),...rows.filter(r=>r.id<=after)];
  const paths=database.prepare("SELECT path FROM workspace WHERE state!='released'").all().map(r=>r.path);
  const results=[];let retiredBytes=0;
  for(const row of ordered) {
    if(Date.now()>=deadline||results.length>=limit)break;
    // Advance before expensive work, including failures and partial resumable walks.
    database.prepare("INSERT OR REPLACE INTO workspace_idle_growth_cursor VALUES(?,?)").run(scope,row.id);
    try {
      const record=recordBy(database,{id:row.id});
      if(Date.now()-record.createdAt<=3600000)growthError('idle-growth-recent-write','New workspace retains its admitted promise.');
      const sampled=measureWorkspaceRow(database,row,paths,Math.min(deadline,Date.now()+2000),statePath,true);
      if(sampled.partial){results.push({id:row.id,path:row.path,status:'partial',visited:sampled.visited});continue;}
      if(!sampled.ok)growthError('idle-growth-sample-required',sampled.error);
      const result=duringInspection(deadline,()=>withWorkspaceLock(database,record.path,()=>{
        const current=recordBy(database,{id:record.id});
        const {binding,plan,measurement}=growthBinding(database,current);
        // Cheap data-only check before the expensive exact execution observation.
        validateIdleGrowth(database,current,plan,measurement.measurement_json,{references:[],errors:[]});
        const disposition={kind:'retire-future-growth',retainedUse:'source',remainingGrowthBytes:0,growthWriters:'none',writingLease:'retire',
          reason:'Automatic retirement of an idle future promise; all actual bytes and source remain.',ownerEvidence:'Sara authorized idle-growth policy: exact quiescence, two stable samples and one hour since actual write.',
          observedAt:Date.now(),binding};
        const retired=retireGrowthEvidence(database,current,current.owner,JSON.stringify(disposition),statePath,true,deadline);
        return {retired,oldPromiseBytes:plan.growthBytes};
      },record.groupId,deadline));
      retiredBytes+=result.oldPromiseBytes;
      results.push({id:row.id,path:row.path,status:'retired',retiredPromiseBytes:result.oldPromiseBytes,sequence:result.retired.sequence});
    }catch(error){results.push({id:row.id,path:row.path,status:'retained',code:error.code??'idle-growth-unknown',detail:error.message});}
  }
  return {kind:'idle-growth-retirement',scope,retiredPromiseBytes:retiredBytes,retiredCount:results.filter(r=>r.status==='retired').length,
    examined:results.length,eligible:rows.length,remaining:Math.max(0,rows.length-results.length),cursor:results.at(-1)?.id??after,results};
}

function reduceRetainedHeadroomCommand(database, args, statePath) {
  assertOnly(args, ["id", "path", "owner", "disposition", "disposition-sha256", "json"]);
  const selected = growthSelected(database, args);
  const evidence = readFileSync(required(args, "disposition"), "utf8");
  const evidenceSha256 = digest(evidence);
  if (evidenceSha256 !== required(args, "disposition-sha256")) growthError("growth-evidence-changed", "disposition bytes do not match the expected SHA256");
  let disposition;
  try { disposition = JSON.parse(evidence); } catch { growthError("invalid-growth-disposition", "disposition must be JSON"); }
  const deadline = Date.now()+25_000;
  duringInspection(deadline,()=>withWorkspaceLock(database, selected.path, () => {
    const record = recordBy(database, {id:selected.id});
    if (!["active", "referenced", "blocked", "repair-required"].includes(record.state)) growthError("invalid-growth-state", `cannot retire growth from ${record.state}`);
    if (record.owner !== required(args, "owner") || !record.owner || !record.durableSourceCommit) growthError("stale-growth-disposition", "current owning identity and immutable source required");
    const initial = growthBinding(database, record);
    withGrowthBorrowerLocks(database,record,()=>withResourceLock(statePath, `capacity:${initial.binding.device}`, () => {
      const {binding, plan, row, measurement} = growthBinding(database, record);
      if (!["source-only", "budgeted"].includes(plan.intent)) growthError("invalid-growth-state", "retirement requires an explicitly priced plan");
      if (!retainedGrowth(plan)) growthError("retained-headroom-state", "retire growth first");
      const cached = cachedWorkspaceAllocation(database, record.id, record.path, row.device_id);
      if (!cached.ok) growthError("growth-sample-required", cached.error);
      const remoteCustody=verifiedRemoteCustody(record);
      const safety = terminalSafety(database, record,deadline);
      safety.remoteCustody=remoteCustody;
      safety.borrowerCustody=safety.retainedBorrowers.map(b=>{
        const child=recordBy(database,{id:b.recordId});
        if(child.leaseExpiresAt>Date.now() || !recordRetainsCustody(database,child.id) && !retainedParent(database,child.path)) growthError("retained-headroom-borrower","borrower requires explicit retained custody");
        return {binding:cacheBinding(database,child.id),remoteCustody:verifiedRemoteCustody(child)};
      });
      if (Date.now() >= deadline) growthError("growth-observation-timeout", "retirement observation budget exhausted");
      validateRetainedHeadroom(disposition, binding, plan, safety);
      const next = {...plan, headroomBytes:disposition.headroomBytes,
        retainedHeadroom:{kind:"terminal-source-headroom",dispositionSha256:evidenceSha256,observedAt:Date.now()}};
      const reservations=capacityReservations(database,row.device_id,record.path);
      const priorRequirement=capacityRequirement({...plan,constructionBytes:0,growthBytes:0},reservations.priced,reservations.headroomBytes);
      const nextRequirement=capacityRequirement({...next,constructionBytes:0,growthBytes:0},reservations.priced,reservations.headroomBytes);
      if(nextRequirement>priorRequirement) growthError("unsafe-retained-headroom","requirement cannot increase");
      database.exec("BEGIN IMMEDIATE");
      try {
        const current = growthBinding(database, recordBy(database, {id:record.id}));
        validateRetainedHeadroom(disposition, current.binding, current.plan, safety);
        const fresh = cachedWorkspaceAllocation(database, record.id, record.path, row.device_id);
        if (!fresh.ok) growthError("growth-sample-required", fresh.error);
        database.exec(`CREATE TABLE IF NOT EXISTS workspace_retained_headroom_repricing (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id TEXT NOT NULL, occurred_at INTEGER NOT NULL,
          record_json TEXT NOT NULL, old_plan_json TEXT NOT NULL, new_plan_json TEXT NOT NULL,
          measurement_json TEXT NOT NULL, disposition_json TEXT NOT NULL, safety_json TEXT NOT NULL)`);
        const changed = database.prepare("UPDATE workspace_capacity SET plan_json=? WHERE workspace_id=? AND plan_json=?")
          .run(JSON.stringify(next), record.id, row.plan_json).changes;
        if (changed !== 1) growthError("stale-growth-disposition", "capacity plan CAS failed");
        const journal = database.prepare("INSERT INTO workspace_retained_headroom_repricing(workspace_id,occurred_at,record_json,old_plan_json,new_plan_json,measurement_json,disposition_json,safety_json) VALUES(?,?,?,?,?,?,?,?)")
          .run(record.id, Date.now(), JSON.stringify(record), row.plan_json, JSON.stringify(next), measurement.measurement_json, evidence, JSON.stringify(safety));
        database.exec("COMMIT");
        print({ok:true, kind:"reduced-retained-headroom", newWritesAuthorized:false, priorRequirement, nextRequirement, sequence:Number(journal.lastInsertRowid),
          record:creationRecord(database, record.id), dispositionSha256:evidenceSha256, safety}, bool(args,"json"));
      } catch (error) { database.exec("ROLLBACK"); throw error; }
    },deadline),deadline);
  }, selected.groupId,deadline));
}

// One checkout's allocated-block sample under its own checkout lock; only the measurement
// cache and traversal progress change. Failed walks retain the last successful sample,
// never publishing a partial total as a smaller allocation.
function measureWorkspaceRow(database, row, paths, deadline, statePath, incremental = false, contentProof = true) {
  database.exec("CREATE TABLE IF NOT EXISTS workspace_capacity_attempt(workspace_id TEXT PRIMARY KEY, attempted_at INTEGER NOT NULL)");
  database.prepare("INSERT OR REPLACE INTO workspace_capacity_attempt VALUES(?,?)").run(row.id,Date.now());
  const store = sample => sample.ok
    ? withResourceLock(statePath, `capacity:${row.device_id}`,
        () => persistAllocationSample(database, row, sample), undefined,
        {waitMs: Math.max(0, Math.min(30_000, deadline - Date.now()))})
    : persistAllocationSample(database, row, sample);

  try {
    return withWorkspaceLock(database, row.path, () => {
      const excludedPaths=paths.filter(candidate=>candidate.startsWith(`${row.path}${path.sep}`));
      if(!incremental){
        // Capacity admission needs allocated blocks, not proof of one-hour
        // payload idleness. Shared hardlink churn must not fail a fully admitted
        // checkout merely because its separate optional content census races.
        const sample=contentProof?withContentObservation(database,{deadline},observeContent=>workspaceAllocationSample(row.path,row.device_id,{deadline,maxEntries:2_000_000,excludedPaths,observeContent}))
          : {...workspaceAllocationSample(row.path,row.device_id,{deadline,maxEntries:2_000_000,excludedPaths}),writeObservationComplete:false};
        return store(sample);
      }
      database.exec("CREATE TABLE IF NOT EXISTS workspace_capacity_walk(workspace_id TEXT PRIMARY KEY, state_json TEXT NOT NULL)");
      database.exec("CREATE TABLE IF NOT EXISTS workspace_capacity_content_walk(workspace_id TEXT PRIMARY KEY, state_json TEXT NOT NULL)");
      // Allocation sampling and optional payload-idleness proofs are independent
      // periodic observers. Neither may reset the other's incomplete traversal.
      // Preserve an explicitly tagged legacy content walk in its own slot; an
      // untagged or malformed legacy state still restarts conservatively.
      const legacy=database.prepare("SELECT state_json FROM workspace_capacity_walk WHERE workspace_id=?").get(row.id);
      let legacyState;try{legacyState=legacy?JSON.parse(legacy.state_json):null;}catch{}
      if(legacyState?.contentProof===true){
        database.exec("BEGIN IMMEDIATE");
        try{
          database.prepare("INSERT OR IGNORE INTO workspace_capacity_content_walk VALUES(?,?)").run(row.id,legacy.state_json);
          database.prepare("DELETE FROM workspace_capacity_walk WHERE workspace_id=?").run(row.id);
          database.exec("COMMIT");
        }catch(error){database.exec("ROLLBACK");throw error;}
      }
      const walkTable=contentProof?"workspace_capacity_content_walk":"workspace_capacity_walk";
      const saved=database.prepare(`SELECT state_json FROM ${walkTable} WHERE workspace_id=?`).get(row.id);
      let prior;try{prior=saved?JSON.parse(saved.state_json):null;}catch{prior=null;}
      if(prior && prior.contentProof!==contentProof)prior=null;
      // An allocation walk that already exceeds the unchanged freshness window
      // cannot finish as a fresh physical observation. Restart traversal only;
      // never erase the last complete sample or publish a partial allocation.
      if(prior && !contentProof && Date.now()-prior.startedAt>CAPACITY_MEASUREMENT_MAX_AGE_MS)prior=null;
      const until=Math.min(deadline,Date.now()+1000);
      const walk=observeContent=>allocationSlice(row.path,row.device_id,prior,{deadline:until,excludedPaths,observeContent});
      const slice=contentProof?withContentObservation(database,{deadline:until},walk):walk(undefined);
      if(slice.partial){
        slice.state.contentProof=contentProof;
        database.prepare(`INSERT OR REPLACE INTO ${walkTable} VALUES(?,?)`).run(row.id,JSON.stringify(slice.state));
        return {partial:true,visited:slice.visited,entries:slice.state.entries,startedAt:slice.state.startedAt};
      }
      database.prepare(`DELETE FROM ${walkTable} WHERE workspace_id=?`).run(row.id);
      return store(slice);
    }, row.group_id, deadline);
  } catch (error) { return store({ ok: false, startedAt: Date.now(), completedAt: Date.now(), error: error.message }); }
}

// One pass refreshes the samples the ledger actually reads, most valuable first: rows charged
// in full because their sample is missing, failed or stale (largest charge first), then
// current samples closest to expiry. Rows the ledger never measures are skipped, not walked.
// A targeted --id/--path request always measures the selected row.
function capacityStatusCommand(database,args) {
  assertOnly(args,["root","json"]);
  const root=path.resolve(required(args,"root")),stats=statfsSync(root),device=String(statSync(root).dev);
  const reservations=capacityReservations(database,device);
  print({kind:"capacity-status",observedAt:Date.now(),device,freeBytes:stats.bavail*stats.bsize,
    effectiveReservedBytes:reservations.priced.reduce((a,b)=>a+b,0),...reservations},bool(args,"json"));
}

function measureCapacityCommand(database, args, statePath) {
  assertOnly(args, ["root", "path", "id", "budget-ms", "incremental", "content-proof", "json"]);
  const budgetMs = numberFlag(args, "budget-ms", 40_000);
  if (!Number.isSafeInteger(budgetMs) || budgetMs < 1 || budgetMs > 300_000) fail("--budget-ms must be between 1 and 300000");
  const started = Date.now(), deadline = started + budgetMs;
  const selected = one(args, "id") !== undefined || one(args, "path") !== undefined ? recordBy(database, selectorFrom(args, 'measure-capacity')).id : null;
  const root = one(args, "root") === undefined ? null : path.resolve(one(args, "root"));
  // Sampling serializes only the actual checkout, never the entire pool.
  // A long tree walk must not hold a global lock across unrelated records.
  const rows = database.prepare(`SELECT w.id,w.path,w.state,w.created_at,w.group_id,c.device_id,c.plan_json FROM workspace w
    JOIN workspace_capacity c ON c.workspace_id=w.id
    WHERE w.state!='released' AND (? IS NULL OR w.id=?) AND (? IS NULL OR w.root=?)`).all(selected, selected, root, root);
  const missing = [...new Set(rows.map(row=>row.device_id))].flatMap(device=>settleMissingCapacity(database,statePath,device,deadline,new Set(rows.map(row=>row.id))));
  const releasedMissing = new Set(missing.map(item=>item.id));
  const paths = database.prepare("SELECT path FROM workspace WHERE state!='released'").all().map(row => row.path);
  const skipped = { "retired-future-growth": 0, "zero-liability": 0 };
  database.exec("CREATE TABLE IF NOT EXISTS workspace_capacity_attempt(workspace_id TEXT PRIMARY KEY, attempted_at INTEGER NOT NULL)");
  const settled=selected===null?terminalQualificationPaths(rows):new Map();
  const queue = [];
  for (const row of rows) {
    if(releasedMissing.has(row.id)) continue;
    const plan = JSON.parse(row.plan_json);
    if (selected === null && movedToColdStorage(row.path)) { skipped["cold-storage"] = (skipped["cold-storage"] ?? 0) + 1; continue; }
    const budget = measuredBudgetBytes(plan, row.state);
    if (selected === null && budget === 0) { skipped[retainedGrowth(plan) ? "retired-future-growth" : "zero-liability"] += 1; continue; }
    const cached = cachedWorkspaceAllocation(database, row.id, row.path, row.device_id, started);
    let restored=false;try{restored=(JSON.parse(database.prepare('SELECT state_json FROM workspace_growth_policy WHERE workspace_id=?').get(row.id)?.state_json??'{}').restoreAt??0)>settled.get(row.path);}catch{restored=true;}
    if(selected===null && settled.has(row.path)&&!restored){skipped['terminal-qualification']=(skipped['terminal-qualification']??0)+1;continue;}
    const attempt=database.prepare("SELECT attempted_at FROM workspace_capacity_attempt WHERE workspace_id=?").get(row.id)?.attempted_at ?? 0;
    queue.push({ row, budget, cached, attempt });
  }
  queue.sort((a, b) => (a.cached.ok - b.cached.ok)
    || (a.cached.ok ? a.cached.startedAt - b.cached.startedAt : a.attempt-b.attempt || (a.cached.lastObservation?.startedAt??0)-(b.cached.lastObservation?.startedAt??0) || b.budget-a.budget)
    || (a.row.id < b.row.id ? -1 : a.row.id > b.row.id ? 1 : 0));
  const chargedBefore = queue.filter(item => !item.cached.ok).reduce((sum, item) => sum + item.budget, 0);
  const results = missing.map(item=>({...item,status:"missing-path-settled",ok:true}));
  const counts = { measured: missing.length, error: 0, deferred: 0 };
  let pending=queue;
  do {
    const next=[];
    for (const { row, budget, cached } of pending) {
      if (Date.now() >= deadline) {
        counts.deferred += 1;
        results.push({ path: row.path, status: "deferred", budgetBytes: budget, cache: cached.ok ? "current" : cached.code });
        continue;
      }
      // Finish a bounded row quantum before spreading observation starts across
      // the entire fleet. Each individual checkout lock remains at most two
      // seconds; a huge tree cannot monopolize the aggregate fleet budget.
      // Oldest-attempt ordering rotates unfinished rows on the next activation.
      const quantumDeadline=selected===null?Math.min(deadline,Date.now()+30000):deadline;
      let sample;
      do {
        const sampleDeadline = selected === null ? Math.min(quantumDeadline, Date.now() + 2000) : deadline;
        sample = measureWorkspaceRow(database, row, paths, sampleDeadline, statePath, selected===null||bool(args,'incremental'),bool(args,'content-proof'));
        counts[sample.partial ? "deferred" : sample.ok ? "measured" : "error"] += 1;
        results.push({ path: row.path, status: sample.partial ? "partial" : sample.ok ? "measured" : "error", budgetBytes: budget, previousCache: cached.ok ? "current" : cached.code, ...(sample.partial ? {visited:sample.visited,entries:sample.entries,startedAt:sample.startedAt} : sample) });
      } while(selected===null && sample.partial && Date.now()<quantumDeadline);
      if(sample.partial)next.push({row,budget,cached});
    }
    pending=next;
  } while(pending.length && Date.now()<deadline);
  const now = Date.now();
  let chargedAfter = 0, oldestCurrentStartedAt = null;
  const after = {};
  for (const { row, budget } of queue) {
    const cached = cachedWorkspaceAllocation(database, row.id, row.path, row.device_id, now);
    if (!cached.ok) { chargedAfter += budget; after[cached.code] = (after[cached.code] ?? 0) + 1; }
    else if (oldestCurrentStartedAt === null || cached.startedAt < oldestCurrentStartedAt) oldestCurrentStartedAt = cached.startedAt;
  }
  const idleGrowth = selected===null ? retireIdleGrowthCommand(database, parseArgs(["--budget-ms",String(Math.max(1,Math.min(10000,deadline-Date.now()))),"--max-records","16",...(root?["--root",root]:[])]),statePath) : {kind:"target-only-no-idle-sweep"};
  print({ kind: "capacity-measurement", idleGrowth, budgetMs, elapsedMs: Date.now() - started,
    progress: { pricedRows: rows.length, eligible: queue.length, skipped, ...counts,
      fullyChargedBytesBefore: chargedBefore, fullyChargedBytesAfter: chargedAfter, uncreditedAfter: after,
      oldestCurrentSampleAgeMs: oldestCurrentStartedAt === null ? null : now - oldestCurrentStartedAt,
      sampleLimitMs: CAPACITY_MEASUREMENT_MAX_AGE_MS },
    results }, bool(args, "json"));
}

function reconcileCommand(database, args, statePath) {
  assertOnly(args, ["root", "id", "path", "execute", "reap-expired", "preserve-runtime", "ignore-lease", "json", "max-groups", "budget-ms", "after"]);
  const started = Date.now();
  const budget = numberFlag(args, "budget-ms", 20_000);
  const maxGroups = numberFlag(args, "max-groups", 32);
  if (budget < 1 || budget > 40_000) fail("--budget-ms must be between 1 and 40000");
  if (!Number.isSafeInteger(maxGroups) || maxGroups < 1) fail("--max-groups must be a positive integer");
  const execute = bool(args, "execute");
  if (execute) pruneReleased(database, Date.now(), one(args, "root"));
  let records;
  if (one(args, "id") !== undefined || one(args, "path") !== undefined) records = [recordBy(database, selectorFrom(args, 'reconcile'))];
  else records = listRecords(database, one(args, "root"));
  records = records.filter((record) => record.state !== "released" || existsSync(record.path));
  const scope = one(args, "root") === undefined ? "*" : path.resolve(one(args, "root"));
  const targeted = one(args, "id") !== undefined || one(args, "path") !== undefined;
  database.exec("CREATE TABLE IF NOT EXISTS reconciliation_cursor (scope TEXT PRIMARY KEY, after_id TEXT NOT NULL)");
  const saved = execute && !targeted ? database.prepare("SELECT after_id FROM reconciliation_cursor WHERE scope = ?").get(scope)?.after_id : undefined;
  const after = one(args, "after", saved ?? "start");
  const anchor = after === "start" ? undefined : database.prepare("SELECT root, path FROM workspace WHERE id = ?").get(after);
  if ((!anchor || (scope !== "*" && anchor.root !== scope)) && after !== "start" && one(args, "after") !== undefined) fail(`--after workspace is not in the selected pool: ${after}`);
  if (anchor) {
    const pivot = records.findIndex((record) => record.root > anchor.root || (record.root === anchor.root && record.path > anchor.path));
    if (pivot >= 0) records = [...records.slice(pivot), ...records.slice(0, pivot)];
  }
  const deadline = started + budget;
  let safety;
  try {
    safety = duringInspection(deadline, () => safetySnapshot(database));
  } catch (error) {
    print(blockedReconciliation(database, records, error, false), bool(args, "json"));
    return;
  }
  const results = reconcileRecords(database, records, {
    execute,
    reapExpired: bool(args, "reap-expired"),
    preserveRuntime: bool(args, "preserve-runtime"),
    ignoreLease: bool(args, "ignore-lease"),
    statePath,
    safety,
    deadline,
    maxGroups,
    after,
    onProgress: execute && !targeted ? (id) => database.prepare(
      "INSERT INTO reconciliation_cursor (scope, after_id) VALUES (?, ?) ON CONFLICT(scope) DO UPDATE SET after_id = excluded.after_id",
    ).run(scope, id) : undefined,
  });
  print(results, bool(args, "json"));
}

function maintenancePostcondition(spec) {
  if(spec.kind==='mirror-directory')return existsSync(spec.input.directory) && lstatSync(spec.input.directory).isDirectory()?{kind:'applied',result:null,evidence:'canonical-directory-observation'}:{kind:'unknown'};
  if(spec.kind==='gc-warning-removal')return !existsSync(spec.input.file)?{kind:'applied',result:null,evidence:'canonical-warning-path-absent-postcondition-not-historical-attribution'}:{kind:'unknown'};
  if(spec.kind==='alternates-replacement')return existsSync(spec.input.file)&&readFileSync(spec.input.file,'utf8')===`${spec.input.objectSource}\n`?{kind:'applied',result:null,evidence:'canonical-exact-alternates-bytes'}:{kind:'unknown'};
  if(spec.kind!=='git')return {kind:'unknown'};
  const args=spec.input.args,offset=['-C','--git-dir'].includes(args[0])?2:0,location=args.slice(0,offset),verb=args[offset],rest=args.slice(offset+1);
  const read=(suffix)=>command('git',[...location,...suffix]);
  if(verb==='config'){
    const words=rest.filter(x=>!x.startsWith('--'));if(words.length===2){const result=read(['config','--local','--get-all',words[0]]);if(result.status===0&&result.stdout===words[1])return {kind:'applied',result:'',evidence:'canonical-exact-config'};}
    if(rest.includes('--unset-all')&&words.length===1){const result=read(['config','--local','--get-all',words[0]]);if(result.status===1&&!result.error)return {kind:'applied',result:'',evidence:'canonical-config-unset-postcondition'};}
  }
  if(verb==='remote'&&['add','set-url'].includes(rest[0])){const name=rest.at(-2),url=rest.at(-1),result=read(['remote','get-url',...(rest.includes('--push')?['--push']:[]),name]);if(result.status===0&&result.stdout===url)return {kind:'applied',result:'',evidence:'canonical-remote-url'};}
  if(verb==='init'&&rest[0]==='--bare'){const result=command('git',['--git-dir',rest[1],'rev-parse','--is-bare-repository']);if(result.status===0&&result.stdout==='true')return {kind:'applied',result:'',evidence:'canonical-bare-mirror'};}
  if(verb==='fetch'){
    const refs=rest.filter(x=>/^\+[a-f0-9]{40,64}:refs\/pi-workspace\/objects\//.test(x));if(!refs.length||refs.length>128)return {kind:'unknown'};
    for(const ref of refs){maintenanceContext.journal.check();const [oid,name]=ref.slice(1).split(':');const observed=read(['rev-parse','--verify',name]);if(observed.status!==0||observed.stdout!==oid)return {kind:'unknown'};}
    return {kind:'applied',result:'',evidence:'canonical-every-exact-fetch-ref'};
  }
  return {kind:'unknown'};
}
function maintainCommand(database, args) {
  assertOnly(args,['root','id','path','execute','json','operation-id','resume','reconcile','budget-ms','max-records','prior-state','prior-state-sha256']);
  const budget=Number(required(args,'budget-ms')),maxRecords=Number(required(args,'max-records'));
  if(!Number.isSafeInteger(budget)||budget<1000||budget>20000||!Number.isSafeInteger(maxRecords)||maxRecords<1||maxRecords>32)throw new MaintenanceError('maintenance-explicit-bounds-required');
  const deadline=Date.now()+budget,statePath=registryPaths.get(database);
  const root=one(args,'root')===undefined?null:path.resolve(one(args,'root'));
  if(root!==null&&(one(args,'id')!==undefined||one(args,'path')!==undefined))throw new MaintenanceError('maintenance-selection-conflict');
  const target=root===null?recordBy(database,selectorFrom(args,'maintain')):null;
  const scope={root,id:target?.id??null,path:target?.path??null};
  const next=(cursor)=>{
    const row=target ? cursor===''?database.prepare('SELECT id,path,owner,source_commit,group_id FROM workspace WHERE id=?').get(target.id):null
      : database.prepare('SELECT id,path,owner,source_commit,group_id FROM workspace WHERE root=? AND id>? ORDER BY id LIMIT 1').get(root,cursor);
    return row?{id:row.id,path:row.path,owner:row.owner,sourceCommit:row.source_commit,groupId:row.group_id}:null;
  };
  if(!bool(args,'execute')){
    if(bool(args,'reconcile')||bool(args,'resume'))throw new MaintenanceError('maintenance-execute-required');
    const results=[];let cursor='';duringInspection(deadline,()=>{while(results.length<maxRecords){const record=next(cursor);if(!record)break;cursor=record.id;results.push({id:record.id,path:record.path,result:withWorkspaceLock(database,record.path,()=>maintainReferenceClone(record.path,false,statePath),record.groupId,deadline)});}});
    print({kind:'maintenance-preview',cursor,results,notExecution:true},true);return;
  }
  const operation=required(args,'operation-id');
  // A prior unknown legacy run must be reconciled by its actual owner, not replayed.
  const prior=priorDisposition(required(args,'prior-state'),required(args,'prior-state-sha256'),scope);
  const journalFile=path.join(path.dirname(statePath),'maintenance-journal.sqlite3');
  const journal=new MaintenanceJournal(journalFile,operation,{scope,prior,protocol:1,toolSha256:createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex'),journalSha256:createHash('sha256').update(readFileSync(new URL('./maintenance-journal.mjs',import.meta.url))).digest('hex')},{resume:bool(args,'resume'),deadline});
  const inspect=record=>{
    const actual=database.prepare('SELECT id,path,owner,source_commit,group_id FROM workspace WHERE id=?').get(record.id);
    if(!actual||maintenanceDigest(record)!==maintenanceDigest({id:actual.id,path:actual.path,owner:actual.owner,sourceCommit:actual.source_commit,groupId:actual.group_id}))throw new MaintenanceError('maintenance-record-identity-conflict');
    if(generatedOnlySourceCustody(database,record.id)||recordRetainsCustody(database,record.id)||retainedParent(database,record.path))throw new MaintenanceError('maintenance-retained-custody');
  };
  try{
    if(bool(args,'reconcile')){
      const result=journal.reconcile(spec=>{inspect(spec.workspace);return withWorkspaceLock(database,spec.workspace.path,()=>{inspect(spec.workspace);maintenanceContext={journal,record:spec.workspace};try{return maintenancePostcondition(spec);}finally{maintenanceContext=undefined;}},spec.workspace.groupId,deadline);});print(result,true);return;
    }
    const result=journal.run({next,inspect,maxRecords,execute:record=>withWorkspaceLock(database,record.path,()=>{inspect(record);maintenanceContext={journal,record};try{return maintainReferenceClone(record.path,true,statePath);}finally{maintenanceContext=undefined;}},record.groupId,deadline)});print(result,true);if(result.state!=='settled')process.exitCode=75;
  }catch(error){const checkpoint=journal.status();print({...checkpoint,error:{code:error instanceof MaintenanceError?error.code:'maintenance-command-failed',message:error.message}},true);process.exitCode=75;}finally{maintenanceContext=undefined;journal.close();}
}

function statusCommand(database, args) {
  assertOnly(args, ["root", "json", "id", "path", "owner", "limit", "after"]);
  const root = one(args, "root");
  const pathFilter = one(args, "path");
  const ownerFilter = one(args, "owner");
  const idFilter = one(args, "id");
  const predicates = [];
  const parameters = [];
  if(idFilter!==undefined){predicates.push("id = ?");parameters.push(idFilter);}
  if (root !== undefined) {
    predicates.push("root = ?");
    parameters.push(path.resolve(root));
  }
  if (pathFilter !== undefined) {
    predicates.push("(path = ? OR instr(path, ?) > 0)");
    parameters.push(path.resolve(pathFilter), pathFilter);
  }
  if (ownerFilter !== undefined) {
    predicates.push("instr(coalesce(owner, ''), ?) > 0");
    parameters.push(ownerFilter);
  }
  const where = predicates.length > 0 ? ` WHERE ${predicates.join(" AND ")}` : "";
  const limitText = one(args, "limit") ?? "100";
  if (!/^[1-9][0-9]*$/.test(limitText) || Number(limitText) > 500) fail("--limit must be an integer from 1 to 500");
  const limit = Number(limitText);
  const after = one(args, "after");
  const matched = database.prepare(`SELECT count(*) AS count FROM workspace${where}`).get(...parameters).count;
  const pagePredicates = [...predicates], pageParameters = [...parameters];
  if (after !== undefined && after !== "start") {
    let cursor;
    try { cursor = JSON.parse(Buffer.from(after, "base64url").toString("utf8")); } catch { fail("invalid --after status cursor"); }
    if (!Array.isArray(cursor) || cursor.length !== 3 || cursor.some(value => typeof value !== "string")) fail("invalid --after status cursor");
    pagePredicates.push("(root, path, id) > (?, ?, ?)");
    pageParameters.push(...cursor);
  }
  const pageWhere = pagePredicates.length ? ` WHERE ${pagePredicates.join(" AND ")}` : "";
  // Cache declarations and pending creation payloads belong to lifecycle operations, not pool status.
  const rows = database.prepare(`SELECT id, path, root, kind, mode, owner, repository, source_commit, ${ASSIGNMENT_SOURCE}, checkout_type,
    length(cache_paths) AS cache_bytes, length(creation_request) AS creation_bytes,
    created_at, updated_at, lease_expires_at, state, detail, group_id
    FROM workspace${pageWhere} ORDER BY root, path, id LIMIT ?`).all(...pageParameters, limit + 1);
  const hasMore = rows.length > limit;
  const records = rows.slice(0, limit).map(row => {
    const { cachePaths, ...record } = rowToRecord({ ...row, cache_paths: "[]", creation_request: "null" });
    delete record.creation;
    const submitted=database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='workspace_release_submission'").get();
    const submission=submitted?database.prepare('SELECT request_id,unit_name,state,launch_json,binding_json FROM workspace_release_submission WHERE workspace_id=?').get(row.id):null;
    return { ...record, ...(submission?{releaseSubmission:{requestId:submission.request_id,unitName:submission.unit_name,state:submission.state,originalBinding:JSON.parse(submission.binding_json),launch:JSON.parse(submission.launch_json??'null')}}:{}), releaseSettlement: releaseSettlement(database, row.id), capacity: recordedCapacity(database, row.id), cacheDeclarationBytes: row.cache_bytes, creationRequestBytes: row.creation_bytes };
  });
  const last = rows[Math.min(rows.length, limit) - 1];
  const nextAfter = hasMore && last ? Buffer.from(JSON.stringify([last.root, last.path, last.id])).toString("base64url") : null;
  if (bool(args, "json")) {
    print({ records, matched, limit, nextAfter }, true);
    return;
  }
  const filtered = pathFilter !== undefined || ownerFilter !== undefined;
  const total = !filtered ? matched : root === undefined
    ? database.prepare("SELECT count(*) AS count FROM workspace").get().count
    : database.prepare("SELECT count(*) AS count FROM workspace WHERE root = ?").get(path.resolve(root)).count;
  if (filtered && matched === 0) {
    process.stdout.write(`no registered workspace matches that filter; ${total} record(s) are known, and a checkout absent from all of them was never registered\n`);
    return;
  }
  const summary = new Map();
  for (const record of records) summary.set(record.state, (summary.get(record.state) ?? 0) + 1);
  const scope = filtered ? ` (filtered from ${total})` : "";
  process.stdout.write(`${records.length} of ${matched} registered workspace(s)${scope} on this page: ${[...summary].map(([state, count]) => `${state}=${count}`).join(" ")}\n`);
  if (nextAfter) process.stdout.write(`more records: agent-workspace status --after ${nextAfter} (repeat the same filters)\n`);
  if (filtered) {
    for (const record of records) {
      process.stdout.write(`${record.path}\n  state ${record.state}: ${record.detail}\n  owner ${record.owner ?? "(none)"}  mode ${record.mode}  present-on-disk ${existsSync(record.path)}\n`);
    }
    return;
  }
  print(records, false);
}

function help() {
  process.stdout.write(`Usage:
  agent-workspace create --root PATH --name NAME --repo URL [--ref GIT_REF] [--mode writer|review] [--group ID] [--cache PATH,...] [--creation-timeout-seconds 300] [--sparse-pattern PATTERN ...]
                         [--intent source-only|budgeted --headroom-gib N --growth-mib N]
  agent-workspace job-status --job-id SHA256 [--json]
  agent-workspace source-status --job-id SHA256 [--json]
  agent-workspace source-job-abandon --job-id SHA256 --owner OWNER --permit-sha256 SHA256 --json
  agent-workspace register --path PATH [--owner ID] [--source-commit SHA] [--group ID] [--cache PATH,...] [--cache-owned OUTPUT=TRACKED_SOURCE] [--replace-cache] [--retained | --lease-seconds N] [--adopt-accounted | --intent source-only|budgeted --headroom-gib N --growth-mib N | --min-free-gib N]
  agent-workspace terminal-safety --id ID --path PATH --owner OWNER --json
  agent-workspace custody-status --id ID --path PATH --json
  agent-workspace end-writing --id ID --path PATH --owner OWNER --disposition FILE --disposition-sha256 SHA --json
  agent-workspace thaw-source --id ID --path SOURCE_SNAPSHOT --owner OWNER --expected-head SHA [--json]
  agent-workspace source-handoff --id ID --path PATH --owner OWNER --expected-head SHA --recipient OWNER --remote origin --branch BRANCH --json
  agent-workspace freeze-source --id ID --path SOURCE_SNAPSHOT --owner OWNER --expected-head SHA --recipient OWNER --authorization EVIDENCE [--json]
  agent-workspace retire-idle-growth [--root PATH] [--budget-ms 90000] [--max-records 128] [--json]
  agent-workspace writer-run --id ID --path PATH --owner OWNER --expected-head SHA --command-json '["executable","arg"]' --timeout-ms N [--json]
  agent-workspace adopt-ended-actions --id ID --path PATH --repository owi-link/converge --run RUN --attempt ATTEMPT --source-commit SHA --json
  agent-workspace reassign --id ID --path PATH --from-owner ID --from-source-commit SHA|unset --from-state STATE
                           --owner ID --source-commit HEAD_SHA --authorization RECEIPT [--json]
  agent-workspace adopt --root PATH [--mode writer|review] [--nested-groups] [--cache PATH,...] [--cache-owned OUTPUT=TRACKED_SOURCE] [--replace-cache] [--execute]
  agent-workspace cancel-creation (--id ID|--path PATH)
  agent-workspace finalize-creation (--id ID|--path PATH)
  agent-workspace heartbeat ${selectorSyntax("heartbeat")} [--lease-seconds N]
  agent-workspace release ${selectorSyntax("release")} [--reap-expired] [--preserve-runtime]
  agent-workspace dispose-local-merges ${selectorSyntax("dispose-local-merges")} --owner OWNER [--json]
  agent-workspace release ${selectorSyntax("release")} --end-retention --owner OWNER --expected-plan-sha256 SHA [--json]
  agent-workspace reconcile [--root PATH] [--execute] [--reap-expired] [--preserve-runtime]
                            [--budget-ms 20000] [--max-groups 32] [--after ID|start]
  agent-workspace release-ended-owners [--root PATH | ${selectorSyntax("release-ended-owners")}] [--execute]
                            [--budget-ms 30000] [--max-records 16] [--after ID|start] [--json]
  agent-workspace bind-native-owners [--root PATH | --id ID | --path PATH] [--execute] [--budget-ms 30000] [--max-records 128] [--after ID|start] [--json]
  agent-workspace reap-ended-owners [--root PATH] [--execute] [--bind-budget-ms 15000] [--bind-max-records 128] [--budget-ms 90000] [--max-records 64] [--json]
  agent-workspace measure-capacity [--root PATH | --path PATH | --id ID] [--budget-ms 40000] [--incremental] [--content-proof] [--json]
  agent-workspace reprice-capacity ${selectorSyntax("reprice-capacity")} --intent source-only|budgeted --headroom-gib N --growth-mib N [--json]
  Active reduction additionally requires --id ID --path PATH --owner OWNER --reduction FILE --reduction-sha256 SHA256
                            [--budget-ms 25000]
  agent-workspace reduce-retained-headroom --id ID --path PATH --owner OWNER --disposition FILE --disposition-sha256 SHA --json
  agent-workspace execution-reserve --root ABS_EMPTY_DIRECTORY --owner OWNER --operation-id UUID --growth-mib N --headroom-gib N --holder-pid PID --json
  agent-workspace execution-status --id execution:UUID --json
  agent-workspace execution-release --id execution:UUID --owner OWNER --expected-plan-sha256 SHA256 --json
  agent-workspace growth-status ${selectorSyntax("growth-status")} [--json]
  agent-workspace cache-safety --id ID --path PATH --owner OWNER (--cache RELATIVE|--request FILE --request-sha256 SHA) --json
  agent-workspace cache-plan --id ID --path PATH --owner OWNER --cache RELATIVE --classification node-dependencies|declared-build-cache --operation-id ID --evidence TEXT --json
  agent-workspace retire-cache --id ID --path PATH --owner OWNER --request FILE --request-sha256 SHA --json
  agent-workspace retire-cache-status (--id ID|--stage STAGING_NAME) --json
  agent-workspace share-mirror-packs [--mirror MIRROR_GIT_DIR ...] --json
  agent-workspace prune-mirrors [--execute] [--unused-days 14] --json
  agent-workspace prune-inode-content --json
  agent-workspace retire-source-materialization --id ID --path PATH --owner OWNER --request ABS_FILE --request-sha256 SHA --json
  agent-workspace retire-growth ${selectorSyntax("retire-growth")} --owner OWNER --disposition FILE --disposition-sha256 SHA [--json]
  agent-workspace resume-growth ${selectorSyntax("resume-growth")} --owner OWNER --expected-plan-sha256 SHA --intent source-only|budgeted --headroom-gib N --growth-mib N [--json]
  agent-workspace maintain (--root PATH | --id ID | --path PATH) --budget-ms 1000..20000 --max-records 1..32 [--execute --operation-id UUID --prior-state FILE --prior-state-sha256 SHA256 [--resume] [--reconcile]] [--json]
  agent-workspace status [--root PATH] [--path SUBSTRING] [--owner SUBSTRING] [--limit 1..500 (initial page 100)] [--after CURSOR|start] [--json]
  agent-workspace list ...                    alias for status

Status JSON returns nextAfter; repeat the same filters with --after nextAfter until nextAfter is null.
Ordinary release commits owned-retention before inspection; status reports its original requestId/owner and explicit unsettled physical disposition after a caller interruption.
The registered owner retains settlement responsibility; release never replays another command in the caller batch.
The registry defaults to ${DEFAULT_STATE}. Set PI_WORKSPACE_STATE to move it.
Repeat --cache to declare ignored generated paths that release may remove; these extend the default cache set.
Use a Git ref the source repository can fetch, such as refs/heads/main or a branch name, not origin/main.
Clone checkout is a durable systemd user job; exit 75 with state creating includes a read-only job-status command.
Checkout budgets scale with immutable path count and construction bytes; --creation-timeout-seconds accepts 1–86400.
A caller timeout cannot interrupt it. New clones publish atomically; failed/interrupted staging is removed.
Use repeatable --sparse-pattern PATTERN (Git non-cone patterns) to materialize only selected source paths.
A lease expiry permits reconciliation; it never makes dirty or unpushed work disposable.
Records with the same --group lease, heartbeat, and release as one multi-repository workspace.
Records outlive the directory, so status explains what became of a checkout that is gone;
--path takes a substring, so "status --path ob50" answers that without reading every record.
`);
}

export const workspaceTesting = { leaveReleaseDirectory, processReferences, finishSubmittedRelease, adoptCustodyForRelease, growthSafety, inheritShallowBoundary, completeCreation, assertRepriceSnapshot, repriceReservations, openRegistry, releaseCommand, reassignWorkspace, bindNativeOwnersCommand,releaseEndedOwnersCommand,endedCustodyLineage,reapEndedOwnersCommand, withCapacityAdmission, pruneReleased, ensureSourceCustody, fetchSource, resolveSource, sourceRefFor, prepareCreationSource, revalidatePreparedSource, repositoryRemotes, configurePushUrl, duringInspection, safetySnapshot, assertSafetyBudget, importBaseCommits, ownReleaseUnit, installedReferenceSnapshot, leaseReleaseDisposition, reconcileRecord, stackQueueInspection, classifyWorkspaceCache, cacheBinding, inspectRecord, capacityRefusalDetails, checkoutConstructionCapacity, ledgerLiability, assertCapacity, allocatedWorkspaceBytes, workspaceAllocationSample, cachedWorkspaceAllocation, remainingCapacityBytes, capacityRequirement, capacityReservations, gitDependencySnapshot, sourceCapacityPlan, cacheTargets, stripCaches, dockerEndpointScope: census.dockerEndpointScope, dockerSnapshot, groupReconciliation, maintainReferenceClone, parseSystemdUnits: census.parseSystemdUnits, pruneReleased, systemdManagerSnapshot, releaseInspectionContext, systemdReferences, ownerThreadDatabases: census.ownerThreadDatabases, threadSnapshot };

// Whether a submission's background unit has ceased (never a guess: an observation error is "not ceased").
function releaseUnitCessation(row) {
  const observed=command('systemctl',['show','--property=LoadState','--property=ActiveState','--property=MainPID','--property=ControlPID',`${JSON.parse(row.launch_json??'null')?.started??`kenan-bg-${JSON.parse(row.binding_json).agentId}-${row.unit_name}`}.service`],{timeout:2000});
  const fields=Object.fromEntries(String(observed.stdout??'').trim().split('\n').map(line=>line.split('=')));
  return {ceased:!observed.error&&observed.status===0&&((fields.LoadState==='not-found')||(fields.MainPID==='0'&&fields.ControlPID==='0'&&['inactive','failed'].includes(fields.ActiveState)))};
}

// A detached physical release must not be pinned by its submitter's inherited cwd.
// Resolve the selector and flags first, then move only this administrative process;
// real shells, descriptors, executables and other writers remain in the census.
function leaveReleaseDirectory() {
  process.chdir(homedir());
}

// One foreground release attempt. Returns {adopt:refusal} when an authenticated native caller is
// not the custodian and custody adoption may be tried, {refused:refusal} when it was already
// tried, and undefined after printing any other outcome itself.
function releaseForegroundAttempt(database,args,statePath,selected,{deadline,releaseScope,releaseAuthorityDependencies,allowAdoption,adoption}) {
  // Custody may have just moved: always authorize the current record, never the caller's snapshot.
  const record=recordBy(database,{id:selected.id});
  try {
    return duringInspection(deadline,()=>{
      const members=recordsInGroup(database,record);
      const authority=authorizeWorkspaceRelease(database,members.length?members:[record],statePath,{deadline,...releaseAuthorityDependencies});
      if(!authority.ok&&authority.error?.code==='release-owner-mismatch')return allowAdoption?{adopt:authority}:{refused:authority,adoption};
      if(!authority.ok){if(bool(args,'json'))print(authority,true);else process.stderr.write(`agent-workspace: ${authority.error.code}: ${authority.error.detail}\n`);process.exitCode=2;return;}
      const foreground=authority.kind==='native'&&releaseScope?.background!==true;
      const lock=action=>foreground?withResourceLock(statePath,`release-submit:${record.id}`,action,deadline):withWorkspaceLock(database,record.path,action,record.groupId,deadline);
      const submitted=lock(()=>{
        if(!foreground){releaseCommand(database,args,statePath,{deadline,...releaseAuthorityDependencies});return;}
        assertOnly(args,['id','path','reap-expired','preserve-runtime','json','end-retention','owner','expected-plan-sha256']);
        const request={id:record.id,path:record.path,owner:record.owner,sourceCommit:record.sourceCommit,
          members:(members.length?members:[record]).map(member=>member.id).sort(),flags:[...args.named].filter(([key])=>!['id','path','json'].includes(key)).sort(([a],[b])=>a.localeCompare(b))};
        leaveReleaseDirectory();
        return submitRelease({database,record,request,binding:authority.binding,settlement:releaseSettlement(database,record.id),
          custodyLineage:[...endedCustodyLineage(database,record)],
          observe:releaseUnitCessation,launch:name=>{
            const argv=['release','--id',record.id,...request.flags.flatMap(([key,values])=>values.map(value=>`--${key}=${value}`)),'--json'];
            const launched=command('/usr/local/bin/kenan-bg',[name,'--',process.execPath,new URL('./release-worker.mjs',import.meta.url).pathname,new URL(import.meta.url).pathname,statePath,...argv],{timeout:5000,cwd:path.dirname(statePath),env:{KENAN_BG_IDENTITY:'1'}});
            if(launched.status!==0||launched.error)return {ok:false,code:'release-launch-outcome-unknown',status:launched.status,detail:launched.error?.code??'Observe the exact unit before any continuation.'};
            try{return JSON.parse(launched.stdout);}catch{return {ok:false,code:'release-launch-response-invalid'};}
          }});
      });
      if(submitted===undefined)return;
      const result=submitted.action==='release-submitted'?finishSubmittedRelease(database,record,submitted):submitted;
      print(adoption?{...result,custodyAdoption:adoption}:result,true);
      process.exitCode=result.action==='already-released'||result.completed===true?0:result.action==='release-retained'?2:75;
    });
  }catch(error){
    if(!(error instanceof ResourceBusyError))throw error;
    print({ok:false,error:{code:'release-resource-busy',detail:error.message},completed:false,
      releaseSettlement:releaseSettlement(database,record.id),nextAction:{observe:['agent-workspace','status','--id',record.id,'--json'],retry:'Repeat the same request after the recorded lock holder finishes.'},lock:error.detail},true);process.exitCode=75;
  }
}

// Observe the submitted background release for a bounded time and report what actually happened.
function finishSubmittedRelease(database,record,submitted,{budgetMs=RELEASE_AWAIT_MS,sleep,observeUnit=releaseUnitCessation}={}) {
  const outcome=awaitSubmittedRelease({budgetMs,...(sleep?{sleep}:{}),read:()=>{try{
    const row=database.prepare('SELECT * FROM workspace_release_submission WHERE workspace_id=?').get(record.id);
    // Unit first, then the record: a unit seen ceased has already written everything it will write.
    const unitCeased=row?.state==='submitted'?observeUnit(row).ceased===true:false;
    const current=database.prepare('SELECT state FROM workspace WHERE id=?').get(record.id);
    return {recordState:current?.state,pathExists:existsSync(record.path),submissionState:row?.state,unitCeased,terminal:row?.terminal_json?JSON.parse(row.terminal_json):null};
  }catch{return {submissionState:'submitted'};}}});
  const settlement=releaseSettlement(database,record.id);
  if(outcome.kind==='completed')return {...submitted,action:'release-completed',completed:true,state:outcome.observed.submissionState,releaseSettlement:settlement};
  if(outcome.kind==='terminal')return {...submitted,ok:false,action:'release-retained',completed:false,state:'terminal-known',terminal:outcome.observed.terminal,releaseSettlement:settlement,
    note:`The background release ended without removing the checkout. Read releaseSettlement and the unit log ${submitted.launch?.log??''} for the reason.`};
  return {...submitted,note:`The release is still running in the background unit (accepted work, not a failure). Its completion raises host event ${submitted.launch?.event??'job:<agent>:'+submitted.unitName}; agent-workspace status --id ${record.id} --json shows the outcome.`};
}

// The existing guarded transfer (release-ended-owners), limited to custody transfer for one checkout.
function adoptCustodyForRelease(database,record,statePath,authorityDependencies) {
  try {
    const result=releaseEndedOwnersCommand(database,{positional:[],named:new Map([['id',[record.id]],['execute',['true']],['budget-ms',['25000']]])},statePath,authorityDependencies,{transferOnly:true});
    if(result.ok===false&&result.error)return {transferred:false,action:'none',code:result.error.code,detail:result.error.detail};
    const item=(result.results??[]).find(entry=>entry.record?.id===record.id);
    const transferred=item!==undefined&&['transferred-to-requester','transferred-to-parent'].includes(item.action);
    return {transferred,action:item?.action??'none',...(transferred?{}:{code:item?.code??(result.ok?'owner-not-ended-native-worker':'owner-observation-unavailable')}),
      ...(item?.custody?{custody:item.custody}:{}),...(result.observation?.errors?.length?{observationErrors:result.observation.errors}:{})};
  }catch(error){return {transferred:false,action:'none',code:error.code??'custody-adoption-failed',detail:String(error.message).slice(0,500)};}
}

export function main(argv = process.argv.slice(2), statePath = DEFAULT_STATE, {releaseAuthorityDependencies, releaseScopeOverride} = {}) {
  // Tests that run inside a native tool call pass releaseScopeOverride:{background:true} so no real background unit starts.
  const releaseStarted=Date.now(), releaseScope=argv[0]!=='release'?null:releaseScopeOverride!==undefined?releaseScopeOverride:procScope(process.pid);
  const releaseEntryDeadline=argv[0]==='release'?releaseStarted+releaseBudgetMs(releaseScope):undefined;
  if(argv[0]==='execution-cessation') {
    const args=parseArgs(argv.slice(1));assertOnly(args,['holder']);
    print(executionCessation(JSON.parse(required(args,'holder'))),true);return;
  }
  if(argv[0]==='source-job-abandon-permit') {
    if(process.getuid?.()!==0)refuse('abandon-permit-unsafe','root permit reader required');
    const args=parseArgs(argv.slice(1));assertOnly(args,['job-id']);print(readPermit(required(args,'job-id')),true);return;
  }
  if(argv[0]==='source-job-cgroup-snapshot') {
    const args=parseArgs(argv.slice(1));assertOnly(args,['unit']);print(sourceJobCgroupSnapshot(required(args,'unit')),true);return;
  }
  if(argv[0]==='source-job-abandon') {
    const args=parseArgs(argv.slice(1));assertOnly(args,['job-id','owner','permit-sha256','json']);
    try {
      const jobId=required(args,'job-id');if(!/^[a-f0-9]{64}$/.test(jobId))refuse('abandon-invalid-job','full job SHA required');
      const permitRead=command('sudo',['-n',process.execPath,new URL(import.meta.url).pathname,'source-job-abandon-permit','--job-id',jobId],{timeout:5000});
      if(permitRead.status!==0)refuse('abandon-permit-unknown','trusted root permit reader failed');
      const {permit,permitSha256}=JSON.parse(permitRead.stdout);
      if(permitSha256!==required(args,'permit-sha256')||permit.owner!==required(args,'owner'))refuse('abandon-permit-changed','permit or applying owner mismatch');
      const caller=authenticatedAbandonCaller(permit),database=openRegistry(statePath);
      try {
        const r=recordBy(database,{id:permit.workspaceId});
        const result=withWorkspaceLock(database,r.path,()=>abandonSourceJob({directory:path.join(path.dirname(statePath),'source-preparations','jobs',jobId),jobId,
          requestSha256:permit.requestSha256,attemptSha256:permit.attemptSha256,
          validate:(request,attempt)=>{
            const record=recordBy(database,{id:permit.workspaceId});record.capacity=recordedCapacity(database,record.id);
            const transfer=database.prepare('SELECT * FROM workspace_reassignment WHERE workspace_id=? ORDER BY sequence DESC LIMIT 1').get(record.id);
            const head=git(record.path,['rev-parse','HEAD']);
            validateAbandonPermit(permit,{jobId,requestSha256:permit.requestSha256,attemptSha256:permit.attemptSha256,request,record,transfer,head,unit:attempt.unit,caller});
            const evidence=readFileSync(permit.priorTerminalEvidence.path);if(sha(evidence)!==permit.priorTerminalEvidence.sha256)refuse('abandon-evidence-changed','retained original terminal custody bytes changed');
            const parsed=JSON.parse(evidence);if(!/MainPID=0/.test(parsed.unitObservation)||!/ActiveState=inactive/.test(parsed.unitObservation)||!/ControlGroup=\n/.test(parsed.unitObservation))refuse('abandon-cessation-unknown','retained terminal witness changed');
            return {permitSha256,caller,workspaceId:record.id,owner:record.owner,adoptionSequence:transfer.sequence,head};
          },observe:unit=>{
            const safety=terminalSafety(database,r,Date.now()+25000);
            const read=command('sudo',['-n',process.execPath,new URL(import.meta.url).pathname,'source-job-cgroup-snapshot','--unit',unit],{timeout:10000});
            if(read.status!==0)refuse('abandon-cessation-unknown','privileged original-unit census failed');
            return {...safety,cgroup:JSON.parse(read.stdout)};
          }}),r.groupId);
        print(result,true);if(!result.ok)process.exitCode=2;
      }finally{database.close();}
    }catch(error){print({ok:false,error:{code:error.code??'abandon-failed',message:error.message}},true);process.exitCode=2;}
    return;
  }
  if (argv[0] === "materialization-process-snapshot") {
    if (process.getuid?.() !== 0) throw new MaterializationError("materialization-safety-unknown", "all-FD observation requires root");
    const args = parseArgs(argv.slice(1)); assertOnly(args, ["path"]);
    const roots = many(args, "path");
    if (roots.length < 1 || roots.length > 65 || roots.some(root => !path.isAbsolute(root))) throw new MaterializationError("materialization-invalid-request", "exact original/stage paths required");
    print(materializationProcessReferences(roots), true); return;
  }
  if (argv[0] === "growth-process-snapshot") {
    if (process.getuid?.() !== 0) growthError("growth-writer-unknown", "privileged process observation requires root");
    const args = parseArgs(argv.slice(1));
    assertOnly(args, ["path"]);
    const paths = many(args, "path");
    if (!paths.length || paths.some(target => !path.isAbsolute(target))) growthError("invalid-growth-disposition", "absolute paths required");
    print(growthProcessReferences(paths), true);
    return;
  }
  if (argv[0] === "source-prepare") return sourcePreparationWorker();
  if (argv[0] === "source-revalidate") return sourceRevalidationWorker();
  const [commandName, ...rest] = argv;
  if (
    commandName === undefined ||
    commandName === "--help" ||
    commandName === "help" ||
    (rest.length === 1 && rest[0] === "--help")
  ) {
    help();
    return;
  }
  const args = parseArgs(rest);
  if (args.positional.length > 0) fail(`unexpected argument: ${args.positional[0]}`);
  if (commandName === 'maintain') {
    const selected = selectedArguments(commandName, {id:one(args,'id'),path:one(args,'path')});
    if (!selected.ok) throw Object.assign(new CliError(selected.error.detail), {code:selected.error.code,nextAction:selected.error.nextAction});
  }
  if (commandName === "share-mirror-packs") {
    assertOnly(args, ["mirror", "json"]);
    const root = path.join(path.dirname(statePath), "mirrors");
    const mirrors = many(args, "mirror").length ? many(args, "mirror").map(mirror => path.resolve(mirror))
      : existsSync(root) ? readdirSync(root).filter(name => name.endsWith(".git")).sort().map(name => path.join(root, name)) : [];
    const results = mirrors.map(mirror => {
      const stale = removeStaleTemporaryPacks(mirror);
      if (stale.removed > 0) process.stderr.write(`agent-workspace: removed ${stale.removed} abandoned temporary pack files (${stale.freedBytes} bytes) from ${mirror}\n`);
      try { return { mirror, ...withResourceLock(statePath, `mirror:${mirror}`, () => shareLocalMirrorPacks(statePath, mirror, []), undefined, { mode: "shared", waitMs: 5000 }) }; }
      catch (error) { if (error instanceof ResourceBusyError) return { mirror, ok: false, error: { code: "mirror-busy", detail: error.message } }; throw error; }
    }).filter(result => !result.ok || !["no-local-source", "not-applicable"].includes(result.value.state));
    print({ ok: results.every(result => result.ok), freedBytes: results.reduce((total, result) => total + (result.value?.freedBytes ?? 0), 0), mirrors: results }, true);
    return;
  }
  if (commandName === "prune-mirrors") {
    const home = process.env.HOME || "/home/kenan";
    // [checkouts one level down, checkouts two levels down]
    const MIRROR_BORROWER_ROOTS = [[path.join(home, "worktrees"), null], [path.join(home, "work", "clones"), null], ["/home/kenan-research", "/home/kenan-research/checkouts"]];
    assertOnly(args, ["execute", "unused-days", "json"]);
    const unusedDays = numberFlag(args, "unused-days", 14);
    const root = path.join(path.dirname(statePath), "mirrors");
    const database = openRegistry(statePath);
    let rows;
    try { rows = database.prepare("SELECT path, root, repository, state FROM workspace").all(); } finally { database.close(); }
    // Every existing checkout the registry knows, anything else in its roots, research
    // checkouts (their user can enter the mirrors folder), and checkouts moved to the cold tier.
    const checkouts = new Set([...rows.map(row => row.path).filter(file => !movedToColdStorage(file) && existsSync(file)),
      ...checkoutsUnder([...new Set(rows.map(row => row.root))], 1),
      ...checkoutsUnder(MIRROR_BORROWER_ROOTS.map(([directory]) => directory).filter(Boolean), 1),
      ...checkoutsUnder(MIRROR_BORROWER_ROOTS.map(([, directory]) => directory).filter(Boolean), 2)]);
    const coldBorrowed = coldBorrowedObjectDirectories(process.env.AGENT_WORKSPACE_COLD_OWNERS || "/var/lib/kenan-cold/owners",
      path.join(path.dirname(statePath), "cold-alternates.v1.json"));
    const verdicts = classifyMirrors({ mirrorRoot: root, checkouts: [...checkouts], coldBorrowed, unusedDays,
      activeRepositories: rows.filter(row => row.state !== "released").map(row => row.repository) });
    const execute = bool(args, "execute");
    const retired = [];
    for (const verdict of verdicts.filter(verdict => verdict.retire)) {
      if (!execute) { retired.push({ ...verdict, action: "would-remove" }); continue; }
      // Imports hold this lock shared; removal waits for none of them and skips a busy mirror.
      try { withResourceLock(statePath, `mirror:${verdict.mirror}`, () => removeMirror(verdict.mirror), undefined, { waitMs: 1000 }); retired.push({ ...verdict, action: "removed" }); }
      catch (error) { if (!(error instanceof ResourceBusyError)) throw error; retired.push({ ...verdict, action: "busy" }); }
    }
    const parked = execute ? removeParkedMirrors(root) : 0;
    print({ ok: true, execute, unusedDays, coldBorrowersKnown: coldBorrowed !== null, mirrors: verdicts.length, kept: verdicts.length - retired.length, retired, parkedLeftoversRemoved: parked }, true);
    return;
  }
  if (commandName === "source-status" || commandName === "job-status") {
    assertOnly(args, ["job-id", "json"]);
    const jobId = required(args, "job-id");
    const result = observeWorkspaceJob(statePath, jobId, commandName === "source-status" ? "source" : null);
    print({ jobId, ...result }, true);
    process.exitCode = result.state === "pending" ? 75 : result.state === "ready" ? 0 : 2;
    return;
  }
  if (commandName === "create") {
    const budgetMs = creationTimeout(args);
    const repository = repositoryLocation(required(args, "repo"), currentDirectory());
    if (process.env.PI_WORKSPACE_CREATE_CHILD !== statePath) {
      args.named.set("root", [path.resolve(required(args, "root"))]);
      args.named.set("repo", [repository]);
      const normalized = [...args.named].flatMap(([name, values]) => values.map((value) => `--${name}=${value}`));
      const attempt = () => command("timeout", ["--kill-after=1", String(budgetMs / 1000),
        process.execPath, new URL(import.meta.url).pathname, "create", ...normalized], {
        timeout: budgetMs + 3_000,
        env: { PI_WORKSPACE_STATE: statePath, PI_WORKSPACE_CREATE_CHILD: statePath },
      });
      // Source preparation and checkout run as durable background jobs. Repeat the request
      // here as each one finishes, so one call normally returns the active workspace instead
      // of handing the caller a "repeat this request" loop.
      const waitDeadline = Date.now() + createWaitMs();
      let result = attempt();
      while (result.status === 75 && Date.now() < waitDeadline) {
        const job = pendingJobResult(result.stdout);
        if (job === null) break;
        const pause = new Int32Array(new SharedArrayBuffer(4));
        do Atomics.wait(pause, 0, 0, 1000); while (!existsSync(job) && Date.now() < waitDeadline);
        result = attempt();
      }
      if ([124, 137].includes(result.status) || result.error?.code === "ETIMEDOUT") {
        fail("creation budget exhausted; pending reservation retained, not active; repeat the same create command to retry, optionally increasing --creation-timeout-seconds (maximum 86400)");
      }
      if (result.status === 75 && result.stdout) {
        const pending = JSON.parse(result.stdout);
        if (pending.state === "preparing" && pending.jobId && pending.progressPath) {
          process.stdout.write(`${result.stdout}\n`);
          process.exitCode = 75;
          return;
        }
      }
      if (result.status === 75) {
        if (result.stdout) {
          process.stdout.write(`${result.stdout}\n`);
          process.exitCode = 75;
          return;
        }
        throw new ResourceBusyError(result.stderr);
      }
      if (result.status !== 0) fail(result.stderr || result.error?.message ||
        "creation interrupted; repeat the same command to resume");
      process.stdout.write(`${result.stdout}\n`);
      return;
    }
    creationDeadline = Date.now() + budgetMs;
  }
  if(commandName==='maintain'&&process.env.PI_WORKSPACE_MAINTAIN_WORKER!==statePath){
    const budget=Number(one(args,'budget-ms'));
    if(!Number.isSafeInteger(budget)||budget<1000||budget>20000)throw new MaintenanceError('maintenance-explicit-bounds-required');
    const result=boundedCommand(process.execPath,[new URL(import.meta.url).pathname,...argv],{timeout:budget+1000,maxBuffer:1048576,reapGroup:true,env:{...process.env,PI_WORKSPACE_STATE:statePath,PI_WORKSPACE_MAINTAIN_WORKER:statePath}});
    if(result.error||result.signal){print({kind:'maintenance-worker-outcome-unknown',state:'unknown',operationId:one(args,'operation-id')??null,code:result.error?.code??'worker-signalled',next:'observe original journal; reconcile before resume; never replay as a new operation'},true);process.exitCode=75;return;}
    process.stdout.write(result.stdout);process.stderr.write(result.stderr);process.exitCode=result.status;return;
  }
  const database = openRegistry(statePath,releaseEntryDeadline);
  try {
    if (!["heartbeat", "retire-idle-growth", "capacity-status", "source-handoff", "thaw-source", "freeze-source", "writer-run", "execution-reserve", "execution-release", "execution-status", "register", "terminal-safety", "custody-status", "end-writing", "status", "list", "maintain", "cancel-creation", "finalize-creation", "reassign", "adopt-ended-actions", "release", "retire-source-materialization", "cache-plan", "retire-cache", "retire-cache-status", "cache-safety", "growth-status", "retire-growth", "dispose-local-merges", "reduce-retained-headroom", "resume-growth"].includes(commandName)
      && (commandName !== "reconcile" || bool(args, "execute"))) {
      const scopedRoot = commandName === "reconcile" ? one(args, "root") : undefined;
      const scopedIds = scopedRoot === undefined ? undefined
        : database.prepare("SELECT id FROM workspace WHERE root=?").all(path.resolve(scopedRoot)).map(row => row.id);
      drainGc(statePath, scopedIds);
    }
    if (["execution-reserve","execution-status","execution-release"].includes(commandName)) {
      if(args.positional.length)growthError("execution-invalid-request","no positional arguments accepted");
      print(executionCommand({database,args:args.named,command:commandName,statePath,
        lock:(device,action)=>withResourceLock(statePath,`capacity:${device}`,action),
        reservations:device=>capacityReservations(database,device),requirement:capacityRequirement,
        observe:holder=>{
          const result=command("sudo",["-n",process.execPath,new URL(import.meta.url).pathname,"execution-cessation","--holder",JSON.stringify(holder)],{timeout:7000});
          if(result.status!==0)growthError(result.stderr?.includes("execution-holder-live")?"execution-holder-live":"execution-cessation-unknown",result.stderr?.trim()||"trusted observer failed");
          try{return JSON.parse(result.stdout);}catch{growthError("execution-cessation-unknown","invalid observer output");}
        }}),true);
    }
    else if (commandName === "retire-idle-growth") print(retireIdleGrowthCommand(database,args,statePath),bool(args,"json"));
    else if (commandName === "create") createCommand(database, args, statePath);
    else if (commandName === "register") registerCommand(database, args);
    else if (commandName === "end-writing") endWritingCommand(database,args);
    else if (commandName === "terminal-safety") { assertOnly(args,["id","path","owner","json"]);const r=growthSelected(database,args,"terminal-safety"),deadline=Date.now()+25000;if(r.owner!==required(args,"owner"))growthError("stale-growth-disposition","owner changed");duringInspection(deadline,()=>withWorkspaceLock(database,r.path,()=>withGrowthBorrowerLocks(database,r,()=>print({ok:true,effect:"none",safety:terminalSafety(database,r,deadline)},true),deadline),r.groupId,deadline)); }
    else if (commandName === "custody-status") { assertOnly(args,["id","path","json"]); const r=growthSelected(database,args); withWorkspaceLock(database,r.path,()=>print({ok:true,binding:cacheBinding(database,r.id)},true),r.groupId); }
    else if (commandName === "thaw-source") thawSourceCommand(database,args);
    else if (commandName === "source-handoff") sourceHandoffCommand(database,args);
    else if (commandName === "freeze-source") freezeSourceCommand(database,args);
    else if (commandName === "writer-run") writerRunCommand(database,args);
    else if (commandName === "adopt-ended-actions") adoptEndedActionsCommand(database,args,statePath);
    else if (commandName === "reassign") reassignCommand(database, args);
    else if (commandName === "adopt") adoptCommand(database, args, statePath);
    else if(commandName==='release') {
      const selected=recordBy(database,selectorFrom(args,'release'));
      const group=recordsInGroup(database,selected),record=[...(group.length?group:[selected])].sort((a,b)=>a.id.localeCompare(b.id))[0];
      database.exec(`PRAGMA busy_timeout=${Math.max(1000,Math.min(REGISTRY_BUSY_MS,releaseEntryDeadline-Date.now()))}`);
      const initialMembers=recordsInGroup(database,record);
      // A completed release is history, not custody: anyone may read that it already happened.
      // Before October 29 a non-custodian got release-owner-mismatch for a checkout that was
      // already gone (awareness-list-1bab, released by its creator's background unit).
      if((initialMembers.length?initialMembers:[record]).every(member=>member.state==='released'&&!existsSync(member.path)))
        print({ok:true,action:'already-released',completed:true,record,releaseSettlement:releaseSettlement(database,record.id)},true);
      else {
        let attempt=releaseForegroundAttempt(database,args,statePath,record,{deadline:releaseEntryDeadline,releaseScope,releaseAuthorityDependencies,allowAdoption:true});
        if(attempt?.adopt){
          // The caller is not the custodian. When native lineage proves the custodian ended (and
          // the caller is its live parent or an authenticated successor), or the custodian is the
          // caller's parent holding custody transferred from its ended child, take custody through
          // the existing guarded release-ended-owners transfer, then release. A transfer deletes
          // nothing; live owners, unknown owners and pending wakes naming the checkout still refuse.
          const adoption=adoptCustodyForRelease(database,record,statePath,releaseAuthorityDependencies);
          if(adoption.transferred)attempt=releaseForegroundAttempt(database,args,statePath,record,{deadline:Date.now()+releaseBudgetMs(releaseScope),releaseScope,releaseAuthorityDependencies,allowAdoption:false,adoption});
          else attempt={refused:attempt.adopt,adoption};
        }
        if(attempt?.refused){
          const refusal={...attempt.refused,...(attempt.adoption?{custodyAdoption:attempt.adoption}:{}),
            nextAction:{status:['agent-workspace','status','--id',record.id,'--json'],
              explanation:'Only the checkout custodian releases it. Custody moves automatically when native lineage proves the custodian ended and you are its live parent or successor; a live custodian must release it itself or reassign it.'}};
          if(bool(args,'json'))print(refusal,true);else process.stderr.write(`agent-workspace: ${refusal.error.code}: ${refusal.error.detail}${attempt.adoption?` (custody adoption: ${attempt.adoption.action??'none'} ${attempt.adoption.code??''})`:''}\n`);
          process.exitCode=2;
        }
      }
    }
    else if (["heartbeat", "cancel-creation", "finalize-creation"].includes(commandName)) {
      const record = recordBy(database, selectorFrom(args, commandName));
      withWorkspaceLock(database, record.path, () => {
        if (commandName === "heartbeat") heartbeatCommand(database, args, statePath);
        else if (commandName === "cancel-creation") cancelCreationCommand(database, args);
        else if (commandName === "finalize-creation") finalizeCreationCommand(database, args, statePath);
        else releaseCommand(database, args, statePath);
      }, record.groupId);
    }
    else if (commandName === "reconcile") reconcileCommand(database, args, statePath);
    else if (commandName === "prune-inode-content") { assertOnly(args, ["json"]); print({ ok: true, ...pruneInodeContent(database) }, true); }
    else if (["bind-native-owners","release-ended-owners","reap-ended-owners"].includes(commandName)) {
      const result=commandName==="bind-native-owners"?bindNativeOwnersCommand(database,args,statePath):commandName==="release-ended-owners"?releaseEndedOwnersCommand(database,args,statePath):reapEndedOwnersCommand(database,args,statePath);
      print(result,true);if(!result.ok)process.exitCode=75;
    }
    else if (commandName === "measure-capacity") measureCapacityCommand(database, args, statePath);
    else if (commandName === "capacity-status") capacityStatusCommand(database,args);
    else if (commandName === "growth-status") growthStatusCommand(database, args, statePath);
    else if (commandName === "cache-safety") cacheSafetyCommand(database,args,statePath);
    else if (commandName === "cache-plan" || commandName === "retire-cache") workspaceCacheCommand(database,args,statePath,commandName === "cache-plan");
    else if (commandName === "retire-cache-status") { assertOnly(args,["id","stage","json"]); const result=cacheRetirementStatus(database,{workspaceId:one(args,"id"),stage:one(args,"stage")}); print(result,true); if(!result.ok) process.exitCode=2; }
    else if (commandName === "retire-source-materialization") retireSourceMaterializationCommand(database, args, statePath);
    else if (commandName === "retire-growth") retireGrowthCommand(database, args, statePath);
    else if (commandName === "dispose-local-merges") disposeLocalMergesCommand(database, args);
    else if (commandName === "reduce-retained-headroom") reduceRetainedHeadroomCommand(database,args,statePath);
    else if (commandName === "resume-growth") repriceCapacityCommand(database, args, statePath, true);
    else if (commandName === "reprice-capacity") repriceCapacityCommand(database, args, statePath);
    else if (commandName === "maintain") maintainCommand(database, args);
    else if (commandName === "status" || commandName === "list") statusCommand(database, args);
    else {
      help();
      fail(`unknown command: ${commandName}`);
    }
  } finally {
    database.close();
    creationDeadline = undefined;
  }
}

if (process.argv[1] !== undefined && existsSync(process.argv[1])
  && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  for (const stream of [process.stdout, process.stderr]) {
    stream.on("error", (error) => {
      if (error.code === "EPIPE") process.exit(0);
      throw error;
    });
  }
  try {
    main();
  } catch (caught) {
    // Any census deadline that escapes as a raw CensusFailure is the same typed non-effect.
    const error = caught instanceof CensusFailure && /timed out|budget exhausted/.test(caught.message)
      ? Object.assign(new CliError(caught.message), {code: "inspection-timeout"}) : caught;
    if (process.argv.some(value => value === "--json" || value === "--json=true")) {
      if (error instanceof RegistrationMismatchError) {
        process.stdout.write(`${JSON.stringify({ ok: false, error: {
          code: error.code, field: error.field, requested: error.requested, recorded: error.recorded,
        } })}\n`);
      } else if (error.code === "inspection-timeout" || error.code?.startsWith("FROZEN_CUSTODY") || ["terminal-safety", "measure-capacity", "source-handoff", "writer-run", "freeze-source", "thaw-source", "execution-reserve", "execution-release", "execution-status", "reassign", "cache-safety", "retire-source-materialization", "materialization-process-snapshot", "retire-growth", "dispose-local-merges", "reduce-retained-headroom", "growth-status", "resume-growth", "reprice-capacity", "heartbeat"].includes(process.argv[2]) || error instanceof GrowthLifecycleError || error instanceof MaterializationError || error instanceof CacheRetirementError) {
        process.stdout.write(`${JSON.stringify({ ok: false, error: {
          code: error.code ?? (error instanceof ResourceBusyError ? "resource-busy" : error instanceof CliError ? "invalid-request" : "lifecycle-failed"),
          detail: error instanceof Error ? error.message : String(error),
          ...(error.nextAction === undefined ? {} : {nextAction:error.nextAction}),
        } })}\n`);
      }
    }
    process.stderr.write(`agent-workspace: ${error instanceof Error ? error.message : String(error)}\n${error instanceof ResourceBusyError && error.detail ? `agent-workspace: lock detail ${JSON.stringify(error.detail)}\n` : ""}`);
    process.exit(error instanceof ResourceBusyError ? 75 : (error instanceof CliError || error instanceof SourceHandoffError || error instanceof GrowthLifecycleError || error instanceof MaterializationError || error instanceof CacheRetirementError) ? 2 : 1);
  }
}
