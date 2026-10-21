#!/bin/sh
# Installs an agent-browser build as the shared browser toolchain on this host and selects it.
#   deploy/install-browser.sh install BINARY SOURCE_COMMIT   copy BINARY into /srv/kenan/toolchains/browser-SRC8-SHA8 and select it
#   deploy/install-browser.sh select TOOLCHAIN_DIR           select an installed toolchain (rollback = select the previous one)
#   deploy/install-browser.sh current                        print the selected toolchain
# Selecting repoints every /etc/kenan/domains/*.json tools.browser and the owner's ~/.local/bin/agent-browser.
# Running daemons restart on their next command: the daemon identity includes the source commit.
set -eu
toolchains=/srv/kenan/toolchains
owner_link=/home/kenan/.local/bin/agent-browser

usage() { sed -n '2,7p' "$0" >&2; exit 2; }

select_toolchain() {
	dir=$(realpath -e "$1")
	case "$dir" in "$toolchains"/browser-*) ;; *) echo "not a browser toolchain under $toolchains: $dir" >&2; exit 1 ;; esac
	[ -x "$dir/agent-browser-linux-x64" ] || { echo "incomplete toolchain: $dir" >&2; exit 1; }
	sudo python3 - "$dir" <<'EOF'
import glob, json, os, sys
directory = sys.argv[1]
for path in sorted(glob.glob('/etc/kenan/domains/*.json')):
    with open(path) as handle:
        config = json.load(handle)
    browser = config.get('tools', {}).get('browser')
    if browser is None:
        continue
    browser['executable'] = directory + '/agent-browser-linux-x64'
    # No --config: agent-browser reads the person's ~/.agent-browser/config.json (credential plugins for auth fill).
    browser.pop('configurationPath', None)
    stat = os.stat(path)
    pending = path + '.pending'
    with open(pending, 'w') as handle:
        json.dump(config, handle, indent=2)
        handle.write('\n')
        handle.flush()
        os.fsync(handle.fileno())
    os.chown(pending, stat.st_uid, stat.st_gid)
    os.chmod(pending, stat.st_mode & 0o7777)
    os.replace(pending, path)
    print('selected', directory, 'for', path)
EOF
	ln -sfn "$dir/agent-browser-linux-x64" "$owner_link.pending"
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
