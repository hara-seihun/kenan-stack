#!/bin/bash
# Deploys to production exactly the commit live on Beta. The only forward route to production (deploy/lineage.sh).
# Usage: deploy/promote.sh
set -euo pipefail
# This file takes arguments, not stdin. Children must not consume a calling bash -s script.
exec </dev/null
# Parts of the deploy run Python as root from the checkout; bytecode written there would be root-owned and break the next
# checkout or clean (promote's clone failed this way on 2026-10-24).
export PYTHONDONTWRITEBYTECODE=1
(( $# == 0 )) || { echo 'Usage: deploy/promote.sh (takes no arguments; it promotes the commit live on Beta)' >&2; exit 64; }
fail() { echo "$1: $2" >&2; exit "$3"; }
[[ -f /etc/kenan/production.json ]] || fail deploy_channel_not_configured "/etc/kenan/production.json is missing; this host does not host production" 10
repo=/home/kenan/work/repos/kenan.git
# Detached systemd services have no login HOME. Use the repository owner for
# source preparation, rather than a root clone that cannot read the owned mirror.
if (( EUID == 0 )) && [[ $(stat -c %u "$repo") != 0 ]]; then
 owner=$(stat -c %U "$repo")
 args=(HOME="$(getent passwd "$owner" | cut -d: -f6)")
 [[ -v KENAN_STACK_LOCK_PID ]] && args+=(KENAN_STACK_LOCK_PID="$KENAN_STACK_LOCK_PID")
 [[ -v KENAN_BUILD_CACHE ]] && args+=(KENAN_BUILD_CACHE="$KENAN_BUILD_CACHE")
 [[ -v KENAN_BUNDLE_NOTE ]] && args+=(KENAN_BUNDLE_NOTE="$KENAN_BUNDLE_NOTE")
 exec sudo -n -u "$owner" env "${args[@]}" /bin/bash "$(realpath "$0")"
fi
export HOME=${HOME:-$(getent passwd "$(id -u)" | cut -d: -f6)}
beta_file=/srv/kenan/beta/source-commit
[[ -s $beta_file ]] || fail promote_beta_unset "$beta_file is missing: Beta has nothing deployed to promote" 9
beta=$(<"$beta_file")
[[ $beta =~ ^[0-9a-f]{40}$ ]] || fail promote_beta_invalid "$beta_file holds '$beta', not a commit id" 6
# Acme's timer picks up the bundle; this host never pushes or deploys there.
handoff() {
 # Host integrations are optional for an independent public install.
 # Start publication independently of the remote source handoff.
 local trigger="$(dirname "${BASH_SOURCE[0]}")/public-github/trigger.sh"
 [[ ! -f $trigger ]] || bash "$trigger"
 local bundle="$(dirname "${BASH_SOURCE[0]}")/bundle-acme.sh"
 [[ ! -f $bundle ]] || bash "$bundle" "$beta"
}

if [[ -s /srv/kenan/production/source-commit && $(</srv/kenan/production/source-commit) == "$beta" ]]; then
 echo "production already runs Beta's ${beta:0:8}"; handoff; exit
fi
# A clean clone at Beta's commit, kept per user. Its owner's immutable build cache is shared with ordinary checkouts.
checkout=${XDG_STATE_HOME:-$HOME/.local/state}/kenan-promote
if [[ ! -d $checkout/.git ]]; then
 mkdir -p "$(dirname "$checkout")"
 git clone --quiet --no-checkout "$repo" "$checkout"
fi
git -C "$checkout" fetch --quiet origin
git -C "$checkout" cat-file -e "$beta^{commit}" 2>/dev/null || fail promote_beta_unpublished "Beta runs ${beta:0:8}, which is not in $repo" 5
git -C "$checkout" checkout --quiet --force --detach "$beta"
git -C "$checkout" clean -fdxq -e node_modules
echo "Promoting Beta's ${beta:0:8} to production"
bash "$checkout/deploy/deploy.sh" production --wait
# --wait reports the detached unit's result, not merely successful submission to systemd.
[[ -s /srv/kenan/production/source-commit && $(</srv/kenan/production/source-commit) == "$beta" ]] || fail promote_production_not_live "production did not reach ${beta:0:8}; no Acme handoff was queued" 12
handoff
