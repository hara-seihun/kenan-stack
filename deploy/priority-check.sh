#!/bin/bash
# Regression check for compute priority (deploy/README.md "Compute priority"). Run it from an agent's Bash tool:
# it confirms the shell sits in the agent-tool scope the server placed it in, saturates every core from there,
# and compares app, broker and public phone-websocket latency against an idle baseline. Exit 0 = interactive paths held.
set -euo pipefail
channel=${1:-beta}
seconds=${2:-20}
case $channel in beta|production) ;; *) echo "usage: $0 [beta|production] [seconds]" >&2; exit 2 ;; esac

cgroup=$(cut -d: -f3 /proc/self/cgroup)
if [[ ! $cgroup =~ ^/user\.slice/user-$(id -u)\.slice/agent-tool-[^/]+\.scope$ ]]; then
 echo "priority_check_misplaced: this shell runs in $cgroup, not an agent-tool scope in user-$(id -u).slice" >&2
 exit 1
fi
echo "placement ok: $cgroup (cpu.weight $(cat /sys/fs/cgroup/user.slice/cpu.weight) on user.slice)"

zeros=$(printf '0%.0s' {1..64})
ws_url="https://calls.example.com/kenan/$channel/hooks/voice/phone/00000000-0000-4000-8000-000000000000/$zeros/silent/call_prioritycheck"
probe() {
 case $1 in
  app) curl -s -m 10 -o /dev/null -w '%{time_total}' --unix-socket "/run/kenan/$channel.sock" http://localhost/api/accounts ;;
  broker) curl -s -m 10 -o /dev/null -w '%{time_total}' http://127.0.0.1:2461/ ;;
  phone-ws) curl -s -m 10 -o /dev/null -w '%{time_total}' --http1.1 -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' "$ws_url" ;;
 esac
}
# p95 in milliseconds of N samples of one probe.
sample() {
 local name=$1 n=$2 i
 for ((i = 0; i < n; i++)); do probe "$name" || echo 10; echo; sleep 0.2; done | sort -n | awk '{a[NR]=$1} END {i=int(NR*0.95); if (i<1) i=1; printf "%d", a[i]*1000}'
}

declare -A base load
for p in app broker phone-ws; do base[$p]=$(sample "$p" 15); done

hogs=()
cleanup() { ((${#hogs[@]})) && kill "${hogs[@]}" 2>/dev/null; wait 2>/dev/null || true; }
trap cleanup EXIT
for ((i = 0; i < 2 * $(nproc); i++)); do (end=$((SECONDS + seconds)); while ((SECONDS < end)); do :; done) & hogs+=($!); done
sleep 3
for p in app broker phone-ws; do load[$p]=$(sample "$p" 15); done
loadavg=$(cut -d' ' -f1 /proc/loadavg)
cleanup; hogs=()

status=0
for p in app broker phone-ws; do
 limit=$(( base[$p] * 3 > base[$p] + 100 ? base[$p] * 3 : base[$p] + 100 ))
 verdict=ok; (( load[$p] <= limit )) || { verdict=REGRESSED; status=1; }
 printf '%-9s idle p95 %5d ms   under %d hogs p95 %5d ms   limit %5d ms   %s\n' "$p" "${base[$p]}" $((2 * $(nproc))) "${load[$p]}" "$limit" "$verdict"
done
echo "load average under hogs: $loadavg"
exit $status
