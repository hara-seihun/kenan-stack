// Whole-host safety census for release/reconcile. Each census is complete or a
// typed failure; the parallel runner unions complete censuses and never returns
// a partial snapshot.
import { spawnSync } from "node:child_process";
import {
  accessSync, closeSync, constants, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync,
  readlinkSync, renameSync, statSync, writeFileSync,
} from "node:fs";
import { homedir, userInfo } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MessageChannel, Worker, isMainThread, receiveMessageOnPort, workerData } from "node:worker_threads";
import { GrowthLifecycleError, growthError } from "./growth-lifecycle.mjs";
import { coldIdentity } from "./cold-storage.mjs";

export class CensusFailure extends Error {}

let censusDeadline;
export function withCensusDeadline(deadline, action) {
  const previous = censusDeadline;
  censusDeadline = deadline;
  try { return action(); } finally { censusDeadline = previous; }
}

export function assertSafetyBudget(phase) {
  if (censusDeadline !== undefined && Date.now() >= censusDeadline)
    growthError("growth-observation-timeout", `${phase} observation budget exhausted; no safety verdict established`);
}

// SQLite read-only openers of an idle WAL database race on wal-index recovery and
// fail at once with SQLITE_BUSY_RECOVERY unless a busy handler waits. The wait is
// bounded by the census deadline.
const UNBOUNDED_BUSY_MS = 5_000;
export function busyBudgetMs() {
  return censusDeadline === undefined ? UNBOUNDED_BUSY_MS : Math.max(1, censusDeadline - Date.now());
}

export function run(executable, commandArgs, options = {}) {
  const remaining = (censusDeadline ?? Infinity) - Date.now();
  if (remaining <= 0) throw new CensusFailure("workspace inspection budget exhausted; no safety verdict was established");
  const result = spawnSync(executable, commandArgs, {
    cwd: homedir(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    maxBuffer: 64 * 1024 * 1024,
    timeout: Math.max(1, Math.min(options.timeout ?? 30_000, remaining)),
    ...(censusDeadline === undefined ? {} : { killSignal: "SIGKILL" }),
  });
  if (censusDeadline !== undefined && result.error?.code === "ETIMEDOUT")
    throw new CensusFailure(`workspace inspection timed out: ${executable} ${commandArgs.join(" ")}; no safety verdict was established`);
  return {
    status: result.status,
    stdout: typeof result.stdout === "string" ? result.stdout.trim() : "",
    stderr: typeof result.stderr === "string" ? result.stderr.trim() : "",
    error: result.error,
  };
}

export function processAncestry() {
  const ignored = new Set([process.pid, process.ppid]);
  let candidate = process.ppid;
  while (candidate > 1) {
    try {
      const status = readFileSync(`/proc/${candidate}/status`, "utf8");
      const match = status.match(/^PPid:\s+(\d+)/mu);
      if (match === null) break;
      candidate = Number(match[1]);
      if (ignored.has(candidate)) break;
      ignored.add(candidate);
    } catch {
      break;
    }
  }
  return ignored;
}

export function readLink(file) {
  try {
    return readlinkSync(file).replace(/ \(deleted\)$/u, "");
  } catch {
    return null;
  }
}

export function within(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

export function processSnapshot(strict = false, workspacePath = null, fdAccess = "write") {
  if (!["write", "all"].includes(fdAccess)) growthError("growth-writer-unknown", "unknown FD observation mode");
  if (!existsSync("/proc")) { if (strict) growthError("growth-writer-unknown", "/proc unavailable"); return []; }
  const ignored = processAncestry();
  const uid = process.getuid?.();
  if (uid === undefined) { if (strict) growthError("growth-writer-unknown", "process identity unavailable"); return []; }
  const processes = [];
  let entries;
  try { entries = readdirSync("/proc"); } catch (error) { if (strict) throw error; return []; }
  for (const entry of entries) {
    assertSafetyBudget("process references");
    if (!/^\d+$/u.test(entry)) continue;
    const pid = Number(entry);
    if (ignored.has(pid)) continue;
    const root = `/proc/${pid}`;
    try {
      const status = readFileSync(`${root}/status`, "utf8");
      const owner = Number(status.match(/^Uid:\s+(\d+)/mu)?.[1]);
      if (strict && !Number.isSafeInteger(owner)) growthError("growth-writer-unknown", `unknown process owner ${pid}`);
      if (owner !== uid && !strict) continue;
      const commandLine = readFileSync(`${root}/cmdline`, "utf8").split("\0").filter(Boolean);
      if (strict && readLink(`${root}/cwd`) === null && commandLine.length > 0) growthError("growth-writer-unknown", `unknown cwd for process ${pid}`);
      const writableFiles = [];
      const cwd = readLink(`${root}/cwd`), executable = readLink(`${root}/exe`);
      if (strict && commandLine.length > 0) {
        for (const fd of readdirSync(`${root}/fd`)) {
          let target;
          try { target = readlinkSync(`${root}/fd/${fd}`).replace(/ \(deleted\)$/u, ""); }
          catch (error) { if (error.code === "ENOENT") continue; throw error; }
          if (workspacePath && path.isAbsolute(target) && (Array.isArray(workspacePath) ? workspacePath : [workspacePath]).some(root => within(root, target))) {
            const flags = readFileSync(`${root}/fdinfo/${fd}`, "utf8").match(/^flags:\s+([0-7]+)$/mu)?.[1];
            if (flags === undefined) growthError("growth-writer-unknown", `unknown fd flags ${pid}/${fd}`);
            if (fdAccess === "all" || (parseInt(flags,8) & 3) !== 0) writableFiles.push(target);
          }
        }
      }
      processes.push({ writableFiles, pid, ppid: Number(status.match(/^PPid:\s+(\d+)/mu)?.[1] ?? 0), command: commandLine[0] ?? "unknown", commandLine, cwd, executable });
    } catch (error) {
      if (strict && (!["ENOENT", "ESRCH"].includes(error.code) || existsSync(root))) growthError("growth-writer-unknown", `cannot inspect process ${pid}: ${error.message}`);
      continue;
    }
  }
  return processes;
}

export function dockerEndpointScope(endpoint, {
  uid = process.getuid?.(),
  inspect = statSync,
  writable = (file) => accessSync(file, constants.W_OK),
} = {}) {
  if (!endpoint.startsWith("unix://")) return { inspect: true };
  const socketPath = endpoint.slice("unix://".length);
  if (!path.isAbsolute(socketPath)) return { error: "Docker Unix endpoint must have an absolute socket path" };
  let socket;
  try {
    socket = inspect(socketPath);
  } catch (error) {
    return { error: `Docker Unix socket metadata failed: ${error.code ?? "unknown"}` };
  }
  if (!socket.isSocket()) return { error: "Docker Unix endpoint is not a socket" };
  try {
    writable(socketPath);
  } catch (error) {
    // A foreign daemon without a connect grant cannot own this account's Docker work.
    // Failure at an owned or otherwise authorized endpoint remains an inspection failure.
    if (error.code === "EACCES" && uid !== undefined && uid !== 0 && socket.uid !== uid) {
      return { inspect: false, reason: "foreign-owned-socket-without-connect-grant" };
    }
    return { error: `Docker Unix socket access failed: ${error.code ?? "unknown"}` };
  }
  return { inspect: true };
}

// The recorded 63-container Docker inspect timed out as one request within the
// release census. Keep each request short so bounded subsets can complete under
// ordinary load, or the census can fail closed before its enclosing deadline.
const DOCKER_INSPECT_BATCH = 16;
const DOCKER_INSPECT_TIMEOUT_MS = 5_000;
const VANISHED_CONTAINER = /^(?:Error(?: response from daemon)?: )?No such (?:object|container): \S+$/iu;
export function dockerSnapshot(execute = run, { env = process.env, endpointScope = dockerEndpointScope } = {}) {
  const context = execute("docker", ["context", "inspect", ...(env.DOCKER_CONTEXT ? [env.DOCKER_CONTEXT] : []),
    "--format", "{{json .Endpoints.docker.Host}}"], { timeout: 10_000 });
  if (context.error?.code === "ENOENT") return { containers: [], available: false };
  if (context.status !== 0) return { containers: [], available: true, error: context.stderr || context.stdout || "docker context inspect failed" };
  let endpoint;
  try {
    endpoint = !env.DOCKER_CONTEXT && env.DOCKER_HOST ? env.DOCKER_HOST : JSON.parse(context.stdout);
    if (typeof endpoint !== "string" || endpoint.length === 0) throw new Error("missing endpoint");
  } catch {
    return { containers: [], available: true, error: "docker context inspect returned an invalid endpoint" };
  }
  const scope = endpointScope(endpoint);
  if (scope.error) return { containers: [], available: true, error: scope.error };
  if (!scope.inspect) return { containers: [], available: false, reason: scope.reason };
  const listed = execute("docker", ["ps", "--all", "--quiet", "--no-trunc"], { timeout: 10_000 });
  if (listed.error?.code === "ENOENT") return { containers: [], available: false };
  if (listed.status !== 0) return { containers: [], available: true, error: listed.stderr || listed.stdout || "docker ps failed" };
  const ids = listed.stdout.split(/\s+/u).filter(Boolean);
  const containers = [];
  for (let offset = 0; offset < ids.length; offset += DOCKER_INSPECT_BATCH) {
    const batch = ids.slice(offset, offset + DOCKER_INSPECT_BATCH);
    const inspected = execute("docker", ["inspect", ...batch], { timeout: DOCKER_INSPECT_TIMEOUT_MS });
    // A timed-out or signalled process has no complete inspection result, even if
    // its stderr happens to mention a container that vanished after `ps`.
    if (inspected.error || inspected.signal)
      return { containers: [], available: true, error: inspected.stderr || inspected.stdout || "docker inspect failed" };
    if (inspected.status !== 0) {
      // A container removed after `ps` is absent, not unknown; every other diagnostic refuses.
      const diagnostics = (inspected.stderr ?? "").split("\n").map(line => line.trim()).filter(Boolean);
      if (diagnostics.length === 0 || !diagnostics.every(line => VANISHED_CONTAINER.test(line)))
        return { containers: [], available: true, error: inspected.stderr || inspected.stdout || "docker inspect failed" };
    }
    if ((inspected.stdout ?? "").trim() === "" && inspected.status !== 0) continue;
    try {
      const parsed = JSON.parse(inspected.stdout);
      if (!Array.isArray(parsed)) return { containers: [], available: true, error: "docker inspect returned invalid JSON" };
      containers.push(...parsed);
    } catch {
      return { containers: [], available: true, error: "docker inspect returned invalid JSON" };
    }
  }
  return { containers, available: true };
}

// A finished RemainAfterExit unit stays "active (exited)" until someone stops it. With no process, no control group,
// nothing that runs when it is stopped and nothing that starts it again, it can no longer touch any path, so it is not a
// reference (2026-10-24 converge-kenan: seven such wrappers kept completed workspaces referenced, so a 4 GiB admission
// was refused). Each property must be present and exactly inert; anything else keeps the unit a reference.
export function inertCompletedUnit(properties) {
  return properties.get("ActiveState") === "active" && properties.get("SubState") === "exited"
    && properties.get("MainPID") === "0" && properties.get("ControlPID") === "0" && properties.get("ControlGroup") === ""
    && emptyExecList(properties, "ExecStop") && emptyExecList(properties, "ExecStopPost") && properties.get("TriggeredBy") === "";
}
// systemctl show omits an exec property that has no commands, even when it is requested by name (observed on
// converge-kenan, October 29: finished converge-heavy wrappers printed no ExecStop line, so they stayed references
// forever). A manager that prints the requested ControlGroup and TriggeredBy is new enough that absence means empty.
function emptyExecList(properties, name) {
  return properties.has(name) ? properties.get(name) === "" : properties.has("ControlGroup") && properties.has("TriggeredBy");
}

export function parseSystemdUnits(output, manager) {
  return output.split(/\n\s*\n/u).flatMap((block) => {
    const properties = new Map(block.split("\n").flatMap((line) => {
      const separator = line.indexOf("=");
      return separator === -1 ? [] : [[line.slice(0, separator), line.slice(separator + 1)]];
    }));
    const id = properties.get("Id");
    const activeState = properties.get("ActiveState");
    if (id === undefined || activeState === undefined || !["active", "activating", "reloading", "deactivating"].includes(activeState)) return [];
    if (inertCompletedUnit(properties)) return [];
    const rawWorkingDirectory = properties.get("WorkingDirectory") ?? "";
    return [{
      id,
      manager,
      activeState,
      workingDirectory: rawWorkingDirectory.replace(/^[!+~-]+/u, "") || null,
      execStart: properties.get("ExecStart") ?? "",
      mainPid: Number(properties.get("MainPID") ?? 0),
    }];
  });
}

// The systemd census reads properties only for services. A scope has no ExecStart or WorkingDirectory (its processes
// were started outside systemd and are covered by the process census), so showing scopes, often the bulk of transient
// units, costs a manager round trip per unit and can never produce a reference. Services are shown in bounded batches.
// A slow or stalled manager leaves the census incomplete: a typed "census-incomplete" result that the caller classifies
// as blocked and keeps custody, rather than the whole release failing hard.
const SYSTEMD_LIST_TIMEOUT_MS = 120_000;
const SYSTEMD_SHOW_BASE_MS = 20_000;
const SYSTEMD_SHOW_PER_UNIT_MS = 50;
export const SYSTEMD_SHOW_BATCH = 512;
export const systemdShowTimeoutMs = (unitCount) => SYSTEMD_SHOW_BASE_MS + SYSTEMD_SHOW_PER_UNIT_MS * unitCount;
const SHOWN_PROPERTIES = ["Id", "ActiveState", "WorkingDirectory", "ExecStart", "MainPID", "SubState", "ControlPID",
  "ControlGroup", "ExecStop", "ExecStopPost", "TriggeredBy"].map((property) => `--property=${property}`);

export function systemdManagerSnapshot(manager, execute = run) {
  try { return systemdManagerObservation(manager, execute); }
  catch (error) {
    if (error instanceof CensusFailure) return { units: [], available: true, error: `census-incomplete: ${error.message}` };
    throw error;
  }
}

function systemdManagerObservation(manager, execute) {
  const managerArgs = manager === "user" ? ["--user"] : [];
  const listed = execute("systemctl", [
    ...managerArgs, "list-units", "--all", "--state=active,activating,reloading,deactivating",
    "--type=service", "--type=scope", "--output=json", "--no-pager",
  ], { timeout: SYSTEMD_LIST_TIMEOUT_MS });
  if (listed.error?.code === "ENOENT" || /not been booted with systemd|failed to connect to (?:user scope )?bus|(?:DBUS_SESSION_BUS_ADDRESS|XDG_RUNTIME_DIR) not defined/iu.test(listed.stderr)) {
    return { units: [], available: false };
  }
  if (listed.status !== 0) return { units: [], available: true, error: listed.stderr || listed.stdout || "systemctl list-units failed" };
  let rows;
  try {
    rows = JSON.parse(listed.stdout);
  } catch {
    return { units: [], available: true, error: "systemctl list-units returned invalid JSON" };
  }
  if (!Array.isArray(rows) || rows.some((row) =>
    row === null || typeof row !== "object" || typeof row.unit !== "string" ||
    !/^[a-zA-Z0-9:_.@\\\\-]+\.(?:service|scope)$/u.test(row.unit))) {
    return { units: [], available: true, error: "systemctl list-units returned invalid unit records" };
  }
  const unitIds = rows.map((row) => row.unit);
  if (new Set(unitIds).size !== unitIds.length) {
    return { units: [], available: true, error: "systemctl list-units returned duplicate unit records" };
  }
  const services = unitIds.filter((unit) => unit.endsWith(".service"));
  const units = [];
  for (let start = 0; start < services.length; start += SYSTEMD_SHOW_BATCH) {
    const batch = services.slice(start, start + SYSTEMD_SHOW_BATCH);
    const shown = execute("systemctl", [...managerArgs, "show", ...SHOWN_PROPERTIES, "--", ...batch],
      { timeout: systemdShowTimeoutMs(batch.length) });
    if (shown.status !== 0) return { units: [], available: true, error: shown.stderr || shown.stdout || "systemctl show failed" };
    units.push(...parseSystemdUnits(shown.stdout, manager));
  }
  return { units, available: true };
}

export function unionSystemd(user, system) {
  const errors = [user.error, system.error].filter(Boolean);
  return {
    units: [...user.units, ...system.units],
    available: user.available || system.available,
    ...(errors.length > 0 ? { error: errors.join("; ") } : {}),
  };
}

export function systemdSnapshot() {
  return unionSystemd(systemdManagerSnapshot("user"), systemdManagerSnapshot("system"));
}

// Installed artifacts under /opt and /srv that name a checkout path (a bundle whose __dirname
// points into an agent clone's node_modules). 2026-10-19: the Slack sender installed at
// /opt/converge-slack-sender/8fe1fe50 from limmy-independent-83fd broke when that checkout was
// released a minute later. Depth-bounded, node_modules/.git skipped; same scan as /usr/local/bin/liveuse.
export const INSTALL_ROOTS = ["/opt", "/srv", "/etc/systemd"];
const INSTALLED_FILE_LIMIT = 32 << 20;
const BINARY_PROBE_BYTES = 8192;
const HOME_PREFIX = Buffer.from("/home/");
const USER_BYTE = new Uint8Array(256), PATH_BYTE = new Uint8Array(256);
for (const byte of Buffer.from("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._@+-")) { USER_BYTE[byte] = 1; PATH_BYTE[byte] = 1; }
PATH_BYTE[0x2f] = 1;

// Exactly the matches of /\/home\/[A-Za-z0-9._@+-]+\/[A-Za-z0-9._\/@+-]+/g over the latin1 text,
// located with a native substring search instead of decoding and regex-scanning every byte.
export function homePathMatches(data) {
  const found = [];
  let from = 0;
  for (;;) {
    const start = data.indexOf(HOME_PREFIX, from);
    if (start === -1) return found;
    let cursor = start + HOME_PREFIX.length;
    const userStart = cursor;
    while (cursor < data.length && USER_BYTE[data[cursor]] === 1) cursor += 1;
    if (cursor === userStart || data[cursor] !== 0x2f) { from = start + 1; continue; }
    cursor += 1;
    const tailStart = cursor;
    while (cursor < data.length && PATH_BYTE[data[cursor]] === 1) cursor += 1;
    if (cursor === tailStart) { from = start + 1; continue; }
    found.push(data.toString("latin1", start, cursor));
    from = cursor;
  }
}

// Racy-entry rule (as Git's index): an observation is reusable only when the file's
// change time precedes the read by more than any timestamp granularity, so a later
// same-tick write cannot hide behind an identical stat.
const RACY_WINDOW_NS = 2_000_000_000n;
const INSTALLED_CACHE_VERSION = 1;
const statIdentity = (stat) => `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;

function observeInstalledFile(candidate, stat) {
  const descriptor = openSync(candidate, "r");
  try {
    const head = Buffer.allocUnsafe(Math.min(BINARY_PROBE_BYTES, Number(stat.size)));
    const headBytes = readSync(descriptor, head, 0, head.length, 0);
    if (head.subarray(0, headBytes).includes(0)) return { binary: true, after: fstatSync(descriptor, { bigint: true }) };
    const size = Math.max(Number(stat.size), headBytes);
    const data = Buffer.allocUnsafe(size);
    head.copy(data, 0, 0, headBytes);
    let length = headBytes;
    while (length < data.length) {
      const read = readSync(descriptor, data, length, data.length - length, length);
      if (read === 0) break;
      length += read;
    }
    return { binary: false, paths: homePathMatches(data.subarray(0, length)), after: fstatSync(descriptor, { bigint: true }) };
  } finally {
    closeSync(descriptor);
  }
}

export function installedReferenceSnapshot(roots = INSTALL_ROOTS, { cacheFile, racyWindowNs = RACY_WINDOW_NS } = {}) {
  const references = [];
  const previous = readJsonCache(cacheFile, INSTALLED_CACHE_VERSION);
  const next = new Map();
  const reusableBefore = BigInt(Date.now()) * 1_000_000n - racyWindowNs;
  const walk = (directory, depth) => {
    assertSafetyBudget("installed references");
    let entries;
    try { entries = readdirSync(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      assertSafetyBudget("installed references");
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (depth < 3 && entry.name !== "node_modules" && entry.name !== ".git") walk(candidate, depth + 1);
      } else if (entry.isFile()) {
        let stat;
        try { stat = statSync(candidate, { bigint: true }); } catch { continue; }
        if (stat.size > INSTALLED_FILE_LIMIT) continue;
        const identity = statIdentity(stat);
        const known = previous.get(candidate);
        let paths;
        if (known !== undefined && known[0] === identity) {
          paths = known[1];
        } else {
          let observed;
          try { observed = observeInstalledFile(candidate, stat); } catch { continue; }
          paths = observed.binary ? null : observed.paths;
          if (statIdentity(observed.after) === identity && stat.ctimeNs < reusableBefore) next.set(candidate, [identity, paths]);
          if (paths === null) continue;
          for (const match of paths) references.push({ file: candidate, path: match });
          continue;
        }
        next.set(candidate, known);
        if (paths === null) continue;
        for (const match of paths) references.push({ file: candidate, path: match });
      }
    }
  };
  for (const root of roots) walk(root, 0);
  if (cacheFile !== undefined) writeJsonCache(cacheFile, INSTALLED_CACHE_VERSION, next);
  return references;
}

// A linked worktree whose repository was deleted has no object store.
function orphanedWorktree(workspacePath) {
  const pointer = /^gitdir: (.+)$/m.exec(readFileSync(path.join(workspacePath, ".git"), "utf8"));
  return pointer !== null && !existsSync(path.resolve(workspacePath, pointer[1].trim()));
}

// Git's own resolution of a linked worktree's common directory: `.git` is a
// `gitdir:` file, and that admin directory's `commondir` (if present) names the
// common directory relative to it. Other layouts are resolved by Git itself.
function linkedCommonDirectory(workspacePath) {
  let pointer;
  try { pointer = readFileSync(path.join(workspacePath, ".git"), "utf8"); }
  catch (error) { if (["ENOENT", "EISDIR"].includes(error.code)) return { kind: "git" }; throw error; }
  const match = /^gitdir: (.+)$/mu.exec(pointer);
  if (match === null) return { kind: "git" };
  const adminDirectory = path.resolve(workspacePath, match[1].trim());
  if (!existsSync(adminDirectory)) return { kind: "orphaned" };
  let common;
  try { common = readFileSync(path.join(adminDirectory, "commondir"), "utf8").trim(); }
  catch (error) { if (error.code === "ENOENT") return { kind: "resolved", directory: adminDirectory }; throw error; }
  if (common === "") return { kind: "git" };
  return { kind: "resolved", directory: path.resolve(adminDirectory, common) };
}

// A checkout moved to the Storage Box can't change, so its dependencies are read through the
// SMB mount once and reused while its symlink stays the same (cacheFile beside the registry).
export function gitDependencyCensus(rows, execute = run, { cacheFile } = {}) {
  const alternates = [];
  const linkedWorktrees = [];
  let cache = {};
  if (cacheFile) try { cache = JSON.parse(readFileSync(cacheFile, "utf8")); } catch {}
  const nextCache = {};
  for (const record of rows) {
    const cold = coldIdentity(record.path);
    const cached = cold === null ? undefined : cache[record.path];
    const found = cached?.identity === cold && cached.recordId === record.id ? cached
      : recordGitDependencies(record, execute) ?? { alternates: [], linkedWorktrees: [] };
    alternates.push(...found.alternates);
    linkedWorktrees.push(...found.linkedWorktrees);
    if (cold !== null) nextCache[record.path] = { ...found, identity: cold, recordId: record.id };
  }
  if (cacheFile && JSON.stringify(nextCache) !== JSON.stringify(cache)) {
    const temporary = `${cacheFile}.${process.pid}`;
    writeFileSync(temporary, JSON.stringify(nextCache), { mode: 0o600 });
    renameSync(temporary, cacheFile);
  }
  return { alternates, linkedWorktrees };
}

function recordGitDependencies(record, execute) {
  const alternates = [];
  const linkedWorktrees = [];
  assertSafetyBudget("dependency");
  if (!existsSync(record.path)) return null;
  let commonDirectory = path.join(record.path, ".git");
  if (record.checkoutType === "worktree") {
    const linked = linkedCommonDirectory(record.path);
    if (linked.kind === "orphaned") return null;
    if (linked.kind === "resolved") commonDirectory = linked.directory;
    else {
      const common = execute("git", ["-C", record.path, "rev-parse", "--git-common-dir"]);
      if (common.status !== 0 && existsSync(path.join(record.path, ".git")) && orphanedWorktree(record.path)) return null;
      if (common.status !== 0) throw new CensusFailure(`cannot inspect linked worktree ${record.path}: ${common.stderr || common.error?.message || `exit ${common.status}`}`);
      commonDirectory = path.resolve(record.path, common.stdout);
    }
    linkedWorktrees.push({ recordId: record.id, workspacePath: record.path, commonDirectory });
  }
  const objectDirectory = path.join(commonDirectory, "objects");
  const alternatesPath = path.join(objectDirectory, "info", "alternates");
  let contents;
  try { contents = readFileSync(alternatesPath, "utf8"); }
  catch (error) { if (error.code === "ENOENT" || error.code === "ENOTDIR") return { alternates, linkedWorktrees }; throw error; }
  for (const alternate of contents.split("\n").filter(Boolean)) {
    alternates.push({ recordId: record.id, workspacePath: record.path, objectDirectory: path.resolve(objectDirectory, alternate) });
  }
  return { alternates, linkedWorktrees };
}

function optionalOwnerPath(candidate) {
  try { statSync(candidate); return true; }
  catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

export function ownerThreadDatabases() {
  const databases = new Set();
  const fleetDir = path.dirname(process.env.PI_ORCHESTRATOR_LEDGER ??
    path.join(homedir(), ".local", "share", "pi-orchestrator", "ledger.sqlite3"));
  databases.add(path.join(fleetDir, "threads.sqlite3"));
  const applications = path.join(fleetDir, "applications");
  if (optionalOwnerPath(applications)) {
    for (const entry of readdirSync(applications, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.isSymbolicLink()) databases.add(path.join(applications, entry.name, "threads.sqlite3"));
    }
  }
  const owner = userInfo().username;
  const person = path.join("/var/lib/pi-remote/persons", `${owner}.json`);
  let remoteData = process.env.PI_REMOTE_DATA;
  if (!remoteData && optionalOwnerPath(person)) {
    const registration = JSON.parse(readFileSync(person, "utf8"));
    if (registration.user === owner) remoteData = registration.environment?.PI_REMOTE_DATA;
  }
  remoteData ??= path.join(process.env.XDG_STATE_HOME ?? path.join(homedir(), ".local", "state"), "pi-remote");
  databases.add(path.join(remoteData, "threads.sqlite3"));
  if (process.env.PI_THREAD_DATABASE) databases.add(process.env.PI_THREAD_DATABASE);
  return [...databases];
}

const THREAD_CACHE_VERSION = 3;

// Every committed SQLite change reaches the database, its WAL or its rollback
// journal through write(2), so identical stats of all three (outside the racy
// window) prove the query would read identical pages.
function sqliteFileIdentity(databasePath) {
  const parts = [];
  let newestChange = null;
  for (const file of [databasePath, `${databasePath}-wal`, `${databasePath}-journal`]) {
    let stat;
    try { stat = statSync(file, { bigint: true }); }
    catch (error) { if (error.code === "ENOENT") { parts.push("absent"); continue; } throw error; }
    parts.push(statIdentity(stat));
    if (newestChange === null || stat.ctimeNs > newestChange) newestChange = stat.ctimeNs;
  }
  return { key: `${THREAD_CACHE_VERSION}|${parts.join("|")}`, newestChange };
}

function readJsonCache(cacheFile, version) {
  if (cacheFile === undefined) return new Map();
  let parsed;
  try { parsed = JSON.parse(readFileSync(cacheFile, "utf8")); }
  catch (error) { if (error.code === "ENOENT" || error instanceof SyntaxError) return new Map(); throw error; }
  if (parsed?.version !== version || parsed.entries === null || typeof parsed.entries !== "object") return new Map();
  return new Map(Object.entries(parsed.entries));
}

function writeJsonCache(cacheFile, version, entries) {
  mkdirSync(path.dirname(cacheFile), { recursive: true, mode: 0o700 });
  const temporary = `${cacheFile}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  writeFileSync(temporary, JSON.stringify({ version, entries: Object.fromEntries(entries) }), { mode: 0o600 });
  renameSync(temporary, cacheFile);
}

// Cursor checkpoints are bound to the complete SQLite file/WAL/journal identity.
// A paused census never returns a verdict. Completed databases and partial table
// scans survive deadlines, while a changed database invalidates all its progress.
export function threadSnapshot(paths = ownerThreadDatabases(), { cacheFile, racyWindowNs = RACY_WINDOW_NS, batchSize = 256, onCheckpoint } = {}) {
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 4096) throw new CensusFailure("invalid thread census batch size");
  const references = [];
  const entries = readJsonCache(cacheFile, THREAD_CACHE_VERSION);
  for (const databasePath of paths) {
    assertSafetyBudget("thread references");
    if (!optionalOwnerPath(databasePath)) { entries.delete(databasePath); continue; }
    let before = sqliteFileIdentity(databasePath);
    const reusableBefore = BigInt(Date.now()) * 1_000_000n - racyWindowNs;
    let reusable = before.newestChange !== null && before.newestChange < reusableBefore;
    let progress = entries.get(databasePath);
    if (!reusable || progress?.key !== before.key) progress = {key: before.key, phase: 0, cursor: 0, ids: [], rows: []};
    const checkpoint = () => {
      if (sqliteFileIdentity(databasePath).key !== before.key) {
        entries.delete(databasePath);
        if (cacheFile !== undefined) writeJsonCache(cacheFile, THREAD_CACHE_VERSION, entries);
        throw new CensusFailure("thread database changed during observation; no safety verdict established");
      }
      if (reusable && cacheFile !== undefined) {
        entries.set(databasePath, progress);
        writeJsonCache(cacheFile, THREAD_CACHE_VERSION, entries);
      }
      onCheckpoint?.({databasePath, phase: progress.phase, cursor: progress.cursor});
      assertSafetyBudget("thread references");
    };
    if (progress.phase !== 4) {
      const database = new DatabaseSync(databasePath, { readOnly: true, timeout: busyBudgetMs() });
      try {
        // Pin a consistent read snapshot before recording the baseline. SQLite
        // may recover/create an empty WAL when the first reader opens it.
        database.exec("BEGIN");
        database.prepare("SELECT rootpage FROM sqlite_master LIMIT 1").get();
        const opened = sqliteFileIdentity(databasePath);
        if (opened.key !== before.key) {
          before = opened;
          reusable = before.newestChange !== null && before.newestChange < reusableBefore;
          progress = {key: before.key, phase: 0, cursor: 0, ids: [], rows: []};
        }
        const ids = new Set(progress.ids);
        const queries = [
          "SELECT rowid AS cursor, CASE WHEN state='running' OR json_extract(metadata,'$.agentWait') IS NOT NULL OR json_extract(metadata,'$.cancellationRequest') IS NOT NULL THEN id END AS id FROM thread WHERE rowid>? ORDER BY rowid LIMIT ?",
          "SELECT DISTINCT thread_id AS cursor, thread_id AS id FROM thread_work WHERE status!='done' AND thread_id>? ORDER BY thread_id LIMIT ?",
          "SELECT DISTINCT thread_id AS cursor, thread_id AS id FROM thread_execution WHERE ended_at IS NULL AND thread_id>? ORDER BY thread_id LIMIT ?",
        ];
        while (progress.phase < 3) {
          assertSafetyBudget("thread references");
          const batch = database.prepare(queries[progress.phase]).all(progress.cursor, batchSize);
          for (const row of batch) if (row.id !== null) ids.add(row.id);
          progress.ids = [...ids];
          if (batch.length) progress.cursor = batch.at(-1).cursor;
          else { progress.phase++; progress.cursor = progress.phase < 3 ? "" : 0; }
          checkpoint();
        }
        const lookup = database.prepare("SELECT id,cwd FROM thread WHERE id=?");
        while (progress.cursor < progress.ids.length) {
          assertSafetyBudget("thread references");
          const end = Math.min(progress.cursor + batchSize, progress.ids.length);
          while (progress.cursor < end) {
            const row = lookup.get(progress.ids[progress.cursor++]);
            if (row) progress.rows.push([row.id, row.cwd]);
          }
          checkpoint();
        }
        progress.phase = 4;
        progress.ids = [];
        checkpoint();
      } finally { database.close(); }
    }
    for (const [id, cwd] of progress.rows) references.push({id, cwd, database: databasePath});
  }
  if (cacheFile !== undefined) writeJsonCache(cacheFile, THREAD_CACHE_VERSION, entries);
  return references;
}

const CENSUSES = {
  process: () => processSnapshot(),
  docker: () => dockerSnapshot(),
  systemdUser: () => systemdManagerSnapshot("user"),
  systemdSystem: () => systemdManagerSnapshot("system"),
  threads: ({ paths, cacheFile }) => threadSnapshot(paths, { cacheFile }),
  gitDependencies: ({ rows, cacheFile }) => gitDependencyCensus(rows, run, { cacheFile }),
  installed: ({ roots, cacheFile }) => installedReferenceSnapshot(roots, { cacheFile }),
};

function serializeFailure(error) {
  if (error instanceof GrowthLifecycleError) return { kind: "growth", code: error.code, message: error.message };
  if (error instanceof CensusFailure) return { kind: "census", message: error.message };
  return { kind: "defect", message: error instanceof Error ? error.message : String(error), stack: error?.stack };
}

export function reviveFailure(failure, name) {
  if (failure.kind === "growth") return new GrowthLifecycleError(failure.code, failure.message);
  if (failure.kind === "census") return new CensusFailure(failure.message);
  return Object.assign(new Error(`${name} census failed: ${failure.message}`), { stack: failure.stack });
}

// Runs every census on its own thread and unions their results. The caller is
// synchronous, so it blocks on a shared counter that each census increments
// exactly once after posting its outcome. Any failure or the deadline refuses
// the whole snapshot.
const UNDEADLINED_CENSUS_MS = 120_000;
export function runCensuses(tasks, deadline) {
  const names = Object.keys(tasks);
  const settled = new Int32Array(new SharedArrayBuffer(4));
  const started = names.map((name) => {
    const { port1, port2 } = new MessageChannel();
    const worker = new Worker(new URL(import.meta.url), {
      workerData: { safetyCensus: { name, input: tasks[name], deadline, port: port2, settled } },
      transferList: [port2],
    });
    worker.unref();
    return { name, worker, port: port1 };
  });
  const bound = deadline ?? Date.now() + UNDEADLINED_CENSUS_MS;
  const outcomes = new Map();
  try {
    for (;;) {
      const count = Atomics.load(settled, 0);
      for (const { name, port } of started) {
        if (outcomes.has(name)) continue;
        const received = receiveMessageOnPort(port);
        if (received !== undefined) outcomes.set(name, received.message);
      }
      if (outcomes.size === names.length) break;
      const remaining = bound - Date.now();
      if (remaining <= 0) {
        const unfinished = names.filter(name => !outcomes.has(name));
        growthError("growth-observation-timeout", `safety census observation budget exhausted (unfinished: ${unfinished.join(", ")}); no safety verdict established`);
      }
      if (count === names.length) continue;
      Atomics.wait(settled, 0, count, remaining);
    }
    if (process.env.AGENT_WORKSPACE_CENSUS_TIMINGS === "1")
      process.stderr.write(`${JSON.stringify({ census: Object.fromEntries(names.map(name => [name, outcomes.get(name).ms])) })}\n`);
    const results = {};
    for (const name of names) {
      const outcome = outcomes.get(name);
      if (!outcome.ok) throw reviveFailure(outcome.failure, name);
      results[name] = outcome.value;
    }
    return results;
  } finally {
    for (const { worker, port } of started) { port.close(); void worker.terminate(); }
  }
}

if (!isMainThread && workerData?.safetyCensus !== undefined) {
  const { name, input, deadline, port, settled } = workerData.safetyCensus;
  let outcome;
  const started = performance.now();
  try {
    outcome = { ok: true, value: withCensusDeadline(deadline, () => CENSUSES[name](input)) };
  } catch (error) {
    outcome = { ok: false, failure: serializeFailure(error) };
  }
  outcome.ms = Math.round(performance.now() - started);
  try { port.postMessage(outcome); }
  catch (error) { port.postMessage({ ok: false, failure: serializeFailure(error) }); }
  finally {
    Atomics.add(settled, 0, 1);
    Atomics.notify(settled, 0);
  }
}
