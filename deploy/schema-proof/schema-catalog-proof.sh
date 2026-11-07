#!/bin/bash
# Kenan Stack schema upgrade proof between two commits: BASE (the build serving now) and HEAD (the build being installed).
# Each scenario runs in its own fresh PostgreSQL schema of a throwaway database and applies server/db/schema.sql exactly
# as the server does (store.migrate: the whole file as one simple-protocol query, so one implicit transaction).
#
# Usage: DB=LIBPQ_URL schema-catalog-proof.sh REPO BASE HEAD OUT_DIR
#   REPO   a git repository holding both commits; BASE and HEAD are any commit-ish
#   DB     libpq URL of a throwaway database (assistant-host: postgresql:///kenan_test?host=/run/kenan/pg&user=$USER)
#   GUARD_REMOVED=1  replace HEAD's schema_predates_baseline RAISE with NULL; the stale-database checks must then FAIL.
# The fresh BASE vs fresh HEAD catalog difference must equal an exact allowlist derived from the BASE..HEAD schema.sql
# diff (delta.py allow), so the expected list follows the commits instead of being written by hand.
# Rows from seed.sql (every baseline table) are fingerprinted on every transition: upgrade, re-apply, rollback start,
# forward start again, refused stale start.
# Exit 0 = every check passed; 1 = a check failed (named on stderr and in OUT_DIR/result.txt); 2 = usage/setup error.
# Every schema it creates is named RUNID_SCENARIO (RUNID = p<pid>_<epoch>, printed first) and dropped on exit; if any
# RUNID_ schema survives the cleanup the run exits 2 whatever the checks said.
set -uo pipefail
[[ $# == 4 ]] || { echo "usage: DB=URL $0 REPO BASE HEAD OUT_DIR" >&2; exit 2; }
repo=$1; base_ref=$2; head_ref=$3; out=$4
[[ -n ${DB:-} ]] || { echo "db_unset: set DB to the libpq URL of a throwaway database" >&2; exit 2; }
here=$(cd "$(dirname "$0")" && pwd)
base=$(git -C "$repo" rev-parse --verify "$base_ref^{commit}") || { echo "base_unknown: $base_ref" >&2; exit 2; }
head=$(git -C "$repo" rev-parse --verify "$head_ref^{commit}") || { echo "head_unknown: $head_ref" >&2; exit 2; }
mkdir -p "$out" || exit 2
git -C "$repo" show "$base:server/db/schema.sql" > "$out/schema-base-${base:0:8}.sql" || exit 2
git -C "$repo" show "$head:server/db/schema.sql" > "$out/schema-head-${head:0:8}.sql" || exit 2
git -C "$repo" diff "$base" "$head" -- server/db/schema.sql > "$out/schema-sql.diff" || exit 2
old_text=$(cat "$out/schema-base-${base:0:8}.sql") || exit 2
new_text=$(cat "$out/schema-head-${head:0:8}.sql") || exit 2
seed_text=$(cat "$here/seed.sql") || exit 2
baseline_id=$(grep -oP "NOT EXISTS \(SELECT 1 FROM schema_migration WHERE id = '\K[^']+" <<<"$new_text" | head -1)
required_ids=$(tr '\n' ' ' <<<"$new_text" | grep -oP "WHERE id IN \(\K[^)]+" | head -1 | grep -oP "'\K[^']+(?=')")
[[ -n $baseline_id && -n $required_ids ]] || { echo "guard_unparsed: HEAD schema.sql has no schema_predates_baseline guard ids" >&2; exit 2; }
if [[ ${GUARD_REMOVED:-0} == 1 ]]; then
  grep -q "RAISE EXCEPTION 'schema_predates_baseline" <<<"$new_text" || { echo "guard line not found" >&2; exit 2; }
  new_text=$(sed "s/^\( *\)RAISE EXCEPTION 'schema_predates_baseline.*$/\1NULL; -- guard removed by proof/" <<<"$new_text")
  printf '%s\n' "$new_text" > "$out/schema-head-guard-removed.sql"
fi
run_id=p$$_$(date +%s)
echo "run_id $run_id (schemas ${run_id}_*) base $base head $head" >&2
schemas=()
fail=0
note() { printf '%s\n' "$*" | tee -a "$out/result.txt"; }
check() { local name=$1; shift; if "$@"; then note "PASS $name"; else note "FAIL $name"; fail=1; fi; }
: > "$out/result.txt"
note "INFO base $base head $head"

psql_in() { local s=$1; shift; PGOPTIONS="-c search_path=$s -c client_min_messages=warning" psql "$DB" -X -q -v ON_ERROR_STOP=1 "$@"; }
# mk sets the global s; it must not run in a command substitution, or the subshell loses schemas+= and its exit.
mk() { s=${run_id}_$1; schemas+=("$s"); psql "$DB" -X -q -v ON_ERROR_STOP=1 -c "CREATE SCHEMA $s" || exit 2; }
apply() { local s=$1 which=$2 text; [[ $which == old ]] && text=$old_text || text=$new_text; psql_in "$s" -c "$text" 2>&1; }
seed() { psql_in "$1" -c "$seed_text" > "$out/seed-$1.log" 2>&1 || { note "FAIL seed_failed (seed.sql on BASE ${base:0:8}, see seed-$1.log)"; exit 1; }; }
cleanup() {
  local status=$? x left
  for x in "${schemas[@]}"; do psql "$DB" -X -q -c "SET client_min_messages=warning; DROP SCHEMA IF EXISTS $x CASCADE" >&2 || echo "cleanup: drop $x failed" >&2; done
  left=$(psql "$DB" -X -At -c "SELECT string_agg(nspname, ' ') FROM pg_namespace WHERE starts_with(nspname, '${run_id}_')") || { echo "cleanup: leftover query failed" >&2; exit 2; }
  if [[ -n $left ]]; then echo "cleanup: schemas left behind: $left" >&2; exit 2; fi
  echo "cleanup: dropped ${#schemas[@]} schemas, none left" >&2
  exit "$status"
}
trap cleanup EXIT
trap "exit 143" TERM INT HUP

# Catalog: columns (type, NOT NULL, default), constraints, indexes, triggers, functions (definition hash),
# with the per-run schema name removed so scenarios compare directly. schema_migration rows are listed separately.
catalog() {
  local s=$1
  psql_in "$s" -At -F ' | ' -c "
  SELECT 'column', c.relname, a.attname, format_type(a.atttypid, a.atttypmod), CASE WHEN a.attnotnull THEN 'not null' ELSE 'null' END, coalesce(pg_get_expr(d.adbin, d.adrelid), '')
    FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
   WHERE n.nspname = '$s' AND c.relkind IN ('r','p') AND a.attnum > 0 AND NOT a.attisdropped
  UNION ALL
  SELECT 'constraint', c.relname, k.conname, k.contype::text, pg_get_constraintdef(k.oid), ''
    FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = '$s'
  UNION ALL
  SELECT 'index', c.relname, i.relname, '', pg_get_indexdef(i.oid), ''
    FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid JOIN pg_class c ON c.oid = x.indrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = '$s'
  UNION ALL
  SELECT 'trigger', c.relname, t.tgname, '', pg_get_triggerdef(t.oid), ''
    FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = '$s' AND NOT t.tgisinternal
  UNION ALL
  SELECT 'function', p.proname, pg_get_function_identity_arguments(p.oid), '', md5(replace(pg_get_functiondef(p.oid), '$s.', '')), ''
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = '$s'
  ORDER BY 1, 2, 3" | sed "s/$s\.//g"
}
migrations() { psql_in "$1" -At -c "SELECT id FROM schema_migration ORDER BY id"; }
snap() { catalog "$1" > "$out/$2.catalog"; migrations "$1" > "$out/$2.migrations"; }
# data S NAME COLUMNS_FROM: per-table row count and md5 of every row, projected on the columns of COLUMNS_FROM.catalog.
data() { psql_in "$1" -At -F ' | ' -c "$(python3 "$here/delta.py" fingerprint "$out/$3.catalog")" > "$out/$2.data"; }
same() { diff -u "$out/$1" "$out/$2" > "$out/diff-$1-vs-$2.txt"; }

# 1. Fresh BASE vs fresh HEAD: the catalog difference is exactly what the schema.sql diff accounts for.
mk old_fresh; apply "$s" old > "$out/apply-old_fresh.log" || { note "FAIL apply base fresh"; exit 1; }; snap "$s" old_fresh
mk new_fresh; apply "$s" new > "$out/apply-new_fresh.log" || { note "FAIL apply head fresh"; exit 1; }; snap "$s" new_fresh
apply "$s" new > "$out/apply-new_fresh-2.log" || { note "FAIL head applied twice on a fresh head database"; fail=1; }; snap "$s" new_fresh_twice
check "fresh head applied twice is idempotent" same new_fresh.catalog new_fresh_twice.catalog
diff -U0 "$out/old_fresh.catalog" "$out/new_fresh.catalog" > "$out/diff-old_fresh-vs-new_fresh.catalog.txt"
python3 "$here/delta.py" allow "$out/schema-base-${base:0:8}.sql" "$out/schema-head-${head:0:8}.sql" "$out/diff-old_fresh-vs-new_fresh.catalog.txt" "$out"
allow_status=$?
note "INFO expected catalog difference, derived from the schema.sql diff ($(wc -l < "$out/expected-delta.txt") lines):"
tee -a "$out/result.txt" < "$out/expected-delta.txt"
[[ -s $out/unexplained-delta.txt ]] && { note "INFO catalog differences the schema.sql diff does not account for:"; tee -a "$out/result.txt" < "$out/unexplained-delta.txt"; }
[[ -s $out/missing-delta.txt ]] && { note "INFO objects the schema.sql diff adds that the catalog lacks:"; tee -a "$out/result.txt" < "$out/missing-delta.txt"; }
check "fresh base vs fresh head differs by exactly the allowlist derived from the schema.sql diff" test "$allow_status" == 0

# 2. BASE then HEAD (the upgrade every live database takes) equals fresh HEAD and keeps every row.
mk upgrade; apply "$s" old > "$out/apply-upgrade-1-old.log" || { note "FAIL apply base (upgrade)"; exit 1; }
seed "$s"; data "$s" seeded old_fresh
note "INFO seeded rows per table (base columns): $(awk -F' [|] ' '{printf "%s=%s ", $1, $2}' "$out/seeded.data")"
check "seed covers every base table" bash -c "! grep -q ' | 0 | ' '$out/seeded.data'"
apply "$s" new > "$out/apply-upgrade-2-new.log" || { note "FAIL upgrade apply"; fail=1; }
snap "$s" upgrade; data "$s" upgrade_base_cols old_fresh
check "base->head catalog equals fresh head" same new_fresh.catalog upgrade.catalog
check "base->head records exactly the migration ids of a fresh head" same new_fresh.migrations upgrade.migrations
check "base->head keeps every existing row (base columns)" same seeded.data upgrade_base_cols.data
data "$s" upgrade_head_cols new_fresh
apply "$s" new > "$out/apply-upgrade-3-new-again.log" || { note "FAIL second head apply"; fail=1; }
snap "$s" upgrade_idempotent; data "$s" upgrade_idempotent_head_cols new_fresh
check "head applied twice on an upgraded database is idempotent (catalog)" same upgrade.catalog upgrade_idempotent.catalog
check "head applied twice on an upgraded database is idempotent (rows)" same upgrade_head_cols.data upgrade_idempotent_head_cols.data

# 3. Rollback: the upgraded database, with values written into every column HEAD adds, starts BASE, then HEAD again.
python3 "$here/delta.py" exercise "$out/old_fresh.catalog" "$out/new_fresh.catalog" > "$out/exercise.sql" || { note "FAIL exercise_unbuildable"; exit 1; }
psql_in "$s" -c "$(cat "$out/exercise.sql")" > "$out/exercise.log" 2>&1 || { note "FAIL exercise.sql on the upgraded database"; exit 1; }
note "INFO head-only columns written before rollback: $(grep -c . "$out/exercise.sql") ($(grep -oP 'UPDATE "\K[^"]+" SET "[^"]+' "$out/exercise.sql" | tr -d '"' | sed 's/ SET /./' | tr '\n' ' '))"
data "$s" exercised_head_cols new_fresh
if apply "$s" old > "$out/apply-rollback-1-old-on-new.log"; then note "PASS base schema applies on an upgraded database (rollback starts)"; else note "FAIL base schema refused on an upgraded database"; fail=1; fi
data "$s" rollback_old_base_cols old_fresh; data "$s" rollback_old_head_cols new_fresh
check "rollback start keeps every existing row (base columns)" same seeded.data rollback_old_base_cols.data
check "rollback start keeps every value in head-only columns" same exercised_head_cols.data rollback_old_head_cols.data
apply "$s" new > "$out/apply-rollback-2-new.log" || { note "FAIL head after rollback"; fail=1; }
snap "$s" rollback_new; data "$s" rollback_new_head_cols new_fresh
check "base->head->base->head catalog equals fresh head" same new_fresh.catalog rollback_new.catalog
check "base->head->base->head keeps every row and value" same exercised_head_cols.data rollback_new_head_cols.data

# 4. Fresh HEAD then BASE then HEAD (BASE rolled back onto a database HEAD created, then forward again).
mk new_then_old; apply "$s" new > "$out/apply-new_then_old-1-new.log" || { note "FAIL apply head fresh (new_then_old)"; fail=1; }
check "base schema applies on a fresh head database (rollback starts)" eval 'apply "$s" old > "$out/apply-new_then_old-2-old.log"'
check "head applies again after base on a fresh head database" eval 'apply "$s" new > "$out/apply-new_then_old-3-new.log"'
snap "$s" new_then_old_new
check "head->base->head catalog equals fresh head" same new_fresh.catalog new_then_old_new.catalog

# 5. Red: a database short of the baseline (baseline id and one required migration id missing) is refused before any change.
for missing in $(head -1 <<<"$required_ids") $(tail -1 <<<"$required_ids"); do
  name=stale_${missing//-/_}
  mk "$name"; apply "$s" old > /dev/null || fail=1; seed "$s"
  psql_in "$s" -c "DELETE FROM schema_migration WHERE id IN ('$baseline_id', '$missing')" || exit 2
  snap "$s" "${name}_before"; data "$s" "${name}_before" old_fresh
  if apply "$s" new > "$out/apply-$name.log"; then refused=0; else refused=1; fi
  snap "$s" "${name}_after"; data "$s" "${name}_after" old_fresh
  check "stale database (no $baseline_id, missing $missing) refused with schema_predates_baseline" bash -c "[[ $refused == 1 ]] && grep -q schema_predates_baseline '$out/apply-$name.log'"
  check "stale database (missing $missing) unchanged by the refused start" bash -c "diff -q '$out/${name}_before.catalog' '$out/${name}_after.catalog' && diff -q '$out/${name}_before.migrations' '$out/${name}_after.migrations' && diff -q '$out/${name}_before.data' '$out/${name}_after.data'"
done

if [[ $fail == 0 ]]; then note "RESULT PASS"; exit 0; else note "RESULT FAIL"; exit 1; fi
