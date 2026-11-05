import './scratch-env.mjs';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {dependencyLinkCensus, dependencyLinkReferences, dependencyLinkChain} from './safety-census.mjs';
import {main} from './workspace.mjs';

// November 5, converge-kenan: derek-build-progress/node_modules was a manual symlink to
// gabriel-retest-ui-c3b2/node_modules. The donor's ordinary release saw no process, unit,
// container or thread in its checkout, retired node_modules and removed the checkout; the
// borrower's frozen screenshot run then failed with exit 254. A symlink from another
// checkout is structural custody even while no process is running.
const entry = new URL('./main', import.meta.url).pathname;
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], {encoding: 'utf8'}).trim();

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'dependency-link-')), source = path.join(root, 'source'), remote = path.join(root, 'remote.git');
  mkdirSync(source);
  git(source, 'init', '-b', 'main'); git(source, 'config', 'user.name', 'Test'); git(source, 'config', 'user.email', 'test@example.invalid');
  writeFileSync(path.join(source, '.gitignore'), 'node_modules/\nnode_modules\n');
  writeFileSync(path.join(source, 'file.txt'), 'source\n');
  git(source, 'add', '.'); git(source, 'commit', '-m', 'source');
  execFileSync('git', ['clone', '-q', '--bare', source, remote]);
  git(source, 'remote', 'add', 'origin', remote); git(source, 'push', '-q', '-u', 'origin', 'main');
  const env = {...process.env, PI_WORKSPACE_STATE: path.join(root, 'state', 'registry.sqlite3'), PI_WORKSPACE_TEST_EXTERNAL_SAFETY: 'empty'};
  const once = args => {
    try { return JSON.parse(execFileSync(entry, args, {env, encoding: 'utf8', timeout: 90_000})); }
    catch (error) { if ([2, 75].includes(error.status) && error.stdout) return JSON.parse(error.stdout); throw error; }
  };
  // Creation prepares source in a durable job; repeating the same request continues it.
  const run = args => {
    for (const deadline = Date.now() + 90_000; ;) {
      const output = once(args);
      if (args[0] !== 'create' || output.state === 'active' || output.ok === false || Date.now() > deadline) return output;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  };
  // Release runs in process as an operator would from a background unit, so a test
  // started inside a native tool call never submits a real background release.
  const release = target => {
    let out = ''; const write = process.stdout.write, exit = process.exitCode, safety = process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY;
    process.exitCode = undefined; process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY = 'empty'; process.stdout.write = chunk => { out += chunk; return true; };
    try { main(['release', '--path', target, '--json'], env.PI_WORKSPACE_STATE, {releaseScopeOverride: {background: true}}); return JSON.parse(out); }
    finally { process.stdout.write = write; process.exitCode = exit; if (safety === undefined) delete process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY; else process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY = safety; }
  };
  const workspaces = path.join(root, 'workspaces');
  const create = name => run(['create', '--root', workspaces, '--name', name, '--repo', source, '--min-free-gib', '0', '--json']);
  return {root, workspaces, run, create, release, close: () => rmSync(root, {recursive: true, force: true})};
}

test('release keeps a donor whose dependencies a frozen registered borrower links, directly or through a dangling chain', () => {
  const f = fixture();
  try {
    const donor = f.create('donor'), borrower = f.create('borrower');
    assert.equal(donor.state, 'active'); assert.equal(borrower.state, 'active');
    const payload = path.join(donor.path, 'node_modules', 'tailwindcss', 'index.js');
    mkdirSync(path.dirname(payload), {recursive: true}); writeFileSync(payload, 'dependency bytes');
    // The consumer runs nothing right now: only its symlink holds the dependency.
    symlinkSync(path.join(donor.path, 'node_modules'), path.join(borrower.path, 'node_modules'));

    const retained = f.release(donor.path);
    assert.equal(retained.inspection.classification, 'referenced', JSON.stringify(retained.inspection));
    assert.match(retained.inspection.reason, /dependency symlink/);
    assert.ok(retained.inspection.dependencyLinks.some(link => link.path === path.join(borrower.path, 'node_modules')));
    assert.equal(readFileSync(path.join(borrower.path, 'node_modules', 'tailwindcss', 'index.js'), 'utf8'), 'dependency bytes');
    assert.equal(existsSync(payload), true);

    // Indirect: an unregistered root member links through a symlinked directory alias,
    // and the chain ends at a path inside the donor. The direct link is gone.
    unlinkSync(path.join(borrower.path, 'node_modules'));
    const alias = path.join(f.workspaces, 'donor-alias'), member = path.join(f.workspaces, 'unregistered-consumer');
    symlinkSync(donor.path, alias); mkdirSync(member);
    symlinkSync('../donor-alias/node_modules', path.join(member, 'node_modules'));
    const indirect = f.release(donor.path);
    assert.equal(indirect.inspection.classification, 'referenced', JSON.stringify(indirect.inspection));
    assert.equal(existsSync(payload), true);

    // Positive control: once no link reaches the donor, the ordinary release removes it.
    unlinkSync(path.join(member, 'node_modules')); unlinkSync(alias);
    const released = f.release(donor.path);
    assert.equal(released.action, 'released', JSON.stringify(released));
    assert.equal(existsSync(donor.path), false);
  } finally { f.close(); }
});

test('a dangling borrower link still protects the path it names; links inside the released roots do not', () => {
  const base = mkdtempSync(path.join(tmpdir(), 'dependency-link-unit-'));
  try {
    const donor = path.join(base, 'donor'), consumer = path.join(base, 'consumer'), nested = path.join(base, 'mono');
    mkdirSync(donor); mkdirSync(consumer); mkdirSync(path.join(nested, 'products', 'app'), {recursive: true});
    writeFileSync(path.join(nested, 'package.json'), JSON.stringify({workspaces: ['products/*']}));
    symlinkSync(path.join(donor, 'node_modules'), path.join(consumer, 'node_modules'));          // dangling: target already gone
    symlinkSync(path.join(donor, 'node_modules'), path.join(nested, 'products', 'app', 'node_modules')); // package-directory link
    symlinkSync('node_modules', path.join(donor, 'self-link'));                                    // inside the donor itself
    const rows = [donor, consumer, nested].map((value, index) => ({id: String(index), path: value, root: base, checkoutType: 'clone'}));
    const links = dependencyLinkCensus(rows);
    const references = dependencyLinkReferences([donor], links).map(link => link.path).sort();
    assert.deepEqual(references, [path.join(consumer, 'node_modules'), path.join(nested, 'products', 'app', 'node_modules')].sort());
    // Generated-cache retirement of the donor's node_modules is protected the same way,
    // including by a link elsewhere in the donor that outlives the cache.
    assert.equal(dependencyLinkReferences([path.join(donor, 'node_modules')], links).length, 3);
    assert.deepEqual(dependencyLinkReferences([path.join(donor, 'dist')], links), []);
    // An unbounded chain is an incomplete observation, never a clear verdict.
    symlinkSync('loop-b', path.join(base, 'loop-a')); symlinkSync('loop-a', path.join(base, 'loop-b'));
    assert.throws(() => dependencyLinkChain(path.join(base, 'loop-a')), /exceeds|ELOOP/);
  } finally { rmSync(base, {recursive: true, force: true}); }
});

test('an intermediate alias another checkout chains through is custody; a peer of the same donor is not', () => {
  const base = mkdtempSync(path.join(tmpdir(), 'dependency-link-alias-'));
  try {
    const donor = path.join(base, 'donor'), alias = path.join(base, 'alias'), chained = path.join(base, 'chained'), peer = path.join(base, 'peer');
    for (const directory of [donor, alias, chained, peer]) mkdirSync(directory);
    mkdirSync(path.join(donor, 'node_modules'));
    symlinkSync(path.join(donor, 'node_modules'), path.join(alias, 'node_modules'));   // W -> A
    symlinkSync(path.join(alias, 'node_modules'), path.join(chained, 'node_modules')); // V -> W -> A
    symlinkSync(path.join(donor, 'node_modules'), path.join(peer, 'node_modules'));    // P -> A
    const rows = [donor, alias, chained, peer].map((value, index) => ({id: String(index), path: value, root: base, checkoutType: 'clone'}));
    const links = dependencyLinkCensus(rows);
    // Releasing W or unlinking its alias would break V's pathname: retained.
    assert.deepEqual(dependencyLinkReferences([alias], links).map(link => link.path), [path.join(chained, 'node_modules')]);
    assert.deepEqual(dependencyLinkReferences([path.join(alias, 'node_modules')], links).map(link => link.path), [path.join(chained, 'node_modules')]);
    // Once V is gone, a peer of the same donor never blocks W's otherwise unborrowed alias.
    rmSync(chained, {recursive: true});
    assert.deepEqual(dependencyLinkReferences([path.join(alias, 'node_modules')], dependencyLinkCensus(rows)), []);
    // The donor itself stays protected by both remaining links.
    assert.equal(dependencyLinkReferences([donor], dependencyLinkCensus(rows)).length, 2);
  } finally { rmSync(base, {recursive: true, force: true}); }
});
