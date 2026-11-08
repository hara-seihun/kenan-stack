#!/usr/bin/env bash
set -euo pipefail
if [[ $(id -u) == 0 ]]; then exec /usr/sbin/runuser -u kenan -- "$0" "$@"; fi
[[ $(id -u) == 1000 ]] || { printf 'Android build must use original kenan UID1000 cache custody\n' >&2; exit 2; }
cd "$(dirname "$0")"
export JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64
export ANDROID_HOME=/opt/android-sdk
export GRADLE_USER_HOME=/var/cache/kenan/android/gradle
# Disposable debug builds use their own key; never touch either release identity.
debug_key=/var/cache/kenan/android/next-debug.keystore
if [[ ! -f "$debug_key" ]]; then
    umask 077
    mkdir -p "$(dirname "$debug_key")"
    tmp=$(mktemp "${debug_key}.XXXXXX")
    trap 'rm -f "$tmp"' EXIT
    rm -f "$tmp"
    "$JAVA_HOME/bin/keytool" -genkeypair -keystore "$tmp" -storepass android -keypass android \
        -alias androiddebugkey -dname 'CN=Android Debug,O=Android,C=US' -keyalg RSA -keysize 2048 -validity 10000 >/dev/null 2>&1
    ln "$tmp" "$debug_key" 2>/dev/null || [[ -f "$debug_key" ]]
    rm -f "$tmp"
    trap - EXIT
fi
GRADLE=$(python3 - <<'PY'
import json
from pathlib import Path
spec = json.loads(Path('toolchain.json').read_text())
root = Path(spec['installationRoot']) / spec['version']
receipt = root / 'kenan-toolchain.json'
if not receipt.is_file() or json.loads(receipt.read_text()) != spec:
    raise SystemExit('Shared Gradle toolchain is unset or differs from android/toolchain.json; install with sudo python3 android/install-toolchain.py --manifest android/toolchain.json')
print(root / 'bin/gradle')
PY
)
if [[ ! -x "$GRADLE" ]]; then printf 'Declared shared Gradle executable missing: %s\n' "$GRADLE" >&2; exit 1; fi
channel=
origin_supplied=false
for arg in "$@"; do
    case "$arg" in
        -PkenanChannel=*) channel=${arg#*=} ;;
        -PkenanGatewayOrigin=*) origin_supplied=true ;;
    esac
done
if ! $origin_supplied; then
    [[ "$channel" == beta || "$channel" == production ]] || { echo 'Supply -PkenanChannel=beta or production' >&2; exit 2; }
    config_reader=(python3)
    [[ -r "/etc/kenan/$channel.json" ]] || config_reader=(sudo -n python3)
    origin=$("${config_reader[@]}" -c 'import json,sys; x=json.load(open(sys.argv[1])); v=x["origins"][0]; assert isinstance(v,str) and v; print(v)' "/etc/kenan/$channel.json")
    set -- "$@" "-PkenanGatewayOrigin=$origin"
fi
exec "$GRADLE" --no-daemon --console=plain "$@"
