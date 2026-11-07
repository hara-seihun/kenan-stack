#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
bash deploy/install-build-deps.sh
install -d -m 755 /var/lib/kenan /run/kenan /srv/kenan
if [[ ! -f /var/lib/kenan/postgres/PG_VERSION ]]; then
 install -d -o postgres -g postgres -m 700 /var/lib/kenan/postgres
 runuser -u postgres -- /usr/lib/postgresql/18/bin/initdb -D /var/lib/kenan/postgres --auth-local=peer --auth-host=reject
fi
install -m 644 deploy/kenan-postgres.service deploy/kenan@.service deploy/kenan@.socket deploy/kenan-entrance@.service deploy/kenan-port-access.service deploy/kenan-model-broker.service deploy/kenan-wal-guard.service deploy/kenan-wal-guard.timer deploy/kenan-chrome-reap.service deploy/kenan-chrome-reap.timer /etc/systemd/system/
cp -r --no-preserve=ownership deploy/priority/. /etc/systemd/system/
install -d /etc/systemd/user && cp -r --no-preserve=ownership deploy/priority-user/. /etc/systemd/user/
if [[ $(hostname) == acme-host ]]; then
 cp -r --no-preserve=ownership deploy/acme-policy/priority/. /etc/systemd/system/
 cp -r --no-preserve=ownership deploy/acme-policy/priority-user/. /etc/systemd/user/
fi
bash deploy/install-local-policy.sh
bash deploy/install-runtime-control.sh
sh deploy/install-mail.sh install
install -m 644 deploy/entrance-beta.conf deploy/entrance-production.conf /etc/kenan/
install -m 644 deploy/owner-ports.json deploy/developers.json /etc/kenan/
install -m 755 deploy/contribute.py /usr/local/bin/kenan-stack-contribute
visudo -cf deploy/contribute.sudoers && install -m 440 deploy/contribute.sudoers /etc/sudoers.d/kenan-stack-contribute
install -d -o kenan -g kenan -m 755 /var/lib/kenan/contributions
bash deploy/install-acme-handoff.sh
install -m 644 deploy/apparmor-kenan-chrome /etc/apparmor.d/kenan-chrome
apparmor_parser -r /etc/apparmor.d/kenan-chrome
install -m 755 deploy/port-access.py /usr/local/sbin/kenan-port-access
install -D -m 755 deploy/model-broker-supervisor/supervisor.mjs /usr/local/lib/kenan/model-broker-supervisor.mjs
install -m 644 deploy/model-broker-supervisor/90-kenan-model-broker.conf /etc/sysctl.d/ && sysctl -q -p /etc/sysctl.d/90-kenan-model-broker.conf
bash deploy/install-model-broker.sh
python3 deploy/install-wal-guard.py --required
install -m 755 deploy/chrome-reap.py /usr/local/sbin/kenan-chrome-reap
systemctl daemon-reload
systemctl enable --now kenan-postgres.service
if ! runuser -u postgres -- psql -h /run/kenan/pg -Atc "SELECT 1 FROM pg_roles WHERE rolname='root'" | grep -q 1; then
 runuser -u postgres -- createuser -h /run/kenan/pg --superuser root
fi
for channel in beta production; do
 if ! psql -h /run/kenan/pg -d postgres -Atc "SELECT 1 FROM pg_database WHERE datname='kenan_$channel'" | grep -q 1; then
  createdb -h /run/kenan/pg "kenan_$channel"
 fi
done
# Vitest's host default uses this dedicated throwaway database, never an app database.
# Schema-isolated suites can run as their Unix peer without becoming superusers.
if ! psql -h /run/kenan/pg -d postgres -Atc "SELECT 1 FROM pg_database WHERE datname='kenan_test'" | grep -q 1; then
 createdb -h /run/kenan/pg kenan_test
fi
psql -h /run/kenan/pg -d postgres -v ON_ERROR_STOP=1 -c 'GRANT CONNECT, CREATE ON DATABASE kenan_test TO PUBLIC'
systemctl daemon-reload
systemctl enable --now kenan-port-access.service kenan-model-broker.service kenan-entrance@beta.service kenan-entrance@production.service kenan-wal-guard.timer kenan-chrome-reap.timer
printf 'Prepared units and PostgreSQL; write /etc/kenan/CHANNEL.json before deploying.\n'
