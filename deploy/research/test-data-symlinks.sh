#!/bin/bash
# Regular data files still require pointers; symlinks with data-like names are just links.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
T=$(mktemp -d /var/tmp/data-symlink-test.XXXXXX); trap 'rm -rf -- "$T"' EXIT
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@x GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@x
export ResearchCo_DATA_STORE="$T/store"
git init -q --bare -b main "$T/r.git"
git --git-dir="$T/r.git" config kenan.dataStore true
ln -s "$here/size-cap" "$T/r.git/hooks/pre-receive"
git init -q -b main "$T/w"
cd "$T/w"
git remote add origin "$T/r.git"
mkdir -p nested
ln -s /external/retained-image.png nested/image.png
printf '/external/retained-image.png' >note.txt
git add -A; git commit -qm symlinks
git push -q origin HEAD:main
ResearchCo-data check-push HEAD
# The direct-hook fallback has no quarantine, but must keep exactly the same mode-aware behavior.
printf '%040d %s refs/heads/test\n' 0 "$(git rev-parse HEAD)" | "$here/size-cap"
printf 'actual image bytes' >raw.png
git add raw.png; git commit -qm raw
if git push -q origin HEAD:main 2>"$T/err"; then
  echo 'FAIL: raw regular image accepted' >&2; exit 1
fi
grep -q data_in_git "$T/err"
# A harmless text alias must not conceal the same blob at a data path.
git reset -q --hard HEAD~1
printf 'same bytes' >alias.txt
cp alias.txt alias.png
git add -A; git commit -qm aliases
if git push -q origin HEAD:main 2>"$T/err"; then
  echo 'FAIL: text alias concealed a raw regular image' >&2; exit 1
fi
grep -q data_in_git "$T/err"
echo 'ok: symlinks pass; raw regular images and text aliases are refused'
# The shared object listing still applies the ordinary size cap and generated-file exception.
git reset -q --hard HEAD~1
git --git-dir="$T/r.git" config kenan.dataStore false
truncate -s $((33 << 20)) oversized.txt
git add oversized.txt; git commit -qm oversized
if git push -q origin HEAD:main 2>"$T/err"; then
  echo 'FAIL: oversized regular file accepted' >&2; exit 1
fi
grep -q research_push_too_large "$T/err"
git reset -q --hard HEAD~1
mkdir -p compiler/symbolic-search/measure
truncate -s $((33 << 20)) compiler/symbolic-search/measure/STATUS.md
git add -A; git commit -qm generated
git push -q origin HEAD:main
echo 'ok: size cap and generated-file exception are preserved'
