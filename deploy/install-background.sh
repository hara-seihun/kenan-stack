#!/bin/bash
# A CLI-only deployment; no application build, restart or channel mutation.
set -euo pipefail
cd "$(dirname "$(realpath "$0")")/.."
if (( EUID != 0 )); then exec sudo -n /bin/bash "$PWD/deploy/install-background.sh" "$@"; fi
bash deploy/install-build-deps.sh
source deploy/place.sh
# These carry lifetime metadata, never identity or authorization. sudo must not hide an
# enclosing shell deadline or make a tracked service look like an unbounded foreground call.
policy=$(mktemp)
trap 'rm -f "$policy"' EXIT
printf '%s\n' 'Defaults env_keep += "KENAN_BASH_DEADLINE_UNIX_MS KENAN_TRACKED_BACKGROUND"' > "$policy"
visudo -cf "$policy" >/dev/null
place 0440 "$policy" /etc/sudoers.d/kenan-shell-deadline
rm -f "$policy"
trap - EXIT
python3 deploy/kenan-bg-native/migrate-state.py begin
# Compile only when the credential reader changes; its stable N-API ABI needs no
# per-Node-version rebuild. Launch and status keep their existing shared code.
native_dir=/usr/local/lib/kenan/kenan-bg-native
install -d -m 0755 "$native_dir"
launcher_changed=0
if [[ ! -f $native_dir/peer-credentials.node ]] || ! cmp -s deploy/kenan-bg-native/peer-credentials.c "$native_dir/peer-credentials.c"; then
  launcher_changed=1
  compiled=$(mktemp)
  trap 'rm -f "$compiled"' EXIT
  cc -O2 -shared -fPIC -I/usr/include/node -DNODE_GYP_MODULE_NAME=peer_credentials deploy/kenan-bg-native/peer-credentials.c -o "$compiled"
  place 0644 "$compiled" "$native_dir/peer-credentials.node"
  place 0644 deploy/kenan-bg-native/peer-credentials.c "$native_dir/peer-credentials.c"
  rm -f "$compiled"
  trap - EXIT
fi
for file in deploy/kenan-bg-native/*.mjs; do
  [[ $file == *.test.mjs ]] && continue
  target=$native_dir/$(basename "$file")
  if ! cmp -s "$file" "$target"; then launcher_changed=1; place 0644 "$file" "$target"; fi
done
place 0644 deploy/kenan-bg-native/reap.py "$native_dir/reap.py"
python3 deploy/kenan-bg-native/migrate-state.py finish
rendered_unit=$(mktemp)
trap 'rm -f "$rendered_unit"' EXIT
sed "s|@NATIVE_SERVER@|$native_dir/launch-server.mjs|g" deploy/kenan-bg-launch.service > "$rendered_unit"
place 0755 deploy/kenan-bg /usr/local/bin/kenan-bg
units_changed=0
place_unit 0644 deploy/kenan-bg-launch.socket /etc/systemd/system/kenan-bg-launch.socket
socket_changed=$units_changed
place_unit 0644 deploy/kenan-bg-reap.service /etc/systemd/system/kenan-bg-reap.service
place_unit 0644 deploy/kenan-bg-reap.timer /etc/systemd/system/kenan-bg-reap.timer
place_unit 0644 deploy/kenan-bg-recover.service /etc/systemd/system/kenan-bg-recover.service
place_unit 0644 "$rendered_unit" /etc/systemd/system/kenan-bg-launch.service
if [[ -f /etc/systemd/system/kenan-bg-launch@.service ]]; then
  rm /etc/systemd/system/kenan-bg-launch@.service
  units_changed=1
fi
if (( units_changed )); then systemctl daemon-reload; fi
# Socket-mode changes need both listeners closed. Existing jobs are separate
# services; a launcher restart only drains its own in-flight requests.
if (( socket_changed )); then
  systemctl stop kenan-bg-launch.service
  systemctl restart kenan-bg-launch.socket
elif (( launcher_changed || units_changed )); then
  systemctl try-restart kenan-bg-launch.service
fi
enable_units --now kenan-bg-launch.socket
systemctl start kenan-bg-launch.service

enable_units --now kenan-bg-reap.timer
# Enabled only: it runs at boot, never while jobs are running.
enable_units kenan-bg-recover.service
