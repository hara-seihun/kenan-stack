#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
# The guard is shared across hosts; validate/install its host policy before the
# ResearchCo-only resource settings. Ordinary forward deploys call this installer.
python3 deploy/install-wal-guard.py
[[ $(hostname) == ResearchCo ]] || exit 0
# The userspace OOM killer stops reclaim storms before the kernel's hard cap
# stalls every command. Install only when absent; forward deploys do not upgrade
# the package repeatedly while running tools are using its libraries.
if ! dpkg-query -W -f='${Status}' systemd-oomd 2>/dev/null | grep -qx 'install ok installed'; then
 DEBIAN_FRONTEND=noninteractive apt-get install -y --no-upgrade systemd-oomd
 # Load the new bus policy before oomd first connects; otherwise its pressure
 # handling works but diagnostic calls time out waiting for the bus name.
 systemctl reload dbus.service
 systemctl restart systemd-oomd.service
fi
install -d /etc/systemd/system/user.slice.d /etc/systemd/user/service.d
install -m 644 deploy/priority-user/kenanbg.slice /etc/systemd/user/kenanbg.slice
# Per-job caps make one runaway allocation fail in its own cgroup, not stall every shell.
install -D -m 644 deploy/priority/agent-tool-.scope.d/60-job-memory.conf /etc/systemd/system/agent-tool-.scope.d/60-job-memory.conf
install -D -m 644 deploy/priority/kenan-bg-.service.d/60-job-memory.conf /etc/systemd/system/kenan-bg-.service.d/60-job-memory.conf
install -D -m 644 deploy/priority/kenan-bg-.service.d/60-job-memory.conf /etc/systemd/user/kenan-bg-.service.d/60-job-memory.conf
install -m 644 deploy/priority-user/service.d/50-kenan-oom-visible.conf /etc/systemd/user/service.d/50-kenan-oom-visible.conf
install -D -m 644 deploy/priority-user/kenan-bg-.service.d/50-kenan-bg-cpu.conf /etc/systemd/user/kenan-bg-.service.d/50-kenan-bg-cpu.conf
install -m 644 deploy/priority/system-kenan.slice.d/50-kenan-interactive.conf /etc/systemd/system/system-kenan.slice.d/50-kenan-interactive.conf
install -m 644 deploy/priority/system.slice.d/50-kenan-interactive.conf /etc/systemd/system/system.slice.d/50-kenan-interactive.conf
total_kib=$(awk '/^MemTotal:/ {print $2}' /proc/meminfo)
# Keep the system services' 16 GiB reservation plus 16 GiB for kernel/CMA,
# backups and other slices. Reserving only system.slice's minimum let the host
# exhaust physical RAM before the shared jobs reached their cgroup limit.
cap_gib=$((total_kib / 1048576 - 16 - 16))
(( cap_gib > 0 )) || { echo insufficient_ram_for_system_reserve >&2; exit 1; }
# A shared MemoryHigh makes every small tool launch reclaim other jobs' pages,
# even with physical RAM available. Keep the shared hard cap and host headroom
# without throttling all allocating jobs below that cap.
printf '[Slice]\nMemoryHigh=infinity\nMemoryMax=%sG\nMemorySwapMax=8G\nManagedOOMMemoryPressure=kill\nManagedOOMMemoryPressureLimit=10%%\nManagedOOMMemoryPressureDurationSec=5s\n' "$cap_gib" > /etc/systemd/system/user.slice.d/60-agent-memory.conf
rm -f /etc/systemd/system/agent-tool-.scope.d/50-kenan-{cpu,memory}.conf
for unit in 'kenan@' kenan-model-broker kenan-postgres 'kenan-signal-receiver@'; do
 install -d "/etc/systemd/system/$unit.service.d"
 printf '[Service]\nOOMScoreAdjust=-900\n' > "/etc/systemd/system/$unit.service.d/60-oom-priority.conf"
done
systemctl daemon-reload
systemctl enable --now systemd-oomd.service
for unit in kenan@beta.service kenan-model-broker.service kenan-postgres.service kenan-signal-receiver@kenan.service; do
 pid=$(systemctl show "$unit" -p MainPID --value)
 if [[ $pid =~ ^[1-9][0-9]*$ ]]; then printf '%s' -900 > "/proc/$pid/oom_score_adj"; fi
done
systemctl --user -M kenan@ daemon-reload
