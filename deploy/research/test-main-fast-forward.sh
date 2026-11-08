#!/bin/bash
# Regression: with main-fast-forward installed, a force push of main is refused, and clones taken while workers publish
# (and one keeps amending and force-pushing) all start on a commit that is in main's final history.
# Needs no root and touches only its own scratch folder.
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
T=$(mktemp -d /var/tmp/main-ff-test.XXXXXX); trap 'rm -rf -- "$T"' EXIT
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@x GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@x
git init -q --bare -b main "$T/r.git"; ln -s "$here/main-fast-forward" "$T/r.git/hooks/update"
git clone -q "$T/r.git" "$T/seed" 2>/dev/null; (cd "$T/seed" && git commit -q --allow-empty -m base && git push -q origin HEAD:main)
publisher() { git clone -q "$T/r.git" "$T/p$1" && cd "$T/p$1" && for i in 1 2 3 4 5 6; do git fetch -q origin && git reset -q --hard origin/main && git commit -q --allow-empty -m "p$1-$i" && git push -q origin HEAD:main 2>/dev/null; done; }
rewriter() { git clone -q "$T/r.git" "$T/w" && cd "$T/w" && for i in 1 2 3 4 5 6; do git fetch -q origin && git reset -q --hard origin/main && git commit -q --allow-empty -m "w$i" && git push -q origin HEAD:main 2>/dev/null; git commit -q --amend --allow-empty -m "w$i amended" && git push -q -f origin HEAD:main 2>/dev/null; done; }
for n in 1 2 3; do publisher $n & done; rewriter &
for k in $(seq 1 12); do git clone -q "$T/r.git" "$T/c$k" 2>/dev/null && git -C "$T/c$k" rev-parse HEAD >>"$T/starts"; done
wait
fail=0
while read -r s; do git -C "$T/r.git" merge-base --is-ancestor "$s" main || { echo "FAIL a clone started on $s, which is not in main's history"; fail=1; }; done <"$T/starts"
git -C "$T/w" push -q -f origin HEAD~1:main 2>"$T/err" && { echo "FAIL force push of main was accepted"; fail=1; }
grep -q main_rewrite_refused "$T/err" || { echo "FAIL force push refusal not typed"; fail=1; }
git -C "$T/w" push -q origin :main 2>"$T/err" && { echo "FAIL deleting main was accepted"; fail=1; }
git -C "$T/w" push -q origin HEAD:refs/heads/other 2>"$T/other.err" && git -C "$T/w" commit -q --amend --allow-empty -m other2 2>>"$T/other.err" && git -C "$T/w" push -q -f origin HEAD:refs/heads/other 2>>"$T/other.err" || { echo "FAIL other branches must stay rewritable"; cat "$T/other.err"; fail=1; }
(( fail )) || echo "ok   main only moves forward; $(wc -l <"$T/starts") clones during publication all started in its history"
exit $fail
