// Uncommitted work in a checkout being released (2026-10-31).
//
// An explicit release of a checkout whose commits are all published used to keep the checkout
// forever when its working tree had edits or untracked files, even when those edits were
// superseded by what was published (rf-long-tail: ten edited files, all redone on Seinari main).
// Release now copies every changed, untracked and non-build ignored file into one compressed tar next
// to the registry, with a manifest naming the checkout, its HEAD and its deleted paths, and then
// removes the checkout. Nothing is lost and nobody has to judge whether the edits mattered.
import {mkdirSync, lstatSync, writeFileSync, renameSync, rmSync, mkdtempSync, openSync, fsyncSync, closeSync} from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

// The archive holds small source edits. A tree with more uncommitted bytes than this is kept
// as before: copying gigabytes of unpublished data is a decision for its owner.
export const WORKING_TREE_ARCHIVE_MAX_BYTES = 1024 ** 3;

export class WorkingTreeArchiveError extends Error {
  constructor(code, detail) { super(`${code}: ${detail}`); this.code = code; }
}

// Parse `git status --porcelain=v1 -z --untracked-files=all` into present and deleted paths.
export function parseStatusZ(output) {
  const fields = output.split('\0');
  const present = new Set(), deleted = new Set();
  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i];
    if (!entry) continue;
    const xy = entry.slice(0, 2), file = entry.slice(3);
    if (xy[0] === 'R' || xy[0] === 'C') i++; // the source path of a rename/copy follows
    if (xy === '!!') continue;
    (xy.includes('D') ? deleted : present).add(file);
  }
  return {present: [...present].sort(), deleted: [...deleted].sort()};
}

// Ignored output in a released checkout (2026-10-31, rf-joint: jointsim.so blocked release).
// Regenerable build products are dropped with the checkout; every other ignored file is archived
// beside the uncommitted files, under the same size limit.
const BUILD_DIRECTORIES = new Set(['__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache', 'node_modules', 'build', 'dist',
  'target', '.lake', '.gradle', '.nx', '.react-router', '.converge-cache', '.venv', 'venv', '.tox', '.eggs', 'CMakeFiles']);
const BUILD_EXTENSIONS = new Set(['.so', '.o', '.a', '.obj', '.lo', '.la', '.pyc', '.pyo', '.pyd', '.dylib', '.dll', '.exe',
  '.cubin', '.fatbin', '.class', '.whl', '.olean', '.ilean']);
export function isBuildProduct(file) {
  const parts = file.split('/');
  if (parts.slice(0, -1).some(part => BUILD_DIRECTORIES.has(part) || part.endsWith('.egg-info'))) return true;
  const base = parts.at(-1);
  if (BUILD_DIRECTORIES.has(base) || base.endsWith('.egg-info')) return true;
  return BUILD_EXTENSIONS.has(path.extname(base)) || /\.so\.\d+(\.\d+)*$/u.test(base);
}

// Every ignored file (not directory) under pathspec, split into dropped build products and
// archived ignored files.
export function ignoredOutput(root, pathspec = ['.']) {
  const result = spawnSync('git', ['-C', root, 'ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--', ...pathspec], {encoding: 'utf8', maxBuffer: 256 * 1024 * 1024});
  if (result.status !== 0) throw new WorkingTreeArchiveError('ignored-output-status-failed', String(result.stderr).trim().slice(0, 300));
  const dropped = [], archived = [];
  let bytes = 0;
  for (const file of result.stdout.split('\0').filter(Boolean).sort()) {
    if (isBuildProduct(file)) { dropped.push(file); continue; }
    let stat;
    try { stat = lstatSync(path.join(root, file)); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    archived.push(file);
    if (stat.isFile()) bytes += stat.size;
  }
  return {dropped, archived, bytes};
}

export function workingTreeChanges(root, pathspec = ['.']) {
  const result = spawnSync('git', ['-C', root, 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--', ...pathspec], {encoding: 'utf8', maxBuffer: 256 * 1024 * 1024});
  if (result.status !== 0) throw new WorkingTreeArchiveError('working-tree-status-failed', String(result.stderr).trim().slice(0, 300));
  const {present, deleted} = parseStatusZ(result.stdout);
  const files = [];
  let bytes = 0;
  for (const file of present) {
    let stat;
    try { stat = lstatSync(path.join(root, file)); } catch (error) { if (error.code === 'ENOENT') { deleted.push(file); continue; } throw error; }
    files.push(file);
    if (stat.isFile()) bytes += stat.size;
  }
  return {files, deleted: [...new Set(deleted)].sort(), bytes, ignored: [], droppedBuildProducts: []};
}

// Adds ignored output to a change set: archived ignored files join the archive, build products are listed only.
export function withIgnoredOutput(changes, ignored) {
  return {...changes, files: [...changes.files, ...ignored.archived], bytes: changes.bytes + ignored.bytes,
    ignored: ignored.archived, droppedBuildProducts: ignored.dropped};
}

// Writes <directory>/<name>-<time>.tar.zst atomically and returns its path.
export function archiveWorkingTree({root, directory, name, manifest, changes}) {
  if (changes.bytes > WORKING_TREE_ARCHIVE_MAX_BYTES)
    throw new WorkingTreeArchiveError('working-tree-too-large', `${changes.bytes} bytes of uncommitted files exceed the ${WORKING_TREE_ARCHIVE_MAX_BYTES}-byte archive limit`);
  mkdirSync(directory, {recursive: true, mode: 0o700});
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = path.join(directory, `${name}-${stamp}.tar.zst`);
  const staging = mkdtempSync(path.join(directory, '.staging-'));
  try {
    writeFileSync(path.join(staging, 'RELEASED-WORK.json'), JSON.stringify({...manifest, files: changes.files, deleted: changes.deleted, bytes: changes.bytes,
      ignored: changes.ignored ?? [], droppedBuildProducts: changes.droppedBuildProducts ?? []}, null, 2) + '\n');
    const partial = path.join(staging, 'archive.tar.zst');
    // Manifest first (from the staging directory), then the changed files relative to the checkout.
    const tar = spawnSync('tar', ['--zstd', '-cf', partial, '-C', staging, 'RELEASED-WORK.json', '-C', root, '--null', '--no-recursion', '-T', '-'],
      {input: changes.files.map(file => file + '\0').join(''), encoding: 'utf8', maxBuffer: 16 * 1024 * 1024});
    if (tar.status !== 0) throw new WorkingTreeArchiveError('working-tree-archive-failed', String(tar.stderr).trim().slice(0, 300));
    const fd = openSync(partial, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(partial, target);
    const dir = openSync(directory, 'r'); try { fsyncSync(dir); } finally { closeSync(dir); }
    return target;
  } finally {
    rmSync(staging, {recursive: true, force: true});
  }
}
