#!/bin/bash
# Keep host qualification outside an agent tool's process/deadline scope. The
# receive->admit latency check needs bounded scheduler contention, not a relaxed
# assertion. A private cgroup has priority; it does not stop other writers.
set -euo pipefail
root=$(git rev-parse --show-toplevel)
receipt=${1:?usage: qualify-host.sh ABSOLUTE_RECEIPT_DIRECTORY}
[[ $receipt = /* ]] || exit 2
mkdir -p "$receipt"
git rev-parse HEAD > "$receipt/source-commit"
unit=kenan-qualify-$(date +%s%N)
sudo systemd-run --unit="$unit" --collect -p User="$(id -un)" -p Group="$(id -gn)" -p Nice=-10 -p CPUWeight=10000 -p IOWeight=10000 /bin/bash -c 'cd "$1"; npm run check > "$2/check.log" 2>&1 && npm test -- --maxWorkers=1 > "$2/test.log" 2>&1; status=$?; printf "%s\n" "$status" > "$2/exit"; exit "$status"' bash "$root" "$receipt"
printf '%s\n' "$unit" > "$receipt/unit"
echo "Qualification continues independently in $unit; result $receipt/exit"
