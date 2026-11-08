#!/usr/bin/python3
"""Retire only after a completed inventory handover; keep the original in inert root custody."""
import datetime
import json
import os
from pathlib import Path
import re
import stat
import sys
import tempfile


def retire(alias, pool_path, state_path, accounts, inert):
    if not re.fullmatch(r'openai-codex-\d+', alias):
        raise ValueError('invalid_pool_alias')
    pool_bytes = pool_path.read_bytes()
    pool = json.loads(pool_bytes)
    if any(a['id'] == alias for a in pool['accounts']):
        raise ValueError('account_still_pooled')
    state_bytes = state_path.read_bytes()
    state = json.loads(state_bytes)
    if state.get('pending') or state.get('draining') or not state.get('current'):
        raise ValueError('broker_handover_incomplete')
    ready = datetime.datetime.fromisoformat(state['current']['readyAt'].replace('Z', '+00:00')).timestamp()
    if ready <= pool_path.stat().st_mtime:
        raise ValueError('broker_generation_predates_inventory')
    os.kill(state['current']['pid'], 0)
    source = accounts / (alias + '.json')
    if source.is_symlink() or not stat.S_ISREG(source.stat().st_mode):
        raise ValueError('unsafe_auth_file')
    original = source.read_bytes()
    if json.loads(original).get('openai-codex', {}).get('type') == 'transferred':
        return {'alias': alias, 'state': 'already_transferred'}
    inert.mkdir(parents=True, exist_ok=True, mode=0o700)
    if inert.is_symlink() or inert.stat().st_uid != os.geteuid() or stat.S_IMODE(inert.stat().st_mode) != 0o700:
        raise ValueError('unsafe_inert_custody')
    folder = Path(tempfile.mkdtemp(prefix=alias + '-', dir=inert))
    backup = folder / 'auth.json'
    fd = os.open(backup, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    with os.fdopen(fd, 'wb') as f:
        f.write(original)
        f.flush()
        os.fsync(f.fileno())
    # Refuse an inventory, generation or credential change rather than retire against stale evidence.
    if pool_path.read_bytes() != pool_bytes or state_path.read_bytes() != state_bytes or source.read_bytes() != original:
        raise ValueError('retirement_state_changed')
    receipt = {'openai-codex': {'type': 'transferred', 'alias': alias,
               'transferredAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
               'reason': 'Removed from the pool after completed broker generation handover.'}}
    owner = source.stat()
    fd, temporary = tempfile.mkstemp(prefix='.' + alias + '-', dir=accounts)
    try:
        with os.fdopen(fd, 'w') as f:
            os.fchmod(f.fileno(), 0o600)
            os.fchown(f.fileno(), owner.st_uid, owner.st_gid)
            json.dump(receipt, f)
            f.write('\n')
            f.flush()
            os.fsync(f.fileno())
        os.replace(temporary, source)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    return {'alias': alias, 'state': 'transferred', 'inertPath': str(backup)}


if __name__ == '__main__':
    if os.geteuid() != 0:
        sys.exit('account_retirement_requires_root')
    try:
        print(json.dumps(retire(sys.argv[1], Path('/etc/pi-stack-next/employee-model-pool.json'),
              Path('/run/kenan-acme-broker/state.json'),
              Path('/var/lib/pi-stack-next/domains/acme/plain/home/agent/accounts'),
              Path('/var/lib/kenan/retired-accounts'))))
    except Exception as error:
        # Never expose an exception body that might include credential bytes.
        code = str(error) if isinstance(error, ValueError) and re.fullmatch('[a-z_]+', str(error)) else 'account_retirement_failed'
        sys.exit(code)
