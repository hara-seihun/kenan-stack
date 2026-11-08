#!/bin/bash
# Brings the phone edge's call logs and recordings home: started by the server the moment an edge call is settled
# (pullEdgeLogs in server/extensions/phone-host.ts), and by kenan-phone-edge-pull.timer every minute as the retry. A
# finished call's log lines are appended to the server's own log of the same call; a recording is moved once its bridge
# has stopped. Call logs and recordings are group `kenan` readable, so Alice's agents read them without sudo.
set -euo pipefail
config=/etc/kenan/phone-edge.json
read -r host user key known data <<<"$(python3 -c 'import json,sys; c=json.load(open(sys.argv[1])); print(c["host"], c["user"], c["sshKeyPath"], c["knownHostsPath"], c["dataRoot"])' "$config")"
# Rides the server's standing connection (kenan-phone-edge-ssh.service) when it is up; opens its own otherwise.
ssh_cmd="ssh -i $key -o UserKnownHostsFile=$known -o StrictHostKeyChecking=yes -o BatchMode=yes -o ConnectTimeout=10 -o ControlMaster=auto -o ControlPath=/run/kenan/phone-edge-%C -o ControlPersist=6h"
readable() {
 local dir
 for dir in /var/lib/kenan/{beta,production}/{call-logs,call-audio}; do
  install -d -m 2750 -g kenan "$dir"
  chgrp -R kenan "$dir"; chmod 2750 "$dir"; find "$dir" -type f ! -perm -g=r -exec chmod g+r {} +
 done
}
stage=$(mktemp -d /var/tmp/phone-edge-pull.XXXXXX); trap 'rm -rf "$stage"; readable' EXIT
# Only files of calls whose bridge is no longer running: the edge lists them, so nothing still being written moves.
done_files=$($ssh_cmd "$user@$host" 'cd '"$data"' 2>/dev/null || exit 0; for f in */call-logs/*.jsonl */call-audio/*.wav; do [ -e "$f" ] || continue; id=$(basename "$f"); id=${id%.*}; systemctl is-active --quiet "kenan-call-$id" || echo "$f"; done')
[[ -n $done_files ]] || exit 0
printf '%s\n' $done_files > "$stage/list"
timeout 300 rsync -a --files-from="$stage/list" -e "$ssh_cmd" "$user@$host:$data/" "$stage/files/"
moved=()
while read -r f; do
 channel=${f%%/*}; [[ $channel == beta || $channel == production ]] || continue
 dest=/var/lib/kenan/$channel/${f#*/}
 install -d -m 2750 -g kenan "$(dirname "$dest")"
 if [[ $f == *.jsonl ]]; then cat "$stage/files/$f" >> "$dest"; chmod 640 "$dest"; else install -m 640 -g kenan "$stage/files/$f" "$dest"; fi
 moved+=("$data/$f")
done < "$stage/list"
# One removal for everything moved; ssh reads no stdin here, so it cannot swallow the list.
(( ${#moved[@]} )) && $ssh_cmd -n "$user@$host" "rm -f ${moved[*]}"
exit 0
