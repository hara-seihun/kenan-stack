#!/bin/bash
# Publish prepared files; keep serving during staging and frontend-only updates.
set -euo pipefail
# This file takes arguments, not stdin. Children must not consume a calling bash -s script.
exec </dev/null
source "$(dirname "$0")/detach.sh"
detach_deploy_from_app "$0" "$@"
channel=${1:?channel}; source=${2:?build directory}; target=${3:?install directory}; commit=${4:?commit}; expected_live=${5:?live commit checked by lineage.sh, or none}; mode=${6:?forward|rollback}
[[ $channel == beta || $channel == production ]] || exit 2
[[ $mode == forward || $mode == rollback ]] || { echo "deploy_usage: mode must be forward or rollback, got $mode" >&2; exit 64; }
mkdir -p "$target"
exec 9>"$target/.deploy.lock"
flock 9
live=none; [[ -s $target/source-commit ]] && live=$(<"$target/source-commit")
if [[ $live != "$expected_live" ]]; then
 # Builds stay parallel. A newer live commit is harmless if this prepared commit already includes it.
 # Read through the checkout's local shared origin too: a clone may not have fetched a concurrent deploy yet.
 checkout=$(realpath "$(dirname "$0")/..")
 git_() { GIT_OPTIONAL_LOCKS=0 git -c safe.directory='*' -C "$checkout" "$@"; }
 includes_live=false
 if [[ $mode == forward && $live =~ ^[0-9a-f]{40}$ ]] && common=$(git_ rev-parse --path-format=absolute --git-common-dir 2>/dev/null); then
  if [[ $(git -c safe.directory='*' --git-dir="$common" rev-parse --is-bare-repository) == true ]]; then origin=$common
  else origin=$(git_ remote get-url origin); fi
  if [[ $origin == /* && -d $origin ]] && GIT_ALTERNATE_OBJECT_DIRECTORIES="$origin/objects" git_ merge-base --is-ancestor "$live" "$commit"; then includes_live=true; fi
 fi
 if ! $includes_live; then
  echo "deploy_channel_moved: $channel changed from $expected_live to $live while this build ran; $mode deploy cannot replace it. Merge the live commit and deploy again, or retry an explicit rollback against the new live version" >&2
  exit 9
 fi
fi
# Runtime assets must exist before copying or touching the selected backend.
for asset in dist/server/main.js dist/server/db/schema.sql dist/web/index.html package.json package-lock.json; do
 if [[ ! -s $source/$asset ]]; then echo "deploy_runtime_asset_missing: $asset" >&2; exit 12; fi
done
# Select the prepared build's mail CLIs before publishing, including direct install-build callers.
# They are shared by both channels; a channel rollback keeps the newer compatible CLIs.
if [[ $mode == forward ]]; then
 bash "$source/deploy/install-build-deps.sh"
 sh "$source/deploy/install-mail.sh" install
 bash "$source/deploy/install-model-broker.sh"
fi
stage=$(mktemp -d "$target/.deploy-XXXXXX")
trap 'rm -rf "$stage"' EXIT
cp -a "$source/dist" "$source/package.json" "$source/package-lock.json" "$stage/"

dependencies_changed=false
# The key covers the lockfile and deploy/patches, so a dependency patch installs even when the lockfile is unchanged.
# Both trees without a key (built before keys existed) count as the same key; only a real difference reinstalls.
deps_key() { cat "$1/node_modules/.kenan-deps-key" 2>/dev/null || true; }
if [[ ! -d $target/node_modules ]] || ! cmp -s "$source/package-lock.json" "$target/package-lock.json" || [[ $(deps_key "$source") != "$(deps_key "$target")" ]]; then
 dependencies_changed=true
 mkdir "$stage/node_modules"
 cp -a "$source/node_modules/." "$stage/node_modules/"
fi
restart=$dependencies_changed
for part in server shared android; do
 if [[ -e $stage/dist/$part || -e $target/dist/$part ]]; then
  if ! diff -qr --exclude="*.test.js" --exclude="*.test.js.map" "$stage/dist/$part" "$target/dist/$part" >/dev/null 2>&1; then restart=true; fi
 fi
done
if ! cmp -s "$source/package.json" "$target/package.json"; then restart=true; fi
if ! systemctl is-active --quiet "kenan@$channel.service"; then restart=true; fi

# A failed upgrade may have selected files without loading them. Use the running process's selected code.
if ! python3 - "$target" "$channel" <<'PYLIVE'
import json, os, pathlib, sys
try:
 state=json.loads(pathlib.Path('/run/kenan/'+sys.argv[2]+'-live-release.json').read_text())
 os.kill(state['pid'],0)
 assert os.path.realpath(sys.argv[1]+'/current') == state['root']
except (OSError,ValueError,KeyError,AssertionError): sys.exit(1)
PYLIVE
then restart=true; fi

# The channel socket (deploy/kenan@.socket) is held by systemd, so a restart only queues requests. It is in use when
# the only listener on its path is systemd's; otherwise (first switch to it, or a build that bound the path itself after
# a rollback) the socket is re-established while the service is down, which refuses requests for that moment once.
socket=/run/kenan/$channel.sock
socket_held() {
 local listeners; listeners=$(ss -xlpH src "$socket" 2>/dev/null)
 [[ $(grep -c . <<<"$listeners") == 1 ]] && grep -q 'pid=1,' <<<"$listeners"
}
held=false
if systemctl cat "kenan@$channel.socket" >/dev/null 2>&1 && socket_held; then held=true; fi

# Backend modules and dependencies remain at immutable paths for turns using an earlier generation.
# The selected public tree changes before the live reload; no process or model connection is stopped.
if $restart; then
 mkdir -p "$target/releases" "$target/dependencies" "$target/dist" "$stage/old"
 key=$(deps_key "$source")
 # Prepared builds always have a key. Direct installers without one use the package-lock cache identity.
 if [[ -z $key ]]; then key=$(sha256sum "$source/package-lock.json" | cut -d' ' -f1); fi
 depdir="$target/dependencies/$key"
 if [[ ! -d $depdir ]]; then
  if [[ -d $stage/node_modules ]]; then mv "$stage/node_modules" "$depdir"
  elif [[ -d $target/node_modules && ! -L $target/node_modules ]]; then mv "$target/node_modules" "$depdir"
  else
   mkdir "$stage/dependencies"
   cp -a "$source/node_modules/." "$stage/dependencies/"
   mv "$stage/dependencies" "$depdir"
  fi
 fi
 release="$target/releases/$commit"
 if [[ ! -d $release ]]; then
  mkdir -p "$stage/release/dist"
  for part in "$stage/dist/"*; do
   [[ $(basename "$part") == web ]] || mv "$part" "$stage/release/dist/"
  done
  cp "$stage/package.json" "$stage/package-lock.json" "$stage/release/"
  [[ ! -f $stage/dist/commits.log ]] || cp "$stage/dist/commits.log" "$stage/release/dist/"
  ln -s "$depdir" "$stage/release/node_modules"
  mv "$stage/release" "$release"
 fi
 ln -s "$release" "$stage/current"
 mv -fT "$stage/current" "$target/current"
 for part in server shared android; do
  [[ ! -e $target/dist/$part && ! -L $target/dist/$part ]] || mv "$target/dist/$part" "$stage/old/$part"
  ln -s "$release/dist/$part" "$target/dist/$part"
 done
 [[ ! -e $target/node_modules && ! -L $target/node_modules ]] || mv "$target/node_modules" "$stage/old/node_modules"
 ln -s "$depdir" "$target/node_modules"
 mv "$stage/package.json" "$target/package.json"
 mv "$stage/package-lock.json" "$target/package-lock.json"
fi

# Keep old hashed assets for open tabs; publish the new index only after its assets.
mkdir -p "$target/dist/web"
mv "$stage/dist/web/index.html" "$stage/index.html"
# The emoji directory is wholly generated from web/public: clear it first so a removed file stops being served.
rm -rf "$target/dist/web/emoji"
cp -a "$stage/dist/web/." "$target/dist/web/"
mv "$stage/index.html" "$target/dist/web/.index-next"
mv -f "$target/dist/web/.index-next" "$target/dist/web/index.html"
# 📰 What's new: this commit's history, read by the running server whenever it changes, so no restart is needed for it.
if [[ -f $stage/dist/commits.log ]]; then mv -f "$stage/dist/commits.log" "$target/dist/commits.log"; else rm -f "$target/dist/commits.log"; fi
printf '%s\n' "$commit" > "$stage/source-commit"
mv "$stage/source-commit" "$target/source-commit"
if $restart; then
 # The helper uses live reload for both channels. A pre-upgrade installation replaces its process just once.
 if ! $held && ! systemctl is-active --quiet "kenan@$channel.service" && systemctl cat "kenan@$channel.socket" >/dev/null 2>&1; then systemctl restart "kenan@$channel.socket"; fi
 sudo -n /usr/local/sbin/kenan-runtime-restart "$channel"
fi
printf '%s published; backend updated: %s\n' "$channel" "$restart"
