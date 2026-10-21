#!/usr/bin/python3
"""Pair the Kenan database recovery point with files in the existing B2 repository."""
import datetime
import json
import os
from pathlib import Path
import subprocess

os.umask(0o077)
credentials=json.loads(Path('/root/restic-access.json').read_text())
env=os.environ.copy()
env.update({key:value for key,value in credentials.items() if key!='repository'})
env['RESTIC_REPOSITORY']=credentials['repository']
env['RESTIC_CACHE_DIR']='/var/lib/restic-system/cache'
env['GOMEMLIMIT']='4GiB'
paths=['/var/lib/kenan/beta','/var/lib/kenan/production','/var/lib/kenan/shared-files','/var/lib/kenan/android','/var/lib/kenan/account-state']
command=['/usr/bin/restic','--retry-lock','5m']
output=subprocess.check_output(command+['backup',*paths,'--host','kenan-server','--tag','kenan-files','--json'],env=env,text=True)
summary=next((row for line in output.splitlines() if (row:=json.loads(line)).get('message_type')=='summary'),None)
if not summary or not summary.get('snapshot_id'):
    raise RuntimeError('File backup returned no snapshot')
subprocess.run(command+['forget','--host','kenan-server','--tag','kenan-files','--keep-last','2','--group-by','paths','--prune'],env=env,check=True)
summary['observedAt']=datetime.datetime.now(datetime.timezone.utc).isoformat()
target=Path('/var/lib/kenan/backup/files-snapshot.json')
temporary=target.with_suffix('.tmp')
temporary.write_text(json.dumps(summary,indent=2)+'\n')
os.replace(temporary,target)
print(json.dumps({'artifactSnapshotId':summary['snapshot_id'],'observedAt':summary['observedAt']}))
