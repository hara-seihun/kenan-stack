import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {assertOwned, authorize, callerUid, Refusal} from './operator-observe.mjs';
import {observerRoute, privilegedCommand, stackQualificationReferences, ObserverUnavailable} from './operator-observation.mjs';
import {qualificationReferences, operatorCensus} from './qualification-references.mjs';

const uid = process.getuid();
const scratch = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'operator-observe-')));
const moduleUrl = new URL('./workspace.mjs', import.meta.url);
const receipt = JSON.stringify({operatorObserver: {gid: 975, node: '/usr/local/bin/node', entry: '/srv/tools/agent-workspace/operator-observe.mjs'}});
const foreign = {uid, groups: [uid, 975], stat: () => ({uid: uid + 1}), read: () => receipt};

test('the observer answers only for real paths its caller owns', () => {
  const root = scratch();
  try {
    assertOwned(root, uid);
    assertOwned(path.join(root, 'not-yet', 'created'), uid);
    fs.symlinkSync(root, path.join(root, 'link'));
    assert.throws(() => assertOwned(path.join(root, 'link'), uid), Refusal);
    assert.throws(() => assertOwned(path.join(root, 'link', 'below'), uid), Refusal);
    assert.throws(() => assertOwned(root, uid + 1), Refusal);
    assert.throws(() => assertOwned('/nonexistent-operator-observe-root', uid), Refusal);
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
});

test('only the listed observations with well-formed arguments are admitted', () => {
  const root = scratch();
  try {
    assert.deepEqual(authorize(['workspace.mjs', 'growth-process-snapshot', '--path', root], uid), ['workspace.mjs', 'growth-process-snapshot', '--path', root]);
    assert.ok(authorize(['qualification-references.mjs', '--census', JSON.stringify([root])], uid));
    assert.ok(authorize(['capacity-owner-forecast.mjs', '--processes', JSON.stringify([root]), String(Date.now() + 1000)], uid));
    for (const argv of [
      ['workspace.mjs', 'release', '--path', root],
      ['workspace.mjs', 'growth-process-snapshot', '--path', `${root}/../x`],
      ['workspace.mjs', 'growth-process-snapshot', '--id', root],
      ['../workspace.mjs', 'growth-process-snapshot', '--path', root],
      ['qualification-references.mjs', '--census', '["relative"]'],
      ['qualification-references.mjs', '--census', JSON.stringify([root, '/etc'])],
      ['capacity-owner-forecast.mjs', '--processes', JSON.stringify([root]), 'soon'],
      ['constructor', 'x'],
    ]) assert.throws(() => authorize(argv, uid), Refusal, argv.join(' '));
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
  assert.throws(() => callerUid({}), Refusal);
  assert.throws(() => callerUid({SUDO_UID: '0'}), Refusal);
  assert.equal(callerUid({SUDO_UID: '1006'}), 1006);
});

test('only a member of the recorded operator group uses the operator observer', () => {
  assert.deepEqual(observerRoute(moduleUrl, {uid: 0}), {kind: 'root'});
  assert.deepEqual(observerRoute(moduleUrl, {...foreign, stat: () => ({uid})}), {kind: 'direct'});
  assert.deepEqual(observerRoute(moduleUrl, {...foreign, groups: [uid]}), {kind: 'direct'});
  assert.deepEqual(observerRoute(moduleUrl, {...foreign, read: () => '{"component":"agent-workspace"}'}), {kind: 'direct'});
  assert.deepEqual(observerRoute(moduleUrl, {...foreign, read: () => { throw Object.assign(new Error('ENOENT'), {code: 'ENOENT'}); }}), {kind: 'direct'});
  assert.throws(() => observerRoute(moduleUrl, {...foreign, read: () => '{"operatorObserver":{"node":"/n"}}'}), ObserverUnavailable);
  assert.throws(() => observerRoute(moduleUrl, {...foreign, read: () => '{'}), ObserverUnavailable);
  assert.deepEqual(privilegedCommand(moduleUrl, ['growth-process-snapshot', '--path', '/p'], {...foreign, stat: () => ({uid})}),
    ['-n', process.execPath, new URL(moduleUrl).pathname, 'growth-process-snapshot', '--path', '/p']);
  assert.deepEqual(privilegedCommand(moduleUrl, ['growth-process-snapshot', '--path', '/p'], foreign),
    ['-n', '/usr/local/bin/node', '/srv/tools/agent-workspace/operator-observe.mjs', 'workspace.mjs', 'growth-process-snapshot', '--path', '/p']);
});

test('an operator census is the observer result, and any observer failure protects', () => {
  const ok = {errors: [], references: [], released: [], observations: [], complete: true, observedAt: 1};
  let argv;
  const execute = (command, args) => { argv = [command, ...args]; return {status: 0, stdout: JSON.stringify(ok)}; };
  assert.deepEqual(stackQualificationReferences(['/home/op/w'], {...foreign, execute}), ok);
  assert.deepEqual(argv.slice(3), ['/srv/tools/agent-workspace/operator-observe.mjs', 'qualification-references.mjs', '--census', '["/home/op/w"]']);
  for (const result of [{status: 77, stdout: '', stderr: 'refused'}, {status: 0, stdout: 'nope'}, {status: 0, stdout: '{"complete":true}'}, {status: null, error: {code: 'ETIMEDOUT'}}]) {
    const census = stackQualificationReferences(['/home/op/w'], {...foreign, execute: () => result});
    assert.equal(census.complete, false);
    assert.equal(census.errors.length, 1);
  }
  assert.equal(stackQualificationReferences(['/home/op/w'], {...foreign, read: () => '{'}).complete, false);
});

test('an unreadable qualification store is an error, not an absent one', {skip: uid === 0 && 'root reads through mode 000'}, () => {
  const root = scratch();
  try {
    const locked = path.join(root, 'locked');
    fs.mkdirSync(path.join(locked, 'qualification-authority-requests'), {recursive: true});
    fs.mkdirSync(path.join(root, 'data'));
    fs.chmodSync(locked, 0o000);
    const census = qualificationReferences(null, {dataRoot: path.join(root, 'data'),
      requestsDir: path.join(locked, 'qualification-authority-requests'), queueStateFile: path.join(locked, 'merge-queue', 'state.json')});
    assert.equal(census.complete, false);
    assert.match(census.errors.join('\n'), /EACCES/);
  } finally { fs.chmodSync(path.join(root, 'locked'), 0o755); fs.rmSync(root, {recursive: true, force: true}); }
});

test('the operator census passes on only the settlements that concern the caller roots', () => {
  const root = scratch();
  try {
    const data = path.join(root, 'data'), requests = path.join(data, 'qualification-authority-requests'), admission = path.join(data, 'producer-admission');
    fs.mkdirSync(requests, {recursive: true}); fs.mkdirSync(admission);
    const leaf = 'a'.repeat(40);
    for (const [id, checkout] of [['11111111-1111-4111-8111-111111111111', '/home/op/mine'], ['22222222-2222-4222-8222-222222222222', '/home/owner/private']]) {
      fs.writeFileSync(path.join(requests, `${id}.json`), JSON.stringify({version: 1, root: checkout, name: id, pipeline: {operation: id, leaves: [leaf], owner: 'o', base: leaf}}));
      fs.writeFileSync(path.join(admission, `${id}.completed.json`), JSON.stringify({state: 'completed', identity: {operation: id, owner: 'o', base: leaf, leaves: [leaf]}}));
    }
    const census = operatorCensus(['/home/op/mine'], {dataRoot: data});
    assert.equal(census.complete, true);
    assert.deepEqual(census.released.map(item => item.paths), [['/home/op/mine']]);
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
});
