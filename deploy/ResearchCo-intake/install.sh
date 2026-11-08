#!/bin/bash
# Explicit opt-in on ResearchCo only. Normal deployments do not install or enable this service.
set -euo pipefail
[[ ${1-} == --enable && $# == 1 ]] || { echo 'Usage: deploy/ResearchCo-intake/install.sh --enable' >&2; exit 64; }
[[ $(hostname -s) == ResearchCo ]] || { echo 'This intake service belongs on ResearchCo only.' >&2; exit 1; }
cd "$(dirname "$(realpath "$0")")"
sudo -n install -d -o kenan -g kenan /home/kenan/.local/lib/kenan-ResearchCo-intake /home/kenan/.local/state/kenan-ResearchCo-intake
sudo -n install -m 0755 intake.py /home/kenan/.local/lib/kenan-ResearchCo-intake/intake.py
sudo -n install-units kenan-ResearchCo-intake.service kenan-ResearchCo-intake.timer \
  --enable-now kenan-ResearchCo-intake.timer
