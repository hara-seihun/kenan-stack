#!/bin/bash
# Installs a peer relay.
#   deploy/peer/install.sh NAME CONFIG.json          for the calling user: user unit kenan-peer-relay@NAME, config in
#                                                     ~/.config/kenan-peer-relay (the user must linger), e.g. over SSH.
#   deploy/peer/install.sh --host NAME CONFIG.json   two people's Kenaznias on this host: system unit
#                                                     kenan-peer-relay-host@NAME as root, config in /etc/kenan/peer-relay.
set -euo pipefail
usage='usage: deploy/peer/install.sh [--host] NAME CONFIG.json'
host=false; if [[ ${1-} == --host ]]; then host=true; shift; fi
name=${1:?$usage}; config=${2:?$usage}
config=$(realpath "$config")
cd "$(dirname "$0")"
node peer-relay.mjs --check "$config"
sudo install -D -m 0755 peer-relay.mjs /usr/local/lib/kenan/peer-relay/peer-relay.mjs
if $host; then
 [[ $config -ef /etc/kenan/peer-relay/$name.json ]] || sudo install -D -m 0600 -o root -g root "$config" "/etc/kenan/peer-relay/$name.json"
 sudo install -m 0644 -o root -g root kenan-peer-relay-host@.service /etc/systemd/system/kenan-peer-relay-host@.service
 sudo systemctl daemon-reload
 sudo systemctl enable "kenan-peer-relay-host@$name.service"
 sudo systemctl restart "kenan-peer-relay-host@$name.service"
 exit
fi
dest=$HOME/.config/kenan-peer-relay/$name.json
# install unlinks its destination first, so reinstalling the installed config in place would delete it.
[[ $config -ef $dest ]] || install -D -m 0600 "$config" "$dest"
install -D -m 0644 kenan-peer-relay@.service "$HOME/.config/systemd/user/kenan-peer-relay@.service"
systemctl --user daemon-reload
systemctl --user enable "kenan-peer-relay@$name.service"
systemctl --user restart "kenan-peer-relay@$name.service"
