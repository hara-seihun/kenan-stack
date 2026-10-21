import { afterEach, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const script = fileURLToPath(new URL('./prepare-build.sh', import.meta.url));
const roots: string[] = [];
afterEach(() => { for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true }); });

// A fake npm whose install and build each take long enough to overlap, and fail if another run touches their tree.
const npm = `#!/bin/bash
set -euo pipefail
echo "$1 $PWD" >> "$TRACE"
case "$1" in
 ci) rm -rf node_modules; mkdir node_modules; echo "$$" > node_modules/owner; sleep 0.4; test "$(cat node_modules/owner)" = "$$";;
 run) test -f node_modules/owner; rm -rf dist; mkdir -p dist/server; echo "$$" > dist/server/config.js; sleep 0.4; test "$(cat dist/server/config.js)" = "$$";;
esac
echo "$1-done $PWD" >> "$TRACE"
`;

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'kenan-prepare-')); roots.push(root);
  const checkout = join(root, 'checkout'), bin = join(root, 'bin'), trace = join(root, 'trace');
  mkdirSync(join(checkout, 'server/db'), { recursive: true }); mkdirSync(bin);
  writeFileSync(join(checkout, 'package.json'), '{}'); writeFileSync(join(checkout, 'package-lock.json'), '{"lock":1}');
  writeFileSync(join(checkout, 'server/db/schema.sql'), 'create table t();');
  writeFileSync(join(bin, 'npm'), npm, { mode: 0o755 }); writeFileSync(trace, '');
  const git = (...args: string[]) => execFileSync('git', ['-C', checkout, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' }).trim();
  git('init', '-q'); git('add', '.'); git('commit', '-qm', 'one');
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, TRACE: trace };
  const prepare = (commit: string) => run('bash', [script, checkout, commit], { env }).then(r => r.stdout.trim());
  return { checkout, git, prepare, trace: () => readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean) };
}

it('prepares two concurrent deploys in private trees without waiting on each other, then reuses the build', async () => {
  const f = fixture(), commit = f.git('rev-parse', 'HEAD');
  const [a, b] = await Promise.all([f.prepare(commit), f.prepare(commit)]);
  expect(a).toBe(b);
  const steps = f.trace().map(line => line.split(' ')[0]);
  expect(steps.slice(0, 2)).toEqual(['ci', 'ci']);
  expect(readFileSync(join(a, 'dist/server/db/schema.sql'), 'utf8')).toBe('create table t();');
  expect(readFileSync(join(a, 'node_modules/owner'), 'utf8')).toMatch(/^\d+\n$/);
  const dirs = f.trace().filter(line => !line.includes('-done ')).map(line => line.split(' ')[1]);
  expect(new Set(dirs).size).toBe(dirs.length);
  expect(existsSync(join(f.checkout, 'node_modules')) || existsSync(join(f.checkout, 'dist'))).toBe(false);
  const cache = join(f.checkout, '.git/kenan-deploy');
  for (const kind of ['builds', 'deps']) expect(readdirSync(join(cache, kind)).filter(n => n.startsWith('.tmp-'))).toEqual([]);

  const calls = f.trace().length;
  expect(await f.prepare(commit)).toBe(a);
  expect(f.trace()).toHaveLength(calls);

  writeFileSync(join(f.checkout, 'server/db/schema.sql'), 'create table u();'); f.git('commit', '-qam', 'two');
  const next = await f.prepare(f.git('rev-parse', 'HEAD'));
  expect(next).not.toBe(a);
  expect(f.trace().slice(calls).map(line => line.split(' ')[0])).toEqual(['run', 'run-done']);
  expect(readFileSync(join(a, 'dist/server/db/schema.sql'), 'utf8')).toBe('create table t();');
});
