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
