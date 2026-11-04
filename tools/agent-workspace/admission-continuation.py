#!/usr/bin/python3
"""Single-attempt custody continuation. Admission is always before selection."""
import fcntl
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import uuid


def root():
    if len(sys.argv) > 3 and sys.argv[1] == 'run':
        return Path(sys.argv[3])
    p = Path(os.environ.get('XDG_STATE_HOME', str(Path.home() / '.local/state'))) / 'pi-workspaces/admission-jobs'
    p.mkdir(mode=0o700, parents=True, exist_ok=True)
    if p.is_symlink() or p.stat().st_uid != os.getuid() or p.stat().st_mode & 0o077:
        raise RuntimeError('admission job directory must be private and owned by the caller')
    return p


def save(path, value):
    temporary = path.with_suffix('.tmp')
    with temporary.open('w') as f:
        json.dump(value, f)
        f.flush()
        os.fsync(f.fileno())
    temporary.replace(path)


def directory(job):
    if len(job) != 32 or any(c not in '0123456789abcdef' for c in job):
        raise ValueError('invalid admission job ID')
    p = root() / job
    if p.is_symlink() or p.stat().st_uid != os.getuid():
        raise ValueError('invalid admission job custody')
    return p


def run(job):
    p = directory(job)
    # A second activation must never replay a command whose effect is uncertain.
    fd = os.open(p / 'claimed', os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    os.close(fd)
    request = json.loads((p / 'request.json').read_text())
    result = {'state': 'waiting', 'commandStarted': False, 'jobId': job}
    save(p / 'progress.json', result)
    deadline = time.monotonic() + 600
    locks = []
    try:
        for suffix in ['.turnstile', '']:
            handle = open(request['lock'] + suffix, 'w')
            locks.append(handle)
            # flock is kernel-blocked, not a polling loop. One absolute budget.
            remaining = max(0, deadline - time.monotonic())
            acquired = subprocess.run(['flock', '--shared', '--wait', str(remaining), '--conflict-exit-code', '75', str(handle.fileno())], pass_fds=(handle.fileno(),))
            if acquired.returncode:
                result.update(state='failed', exitCode=75, error='admission budget exhausted')
                save(p / 'result.json', result)
                return
        fcntl.flock(locks[0], fcntl.LOCK_UN)
        locks[0].close()
        # Resolve only now, never when the request was submitted.
        component = str(Path(request['selected']).resolve(strict=True))
        result.update(state='running', commandStarted=True, component=component)
        save(p / 'progress.json', result)
        with (p / 'stdout').open('wb') as out, (p / 'stderr').open('wb') as err:
            child = subprocess.run([component + '/main', *request['args']], cwd=request['cwd'], env=request['env'], stdout=out, stderr=err, pass_fds=(locks[1].fileno(),))
        result.update(state='completed' if child.returncode == 0 else 'failed', exitCode=child.returncode, stdoutPath=str(p / 'stdout'), stderrPath=str(p / 'stderr'))
        save(p / 'result.json', result)
    except Exception as error:
        result.update(state='interrupted' if result['commandStarted'] else 'failed', error=str(error))
        save(p / 'result.json', result)
        raise
    finally:
        for handle in locks:
            handle.close()


def submit(args):
    if not args or args[0] not in ('heartbeat', 'release'):
        raise ValueError('only heartbeat and release may be continued')
    job = uuid.uuid4().hex
    p = root() / job
    p.mkdir(mode=0o700)
    # Retain execution context, not credentials or unrelated caller environment.
    keys = ['PATH', 'HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_RUNTIME_DIR', 'PI_WORKSPACE_STATE', 'PI_REMOTE_DATA', 'SEINARI_DATA_STORE', 'PI_THREAD_DATABASE', 'KENAN_AGENT', 'KENAN_TOOL_CALL_ID']
    env = {k: os.environ[k] for k in keys if k in os.environ}
    request = {'args': args, 'cwd': os.getcwd(), 'env': env, 'lock': os.environ.get('AGENT_WORKSPACE_ADMISSION_LOCK', '/run/lock/agent-workspace-admission.lock'), 'selected': os.environ.get('AGENT_WORKSPACE_SELECTED_ROOT', '/srv/pi/tools/agent-workspace')}
    save(p / 'request.json', request)
    unit = 'agent-workspace-admission-' + job
    save(p / 'progress.json', {'state': 'submitting', 'commandStarted': False, 'jobId': job, 'unit': unit})
    # The immutable helper survives later launcher installation and caller death.
    launched = subprocess.run(['systemd-run', '--user', '--quiet', '--collect', '--unit', unit, '--property=Type=exec', '--', '/usr/bin/python3', str(Path(__file__).resolve()), 'run', job, str(root())], capture_output=True, text=True)
    if launched.returncode:
        save(p / 'submission-error.json', {'error': launched.stderr, 'commandStarted': False})
        raise RuntimeError('continuation submission was not acknowledged; reconcile ' + str(p))
    print(json.dumps({'ok': True, 'state': 'pending', 'commandStarted': False, 'jobKind': 'admission', 'jobId': job, 'resultPath': str(p / 'result.json'), 'observeCommand': 'agent-workspace admission-status --job-id ' + job + ' --json', 'nextAction': 'Observe this job; do not resubmit the original command. Its single attempt runs automatically after publication.'}))
    return 75


def status(job):
    p = directory(job)
    terminal = p / 'result.json'
    value = json.loads((terminal if terminal.exists() else p / 'progress.json').read_text())
    if not terminal.exists():
        active = subprocess.run(['systemctl', '--user', 'is-active', 'agent-workspace-admission-' + job], capture_output=True, text=True)
        if active.stdout.strip() not in ('active', 'activating'):
            value = {**value, 'state': 'interrupted', 'nextAction': 'Reconcile retained output and commandStarted before any fresh attempt. This job never restarts automatically.'}
    print(json.dumps(value))
    return 0 if value['state'] == 'completed' else 75 if value['state'] in ('waiting', 'running', 'submitting') else 2


if __name__ == '__main__':
    os.umask(0o077)
    if sys.argv[1] == 'run':
        run(sys.argv[2])
    elif sys.argv[1] == 'submit':
        sys.exit(submit(sys.argv[2:]))
    elif sys.argv[1] == 'status':
        sys.exit(status(sys.argv[2]))
    else:
        raise ValueError('unknown continuation action')
