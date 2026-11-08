#!/bin/bash
# Install the research remote's forward-only and size hooks and native build helper.
set -euo pipefail
[[ $(id -u) == 0 ]] || { echo 'research_install_needs_root: run with sudo' >&2; exit 1; }
here=$(cd "$(dirname "$0")" && pwd)
remotes=/home/kenan/data/research-remotes
install -d -m 0755 /usr/local/lib/kenan /usr/local/bin
install -m 0755 "$here/main-fast-forward" /usr/local/lib/kenan/research-main-fast-forward
install -m 0755 "$here/size-cap" /usr/local/lib/kenan/research-size-cap
install -m 0755 "$here/ResearchCo-post-receive" /usr/local/lib/kenan/research-ResearchCo-post-receive
install -m 0755 "$here/symbolic-search-native-build" /usr/local/bin/symbolic-search-native-build
shopt -s nullglob
for repo in "$remotes"/*.git; do
  for pair in update:research-main-fast-forward pre-receive:research-size-cap; do
    hook=$repo/hooks/${pair%%:*}; target=/usr/local/lib/kenan/${pair#*:}
    if [[ -e $hook && $(readlink "$hook" || true) != "$target" ]]; then echo "research_hook_conflict: $hook exists" >&2; exit 1; fi
    ln -sfn "$target" "$hook"
  done
done
