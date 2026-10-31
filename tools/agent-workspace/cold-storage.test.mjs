import './scratch-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = mkdtempSync(path.join(tmpdir(), 'cold-storage-'));
process.env.PI_WORKSPACE_COLD_ROOT = path.join(root, 'cold');
const { movedToColdStorage, underColdStorage } = await import('./cold-storage.mjs');
const { gitDependencyCensus } = await import('./safety-census.mjs');

test.after(() => rmSync(root, { recursive: true, force: true }));

function coldClone(name, alternate) {
  const moved = path.join(root, 'cold', 'clones', name);
  mkdirSync(path.join(moved, '.git', 'objects', 'info'), { recursive: true });
  writeFileSync(path.join(moved, '.git', 'objects', 'info', 'alternates'), `${alternate}\n`);
  mkdirSync(path.join(root, 'clones'), { recursive: true });
  const link = path.join(root, 'clones', name);
  symlinkSync(moved, link);
  return { moved, link };
}

test('a checkout symlinked into the cold mount is recognised from the symlink alone', () => {
  const { link } = coldClone('recognised', '/objects/a');
  const local = path.join(root, 'clones', 'local');
  mkdirSync(local);
  symlinkSync(local, path.join(root, 'clones', 'local-link'));
  assert.equal(movedToColdStorage(link), true);
  assert.equal(movedToColdStorage(local), false);
  assert.equal(movedToColdStorage(path.join(root, 'clones', 'local-link')), false);
  assert.equal(underColdStorage(path.join(link, 'deep', 'source.git')), true);
  assert.equal(underColdStorage(path.join(local, 'source.git')), false);
});

test('a cold checkout\'s git dependencies are read once and reused while its symlink is unchanged', () => {
  const { moved, link } = coldClone('cached', '/objects/borrowed');
  const cacheFile = path.join(root, 'cold-deps.json');
  const rows = [{ id: 'r1', path: link, checkoutType: 'clone' }];
  const first = gitDependencyCensus(rows, undefined, { cacheFile });
  assert.deepEqual(first.alternates.map(item => item.objectDirectory), ['/objects/borrowed']);
  // The mount is never read again: even with the box copy gone the census answers from the cache.
  rmSync(moved, { recursive: true, force: true });
  assert.deepEqual(gitDependencyCensus(rows, undefined, { cacheFile }), first);
});
