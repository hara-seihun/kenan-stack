#!/bin/bash
# Shared by source builds, deploys and standalone native-helper installation.
# Install missing native tools on Debian/Ubuntu; --check only reports what is missing.
set -euo pipefail
exec 1>&2
mode=${1:-install}
[[ $mode == install || $mode == --check ]] || { echo 'Usage: deploy/install-build-deps.sh [--check]' >&2; exit 64; }
missing=()
add() { [[ " ${missing[*]} " == *" $1 "* ]] || missing+=("$1"); }
scan() {
 missing=()
 for tool in cc c++ make; do command -v "$tool" >/dev/null || add build-essential; done
 command -v python3 >/dev/null || add python3
 command -v git >/dev/null || add git
 command -v pkg-config >/dev/null || add pkg-config
 [[ -r /usr/include/node/node_api.h ]] || add libnode-dev
 if ! command -v pkg-config >/dev/null || ! pkg-config --exists json-c; then add libjson-c-dev; fi
 if ! command -v pkg-config >/dev/null || ! pkg-config --exists libsystemd; then add libsystemd-dev; fi
 # A compiler executable alone is not enough: link against libc as well.
 if command -v cc >/dev/null && ! printf '#include <stdio.h>\nint main(void) { return puts("") < 0; }\n' | cc -x c - -o /dev/null >/dev/null 2>&1; then add build-essential; fi
}
scan
if (( ${#missing[@]} )); then
 echo "build_dependencies_missing: ${missing[*]}"
 debian=false
 if [[ -r /etc/os-release ]]; then
  . /etc/os-release
  case " ${ID:-} ${ID_LIKE:-} " in *' debian '*|*' ubuntu '*) debian=true;; esac
 fi
 if [[ $mode == --check ]] || ! $debian || ! command -v apt-get >/dev/null; then
  echo "Install these build dependencies before npm ci or npm run build: ${missing[*]}. On Debian/Ubuntu: sudo bash deploy/install-build-deps.sh"
  exit 22
 fi
 root=()
 if (( EUID != 0 )); then
  if ! command -v sudo >/dev/null || ! sudo -n true 2>/dev/null; then
   echo "build_dependencies_need_root: run sudo bash deploy/install-build-deps.sh to install ${missing[*]}"
   exit 22
  fi
  root=(sudo -n)
 fi
 # Fresh images may have no package lists. Keep all apt output off prepare-build's path stdout.
 "${root[@]}" env DEBIAN_FRONTEND=noninteractive apt-get update -qq
 # Match systemd's installed library, including when it came from backports.
 systemd_version=$(dpkg-query -W -f='${Version}' "libsystemd0:$(dpkg --print-architecture)" 2>/dev/null || true)
 if [[ -n $systemd_version ]]; then
  for i in "${!missing[@]}"; do
   if [[ ${missing[$i]} == libsystemd-dev ]]; then missing[$i]="libsystemd-dev=$systemd_version"; fi
  done
 fi
 if ! "${root[@]}" env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "${missing[@]}"; then
  echo "build_dependencies_install_failed: required Debian/Ubuntu packages: ${missing[*]}"
  exit 22
 fi
 scan
 if (( ${#missing[@]} )); then echo "build_dependencies_unavailable_after_install: ${missing[*]}"; exit 22; fi
fi
# Check the actual headers and link libraries, not just package installation records.
printf '#include <json-c/json.h>\n#include <systemd/sd-bus.h>\n#include <node_api.h>\nint main(void) { napi_env env = 0; (void)env; json_object_put(0); sd_bus_unref(0); return 0; }\n' |
 cc -x c - -I/usr/include/node $(pkg-config --cflags --libs json-c libsystemd) -o /dev/null || {
  echo 'build_dependencies_unusable: check build-essential, libjson-c-dev, libsystemd-dev and libnode-dev compiler headers and libraries'
  exit 22
 }
if ! command -v node >/dev/null || ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)' || ! command -v npm >/dev/null; then
 echo 'build_dependencies_node: install Node.js >=24 with npm, then rerun. The distribution Node.js package may be older; existing Node installations are never replaced.'
 exit 22
fi
