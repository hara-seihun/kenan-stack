#!/usr/bin/env python3
"""One-time native kenan-bg state move, used around launcher installation."""
import ctypes
import os
from pathlib import Path
import subprocess
import sys

OLD_ROOT = Path('/var/lib/agent-workspace/background-launch')
ROOT = Path('/var/lib/kenan-bg/background-launch')
LAUNCHER = '/usr/local/lib/kenan/kenan-bg-native/background-launch.mjs'


def begin(old=OLD_ROOT, root=ROOT):
    root.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
    if old.is_symlink():
        if old.readlink() != root or not root.is_dir():
            raise RuntimeError('background_migration_alias_conflict')
        return
    if not old.exists():
        root.mkdir(mode=0o700, exist_ok=True)
        return
    if root.exists() or root.is_symlink():
        raise RuntimeError('background_migration_state_conflict')
    # Exchange the directory and a self-referencing symlink in one syscall.
    # Old writers never see a missing path, and open lock descriptors keep their
    # inode. After the exchange, old -> root and root is the original directory.
    root.symlink_to(root)
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.renameat2(-100, os.fsencode(old), -100, os.fsencode(root), 2) != 0:
        error = ctypes.get_errno()
        root.unlink()
        raise OSError(error, os.strerror(error))


def finish(old=OLD_ROOT, root=ROOT, launcher=LAUNCHER):
    if not old.is_symlink():
        return
    if old.readlink() != root or not root.is_dir():
        raise RuntimeError('background_migration_alias_conflict')
    # Called after replacing the launcher. Only processes already holding old
    # code can still use the alias. pidwait uses pidfds, not repeated polling.
    pids = []
    for proc in Path('/proc').iterdir():
        if not proc.name.isdigit() or int(proc.name) == os.getpid():
            continue
        try:
            args = (proc / 'cmdline').read_bytes().split(b'\0')
            if len(args) > 1 and os.fsencode(launcher) in args[1:] and Path(os.fsdecode(args[0])).name in ('node', 'nodejs'):
                pids.append(proc.name)
        except (OSError, ValueError):
            continue
    if pids:
        result = subprocess.run(['pidwait', '--pid', ','.join(pids)], timeout=25, check=False)
        if result.returncode not in (0, 1):
            raise RuntimeError('background_migration_writer_wait_failed')
    old.unlink()
    try:
        old.parent.rmdir()
    except OSError:
        pass  # Other state, if any, belongs to its owner.


if __name__ == '__main__':
    if sys.argv[1:] == ['begin']:
        begin()
    elif sys.argv[1:] == ['finish']:
        finish()
    else:
        raise SystemExit('usage: migrate-state.py begin|finish')
