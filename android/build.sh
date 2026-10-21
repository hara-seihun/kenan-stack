#!/usr/bin/env bash
set -euo pipefail
if [[ $(id -u) == 0 ]]; then exec /usr/sbin/runuser -u kenan -- "$0" "$@"; fi
[[ $(id -u) == 1000 ]] || { printf 'Android build must use original kenan UID1000 cache custody\n' >&2; exit 2; }
cd "$(dirname "$0")"
export JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64
export ANDROID_HOME=/opt/android-sdk
export GRADLE_USER_HOME=/var/cache/kenan/android/gradle
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
exec "$GRADLE" --no-daemon --console=plain "$@"
