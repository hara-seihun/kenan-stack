import './scratch-env.mjs';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, mkdirSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {workspaceTesting} from './workspace.mjs';

const git = (repository, ...args) => execFileSync('git', ['-C', repository, ...args], {encoding:'utf8'}).trim();

test('local commit with missing blobs prices from exact independent custody without lazy fetching', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'partial-source-pricing-'));
  try {
    const source = path.join(root, 'source'); mkdirSync(source);
    git(source, 'init', '-q', '-b', 'main');
    git(source, 'config', 'user.name', 'Test'); git(source, 'config', 'user.email', 'test@example.invalid');
    writeFileSync(path.join(source, 'file.txt'), 'selected bytes\n');
    writeFileSync(path.join(source, '.gitattributes'), '*.txt text\n');
    git(source, 'add', '.'); git(source, 'commit', '-qm', 'fixture');
    const commit = git(source, 'rev-parse', 'HEAD');
    const mirror = path.join(root, 'mirror.git');
    git(source, 'clone', '--bare', '--no-hardlinks', source, mirror);
    const intent = {intent:'source-only', growthBytes:0, headroomBytes:1024**3};
    const price = (store, patterns = []) => workspaceTesting.sourceCapacityPlan(source, commit, intent, 4096, store, patterns);
    const expected = price(mirror);
    for (const name of ['file.txt', '.gitattributes']) {
      const blob = git(source, 'rev-parse', `${commit}:${name}`);
      rmSync(path.join(source, '.git', 'objects', blob.slice(0, 2), blob.slice(2)));
    }
    git(source, 'remote', 'add', 'origin', path.join(root, 'no-network-source'));
    git(source, 'config', 'remote.origin.promisor', 'true');
    git(source, 'config', 'remote.origin.partialclonefilter', 'blob:none');
    assert.equal(git(source, 'cat-file', '-t', commit), 'commit');
    assert.deepEqual(price(mirror), expected);
    assert.equal(price(mirror, ['/file.txt']).sourceImportBytes, 0);
    assert.throws(() => price(undefined), /selected source object is unavailable/);
    const attributes = path.join(source, '.git', 'info', 'attributes');
    writeFileSync(attributes, '*.txt filter=unknown-transform\n');
    assert.throws(() => price(mirror), /assigns a checkout filter/);
    rmSync(attributes);
    const blob = git(mirror, 'rev-parse', `${commit}:file.txt`);
    rmSync(path.join(mirror, 'objects', blob.slice(0, 2), blob.slice(2)));
    assert.throws(() => price(mirror), /selected source object is unavailable/);
  } finally { rmSync(root, {recursive:true, force:true}); }
});
