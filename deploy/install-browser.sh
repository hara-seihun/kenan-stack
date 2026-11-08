#!/bin/sh
# Installs an agent-browser build as the shared browser toolchain on this host and selects it.
#   deploy/install-browser.sh install BINARY SOURCE_COMMIT   copy BINARY into /srv/kenan/toolchains/browser-SRC8-SHA8 and select it
#   deploy/install-browser.sh select TOOLCHAIN_DIR           select an installed toolchain (rollback = select the previous one)
#   deploy/install-browser.sh current                        print the selected toolchain
# Selecting updates domain and active extension configs, plus the owner's CLI and shared PATH link.
# Browser settings, sessions and unrelated tools are preserved.
# Running sessions retain their daemon across releases; close explicitly or use a new session for the installed build.
set -eu
toolchains=/srv/kenan/toolchains
owner_link=/home/kenan/.local/bin/agent-browser

usage() { sed -n '2,7p' "$0" >&2; exit 2; }

select_toolchain() {
	dir=$(realpath -e "$1")
	case "$dir" in "$toolchains"/browser-*) ;; *) echo "not a browser toolchain under $toolchains: $dir" >&2; exit 1 ;; esac
	[ -x "$dir/agent-browser-linux-x64" ] || { echo "incomplete toolchain: $dir" >&2; exit 1; }
	# Keep the native executable unchanged; all entry points register cloud command activity.
	sudo install -d -m755 /usr/local/lib/kenan/browser-use
	for file in activity.py agent-browser.py; do
		sudo install -m644 "$(dirname "$0")/cloud-browser/$file" /usr/local/lib/kenan/browser-use/
	done
	sudo install -m755 "$(dirname "$0")/cloud-browser/agent-browser" "$dir/agent-browser"
	sudo python3 "$(dirname "$0")/select-browser-config.py" "$dir" /etc/kenan
	sudo python3 - "$owner_link" <<'EOF'
import os, sys
shared_link = '/usr/local/bin/agent-browser'
pending = shared_link + '.' + str(os.getpid())
os.symlink(sys.argv[1], pending)
os.replace(pending, shared_link)
print('selected', sys.argv[1], 'for', shared_link)
EOF
	ln -sfn "$dir/agent-browser" "$owner_link.pending"
	mv -T "$owner_link.pending" "$owner_link"
	echo "selected $dir for $owner_link"
}

[ $# -ge 1 ] || usage
case "$1" in
install)
	[ $# -eq 3 ] || usage
	binary=$2 source=$3
	echo "$source" | grep -Eq '^[0-9a-f]{40}$' || { echo "SOURCE_COMMIT must be a full commit id" >&2; exit 1; }
	sha=$(sha256sum "$binary" | cut -c1-64)
	dir="$toolchains/browser-$(echo "$source" | cut -c1-8)-$(echo "$sha" | cut -c1-8)"
	if [ ! -e "$dir" ]; then
		sudo install -d -o root -g root -m 0755 "$dir.pending"
		sudo install -o root -g root -m 0755 "$binary" "$dir.pending/agent-browser-linux-x64"
		printf '%s\n%s\n' "$source" "$sha" | sudo install -o root -g root -m 0644 /dev/stdin "$dir.pending/source"
		sudo mv -T "$dir.pending" "$dir"
	fi
	[ "$(sha256sum "$dir/agent-browser-linux-x64" | cut -c1-64)" = "$sha" ] || { echo "installed binary differs: $dir" >&2; exit 1; }
	select_toolchain "$dir"
	;;
select)
	[ $# -eq 2 ] || usage
	select_toolchain "$2"
	;;
current)
	dirname "$(readlink -e "$owner_link")"
	;;
*) usage ;;
esac
