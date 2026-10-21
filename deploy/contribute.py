#!/usr/bin/python3
"""Kenan Stack contribution queue: developers submit commits for the next combined Beta bundle.

Runs as kenan. Developers reach it through an exact sudo grant and stream a git bundle on stdin.
Nothing here builds or deploys code; the Kenan Beta publisher merges queued entries and deploys them with deploy/deploy.sh.
"""
import json, os, re, shutil, subprocess, sys, tempfile, time
from pathlib import Path

CANONICAL = Path('/home/kenan/work/repos/kenan.git')
QUEUE = Path('/var/lib/kenan/contributions')
DEVELOPERS = Path('/etc/kenan/developers.json')
BETA_SOURCE = Path('/srv/kenan/beta/source-commit')
PUBLISHER_UID = 1000
MAX_BUNDLE = 512 * 1024 * 1024
ROOT_EXECUTED = ('deploy/', 'patches/', 'package.json', 'package-lock.json')
USAGE = '''usage:
  git bundle create - BRANCH | sudo -n -u kenan kenan-stack-contribute check BRANCH FULL_SHA
  git bundle create - BRANCH | sudo -n -u kenan kenan-stack-contribute submit BRANCH FULL_SHA
  sudo -n -u kenan kenan-stack-contribute status [ID]
  sudo -n -u kenan kenan-stack-contribute base
  kenan-stack-contribute settle ID published SOURCE_COMMIT   (Beta publisher only)
  kenan-stack-contribute settle ID rejected REASON            (Beta publisher only)'''


class Refused(Exception):
    def __init__(self, code, message, exit_code, **detail):
        super().__init__(message)
        self.code, self.exit_code, self.detail = code, exit_code, detail


def emit(value):
    print(json.dumps(value, indent=1, sort_keys=True))


def git(*args, cwd=None, check=True):
    result = subprocess.run(['/usr/bin/git', *args], cwd=cwd, capture_output=True, text=True,
                            env={'PATH': '/usr/bin:/bin', 'HOME': '/home/kenan', 'GIT_TERMINAL_PROMPT': '0', 'LC_ALL': 'C'})
    if check and result.returncode != 0:
        raise Refused('git_failed', result.stderr.strip() or 'git ' + args[0] + ' failed', 5, command=list(args[:3]))
    return result


def caller():
    if os.getuid() != PUBLISHER_UID:
        raise Refused('wrong_identity', 'Run through sudo -n -u kenan', 2)
    raw = os.environ.get('SUDO_UID')
    if raw is None:
        return {'kind': 'publisher'}
    registry = json.loads(DEVELOPERS.read_text())
    if registry.get('version') != 1:
        raise Refused('registry_invalid', 'Unsupported developer registry version', 5)
    for name, entry in registry['developers'].items():
        if str(entry['uid']) == raw:
            return {'kind': 'developer', 'name': name, 'uid': entry['uid'], 'prefix': entry['refPrefix']}
    raise Refused('not_a_developer', 'This account is not enrolled as a Kenan Stack developer', 2)


def branch_name(value):
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._/-]{0,119}', value) or '..' in value or value.endswith(('.lock', '/', '.')):
        raise Refused('invalid_branch', 'Branch must be a simple name such as sidebar or feature/sidebar', 2)
    if git('check-ref-format', 'refs/heads/' + value, check=False).returncode != 0:
        raise Refused('invalid_branch', 'Branch name is not a valid Git ref', 2)
    return value


def full_sha(value):
    if not re.fullmatch(r'[0-9a-f]{40}', value):
        raise Refused('invalid_commit', 'Commit must be the full 40-character SHA', 2)
    return value


def beta_base():
    commit = BETA_SOURCE.read_text().strip()
    full_sha(commit)
    if git('cat-file', '-t', commit, cwd=CANONICAL, check=False).stdout.strip() != 'commit':
        raise Refused('base_missing', 'Serving Beta source commit is absent from the canonical repository', 5, base=commit)
    return {'sourceCommit': commit}


def receive_bundle(workdir, branch, sha):
    bundle = workdir / 'contribution.bundle'
    with open(bundle, 'wb') as out:
        total = 0
        while chunk := sys.stdin.buffer.read(1 << 20):
            total += len(chunk)
            if total > MAX_BUNDLE:
                raise Refused('bundle_too_large', 'Bundle exceeds 512 MiB', 4)
            out.write(chunk)
    if total == 0:
        raise Refused('bundle_missing', 'Stream `git bundle create - BRANCH` on stdin', 2)
    scratch = workdir / 'scratch.git'
    git('init', '--quiet', '--bare', str(scratch))
    (scratch / 'objects/info/alternates').write_text(str(CANONICAL / 'objects') + '\n')
    verified = git('bundle', 'verify', '--quiet', str(bundle), cwd=scratch, check=False)
    if verified.returncode != 0:
        raise Refused('bundle_invalid', verified.stderr.strip() or 'Bundle verification failed', 4)
    heads = dict(reversed(line.split(' ', 1)) for line in git('bundle', 'list-heads', str(bundle), cwd=scratch).stdout.splitlines())
    if heads.get('refs/heads/' + branch) != sha:
        raise Refused('bundle_mismatch', 'Bundle does not carry refs/heads/%s at %s' % (branch, sha), 4, heads=heads)
    git('fetch', '--quiet', '--no-tags', '--no-write-fetch-head', str(bundle), 'refs/heads/%s:refs/heads/candidate' % branch, cwd=scratch)
    if git('cat-file', '-t', sha, cwd=scratch).stdout.strip() != 'commit':
        raise Refused('bundle_invalid', 'Submitted object is not a commit', 4)
    return bundle, scratch


def assess(scratch, sha):
    base = beta_base()
    if git('merge-base', '--is-ancestor', base['sourceCommit'], sha, cwd=scratch, check=False).returncode != 0:
        raise Refused('stale_base', 'Rebase onto the serving Beta source commit before submitting', 3, base=base)
    changed = git('diff', '--name-only', base['sourceCommit'], sha, cwd=scratch).stdout.split()
    commits = int(git('rev-list', '--count', base['sourceCommit'] + '..' + sha, cwd=scratch).stdout)
    return {'base': base, 'commits': commits, 'changedFiles': len(changed),
            'rootExecutedPaths': sorted(p for p in changed if p.startswith(ROOT_EXECUTED))}


def entries():
    return sorted((json.loads(p.read_text()) for p in QUEUE.glob('*.json')), key=lambda e: e['submittedAt'])


def write_entry(entry):
    path = QUEUE / (entry['id'] + '.json')
    staged = path.with_suffix('.pending')
    staged.write_text(json.dumps(entry, indent=1, sort_keys=True) + '\n')
    os.chmod(staged, 0o644)
    os.replace(staged, path)


def contribute(who, mode, branch, sha):
    if who['kind'] != 'developer':
        raise Refused('developer_only', 'Only enrolled developers submit contributions', 2)
    branch, sha = branch_name(branch), full_sha(sha)
    ref = 'refs/heads/' + who['prefix'] + branch
    with tempfile.TemporaryDirectory(prefix='kenan-stack-contribute-') as tmp:
        bundle, scratch = receive_bundle(Path(tmp), branch, sha)
        assessment = assess(scratch, sha)
        plan = {'developer': who['name'], 'branch': branch, 'commit': sha, 'canonicalRef': ref, **assessment}
        if mode == 'check':
            return {'state': 'check-passed', 'dryRun': True, 'wouldQueue': plan,
                    'note': 'Nothing was written to the canonical repository or the queue.'}
        for entry in entries():
            if entry['state'] == 'queued' and entry['developer'] == who['name'] and entry['branch'] == branch and entry['commit'] == sha:
                return {'state': 'already-queued', 'entry': entry}
        git('fetch', '--quiet', '--no-tags', '--no-write-fetch-head', str(bundle), '+refs/heads/%s:%s' % (branch, ref), cwd=CANONICAL)
        if git('rev-parse', ref, cwd=CANONICAL).stdout.strip() != sha:
            raise Refused('ref_race', 'Canonical ref changed during submission', 5, ref=ref)
        now = int(time.time() * 1000)
        entry = {'id': '%s-%s-%s' % (who['name'], time.strftime('%Y%m%dT%H%M%SZ', time.gmtime(now / 1000)), sha[:8]),
                 'state': 'queued', 'submittedAt': now, **plan}
        for previous in entries():
            if previous['state'] == 'queued' and previous['developer'] == who['name'] and previous['branch'] == branch:
                previous.update(state='superseded', supersededBy=entry['id'], settledAt=now)
                write_entry(previous)
        write_entry(entry)
        return {'state': 'queued', 'entry': entry}


def settle(who, ident, outcome, detail):
    if who['kind'] != 'publisher':
        raise Refused('publisher_only', 'Only the Beta publisher settles contributions', 2)
    path = QUEUE / (ident + '.json')
    if not re.fullmatch(r'[A-Za-z0-9._-]+', ident) or not path.exists():
        raise Refused('unknown_entry', 'No such contribution', 2)
    if outcome == 'published' and not re.fullmatch(r'[0-9a-f]{40}', detail):
        raise Refused('invalid_release', 'Published requires the deployed Beta source commit', 2)
    if outcome not in ('published', 'rejected') or not detail.strip():
        raise Refused('invalid_outcome', 'Outcome is published SOURCE_COMMIT or rejected REASON', 2)
    entry = json.loads(path.read_text())
    if entry['state'] != 'queued':
        raise Refused('not_queued', 'Contribution is already ' + entry['state'], 2)
    entry.update(state=outcome, settledAt=int(time.time() * 1000), **({'release': detail} if outcome == 'published' else {'reason': detail}))
    write_entry(entry)
    return {'state': 'settled', 'entry': entry}


def main(argv):
    who = caller()
    match argv:
        case ['check' | 'submit' as mode, branch, sha]:
            return contribute(who, mode, branch, sha)
        case ['status']:
            visible = [e for e in entries() if who['kind'] == 'publisher' or e['developer'] == who['name']]
            return {'state': 'listed', 'entries': visible}
        case ['status', ident]:
            match = [e for e in entries() if e['id'] == ident and (who['kind'] == 'publisher' or e['developer'] == who['name'])]
            if not match:
                raise Refused('unknown_entry', 'No such contribution', 2)
            return {'state': 'found', 'entry': match[0]}
        case ['base']:
            return {'state': 'serving-beta', **beta_base()}
        case ['settle', ident, outcome, *detail] if detail:
            return settle(who, ident, outcome, ' '.join(detail))
        case _:
            raise Refused('usage', USAGE, 2)


if __name__ == '__main__':
    try:
        emit({'ok': True, 'value': main(sys.argv[1:])})
    except Refused as refused:
        emit({'ok': False, 'error': {'code': refused.code, 'message': str(refused), **refused.detail}})
        sys.exit(refused.exit_code)
