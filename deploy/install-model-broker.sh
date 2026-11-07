#!/usr/bin/env bash
# Install the bundled subscription broker, preserving a separately managed broker.
set -euo pipefail
exec </dev/null
source_root=$(cd "$(dirname "$0")/.." && pwd)
component=$source_root/model-broker
root=/srv/kenan/broker
config=/etc/kenan/model-broker.json
[[ $(id -u) == 0 ]] || { echo 'model_broker_install_requires_root' >&2; exit 1; }
# Existing private/independent installations keep their release and credentials. Once
# this installer owns current, every forward Stack deploy updates it from source.
# A host whose brokers run elsewhere says so in /etc/kenan/model-broker.external (Acme: its own Claude and
# Codex brokers on ports 25121 and 25100; Beta's deploy failed here on November 6, 2026 without it).
if [[ -f /etc/kenan/model-broker.external ]]; then
 echo 'Keeping the externally managed model broker (/etc/kenan/model-broker.external).'
 exit 0
fi
if [[ -e $root/current && ! -f $root/current/.stack-bundled ]]; then
 echo 'Keeping the independently managed model broker.'
 exit 0
fi
[[ -f $config ]] || { echo 'model_broker_config_missing: copy model-broker/config.example.json to /etc/kenan/model-broker.json, edit its grants, then rerun this installer' >&2; exit 1; }
bash "$source_root/deploy/install-build-deps.sh"
node=$(command -v node)
[[ $($node -p 'Number(process.versions.node.split(".")[0]) >= 24') == true ]] || { echo 'model_broker_requires_node_24' >&2; exit 1; }
id kenan >/dev/null
if [[ -e $root/current && ! -L $root/current ]]; then
 echo 'model_broker_current_not_symlink: current must be a release symlink' >&2
 exit 1
fi
previous=$(readlink "$root/current" 2>/dev/null || true)
# Only create missing private state directories. Never overwrite or import auth.
python3 - "$config" <<'PY'
import json, os, pwd, stat, sys
p=sys.argv[1]; info=os.stat(p)
if info.st_uid != 0 or info.st_mode & 0o022:
    raise SystemExit('model_broker_config_permissions: config must be root-owned without group/other write access')
c=json.load(open(p)); owner=pwd.getpwnam('kenan')
for key in ('ledgerPath','authPath'):
    path=c.get(key)
    if not isinstance(path,str) or not path.startswith('/'):
        raise SystemExit('model_broker_config_invalid: ledgerPath and authPath must be absolute')
    parent=os.path.dirname(path)
    if not os.path.isdir(parent):
        os.makedirs(parent, mode=0o700, exist_ok=True)
        os.chown(parent,owner.pw_uid,owner.pw_gid)
PY
install -d -m 755 "$root"
stage=$(mktemp -d "$root/.stack-build-XXXXXX")
trap 'rm -rf "$stage"' EXIT
cp -a "$component/src" "$component/build.mjs" "$component/package.json" "$component/package-lock.json" "$stage/"
(cd "$stage" && npm ci --include=dev --no-audit --no-fund && npm run build && npm prune --omit=dev --no-audit --no-fund)
# Check configuration against the installed parser before selecting any release.
chmod -R a+rX "$stage"
runuser -u kenan -- "$node" "$stage/dist/cli.js" accounts "$config" >/dev/null
touch "$stage/.stack-bundled"
chown -R root:root "$stage"
release=$root/stack-$(date +%s)-${stage##*-}
mv "$stage" "$release"
trap - EXIT
install -D -m 755 "$source_root/deploy/model-broker-supervisor/supervisor.mjs" /usr/local/lib/kenan/model-broker-supervisor.mjs
sed "s|/usr/local/bin/node|$node|g" "$source_root/deploy/kenan-model-broker.service" > /etc/systemd/system/kenan-model-broker.service
install -m 755 "$source_root/deploy/port-access.py" /usr/local/sbin/kenan-port-access
install -m 644 "$source_root/deploy/kenan-port-access.service" /etc/systemd/system/kenan-port-access.service
# A fresh host has no additional owner-only ports yet.
if [[ ! -f /etc/kenan/owner-ports.json ]]; then printf '{"ports":[]}\n' > /etc/kenan/owner-ports.json; fi
systemctl daemon-reload
systemctl enable kenan-port-access.service kenan-model-broker.service
systemctl restart kenan-port-access.service
ln -s "$release" "$root/.current-$$"
mv -Tf "$root/.current-$$" "$root/current"
activate() {
 if systemctl is-active --quiet kenan-model-broker.service; then systemctl reload kenan-model-broker.service
 else systemctl start kenan-model-broker.service; fi
}
if activate; then :
else
 status=$?
 if [[ -n $previous ]]; then
  ln -s "$previous" "$root/.current-$$"
  mv -Tf "$root/.current-$$" "$root/current"
 else
  rm -f "$root/current"
 fi
 echo 'model_broker_activation_failed: restored the previous release selection; inspect journalctl -u kenan-model-broker' >&2
 exit "$status"
fi
printf 'Bundled subscription broker installed. Use model-broker/README.md to sign in to your own subscriptions.\n'
