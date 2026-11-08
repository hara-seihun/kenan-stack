#!/bin/bash
# CPU speech tools for local and edge call units. Models stay outside releases and Git.
set -euo pipefail
(( EUID == 0 )) || exec sudo -n bash "$0" "$@"
case ${1-} in
 ''|--tools-only) ;;
 *) echo 'usage: ensure-runtime.sh [--tools-only]' >&2; exit 2;;
esac
packages=()
command -v whisper-cli >/dev/null || packages+=(whisper.cpp)
command -v espeak-ng >/dev/null || packages+=(espeak-ng)
if (( ${#packages[@]} )); then
 DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "${packages[@]}"
fi
model=/var/lib/kenan/models/whisper/ggml-base-q5_1.bin
install -d -m 755 "$(dirname "$model")"
# The edge gets the canonical host copy below, rather than downloading on every deploy.
[[ ${1-} != --tools-only ]] || exit 0
if [[ ! -s $model ]]; then
 command -v curl >/dev/null || DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends curl
 temporary=$(mktemp "${model}.XXXXXX")
 trap 'rm -f "$temporary"' EXIT
 curl --fail --location --retry 2 --connect-timeout 15 --max-time 300 \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base-q5_1.bin -o "$temporary"
 [[ -s $temporary ]]
 chmod 644 "$temporary"
 mv "$temporary" "$model"
 trap - EXIT
fi
config=/etc/kenan/phone-edge.json
[[ -f $config ]] || exit 0
read -r host user key known <<<"$(python3 -c 'import json,sys; c=json.load(open(sys.argv[1])); print(*(c[k] for k in ("host","user","sshKeyPath","knownHostsPath")))' "$config")"
ssh_cmd=(ssh -i "$key" -o "UserKnownHostsFile=$known" -o StrictHostKeyChecking=yes -o BatchMode=yes -o ConnectTimeout=10)
"${ssh_cmd[@]}" "$user@$host" 'bash -s -- --tools-only' < "$(realpath "$0")"
# Size-only avoids reading the model or recopying it on ordinary deploys. Rsync publishes via rename.
rsync -a --size-only --chmod=F644 -e "${ssh_cmd[*]}" "$model" "$user@$host:$model"
