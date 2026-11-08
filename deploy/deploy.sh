#!/bin/bash
set -euo pipefail
# This file takes arguments, not stdin. Children must not consume a calling bash -s script.
exec </dev/null
# Parts of the deploy run Python as root from the checkout; bytecode written there would be root-owned and break the next
# checkout or clean (promote's clone failed this way on 2026-10-24).
export PYTHONDONTWRITEBYTECODE=1
usage='Usage: deploy/deploy.sh beta|production [--rollback] [--wait]   (forward to production only through deploy/promote.sh)'
channel=${1:?$usage}
[[ $channel == beta || $channel == production ]] || { echo "$usage" >&2; exit 2; }
mode=forward
wait_for_deploy=false
for option in "${@:2}"; do
 case $option in
  --rollback) mode=rollback;;
  --wait) wait_for_deploy=true;;
  *) echo "$usage" >&2; exit 2;;
 esac
done
# Missing channels are intentional on single-channel hosts. Refuse before sudo, lineage checks or detaching.
[[ -f /etc/kenan/$channel.json ]] || { echo "deploy_channel_not_configured: /etc/kenan/$channel.json is missing; this host does not host $channel" >&2; exit 10; }
script=$(realpath "$0")
# Deployment installs units and release trees as root; agents invoke it as themselves. Administrators re-run this
# script as root; household operators (machine/user-access.md) hand the checked, pushed commit to kenan-operator,
# which deploys it from its own checkout.
cd "$(dirname "$script")/.."
source deploy/detach.sh
build_cache_checked || exit
bash deploy/host-requirements.sh
if (( EUID != 0 )); then
 if sudo -n -l /bin/bash >/dev/null 2>&1; then reexec_as_root "$script" "$@"; fi
 bash deploy/lineage.sh "/srv/kenan/$channel" "$PWD" "$mode" >/dev/null
 wait_args=(); $wait_for_deploy && wait_args=(--wait)
 exec sudo -n /usr/local/sbin/kenan-operator deploy "$channel" "$mode" "$(git rev-parse HEAD)" "${wait_args[@]}"
fi
# Root tools (visudo, useradd) live in sbin, which an inherited PATH may omit: the Acme intake's PATH did (2026-11-04).
for dir in /usr/local/sbin /usr/sbin /sbin; do if [[ -d $dir && :$PATH: != *:$dir:* ]]; then PATH=$dir:$PATH; fi; done; export PATH
# Checked before detaching so a refusal reaches the caller instead of a transient unit's journal.
bash deploy/lineage.sh "/srv/kenan/$channel" "$PWD" "$mode" >/dev/null
# Acme: a forward deploy never restarts a channel while a real meeting is live on it (November 6, 2026: an intake
# deploy ran during a notetaker meeting). Rollback is never refused; KENAN_DEPLOY_DURING_MEETING=1 overrides.
if [[ $mode == forward && -f /etc/kenan/acme-meeting-$channel.json && ${KENAN_DEPLOY_DURING_MEETING:-} != 1 ]]; then
 meetings=$(cd "/srv/kenan/$channel" && node "$OLDPWD/deploy/stack-bundle-meetings.mjs" "$channel") || meetings='{"live":null}'
 if [[ $meetings == *'"live":true'* ]]; then
  echo "deploy_meeting_live: a real meeting is live on $channel; deploy after it ends (KENAN_DEPLOY_DURING_MEETING=1 overrides)" >&2
  exit 75
 fi
fi
if [[ $mode == forward && $channel == beta && -f /etc/kenan/slack-haiku-enabled ]]; then KENAN_SLACK_INTAKE_FROM_DEPLOY=beta bash deploy/install-slack-intake.sh --check; fi
source deploy/place.sh
bash deploy/install-runtime-control.sh
detach_deploy_from_app "$script" "$@"
# Acme's automatic intake holds its own cross-channel lock. Other hosts keep
# parallel builds and serialize only each channel's final file swap.
if [[ -f /etc/kenan/acme-meeting-beta.json ]]; then
 source deploy/stack-deploy-lock.sh
 stack_deploy_lock
fi
KENAN_DEPLOY_DESCRIPTION="deploy/deploy.sh $* at $(git -c safe.directory="$PWD" rev-parse --short HEAD)"
trap 'report_detached_failure $? "$channel"' EXIT
source_commit=$(git -c safe.directory="$PWD" rev-parse HEAD)
live_commit=$(bash deploy/lineage.sh "/srv/kenan/$channel" "$PWD" "$mode")
# Build as the checkout's owner into a tree keyed by the commit (deploy/prepare-build.sh), so Beta and production can
# deploy the same checkout at once without sharing node_modules or dist, and the second channel reuses the first's build.
bash deploy/install-build-deps.sh
owner=$(stat -c %U .)
build=$(build_as_owner "$owner" "$PWD" "$source_commit")
# Refuse a config the new build would reject (the channel file and every person's media settings) before anything restarts.
node -e 'import(process.argv[1]).then(m => m.checkChannelConfig(process.argv[2]))' "$build/dist/server/config-check.js" "/etc/kenan/$channel.json"
# Alice wants Kenan’s male voice. This only updates Acme’s own media selection; no live session is restarted.
if [[ $mode == forward ]]; then python3 deploy/install-acme-voice.py "$channel"; python3 deploy/install-acme-meeting-voice.py "$channel"; fi
# Dictation transcribes on this host; its package and models arrive before a channel that enables it starts.
if [[ $mode == forward ]]; then bash deploy/dictation-models.sh "$channel" "$build"; fi
# PDF previews draw pages with poppler (server/files/pdf.ts).
if [[ $mode == forward ]] && ! command -v pdftoppm >/dev/null; then DEBIAN_FRONTEND=noninteractive apt-get install -y -q poppler-utils >/dev/null; fi
# kenan-image (deploy/kenan-image) is a host command shared by every person's agents; installing is idempotent.
if [[ $mode == forward ]]; then bash deploy/install-image-gen.sh; fi
if [[ $mode == forward ]]; then bash deploy/install-local-policy.sh; place 0755 deploy/kenan-notify /usr/local/bin/kenan-notify; place 0755 deploy/kenan-event /usr/local/bin/kenan-event; bash deploy/install-background.sh; mkdir -p /var/tmp/kenan-bg; chmod 1777 /var/tmp/kenan-bg; place 0755 deploy/onboard.py /usr/local/sbin/kenan-onboard; place 0755 deploy/reset-login.py /usr/local/sbin/kenan-reset-login; place 0755 deploy/household-mail.py /usr/local/bin/household-mail; fi
if [[ $mode == forward ]]; then sh deploy/host-link/install; bash deploy/install-acme-handoff.sh; bash deploy/install-stack-intake.sh; fi
# The units come from this commit too, so hosts never keep a stale copy (acme-host's lacked self-recovery).
units_changed=0
if [[ $mode == forward ]]; then for unit in kenan-postgres.service kenan@.service kenan@.socket; do place_unit 0644 "deploy/$unit" "/etc/systemd/system/$unit"; done; fi
if (( units_changed )); then systemctl daemon-reload; fi
# Acme's subscription broker runs this commit's deploy/acme-model-broker.mjs; it restarts only when it changed
# (deploy/install-acme-broker.test.py). Hosts without pi-stack-next-employee-models.service are left alone.
if [[ $mode == forward ]]; then python3 deploy/install-acme-broker.py; fi
# Source-owned read-only intake runner; install never starts or replays a sweep.
if [[ $mode == forward && -d /opt/kenan-acme/deploy ]]; then python3 deploy/install-slack-bounded-intake.py; fi
if [[ $mode == forward && $channel == beta && -f /etc/kenan/slack-haiku-enabled ]]; then KENAN_SLACK_INTAKE_FROM_DEPLOY=beta bash deploy/install-slack-intake.sh; fi
# Browser Use Cloud client and root broker (deploy/cloud-browser); skipped on hosts without the host-owned key file.
if [[ $mode == forward ]]; then bash deploy/install-cloud-browser.sh; fi
if [[ $mode == forward && $channel == beta ]]; then python3 deploy/install-meeting-coverage.py; fi
enable_units "kenan@$channel.service"
if [[ -f /etc/systemd/system/kenan@.socket ]]; then enable_units "kenan@$channel.socket"; fi
# The phone edge runs this channel's call bridges from the same build, so it gets it before the server switches.
bash deploy/phone-edge/sync.sh "$channel" "$build"
bash deploy/install-build.sh "$channel" "$build" "/srv/kenan/$channel" "$source_commit" "$live_commit" "$mode"
# Startup can include a one-time schema backfill (conversation_file took 30-45 s on 1.3M messages), so wait while the
# service is still starting, up to 5 minutes, and stop waiting at once if it failed.
for attempt in {1..300}; do
 if curl --fail --silent --max-time 5 --unix-socket "/run/kenan/$channel.sock" http://localhost/api/accounts >/dev/null; then break; fi
 if systemctl is-failed --quiet "kenan@$channel.service"; then break; fi
 sleep 1
done
curl --fail --silent --max-time 5 --unix-socket "/run/kenan/$channel.sock" http://localhost/api/accounts
# Acme: the Google sign-in entrance for kenan.acme.example, its root enrollment and the people firewall follow Beta's build.
if [[ $mode == forward && $channel == beta ]]; then bash deploy/install-entrance.sh "$build" "$source_commit"; fi
# Hosts with household operators (deploy/operator/README.md) refresh their database views for the new schema.
if [[ -x /usr/local/sbin/kenan-operator ]]; then bash deploy/operator/apply-db.sh "$channel"; fi
# Hosts that build the native app keep its signed channel builds in /var/lib/kenan/android/CHANNEL; Acme has none.
if [[ -d /var/lib/kenan/android/$channel ]]; then node deploy/publish-android.mjs "$channel"; else echo "$channel: no native build on this host"; fi
echo "$channel launched"
# Post-release feedback is independent of this deployment and cannot hold or fail it.
if [[ $mode == forward && $channel == beta ]]; then
 if ! sudo -H -u "$owner" node "$PWD/deploy/background-check.mjs" start "$PWD" "${live_commit:--}" "$source_commit"; then
  echo 'Background changed-test feedback could not start; see its repair event. Beta is already live.' >&2
 fi
fi
# Beta is the release channel on hosts without production; two-channel hosts publish on promotion.
if [[ $channel == beta && ! -f /etc/kenan/production.json ]]; then
 bash deploy/public-github/trigger.sh
fi
