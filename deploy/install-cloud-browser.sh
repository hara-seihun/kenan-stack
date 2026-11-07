#!/bin/bash
# Install the shared cloud client and select the activity-aware browser wrapper.
set -euo pipefail
cd "$(dirname "$0")"
# A client-only repair must not rewrite broker services, select another browser,
# seed existing sessions or touch any profile/configuration/credential state.
if [[ ${1:-} == --client-only && $# == 1 ]]; then
  install -d -m755 /usr/local/lib/kenan/browser-use
  # cloud-browser.py imports activity.py: a client without it cannot start.
  install -m644 cloud-browser/cloud-browser.py cloud-browser/activity.py /usr/local/lib/kenan/browser-use/
  git rev-parse HEAD > /usr/local/lib/kenan/browser-use/CLOUD_CLIENT_SOURCE_COMMIT
  echo 'cloud-browser: installed the client only; sessions, services and configuration are unchanged'
  exit 0
elif (( $# )); then
  echo 'usage: install-cloud-browser.sh [--client-only]' >&2
  exit 2
fi
if [[ -f /etc/kenan/browser-use.key ]]; then
  broker_unit=cloud-browser-broker-local.service
elif [[ -f /etc/kenan-session-scope/browser-use/api-key ]]; then
  broker_unit=cloud-browser-broker.service
else
  echo 'cloud-browser: no host key; broker unchanged'
  exit 0
fi
python3 -c 'import websockets' 2>/dev/null || { DEBIAN_FRONTEND=noninteractive apt-get install -y -q python3-websockets >/dev/null; }
changed=0
install -d -m755 /usr/local/lib/kenan/browser-use
for f in cloud-browser cloud-browser.py broker.py activity.py agent-browser.py; do
  mode=644; [[ $f == cloud-browser ]] && mode=755
  if ! cmp -s "cloud-browser/$f" "/usr/local/lib/kenan/browser-use/$f"; then install -m$mode "cloud-browser/$f" /usr/local/lib/kenan/browser-use/; changed=1; fi
done
ln -sfn /usr/local/lib/kenan/browser-use/cloud-browser /usr/local/bin/cloud-browser
# Give already-open browsers one ordinary idle interval to register their next command.
python3 - <<'SEED'
import json, os, time, uuid
from pathlib import Path
for config in Path('/run/user').glob('*/cloud-browser/*.json'):
    try:
        if str(uuid.UUID(config.stem)) != config.stem:
            continue
    except ValueError:
        continue
    directory = config.with_suffix('.activity')
    if directory.exists():
        continue
    owner = config.stat()
    directory.mkdir(mode=0o700)
    os.chown(directory, owner.st_uid, owner.st_gid)
    record = directory / 'shell.json'
    record.write_text(json.dumps({'agentId': None, 'lastUsedAt': time.time_ns() // 1_000_000, 'keepAliveMinutes': None}))
    os.chmod(record, 0o600)
    os.chown(record, owner.st_uid, owner.st_gid)
SEED
if ! cmp -s "cloud-browser/$broker_unit" /etc/systemd/system/cloud-browser-broker.service; then
  install -m644 "cloud-browser/$broker_unit" /etc/systemd/system/cloud-browser-broker.service
  systemctl daemon-reload
  changed=1
fi
systemctl enable cloud-browser-broker.service >/dev/null
if (( changed )); then systemctl restart cloud-browser-broker.service; else systemctl start cloud-browser-broker.service; fi
# Clients retry only connection establishment while the broker binds its socket.
if [[ -x /home/kenan/.local/bin/agent-browser ]]; then
  sh install-browser.sh select "$(sh install-browser.sh current)"
fi
echo 'cloud-browser: installed'
