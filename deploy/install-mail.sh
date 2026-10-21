#!/bin/sh
# Installs the host mail CLIs from deploy/mail as content-addressed releases and selects them.
#   deploy/install-mail.sh install   copy mail-send and mail-search (each with mail_identity.py) into
#                                    /usr/local/lib/kenan/TOOL/SHA256 and point /usr/local/bin/TOOL at it
#   deploy/install-mail.sh current   print the selected releases
# Rollback: sudo ln -sfn /usr/local/lib/kenan/TOOL/OLDSHA/TOOL /usr/local/bin/TOOL (older releases are kept).
set -eu
source_dir=$(dirname "$(realpath "$0")")/mail
lib=/usr/local/lib/kenan
. "$(dirname "$(realpath "$0")")/place.sh"
[ "$(id -u)" = 0 ] || exec sudo -n sh "$(realpath "$0")" "$@"

case "${1:-}" in
install)
	for tool in mail-send mail-search; do
		hash=$(cat "$source_dir/$tool" "$source_dir/mail_identity.py" | sha256sum | cut -c1-64)
		release="$lib/$tool/$hash"
		[ -x "$release/$tool" ] || place_tree "$release" 755 "$source_dir/$tool" "$source_dir/mail_identity.py"
		place_link "$release/$tool" "/usr/local/bin/$tool"
		echo "selected $release/$tool"
	done
	;;
current)
	for tool in mail-send mail-search; do readlink "/usr/local/bin/$tool"; done
	;;
*)
	sed -n '2,6p' "$0" >&2
	exit 2
	;;
esac
