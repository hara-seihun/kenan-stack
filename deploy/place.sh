# Host files that parallel deploys both write are replaced by rename, never written in place, so two deploys placing
# the same file at once both succeed (uutils install fails one with "Already exists"). POSIX sh, sourced.
# place MODE SOURCE TARGET   copy SOURCE to TARGET with MODE
place() {
	place_tmp=$(mktemp "$(dirname "$3")/.$(basename "$3").XXXXXX") || return 1
	cp "$2" "$place_tmp" && chmod "$1" "$place_tmp" && mv -fT "$place_tmp" "$3" || { rm -f "$place_tmp"; return 1; }
}
# place_link TARGET LINK     point symlink LINK at TARGET
place_link() {
	place_tmp=$(mktemp -u "$(dirname "$2")/.$(basename "$2").XXXXXX") || return 1
	ln -s "$1" "$place_tmp" && mv -fT "$place_tmp" "$2" || { rm -f "$place_tmp"; return 1; }
}
# place_tree DIRECTORY MODE SOURCE...   create DIRECTORY holding SOURCE files once; a concurrent creator's copy is kept
place_tree() {
	place_dir=$1 place_mode=$2; shift 2
	mkdir -p "$(dirname "$place_dir")"
	place_tmp=$(mktemp -d "$(dirname "$place_dir")/.$(basename "$place_dir").XXXXXX") || return 1
	chmod 755 "$place_tmp"
	for place_source in "$@"; do cp "$place_source" "$place_tmp/" && chmod "$place_mode" "$place_tmp/$(basename "$place_source")" || { rm -rf "$place_tmp"; return 1; }; done
	mv -T "$place_tmp" "$place_dir" 2>/dev/null || rm -rf "$place_tmp"
	[ -d "$place_dir" ]
}
# place_unit MODE SOURCE TARGET   place a systemd unit only when its content or mode differs, and then set units_changed=1:
# a daemon-reload blocks the whole system manager for ~3 s on assistant-host (2026-10-31: 74 reloads an hour, most from deploys
# that changed no unit, stalled every agent's tool scope behind them), so callers reload only when something changed.
place_unit() {
	if [ -f "$3" ] && cmp -s "$2" "$3" && [ "$(stat -c %a "$3")" = "$(printf %o $((0$1)))" ]; then return 0; fi
	place "$@" && units_changed=1
}
# enable_units [--now] UNIT...   enable (and with --now start) units; `systemctl enable` reloads the manager even when the unit
# is already enabled, so it runs only for units that aren't.
enable_units() {
	enable_now=
	if [ "$1" = --now ]; then enable_now=1; shift; fi
	for enable_unit in "$@"; do
		systemctl is-enabled --quiet "$enable_unit" 2>/dev/null || systemctl enable "$enable_unit"
		[ -z "$enable_now" ] || systemctl start "$enable_unit"
	done
}
