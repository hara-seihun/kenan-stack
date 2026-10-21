#!/bin/bash
# Applies operator-db.sql to CHANNEL's database for the current members of the host group kenan-operators.
# Run as root (deploy/deploy.sh, deploy/operator/install.sh). Usage: deploy/operator/apply-db.sh beta|production
set -euo pipefail
channel=${1:?usage: deploy/operator/apply-db.sh beta|production}
members=$(getent group kenan-operators | cut -d: -f4) || { echo "apply-db: host group kenan-operators is missing (kenan-user-grants creates it)" >&2; exit 1; }
# Both channels' databases share the cluster's roles. A deploy of the other channel changing the same role at the same
# moment fails one transaction (tuple concurrently updated, or a role it just created); the retry sees it committed.
for attempt in 1 2 3; do
 if output=$(psql "$(jq -r .databaseUrl "/etc/kenan/$channel.json")" -q -v operators="$members" -f "$(dirname "$0")/operator-db.sql" 2>&1); then
  [[ -z $output ]] || printf '%s\n' "$output" >&2
  exit 0
 fi
 printf '%s\n' "$output" >&2
 grep -Eq 'tuple concurrently updated|already exists' <<<"$output" && (( attempt < 3 )) || exit 1
 sleep 0.$RANDOM
done
