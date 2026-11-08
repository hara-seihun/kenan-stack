#!/bin/bash
# Copy production's source for Acme's automatic intake; message only for a decision.
# The only remote write is the bundle file in /var/tmp; Acme owns its source and deployment.
# Usage: deploy/bundle-acme.sh COMMIT [--note "Decision needed on Acme"]
set -euo pipefail
# This file takes arguments, not stdin. Children must not consume a calling bash -s script.
exec </dev/null
fail() { echo "$1: $2" >&2; exit "$3"; }
usage() { echo 'Usage: deploy/bundle-acme.sh COMMIT [--note "Decision needed on Acme"]' >&2; exit 64; }
(( $# == 1 || $# == 3 )) || usage
commit=$1
note=${KENAN_BUNDLE_NOTE:-}
if (( $# == 3 )); then
 [[ $2 == --note && -n ${3//[[:space:]]/} ]] || usage
 note=$3
fi
[[ -n ${note//[[:space:]]/} ]] || note=''
# Household operators use the repository owner's bundle directory and peer socket.
helper=/usr/local/libexec/kenan-bundle-acme
if [[ -z ${KENAN_BUNDLE_REPO:-} && $(id -un) != kenan && -x $helper ]]; then
 args=("$commit")
 [[ -n $note ]] && args+=(--note "$note")
 exec sudo -n -u kenan "$helper" "${args[@]}"
fi
repo=${KENAN_BUNDLE_REPO:-/home/kenan/work/repos/kenan.git}
relay=${KENAN_BUNDLE_RELAY:-$HOME/.config/kenan-peer-relay/acme.json}
[[ -f $relay ]] || { echo 'Acme handoff skipped: this account has no Acme peer relay'; exit 0; }
requested_commit=$commit
if ! commit=$(git -C "$repo" rev-parse --verify --end-of-options "$requested_commit^{commit}" 2>/dev/null); then
 [[ $requested_commit =~ ^[0-9a-f]{40}$ ]] && fail bundle_commit_unknown "$requested_commit is not in $repo" 5
 fail bundle_commit_invalid "'$requested_commit' does not resolve to a commit in $repo" 6
fi
out=${KENAN_BUNDLE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/kenan-acme-bundles}
mkdir -p "$out"
out=$(realpath "$out")
bundle=$out/$commit.bundle
if [[ ! -s $bundle ]]; then
 tmp=$(mktemp "$out/.bundle.XXXXXX")
 ref=refs/kenan-acme/bundle$(basename "$tmp")
 trap 'git -C "$repo" update-ref -d "$ref"; rm -f "$tmp"' EXIT
 git -C "$repo" update-ref "$ref" "$commit"
 # A complete bundle needs no guesses about which ancestors Acme already has.
 git -C "$repo" bundle create "$tmp" "$ref"
 mv "$tmp" "$bundle"
 git -C "$repo" update-ref -d "$ref"
 trap - EXIT
fi
ref=$(git -C "$repo" bundle list-heads "$bundle" | cut -d ' ' -f2)
remote_bundle=/var/tmp/kenan-stack-$commit.bundle
payload=$(jq -n --arg bundle "$remote_bundle" --arg ref "$ref" --arg commit "$commit" '{
 bundle: $bundle, ref: $ref, commit: $commit, peer: "acme"
}')
handoff_failed() {
 local code=$1 detail=$2 status=$3
 jq --arg error "$code" --arg detail "$detail" '. + {status: "failed", error: $error, detail: $detail, action: "Please repair the failed Acme handoff and rerun deploy/promote.sh. Production is already live."}' <<< "$payload" |
  "${KENAN_EVENT_COMMAND:-kenan-event}" --id "acme-bundle-failed:$commit" 'deploy:manager:alice:acme-bundle' || echo 'bundle_failure_event_failed: could not notify Kenaznia' >&2
 fail "$code" "$detail" "$status"
}
# Each sender owns its temporary file: promotion and intake may export this commit
# concurrently. Stream and rename in one session; intake only sees complete *.bundle files.
ssh -o BatchMode=yes -o ConnectTimeout=15 acme-host "
 set -e
 partial=\$(mktemp '$remote_bundle.XXXXXX.partial')
 trap 'rm -f \"\$partial\"' EXIT
 cat >\"\$partial\"
 mv -f \"\$partial\" '$remote_bundle'
" < "$bundle" ||
 handoff_failed bundle_copy_failed "could not copy $bundle to acme-host:$remote_bundle" 10
# Feedback starts after the copy and never changes the handoff's success. Its JSON sidecar is updated when checks finish.
if ! node "$(dirname "$0")/background-check.mjs" export "$repo" - "$commit"; then
 echo 'Background changed-test feedback could not start; the repair event has been queued. Bundle export is complete.' >&2
fi
if [[ -z $note ]]; then
 echo "Acme bundle copied to acme-host:$remote_bundle (ref $ref); automatic intake will pick it up"
 exit 0
fi
# Keep the optional decision message free of personal context.
payload=$(jq --arg note "$note" '. + {text: ($note + "\nBundle: " + .bundle + ", through ref " + .ref + ", through commit " + .commit + ", no prerequisites; supersedes all earlier Kenan Stack bundles.")}' <<< "$payload")
# A stable UUID makes repeated promotions queue this message once, including after a crash before the host file is removed.
id="${commit:0:8}-${commit:8:4}-${commit:12:4}-${commit:16:4}-${commit:20:12}"
message=$(jq --arg id "$id" '{id: $id, peer: .peer, from: "deploy:promotion", to: "manager:acme", text: .text, createdAt: (now * 1000 | floor)}' <<< "$payload")
# The channel creates this owned directory at startup. Atomic files survive a stopped/restarting Beta;
# its ordinary host-inbox watcher transfers them to peer_message, deduplicated by the stable id above.
outbox=${KENAN_BUNDLE_OUTBOX:-/var/lib/kenan/peer-outbox/alice}
queued_file=$(mktemp "$outbox/.bundle.XXXXXX") || handoff_failed bundle_relay_failed "could not write the peer outbox $outbox" 11
trap 'rm -f "$queued_file"' EXIT
printf '%s\n' "$message" > "$queued_file" && mv "$queued_file" "$outbox/$(date +%s%N)-${queued_file##*.}.json" ||
 handoff_failed bundle_relay_failed "could not queue the Acme peer message in $outbox" 11
trap - EXIT
echo "Acme bundle copied to acme-host:$remote_bundle (ref $ref); message queued durably for Acme's Kenaznia"
