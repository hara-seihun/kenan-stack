import './scratch-env.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFileSync, spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';

const cli = new URL('./workspace.mjs', import.meta.url).pathname;
test('terminal-safety native CLI reports its own selectors and JSON owner errors without effects', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'terminal-safety-cli-'));
  const repo = path.join(root, 'repo'), state = path.join(root, 'registry.sqlite3');
  const git = (...args) => execFileSync('git', args, {encoding:'utf8', timeout:5000}).trim();
  const run = args => spawnSync(process.execPath, [cli, 'terminal-safety', ...args, '--json'], {
    encoding:'utf8', timeout:5000, env:{...process.env, PI_WORKSPACE_STATE:state},
  });
  try {
    mkdirSync(repo); git('init', '-q', '-b', 'main', repo);
    git('-C', repo, 'config', 'user.name', 'Fixture');
    git('-C', repo, 'config', 'user.email', 'fixture@example.invalid');
    writeFileSync(path.join(repo, 'tracked'), 'preserved');
    git('-C', repo, 'add', '.'); git('-C', repo, 'commit', '-qm', 'fixture');
    const head = git('-C', repo, 'rev-parse', 'HEAD');
    const registered = spawnSync(process.execPath, [cli, 'register', '--path', repo, '--owner', 'fixture', '--source-commit', head, '--json'], {
      encoding:'utf8', timeout:10000, env:{...process.env, PI_WORKSPACE_STATE:state},
    });
    assert.equal(registered.status, 0, registered.stderr);
    const id = JSON.parse(registered.stdout).id;
    const snapshot = () => {
      const db = new DatabaseSync(state);
      try {
        return JSON.stringify(db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(({name}) =>
          [name, db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}" ORDER BY rowid`).all()]));
      } finally { db.close(); }
    };
    const before = snapshot();
    for (const args of [[], ['--owner','fixture'], ['--id',id,'--owner','fixture'], ['--path',repo,'--owner','fixture']]) {
      const result = run(args);
      assert.equal(result.status, 2, result.stderr);
      const body = JSON.parse(result.stdout);
      assert.equal(body.ok, false);
      assert.equal(body.error.code, 'invalid-workspace-selector');
      assert.equal(body.error.detail, 'terminal-safety requires --id ID --path PATH');
      assert.equal(body.error.nextAction.command, 'terminal-safety');
      assert.deepEqual(body.error.nextAction.selector, {kind:'all',flags:['id','path']});
      assert.doesNotMatch(result.stdout + result.stderr, /retire-growth/);
    }
    for (const owner of [[], ['--owner','']]) {
      const result = run(['--id',id,'--path',repo,...owner]);
      assert.equal(result.status, 2, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), {ok:false,error:{code:'invalid-request',detail:'--owner is required'}});
    }
    for (const [args, code] of [
      [['--id',id,'--path',repo,'--owner','wrong'], 'stale-growth-disposition'],
      [['--id',id,'--path',root,'--owner','fixture'], 'growth-identity-changed'],
    ]) {
      const result = run(args);
      assert.equal(result.status, 2, result.stderr);
      assert.equal(JSON.parse(result.stdout).error.code, code);
    }
    assert.equal(snapshot(), before, 'diagnostics must not change registry rows or capacity');
    assert.equal(readFileSync(path.join(repo,'tracked'),'utf8'), 'preserved');
    assert.equal(git('-C',repo,'rev-parse','HEAD'), head);
  } finally { rmSync(root, {recursive:true, force:true}); }
});
