#!/bin/bash
# Installs an event relay for the calling user (who must linger): user unit kenan-event-relay@NAME, config in
# ~/.config/kenan-event-relay/NAME.json.   usage: deploy/event-relay/install.sh NAME CONFIG.json
set -euo pipefail
usage='usage: deploy/event-relay/install.sh NAME CONFIG.json'
name=${1:?$usage}; config=$(realpath "${2:?$usage}")
cd "$(dirname "$0")"
node event-relay.mjs --check "$config"
sudo install -D -m 0755 event-relay.mjs /usr/local/lib/kenan/event-relay/event-relay.mjs
dest=$HOME/.config/kenan-event-relay/$name.json
# install unlinks its destination first, so reinstalling the installed config in place would delete it.
[[ $config -ef $dest ]] || install -D -m 0600 "$config" "$dest"
install -D -m 0644 kenan-event-relay@.service "$HOME/.config/systemd/user/kenan-event-relay@.service"
systemctl --user daemon-reload
systemctl --user enable "kenan-event-relay@$name.service"
systemctl --user restart "kenan-event-relay@$name.service"
