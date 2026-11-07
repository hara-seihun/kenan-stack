#!/bin/bash
source "$(dirname "${BASH_SOURCE[0]}")/build-as-owner.sh"

# Administrators re-run the deploy as root; sudo's env_reset keeps only PATH, so a set KENAN_BUILD_CACHE is named too.
reexec_as_root() {
 build_cache_checked || exit
 local keep=PATH
 [[ -v KENAN_STACK_LOCK_PID ]] && keep+=,KENAN_STACK_LOCK_PID
 [[ -v KENAN_BUILD_CACHE ]] && keep+=,KENAN_BUILD_CACHE
 exec sudo -n --preserve-env="$keep" /bin/bash "$@"
}

# A deployment must not die with the app that requested it.
detach_deploy_from_app() {
 # Agent tools run in agent-tool-CHANNEL-*.scope units bound to kenan@CHANNEL.service, so stopping the app ends them too.
 if ! grep -Eq '/kenan@[^/]+\.service(/|$)|/agent-tool-[^/]+\.scope$' "/proc/$$/cgroup"; then return; fi
 detach_deploy "$@"
}

# A transient unit starts from systemd's environment, not ours: everything the deploy needs is passed with --setenv.
detach_deploy() {
 build_cache_checked || exit
 local entry=$1
 shift
 entry=$(realpath "$entry")
 local unit="kenan-deploy-${1:?channel}-$(date +%s%N)"
 local -a env=(--setenv="PATH=$PATH" --setenv="KENAN_DEPLOY_UNIT=$unit" --setenv="KENAN_DEPLOY_REQUESTER_UID=${SUDO_UID-}")
 [[ -v KENAN_STACK_LOCK_PID ]] && env+=(--setenv="KENAN_STACK_LOCK_PID=$KENAN_STACK_LOCK_PID")
 [[ -v KENAN_BUILD_CACHE ]] && env+=(--setenv="KENAN_BUILD_CACHE=$KENAN_BUILD_CACHE")
 local -a wait_args=()
 if ${wait_for_deploy:-false}; then wait_args=(--wait); fi
 printf 'Deployment continues independently in %s.service; inspect with sudo journalctl -u %s.service; a failure is sent to your phone\n' "$unit" "$unit"
 local status=0
 systemd-run --quiet --collect --expand-environment=no --unit="$unit" --slice=user.slice \
  --property="WorkingDirectory=$PWD" "${wait_args[@]}" "${env[@]}" \
  /bin/bash "$entry" "$@" || status=$?
 if (( status != 0 )); then
  echo "deploy_detached_failed: $unit.service returned $status; inspect with sudo journalctl -u $unit.service" >&2
  exit "$status"
 fi
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
