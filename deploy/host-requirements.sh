#!/bin/bash
# Refuses a host the runtime cannot run on, before anything is built or stopped.
# systemd-run ≥ 254: agent tool scopes, phone bridges and detached deploys pass --expand-environment=no so commands
# reach exec literally (${VAR} included); older systemd-run rejects the option and every owner tool fails.
set -euo pipefail
version=$(systemd-run --version | sed -n '1s/^systemd \([0-9][0-9]*\).*/\1/p')
[[ -n $version ]] || { echo "host_requirement_unknown: systemd-run --version printed no systemd version" >&2; exit 20; }
if (( version < 254 )); then
 echo "host_requirement_systemd: systemd $version is older than 254, so systemd-run rejects --expand-environment=no and every agent tool would fail. Install systemd 254 or later (Debian 12: bookworm-backports) first." >&2
 exit 21
fi
