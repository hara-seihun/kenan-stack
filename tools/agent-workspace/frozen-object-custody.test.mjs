import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn, spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {prepareFrozenObjectCustody} from './frozen-object-custody.mjs';

function git(directory, args, input) {
  const result = spawnSync('git', ['-C', directory, ...args], {input, encoding: 'utf8', timeout: 30000, maxBuffer: 16 * 1024 * 1024, env: {...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null'}});
  assert.equal(result.status, 0, String(result.error || result.stderr));
  return result.stdout.trim();
}
function fixture(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'frozen-objects-'));
  const source = path.join(root, 'source'), state = path.join(root, 'state'), statePath = path.join(state, 'registry.sqlite3');
  fs.mkdirSync(state); fs.mkdirSync(path.join(state, 'mirrors'));
  fs.mkdirSync(source); git(source, ['init', '-q']);
  git(source, ['config', 'user.name', 'Fixture']); git(source, ['config', 'user.email', 'fixture@example.invalid']);
  const context = {root, source, state, statePath,
    commit() { git(source, ['add', '.']); git(source, ['commit', '-qm', 'fixture']); return git(source, ['rev-parse', 'HEAD']); },
    request() { return {path: source, statePath, id: 'fixture-id', head: git(source, ['rev-parse', 'HEAD'])}; },
    borrow() {
      const mirror = path.join(state, 'mirrors', 'fixture.git');
      git(root, ['clone', '-q', '--mirror', '--no-hardlinks', source, mirror]);
      fs.rmSync(source, {recursive: true});
      git(root, ['clone', '-q', '--shared', mirror, source]);
      git(source, ['config', 'user.name', 'Fixture']); git(source, ['config', 'user.email', 'fixture@example.invalid']);
      return mirror;
    },
  };
  try {
    const result = fn(context);
    if (result?.then) return result.finally(() => fs.rmSync(root, {recursive: true, force: true}));
    return result;
  } finally {
    // Async fixtures perform their own cleanup after the child writers stop.
    if (!context.async) fs.rmSync(root, {recursive: true, force: true});
  }
}
function seed(f) {
  fs.mkdirSync(path.join(f.source, 'nested'));
  fs.writeFileSync(path.join(f.source, 'nested', 'file'), 'nested\n');
  fs.writeFileSync(path.join(f.source, 'keep'), 'keep\n');
  fs.writeFileSync(path.join(f.source, 'change'), 'before\n');
  return f.commit();
}
function refs(mirror) { return git(mirror, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/pi-workspace-frozen/']); }
function removeLoose(directory, object) { fs.unlinkSync(path.join(directory, 'objects', object.slice(0, 2), object.slice(2))); }
function importBlobs(directory, count) {
  let input = 'commit refs/heads/many\ncommitter Fixture <f@example.invalid> 1700000000 +0000\ndata 5\nmany\n';
  for (let i = 0; i < count; i++) {
    const body = `value-${i}\n`;
    input += `M 100644 inline f${i}\ndata ${Buffer.byteLength(body)}\n${body}\n`;
  }
  git(directory, ['fast-import', '--quiet'], input + '\ndone\n');
  git(directory, ['symbolic-ref', 'HEAD', 'refs/heads/many']);
  git(directory, ['reset', '--hard', '-q']);
}

test('private Git is preserved without repack, copies, or refs', () => fixture(f => {
  seed(f);
  const objects = git(f.source, ['count-objects', '-v']);
  assert.deepEqual(prepareFrozenObjectCustody(f.request()), {kind: 'private-git'});
  assert.equal(git(f.source, ['count-objects', '-v']), objects);
  assert.equal(refs(f.source), '');
}));

test('managed alternate pins the minimal commit, tree and blob boundary and survives mirror prune', () => fixture(f => {
  const base = seed(f), mirror = f.borrow();
  const tree = git(f.source, ['rev-parse', 'HEAD:nested']), blob = git(f.source, ['rev-parse', 'HEAD:keep']);
  fs.writeFileSync(path.join(f.source, 'change'), 'after\n');
  f.commit(); const request = f.request();
  const counts = git(f.source, ['count-objects', '-v']);
  const custody = prepareFrozenObjectCustody(request);
  assert.equal(custody.kind, 'managed-mirror-pins');
  assert.equal(custody.alternate, path.join(mirror, 'objects'));
  assert.deepEqual(custody.pins.map(pin => pin.object).sort(), [base, tree, blob].sort());
  for (const pin of custody.pins) {
    assert.equal(pin.ref, `refs/pi-workspace-frozen/${request.id}/${request.head}/${pin.object}`);
    assert.equal(git(mirror, ['rev-parse', pin.ref]), pin.object);
  }
  assert.deepEqual(prepareFrozenObjectCustody(request), custody);
  assert.equal(git(f.source, ['count-objects', '-v']), counts);
  for (const ref of git(mirror, ['for-each-ref', '--format=%(refname)', 'refs/heads/', 'refs/tags/']).split('\n').filter(Boolean)) git(mirror, ['update-ref', '-d', ref]);
  git(mirror, ['reflog', 'expire', '--expire=now', '--all']);
  git(mirror, ['gc', '--prune=now']);
  git(f.source, ['fsck', '--full', '--no-reflogs']);
  assert.equal(git(f.source, ['show', 'HEAD:nested/file']), 'nested');
  assert.equal(git(f.source, ['show', 'HEAD:change']), 'after');
  assert.ok(fs.existsSync(path.join(f.source, '.git', 'objects')));
}));

test('dry runs validate the full boundary without publishing refs', () => fixture(f => {
  seed(f); const mirror = f.borrow();
  const request = f.request();
  const planned = prepareFrozenObjectCustody({...request, dryRun: true});
  assert.equal(planned.pins.length, 1);
  assert.equal(refs(mirror), '');
  assert.deepEqual(prepareFrozenObjectCustody(request), planned);
}));

for (const invalid of ['outside', 'nested', 'relative', 'multiple', 'symbolic-alternate', 'symbolic-gitdir', 'commondir', 'gitdir', 'shallow', 'grafts', 'replacement', 'http']) {
  test(`rejects ${invalid} custody without publishing pins`, () => fixture(f => {
    const base = seed(f), mirror = f.borrow(), request = f.request();
    const alternateFile = path.join(f.source, '.git', 'objects', 'info', 'alternates');
    const objects = path.join(mirror, 'objects');
    if (invalid === 'outside') {
      const outside = path.join(f.root, 'outside.git'); fs.renameSync(mirror, outside);
      fs.writeFileSync(alternateFile, path.join(outside, 'objects') + '\n');
    } else if (invalid === 'nested') fs.writeFileSync(path.join(objects, 'info', 'alternates'), objects + '\n');
    else if (invalid === 'relative') fs.writeFileSync(alternateFile, path.relative(path.dirname(alternateFile), objects) + '\n');
    else if (invalid === 'multiple') fs.writeFileSync(alternateFile, objects + '\n' + objects + '\n');
    else if (invalid === 'symbolic-alternate') {
      const alias = path.join(f.state, 'mirrors', 'alias.git'); fs.symlinkSync(mirror, alias);
      fs.writeFileSync(alternateFile, path.join(alias, 'objects') + '\n');
    } else if (invalid === 'symbolic-gitdir') {
      fs.renameSync(path.join(f.source, '.git'), path.join(f.root, 'private.git'));
      fs.symlinkSync(path.join(f.root, 'private.git'), path.join(f.source, '.git'));
    } else if (['commondir', 'gitdir', 'shallow'].includes(invalid)) fs.writeFileSync(path.join(f.source, '.git', invalid), '../anything\n');
    else if (invalid === 'grafts') fs.writeFileSync(path.join(f.source, '.git', 'info', 'grafts'), base + '\n');
    else if (invalid === 'replacement') git(f.source, ['update-ref', `refs/replace/${base}`, base]);
    else if (invalid === 'http') fs.writeFileSync(path.join(objects, 'info', 'http-alternates'), 'https://example.invalid/objects\n');
    assert.throws(() => prepareFrozenObjectCustody(request), {code: 'FROZEN_OBJECT_CUSTODY_UNAVAILABLE'});
  }));
}

test('a missing child beneath a present borrowed commit fails closure, including dry runs', () => fixture(f => {
  seed(f); const mirror = f.borrow();
  const blob = git(mirror, ['rev-parse', 'HEAD:keep']);
  removeLoose(mirror, blob);
  for (const dryRun of [true, false]) assert.throws(() => prepareFrozenObjectCustody({...f.request(), dryRun}), /missing|validate/i);
  assert.equal(refs(mirror), '');
}));

test('missing local objects cannot be mistaken for borrowed objects', () => fixture(f => {
  seed(f); const request = f.request(), blob = git(f.source, ['rev-parse', 'HEAD:keep']);
  removeLoose(path.join(f.source, '.git'), blob);
  assert.throws(() => prepareFrozenObjectCustody(request), /missing object/);
}));

test('wrong existing boundary refs are never overwritten or deleted, including dry runs', () => fixture(f => {
  seed(f); const mirror = f.borrow(), request = f.request();
  const ref = `refs/pi-workspace-frozen/${request.id}/${request.head}/${request.head}`;
  const wrong = git(mirror, ['rev-parse', 'HEAD^{tree}']);
  git(mirror, ['update-ref', ref, wrong]);
  for (const dryRun of [true, false]) assert.throws(() => prepareFrozenObjectCustody({...request, dryRun}), /wrong object/);
  assert.equal(git(mirror, ['rev-parse', ref]), wrong);
}));

test('two concurrent identical pin writers preserve create-or-verify custody', () => fixture(async f => {
  f.async = true;
  seed(f); const mirror = f.borrow(), request = f.request();
  const module = fileURLToPath(new URL('./frozen-object-custody.mjs', import.meta.url));
  const program = `import {prepareFrozenObjectCustody} from ${JSON.stringify(module)};prepareFrozenObjectCustody(${JSON.stringify(request)});`;
  const run = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', program], {stdio: ['ignore', 'pipe', 'pipe']});
    let errors = ''; child.stderr.on('data', chunk => errors += chunk);
    child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(Error(errors)));
  });
  await Promise.all([run(), run()]);
  assert.equal(refs(mirror).split('\n').length, 1);
}));

test('gitlinks are not followed and injected Git object environments are ignored', () => fixture(f => {
  seed(f);
  git(f.source, ['update-index', '--add', '--cacheinfo', `160000,${'a'.repeat(40)},submodule`]);
  git(f.source, ['commit', '-qm', 'gitlink']);
  const request = f.request(), old = process.env.GIT_OBJECT_DIRECTORY;
  try {
    process.env.GIT_OBJECT_DIRECTORY = '/does-not-exist';
    assert.deepEqual(prepareFrozenObjectCustody(request), {kind: 'private-git'});
  } finally { if (old === undefined) delete process.env.GIT_OBJECT_DIRECTORY; else process.env.GIT_OBJECT_DIRECTORY = old; }
}));

test('more than 4096 borrowed boundary objects are rejected without publishing partial pins', () => fixture(f => {
  importBlobs(f.source, 4097); const mirror = f.borrow();
  // A local root tree containing mirror blobs makes each blob a genuine boundary root.
  fs.writeFileSync(path.join(f.source, 'local'), 'local\n'); f.commit();
  assert.throws(() => prepareFrozenObjectCustody(f.request()), /4096 boundary pins/);
  assert.equal(refs(mirror), '');
}));

test('more than 50000 local graph nodes are rejected with bounded batched object reads', () => fixture(f => {
  importBlobs(f.source, 50000);
  assert.throws(() => prepareFrozenObjectCustody(f.request()), /50000 local graph nodes/);
  assert.equal(refs(f.source), '');
}));
