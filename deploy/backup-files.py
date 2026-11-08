#!/usr/bin/python3
"""Pair the Kenan database recovery point with files in the existing B2 repository."""
import datetime
import json
import os
from pathlib import Path
import subprocess
import sys

os.umask(0o077)
# The nightly system backup writes the same B2 repository for hours and snapshots /var/lib/kenan itself; an hourly file
# snapshot beside it only queues on its lock (2026-10-29: kenan-backup failed waiting). The database step already ran.
if subprocess.run(['systemctl','is-active','--quiet','restic-system-backup.service']).returncode==0 or \
        subprocess.run(['systemctl','show','-p','ActiveState','--value','restic-system-backup.service'],capture_output=True,text=True).stdout.strip()=='activating':
    print('nightly system backup is running; this hour\'s file snapshot is skipped (the nightly one covers these paths)',flush=True)
    raise SystemExit(0)
credentials=json.loads(Path('/root/restic-access.json').read_text())
env=os.environ.copy()
env.update({key:value for key,value in credentials.items() if key!='repository'})
env['RESTIC_REPOSITORY']=credentials['repository']
env['RESTIC_CACHE_DIR']='/var/lib/restic-system/cache'
env['GOMEMLIMIT']='4GiB'
paths=['/var/lib/kenan/beta','/var/lib/kenan/production','/var/lib/kenan/shared-files','/var/lib/kenan/android','/var/lib/kenan/account-state']
command=['/usr/bin/restic','--retry-lock','5m']
# A pack B2 couldn't serve earlier was taken out of the index; once B2 serves it again this puts it back.
subprocess.run(['/usr/local/sbin/restic-pack-guard','probe'],check=True)

def backup():
    result=subprocess.run(command+['backup',*paths,'--host','assistant-host','--tag','kenan-files','--json'],env=env,text=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
    sys.stderr.write(result.stderr)
    # restic --json writes its per-item errors to stderr, among plain-text retry messages.
    errors=[row['error']['message'] for line in result.stderr.splitlines() if line.startswith('{') and (row:=json.loads(line)).get('message_type')=='error']
    # Exit 3 whose every error is an unreadable earlier tree still wrote a complete snapshot: restic re-reads those
    # directories in full. Any other error (a source file restic couldn't read) fails the unit as before.
    damage_only=result.returncode==3 and errors and all('the repository could be damaged' in error for error in errors)
    if result.returncode!=0 and not damage_only:
        raise subprocess.CalledProcessError(result.returncode,result.args,result.stdout)
    return result.stdout,result.stderr if damage_only else None

output,damage=backup()
if damage:
    # 2026-10-29: B2 answered 503 for one pack for hours and every hourly run failed. pack-guard takes any pack B2
    # really can't serve out of the index (the file stays) and opens an alert; the second backup then stores those
    # trees again, so this snapshot doesn't depend on the unreadable pack.
    guard=subprocess.run(['/usr/local/sbin/restic-pack-guard','handle-backup'],input=damage,text=True,stdout=subprocess.PIPE,check=True)
    if json.loads(guard.stdout):
        output,damage=backup()
summary=next((row for line in output.splitlines() if (row:=json.loads(line)).get('message_type')=='summary'),None)
if not summary or not summary.get('snapshot_id'):
    raise RuntimeError('File backup returned no snapshot')
subprocess.run(command+['unlock'],env=env,check=True)
# No --prune: pruning repacks the whole shared repository. restic-system-maintenance prunes it weekly through cpu-slot.
# The nightly system backup shares this repository and can hold its lock for longer than five minutes. The snapshot is
# already made, so a locked repository (restic exit 11) leaves forgetting to the next hourly run instead of failing it.
forget=subprocess.run(command+['forget','--host','assistant-host','--tag','kenan-files','--keep-last','2','--group-by','paths'],env=env)
if forget.returncode==11:
    print('repository locked by another backup; old kenan-files snapshots are forgotten on the next run',flush=True)
elif forget.returncode!=0:
    raise subprocess.CalledProcessError(forget.returncode,forget.args)
summary['observedAt']=datetime.datetime.now(datetime.timezone.utc).isoformat()
target=Path('/var/lib/kenan/backup/files-snapshot.json')
temporary=target.with_suffix('.tmp')
temporary.write_text(json.dumps(summary,indent=2)+'\n')
os.replace(temporary,target)
print(json.dumps({'artifactSnapshotId':summary['snapshot_id'],'observedAt':summary['observedAt']}))
