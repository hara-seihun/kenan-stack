#!/usr/bin/python3 -I
"""Keep the Kenan PostgreSQL cluster alive when WAL archiving stalls.

Every run:
  * alert (machine-alert inbox) when archiving is stalled or disk headroom is low;
  * if archiving is stalled AND the pgdata filesystem is nearly full, suspend
    archiving (archive_command=/bin/true) so WAL is recycled instead of filling
    the disk and crash-looping the database;
  * while suspended, probe the repository with `pgbackrest info`; when it
    answers, restore archiving and take a fresh full backup.
"""
import json, os, shutil, subprocess, sys, time
from pathlib import Path

BACKUP = Path('/etc/kenan/backup.json')
PGDATA = Path('/var/lib/kenan/postgres')
SOCKET = '/run/kenan/pg'
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


def query(sql):
    out = subprocess.run(['/usr/sbin/runuser', '-u', 'postgres', '--', '/usr/lib/postgresql/18/bin/psql',
                          '-X', '-A', '-t', '-q', '-v', 'ON_ERROR_STOP=1', '-h', SOCKET, '-d', 'postgres', '-c', sql],
                         capture_output=True, text=True, timeout=30, cwd='/tmp')
    if out.returncode:
        raise RuntimeError(out.stderr.strip()[:300])
    return out.stdout.strip()


def free_bytes(path):
    s = os.statvfs(path)
    return s.f_bavail * s.f_frsize


def pgbackrest(*args, timeout=600):
    cfg = json.loads(BACKUP.read_text())
    return subprocess.run(['/usr/sbin/runuser', '-u', 'postgres', '--', '/usr/bin/pgbackrest',
                           f'--config={cfg["pgbackrestConfig"]}', f'--stanza={cfg["stanza"]}',
                           '--log-level-console=error', *args],
                          capture_output=True, text=True, timeout=timeout, cwd='/tmp')


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


def guard():
    if not Path(SOCKET, '.s.PGSQL.5432').exists():
        return
    try:
        row = query("SELECT current_setting('archive_mode'), current_setting('archive_command'), "
                    "coalesce(extract(epoch from last_archived_time)::bigint,0), "
                    "coalesce(extract(epoch from last_failed_time)::bigint,0) FROM pg_stat_archiver")
    except RuntimeError as e:
        log(f'postgres not queryable ({e})')
        return
    mode, command, last_ok, last_fail = row.split('|')
    if mode != 'on':
        return
    last_ok, last_fail = int(last_ok), int(last_fail)
    status = PGDATA / 'pg_wal' / 'archive_status'
    ready = sum(1 for f in status.iterdir() if f.name.endswith('.ready'))
    free = free_bytes(PGDATA)
    now = time.time()
    stalled = ready > READY_ALERT or (last_fail > last_ok and now - last_ok > STALL_ALERT_SECONDS)
    state = json.loads(STATE.read_text()) if STATE.exists() else {'suspended': False}

    if state['suspended']:
        probe = pgbackrest('--output=json', 'info', timeout=120)
        healthy = probe.returncode == 0 and all(s['status']['code'] in (0, 2) for s in json.loads(probe.stdout))
        if not healthy:
            condition('wal-archiving-suspended', True,
                      f'WAL archiving was SUSPENDED at {time.ctime(state["at"])} to keep PostgreSQL alive '
                      f'(pgdata free {free / GiB:.1f}G). Point-in-time recovery after the last full backup is '
                      f'unavailable until the repository answers `pgbackrest info`; the guard then resumes archiving '
                      f'and takes a full backup.\n\nLast check: {(probe.stderr or probe.stdout).strip()[:400]}')
            return
        query('ALTER SYSTEM RESET archive_command')
        query('SELECT pg_reload_conf()')
        STATE.write_text(json.dumps({'suspended': False, 'resumedAt': int(now)}))
        subprocess.run(['/usr/bin/systemctl', 'reset-failed', 'kenan-backup.service'])
        subprocess.run(['/usr/bin/systemctl', 'start', '--no-block', 'kenan-backup.service'])
        log('repository healthy again, archiving resumed, full backup started')
    condition('wal-archiving-suspended', False, '')

    if stalled and free < PG_FREE_SUSPEND and command != '/bin/true':
        query("ALTER SYSTEM SET archive_command = '/bin/true'")
        query('SELECT pg_reload_conf()')
        query('CHECKPOINT')
        STATE.write_text(json.dumps({'suspended': True, 'at': int(now), 'ready': ready, 'free': free}))
        log(f'archiving SUSPENDED (ready={ready}, free={free / GiB:.1f}G)')
        return guard()

    condition('wal-archive-stalled', stalled,
              f'Kenan WAL archiving is stalled. {ready} segments ({ready * 16 / 1024:.1f}G) waiting; '
              f'last success {time.ctime(last_ok) if last_ok else "never"}, last failure '
              f'{time.ctime(last_fail) if last_fail else "never"}. pgdata free {free / GiB:.1f}G. '
              f'Below {PG_FREE_SUSPEND // GiB}G free archiving is suspended automatically.\n\n'
              f'Check: journalctl -u kenan-postgres | grep -i archive')
    condition('disk-low', free < PG_FREE_ALERT, f'Only {free / GiB:.1f}G free on the filesystem holding {PGDATA}.')


def main():
    guard()
    root_free = free_bytes('/')
    condition('host-root-disk-low', root_free < ROOT_FREE_ALERT,
              f'kenan-server root filesystem has only {root_free / GiB:.1f}G free.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
