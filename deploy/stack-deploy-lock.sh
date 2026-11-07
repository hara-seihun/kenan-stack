# Shared by manual deployments and the automatic bundle service, after detaching from the app.
stack_deploy_lock() {
 local lock=/run/lock/kenan-stack-deploy.lock
 # The automatic service holds descriptor 8 through both channel deployments. An open descriptor alone is not a lock.
 local major minor inode lock_key
 if [[ ${KENAN_STACK_LOCK_PID:-} =~ ^[0-9]+$ ]] && [[ -e /proc/$KENAN_STACK_LOCK_PID/fd/8 ]] && \
    [[ $(stat -Lc '%d:%i' /proc/$KENAN_STACK_LOCK_PID/fd/8) == $(stat -Lc '%d:%i' "$lock") ]]; then
  read -r major minor inode < <(stat -Lc '%Hd %Ld %i' "$lock")
  printf -v lock_key '%02x:%02x:%s' "$major" "$minor" "$inode"
  # flock(1) records its short-lived child PID, not the shell's. fdinfo identifies the actual locked descriptor.
  if awk -v key="$lock_key" \
     '$1 == "lock:" && $3 == "FLOCK" && $5 == "WRITE" && $7 == key { held=1 } END { exit !held }' \
     "/proc/$KENAN_STACK_LOCK_PID/fdinfo/8"; then return; fi
 fi
 exec 8>"$lock"
 flock 8
 export KENAN_STACK_LOCK_PID=$$
}
