// Shared mirrors outlive the checkouts that used them. On 2026-10-30 three mirrors
// of research repositories (49-73 GB each) filled the root disk to 97%: two had a
// source that no longer existed. A mirror is retired when nothing can still need it:
// no existing checkout borrows its objects (alternates) or is one of its linked
// worktrees, no unreleased workspace names one of its sources, and either every
// source it fetches from is a local path that is gone or it has been idle for
// `unusedDays`. A later create for the same source simply builds a new mirror.
// Two mirrors of one origin are never both kept once the extra one has sat idle for a
// day (on 2026-11-01 duplicates of halo-5090 and programme 12 held 9 GiB of root).
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import path from "node:path";
import { underColdStorage } from "./cold-storage.mjs";

const { GIT_DIR, GIT_OBJECT_DIRECTORY, GIT_WORK_TREE, ...inherited } = process.env;
const gitEnvironment = { ...inherited, GIT_ALTERNATE_OBJECT_DIRECTORIES: "" };
const real = file => { try { return realpathSync(file); } catch { return null; } };
const missing = error => error?.code === "ENOENT" || error?.code === "ENOTDIR";

export function mirrorSources(mirror) {
  const listed = spawnSync("git", ["--git-dir", mirror, "config", "--local", "--get-regexp", "^remote\\..*\\.url$"], { encoding: "utf8", env: gitEnvironment });
  if (listed.status !== 0) return [];
  return [...new Set(listed.stdout.split("\n").filter(Boolean).map(line => line.slice(line.indexOf(" ") + 1)))];
}

// The object directories a checkout or repository reads through alternates.
function alternatesOf(gitDirectory) {
  try {
    return readFileSync(path.join(gitDirectory, "objects", "info", "alternates"), "utf8").split("\n")
      .map(line => line.trim()).filter(line => line && !line.startsWith("#"))
      .map(line => path.isAbsolute(line) ? line : path.resolve(gitDirectory, "objects", line));
  } catch (error) { if (missing(error) || error.code === "EACCES") return []; throw error; }
}

function gitDirectoryOf(checkout) {
  const dotGit = path.join(checkout, ".git");
  try {
    const s = statSync(dotGit);
    if (s.isDirectory()) return dotGit;
    const pointer = /^gitdir:\s*(.+)$/mu.exec(readFileSync(dotGit, "utf8"))?.[1]?.trim();
    if (!pointer) return null;
    const linked = path.resolve(checkout, pointer);
    // A linked worktree keeps its objects in the common directory.
    const common = existsSync(path.join(linked, "commondir")) ? path.resolve(linked, readFileSync(path.join(linked, "commondir"), "utf8").trim()) : linked;
    return common;
  } catch (error) {
    // A folder this user cannot enter is not one of its checkouts (mirrors are this user's alone).
    if (error.code === "EACCES") return null;
    if (!missing(error)) throw error;
    return existsSync(path.join(checkout, "objects")) ? checkout : null; // bare repository
  }
}

// Real paths of every object directory borrowed by the given checkouts.
export function borrowedObjectDirectories(checkouts) {
  const borrowed = new Set();
  for (const checkout of new Set(checkouts)) {
    const gitDirectory = gitDirectoryOf(checkout);
    if (gitDirectory === null) continue;
    for (const objects of [path.join(gitDirectory, "objects"), ...alternatesOf(gitDirectory)]) {
      const resolved = real(objects);
      if (resolved) borrowed.add(resolved);
    }
  }
  return borrowed;
}

// Checkout folders under the given roots, `depth` levels down. Symlinks are skipped:
// folders kenan-cold moved to the Storage Box are read from its owner lists instead,
// which is much faster than stat over SMB.
export function checkoutsUnder(roots, depth = 1) {
  const found = [];
  const walk = (directory, level) => {
    let names;
    try { names = readdirSync(directory); } catch (error) { if (missing(error) || error.code === "EACCES") return; throw error; }
    for (const name of names) {
      const child = path.join(directory, name);
      let isDirectory = false;
      try { isDirectory = lstatSync(child).isDirectory(); } catch { continue; }
      if (!isDirectory) continue;
      if (level === depth) found.push(child); else walk(child, level + 1);
    }
  };
  for (const root of roots) walk(root, 1);
  return found;
}

// kenan-cold keeps, for every folder it moved to the Storage Box, a gzip list of
// NUL-separated "uid gid mode relative-path" entries named after the folder's path
// with / written as %. Moved checkouts still borrow objects through their
// alternates, so their alternates files are read too. Lists never change while a
// folder stays moved, so what was read is cached by list name and mtime. Returns
// the alternates targets, or null when the lists cannot be read (then nothing is
// retired).
export function coldBorrowedObjectDirectories(ownersDirectory, cacheFile) {
  const readable = (file, args) => {
    try { return { ok: true, value: readFileSync(file) }; }
    catch (error) {
      if (missing(error)) return { ok: true, value: null };
      if (error.code !== "EACCES") throw error;
      const elevated = spawnSync("sudo", ["-n", ...args], { maxBuffer: 1 << 30 });
      return elevated.status === 0 ? { ok: true, value: elevated.stdout } : { ok: false };
    }
  };
  let listing;
  try { listing = readdirSync(ownersDirectory).filter(name => name.endsWith(".gz")).map(name => [name, statSync(path.join(ownersDirectory, name)).mtimeMs]); }
  catch (error) {
    if (missing(error)) return new Set();
    if (error.code !== "EACCES") throw error;
    const listed = spawnSync("sudo", ["-n", "find", ownersDirectory, "-maxdepth", "1", "-name", "*.gz", "-printf", "%f\t%T@\n"], { encoding: "utf8", maxBuffer: 1 << 26 });
    if (listed.status !== 0) return null;
    listing = listed.stdout.split("\n").filter(Boolean).map(line => { const [name, seconds] = line.split("\t"); return [name, Number(seconds) * 1000]; });
  }
  let cache = {};
  try { cache = JSON.parse(readFileSync(cacheFile, "utf8")); } catch { cache = {}; }
  const next = {};
  for (const [name, mtimeMs] of listing) {
    const known = cache[name];
    if (known && known.mtimeMs === mtimeMs) { next[name] = known; continue; }
    const file = path.join(ownersDirectory, name);
    const compressed = readable(file, ["cat", file]);
    if (!compressed.ok) return null;
    if (compressed.value === null) continue;
    const folder = "/" + name.slice(0, -3).replaceAll("%", "/");
    const targets = [];
    for (const entry of gunzipSync(compressed.value).toString("utf8").split("\0")) {
      const relative = entry.split(" ").slice(3).join(" ");
      if (!relative.endsWith("objects/info/alternates")) continue;
      const alternates = path.join(folder, relative);
      const content = readable(alternates, ["cat", alternates]);
      if (!content.ok) return null;
      if (content.value === null) continue;
      for (const line of content.value.toString("utf8").split("\n").map(value => value.trim()).filter(value => value && !value.startsWith("#"))) {
        targets.push(path.isAbsolute(line) ? line : path.resolve(path.dirname(path.dirname(alternates)), line));
      }
    }
    next[name] = { mtimeMs, targets };
  }
  try { writeFileSync(cacheFile, JSON.stringify(next)); } catch { /* the cache only saves time */ }
  const borrowed = new Set();
  for (const { targets } of Object.values(next)) for (const target of targets) borrowed.add(real(target) ?? path.resolve(target));
  return borrowed;
}

// True when the mirror's sources are local repositories that no longer hold any
// commit the mirror keeps custody of: the source rewrote its history (for example
// moving large files to LFS), and every object the mirror holds for old checkouts
// is dead weight once nothing borrows it.
export function sourcesRewritten(mirror, sources) {
  // A source moved to the box is read-only (it can't have been rewritten since) and is never read.
  if (sources.some(underColdStorage)) return false;
  const local = sources.filter(url => path.isAbsolute(url) && existsSync(url));
  if (local.length === 0 || local.length !== sources.length) return false;
  const refs = spawnSync("git", ["--git-dir", mirror, "for-each-ref", "--format=%(objectname)", "refs/pi-workspace/"], { encoding: "utf8", env: gitEnvironment, maxBuffer: 1 << 26 });
  if (refs.status !== 0) return false;
  const commits = [...new Set(refs.stdout.split("\n").filter(Boolean))];
  if (commits.length === 0) return false;
  for (const source of local) {
    const checked = spawnSync("git", ["-C", source, "cat-file", "--batch-check=%(objecttype)"], { input: commits.join("\n") + "\n", encoding: "utf8", env: gitEnvironment, maxBuffer: 1 << 26 });
    if (checked.status !== 0) return false;
    if (checked.stdout.split("\n").some(line => line === "commit")) return false;
  }
  return true;
}

function liveWorktrees(mirror) {
  const directory = path.join(mirror, "worktrees");
  let names;
  try { names = readdirSync(directory); } catch (error) { if (missing(error)) return []; throw error; }
  return names.map(name => {
    try { return readFileSync(path.join(directory, name, "gitdir"), "utf8").trim(); } catch { return null; }
  }).filter(gitdir => gitdir && existsSync(gitdir));
}

const USE_STAMP = "pi-workspace-last-use";

// create stamps the mirror it reads from, since a create whose commit the mirror already
// holds writes nothing else there. A mirror that doesn't exist yet needs no stamp.
export function markMirrorUse(mirror) {
  try { writeFileSync(path.join(mirror, USE_STAMP), `${new Date().toISOString()}\n`); }
  catch (error) { if (!missing(error)) throw error; }
}

// Newest change to the mirror's refs, closure proofs or configuration: what a create or
// fetch writes. Pack and loose-object files are left out, because the hourly
// share-mirror-packs relinks them into every mirror and so made idle mirrors look used.
export function lastActivityMs(mirror) {
  let newest = 0;
  const note = file => { try { newest = Math.max(newest, lstatSync(file).mtimeMs); } catch (error) { if (!missing(error)) throw error; } };
  for (const name of ["", "config", "packed-refs", "FETCH_HEAD", "pi-workspace-closure", USE_STAMP]) note(path.join(mirror, name));
  const walk = (directory, depth) => {
    let entries;
    try { entries = readdirSync(directory, { withFileTypes: true }); } catch (error) { if (missing(error)) return; throw error; }
    note(directory);
    for (const entry of entries) if (entry.isDirectory() && depth < 6) walk(path.join(directory, entry.name), depth + 1);
  };
  walk(path.join(mirror, "refs"), 0);
  return newest;
}

function originOf(mirror) {
  const origin = spawnSync("git", ["--git-dir", mirror, "config", "--local", "--get", "remote.origin.url"], { encoding: "utf8", env: gitEnvironment });
  return origin.status === 0 ? origin.stdout.trim() || null : null;
}

const PROTECTED = new Set(["borrowed", "cold-borrowers-unknown", "linked-worktree", "active-workspace"]);

// Decide, for every mirror under mirrorRoot, whether it is retired and why.
// activeMirrors: paths of the mirrors unreleased workspaces create from (create's own naming).
// checkouts: existing checkout or Git directory paths that might borrow from a mirror.
// coldBorrowed: object directories borrowed by checkouts on the cold tier, or null if unknown.
export function classifyMirrors({ mirrorRoot, activeMirrors = [], checkouts, coldBorrowed = new Set(), now = Date.now(), unusedDays = 14, duplicateIdleDays = 1 }) {
  let names;
  try { names = readdirSync(mirrorRoot).filter(name => name.endsWith(".git") && !name.startsWith(".")).sort(); }
  catch (error) { if (missing(error)) return []; throw error; }
  const borrowed = borrowedObjectDirectories(checkouts);
  for (const target of coldBorrowed ?? []) borrowed.add(target);
  const active = new Set([...activeMirrors].map(mirror => path.resolve(mirror)));
  const verdicts = names.map(name => {
    const mirror = path.join(mirrorRoot, name);
    const objects = real(path.join(mirror, "objects"));
    const sources = mirrorSources(mirror);
    const lastActivity = lastActivityMs(mirror);
    const base = { mirror, sources, origin: originOf(mirror), lastActivity: new Date(lastActivity).toISOString(), lastActivityMs: lastActivity };
    if (objects && (borrowed.has(objects) || borrowed.has(path.join(mirror, "objects")))) return { ...base, retire: false, reason: "borrowed" };
    if (coldBorrowed === null) return { ...base, retire: false, reason: "cold-borrowers-unknown" };
    if (liveWorktrees(mirror).length > 0) return { ...base, retire: false, reason: "linked-worktree" };
    if (active.has(mirror)) return { ...base, retire: false, reason: "active-workspace" };
    const localGone = sources.length > 0 && sources.every(url => path.isAbsolute(url) && !underColdStorage(url) && !existsSync(url));
    if (localGone) return { ...base, retire: true, reason: "source-gone" };
    if (sourcesRewritten(mirror, sources)) return { ...base, retire: true, reason: "source-rewritten" };
    if (now - lastActivity > unusedDays * 86_400_000) return { ...base, retire: true, reason: "unused" };
    return { ...base, retire: false, reason: "recent" };
  });
  // One mirror per origin: the kept one is a protected mirror, else the most recently used.
  const byOrigin = new Map();
  for (const verdict of verdicts) if (verdict.origin && !verdict.retire) byOrigin.set(verdict.origin, [...(byOrigin.get(verdict.origin) ?? []), verdict]);
  for (const group of byOrigin.values()) {
    if (group.length < 2) continue;
    const keepers = group.filter(verdict => PROTECTED.has(verdict.reason));
    const kept = keepers.length ? keepers : [group.reduce((a, b) => (b.lastActivityMs > a.lastActivityMs ? b : a))];
    for (const verdict of group) {
      if (kept.includes(verdict) || verdict.reason !== "recent" || now - verdict.lastActivityMs <= duplicateIdleDays * 86_400_000) continue;
      Object.assign(verdict, { retire: true, reason: "duplicate", duplicateOf: kept[0].mirror });
    }
  }
  return verdicts.map(({ lastActivityMs: _, ...verdict }) => verdict);
}

// Git directories anywhere under `roots` whose objects/info/alternates names a directory
// inside mirrorRoot, and the object directories they name. Read through `sudo -n` when it is available, so other users' folders
// count too. Returns null when the scan did not finish or could not read everything; then
// nothing is retired.
export function hostMirrorBorrowers(roots, mirrorRoot, { timeoutMs = 300_000 } = {}) {
  const existing = roots.filter(root => existsSync(root));
  if (existing.length === 0) return { gitDirectories: [], objectDirectories: [] };
  const findArgs = [...existing, "-xdev", "(", "-name", "node_modules", "-o", "-name", ".lake", "-o", "-path", mirrorRoot, ")", "-prune",
    "-o", "-path", "*/objects/info/alternates", "-type", "f", "-exec", "grep", "-H", "-Z", "", "{}", "+"];
  const scan = elevated => spawnSync(elevated ? "sudo" : "nice", elevated ? ["-n", "nice", "-n", "19", "ionice", "-c", "3", "find", ...findArgs] : ["-n", "19", "find", ...findArgs],
    { encoding: "utf8", timeout: timeoutMs, maxBuffer: 1 << 28 });
  let result = scan(true);
  if (!result.error && /^sudo: /mu.test(result.stderr ?? "")) result = scan(false);
  // grep exits 1 for an empty alternates file, so the exit status says little; an unreadable
  // folder could hide a borrower, files vanishing mid-scan (in /tmp) can't.
  if (result.error || result.signal || /Permission denied/u.test(result.stderr ?? "")) return null;
  const root = real(mirrorRoot) ?? path.resolve(mirrorRoot);
  const found = new Set(), borrowed = new Set();
  for (const line of result.stdout.split("\n")) {
    const nul = line.indexOf("\0");
    if (nul < 0) continue;
    const file = line.slice(0, nul), target = line.slice(nul + 1).trim();
    if (!target || target.startsWith("#")) continue;
    const objects = path.dirname(path.dirname(file));
    const resolved = path.isAbsolute(target) ? target : path.resolve(objects, target);
    const canonical = real(resolved) ?? resolved;
    if (canonical === root || canonical.startsWith(root + path.sep) || resolved.startsWith(path.resolve(mirrorRoot) + path.sep)) {
      found.add(path.dirname(objects));
      borrowed.add(canonical);
    }
  }
  return { gitDirectories: [...found].sort(), objectDirectories: [...borrowed].sort() };
}

// Remove a retired mirror: rename it out of the way first, so no reader sees it half deleted.
export function removeMirror(mirror) {
  const parked = path.join(path.dirname(mirror), `.retiring-${path.basename(mirror)}-${process.pid}`);
  renameSync(mirror, parked);
  rmSync(parked, { recursive: true, force: true });
}

// Leftovers of an interrupted removal.
export function removeParkedMirrors(mirrorRoot) {
  let names;
  try { names = readdirSync(mirrorRoot).filter(name => name.startsWith(".retiring-")); } catch (error) { if (missing(error)) return 0; throw error; }
  for (const name of names) rmSync(path.join(mirrorRoot, name), { recursive: true, force: true });
  return names.length;
}
