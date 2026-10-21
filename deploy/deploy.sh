#!/bin/bash
set -euo pipefail
usage='Usage: deploy/deploy.sh beta|production [--rollback]'
channel=${1:?$usage}
[[ $channel == beta || $channel == production ]] || { echo "$usage" >&2; exit 2; }
case ${2-} in
 '') mode=forward;;
 --rollback) mode=rollback;;
 *) echo "$usage" >&2; exit 2;;
esac
(( $# <= 2 )) || { echo "$usage" >&2; exit 2; }
script=$(realpath "$0")
# Deployment installs units and release trees as root; agents invoke it as themselves. Administrators re-run this
# script as root; household operators (machine/user-access.md) hand the checked, pushed commit to kenan-operator,
# which deploys it from its own checkout.
cd "$(dirname "$script")/.."
bash deploy/host-requirements.sh
if (( EUID != 0 )); then
 if sudo -n -l /bin/bash >/dev/null 2>&1; then exec sudo -n --preserve-env=PATH /bin/bash "$script" "$@"; fi
 bash deploy/lineage.sh "/srv/kenan/$channel" "$PWD" "$mode" >/dev/null
 exec sudo -n /usr/local/sbin/kenan-operator deploy "$channel" "$mode" "$(git rev-parse HEAD)"
fi
# Checked before detaching so a refusal reaches the caller instead of a transient unit's journal.
bash deploy/lineage.sh "/srv/kenan/$channel" "$PWD" "$mode" >/dev/null
source deploy/place.sh
place 0755 deploy/kenan-runtime-restart /usr/local/sbin/kenan-runtime-restart
place 0755 deploy/kenan-runtime-recover /usr/local/sbin/kenan-runtime-recover
for unit in kenan-runtime-recovery.{service,timer}; do place 0644 "deploy/$unit" "/etc/systemd/system/$unit"; done
systemctl daemon-reload
systemctl enable --now kenan-runtime-recovery.timer
source deploy/detach.sh
detach_deploy_from_app "$script" "$@"
KENAN_DEPLOY_DESCRIPTION="deploy/deploy.sh $* at $(git -c safe.directory="$PWD" rev-parse --short HEAD)"
trap 'report_detached_failure $? "$channel"' EXIT
[[ -f /etc/kenan/$channel.json ]] || { echo 'Run deploy/prepare.sh and write the channel config first' >&2; exit 1; }
source_commit=$(git -c safe.directory="$PWD" rev-parse HEAD)
live_commit=$(bash deploy/lineage.sh "/srv/kenan/$channel" "$PWD" "$mode")
# Build as the checkout's owner into a tree keyed by the commit (deploy/prepare-build.sh), so Beta and production can
# deploy the same checkout at once without sharing node_modules or dist, and the second channel reuses the first's build.
owner=$(stat -c %U .)
build=$(sudo -u "$owner" -H bash deploy/prepare-build.sh "$PWD" "$source_commit")
# Refuse a config the new build would reject before anything restarts.
node -e 'import(process.argv[1]).then(m => m.loadConfig(process.argv[2]))' "$build/dist/server/config.js" "/etc/kenan/$channel.json"
# The mail tool calls the host mail CLIs, so a forward deploy selects the CLIs from the same commit (content-addressed,
# shared by both channels; a channel rollback keeps the newer CLIs, which stay compatible with older tools).
if [[ $mode == forward ]]; then sh deploy/install-mail.sh install; place 0755 deploy/kenan-notify /usr/local/bin/kenan-notify; place 0755 deploy/kenan-event /usr/local/bin/kenan-event; place 0755 deploy/add-person.py /usr/local/sbin/kenan-add-person; fi
# The units come from this commit too, so hosts never keep a stale copy (acme-host's lacked self-recovery).
if [[ $mode == forward ]]; then for unit in kenan-postgres.service kenan@.service kenan@.socket; do place 0644 "deploy/$unit" "/etc/systemd/system/$unit"; done; systemctl daemon-reload; fi
systemctl enable "kenan@$channel.service"
if [[ -f /etc/systemd/system/kenan@.socket ]]; then systemctl enable "kenan@$channel.socket"; fi
bash deploy/install-build.sh "$channel" "$build" "/srv/kenan/$channel" "$source_commit" "$live_commit"
# Startup can include a one-time schema backfill (conversation_file took 30-45 s on 1.3M messages), so wait while the
# service is still starting, up to 5 minutes, and stop waiting at once if it failed.
for attempt in {1..300}; do
 if curl --fail --silent --max-time 5 --unix-socket "/run/kenan/$channel.sock" http://localhost/api/accounts >/dev/null; then break; fi
 if systemctl is-failed --quiet "kenan@$channel.service"; then break; fi
 sleep 1
done
curl --fail --silent --max-time 5 --unix-socket "/run/kenan/$channel.sock" http://localhost/api/accounts
# Hosts with household operators (deploy/operator/README.md) refresh their database views for the new schema.
if [[ -x /usr/local/sbin/kenan-operator ]]; then bash deploy/operator/apply-db.sh "$channel"; fi
# Hosts that build the native app keep its signed channel builds in /var/lib/kenan/android/CHANNEL; Acme has none.
if [[ -d /var/lib/kenan/android/$channel ]]; then node deploy/publish-android.mjs "$channel"; else echo "$channel: no native build on this host"; fi
echo "$channel launched"
