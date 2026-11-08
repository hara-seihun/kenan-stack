#!/bin/bash
# Applies operator-db.sql to CHANNEL's database for the current members of the host group kenan-operators, each paired
# with the person whose unixUser they are in /etc/kenan/CHANNEL.json (Alice's account kenan is person alice).
# Run as root (deploy/deploy.sh, deploy/operator/install.sh). Usage: deploy/operator/apply-db.sh beta|production
set -euo pipefail
channel=${1:?usage: deploy/operator/apply-db.sh beta|production}
config=/etc/kenan/$channel.json
members=$(getent group kenan-operators | cut -d: -f4) || { echo "apply-db: host group kenan-operators is missing (kenan-user-grants creates it)" >&2; exit 1; }
operators=$(bash "$(dirname "$0")/operator-identities.sh" "$members" "$config")
# Both channels' databases share the cluster's roles. A deploy of the other channel changing the same role at the same
# moment fails one transaction (tuple concurrently updated, or a role it just created); the retry sees it committed.
url=$(jq -r .databaseUrl "$config")
# Each operator logs in as its own Unix user (peer auth), so check what a real login sees: plain names reach the
# operator views, and an operator that is also a service identity (kenan runs the calendar link and
# contention-watch) reaches every public table it holds privileges on through its own schema: the 2026-10-22 search
# path put kenan_calendar on the filtered operator view and stopped the calendar link.
check_sessions() {
 local database user wrong
 database=$(psql "$url" -Atc 'SELECT current_database()')
 for user in $(psql "$url" -Atc 'SELECT role_name FROM operator.identity'); do
  wrong=$(runuser -u "$user" -- psql "host=/run/kenan/pg dbname=$database" -X -Atc "SELECT string_agg(relname, ', ') FROM pg_class
     WHERE relnamespace = 'public'::regnamespace AND relkind IN ('r', 'p', 'v') AND has_table_privilege(oid, 'SELECT,INSERT,UPDATE,DELETE')
     AND to_regclass(quote_ident(relname)) IS DISTINCT FROM to_regclass(quote_ident(current_user) || '.' || quote_ident(relname))
") || return 1
  [[ -z $wrong ]] || { echo "apply-db: operator_session_path_wrong: $user in $database reaches $wrong through the wrong schema" >&2; return 1; }
 done
}
# Plain `psql` as an operator connects to kenan-postgres and the database of the channel hosting their manager. Both
# channels' deploys write the same bytes, by rename, and only on change.
install_default_clusters() {
 local version targets=() other file=/etc/postgresql-common/user_clusters staged
 version=$(( $(psql "$url" -Atc 'SHOW server_version_num') / 10000 ))
 for other in beta production; do
  [[ -f /etc/kenan/$other.json ]] || continue
  targets+=("/etc/kenan/$other.json=$(psql "$(jq -r .databaseUrl "/etc/kenan/$other.json")" -X -At -c '\echo :HOST::PORT/:DBNAME')")
 done
 staged=$(mktemp "$file.XXXXXX")
 bash "$(dirname "$0")/operator-clusters.sh" "$members" "$version" "${targets[@]}" >"$staged" || { rm -f "$staged"; return 1; }
 if cmp -s "$staged" "$file"; then rm -f "$staged"; else chmod 0644 "$staged" && mv -f "$staged" "$file"; fi
}
for attempt in 1 2 3; do
 if output=$(psql "$url" -X -q -v operators="$operators" -v operator_role=kenan_operator -f "$(dirname "$0")/operator-db.sql" 2>&1); then
  [[ -z $output ]] || printf '%s\n' "$output" >&2
  check_sessions
  install_default_clusters
  exit 0
 fi
 printf '%s\n' "$output" >&2
 grep -Eq 'tuple concurrently updated|already exists' <<<"$output" && (( attempt < 3 )) || exit 1
 sleep 0.$RANDOM
done
