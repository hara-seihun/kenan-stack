#!/bin/bash
# Publish prepared files; keep serving during staging and frontend-only updates.
set -euo pipefail
source "$(dirname "$0")/detach.sh"
detach_deploy_from_app "$0" "$@"
channel=${1:?channel}; source=${2:?build directory}; target=${3:?install directory}; commit=${4:?commit}; expected_live=${5:?live commit checked by lineage.sh, or none}
[[ $channel == beta || $channel == production ]] || exit 2
mkdir -p "$target"
exec 9>"$target/.deploy.lock"
flock 9
live=none; [[ -s $target/source-commit ]] && live=$(<"$target/source-commit")
if [[ $live != "$expected_live" ]]; then
 echo "deploy_channel_moved: $channel changed from $expected_live to $live while this build ran; deploy again so the check covers $live" >&2
 exit 9
fi
stage=$(mktemp -d "$target/.deploy-XXXXXX")
trap 'rm -rf "$stage"' EXIT
cp -a "$source/dist" "$source/package.json" "$source/package-lock.json" "$stage/"

dependencies_changed=false
if [[ ! -d $target/node_modules ]] || ! cmp -s "$source/package-lock.json" "$target/package-lock.json"; then
 dependencies_changed=true
 mkdir "$stage/node_modules"
 cp -a "$source/node_modules/." "$stage/node_modules/"
fi
restart=$dependencies_changed
for part in server shared; do
 if [[ -e $stage/dist/$part || -e $target/dist/$part ]]; then
  if ! diff -qr --exclude="*.test.js" --exclude="*.test.js.map" "$stage/dist/$part" "$target/dist/$part" >/dev/null 2>&1; then restart=true; fi
 fi
done
if ! cmp -s "$source/package.json" "$target/package.json"; then restart=true; fi
if ! systemctl is-active --quiet "kenan@$channel.service"; then restart=true; fi

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

# All expensive copying has finished before taking the server down. With a held socket the running process keeps its
# loaded code while the files change under it, and requests wait in the socket during the restart.
if $restart; then
 if ! $held; then systemctl stop "kenan@$channel.service"; fi
 mkdir -p "$target/dist" "$stage/old"
 for part in server shared; do
  if [[ -e $target/dist/$part ]]; then mv "$target/dist/$part" "$stage/old/$part"; fi
  if [[ -e $stage/dist/$part ]]; then mv "$stage/dist/$part" "$target/dist/$part"; fi
 done
 if $dependencies_changed; then
  if [[ -e $target/node_modules || -L $target/node_modules ]]; then mv "$target/node_modules" "$stage/old/node_modules"; fi
  mv "$stage/node_modules" "$target/node_modules"
 fi
 mv "$stage/package.json" "$target/package.json"
 mv "$stage/package-lock.json" "$target/package-lock.json"
fi

# Keep old hashed assets for open tabs; publish the new index only after its assets.
mkdir -p "$target/dist/web"
mv "$stage/dist/web/index.html" "$stage/index.html"
cp -a "$stage/dist/web/." "$target/dist/web/"
mv "$stage/index.html" "$target/dist/web/.index-next"
mv -f "$target/dist/web/.index-next" "$target/dist/web/index.html"
printf '%s\n' "$commit" > "$stage/source-commit"
mv "$stage/source-commit" "$target/source-commit"
if $restart; then
 if $held; then systemctl restart "kenan@$channel.service"
 elif systemctl cat "kenan@$channel.socket" >/dev/null 2>&1; then systemctl restart "kenan@$channel.socket"; systemctl start "kenan@$channel.service"
 else systemctl start "kenan@$channel.service"; fi
fi
printf '%s published; backend restarted: %s\n' "$channel" "$restart"
