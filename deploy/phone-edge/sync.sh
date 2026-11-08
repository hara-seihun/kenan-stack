#!/bin/bash
# Copies a channel's build to the phone edge (deploy.sh runs it before the server switches builds), so the edge's call
# bridges always run the same commit as the server that writes their specs. Hosts without /etc/kenan/phone-edge.json skip.
set -euo pipefail
channel=${1:?beta|production}; build=${2:?build directory}
config=/etc/kenan/phone-edge.json
[[ -f $config ]] || { echo "$channel: no phone edge on this host"; exit 0; }
bash "$(dirname "$(realpath "$0")")/ensure-runtime.sh"
read -r host user key known release <<<"$(python3 -c 'import json,sys; c=json.load(open(sys.argv[1])); print(c["host"], c["user"], c["sshKeyPath"], c["knownHostsPath"], c["releaseRoot"])' "$config")"
ssh_cmd="ssh -i $key -o UserKnownHostsFile=$known -o StrictHostKeyChecking=yes -o BatchMode=yes -o ConnectTimeout=10"
# node_modules in a build is a link to the shared dependency tree, copied whole; links inside it stay links.
timeout 600 rsync -a --delete --copy-unsafe-links -e "$ssh_cmd" "$build/dist" "$build/node_modules" "$build/package.json" "$user@$host:$release/$channel/"
$ssh_cmd "$user@$host" "echo $(git -C "$build" rev-parse HEAD 2>/dev/null || basename "$build") > $release/$channel/source-commit"
echo "$channel: phone edge $host has $(basename "$build")"
