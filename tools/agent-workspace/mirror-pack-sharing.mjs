// A mirror whose source is a local repository on the same filesystem takes the
// source's immutable pack files by hard link: one inode, two names, no second
// copy. The link keeps the objects alive in the mirror when the source later
// repacks or prunes, so the mirror still owns its objects independently (no
// alternates). Packs the mirror holds alone are removed once every object in
// them is in a pack the mirror shares with a source; partly covered packs are
// rewritten to just their uncovered objects. At every step each object stays
// present in the mirror, so readers (worktrees, reference clones) never miss one.
// The source's loose objects (pushes since its last repack) are linked too, or
// copied when the kernel refuses the link, so a mirror of a local repository
// holds every object its source holds and an import needs no Git transfer.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, linkSync, mkdirSync, lstatSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";

const PACK = /^(pack-[0-9a-f]{40,64})\.idx$/u;
// Git looks a pack up through its index, so the index is linked last and removed first.
const LINK_ORDER = [".pack", ".rev", ".idx"];
const REMOVE_ORDER = [".idx", ".bitmap", ".rev", ".mtimes", ".pack"];
const { GIT_DIR, GIT_OBJECT_DIRECTORY, GIT_WORK_TREE, ...inherited } = process.env;
const gitEnvironment = { ...inherited, GIT_ALTERNATE_OBJECT_DIRECTORIES: "", GIT_NO_LAZY_FETCH: "1" };

// Rewriting a pack is the one heavy step here (a 50 GB pack made three 4-5 GB
// pack-objects on 2026-10-30). Only one runs on the host at a time, at the lowest
// CPU and best-effort IO priority, one thread; a busy lock skips the rewrite until
// the next maintenance run instead of waiting.
export const PACK_REWRITE_LOCK = process.env.AGENT_WORKSPACE_PACK_LOCK || "/run/lock/kenan-git-pack-rewrite.lock";
const LOCK_BUSY = 75;
const MAX_REWRITE_PACK_BYTES = Number(process.env.AGENT_WORKSPACE_MAX_REWRITE_PACK_BYTES || 2 * 1024 ** 3);
const git = (args, options = {}) => spawnSync("git", args, { encoding: "utf8", env: gitEnvironment, maxBuffer: 16 << 20, timeout: 600_000, ...options });
const inode = file => { const s = statSync(file, { bigint: true }); return `${s.dev}:${s.ino}`; };
const missing = error => error?.code === "ENOENT";

export function hashBytesFor(location) {
  const format = git([...location, "rev-parse", "--show-object-format"]);
  if (format.status !== 0) return { ok: false, error: { code: "object-format-unknown", detail: format.stderr.trim() } };
  const bytes = { sha1: 20, sha256: 32 }[format.stdout.trim()];
  return bytes === undefined ? { ok: false, error: { code: "object-format-unsupported", detail: format.stdout.trim() } } : { ok: true, value: bytes };
}

// Object names in a pack index (version 1 or 2), as latin1 strings of raw hash bytes.
export function packIndexNames(file, hashBytes) {
  const data = readFileSync(file);
  const v2 = data.length >= 8 && data.readUInt32BE(0) === 0xff744f63;
  if (v2 && data.readUInt32BE(4) !== 2) return { ok: false, error: { code: "pack-index-version-unsupported", detail: file } };
  const fanout = v2 ? 8 : 0;
  if (data.length < fanout + 1024) return { ok: false, error: { code: "pack-index-truncated", detail: file } };
  const count = data.readUInt32BE(fanout + 1020);
  const start = fanout + 1024, stride = v2 ? hashBytes : hashBytes + 4, skip = v2 ? 0 : 4;
  if (data.length < start + count * stride) return { ok: false, error: { code: "pack-index-truncated", detail: file } };
  const names = new Array(count);
  for (let index = 0; index < count; index++) {
    const offset = start + index * stride + skip;
    names[index] = data.toString("latin1", offset, offset + hashBytes);
  }
  return { ok: true, value: names };
}

export function objectPackDirectory(repository) {
  if (!path.isAbsolute(repository) || !existsSync(repository)) return null;
  const located = git(["-C", repository, "rev-parse", "--path-format=absolute", "--git-path", "objects/pack"]);
  const directory = located.status === 0 ? located.stdout.trim() : "";
  return directory && existsSync(directory) ? directory : null;
}

function packBases(directory) {
  return readdirSync(directory).map(name => PACK.exec(name)?.[1]).filter(Boolean).sort();
}

function lowPriorityGit(args, options) {
  return spawnSync("flock", ["--nonblock", "--conflict-exit-code", String(LOCK_BUSY), PACK_REWRITE_LOCK,
    "nice", "-n", "19", "ionice", "-c", "2", "-n", "7", "git", "-c", "pack.threads=1", ...args],
  { encoding: "utf8", env: gitEnvironment, maxBuffer: 16 << 20, timeout: 3_600_000, ...options });
}

const LOOSE_DIRECTORY = /^[0-9a-f]{2}$/u;
const LOOSE_NAME = /^[0-9a-f]{38}(?:[0-9a-f]{24})?$/u;

// Bring every loose object of the source into the mirror: a hard link when the
// kernel allows it, else a copy (loose objects are small). Objects are immutable
// and content-named, so an existing name is already the same object.
export function shareLooseObjects(sourceObjects, mirrorObjects) {
  let linked = 0, copied = 0;
  let directories;
  try { directories = readdirSync(sourceObjects).filter(name => LOOSE_DIRECTORY.test(name)); }
  catch (error) { if (missing(error)) return { linked, copied }; throw error; }
  for (const directory of directories) {
    let names;
    try { names = readdirSync(path.join(sourceObjects, directory)).filter(name => LOOSE_NAME.test(name)); }
    catch (error) { if (missing(error) || error.code === "ENOTDIR") continue; throw error; }
    if (names.length === 0) continue;
    const target = path.join(mirrorObjects, directory);
    for (const name of names) {
      const from = path.join(sourceObjects, directory, name), to = path.join(target, name);
      if (existsSync(to)) continue;
      mkdirSync(target, { recursive: true, mode: 0o755 });
      const temporary = path.join(target, `.tmp-share-${process.pid}-${name}`);
      try { linkSync(from, temporary); renameSync(temporary, to); linked++; continue; }
      catch (error) {
        if (missing(error)) continue; // the source pruned or packed it meanwhile
        if (!["EPERM", "EACCES", "EXDEV", "EMLINK"].includes(error.code)) throw error;
      }
      try { copyFileSync(from, temporary); renameSync(temporary, to); copied++; }
      catch (error) { try { unlinkSync(temporary); } catch { /* not created */ } if (!missing(error)) throw error; }
    }
  }
  return { linked, copied };
}

// Interrupted fetches and repacks leave tmp_pack_*/tmp_idx_* behind (a killed
// import left a 22 GB tmp_pack on 2026-10-30). A live writer keeps touching its
// file, so one unchanged for maxAgeMs is dead.
export function removeStaleTemporaryPacks(mirror, now = Date.now(), maxAgeMs = 3_600_000) {
  const directory = path.join(mirror, "objects", "pack");
  let removed = 0, freedBytes = 0;
  let names;
  try { names = readdirSync(directory); } catch (error) { if (missing(error)) return { removed, freedBytes }; throw error; }
  for (const name of names) {
    if (!/^(?:tmp_pack_|tmp_idx_|tmp_rev_|tmp_mtimes_|\.tmp-share-)/u.test(name)) continue;
    const file = path.join(directory, name);
    try {
      const s = lstatSync(file);
      if (!s.isFile() || now - s.mtimeMs < maxAgeMs) continue;
      unlinkSync(file);
      removed++;
      if (s.nlink === 1) freedBytes += s.blocks * 512;
    } catch (error) { if (!missing(error)) throw error; }
  }
  return { removed, freedBytes };
}

// Link one source pack into the mirror. A same-named mirror copy holds the same
// objects; it is atomically replaced by the link so the bytes are stored once.
function linkPack(sourceDirectory, mirrorDirectory, base) {
  const created = [];
  let freedBytes = 0;
  try {
    for (const suffix of LINK_ORDER) {
      const from = path.join(sourceDirectory, base + suffix), to = path.join(mirrorDirectory, base + suffix);
      if (!existsSync(from)) { if (suffix === ".rev") continue; throw Object.assign(new Error(from), { code: "ENOENT" }); }
      if (existsSync(to)) {
        if (inode(to) === inode(from)) continue;
        // Pack names are content checksums; a different size is not this pack.
        if (statSync(to).size !== statSync(from).size) throw Object.assign(new Error(to), { code: "EEXIST" });
      }
      const replaced = existsSync(to) ? lstatSync(to) : null;
      const temporary = path.join(mirrorDirectory, `.tmp-share-${process.pid}-${base}${suffix}`);
      linkSync(from, temporary);
      renameSync(temporary, to);
      if (replaced?.nlink === 1) freedBytes += replaced.blocks * 512;
      created.push(to);
    }
    return { linked: created.length > 0, freedBytes };
  } catch (error) {
    // A source repack or a file owned by another user (protected_hardlinks) leaves this
    // pack to the ordinary fetch. Undo only names this call created that Git cannot use.
    if (!["ENOENT", "EEXIST", "EPERM", "EACCES", "EXDEV", "EMLINK"].includes(error.code)) throw error;
    if (!existsSync(path.join(mirrorDirectory, base + ".idx"))) for (const file of created) { try { unlinkSync(file); } catch (e) { if (!missing(e)) throw e; } }
    return { linked: false, skipped: error.code, freedBytes };
  }
}

function removePack(directory, base) {
  let freedBytes = 0;
  for (const suffix of REMOVE_ORDER) {
    const file = path.join(directory, base + suffix);
    try {
      const s = lstatSync(file);
      unlinkSync(file);
      if (s.nlink === 1) freedBytes += s.blocks * 512;
    } catch (error) { if (!missing(error)) throw error; }
  }
  return freedBytes;
}

// Remove (or shrink) mirror-only packs whose objects the shared packs already hold.
function dedupe(mirror, directory, sharedInodes, hashBytes) {
  const result = { removedPacks: 0, rewrittenPacks: 0, freedBytes: 0, keptPacks: 0 };
  const bases = packBases(directory).filter(base => existsSync(path.join(directory, base + ".pack")));
  const isShared = base => sharedInodes.has(inode(path.join(directory, base + ".pack")));
  const own = bases.filter(base => !isShared(base) && !existsSync(path.join(directory, base + ".keep")) && !existsSync(path.join(directory, base + ".promisor")));
  const shared = bases.filter(isShared);
  if (shared.length === 0) { result.keptPacks = own.length; return result; }
  // Loose objects that a pack now holds are redundant copies.
  git(["--git-dir", mirror, "prune-packed", "--quiet"]);
  if (own.length === 0) return result;
  const covered = new Set();
  for (const base of shared) {
    const names = packIndexNames(path.join(directory, base + ".idx"), hashBytes);
    if (!names.ok) { result.keptPacks = own.length; return result; }
    for (const name of names.value) covered.add(name);
  }
  // A multi-pack index would name removed packs; Git rebuilds nothing from it here.
  try { unlinkSync(path.join(directory, "multi-pack-index")); } catch (error) { if (!missing(error)) throw error; }
  for (const base of own) {
    const names = packIndexNames(path.join(directory, base + ".idx"), hashBytes);
    if (!names.ok) { result.keptPacks++; continue; }
    const uncovered = names.value.filter(name => !covered.has(name));
    if (uncovered.length === names.value.length) { result.keptPacks++; continue; }
    // A big pack that is only partly covered means the source rewrote its history
    // (2026-10-30: seinari.git moving its large files to LFS). Rewriting it would
    // copy tens of GB of old objects; the mirror is retired instead (mirror-retirement.mjs).
    if (uncovered.length > 0 && statSync(path.join(directory, base + ".pack")).size > MAX_REWRITE_PACK_BYTES) { result.keptPacks++; result.tooBigToRewrite = (result.tooBigToRewrite ?? 0) + 1; continue; }
    if (uncovered.length > 0) {
      const written = lowPriorityGit(["--git-dir", mirror, "pack-objects", "--quiet", path.join(directory, "pack")],
        { input: uncovered.map(name => Buffer.from(name, "latin1").toString("hex")).join("\n") + "\n" });
      if (written.status === LOCK_BUSY) { result.keptPacks++; result.rewriteBusy = true; continue; }
      const residue = written.stdout.trim();
      if (written.status !== 0 || !/^[0-9a-f]{40,64}$/u.test(residue) || !existsSync(path.join(directory, `pack-${residue}.idx`))) { result.keptPacks++; continue; }
      if (`pack-${residue}` === base) { result.keptPacks++; continue; }
      result.rewrittenPacks++;
    } else result.removedPacks++;
    try { result.freedBytes += removePack(directory, base); }
    catch (error) { if (error.code !== "EPERM" && error.code !== "EACCES") throw error; result.keptPacks++; }
  }
  return result;
}

// sources: repository paths the mirror fetches from. exclusive(action) runs action
// under the mirror's pack-removal fence, or returns null when another sharer holds it.
export function shareMirrorPacks({ mirror, sources, exclusive }) {
  const directory = path.join(mirror, "objects", "pack");
  if (!existsSync(directory) || existsSync(path.join(mirror, "objects", "info", "alternates"))) return { ok: true, value: { state: "not-applicable", sources: [] } };
  const device = statSync(directory).dev;
  const hashBytes = hashBytesFor(["--git-dir", mirror]);
  if (!hashBytes.ok) return hashBytes;
  const used = [], sharedInodes = new Set();
  let linkedPacks = 0, skippedPacks = 0, replacedBytes = 0, linkedLoose = 0, copiedLoose = 0;
  for (const source of [...new Set(sources.filter(Boolean))]) {
    const sourceDirectory = objectPackDirectory(source);
    if (sourceDirectory === null || path.resolve(sourceDirectory) === path.resolve(directory) || statSync(sourceDirectory).dev !== device) continue;
    const sourceHash = hashBytesFor(["-C", source]);
    if (!sourceHash.ok || sourceHash.value !== hashBytes.value) continue;
    used.push(source);
    for (const base of packBases(sourceDirectory)) {
      if (existsSync(path.join(sourceDirectory, base + ".promisor"))) continue;
      const outcome = linkPack(sourceDirectory, directory, base);
      if (outcome.linked) linkedPacks++;
      replacedBytes += outcome.freedBytes;
      if (outcome.skipped) { skippedPacks++; continue; }
      try { sharedInodes.add(inode(path.join(sourceDirectory, base + ".pack"))); } catch (error) { if (!missing(error)) throw error; }
    }
    const loose = shareLooseObjects(path.dirname(sourceDirectory), path.dirname(directory));
    linkedLoose += loose.linked; copiedLoose += loose.copied;
  }
  if (used.length === 0) return { ok: true, value: { state: "no-local-source", sources: [] } };
  const removal = exclusive(() => dedupe(mirror, directory, sharedInodes, hashBytes.value));
  const { freedBytes = 0, ...counts } = removal ?? { removedPacks: 0, rewrittenPacks: 0, keptPacks: null };
  return { ok: true, value: { state: removal === null ? "linked-removal-busy" : "shared", sources: used, linkedPacks, skippedPacks, linkedLoose, copiedLoose,
    ...counts, freedBytes: freedBytes + replacedBytes } };
}

// Local repositories a mirror's configuration fetches from.
export function configuredLocalSources(mirror) {
  const listed = git(["--git-dir", mirror, "config", "--local", "--get-regexp", "^remote\\..*\\.url$"]);
  if (listed.status !== 0) return [];
  return listed.stdout.split("\n").map(line => line.slice(line.indexOf(" ") + 1)).filter(url => path.isAbsolute(url) && existsSync(url));
}

