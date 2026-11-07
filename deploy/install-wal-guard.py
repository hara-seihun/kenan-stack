#!/usr/bin/python3 -I
"""Install the WAL guard only after its explicit local backup policy is valid."""
import importlib.util
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys
import tempfile

DEPLOY = Path(__file__).resolve().parent
POLICY = Path('/etc/kenan/wal-guard.json')
LEGACY_POLICY = Path('/etc/kenan/backup.json')
HELPER = Path('/usr/local/sbin/kenan-wal-guard')


def systemd_services(names=None):
    if names is None:
        result = subprocess.run(['systemctl', 'list-unit-files', '--type=service', '--no-legend', '--no-pager'],
                                capture_output=True, text=True, check=True)
        names = [line.split()[0] for line in result.stdout.splitlines()
                 if line.strip() and '@.service' not in line.split()[0]]
    if not names:
        return []
    result = subprocess.run(['systemctl', 'show', '--no-pager', '--property=Id,LoadState,ExecStart', *names],
                            capture_output=True, text=True, check=True)
    return [dict(line.split('=', 1) for line in block.splitlines() if '=' in line)
            for block in result.stdout.strip().split('\n\n') if block.strip()]


def direct_full_backup(service, cfg):
    if service.get('LoadState') != 'loaded':
        return False
    commands = re.findall(r'argv\[\]=(.*?)(?: ;|$)', service.get('ExecStart', ''))
    if len(commands) != 1:
        return False
    args = shlex.split(commands[0])
    if not args or Path(args[0]).name != 'pgbackrest' or 'backup' not in args:
        return False
    def option(name):
        for i, arg in enumerate(args):
            if arg.startswith(name + '='):
                return arg.split('=', 1)[1]
            if arg == name and i + 1 < len(args):
                return args[i + 1]
        return None
    return (option('--config') == cfg['pgbackrestConfig'] and option('--stanza') == cfg['stanza']
            and option('--type') == 'full')


def atomic_write(path, content, mode):
    fd, temp = tempfile.mkstemp(prefix='.' + path.name + '-', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as f:
            os.fchmod(f.fileno(), mode)
            f.write(content)
        os.replace(temp, path)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)


def install(required=False):
    # Ordinary app deployments do not introduce monitoring on hosts which never
    # installed it. Preparation explicitly requests it and must supply policy.
    if not required and not HELPER.exists() and not POLICY.exists():
        return
    spec = importlib.util.spec_from_file_location('wal_guard', DEPLOY / 'wal-guard.py')
    guard = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(guard)
    converting = not POLICY.exists()
    if converting:
        if not LEGACY_POLICY.exists():
            raise ValueError('wal_guard_policy_missing: create /etc/kenan/wal-guard.json')
        old = json.loads(LEGACY_POLICY.read_text())
        cfg = {'socket': old.get('socket', '/run/kenan/pg')}
        for key in ('pgbackrestConfig', 'stanza'):
            if not isinstance(old.get(key), str) or not old[key]:
                raise ValueError(f'wal_guard_conversion_missing_{key}')
            cfg[key] = old[key]
        # The old guard used this Stack socket. Validate repository selection
        # against the live command; never migrate a stale host's backup policy.
        command = guard.query(cfg, 'SHOW archive_command')
        args = shlex.split(command)
        expected = [f'--config={cfg["pgbackrestConfig"]}', f'--stanza={cfg["stanza"]}']
        if (not args or Path(args[0]).name != 'pgbackrest' or 'archive-push' not in args
                or not all(arg in args for arg in expected)):
            raise ValueError('wal_guard_conversion_archive_command_mismatch: supply explicit local policy')
        matches = sorted({s['Id'] for s in systemd_services() if direct_full_backup(s, cfg)})
        if len(matches) != 1:
            raise ValueError('wal_guard_conversion_full_backup_service_missing_or_ambiguous: supply explicit local policy')
        cfg['fullBackupService'] = matches[0]
    else:
        cfg = guard.load_policy()
    if not Path(cfg['pgbackrestConfig']).is_file():
        raise ValueError('wal_guard_pgbackrest_config_missing')
    services = systemd_services([cfg['fullBackupService']])
    if len(services) != 1 or not direct_full_backup(services[0], cfg):
        raise ValueError('wal_guard_full_backup_service_not_direct_full_pgbackrest: select a dedicated full backup service')
    if converting:
        # Reuse the runtime's validation before publishing the converted file.
        if not Path(cfg['socket']).is_absolute() or not Path(cfg['pgbackrestConfig']).is_absolute():
            raise ValueError('wal_guard_policy_paths_not_absolute')
        atomic_write(POLICY, (json.dumps(cfg, indent=2) + '\n').encode(), 0o644)
        guard.load_policy()
        print('Converted local backup policy after checking live archiving and the full backup service')
    atomic_write(HELPER, (DEPLOY / 'wal-guard.py').read_bytes(), 0o755)
    print('Installed WAL guard with validated local backup policy')


if __name__ == '__main__':
    try:
        if sys.argv[1:] not in ([], ['--required']):
            raise ValueError('usage: install-wal-guard.py [--required]')
        install('--required' in sys.argv)
    except Exception as error:
        # Do not print command output, policy contents, SQL, or private config.
        message = str(error) if isinstance(error, ValueError) else type(error).__name__
        print(f'wal_guard_install_failed: {message}', file=sys.stderr)
        sys.exit(1)
