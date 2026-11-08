#!/usr/bin/python3
"""One timer, one lock, newest complete promotion first. Failures notify the work manager."""
from contextlib import contextmanager
import fcntl
import ctypes
import select
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import signal
import subprocess
import sys
import shutil
import uuid
import time

REPO = Path('/home/kenan/work/repos/kenan.git')
WORK = Path('/home/kenan/work/clones/stack-bundle-deploy')
STATE = Path('/home/kenan/data/kenan-stack-intake')
BRANCH = 'refs/heads/rewrite/acme-deploy'
NOTIFIED = False
EXPORT_DIR = Path('/var/tmp/kenan-stack-to-ResearchCo')
PEER_OUTBOX = Path('/var/lib/kenan/peer-outbox/acme')
DEPLOY_LOCK = Path('/run/lock/kenan-stack-deploy.lock')
INTAKE_LOCK = Path('/run/lock/kenan-stack-intake.lock')
USAGE = 'usage: stack-bundle-intake.py [--own SIGNATURE OWNER]'


def run(argv, cwd=None, **kwargs):
    return subprocess.run([str(a) for a in argv], cwd=cwd, check=True, **kwargs)


def git(repo, *args):
    return run(['git', '-C', repo, *args], stdout=subprocess.PIPE, text=True).stdout.strip()


def inspect_bundle(repo, path):
    if path.is_symlink() or not path.is_file():
        raise ValueError('The bundle must be a regular file')
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    git(repo, 'bundle', 'verify', str(path))
    heads = git(repo, 'bundle', 'list-heads', str(path)).splitlines()
    tips = {line.split()[0] for line in heads}
    if len(tips) != 1:
        raise ValueError('A promotion bundle must contain exactly one distinct commit tip')
    sha = tips.pop()
    git(repo, 'fetch', str(path), f'{heads[0].split()[1]}:refs/stack-intake/{sha}')
    return dict(path=str(path), sha=sha, time=int(git(repo, 'show', '-s', '--format=%ct', sha)), digest=digest, upstream=all(line.split()[1].startswith('refs/kenan-acme/') for line in heads))


def fingerprint(path):
    stat = path.stat()
    return [stat.st_size, stat.st_mtime_ns]


def collect_bundle(repo, path, now=None):
    """Observe across ticks; incomplete transfers never become processed receipts."""
    now = time.time() if now is None else now
    observation = STATE / (path.name + '.observed.json')
    current = fingerprint(path)
    old = json.loads(observation.read_text()) if observation.exists() else {}
    if old.get('fingerprint') != current:
        old = dict(fingerprint=current, since=now)
        observation.write_text(json.dumps(old))
        return None
    if now - old['since'] < 30:
        return None
    try:
        item = inspect_bundle(repo, path)
        if fingerprint(path) != current:
            return None
        return item
    except Exception as error:
        if fingerprint(path) != current:
            return None
        # Require a second stable failed tick, not a transient read failure.
        if old.get('failedOnce'):
            item = dict(path=str(path), digest=hashlib.sha256(path.read_bytes()).hexdigest())
            failed(item, error)
        else:
            old['failedOnce'] = True
            observation.write_text(json.dumps(old))
        return None


def select_bundle(bundles):
    return max(bundles, key=lambda b: (b['time'], b['sha'], b['path']))


def replay_equivalent(work, main, upstream):
    """Drop already-upstream patches before replaying, without rewriting the maintained branch."""
    cherry = git(work, 'cherry', upstream, main)
    if not any(line.startswith('- ') for line in cherry.splitlines()):
        return None
    base = git(work, 'merge-base', main, upstream)
    git(work, 'checkout', '--detach', main)
    result = subprocess.run(['git', '-C', str(work), '-c', 'user.name=Kenan',
                             '-c', 'user.email=person25@example.com', 'rebase', '--rebase-merges', '--onto', upstream, base],
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    if result.returncode:
        subprocess.run(['git', '-C', str(work), 'rebase', '--abort'], check=True)
        git(work, 'checkout', '--detach', main)
        return None
    # The replayed tree carries every non-equivalent local patch. Keep old history as a parent,
    # so a normal fast-forward push remains the only publication operation.
    git(work, '-c', 'user.name=Kenan', '-c', 'user.email=person25@example.com', 'merge', '-s', 'ours',
        '--no-edit', main)
    return git(work, 'rev-parse', 'HEAD')


EXPORT_WINDOW_S = int(os.environ.get('KENAN_STACK_EXPORT_WINDOW_S', '300'))
EXPORT_STATE_NAME = 'export-state.json'


def tree_of(repo, sha):
    return git(repo, 'rev-parse', f'{sha}^{{tree}}')


def unchanged_source(candidate, serving):
    return all(tree_of(WORK, candidate) == tree_of(WORK, sha) for sha in serving.values())


def last_export(out):
    """The newest created export: its tip, source tree and creation time."""
    path = STATE / EXPORT_STATE_NAME
    if path.exists():
        return json.loads(path.read_text())
    manifests = [p for p in out.glob('*.json') if not p.name.endswith('.note.json')] if out.exists() else []
    if not manifests:
        return None
    newest = max(manifests, key=lambda p: p.stat().st_mtime_ns)
    value = json.loads(newest.read_text())
    return dict(tip=value['tip'], tree=value.get('tree'), at=newest.stat().st_mtime)


def publish(manifest):
    """Resumable: a pending manifest is published (again) until it is recorded as queued."""
    value = json.loads(manifest.read_text())
    if value['status'] != 'pending':
        return
    out, tip, bundle = manifest.parent, value['tip'], Path(value['bundle'])
    public = EXPORT_DIR
    public.mkdir(parents=True, exist_ok=True)
    target = public / bundle.name
    temporary = target.with_suffix('.partial')
    shutil.copyfile(bundle, temporary)
    temporary.replace(target)
    write_json(target.with_suffix('.json'), value)
    # The peer's operator pulls these work-only files read-only; no remote writes or credentials.
    message = dict(id=str(uuid.uuid5(uuid.NAMESPACE_URL, f'kenan-stack-export:{tip}')),
                   peer='alice-personal', to='manager:alice', from_='deploy:stack-intake',
                   text=f'Acme source export is ready at {target}, with its manifest beside it; please merge it Beta-first.',
                   createdAt=int(time.time() * 1000))
    message['from'] = message.pop('from_')
    # Store exact bytes before enqueueing so a crash can only repeat the same id and payload.
    message_file = out / f'{tip}.note.json'
    if not message_file.exists():
        write_json(message_file, message)
    # The receiving host polls EXPORT_DIR; routine peer notes are opt-in.
    if os.environ.get('KENAN_STACK_EXPORT_PEER_NOTE') == '1':
        PEER_OUTBOX.mkdir(parents=True, exist_ok=True)
        write_json(PEER_OUTBOX / f'stack-export-{tip}.json', json.loads(message_file.read_text()))
    value.update(status='queued', queuedAt=time.time(), exportedBundle=str(target))
    write_json(manifest, value)


def export_local(repo, upstream, tip=None, now=None):
    """Batch local-only source into one bundle per window and queue it for the upstream operator.

    November 5, 2026: alternating sibling merges (ebc9138c through 6b6c2268) had one source tree and no
    non-merge change, yet each was exported and deployed on ResearchCo. Identical source is never exported.
    """
    now = time.time() if now is None else now
    tip = tip or git(repo, 'rev-parse', BRANCH)
    out = STATE / 'outbox'
    # Resume any publication a crash interrupted, before deciding about new source.
    if out.exists():
        for pending in sorted(out.glob('*.json')):
            if not pending.name.endswith('.note.json') and json.loads(pending.read_text()).get('status') == 'pending':
                publish(pending)
    commits = git(repo, 'rev-list', '--reverse', tip, '--not', upstream).splitlines()
    if not commits:
        return None
    manifest = out / f'{tip}.json'
    if manifest.exists():
        return manifest
    tree = tree_of(repo, tip)
    previous = last_export(out)
    # A merge-only echo of the peer's own bundle, or source already exported, changes nothing for the peer.
    if tree == tree_of(repo, upstream) or (previous and previous.get('tree') == tree):
        return None
    # Coalesce: one bundle per window. Bundles are cumulative against upstream, so the next tick's export
    # carries every change queued meanwhile.
    if previous and now - previous['at'] < EXPORT_WINDOW_S:
        return None
    out.mkdir(parents=True, exist_ok=True)
    bundle = out / f'{tip}.bundle'
    ref = f'refs/stack-export/{tip}'
    git(repo, 'update-ref', ref, tip)
    try:
        temporary = bundle.with_suffix('.partial')
        git(repo, 'bundle', 'create', str(temporary), ref, f'^{upstream}')
        temporary.replace(bundle)
    finally:
        git(repo, 'update-ref', '-d', ref)
    write_json(manifest, dict(tip=tip, upstream=upstream, tree=tree, commits=commits,
                             bundle=str(bundle), sha256=hashlib.sha256(bundle.read_bytes()).hexdigest(),
                             status='pending'))
    write_json(STATE / EXPORT_STATE_NAME, dict(tip=tip, tree=tree, at=now))
    publish(manifest)
    return manifest


def integrate(work, repo, sha):
    git(work, 'fetch', 'origin')
    git(work, 'fetch', 'origin', sha)
    main = git(repo, 'rev-parse', BRANCH)
    git(work, 'checkout', '--detach', main)
    merged = subprocess.run(['git', '-C', str(work), '-c', 'user.name=Kenan', '-c', 'user.email=person25@example.com',
                             'merge', '--no-edit', sha], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    if merged.returncode:
        # Name what conflicts, then leave the deploy clone exactly at main: the next bundle starts clean.
        paths = subprocess.run(['git', '-C', str(work), 'diff', '--name-only', '--diff-filter=U'],
                               stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True).stdout.split()
        subprocess.run(['git', '-C', str(work), 'merge', '--abort'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        subprocess.run(['git', '-C', str(work), 'reset', '--hard', '--quiet', main], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        subprocess.run(['git', '-C', str(work), 'clean', '-fdq'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if paths:
            replayed = replay_equivalent(work, main, sha)
            if replayed:
                return replayed
            raise RuntimeError(f'merge_conflict: bundle {sha} conflicts with {BRANCH.removeprefix("refs/heads/")} at {main} in '
                               f'{", ".join(paths)}; send a bundle whose tip already merges {main}')
        tail = ' '.join(merged.stdout.strip().splitlines()[-3:])
        raise RuntimeError(f'merge_failed: bundle {sha} did not merge into {main}: {tail}')
    return git(work, 'rev-parse', 'HEAD')


def live(channel):
    return Path(f'/srv/kenan/{channel}/source-commit').read_text().strip()


def health(channel, candidate):
    if live(channel) != candidate:
        raise RuntimeError(f'{channel} does not serve {candidate}')
    run(['curl', '--fail', '--silent', '--show-error', '--max-time', '10', '--unix-socket',
         f'/run/kenan/{channel}.sock', 'http://localhost/api/accounts'], stdout=subprocess.DEVNULL)


def reserve_zero():
    for channel in ('beta', 'production'):
        value = json.loads(Path(f'/etc/kenan/{channel}.json').read_text())
        if value.get('claudeWorkerReservePercent') != 0:
            raise RuntimeError(f'{channel}: claudeWorkerReservePercent must remain zero')
        if 'runningAgents' in value or 'maxRunningAgents' in value:
            raise RuntimeError(f'{channel}: runningAgents must remain absent (unlimited)')


def pipeline(work, candidate, run=run, health=health, live=live):
    previous = {c: live(c) for c in ('beta', 'production')}
    try:
        run(['bash', 'deploy/deploy.sh', 'beta'], cwd=work)
        health('beta', candidate)
        run(['bash', 'deploy/promote.sh'], cwd=work)
        health('production', candidate)
    except Exception as failure:
        errors = []
        for channel in ('production', 'beta'):
            if live(channel) != previous[channel]:
                try:
                    run(['git', 'checkout', '--detach', previous[channel]], cwd=work)
                    run(['bash', 'deploy/deploy.sh', channel, '--rollback'], cwd=work)
                    health(channel, previous[channel])
                except Exception as error:
                    errors.append(f'{channel}: {error}')
        run(['git', 'checkout', '--detach', candidate], cwd=work)
        if errors:
            raise RuntimeError(f'{failure}; rollback failed: {errors}') from failure
        raise


class AdmissionDeferred(Exception):
    """No qualification command started; the next timer tick can retry."""


def qualify(work, candidate):
    done = STATE / f'{candidate}-qualification.json'
    # A candidate deferred after qualifying (for example by a live meeting) is not qualified again.
    if done.exists() and json.loads(done.read_text()).get('exitCode') == 0:
        return
    marker = STATE / f'{candidate}-started'
    marker.unlink(missing_ok=True)
    log_path = STATE / f'{candidate}-qualification.log'
    command = ['acme-host-slot', '--owner', f'kenan-stack-{candidate[:12]}',
               '--memory', '6G', '--priority', 'delivery', '--runtime-seconds', '1800',
               '--work-class', 'heavy-test', '--', '/bin/bash', '-c',
               'touch "$1"; exec /bin/bash "$2" "$3"', 'qualification', str(marker),
               str(work / 'deploy/stack-bundle-check.sh'), live('beta')]
    with log_path.open('w') as log:
        process = subprocess.Popen(command, cwd=work, stdout=log, stderr=log, start_new_session=True)
        try:
            process.wait(timeout=60)
        except subprocess.TimeoutExpired:
            if marker.exists():
                process.wait()  # The host slot enforces the admitted runtime bound.
            else:
                os.killpg(process.pid, signal.SIGTERM)
                process.wait(timeout=30)
                # Recheck after termination: admission may have raced the deadline.
                if not marker.exists():
                    raise AdmissionDeferred('Memory admission has not started qualification')
        if process.returncode:
            raise RuntimeError(f'Native qualification failed ({process.returncode}); see {log_path}')
    (STATE / f'{candidate}-qualification.json').write_text(json.dumps(
        dict(candidate=candidate, exitCode=0, log=str(log_path), admission='host-slot')))


def defer(item, error, now=None):
    now = time.time() if now is None else now
    since = item.get('admissionPendingSince', now)
    if now - since >= 4 * 3600:
        failed(item, RuntimeError(f'Qualification has not been admitted for four hours: {error}'))
    else:
        receipt(item, status='admission_pending', admissionPendingSince=since, error=str(error))


# A live real meeting on Beta defers installation (Acme's manager, November 6, 2026): intake deployed Beta at 17:03Z
# while the native notetaker was in Taylor and Morgan's sync. Nothing waits or holds the lock: the bundle stays
# admission_pending, and the next timer tick retries; a qualified candidate is not qualified again. Kenan's own
# #kenanvoice test meetings never count (stack-bundle-meetings.mjs).
def meetings_state():
    result = run(['sudo', '-n', 'node', '/home/kenan/.local/lib/kenan-stack-intake/stack-bundle-meetings.mjs'],
                 cwd='/srv/kenan/beta', stdout=subprocess.PIPE, text=True)
    return json.loads(result.stdout)


def wait_meetings(candidate=None, state=meetings_state):
    if state()['live']:
        raise AdmissionDeferred(f'A real meeting is live on Beta; {candidate or "the bundle"} deploys after it ends')


def receipt(item, **fields):
    path = STATE / (Path(item['path']).name + '.json')
    value = dict(item, processedAt=time.time(), **fields)
    if path.exists():
        previous = json.loads(path.read_text())
        if previous.get('status') == 'failed':
            archive = path.with_name(path.stem + f'.failed-{int(previous["processedAt"])}.json')
            if not archive.exists():
                archive.write_text(path.read_text())
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(value, indent=2) + '\n')
    temporary.replace(path)


@contextmanager
def installation_lock():
    # The root entry point prepares the file; flock works on a read-only descriptor after dropping privileges.
    fd = os.open(DEPLOY_LOCK, os.O_RDONLY)
    if fd != 8:
        os.dup2(fd, 8, inheritable=True)
        os.close(fd)
    previous = os.environ.get('KENAN_STACK_LOCK_PID')
    try:
        try:
            fcntl.flock(8, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise AdmissionDeferred('Another deployment owns the installation lock; retry after it finishes') from error
        os.environ['KENAN_STACK_LOCK_PID'] = str(os.getpid())
        yield
    finally:
        if previous is None:
            os.environ.pop('KENAN_STACK_LOCK_PID', None)
        else:
            os.environ['KENAN_STACK_LOCK_PID'] = previous
        os.close(8)


def observe_workspace_admission(result, timeout=650):
    """Wait for the already-submitted heartbeat's receipt, never resubmit it."""
    if result.returncode != 75:
        return result
    try:
        pending = json.loads(result.stdout)
    except (ValueError, TypeError):
        return result
    if pending.get('jobKind') != 'admission' or pending.get('state') != 'pending':
        return result
    job = pending.get('jobId', '')
    terminal = Path(pending['resultPath'])
    if not re.fullmatch(r'[a-f0-9]{32}', job) or terminal.name != 'result.json' or terminal.parent.name != job:
        raise RuntimeError('Invalid workspace admission continuation binding')
    # Subscribe before reading: completion cannot race between the read and wait.
    libc = ctypes.CDLL(None, use_errno=True)
    fd = libc.inotify_init1(os.O_CLOEXEC)
    if fd < 0:
        raise OSError(ctypes.get_errno(), 'Cannot observe workspace admission')
    try:
        if libc.inotify_add_watch(fd, os.fsencode(terminal.parent), 0x80 | 0x8) < 0:
            raise OSError(ctypes.get_errno(), 'Cannot watch workspace admission directory')
        deadline = time.monotonic() + timeout
        while not terminal.exists():
            remaining = max(0, deadline - time.monotonic())
            if not select.select([fd], [], [], remaining)[0]:
                raise RuntimeError(f'Workspace admission {job} did not settle; reconcile its original receipt, do not replay')
            os.read(fd, 65536)
        settled = json.loads(terminal.read_text())
        if settled.get('jobId') != job or settled.get('state') not in ('completed', 'failed') or 'exitCode' not in settled:
            raise RuntimeError(f'Workspace admission {job} has no completed command verdict; do not replay')
        stdout = Path(settled['stdoutPath']).read_text() if 'stdoutPath' in settled else ''
        stderr = Path(settled['stderrPath']).read_text() if 'stderrPath' in settled else settled.get('error', '')
        return subprocess.CompletedProcess(result.args, settled['exitCode'], stdout, stderr)
    finally:
        os.close(fd)


WORKSPACE_ADMISSION = ['--owner', 'manager:acme', '--intent', 'budgeted', '--headroom-gib', '8', '--growth-mib', '4096']
RELEASED = re.compile(r'workspace cannot renew from state released|workspace path is absent|no workspace (record )?(found|registered)')


def workspace_released(result):
    """True when the heartbeat failed because the intake's admission ended, not for any other refusal."""
    try:
        detail = json.loads(result.stdout).get('error', {}).get('detail', '')
    except (ValueError, TypeError, AttributeError):
        detail = ''
    return bool(RELEASED.search(detail or '') or RELEASED.search(result.stderr or ''))


def wait_for_job(command, kind, job, timeout=600, sleep=time.sleep, clock=time.monotonic):
    """Observe a durable create job through its read-only status command until it settles."""
    if not re.fullmatch(r'[a-f0-9]{64}', job or ''):
        raise RuntimeError(f'Invalid workspace {kind} job binding')
    deadline = clock() + timeout
    while True:
        status = subprocess.run(command + [kind, '--job-id', job, '--json'], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            state = json.loads(status.stdout).get('state')
        except (ValueError, TypeError, AttributeError):
            state = None
        if state == 'ready':
            return
        if state in ('failed', 'cancelled', 'abandoned'):
            raise RuntimeError(f'Workspace {kind} job {job} ended {state}: {status.stdout} {status.stderr}')
        if clock() >= deadline:
            raise RuntimeError(f'Workspace {kind} job {job} did not settle; repeat the original create, do not edit the ledger')
        sleep(1)


def readmit_workspace(command, attempts=4):
    """Re-admit the intake's own checkout after cleanup released it (November 7, 2026, 07:45Z).

    A missing tree is re-created through the priced create route; a tree that release kept is adopted with
    register. Both carry the original owner and capacity guards; the ledger is never edited by hand."""
    if WORK.exists():
        run(command + ['register', '--path', WORK, '--root', WORK.parent, *WORKSPACE_ADMISSION, '--json'],
            stdout=subprocess.PIPE, text=True)
        return
    create = command + ['create', '--root', WORK.parent, '--name', WORK.name, '--repo', REPO, '--mode', 'writer',
                        *WORKSPACE_ADMISSION, '--json']
    for _ in range(attempts):
        result = subprocess.run([str(a) for a in create], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            value = json.loads(result.stdout)
        except (ValueError, TypeError):
            value = {}
        if result.returncode not in (0, 75) or not value.get('ok', False):
            raise RuntimeError(f'Workspace re-admission failed: {result.stdout} {result.stderr}')
        if value.get('jobKind') == 'source' and value.get('state') == 'preparing':
            wait_for_job(command, 'source-status', value.get('jobId'))
            continue  # The create route continues admission when the identical request is repeated.
        if value.get('jobKind') == 'checkout':
            wait_for_job(command, 'job-status', value.get('jobId'))
        if WORK.exists():
            return
    raise RuntimeError('Workspace re-admission did not produce the intake checkout')


def admit_workspace():
    """Renew retired growth through the priced API, inside the normal failure notification boundary."""
    command = ['/home/kenan/.local/bin/agent-workspace']
    result = observe_workspace_admission(subprocess.run(command + ['heartbeat', '--path', str(WORK), '--json'],
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True))
    if result.returncode == 0:
        return
    try:
        code = json.loads(result.stdout).get('error', {}).get('code')
    except ValueError:
        code = None
    if workspace_released(result):
        readmit_workspace(command)
        final = observe_workspace_admission(subprocess.run(command + ['heartbeat', '--path', str(WORK), '--json'],
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True))
        if final.returncode != 0:
            raise RuntimeError(f'Workspace heartbeat failed after re-admission: {final.stdout} {final.stderr}')
        return
    if code != 'growth-admission-required':
        raise RuntimeError(f'Workspace heartbeat failed: {result.stdout} {result.stderr}')
    # Resume requires a fresh physical sample. Never edit the ledger or weaken the capacity guard.
    run(command + ['measure-capacity', '--path', WORK, '--budget-ms', '20000', '--json'])
    status = json.loads(run(command + ['growth-status', '--path', WORK, '--json'],
                            stdout=subprocess.PIPE, text=True).stdout)
    binding = status['binding']
    if binding['path'] != str(WORK) or binding['owner'] != 'manager:acme':
        raise RuntimeError('The intake workspace no longer belongs to the Acme manager')
    run(command + ['resume-growth', '--path', WORK, '--owner', binding['owner'],
                   '--expected-plan-sha256', binding['planSha256'], '--intent', 'budgeted',
                   '--headroom-gib', '8', '--growth-mib', '4096', '--json'])
    final = observe_workspace_admission(subprocess.run(command + ['heartbeat', '--path', WORK, '--json'],
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True))
    final.check_returncode()


def open_intake_lock(path=INTAKE_LOCK):
    """The intake lock belongs to kenan, so every entry point (root timer or kenan by hand) can open it.

    /run/lock is sticky and world-writable: with fs.protected_regular, O_CREAT on another user's existing file fails
    even for root (EACCES), so an existing lock is opened without O_CREAT and only a missing one is created."""
    try:
        fd = os.open(path, os.O_WRONLY)
    except FileNotFoundError:
        try:
            fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o644)
        except FileExistsError:
            fd = os.open(path, os.O_WRONLY)
    if os.geteuid() == 0:
        user = pwd.getpwnam('kenan')
        os.fchown(fd, user.pw_uid, user.pw_gid)
    return fd


def main():
    # Serialize intake source work, not manual deployments. Qualification and meeting waits must not block repairs.
    fd = open_intake_lock()
    if fd != 7:
        os.dup2(fd, 7, inheritable=True)
        os.close(fd)
    fcntl.flock(7, fcntl.LOCK_EX | fcntl.LOCK_NB)
    # Prepare the root-owned deployment lock before dropping privileges; acquire it only for installation.
    os.close(os.open(DEPLOY_LOCK, os.O_CREAT | os.O_RDONLY, 0o644))
    if os.getuid() == 0:
        user = pwd.getpwnam('kenan')
        os.initgroups(user.pw_name, user.pw_gid)
        os.setgid(user.pw_gid)
        os.setuid(user.pw_uid)
    os.environ['HOME'] = '/home/kenan'
    STATE.mkdir(parents=True, exist_ok=True)
    admit_workspace()
    items = []
    for path in sorted(Path('/var/tmp').glob('kenan-stack-*.bundle')):
        saved = STATE / (path.name + '.json')
        if saved.exists():
            old = json.loads(saved.read_text())
            if 'sha' in old and old.get('digest') == hashlib.sha256(path.read_bytes()).hexdigest():
                if time.time() - old['processedAt'] > 7 * 86400:
                    path.unlink()
                    continue
                # Keep processed tips in selection: failure of the newest must not deploy an older bundle.
                if 'sha' in old and 'time' in old:
                    items.append(old)
                continue
        item = collect_bundle(REPO, path)
        if item is not None:
            items.append(item)
    upstream_file = STATE / 'upstream.json'
    if upstream_file.exists():
        export_local(REPO, json.loads(upstream_file.read_text())['sha'])
    if not items:
        return
    item = select_bundle(items)
    # Selection supersedes older complete bundles even if the newest later fails qualification.
    for older in items:
        if older != item and 'sha' in older and older.get('status') not in ('superseded', 'deployed', 'already_deployed'):
            receipt(older, status='superseded', supersededBy=item['sha'])
    process_selected(item)


def process_selected(item):
    if item.get('status') in ('deployed', 'already_deployed', 'superseded'):
        return
    try:
        reserve_zero()
        serving = {channel: live(channel) for channel in ('beta', 'production')}
        if all(subprocess.run(['git', '-C', str(REPO), 'merge-base', '--is-ancestor', item['sha'], sha],
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0
               for sha in serving.values()):
            # A manual operator already delivered this bundle. No source integration, tests or deployment are needed.
            for channel, sha in serving.items():
                health(channel, sha)
            receipt(item, status='already_deployed', **serving)
            return
        if item.get('status') == 'failed' and not ('reserve-wait' in item.get('error', '') and 'exit status 124' in item.get('error', '')):
            return
        # Only incoming upstream bundles advance this watermark. Locally composed bundles contain
        # the maintained tip and must not make local-only source disappear from the export.
        if item.get('upstream'):
            write_json(STATE / 'upstream.json', dict(sha=item['sha']))
        wait_meetings(item['sha'])
        candidate = integrate(WORK, REPO, item['sha'])
        # A bundle whose merge changes no source (for example the peer's copy of our own commits with tests dropped,
        # already merged here with "ours") is recorded, never requalified or redeployed (November 6, 2026: a18f74f8).
        if unchanged_source(candidate, serving):
            for channel, sha in serving.items():
                health(channel, sha)
            receipt(item, status='already_deployed', candidate=candidate, **serving)
            return
        qualify(WORK, candidate)
        # An ordinary push refuses concurrent branch movement and preserves every writer's work.
        try:
            git(WORK, 'push', 'origin', f'HEAD:{BRANCH}')
        except subprocess.CalledProcessError:
            if git(REPO, 'rev-parse', BRANCH) != candidate:
                raise AdmissionDeferred('Maintained source advanced during qualification; retry the combined successor')
            raise
        upstream_file = STATE / 'upstream.json'
        if upstream_file.exists():
            export_local(REPO, json.loads(upstream_file.read_text())['sha'], candidate)
        wait_meetings(candidate)
        reserve_zero()
        with installation_lock():
            pipeline(WORK, candidate)
        reserve_zero()
        receipt(item, status='deployed', candidate=candidate, beta=live('beta'), production=live('production'))
    except AdmissionDeferred as error:
        defer(item, error)
    except Exception as error:
        failed(item, error)
        raise


SIGNATURES_NAME = 'failure-signatures.json'
UNOWNED_REALERT_S = 6 * 3600
ANSI = re.compile(r'\x1b\[[0-9;]*m')


def failure_signature(error):
    """The same failing tests (or type errors) on a newer bundle are one problem, not a new one."""
    found = re.search(r'see (\S+-qualification\.log)', str(error))
    lines = []
    if found and Path(found.group(1)).is_file():
        for line in ANSI.sub('', Path(found.group(1)).read_text(errors='replace')).splitlines():
            if line.startswith(' FAIL ') or re.search(r'error TS\d+:', line):
                lines.append(' '.join(line.split()))
    if not lines:
        # Candidate SHAs and receipt paths change on every bundle; the failure itself does not.
        lines = [re.sub(r'[0-9a-f]{12,}', '<sha>', str(error))]
    lines = sorted(set(lines))
    return hashlib.sha256('\n'.join(lines).encode()).hexdigest()[:16], lines


def own_signature(signature, owner, now=None):
    """Record who fixes a failure signature; later bundles failing the same way then stay quiet."""
    path = STATE / SIGNATURES_NAME
    known = json.loads(path.read_text()) if path.exists() else {}
    known.setdefault(signature, dict(firstSeen=now or time.time(), lines=[], bundles=[]))['owner'] = owner
    write_json(path, known)


def write_json(path, value):
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(value, indent=2) + '\n')
    temporary.replace(path)


def failed(item, error, now=None):
    global NOTIFIED
    now = time.time() if now is None else now
    signature, lines = failure_signature(error)
    path = STATE / SIGNATURES_NAME
    known = json.loads(path.read_text()) if path.exists() else {}
    entry = known.setdefault(signature, dict(firstSeen=now, lines=lines, bundles=[]))
    entry['lines'] = entry.get('lines') or lines
    entry['bundles'] = (entry.get('bundles', []) + [item.get('sha') or item['path']])[-20:]
    # An owned signature already has someone fixing it; an unowned one alerts once, then at most every six hours.
    alert = not entry.get('owner') and ('alertedAt' not in entry or now - entry['alertedAt'] >= UNOWNED_REALERT_S)
    if alert:
        entry['alertedAt'] = now
    write_json(path, known)
    receipt(item, status='failed', error=str(error), signature=signature,
            alert='sent' if alert else 'grouped', **({} if alert else dict(owner=entry.get('owner'))))
    NOTIFIED = True
    if not alert:
        return
    body = json.dumps(dict(bundle=item['path'], error=str(error), signature=signature, failing=lines[:20],
                           receipt=str(STATE / (Path(item['path']).name + '.json')),
                           group=f'Later bundles failing the same way are recorded quietly once an owner runs: '
                                 f'{Path(__file__).resolve()} --own {signature} OWNER'))
    run(['kenan-event', '--id', 'stack-intake-failed:' + item['digest'],
         'acme:manager:acme:stack-bundle-failed'], input=body, text=True)

if __name__ == '__main__':
    if len(sys.argv) == 4 and sys.argv[1] == '--own':
        own_signature(sys.argv[2], sys.argv[3])
        sys.exit(0)
    if len(sys.argv) != 1:
        # A mistyped option must not run a whole intake pass (or raise a failure event to the manager).
        print(USAGE, file=sys.stderr)
        sys.exit(2)
    try:
        main()
    except BlockingIOError:
        pass  # The active manual/automatic deployment owns the next timer turn.
    except Exception as error:
        if not NOTIFIED:
            run(['kenan-event', '--uid', str(pwd.getpwnam('kenan').pw_uid),
                 'acme:manager:acme:stack-bundle-failed'],
                input=json.dumps(dict(error=str(error), service='kenan-stack-intake.service')), text=True)
        raise
