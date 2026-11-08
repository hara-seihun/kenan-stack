#!/usr/bin/python3
"""Select the maintained read-only coverage adapter; retain the exact frozen Calendar implementation."""
import json
from pathlib import Path
import shutil
import hashlib
import os
# The frozen modules the adapter imports relative to the detector (deploy/meeting-coverage-observer.mjs, main()).
FROZEN_MODULES = (
    'infrastructure/architecture/tools/meeting-discovery/detector.ts',
    'infrastructure/architecture/tools/meeting-discovery/handoff.ts',
    'infrastructure/architecture/tools/meeting-discovery/observer-receipt.ts',
    'products/kenan/src/meeting-agent/calendar.ts',
    'products/kenan/src/meeting-agent/attendance-policy.ts',
    'products/kenan/src/meeting-agent/gcs.ts',
    'products/kenan/src/meeting-agent/read-request.ts',
)
def check_frozen_release(detector):
    """A deploy never points Beta's observer at a detector release that is gone or incomplete: every run would fail
    as detector-unavailable. Refuse before the configuration changes."""
    path = Path(detector)
    root = path.parents[4] if len(path.parents) > 4 else path.parent
    missing = [m for m in FROZEN_MODULES if not (root / m).is_file()]
    if path.name != 'detector.ts' or missing:
        raise RuntimeError(f'meeting_observer_release_incomplete: {detector} lacks {missing or ["detector.ts"]}')

def install(config=Path('/etc/kenan/acme-meeting-beta.json'), destination_root=Path('/opt/kenan-acme/deploy')):
    if not config.exists():
        return
    data = json.loads(config.read_text())
    observer = data['tools']['meeting']['observer']
    args = observer['args']
    source = Path(__file__).with_name('meeting-coverage-observer.mjs')
    digest = hashlib.sha256(source.read_bytes()).hexdigest()
    destination = destination_root / ('meeting-coverage-observer-'+digest+'.mjs')
    if not destination.exists():
        shutil.copyfile(source, destination)
    if args and args[0].startswith(('/opt/kenan-acme/deploy/meeting-coverage-observer-', str(destination_root / 'meeting-coverage-observer-'))):
        args = args[1:]
    if not args or not args[0].startswith('/opt/kenan-meeting-discovery/releases/') or args[1:] != ['/etc/kenan-meeting-discovery.json', '--dry-run']:
        raise RuntimeError('Unexpected observer source; preserve its owning configuration')
    check_frozen_release(args[0])
    if observer['args'] != [str(destination), *args]:
        observer['args'] = [str(destination), *args]
        temporary = config.with_suffix('.json.tmp')
        temporary.write_text(json.dumps(data, indent=2)+'\n')
        os.chmod(temporary, config.stat().st_mode & 0o777)
        os.chown(temporary, config.stat().st_uid, config.stat().st_gid)
        temporary.replace(config)

if __name__ == '__main__':
    install()
