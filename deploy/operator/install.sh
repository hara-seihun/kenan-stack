#!/bin/bash
# Installs the household operator grant: deploy/operator/install.sh (as an administrator, from a checkout).
# kenan-operator -> /usr/local/sbin, its sudoers rule, and the operator database views on both channels.
set -euo pipefail
cd "$(dirname "$0")"
sudo visudo -cqf kenan-operator.sudoers
sudo install -m 0755 -o root -g root kenan-operator /usr/local/sbin/kenan-operator
sudo install -m 0440 -o root -g root kenan-operator.sudoers /etc/sudoers.d/kenan-operator
for channel in beta production; do sudo bash apply-db.sh "$channel"; done
