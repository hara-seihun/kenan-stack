#!/usr/bin/env node
// Changed tests give feedback after shipping, never permission to ship. Failures use the existing host-event repair path.
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, symlinkSync, openSync, closeSync, rmSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const entry = fileURLToPath(import.meta.url);
const home = userInfo().homedir || homedir();
const root = join(home, '.local/state/kenan-background-checks');
const relay = join(home, '.config/kenan-peer-relay/acme.json');
const [command, repoArg, baseArg, tipArg] = process.argv.slice(2);
const repo = resolve(repoArg || '.');
const run = (bin, args, options = {}) => spawnSync(bin, args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, ...options });
const git = (...args) => {
  const r = run('git', ['-C', repo, ...args]);
  if (r.status !== 0) throw new Error(r.stderr || r.error?.message || `git ${args[0]} failed`);
  return r.stdout.trim();
};
const read = path => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };
const save = (path, value) => {
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(value, null, 2) + '\n'); renameSync(temp, path);
};
const event = (tip, detail) => {
  const r = run('kenan-event', ['--id', `background-check:${tip}:${detail.status}`, 'goal-0918c2aa-86f8-47ba-a2eb-4b723fafc31c:fixture-check'], {
    input: JSON.stringify({ tip, status: 'failed', checkStatus: detail.status, repo: detail.repo, log: detail.log, result: detail.result, error: detail.error,
      failures: detail.failures?.map(f => ({ file: f.file, name: f.name })), action: 'Please repair these Stack fixture checks on goal 0918c2aa-86f8-47ba-a2eb-4b723fafc31c now, without holding any deploy or export. Compare the failing existing tests with the intentional interface changes and their authors (git log). Automatically update fixture-only drift in rewrite/app-polish, preserving meaningful assertions, check the changed behavior once, and include the repair in the next export. Send real behavior breaks to the change author instead of changing the expectation. Do not bless failures with snapshots or bulk expected-value replacement.' }),
  });
  if (r.status !== 0) console.error('background_check_event_failed:', r.stderr || r.error?.message);
};
const copyManifest = dir => {
  const exported = read(join(dir, 'export.json'));
  if (!exported) return;
  const result = read(join(dir, 'result.json'));
  const path = join(dir, 'manifest.json');
  const { tip, base, status, checkExitCode, testExitCode, databaseAvailable, skippedDatabaseSuites, skippedTests, completedAt } = result;
  save(path, { tip, backgroundCheck: { base, status, checkExitCode, testExitCode, databaseAvailable, skippedDatabaseSuites, skippedTests, completedAt } });
  // Export and check completion may publish concurrently. Each write owns its temporary file.
  // Initial feedback may create the sidecar, but can never replace a completed result.
  const target = `${exported.remote}.json`;
  const temp = `${target}.${randomUUID()}.partial`;
  const publish = completedAt ? `mv -f '${temp}' '${target}'` : `(ln '${temp}' '${target}' 2>/dev/null || test -f '${target}') && rm -f '${temp}'`;
  const r = run('ssh', ['acme-host', `cat > '${temp}' && ${publish}`], { input: readFileSync(path) });
  if (r.status !== 0) throw new Error(`background_check_manifest_copy_failed: ${r.stderr?.trim() || r.error?.message || `ssh exited ${r.status}`}`);
};

async function main() {
  // This hook belongs to the exporting account. Other household accounts and Acme keep their own process.
  if (!existsSync(relay)) return;
  mkdirSync(root, { recursive: true });
  const tip = git('rev-parse', '--verify', `${tipArg || 'HEAD'}^{commit}`);
  const manifest = run('git', ['-C', repo, 'show', `${tip}:package.json`]);
  // Bundle script fixtures also export tiny example repositories. They are not application releases.
  if (manifest.status !== 0 || JSON.parse(manifest.stdout).name !== 'kenan-stack') return;
  const dir = join(root, tip);
  mkdirSync(dir, { recursive: true });
  const resultPath = join(dir, 'result.json');
  if (command === 'start' || command === 'export') {
    if (command === 'export') save(join(dir, 'export.json'), { remote: `/var/tmp/kenan-stack-${tip}` });
    let result = read(resultPath);
    if (!result) {
      const previous = read(join(root, 'last-export.json'))?.tip;
      // The first installation checks the last commit; later runs cover every change since the previous export.
      const candidate = previous && previous !== tip ? previous : baseArg && baseArg !== '-' ? baseArg : `${tip}^`;
      const base = git('merge-base', candidate, tip);
      result = { tip, base, status: 'queued', skippedDatabaseSuites: null, createdAt: new Date().toISOString() };
      save(resultPath, result);
    }
    if (!['passed', 'failed'].includes(result.status)) {
      const runtime = `/run/user/${process.getuid()}`;
      const env = { ...process.env, HOME: home, XDG_RUNTIME_DIR: runtime, DBUS_SESSION_BUS_ADDRESS: `unix:path=${runtime}/bus` };
      const unit = `kenan-fixture-check-${tip}`;
      const active = run('systemctl', ['--user', 'is-active', '--quiet', `${unit}.service`], { env });
      if (active.status !== 0) {
        const launched = run('systemd-run', ['--user', '--quiet', '--collect', '--unit', unit,
          '--property=Slice=user-agents-kenanbg.slice', '--property=UMask=0022',
          `--property=StandardOutput=append:${join(dir, 'log')}`, '--property=StandardError=inherit',
          '--setenv', `HOME=${home}`, '--setenv', `PATH=${process.env.PATH}`,
          ...(process.env.KENAN_TEST_DATABASE_URL ? ['--setenv=KENAN_TEST_DATABASE_URL'] : []),
          process.execPath, entry, 'run', repo, result.base, tip], { env });
        if (launched.status !== 0 && run('systemctl', ['--user', 'is-active', '--quiet', `${unit}.service`], { env }).status !== 0)
          throw new Error(launched.stderr || 'background_check_launch_failed');
      }
    }
    if (command === 'export') {
      copyManifest(dir);
      save(join(root, 'last-export.json'), { tip });
    }
    console.log(`Changed-test feedback ${result.status}: ${join(dir, 'log')}`);
    return;
  }
  if (command !== 'run') throw new Error('Usage: background-check.mjs start|export|run REPO BASE TIP');
  const result = read(resultPath);
  result.status = 'running'; save(resultPath, result);
  const tree = join(dir, 'source');
  const log = join(dir, 'log');
  const output = openSync(log, 'a');
  const execute = (bin, args, cwd = tree) => {
    const r = run(bin, args, { cwd, stdio: ['ignore', output, output] });
    if (r.error) throw r.error;
    return r.status ?? 1;
  };
  try {
    if (execute('git', ['clone', '--quiet', '--shared', '--no-checkout', repo, tree], dir)) throw new Error('background_check_clone_failed');
    if (execute('git', ['checkout', '--quiet', '--detach', tip])) throw new Error('background_check_checkout_failed');
    // A deployment's immutable dependency cache contains dev dependencies. Never use a live server's runtime-only modules.
    const candidates = [join(home, '.cache/kenan-deploy/builds', tip), repo];
    const deps = candidates.find(p => existsSync(join(p, 'node_modules/typescript')) && existsSync(join(p, 'node_modules/vitest')) &&
      existsSync(join(p, 'package-lock.json')) && readFileSync(join(p, 'package-lock.json')).equals(readFileSync(join(tree, 'package-lock.json'))));
    if (deps) symlinkSync(join(deps, 'node_modules'), join(tree, 'node_modules'));
    else if (execute('npm', ['ci', '--no-audit', '--no-fund'])) throw new Error('background_check_dependencies_failed');
    result.checkExitCode = execute('npm', ['run', 'check']);
    result.testExitCode = execute('npm', ['test', '--', '--project', 'suites', '--changed', result.base, '--passWithNoTests', '--reporter=json', `--outputFile=${join(dir, 'tests.json')}`]);
    const report = read(join(dir, 'tests.json'));
    const hasDatabase = Boolean(process.env.KENAN_TEST_DATABASE_URL || existsSync('/run/kenan/pg/.s.PGSQL.5432'));
    result.databaseAvailable = hasDatabase;
    result.skippedDatabaseSuites = [];
    result.skippedTests = [];
    result.failures = [];
    for (const suite of report?.testResults ?? []) {
      const file = suite.name.startsWith(tree + '/') ? suite.name.slice(tree.length + 1) : suite.name;
      const text = existsSync(suite.name) ? readFileSync(suite.name, 'utf8') : '';
      const databaseGroups = [...text.matchAll(/describe\.skipIf\(!testDatabaseUrl\)\(\s*('(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`)/g)]
        .map(m => m[1].slice(1, -1).replace(/\\(['"`\\])/g, '$1'));
      for (const assertion of suite.assertionResults ?? []) {
        if (['pending', 'skipped', 'todo', 'disabled'].includes(assertion.status)) {
          result.skippedTests.push({ file, name: assertion.fullName });
          if (!hasDatabase && databaseGroups.some(group => assertion.ancestorTitles?.includes(group))) {
            if (!result.skippedDatabaseSuites.some(s => s.file === file && s.name === assertion.ancestorTitles.join(' > ')))
              result.skippedDatabaseSuites.push({ file, name: assertion.ancestorTitles.join(' > ') });
          }
        }
        if (assertion.status === 'failed') result.failures.push({ file, name: assertion.fullName, messages: assertion.failureMessages });
      }
      if (suite.status === 'failed' && !suite.assertionResults?.some(a => a.status === 'failed')) result.failures.push({ file, message: suite.message });
    }
    result.status = result.checkExitCode === 0 && result.testExitCode === 0 ? 'passed' : 'failed';
    result.completedAt = new Date().toISOString();
    save(resultPath, result);
    if (result.status === 'failed') event(tip, { ...result, repo, log, result: resultPath });
  } catch (error) {
    result.status = 'failed'; result.error = String(error); result.completedAt = new Date().toISOString();
    save(resultPath, result); event(tip, { ...result, repo, log, result: resultPath });
  } finally {
    closeSync(output);
    try { copyManifest(dir); } catch (error) { event(tip, { status: 'manifest-failed', error: String(error), result: resultPath }); }
    // Only this job's generated checkout is removed. Logs and the machine-readable result remain for the repair worker.
    rmSync(tree, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); try { event(tipArg || 'unknown', { status: 'launch-failed', error: String(error), repo }); } catch {} process.exitCode = 1; });
