#!/bin/bash
# Acme only (hosts with /etc/kenan/public-ingress.json): installs, from this commit's build, the people firewall,
# the root enrollment service and the Google sign-in entrance for kenan.acme.example, and keeps Beta's and production's
# state and configs private to root and kenan (people's tools run as their own uids and must not read Alice's chats).
# Idempotent; restarts a service only when its installed bytes changed. Usage: install-entrance.sh BUILD COMMIT
set -euo pipefail
build=${1:?build}; commit=${2:?commit}
[[ -f /etc/kenan/public-ingress.json ]] || exit 0
cd "$(dirname "$(realpath "$0")")/.."
changed() { [[ ! -f $2 ]] || ! cmp -s "$1" "$2"; }
put() { if changed "$2" "$3"; then install -m "$1" "$2" "$3"; return 0; fi; return 1; }
reload=0
for unit in kenan-people-firewall.service kenan-enroll.service kenan-public-entrance.service; do
 if put 0644 "deploy/$unit" "/etc/systemd/system/$unit"; then reload=1; fi
done
(( reload )) && systemctl daemon-reload
if put 0644 deploy/kenan-people-firewall.nft /etc/kenan/people-firewall.nft || ! nft list table inet kenan_people_tools >/dev/null 2>&1; then
 systemctl enable kenan-people-firewall.service >/dev/null 2>&1; systemctl restart kenan-people-firewall.service
fi
systemctl enable kenan-people-firewall.service >/dev/null 2>&1
for channel in beta production; do
 [[ -d /var/lib/kenan/$channel ]] && chgrp kenan "/var/lib/kenan/$channel" && chmod 0750 "/var/lib/kenan/$channel"
 [[ -f /etc/kenan/$channel.json ]] && chgrp kenan "/etc/kenan/$channel.json" && chmod 0640 "/etc/kenan/$channel.json"
done
install -d -m 0700 /etc/kenan/people /var/lib/kenan/people
if put 0755 deploy/kenan-enroll.py /usr/local/sbin/kenan-enroll || ! systemctl is-active --quiet kenan-enroll.service; then
 systemctl enable kenan-enroll.service >/dev/null 2>&1; systemctl restart kenan-enroll.service
fi
# The entrance switches to Google sign-in once the client from Secret Manager (acme-host-google-signin-client) is on
# the host as /etc/kenan/google-signin.json (root 0600); until then the earlier entrance keeps serving.
[[ -f /etc/kenan/google-signin.json ]] || { echo 'entrance: /etc/kenan/google-signin.json missing; Google sign-in not switched on'; exit 0; }
target=/opt/kenan-entrance/$commit
if [[ ! -f $target/entrance-main.js ]]; then
 install -d -m 0755 "$target.tmp"
 for f in entrance entrance-main google-identity; do install -m 0644 "$build/dist/server/public/$f.js" "$target.tmp/$f.js"; done
 printf '{"type":"module"}\n' > "$target.tmp/package.json"
 rm -rf "$target"; mv "$target.tmp" "$target"
fi
python3 - <<'PY'
import json, os
legacy = json.load(open('/etc/kenan/public-ingress.json')); google = json.load(open('/etc/kenan/google-signin.json'))
subject = legacy['subject']; assert subject.startswith('google-oauth2|')
entrance = {'publicUrl': legacy['publicUrl'], 'upstream': legacy['upstream'], 'webRoot': legacy['webRoot'],
            'google': {'clientId': google['clientId'], 'clientSecret': google['clientSecret'], 'hostedDomain': google['hostedDomain']},
            'administrator': {'googleSubject': subject[len('google-oauth2|'):], 'email': legacy['email'], 'accountId': legacy['accountId'], 'accountSecret': legacy['accountSecret']}}
text = json.dumps(entrance, indent=2) + '\n'
path = '/etc/kenan/entrance.json'
if not os.path.exists(path) or open(path).read() != text:
    tmp = path + '.tmp'; fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600); os.write(fd, text.encode()); os.close(fd); os.replace(tmp, path)
PY
previous=$(readlink /opt/kenan-entrance/current || true)
if [[ $previous != "$target" ]] || ! systemctl is-active --quiet kenan-public-entrance.service || [[ /etc/kenan/entrance.json -nt /run/kenan-entrance.stamp ]]; then
 ln -sfn "$target" /opt/kenan-entrance/current.new && mv -T /opt/kenan-entrance/current.new /opt/kenan-entrance/current
 # The earlier Auth0 entrance and its enrollment hold port 8788 and the old socket; the new pair replaces both.
 systemctl disable --now pi-stack-next-public-ingress.service pi-stack-next-public-enrollment.service >/dev/null 2>&1 || true
 systemctl enable kenan-public-entrance.service >/dev/null 2>&1; systemctl restart kenan-public-entrance.service
 touch /run/kenan-entrance.stamp
 for attempt in $(seq 1 50); do curl -fsS -o /dev/null http://127.0.0.1:8788/ && break; sleep 0.2; done
 curl -fsS -o /dev/null http://127.0.0.1:8788/ || { echo 'entrance did not answer; restoring the earlier entrance' >&2; systemctl stop kenan-public-entrance.service; [[ -n $previous ]] && ln -sfn "$previous" /opt/kenan-entrance/current; systemctl enable --now pi-stack-next-public-ingress.service pi-stack-next-public-enrollment.service; exit 1; }
fi
echo "entrance: Google sign-in serving from $target"
