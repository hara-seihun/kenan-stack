import './scratch-env.mjs';
import './source-lineage.test.mjs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const tool = fileURLToPath(new URL('.', import.meta.url));
const source = path.resolve(tool, '../..');
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], {encoding: 'utf8'}).trim();

test('component deployment retains other tools and fences unrelated source and publication reservations', () => {
  const temporary = mkdtempSync(path.join(tmpdir(), 'workspace-deploy-'));
  try {
    const repository = path.join(temporary, 'source');
    mkdirSync(path.join(repository, 'tools'), {recursive: true});
    mkdirSync(path.join(repository, 'deploy'));
    cpSync(tool, path.join(repository, 'tools/agent-workspace'), {recursive: true});
    for (const name of ['lib', 'release-checkout']) cpSync(path.join(source, 'deploy', name), path.join(repository, 'deploy', name));
    mkdirSync(path.join(repository, 'tools/other'));
    writeFileSync(path.join(repository, 'tools/other/body'), 'other tool unchanged\n');
    git(repository, 'init', '-b', 'main');
    git(repository, 'config', 'user.name', 'Test');
    git(repository, 'config', 'user.email', 'test@example.invalid');
    git(repository, 'add', '.');
    git(repository, 'commit', '-m', 'baseline');
    const baseline = git(repository, 'rev-parse', 'HEAD');
    const releases = path.join(temporary, 'releases');
    const selected = path.join(releases, 'tools', baseline);
    mkdirSync(selected, {recursive: true});
    cpSync(path.join(repository, 'tools/agent-workspace'), path.join(selected, 'agent-workspace'), {recursive: true});
    cpSync(path.join(repository, 'tools/other'), path.join(selected, 'other'), {recursive: true});
    mkdirSync(path.join(temporary, 'dependencies'));
    symlinkSync(path.join(temporary, 'dependencies'), path.join(selected, 'node_modules'));
    writeFileSync(path.join(selected, '.pi-stack-commit'), baseline + '\n');
    writeFileSync(path.join(selected,'.agent-workspace-component.json'),JSON.stringify({source:'historical'}));
    const destination = path.join(temporary, 'tools');
    symlinkSync(selected, destination);
    const original = readFileSync(path.join(repository, 'tools/agent-workspace/README.md'), 'utf8');
    writeFileSync(path.join(repository, 'tools/agent-workspace/README.md'), original + '\nComponent candidate.\n');
    git(repository, 'commit', '-am', 'component repair');
    const commit = git(repository, 'rev-parse', 'HEAD');
    const hostLock = path.join(temporary, 'host.lock');
    const environment = {...process.env, PI_STACK_TOOLS_DEST: destination, PI_STACK_RELEASES_ROOT: releases,
      PI_STACK_HOST_LOCK_PATH: hostLock, PI_STACK_DEPLOY_NO_SUDO: '1'};
    for (const key of ['PI_STACK_HOST_LOCK_HELD', 'PI_STACK_DEPLOY_LOCK_HELD', 'PI_STACK_DEPLOY_DEADLINE_ACTIVE', 'PI_STACK_PUBLICATION_REQUEST']) delete environment[key];
    const deploy = () => execFileSync(path.join(repository, 'tools/agent-workspace/deploy'), [], {env: environment, encoding: 'utf8', timeout: 10000});
    assert.match(deploy(), /no services or workspace records changed/);
    assert.equal(readlinkSync(destination), path.join(releases, 'tools', commit));
    assert.equal(existsSync(path.join(destination,'.agent-workspace-component.json')),false);
    assert.equal(readlinkSync(path.join(destination, 'node_modules')), path.join(temporary, 'dependencies'));
    assert.equal(readFileSync(path.join(destination, 'other/body'), 'utf8'), 'other tool unchanged\n');
    assert.equal(readFileSync(path.join(selected, 'agent-workspace/README.md'), 'utf8'), original);
    assert.equal(git(repository, 'ls-tree', 'HEAD', '--', 'tools/agent-workspace/background-launch.mjs').split(' ')[0], (execFileSync('stat', ['-c', '%a', path.join(destination, 'agent-workspace/background-launch.mjs')], {encoding: 'utf8'}).trim() === '755' ? '100755' : '100644'));
    const receipt = JSON.parse(readFileSync(path.join(destination, 'agent-workspace/.component-release.json')));
    assert.equal(receipt.baseline, baseline);
    assert.equal(git(receipt.sourceRepository, 'rev-parse', `refs/agent-workspace/deployed/${commit}`), commit);
    writeFileSync(hostLock + '.publication', JSON.stringify({requestId: 'different-owner', integrationSha: commit}));
    assert.throws(deploy, /publication reserves this host/);
    rmSync(hostLock + '.publication');
    writeFileSync(path.join(repository, 'tools/other/body'), 'unrelated candidate\n');
    git(repository, 'commit', '-am', 'unrelated change');
    assert.throws(deploy, /refuses changes to other tools/);
    assert.equal(readlinkSync(destination), path.join(releases, 'tools', commit));
    assert.equal(existsSync(path.join(destination,'.agent-workspace-component.json')),false);
    assert.equal(existsSync(path.join(releases, 'tools', git(repository, 'rev-parse', 'HEAD'))), false);
  } finally { rmSync(temporary, {recursive: true, force: true}); }
});

test('an unavailable selected source deploys only over installed bytes equal to an ancestor component tree', () => {
  const temporary = mkdtempSync(path.join(tmpdir(), 'workspace-deploy-content-'));
  try {
    const repository = path.join(temporary, 'source');
    mkdirSync(path.join(repository, 'tools'), {recursive: true});
    mkdirSync(path.join(repository, 'deploy'));
    cpSync(tool, path.join(repository, 'tools/agent-workspace'), {recursive: true});
    for (const name of ['lib', 'release-checkout']) cpSync(path.join(source, 'deploy', name), path.join(repository, 'deploy', name));
    git(repository, 'init', '-b', 'main');
    git(repository, 'config', 'user.name', 'Test');
    git(repository, 'config', 'user.email', 'test@example.invalid');
    git(repository, 'add', '.');
    git(repository, 'commit', '-m', 'public projection');
    const unavailable = 'f'.repeat(40);
    const releases = path.join(temporary, 'releases');
    const selected = path.join(releases, 'tools', unavailable);
    mkdirSync(selected, {recursive: true});
    cpSync(path.join(repository, 'tools/agent-workspace'), path.join(selected, 'agent-workspace'), {recursive: true});
    rmSync(path.join(selected, 'agent-workspace/deploy'));
    writeFileSync(path.join(selected, 'agent-workspace/.component-release.json'), JSON.stringify({sourceCommit: unavailable}) + '\n');
    writeFileSync(path.join(selected, '.pi-stack-commit'), unavailable + '\n');
    const destination = path.join(temporary, 'tools');
    symlinkSync(selected, destination);
    writeFileSync(path.join(repository, 'tools/agent-workspace/README.md'), readFileSync(path.join(repository, 'tools/agent-workspace/README.md'), 'utf8') + '\nComponent candidate.\n');
    git(repository, 'commit', '-am', 'component repair');
    const environment = {...process.env, PI_STACK_TOOLS_DEST: destination, PI_STACK_RELEASES_ROOT: releases,
      PI_STACK_HOST_LOCK_PATH: path.join(temporary, 'host.lock'), PI_STACK_DEPLOY_NO_SUDO: '1'};
    for (const key of ['PI_STACK_HOST_LOCK_HELD', 'PI_STACK_DEPLOY_LOCK_HELD', 'PI_STACK_DEPLOY_DEADLINE_ACTIVE', 'PI_STACK_PUBLICATION_REQUEST']) delete environment[key];
    const deploy = () => execFileSync(path.join(repository, 'tools/agent-workspace/deploy'), [], {env: environment, encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe']});
    writeFileSync(path.join(selected, 'agent-workspace/workspace.mjs'), '// installed bytes no ancestor has\n');
    assert.throws(deploy);
    assert.equal(readlinkSync(destination), selected);
    cpSync(path.join(tool, 'workspace.mjs'), path.join(selected, 'agent-workspace/workspace.mjs'));
    assert.match(deploy(), /no services or workspace records changed/);
    assert.equal(readlinkSync(destination), path.join(releases, 'tools', git(repository, 'rev-parse', 'HEAD')));
  } finally { rmSync(temporary, {recursive: true, force: true}); }
});
