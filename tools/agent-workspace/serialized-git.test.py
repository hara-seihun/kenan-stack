"""Regression tests for tools/agent-workspace/serialized-git.

The wrapper must pass nonmutating Git commands straight through to /usr/bin/git and
hold a kernel flock on <git common dir>/agent-workspace-fetch.lock around fetch,
pull, gc, repack, prune and maintenance. These tests use real Git, a slow logging
upload-pack and a test-held flock; nothing is installed globally.

Run: python3 tools/agent-workspace/serialized-git.test.py
"""
import fcntl, os, subprocess, sys, tempfile, time, unittest
from pathlib import Path

sys.dont_write_bytecode = True
WRAPPER = Path(__file__).with_name('serialized-git')
GIT = '/usr/bin/git'
LOCK = 'agent-workspace-fetch.lock'
SLEEP = 1.5


class SerializedGit(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        home = self.root / 'home'
        home.mkdir()
        self.env = dict(os.environ, HOME=str(home), GIT_CONFIG_NOSYSTEM='1', GIT_TERMINAL_PROMPT='0',
                        GIT_AUTHOR_NAME='t', GIT_AUTHOR_EMAIL='t@example.invalid',
                        GIT_COMMITTER_NAME='t', GIT_COMMITTER_EMAIL='t@example.invalid')
        for k in ('GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE'):
            self.env.pop(k, None)
        # Source repository with three branches whose tips the fetchers must receive.
        self.src = self.root / 'src'
        self.git('init', '-q', '-b', 'main', str(self.src))
        self.tips = {}
        for branch in ('main', 'a', 'b'):
            if branch != 'main':
                self.git('-C', str(self.src), 'checkout', '-q', '-b', branch, 'main')
            (self.src / f'{branch}.txt').write_text(branch * 1000)
            self.git('-C', str(self.src), 'add', '.')
            self.git('-C', str(self.src), 'commit', '-q', '-m', branch)
            self.tips[branch] = self.git('-C', str(self.src), 'rev-parse', 'HEAD').strip()
        self.git('-C', str(self.src), 'checkout', '-q', 'main')
        # Consumer checkout plus a linked worktree sharing its common dir.
        self.repo = self.root / 'repo'
        self.git('init', '-q', '-b', 'main', str(self.repo))
        (self.repo / 'seed').write_text('seed')
        self.git('-C', str(self.repo), 'add', '.')
        self.git('-C', str(self.repo), 'commit', '-q', '-m', 'seed')
        self.wt = self.root / 'wt'
        self.git('-C', str(self.repo), 'worktree', 'add', '-q', '-b', 'side', str(self.wt))
        self.common = self.repo / '.git'
        self.assertEqual(Path(self.git('-C', str(self.wt), 'rev-parse', '--path-format=absolute', '--git-common-dir').strip()), self.common)
        # Slow upload-pack that logs when it starts and when it ends.
        self.log = self.root / 'upload-pack.log'
        self.slow = self.root / 'slow-upload-pack'
        self.slow.write_text(
            '#!/bin/sh\n'
            f'echo "start $$ $(date +%s%N)" >> "{self.log}"\n'
            f'sleep {SLEEP}\n'
            f'{GIT} upload-pack "$@"\nrc=$?\n'
            f'echo "end $$ $(date +%s%N)" >> "{self.log}"\n'
            'exit $rc\n')
        self.slow.chmod(0o755)

    def tearDown(self):
        self.tmp.cleanup()

    def git(self, *args, cwd=None):
        r = subprocess.run([GIT, *args], cwd=cwd, env=self.env, capture_output=True, text=True, timeout=60)
        self.assertEqual(r.returncode, 0, f'git {args}: {r.stderr}')
        return r.stdout

    def wrap(self, *args, cwd=None, timeout=60):
        return subprocess.run([sys.executable, str(WRAPPER), *args], cwd=cwd, env=self.env,
                              capture_output=True, text=True, timeout=timeout)

    def spawn(self, *args, cwd=None, real=False):
        cmd = [GIT, *args] if real else [sys.executable, str(WRAPPER), *args]
        return subprocess.Popen(cmd, cwd=cwd, env=self.env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)

    def fetch_args(self, branch):
        return ['fetch', '--no-tags', f'--upload-pack={self.slow}', str(self.src),
                f'+refs/heads/{branch}:refs/remotes/src/{branch}']

    def intervals(self):
        spans = {}
        for line in self.log.read_text().splitlines():
            kind, pid, ns = line.split()
            spans.setdefault(pid, {})[kind] = int(ns)
        return sorted((s['start'], s['end']) for s in spans.values())

    def wait_for_log_start(self, timeout=20):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if self.log.exists() and 'start' in self.log.read_text():
                return
            time.sleep(0.02)
        self.fail('upload-pack never started')

    def hold_lock(self):
        fd = os.open(self.common / LOCK, os.O_RDWR | os.O_CREAT, 0o644)
        fcntl.flock(fd, fcntl.LOCK_EX)
        return fd

    def assert_lock_is_held(self):
        fd = os.open(self.common / LOCK, os.O_RDWR | os.O_CREAT, 0o644)
        try:
            with self.assertRaises(BlockingIOError):
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        finally:
            os.close(fd)

    def assert_fetched(self, branch, cwd):
        self.assertEqual(self.git('-C', str(cwd), 'rev-parse', f'refs/remotes/src/{branch}').strip(), self.tips[branch])
        self.git('-C', str(cwd), 'cat-file', '-e', f'{self.tips[branch]}^{{tree}}')
        self.git('-C', str(cwd), 'rev-list', '--objects', self.tips[branch])

    def test_wrapper_exists_and_is_executable(self):
        self.assertTrue(WRAPPER.is_file(), WRAPPER)
        self.assertTrue(os.access(WRAPPER, os.X_OK), 'serialized-git must be executable')

    def test_negative_control_real_git_fetches_overlap(self):
        """Proves the fixture would detect overlap if the wrapper did not serialize."""
        p1 = self.spawn(*self.fetch_args('a'), cwd=self.repo, real=True)
        p2 = self.spawn('-C', str(self.wt), *self.fetch_args('b'), real=True)
        for p in (p1, p2):
            out, err = p.communicate(timeout=60)
            self.assertEqual(p.returncode, 0, err)
        (s1, e1), (s2, e2) = self.intervals()
        self.assertLess(s2, e1, 'unwrapped concurrent fetches should overlap in this fixture')

    def test_concurrent_fetches_through_main_and_linked_worktree_do_not_overlap(self):
        p1 = self.spawn(*self.fetch_args('a'), cwd=self.repo)
        p2 = self.spawn('-C', str(self.wt), *self.fetch_args('b'), cwd=self.root)
        self.wait_for_log_start()
        self.assert_lock_is_held()  # first fetch holds the common-dir flock while upload-pack runs
        for p in (p1, p2):
            out, err = p.communicate(timeout=120)
            self.assertEqual(p.returncode, 0, err)
        spans = self.intervals()
        self.assertEqual(len(spans), 2, spans)
        (s1, e1), (s2, e2) = spans
        self.assertLessEqual(e1, s2, f'upload-pack sessions overlapped: {spans}')
        self.assertGreaterEqual((e1 - s1) / 1e9, SLEEP)
        self.assertTrue((self.common / LOCK).exists(), 'lock must live in the Git common dir')
        self.assertFalse((self.common / 'worktrees' / 'wt' / LOCK).exists(), 'lock must not live in the per-worktree gitdir')
        for cwd in (self.repo, self.wt):
            self.assert_fetched('a', cwd)
            self.assert_fetched('b', cwd)
        self.git('-C', str(self.repo), 'fsck', '--connectivity-only', '--no-dangling')

    def test_fetch_waits_for_held_lock_then_completes(self):
        fd = self.hold_lock()
        try:
            p = self.spawn('-C', str(self.wt), *self.fetch_args('a'), cwd=self.root)
            time.sleep(1.0)
            self.assertIsNone(p.poll(), 'fetch must block while the lock is held')
            self.assertFalse(self.log.exists(), 'upload-pack must not start before the lock is acquired')
        finally:
            fcntl.flock(fd, fcntl.LOCK_UN)
            os.close(fd)
        out, err = p.communicate(timeout=120)
        self.assertEqual(p.returncode, 0, err)
        self.assert_fetched('a', self.repo)

    def test_every_mutating_maintenance_command_takes_the_lock(self):
        self.git('-C', str(self.repo), 'remote', 'add', 'src', str(self.src))
        self.git('-C', str(self.repo), 'fetch', '-q', 'src')
        self.git('-C', str(self.wt), 'checkout', '-q', '-B', 'track', 'src/main')
        commands = {
            'fetch': ['fetch', '-q', 'src'],
            'pull': ['pull', '-q', '--ff-only', 'src', 'main'],
            'gc': ['gc', '-q', '--prune=now'],
            'repack': ['repack', '-q', '-d'],
            'prune': ['prune'],
            'maintenance': ['maintenance', 'run', '--task=gc', '--quiet'],
            'config-option-before-fetch': ['-c', 'core.abbrev=12', 'fetch', '-q', 'src'],
        }
        for name, args in commands.items():
            with self.subTest(command=name):
                fd = self.hold_lock()
                try:
                    p = self.spawn('-C', str(self.wt), *args, cwd=self.root)
                    time.sleep(0.6)
                    self.assertIsNone(p.poll(), f'{name} must wait for the lock')
                finally:
                    fcntl.flock(fd, fcntl.LOCK_UN)
                    os.close(fd)
                out, err = p.communicate(timeout=120)
                self.assertEqual(p.returncode, 0, f'{name}: {err}')

    def test_nonmutating_commands_pass_through_without_waiting(self):
        fd = self.hold_lock()
        try:
            for args in (['rev-parse', 'HEAD'], ['status', '--porcelain'], ['log', '-1', '--format=%s'],
                         ['rev-parse', '--git-common-dir']):
                with self.subTest(args=args):
                    expected = subprocess.run([GIT, '-C', str(self.wt), *args], env=self.env, capture_output=True, text=True, timeout=30)
                    t = time.monotonic()
                    got = self.wrap('-C', str(self.wt), *args, cwd=self.root, timeout=10)
                    self.assertLess(time.monotonic() - t, 5, 'passthrough must not wait on the fetch lock')
                    self.assertEqual((got.returncode, got.stdout), (expected.returncode, expected.stdout))
            got = self.wrap('rev-parse', '--show-toplevel', cwd=self.wt, timeout=10)
            self.assertEqual(Path(got.stdout.strip()), self.wt)
        finally:
            fcntl.flock(fd, fcntl.LOCK_UN)
            os.close(fd)

    def test_exit_status_and_output_propagate(self):
        bad = self.wrap('-C', str(self.repo), 'rev-parse', '--verify', '-q', 'refs/heads/does-not-exist')
        real = subprocess.run([GIT, '-C', str(self.repo), 'rev-parse', '--verify', '-q', 'refs/heads/does-not-exist'],
                              env=self.env, capture_output=True, text=True, timeout=30)
        self.assertNotEqual(real.returncode, 0)
        self.assertEqual(bad.returncode, real.returncode)
        failed = self.wrap('-C', str(self.repo), 'fetch', str(self.root / 'missing-remote'))
        real = subprocess.run([GIT, '-C', str(self.repo), 'fetch', str(self.root / 'missing-remote')],
                              env=self.env, capture_output=True, text=True, timeout=30)
        self.assertNotEqual(real.returncode, 0)
        self.assertEqual(failed.returncode, real.returncode, failed.stderr)
        self.assertTrue(failed.stderr.strip())
        ok = self.wrap('-C', str(self.repo), 'fetch', '-q', str(self.src), 'refs/heads/main:refs/remotes/src/main')
        self.assertEqual(ok.returncode, 0, ok.stderr)
        self.assertEqual(self.git('-C', str(self.repo), 'rev-parse', 'refs/remotes/src/main').strip(), self.tips['main'])

    def test_fetch_outside_a_repository_fails_nonzero(self):
        plain = self.root / 'plain'
        plain.mkdir()
        r = self.wrap('-C', str(plain), 'fetch', str(self.src), timeout=30)
        self.assertNotEqual(r.returncode, 0)
        self.assertTrue(r.stderr.strip())
        self.assertFalse((plain / LOCK).exists())


if __name__ == '__main__':
    unittest.main(verbosity=2)
