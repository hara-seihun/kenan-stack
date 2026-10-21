#!/bin/bash
# Prepare the build of one commit in a tree no other deploy writes, and print its path.
# Usage: deploy/prepare-build.sh CHECKOUT COMMIT   (run as the checkout's owner)
#
# Beta and production often deploy the same checkout at once. Each build is keyed by its commit and each dependency
# tree by its lockfile's hash, assembled in a private temporary directory and published with one rename, so parallel
# deploys never share a mutable tree and never wait on each other: a finished key is reused, a race to publish the
# same key keeps whichever rename lands first. The checkout's own node_modules and dist are never touched.
set -euo pipefail
checkout=${1:?checkout}; commit=${2:?commit}
[[ $commit =~ ^[0-9a-f]{40}$ ]] || { echo "prepare_build_usage: commit must be a full id, got $commit" >&2; exit 64; }
git_() { GIT_OPTIONAL_LOCKS=0 git -c safe.directory='*' -C "$checkout" "$@"; }
cache=${KENAN_BUILD_CACHE:-$(git_ rev-parse --absolute-git-dir)/kenan-deploy}
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

build=$cache/builds/$commit
if [[ ! -f $build/.complete ]]; then
 lock_hash=$(git_ show "$commit:package-lock.json" | sha256sum | cut -c1-64)
 deps=$cache/deps/$lock_hash
 if [[ ! -f $deps/.complete ]]; then
  tmp=$(mktemp -d "$cache/deps/.tmp-XXXXXX")
  trap 'rm -rf "$tmp"' EXIT
  git_ archive "$commit" package.json package-lock.json | tar -x -C "$tmp"
  (cd "$tmp" && npm ci --no-audit --no-fund >&2)
  publish "$tmp" "$deps"
  trap - EXIT
 fi
 tmp=$(mktemp -d "$cache/builds/.tmp-XXXXXX")
 trap 'rm -rf "$tmp"' EXIT
 git_ archive "$commit" | tar -x -C "$tmp"
 ln -s "../../deps/$lock_hash/node_modules" "$tmp/node_modules"
 (cd "$tmp" && npm run build >&2 && install -d dist/server/db && cp server/db/schema.sql dist/server/db/schema.sql)
 publish "$tmp" "$build"
 trap - EXIT
fi

# Mark this build and its dependencies used, then drop keys unused for three days and temporaries of crashed runs.
touch "$build" "$(dirname "$(readlink -f "$build/node_modules")")"
find "$cache/builds" "$cache/deps" -mindepth 1 -maxdepth 1 \( -name '.tmp-*' -mmin +360 -o ! -name '.tmp-*' -mtime +2 \) -exec rm -rf {} + 2>/dev/null || true
echo "$build"
