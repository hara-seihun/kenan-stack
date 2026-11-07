#!/usr/bin/python3 -I
"""Keep the local PostgreSQL cluster alive when WAL archiving stalls.

/etc/kenan/wal-guard.json selects the SQL socket, pgBackRest repository and full
backup service. PGDATA always comes from the connected server. Suspension saves
the active archive command before replacing it; recovery restores that command
and queues a fresh full backup, including when a previous run was interrupted.
"""
import json, os, re, shlex, shutil, subprocess, sys, time
from pathlib import Path

POLICY = Path('/etc/kenan/wal-guard.json')
STATE = Path('/var/lib/kenan/wal-guard.json')
INBOX = Path('/var/lib/machine-alerts/inbox')
GiB = 1024 ** 3

READY_ALERT = 64            # 64 x 16MiB = 1GiB of unarchived WAL
STALL_ALERT_SECONDS = 1800  # no successful archive for 30 min while failing
PG_FREE_ALERT = 20 * GiB
PG_FREE_SUSPEND = 8 * GiB
ROOT_FREE_ALERT = 30 * GiB


def log(msg):
    print(msg, flush=True)


def load_policy():
    if not POLICY.is_file():
        raise ValueError('wal_guard_policy_missing: create /etc/kenan/wal-guard.json')
    cfg = json.loads(POLICY.read_text())
    for key in ('socket', 'pgbackrestConfig', 'stanza', 'fullBackupService'):
        if not isinstance(cfg.get(key), str) or not cfg[key]:
            raise ValueError(f'wal_guard_policy_missing_{key}')
    if not all(Path(cfg[key]).is_absolute() for key in ('socket', 'pgbackrestConfig')):
        raise ValueError('wal_guard_policy_paths_not_absolute')
    if not re.fullmatch(r'[A-Za-z0-9_.@-]+\.service', cfg['fullBackupService']):
        raise ValueError('wal_guard_policy_invalid_backup_service')
    return cfg


def query(cfg, sql):
    # SQL goes through stdin, not process arguments: archive commands can contain
    # private values. Never include SQL or server stderr in logs.
    out = subprocess.run(['/usr/sbin/runuser', '-u', 'postgres', '--', '/usr/lib/postgresql/18/bin/psql',
                          '-X', '-A', '-t', '-q', '-v', 'ON_ERROR_STOP=1', '-h', cfg['socket'], '-d', 'postgres'],
                         input=sql, capture_output=True, text=True, timeout=30, cwd='/')
    if out.returncode:
        raise RuntimeError(f'wal_guard_sql_failed_{out.returncode}')
    return out.stdout.strip()


def save_state(state):
    tmp = STATE.with_suffix('.tmp')
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w') as f:
        os.fchmod(f.fileno(), 0o600)
        json.dump(state, f)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, STATE)


def free_bytes(path):
    s = os.statvfs(path)
    return s.f_bavail * s.f_frsize


def pgbackrest(cfg, *args, timeout=600):
    return subprocess.run(['/usr/sbin/runuser', '-u', 'postgres', '--', '/usr/bin/pgbackrest',
                           f'--config={cfg["pgbackrestConfig"]}', f'--stanza={cfg["stanza"]}',
                           '--log-level-console=error', *args],
                          capture_output=True, text=True, timeout=timeout, cwd='/')


def repository_healthy(cfg):
    try:
        probe = pgbackrest(cfg, '--output=json', 'info', timeout=120)
        rows = json.loads(probe.stdout) if probe.returncode == 0 else []
        return any(s['name'] == cfg['stanza'] and s['status']['code'] in (0, 2) for s in rows)
    except (subprocess.TimeoutExpired, ValueError, KeyError, TypeError):
        return False


def condition(name, active, body):
    path = INBOX / f'kenan-{name}.md'
    if active:
        text = f'# kenan {name}\n\n{body}\n\nObserved {time.strftime("%Y-%m-%d %H:%M:%S %Z")} by kenan-wal-guard.timer.\n'
        if not path.exists() or path.read_text().split('\n\nObserved')[0] != text.split('\n\nObserved')[0]:
            tmp = path.with_suffix('.tmp')
            tmp.write_text(text)
            shutil.chown(tmp, 'kenan', 'kenan')
            os.replace(tmp, path)
            log(f'ALERT {name}: {body.splitlines()[0]}')
    elif path.exists():
        path.unlink()
        log(f'recovered {name}')


def guard(cfg):
    if not Path(cfg['socket'], '.s.PGSQL.5432').exists():
        return
    row = json.loads(query(cfg, "SELECT json_build_object("
                           "'data', current_setting('data_directory'), "
                           "'mode', current_setting('archive_mode'), "
                           "'command', current_setting('archive_command'), "
                           "'last_ok', coalesce(extract(epoch from last_archived_time)::bigint,0), "
                           "'last_fail', coalesce(extract(epoch from last_failed_time)::bigint,0)) "
                           "FROM pg_stat_archiver"))
    if row['mode'] != 'on':
        return
    pgdata = Path(row['data'])
    command, last_ok, last_fail = row['command'], row['last_ok'], row['last_fail']
    status = pgdata / 'pg_wal' / 'archive_status'
    ready = sum(1 for f in status.iterdir() if f.name.endswith('.ready'))
    free = free_bytes(pgdata)
    now = time.time()
    stalled = ready > READY_ALERT or (last_fail > last_ok and now - last_ok > STALL_ALERT_SECONDS)
    state = json.loads(STATE.read_text()) if STATE.exists() else {'suspended': False}
    if state.get('dataDirectory', str(pgdata)) != str(pgdata):
        raise RuntimeError('wal_guard_state_is_for_another_cluster')

    # A pre-upgrade suspension (or a crash between ALTER and state writing) may
    # have no saved command. The explicit repository policy supplies its command.
    if command == '/bin/true' and not state['suspended']:
        state = {'suspended': True, 'at': int(now), 'dataDirectory': str(pgdata)}
        save_state(state)

    if state['suspended']:
        if not repository_healthy(cfg):
            condition('wal-archiving-suspended', True,
                      f'WAL archiving was SUSPENDED at {time.ctime(state["at"])} to keep PostgreSQL alive '
                      f'(pgdata free {free / GiB:.1f}G). Point-in-time recovery after the last full backup is '
                      f'unavailable until the repository answers `pgbackrest info`; the guard then resumes '
                      f'archiving and schedules a fresh full backup with {cfg["fullBackupService"]}.')
            return
        restore = state.get('archiveCommand') or shlex.join([
            'pgbackrest', f'--config={cfg["pgbackrestConfig"]}', f'--stanza={cfg["stanza"]}', 'archive-push', '%p'])
        if not restore.strip() or restore.strip() == '/bin/true':
            raise RuntimeError('wal_guard_invalid_saved_archive_command')
        query(cfg, "ALTER SYSTEM SET archive_command = '" + restore.replace("'", "''") + "'")
        query(cfg, 'SELECT pg_reload_conf()')
        # Each query opens a new backend, so this observes the reloaded setting.
        if query(cfg, 'SHOW archive_command') != restore:
            raise RuntimeError('wal_guard_archive_command_not_restored')
        # Keep recovery pending until systemd accepts the backup. Restart rather
        # than start also queues a fresh full if a backup was already running.
        subprocess.run(['/usr/bin/systemctl', 'reset-failed', cfg['fullBackupService']], check=True)
        subprocess.run(['/usr/bin/systemctl', 'restart', '--no-block', cfg['fullBackupService']], check=True)
        save_state({'suspended': False, 'resumedAt': int(now), 'dataDirectory': str(pgdata)})
        condition('wal-archiving-suspended', False, '')
        log(f'archiving restored; fresh full backup queued with {cfg["fullBackupService"]}')
        return
    condition('wal-archiving-suspended', False, '')

    if stalled and free < PG_FREE_SUSPEND:
        if not command.strip():
            raise RuntimeError('wal_guard_cannot_suspend_empty_archive_command')
        # Save first: a crash must never lose the actual command we replaced.
        save_state({'suspended': True, 'at': int(now), 'ready': ready, 'free': free,
                    'archiveCommand': command, 'dataDirectory': str(pgdata)})
        query(cfg, "ALTER SYSTEM SET archive_command = '/bin/true'")
        query(cfg, 'SELECT pg_reload_conf()')
        query(cfg, 'CHECKPOINT')
        condition('wal-archiving-suspended', True,
                  f'WAL archiving is SUSPENDED (ready={ready}, pgdata free={free / GiB:.1f}G). '
                  'The guard will restore archiving and schedule a fresh full backup when the repository answers.')
        return

    condition('wal-archive-stalled', stalled,
              f'Kenan WAL archiving is stalled. {ready} segments ({ready * 16 / 1024:.1f}G) waiting; '
              f'last success {time.ctime(last_ok) if last_ok else "never"}, last failure '
              f'{time.ctime(last_fail) if last_fail else "never"}. pgdata free {free / GiB:.1f}G. '
              f'Below {PG_FREE_SUSPEND // GiB}G free archiving is suspended automatically.\n\n'
              f'Check: journalctl -u kenan-postgres | grep -i archive')
    condition('disk-low', free < PG_FREE_ALERT, f'Only {free / GiB:.1f}G free on the filesystem holding {pgdata}.')
    log(f'checked {pgdata}: ready={ready}, suspended=false')


def main():
    guard(load_policy())
    root_free = free_bytes('/')
    condition('host-root-disk-low', root_free < ROOT_FREE_ALERT,
              f'{os.uname().nodename} root filesystem has only {root_free / GiB:.1f}G free.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
