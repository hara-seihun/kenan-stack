#!/bin/bash
# Prepare the build of one commit in a tree no other deploy writes, and print its path.
# Usage: deploy/prepare-build.sh CHECKOUT COMMIT   (run as the checkout's owner)
#
# Beta and production often deploy the same checkout at once. Each build is keyed by its commit and each dependency
# tree by its lockfile's hash, assembled in a private temporary directory and published with one rename, so parallel
# deploys never share a mutable tree and never wait on each other: a finished key is reused, a race to publish the
# same key keeps whichever rename lands first. The checkout's own node_modules and dist are never touched.
set -euo pipefail
bash "$(dirname "$0")/install-build-deps.sh"
checkout=${1:?checkout}; commit=${2:?commit}
[[ $commit =~ ^[0-9a-f]{40}$ ]] || { echo "prepare_build_usage: commit must be a full id, got $commit" >&2; exit 64; }
git_() { GIT_OPTIONAL_LOCKS=0 git -c safe.directory='*' -C "$checkout" "$@"; }
# Worktrees have different git dirs, and promotion uses a clone. Keep immutable keys in the build owner's
# account cache instead: all of their checkouts reuse them, never another owner's cache or a serving tree.
# Resolve the account home rather than inherited HOME (root and detached deploys may keep a different one).
if [[ -v KENAN_BUILD_CACHE ]]; then
 [[ $KENAN_BUILD_CACHE == /* ]] || { echo "build_cache_not_absolute: KENAN_BUILD_CACHE=$KENAN_BUILD_CACHE" >&2; exit 64; }
 cache=$KENAN_BUILD_CACHE
else
 owner_home=$(getent passwd "$(id -u)" | cut -d: -f6) || owner_home=
 [[ $owner_home == /* ]] || { echo 'build_cache_owner_home_missing: build owner has no absolute home' >&2; exit 64; }
 cache=$owner_home/.cache/kenan-deploy
fi
mkdir -p "$cache/builds" "$cache/deps"

# Publishes a finished temporary tree under its key; a key already published by a concurrent deploy wins.
publish() {
 local tmp=$1 key=$2
 touch "$tmp/.complete"
 if ! mv -T "$tmp" "$key" 2>/dev/null; then
  [[ -f $key/.complete ]] || { echo "prepare_build_publish_failed: $key exists but is incomplete" >&2; rm -rf "$tmp"; exit 1; }
  rm -rf "$tmp"
 fi
}

# Optional feature modules (modules/NAME, see server/modules.ts): a host that lists the ones it serves in /etc/kenan/modules
# (one name per line, # for comments) builds only those, and the build is keyed by that list as well as the commit; a host
# without the file builds every module the source holds.
modules_file=${KENAN_MODULES_FILE:-/etc/kenan/modules}
suffix=; wanted=
if [[ -f $modules_file ]]; then
 wanted=$(grep -v '^[[:space:]]*#' "$modules_file" | grep -v '^[[:space:]]*$' | sort -u | tr '\n' ' ' || true)
 suffix=-m$(printf '%s' "$wanted" | sha256sum | cut -c1-12)
fi
build=$cache/builds/$commit$suffix
if [[ ! -f $build/.complete ]]; then
 # Dependencies are keyed on the lockfile and the patches postinstall applies to them (deploy/patches).
 lock_hash=$({ git_ show "$commit:package-lock.json"; git_ ls-tree -r "$commit" -- deploy/patches deploy/install-build-deps.sh; } | sha256sum | cut -c1-64)
 deps=$cache/deps/$lock_hash
 # A dependency key must own a real node_modules. One linked elsewhere (e.g. hand-seeded to a serving tree) is
 # shared mutable state the deploy may not write, so it is dropped (the link only, never its target) and rebuilt.
 if [[ -L $deps/node_modules || -L $deps ]]; then rm -rf "$deps"; fi
 if [[ ! -f $deps/.complete ]]; then
  tmp=$(mktemp -d "$cache/deps/.tmp-XXXXXX")
  trap 'rm -rf "$tmp"' EXIT
  # deploy/patches is optional: a commit without dependency patches archives only its manifest and lockfile.
  manifest=(package.json package-lock.json)
  [[ -z $(git_ ls-tree "$commit" -- deploy/install-build-deps.sh) ]] || manifest+=(deploy/install-build-deps.sh)
  [[ -z $(git_ ls-tree "$commit" -- deploy/patches) ]] || manifest+=(deploy/patches)
  git_ archive "$commit" "${manifest[@]}" | tar -x -C "$tmp"
  (cd "$tmp" && npm ci --no-audit --no-fund >&2)
  printf '%s\n' "$lock_hash" >"$tmp/node_modules/.kenan-deps-key"
  publish "$tmp" "$deps"
  trap - EXIT
 fi
 tmp=$(mktemp -d "$cache/builds/.tmp-XXXXXX")
 trap 'rm -rf "$tmp"' EXIT
 git_ archive "$commit" | tar -x -C "$tmp"
 if [[ -f $modules_file && -d $tmp/modules ]]; then
  for dir in "$tmp"/modules/*/; do
   name=$(basename "$dir")
   [[ " $wanted" == *" $name "* ]] || rm -rf "$dir"
  done
 fi
 ln -s "../../deps/$lock_hash/node_modules" "$tmp/node_modules"
 (cd "$tmp" && npm run build >&2 && install -d dist/server/db && cp server/db/schema.sql dist/server/db/schema.sql)
 # 📰 What's new (modules/organized) reads the deployed commit's own history.
 if [[ -d $tmp/modules/organized ]]; then
  { printf '%s\0' "$commit"; git_ log -z --no-merges --max-count=3000 --format='%H%x1f%ct%x1f%an%x1f%s%x1f%b' "$commit"; } > "$tmp/dist/commits.log"
 fi
 publish "$tmp" "$build"
 trap - EXIT
fi

# Mark this build and its dependencies used, then drop keys unused for three days and temporaries of crashed runs.
# The build's node_modules link names its key ("../../deps/KEY/node_modules"); touch that key, never what it resolves to.
deps_key=$cache/deps/$(basename "$(dirname "$(readlink "$build/node_modules")")")
touch -h "$build" "$deps_key"
find "$cache/builds" "$cache/deps" -mindepth 1 -maxdepth 1 \( -name '.tmp-*' -mmin +360 -o ! -name '.tmp-*' -mtime +2 \) -exec rm -rf {} + 2>/dev/null || true
echo "$build"
