#!/bin/bash
# Reproduces Acme's automatic bundle consumer from committed source; no source/deployment effects on installation.
set -euo pipefail
cd "$(dirname "$(realpath "$0")")/.."
[[ -d /home/kenan/work/repos/kenan.git && -f /etc/kenan/acme-meeting-beta.json ]] || exit 0
worker=/home/kenan/.local/lib/kenan-stack-intake
sudo -n install -d -o kenan -g kenan "$worker" /home/kenan/data/kenan-stack-intake
for file in stack-bundle-intake.py stack-bundle-meetings.mjs; do
 sudo -n install -m 0755 -o kenan -g kenan "deploy/$file" "$worker/$file"
done
# Every deploy of each channel runs this. A daemon-reload (and enable or disable, which reload too) blocks the whole system
# manager for 2-4 s here; on 2026-11-06 these unconditional calls made 14 reloads per intake deployment, and the stall kept
# the job census's systemctl list-units past its 10 s bound. So each step runs only when it changes something.
changed=0
for unit in kenan-stack-intake.service kenan-stack-intake.timer; do
 if ! cmp -s "deploy/$unit" "/etc/systemd/system/$unit"; then sudo -n install -m 0644 "deploy/$unit" /etc/systemd/system/; changed=1; fi
done
# Replace the older push-marker consumer, rather than create another integration writer.
if [[ $(systemctl is-enabled acme-incoming.path 2>/dev/null) == enabled ]] || systemctl is-active --quiet acme-incoming.path; then
 sudo -n systemctl disable --now acme-incoming.path
fi
if (( changed )); then sudo -n systemctl daemon-reload; fi
systemctl is-enabled --quiet kenan-stack-intake.timer || sudo -n systemctl enable kenan-stack-intake.timer
systemctl is-active --quiet kenan-stack-intake.timer || sudo -n systemctl start kenan-stack-intake.timer
