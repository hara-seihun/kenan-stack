#!/bin/bash
# A deploy replaces whatever a channel runs, so it must carry every commit already live there.
# Usage: deploy/lineage.sh TARGET CHECKOUT forward|rollback
# Prints the live commit (or "none" before the first deploy) for install-build.sh to compare-and-swap.
set -euo pipefail
target=${1:?target}; checkout=${2:?checkout}; mode=${3:?forward|rollback}
[[ $mode == forward || $mode == rollback ]] || { echo "deploy_usage: mode must be forward or rollback, got $mode" >&2; exit 64; }
refuse() { echo "$1: $2" >&2; exit "$3"; }
git_() { GIT_OPTIONAL_LOCKS=0 git -c safe.directory='*' -C "$checkout" "$@"; }

commit=$(git_ rev-parse --verify HEAD^{commit})
dirty=$(git_ status --porcelain --untracked-files=no)
[[ -z $dirty ]] || refuse deploy_uncommitted_changes "$checkout has uncommitted changes, so the build would not match ${commit:0:8}. Commit them first:
$dirty" 3

# A worktree of the shared bare repository is the shared repository itself; a clone names it as origin.
common=$(git_ rev-parse --path-format=absolute --git-common-dir 2>/dev/null)
if [[ -n $common && $(git -c safe.directory='*' --git-dir="$common" rev-parse --is-bare-repository 2>/dev/null) == true ]]; then origin=$common
else origin=$(git_ remote get-url origin 2>/dev/null) || refuse deploy_no_shared_repository "$checkout has no origin remote; deploys must come from a clone or worktree of the shared repository" 4; fi
[[ $origin == /* && -d $origin ]] || refuse deploy_no_shared_repository "origin $origin is not a local repository on this host" 4
origin_git() { GIT_OPTIONAL_LOCKS=0 git -c safe.directory='*' --git-dir="$origin" "$@"; }
if [[ -z $(origin_git for-each-ref --count=1 --contains "$commit" refs/heads 2>/dev/null) ]]; then
 refuse deploy_commit_unpublished "${commit:0:8} is not on any branch of $origin. Push it (to the shared branch) before deploying, so the next deploy can include it" 5
fi

if [[ ! -s $target/source-commit ]]; then echo none; exit 0; fi
live=$(<"$target/source-commit")
[[ $live =~ ^[0-9a-f]{40}$ ]] || refuse deploy_live_commit_invalid "$target/source-commit holds '$live', not a commit id" 6
shared() { GIT_ALTERNATE_OBJECT_DIRECTORIES="$origin/objects" git_ "$@"; }

if [[ $mode == rollback ]]; then
 if shared cat-file -e "$live^{commit}" 2>/dev/null && ! shared merge-base --is-ancestor "$live" "$commit"; then
  echo "Rollback: ${commit:0:8} drops these live commits:" >&2
  shared log --format='  %h %s' "$commit..$live" >&2
 fi
 echo "$live"; exit 0
fi

shared cat-file -e "$live^{commit}" 2>/dev/null || refuse deploy_live_commit_unknown "the channel runs ${live:0:8}, which is in neither $checkout nor $origin, so this deploy cannot prove it keeps it. Find and push that commit, then merge it, or pass --rollback to replace it deliberately" 7
if ! shared merge-base --is-ancestor "$live" "$commit"; then
 missing=$(shared log --format='  %h %s' "$commit..$live")
 refuse deploy_would_drop_live_commits "${commit:0:8} lacks $(wc -l <<<"$missing") commit(s) live on this channel:
$missing
Merge or rebase onto ${live:0:8} and deploy again, or pass --rollback to remove them deliberately" 8
fi
echo "$live"
