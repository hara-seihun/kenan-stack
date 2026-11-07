#!/bin/bash
# Install the local sender watchdog, independently of the remote relay and app deployment.
set -euo pipefail
config=$(realpath "${1:?usage: install-watch.sh CONFIG.json}")
cd "$(dirname "$0")"
sudo install -D -m 0755 watch-outbox.mjs /usr/local/lib/kenan/peer-relay/watch-outbox.mjs
sudo install -D -m 0755 peer-relay.mjs /usr/local/lib/kenan/peer-relay/peer-relay.mjs
[[ $config -ef /etc/kenan/peer-watch.json ]] || sudo install -D -m 0600 "$config" /etc/kenan/peer-watch.json
sudo install -m 0644 kenan-peer-watch.service kenan-peer-watch.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now kenan-peer-watch.timer
sudo systemctl start kenan-peer-watch.service
