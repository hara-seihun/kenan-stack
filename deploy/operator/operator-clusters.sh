#!/bin/bash
# Prints /etc/postgresql-common/user_clusters for the household operators, so a plain `psql` (or pg_dump, pg_isready)
# as one of them reaches kenan-postgres and their own channel's database instead of the Ubuntu cluster on the default
# socket. Their own channel is the one whose config hosts their manager (Alice's account kenan: Beta).
# operator-clusters.sh MEMBERS VERSION CONFIG=HOST:PORT/DATABASE... (MEMBERS comma-separated, as getent prints them).
# A member whose manager no channel hosts gets no line; one hosted by two fails with operator_channel_ambiguous.
set -euo pipefail
(( $# >= 3 )) || { echo "usage: operator-clusters.sh MEMBERS VERSION CONFIG=HOST:PORT/DATABASE..." >&2; exit 64; }
members=$1 version=$2
shift 2
echo "# Written by Kenan Stack's deploy/operator/apply-db.sh on every deploy; edits are overwritten. See user_clusters(5)."
echo "# USER GROUP VERSION CLUSTER DATABASE"
for user in ${members//,/ }; do
 found=()
 for channel in "$@"; do
  config=${channel%%=*} target=${channel#*=}
  hosted=$(jq -r --arg user "$user" '[.people[] | select(.unixUser == $user and .manager != null and (.manager | has("elsewhere") | not))] | length' "$config")
  (( hosted == 0 )) || found+=("$target")
 done
 (( ${#found[@]} <= 1 )) || { echo "operator_channel_ambiguous: $user's manager is hosted by ${found[*]}" >&2; exit 1; }
 (( ${#found[@]} == 0 )) || echo "$user * $version ${found[0]%/*} ${found[0]##*/}"
done
