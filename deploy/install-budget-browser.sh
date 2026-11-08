#!/bin/bash
# Install only the opt-in isolated acquisition tool. No browser selection,
# cloud profile, running session, service or extension configuration is changed.
set -euo pipefail
cd "$(dirname "$0")/.."
commit=$(git rev-parse HEAD)
paths=(deploy/cloud-browser/budget-browser.py deploy/cloud-browser/request-budget.py deploy/install-budget-browser.sh)
if [[ -n $(git status --porcelain -- "${paths[@]}") ]]; then
  echo 'Commit the budget browser source before installation.' >&2
  exit 1
fi
if ! test -x /usr/bin/mitmdump || ! test -x /usr/bin/openssl || ! /usr/bin/python3 -c 'import websockets' 2>/dev/null; then
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq mitmproxy python3-websockets openssl
fi
# Browser discovery is shared with the runtime; do not install Ubuntu's snap
# shim when this host already has a working Chrome installation.
find_browser() {
  /usr/bin/python3 -c "import runpy; print(runpy.run_path('deploy/cloud-browser/budget-browser.py')['browser_binary']())"
}
if ! find_browser >/dev/null 2>&1; then
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq chromium
fi
find_browser
for binary in /usr/bin/mitmdump /usr/bin/openssl; do
  test -x "$binary"
done
root="/srv/kenan/toolchains/budget-browser-$commit"
install -d -m755 "$root"
for file in budget-browser.py request-budget.py; do
  if [[ -e "$root/$file" ]] && ! cmp -s "deploy/cloud-browser/$file" "$root/$file"; then
    echo 'An immutable budget browser build differs from its source.' >&2
    exit 1
  fi
  install -m644 "deploy/cloud-browser/$file" "$root/$file"
done
chmod 755 "$root/budget-browser.py"
printf '%s\n' "$commit" > "$root/SOURCE_COMMIT"
ln -sfn "$root/budget-browser.py" /usr/local/bin/budget-browser
printf 'Installed budget-browser from %s at %s. Existing browsers are unchanged.\n' "$commit" "$root"
