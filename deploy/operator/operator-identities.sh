#!/bin/bash
# Pairs each operator's Unix user with the person in a channel config whose unixUser it is, for operator-db.sql:
# operator-identities.sh MEMBERS CONFIG prints `unixuser=person,...` (MEMBERS comma-separated, as getent prints them).
# A member who is no person, or more than one, fails with operator_person_missing / operator_person_ambiguous.
set -euo pipefail
(( $# == 2 )) || { echo "usage: operator-identities.sh MEMBERS CONFIG" >&2; exit 64; }
jq -r --arg members "$1" '
  [($members | split(",") | map(select(. != "")))[] as $user
   | [.people[] | select(.unixUser == $user)] as $matches
   | [$matches[] | select(.manager != null and (.manager | has("elsewhere") | not))] as $local
   | (if ($local | length) == 1 then $local else $matches end | map(.id)) as $ids
   | if ($ids | length) == 1 then "\($user)=\($ids[0])"
     elif ($ids | length) == 0 then error("operator_person_missing: \($user) is in kenan-operators but no person in the config has unixUser \($user)")
     else error("operator_person_ambiguous: unixUser \($user) belongs to persons \($ids | join(", "))") end]
  | join(",")' "$2"
