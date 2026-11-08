#!/bin/bash
# Regression check (~5 s, root or passwordless sudo): an agent tool scope can always start, even in the moment the slice
# it starts in has just become empty. In a fresh slice inside user-agents.slice (same drop-ins as Docker's slice) it runs
# one scope, checks the slice is still up a second after the scope ended (a slice that stops when empty queues a stop job
# then, and a scope starting meanwhile is refused as "destructive"), then starts 100 short scopes, 4 at a time, and fails
# on any refused start. Also checks user-agents.slice and user-agents-docker.slice themselves.
# Policy: deploy/README.md "Compute priority".
set -uo pipefail
run=(); ((EUID)) && run=(sudo -n)
fail=0
for slice in user-agents.slice user-agents-docker.slice; do
 v=$(systemctl show -P StopWhenUnneeded "$slice")
 [[ $v == no ]] || { echo "agent_slice_stops_when_empty: $slice has StopWhenUnneeded=$v" >&2; fail=1; }
done
probe=user-agents-probe$$.slice
errors=$(mktemp)
"${run[@]}" systemd-run --quiet --scope --slice="$probe" true 2>>"$errors"
sleep 1
state=$(systemctl is-active "$probe")
[[ $state == active ]] || { echo "agent_slice_stops_when_empty: $probe is $state once its only scope ended" >&2; fail=1; }
for ((i = 0; i < 25; i++)); do
 for j in 1 2 3 4; do "${run[@]}" systemd-run --quiet --scope --slice="$probe" true 2>>"$errors" & done
 wait
done
"${run[@]}" systemctl stop "$probe" 2>/dev/null
refused=$(grep -c . "$errors")
if ((refused)); then echo "agent_scope_start_refused: $refused of 101 starts in $probe failed:" >&2; sort -u "$errors" | head -3 >&2; fail=1; fi
rm -f "$errors"
((fail)) || echo "agent slice check: agent slices stay up when empty; 101 scope starts, none refused"
exit $fail
