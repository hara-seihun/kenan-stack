#!/bin/bash
# A deployment must not die with the app that requested it.
detach_deploy_from_app() {
 # Agent tools run in agent-tool-CHANNEL-*.scope units bound to kenan@CHANNEL.service, so stopping the app ends them too.
 if ! grep -Eq '/kenan@[^/]+\.service(/|$)|/agent-tool-[^/]+\.scope$' "/proc/$$/cgroup"; then return; fi
 local entry=$1
 shift
 entry=$(realpath "$entry")
 local unit="kenan-deploy-${1:?channel}-$(date +%s%N)"
 systemd-run --quiet --collect --expand-environment=no --unit="$unit" --slice=user.slice \
  --property="WorkingDirectory=$PWD" --setenv="PATH=$PATH" \
  --setenv="KENAN_DEPLOY_UNIT=$unit" --setenv="KENAN_DEPLOY_REQUESTER_UID=${SUDO_UID-}" \
  /bin/bash "$entry" "$@"
 printf 'Deployment continues independently in %s.service; inspect with sudo journalctl -u %s.service; a failure is sent to your phone\n' "$unit" "$unit"
 exit 0
}

# Nobody watches a detached unit's journal, so its failure goes to the requester's phone through their durable
# notify outbox (/var/lib/kenan/notify/PERSON, owned by their uid), which survives this deploy restarting the app.
report_detached_failure() {
 local status=$1 channel=$2
 (( status != 0 )) && [[ -n ${KENAN_DEPLOY_UNIT-} ]] || return 0
 if [[ -z ${KENAN_DEPLOY_REQUESTER_UID-} ]]; then echo 'deploy_failure_unreported: no requesting uid' >&2; return 0; fi
 timeout 5 journalctl --sync 2>/dev/null || true
 local log body
 log=$(journalctl -u "$KENAN_DEPLOY_UNIT.service" -n 25 -o cat --no-pager 2>&1 | tail -c 1500)
 body=$(printf '%s failed with exit %s.\n\n%s\n\nFull log: sudo journalctl -u %s.service' "$KENAN_DEPLOY_DESCRIPTION" "$status" "$log" "$KENAN_DEPLOY_UNIT")
 "$(dirname "${BASH_SOURCE[0]}")/kenan-notify" --uid "$KENAN_DEPLOY_REQUESTER_UID" "Kenan $channel deploy failed" normal <<<"$body" >/dev/null
}
