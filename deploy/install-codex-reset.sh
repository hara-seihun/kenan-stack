#!/bin/bash
# Installs Acme's automatic banked Codex reset (see acme-codex-reset.mjs) from this checkout:
# the script next to the subscription broker, its oneshot service and 10-minute timer, and the
# acme-codex-reset command, which runs the same script as the broker's user so manual and timer
# runs share one lock and one attempt record. Run as root. Disable with: systemctl disable --now kenan-codex-reset.timer
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
install -o root -g root -m 0644 "$here/acme-codex-reset.mjs" /opt/kenan-acme/deploy/acme-codex-reset.mjs
install -o root -g root -m 0644 "$here/kenan-codex-reset.service" /etc/systemd/system/kenan-codex-reset.service
install -o root -g root -m 0644 "$here/kenan-codex-reset.timer" /etc/systemd/system/kenan-codex-reset.timer
cat > /usr/local/bin/acme-codex-reset <<'WRAP'
#!/bin/bash
# Status: acme-codex-reset status. Manual spend: acme-codex-reset redeem [--dry-run] [--account ID] [--min-used PCT].
exec sudo -u pi2-acme /usr/local/bin/node /opt/kenan-acme/deploy/acme-codex-reset.mjs "$@"
WRAP
chmod 0755 /usr/local/bin/acme-codex-reset
install -d -o pi2-acme -g pi2-acme -m 0700 /var/lib/kenan-codex-reset
systemctl daemon-reload
systemctl enable --now kenan-codex-reset.timer
sudo -u pi2-acme /usr/local/bin/node /opt/kenan-acme/deploy/acme-codex-reset.mjs redeem --dry-run
