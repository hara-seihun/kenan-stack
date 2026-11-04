import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, openSync, closeSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {probeCreationFence, CREATION_FENCE_PROBE_MS} from './creation-fence.mjs';

test('only completed flock statuses establish free or busy', () => {
  for (const [status, busy] of [[0, false], [1, true]]) {
    assert.equal(probeCreationFence(17, {run(name, args, options) {
      assert.equal(name, 'flock');
      assert.deepEqual(args, ['--exclusive', '--nonblock', '3']);
      assert.equal(options.timeout, CREATION_FENCE_PROBE_MS);
      assert.equal(options.killSignal, 'SIGKILL');
      assert.equal(options.stdio[3], 17);
      return {status};
    }}), busy);
  }
});
test('deadline, launch, signal and tool failures remain unknown with useful diagnostics', () => {
  for (const [result, message] of [
    [{status: null, error: {code: 'ETIMEDOUT'}, signal: 'SIGKILL'}, /deadline exhausted after 10000 ms/],
    [{status: null, error: {code: 'ENOENT'}}, /error=ENOENT/],
    [{status: 1, error: {code: 'EIO'}}, /error=EIO/],
    [{status: 0, signal: 'SIGTERM'}, /signal=SIGTERM/],
    [{status: 64, stderr: 'bad descriptor'}, /status=64.*bad descriptor/],
  ]) assert.throws(() => probeCreationFence(17, {run: () => result}), message);
});
test('real kernel contention is busy and a released fence is free', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'creation-fence-'));
  const first = openSync(path.join(directory, 'lock'), 'a');
  const second = openSync(path.join(directory, 'lock'), 'a');
  try {
    assert.equal(probeCreationFence(first), false);
    assert.equal(probeCreationFence(second), true);
    closeSync(first);
    assert.equal(probeCreationFence(second), false);
  } finally {try {closeSync(first);} catch {} closeSync(second); rmSync(directory, {recursive: true, force: true});}
});
test('ordinary startup delay beyond the old one-second budget succeeds', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'creation-fence-delay-'));
  const fd = openSync(path.join(directory, 'lock'), 'a');
  try {
    assert.equal(probeCreationFence(fd, {run(name, args, options) {
      return spawnSync(process.execPath, ['-e', `
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1200);
        const r=require('node:child_process').spawnSync(${JSON.stringify(name)}, ${JSON.stringify(args)}, {stdio:['ignore','inherit','inherit',3]});
        process.exit(r.status ?? 99);
      `], options);
    }}), false);
  } finally {closeSync(fd); rmSync(directory, {recursive:true, force:true});}
});
