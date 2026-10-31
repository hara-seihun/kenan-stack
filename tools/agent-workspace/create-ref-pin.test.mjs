import './scratch-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { pinnedSourceCommit, REF_PIN_MAX_AGE_MS } from './ref-pin.mjs';

const entry = new URL('./workspace.mjs', import.meta.url).pathname;
const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', timeout: 10_000 }).trim();

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'create-ref-pin-'));
  const source = path.join(root, 'source'), remote = path.join(root, 'remote.git');
  mkdirSync(source);
  git(source, 'init', '-q', '-b', 'main');
  git(source, 'config', 'user.name', 'Test'); git(source, 'config', 'user.email', 'test@example.invalid');
  writeFileSync(path.join(source, 'file.txt'), 'first\n');
  git(source, 'add', '.'); git(source, 'commit', '-qm', 'first');
  execFileSync('git', ['clone', '-q', '--bare', source, remote]);
  git(source, 'remote', 'add', 'origin', remote);
  git(source, 'push', '-q', '-u', 'origin', 'main');
  // Every fetch waits for the release file, so source preparation stays pending while the test moves main.
  const release = path.join(root, 'release'), bin = path.join(root, 'bin');
  mkdirSync(bin);
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  writeFileSync(path.join(bin, 'git'), `#!${process.execPath}
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args.includes('fetch')) {
  const deadline = Date.now() + 30000;
  while (!fs.existsSync(${JSON.stringify(release)}) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
}
process.exit(spawnSync(${JSON.stringify(realGit)}, args, { stdio: 'inherit' }).status ?? 1);
`);
  chmodSync(path.join(bin, 'git'), 0o755);
  const env = { ...process.env, PI_WORKSPACE_STATE: path.join(root, 'state', 'registry.sqlite3'),
    PI_WORKSPACE_TEST_EXTERNAL_SAFETY: 'empty', PATH: `${bin}:${process.env.PATH}` };
  return { root, source, release, env, close: () => rmSync(root, { recursive: true, force: true }) };
}

function create(f, name, env) {
  const args = ['create', '--root', path.join(f.root, 'workspaces'), '--name', name, '--repo', f.source, '--min-free-gib', '0', '--json'];
  try { return { status: 0, receipt: JSON.parse(execFileSync(entry, args, { env, encoding: 'utf8', timeout: 60_000 })) }; }
  catch (error) { return { status: error.status, receipt: JSON.parse(error.stdout) }; }
}

test('repeating a create of a moving ref keeps its first preparation instead of starting a new one', () => {
  const f = fixture();
  try {
    const env = { ...f.env, PI_WORKSPACE_CREATE_WAIT_SECONDS: '0' };
    const first = git(f.source, 'rev-parse', 'HEAD');
    const started = create(f, 'moving', env);
    assert.equal(started.status, 75);
    assert.equal(started.receipt.state, 'preparing');
    for (let round = 0; round < 2; round++) {
      writeFileSync(path.join(f.source, 'file.txt'), `moved ${round}\n`);
      git(f.source, 'commit', '-qam', `moved ${round}`);
      const repeated = create(f, 'moving', env);
      // Where the job runs without the gated git (a user-manager unit), preparation may already be done.
      if (repeated.receipt.state === 'preparing')
        assert.equal(repeated.receipt.jobId, started.receipt.jobId, 'a moved HEAD must not start another source job');
    }
    writeFileSync(f.release, 'go');
    const done = create(f, 'moving', { ...f.env, PI_WORKSPACE_CREATE_WAIT_SECONDS: '50' });
    assert.equal(done.status, 0, JSON.stringify(done.receipt));
    assert.equal(done.receipt.sourceCommit, first, 'the workspace is admitted at the commit the first call resolved');
    assert.equal(readFileSync(path.join(done.receipt.path, 'file.txt'), 'utf8'), 'first\n');
  } finally { f.close(); }
});

test('one create call waits for its background jobs and returns the active workspace', () => {
  const f = fixture();
  try {
    spawn('sh', ['-c', `sleep 3; touch '${f.release}'`], { detached: true, stdio: 'ignore' }).unref();
    const started = Date.now();
    const done = create(f, 'waited', { ...f.env, PI_WORKSPACE_CREATE_WAIT_SECONDS: '50' });
    assert.equal(done.status, 0, JSON.stringify(done.receipt));
    assert.ok(Date.now() - started >= 3000, 'the source job was still gated when create started');
    assert.ok(existsSync(path.join(done.receipt.path, 'file.txt')));
  } finally { f.close(); }
});

test('a pin is reused only while recent and still an ancestor of the ref', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ref-pin-'));
  try {
    const file = path.join(root, 'pin.json'), a = 'a'.repeat(40), b = 'b'.repeat(40), c = 'c'.repeat(40);
    assert.equal(pinnedSourceCommit({ file, resolved: a, isAncestor: () => assert.fail(), now: 1000 }), a);
    assert.equal(pinnedSourceCommit({ file, resolved: b, isAncestor: () => true, now: 2000 }), a);
    assert.equal(pinnedSourceCommit({ file, resolved: b, isAncestor: () => null, now: 2000 }), a);
    assert.equal(pinnedSourceCommit({ file, resolved: b, isAncestor: () => false, now: 3000 }), b, 'a rewritten ref repins');
    assert.equal(pinnedSourceCommit({ file, resolved: c, isAncestor: () => true, now: 3000 + REF_PIN_MAX_AGE_MS }), c, 'an old pin expires');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
