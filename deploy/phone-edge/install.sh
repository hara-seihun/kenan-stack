#!/bin/bash
# Sets up the phone edge (machine/phone-calling.md, "Phone edge") from assistant-host, as root: the database port the edge's
# bridges use, the log puller, and the edge itself (Node, the bridge launcher, directories). Safe to run again.
# The edge is a Hetzner Cloud server reached over the household mesh; /etc/kenan/phone-edge.json describes it.
set -euo pipefail
(( EUID == 0 )) || exec sudo -n "$0" "$@"
cd "$(dirname "$(realpath "$0")")"
bash ./ensure-runtime.sh
config=/etc/kenan/phone-edge.json
read -r host user key known dbhost dbport release data <<<"$(python3 -c 'import json,sys; c=json.load(open(sys.argv[1])); print(*(c[k] for k in ("host","user","sshKeyPath","knownHostsPath","databaseHost","databasePort","releaseRoot","dataRoot")))' "$config")"
ssh_cmd=(ssh -i "$key" -o "UserKnownHostsFile=$known" -o StrictHostKeyChecking=yes -o BatchMode=yes -o ConnectTimeout=10 "$user@$host")

id -u kenan_phone_edge >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin kenan_phone_edge
for db in kenan_beta kenan_production; do
 psql "postgresql:///$db?host=/run/kenan/pg&user=root" -v dbname="$db" -q -f edge-db.sql
done
printf 'BIND=%s\nPORT=%s\nEDGE=%s\n' "$dbhost" "$dbport" "$host" > /etc/kenan/phone-edge.env
install -m 0644 kenan-phone-edge-db.service kenan-phone-edge-ssh.service kenan-phone-edge-pull.service kenan-phone-edge-pull.timer /etc/systemd/system/
install -m 0755 pull-logs.sh /usr/local/sbin/kenan-phone-edge-pull
systemctl daemon-reload
systemctl enable --now kenan-phone-edge-db.service kenan-phone-edge-ssh.service kenan-phone-edge-pull.timer
systemctl restart kenan-phone-edge-db.service

# The edge: the same Node as the server, the launcher, and RAM-only spec directory created per call.
node_dir=$(dirname "$(dirname "$(readlink -f /usr/local/bin/node)")")
rsync -a -e "${ssh_cmd[*]:0:${#ssh_cmd[@]}-1}" "$node_dir/" "$user@$host:/opt/node/"
"${ssh_cmd[@]}" "ln -sfn /opt/node/bin/node /usr/local/bin/node && install -d -m 755 $release && install -d -m 700 $data && timedatectl set-ntp true"
rsync -a -e "${ssh_cmd[*]:0:${#ssh_cmd[@]}-1}" kenan-edge-bridge "$user@$host:/usr/local/bin/kenan-edge-bridge"
"${ssh_cmd[@]}" 'node --version; kenan-edge-bridge 2>&1 | head -1 || true'
