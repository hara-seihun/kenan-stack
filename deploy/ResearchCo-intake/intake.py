#!/usr/bin/python3
"""Read Acme's exports; merge locally, deploy ResearchCo Beta and return source."""
import argparse
import fcntl
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys
import time
import uuid

REPO = Path('/home/kenan/work/repos/kenan.git')
CANONICAL = Path('/home/kenan/work/kenan-cache-fix')
STATE = Path('/home/kenan/.local/state/kenan-ResearchCo-intake')
WORK = STATE / 'work'
OUTBOX = Path('/var/lib/kenan/peer-outbox/alice')
BRANCH = 'rewrite/app-polish'
SSH = ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15']
LIST = """import json,pathlib
p=pathlib.Path('/var/tmp/kenan-stack-to-ResearchCo')
print(json.dumps([str(f) for f in sorted(p.glob('*.bundle'), key=lambda f:(f.stat().st_mtime_ns,f.name)) if f.with_suffix('.json').is_file()]))
"""


class IntakeError(Exception):
    def __init__(self, message, **details):
        super().__init__(message)
        self.details = details


def run(*args, cwd=None, data=None, timeout=1800):
    result = subprocess.run([str(a) for a in args], cwd=cwd, input=data,
                            text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            timeout=timeout)
    if result.returncode:
        raise IntakeError(f'Command failed ({result.returncode}): {shlex.join(map(str, args))}',
                          output=(result.stdout + result.stderr)[-12000:])
    return result.stdout.strip()


def ssh_run(*args, attempts=4):
    # Transient DNS/IAP/ssh failures (e.g. around a host restart) are retried before failing.
    for attempt in range(attempts):
        try:
            return run(*SSH, *args)
        except IntakeError:
            if attempt == attempts - 1:
                raise
            time.sleep(15 * (attempt + 1))


def git(tree, *args):
    return run('git', '--no-optional-locks', '-C', tree, *args)


def ancestor(tree, older, newer):
    result = subprocess.run(['git', '-C', str(tree), 'merge-base', '--is-ancestor', older, newer])
    if result.returncode not in (0, 1):
        raise IntakeError('Could not compare Git ancestors', tree=str(tree), older=older, newer=newer)
    return result.returncode == 0


def write_json(path, value):
    temporary = path.with_name(path.name + '.partial')
    with temporary.open('w') as stream:
        json.dump(value, stream, indent=2)
        stream.write('\n')
        stream.flush()
        os.fsync(stream.fileno())
    temporary.replace(path)


def clean(tree):
    status = git(tree, 'status', '--porcelain')
    if status:
        raise IntakeError('Please commit or move the existing edits; intake never discards them.',
                          tree=str(tree), files=status)
    if git(tree, 'branch', '--show-current') != BRANCH and tree == CANONICAL:
        raise IntakeError('Integration checkout is on another branch', tree=str(tree), expected=BRANCH)


def merge(tree, tip):
    clean(tree)
    if ancestor(tree, tip, 'HEAD'):
        return
    try:
        git(tree, '-c', 'user.name=Kenan', '-c', 'user.email=kenan@example.com',
            'merge', '--no-edit', tip)
    except IntakeError as error:
        files = git(tree, 'diff', '--name-only', '--diff-filter=U').splitlines()
        # Only abort a merge started in this dedicated checkout. Never touch agent work.
        if Path(git(tree, 'rev-parse', '--git-path', 'MERGE_HEAD')).exists():
            git(tree, 'merge', '--abort')
        raise IntakeError('Automatic merge failed; please merge these changes explicitly.',
                          tree=str(tree), incoming=tip, files=files, cause=str(error),
                          output=error.details.get('output', '')) from error


def live(channel):
    path = Path('/srv/kenan') / channel / 'source-commit'
    return path.read_text().strip() if path.exists() else None


def deploy_beta(tree, tip):
    if live('beta') != tip:
        run('bash', tree / 'deploy/deploy.sh', 'beta', '--wait', cwd=tree)
    if live('beta') != tip:
        raise IntakeError('Beta changed during intake; please include its new commit before retrying.',
                          expected=tip, live=live('beta'))


def queue_decision(key, body):
    # Only conflicts requiring a source decision go to Acme; completion stays in the journal.
    note = dict(id=str(uuid.uuid5(uuid.NAMESPACE_URL, 'ResearchCo-intake-decision:' + key)),
                peer='acme', to='manager:acme',
                **{'from': 'deploy:ResearchCo-intake'},
                text='ResearchCo intake needs a merge decision: ' + json.dumps(body),
                createdAt=int(time.time() * 1000))
    write_json(OUTBOX / f'ResearchCo-intake-decision-{key}.json', note)


def notify(state, key, error, **details):
    # Stable event IDs also deduplicate a crash between enqueue and state publication.
    # A new outage after recovery must notify again, unlike a previously reported bundle.
    if key == 'poll':
        if 'pollIncident' not in state:
            state['pollIncident'] = str(uuid.uuid4())
            write_json(STATE / 'state.json', state)
        key += '-' + state['pollIncident']
    if key in state.setdefault('notified', []):
        return
    body = {**details, **getattr(error, 'details', {}), 'error': str(error),
            'action': 'Please repair the named condition and rerun kenan-ResearchCo-intake.service.'}
    print(json.dumps(body), file=sys.stderr, flush=True)
    run('kenan-event', '--id', 'ResearchCo-intake:' + key,
        'goal-0adb0d99-7e4b-4916-bbbe-ff5869be4f09:ResearchCo-intake', data=json.dumps(body))
    if body.get('incoming') and body.get('files'):
        queue_decision(key, body)
    state['notified'].append(key)
    write_json(STATE / 'state.json', state)


def complete_bundle(tip):
    path = STATE / f'{tip}.integrated.bundle'
    if not path.exists():
        ref = 'refs/ResearchCo-intake/integrated'
        git(REPO, 'update-ref', ref, tip)
        partial = path.with_suffix('.partial')
        git(REPO, 'bundle', 'create', str(partial), ref)
        partial.replace(path)
    return path


def process(items, state):
    if not items:
        return
    processed = state.setdefault('processed', {})
    head = git(CANONICAL, 'rev-parse', 'HEAD')
    source = git(REPO, 'rev-parse', f'{head}^{{tree}}')
    pending = []
    for item in items:
        tip = item['tip']
        record = processed.get(tip)
        if record and record.get('done'):
            continue
        if not record and ancestor(REPO, tip, head):
            processed[tip] = dict(done=True, alreadyIntegrated=True)
        elif not record and git(REPO, 'rev-parse', f'{tip}^{{tree}}') == source:
            # Both hosts can merge the same parents independently. Different merge commit
            # IDs with identical source must not trigger another merge/deploy/export cycle.
            processed[tip] = dict(done=True, sameSource=True)
            print(f'ResearchCo intake: {tip} has no source changes; no merge or deployment.', flush=True)
        else:
            pending.append(item)
    write_json(STATE / 'state.json', state)
    if not pending:
        return
    # A recorded unfinished item must finish publication even when a previous attempt
    # already advanced canonical source. New imports share one publication below.
    resuming = any(item['tip'] in processed for item in pending)
    for item in pending:
        processed.setdefault(item['tip'], dict(done=False))
    write_json(STATE / 'state.json', state)
    clean(CANONICAL)
    if not WORK.exists():
        git(REPO, 'worktree', 'add', '-b', 'host/ResearchCo-intake', str(WORK), BRANCH)
    merge(WORK, head)
    # All deltas were fetched in order. A later descendant already includes its earlier
    # exports, so merge only the remaining independent tips, then deploy the combined tree.
    tips = [item['tip'] for item in pending]
    for tip in tips:
        if not any(other != tip and ancestor(REPO, tip, other) for other in tips):
            merge(WORK, tip)
    integrated = git(WORK, 'rev-parse', 'HEAD')
    changed = git(REPO, 'rev-parse', f'{integrated}^{{tree}}') != source
    clean(CANONICAL)
    # --ff-only refuses a concurrent divergent commit; Git preserves all tracked/untracked edits.
    git(CANONICAL, 'merge', '--ff-only', integrated)
    if git(CANONICAL, 'rev-parse', 'HEAD') != integrated:
        raise IntakeError('Canonical source advanced during intake; the next tick will include it.',
                          tree=str(CANONICAL), integrated=integrated)
    if changed or resuming:
        publish(integrated)
    for item in pending:
        processed[item['tip']] = dict(done=True, integrated=integrated)
    write_json(STATE / 'state.json', state)
    print(f'ResearchCo intake: combined {len(pending)} exports as {integrated}; '
          + ('deployed and returned source.' if changed or resuming else 'no source changes to deploy.'), flush=True)


def publish(integrated):
    deploy_beta(WORK, integrated)
    run('bash', WORK / 'deploy/bundle-acme.sh', integrated, cwd=WORK)


def collect(state, remote_files):
    items = []
    seen = set()
    for remote in remote_files:
        # The manifest and bundle select the commit, not the descriptive export filename.
        path = Path(remote)
        if path.parent != Path('/var/tmp/kenan-stack-to-ResearchCo') or path.suffix != '.bundle':
            raise IntakeError('Unexpected export filename', bundle=remote)
        name = path.name
        try:
            manifest = (STATE / name).with_suffix('.json')
            if not manifest.exists():
                run('scp', '-q', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15',
                    'acme-host:' + remote[:-7] + '.json', str(manifest) + '.partial')
                Path(str(manifest) + '.partial').replace(manifest)
            item = json.loads(manifest.read_text())
            tip = item['tip']
            if not isinstance(tip, str) or not re.fullmatch('[0-9a-f]{40}', tip):
                raise IntakeError('Manifest tip must be a full commit id', bundle=remote)
            # Exports are immutable. Completed tips need no bundle read, fetch or
            # ancestry comparison on subsequent ticks; unfinished publications retry.
            if state.get('processed', {}).get(tip, {}).get('done'):
                continue
            target = STATE / name
            if not target.exists():
                run('scp', '-q', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15',
                    'acme-host:' + remote, str(target) + '.partial')
                Path(str(target) + '.partial').replace(target)
            heads = git(REPO, 'bundle', 'list-heads', str(STATE / name)).splitlines()
            if {line.split()[0] for line in heads} != {tip}:
                raise IntakeError('Bundle tips do not match manifest', bundle=remote)
            # Import every delta, oldest first, even if its source has already been integrated.
            if tip not in state.setdefault('imported', []):
                git(REPO, 'fetch', str(STATE / name), f'{tip}:refs/ResearchCo-intake/incoming/{tip}')
                state['imported'].append(tip)
                write_json(STATE / 'state.json', state)
            if tip not in seen:
                items.append(dict(tip=tip, bundle=remote))
                seen.add(tip)
        except Exception as error:
            notify(state, 'import-' + name, error, bundle=remote, tree=str(WORK))
    return items


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--inspect', action='store_true', help='Read source/status and export listing only; no local or remote writes')
    args = parser.parse_args()
    if args.inspect:
        print(json.dumps(dict(repo=str(REPO), canonical=str(CANONICAL),
                              branch=git(CANONICAL, 'branch', '--show-current'),
                              edits=git(CANONICAL, 'status', '--porcelain'),
                              state=str(STATE), exports=json.loads(ssh_run('acme-host',
                                                                       'python3 -c ' + shlex.quote(LIST)))), indent=2))
        return
    STATE.mkdir(parents=True, exist_ok=True)
    with (STATE / 'run.lock').open('w') as lock:
        # No queue: systemd already serializes this unit; a manual concurrent run exits immediately.
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
        path = STATE / 'state.json'
        state = json.loads(path.read_text()) if path.exists() else {}
        try:
            files = json.loads(ssh_run('acme-host', 'python3 -c ' + shlex.quote(LIST)))
            items = collect(state, files)
            try:
                process(items, state)
            except Exception as error:
                notify(state, 'process-' + (items[-1]['tip'] if items else 'empty'), error,
                       bundles=[item['bundle'] for item in items], tree=str(WORK))
                # The entire batch remains unfinished and retries together next tick.
            if state.pop('pollIncident', None):
                write_json(path, state)
        except Exception as error:
            notify(state, 'poll', error, tree=str(WORK))
            raise


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps(dict(error=str(error), **getattr(error, 'details', {}))), file=sys.stderr)
        sys.exit(1)
