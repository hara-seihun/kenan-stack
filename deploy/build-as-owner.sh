# Sourced by deploy/deploy.sh and deploy/detach.sh. Runs deploy/prepare-build.sh as the checkout's owner and prints the
# build path. A KENAN_BUILD_CACHE the caller sets (Acme points it at a qualified, pre-seeded cache) must survive
# every hop between deploy.sh and prepare-build.sh: the sudo re-exec as root, the detached systemd-run unit and the sudo
# to the owner each start from a clean environment, so each hands it over explicitly, and only when it is set; unset
# keeps prepare-build.sh's cache in the build owner's account home (regression: deploy/build-as-owner.test.ts).

# Succeeds when KENAN_BUILD_CACHE is unset or absolute; an empty or relative value is a typed refusal.
build_cache_checked() {
 [[ ! -v KENAN_BUILD_CACHE || $KENAN_BUILD_CACHE == /* ]] && return 0
 echo "build_cache_not_absolute: KENAN_BUILD_CACHE=$KENAN_BUILD_CACHE" >&2
 return 64
}

build_as_owner() {
 local owner=$1 checkout=$2 commit=$3
 build_cache_checked || return
 local -a pass=()
 [[ -v KENAN_BUILD_CACHE ]] && pass=(KENAN_BUILD_CACHE="$KENAN_BUILD_CACHE")
 # Passed through env rather than --preserve-env so it needs no SETENV grant in sudoers.
 sudo -u "$owner" -H env "${pass[@]}" bash "$checkout/deploy/prepare-build.sh" "$checkout" "$commit"
}
