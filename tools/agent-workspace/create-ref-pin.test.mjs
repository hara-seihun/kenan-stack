import './scratch-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { pinnedSourceCommit, clearRefPin } from './ref-pin.mjs';

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

function create(f, name, env, capacity = []) {
  const args = ['create', '--root', path.join(f.root, 'workspaces'), '--name', name, '--repo', f.source, ...(capacity.length ? capacity : ['--min-free-gib', '0']), '--json'];
  try { return { status: 0, receipt: JSON.parse(execFileSync(entry, args, { env, encoding: 'utf8', timeout: 60_000 })) }; }
  catch (error) { return { status: error.status, receipt: JSON.parse(error.stdout) }; }
}

for (const capacity of [[], ['--intent', 'source-only', '--headroom-gib', '8', '--growth-mib', '512']]) test(`repeating a create of a moving ref retains its original preparation (${capacity.length ? 'priced' : 'unestimated'})`, () => {
  const f = fixture();
  try {
    const env = { ...f.env, PI_WORKSPACE_CREATE_WAIT_SECONDS: '0' };
    const first = git(f.source, 'rev-parse', 'HEAD');
    const started = create(f, 'moving', env, capacity);
    assert.equal(started.status, 75);
    assert.equal(started.receipt.state, 'preparing');
    const preparationRoot = path.join(path.dirname(env.PI_WORKSPACE_STATE), 'source-preparations');
    const pinDirectory = path.join(preparationRoot, 'ref-pins');
    const pinFile = path.join(pinDirectory, readdirSync(pinDirectory)[0]);
    const pin = JSON.parse(readFileSync(pinFile, 'utf8'));
    writeFileSync(pinFile, JSON.stringify({ ...pin, at: Date.now() - 24 * 60 * 60 * 1000 }));
    for (let round = 0; round < 2; round++) {
      if (round === 1) git(f.source, 'checkout', '--orphan', 'rewritten');
      writeFileSync(path.join(f.source, 'file.txt'), `moved ${round}\n`);
      git(f.source, 'commit', '-qam', `moved ${round}`);
      const repeated = create(f, 'moving', env, capacity);
      // Where the job runs without the gated git (a user-manager unit), preparation may already be done.
      if (repeated.receipt.state === 'preparing')
        assert.equal(repeated.receipt.jobId, started.receipt.jobId, 'a moved HEAD must not start another source job');
    }
    const forecasts = readdirSync(preparationRoot).filter(file => file.endsWith('.forecast.json'));
    assert.equal(forecasts.length, 1, 'exact retries must not create another source forecast');
    assert.equal(JSON.parse(readFileSync(path.join(preparationRoot, forecasts[0]), 'utf8')).inputs.sourceCommit, first);
    writeFileSync(f.release, 'go');
    const done = create(f, 'moving', { ...f.env, PI_WORKSPACE_CREATE_WAIT_SECONDS: '50' }, capacity);
    assert.equal(done.status, 0, JSON.stringify(done.receipt));
    assert.equal(done.receipt.sourceCommit, first, 'the workspace is admitted at the commit the first call resolved');
    assert.equal(readFileSync(path.join(done.receipt.path, 'file.txt'), 'utf8'), 'first\n');
    if (capacity.length) {
      assert.equal(done.receipt.capacity.growthBytes, 512 * 1024 ** 2);
      assert.equal(done.receipt.capacity.headroomBytes, 8 * 1024 ** 3);
    }
    assert.equal(existsSync(pinFile), false, 'workspace reservation takes over the original source custody');
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

test('accepted pins survive time, rewritten or unavailable refs, and clear only at transfer', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ref-pin-'));
  try {
    const file = path.join(root, 'pin.json'), a = 'a'.repeat(40), b = 'b'.repeat(40);
    assert.equal(pinnedSourceCommit({ file, resolve: () => a, now: 1000 }), a);
    const original = readFileSync(file, 'utf8');
    for (const now of [0, 2000, 1000 + 24 * 60 * 60 * 1000]) {
      assert.equal(pinnedSourceCommit({ file, resolve: () => assert.fail('accepted retry must not resolve mutable HEAD'), now }), a);
      assert.equal(readFileSync(file, 'utf8'), original);
    }
    clearRefPin(file);
    assert.equal(pinnedSourceCommit({ file, resolve: () => b }), b);
    writeFileSync(file, '{broken');
    assert.throws(() => pinnedSourceCommit({ file, resolve: () => assert.fail() }), SyntaxError);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
