#!/bin/bash
# Regression: the research remotes' size cap lets regenerated files (model inventory, the solver's measure/STATUS.md)
# and the card files through up to 256 MiB, and still refuses any other file over 32 MiB, including a STATUS.md somewhere else.
# Needs no root and touches only its own scratch folder.
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
T=$(mktemp -d /var/tmp/size-cap-test.XXXXXX); trap 'rm -rf -- "$T"' EXIT
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@x GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@x
git init -q --bare -b main "$T/r.git"; ln -s "$here/size-cap" "$T/r.git/hooks/pre-receive"
git clone -q "$T/r.git" "$T/w" 2>/dev/null; cd "$T/w" && git commit -q --allow-empty -m base && git push -q origin HEAD:main
failed=0
push_of() { # push_of accepted|refused PATH: a new 40 MiB file at PATH
  mkdir -p "$(dirname "$2")"; head -c $((40 << 20)) /dev/urandom >"$2"; git add "$2"; git commit -q -m "$2"
  if git push -q origin HEAD:main 2>"$T/err"; then got=accepted; else got=refused; git reset -q --hard HEAD~1; fi
  if [[ $got == "$1" ]]; then echo "ok   $got a 40 MiB $2"; else echo "FAIL $got a 40 MiB $2"; sed 's/^/    /' "$T/err"; failed=1; fi
}
push_of accepted compiler/symbolic-search/measure/STATUS.md
push_of accepted research/receiver-relative/engineering/hardware/model/inventory/matrix/5090.json
push_of accepted compiler/symbolic-search/model/cards/h100.card.json
push_of accepted research/receiver-relative/engineering/hardware/model/cards/h100.structure.json
push_of refused measure/raw.bin
push_of refused compiler/symbolic-search/model/cards-raw/h100.bin
push_of refused sub/measure/STATUS.md
push_of refused measure/STATUS.md.bak
# A merge pushed with its branch: the generated file's path is found through the merge's diffs, so it keeps its 256 MiB limit.
git checkout -q -b side; mkdir -p research/receiver-relative/engineering/hardware/model/inventory/matrix
head -c $((40 << 20)) /dev/urandom >research/receiver-relative/engineering/hardware/model/inventory/matrix/b200.json
git add -A; git commit -q -m side; git checkout -q main 2>/dev/null || git checkout -q -; git commit -q --allow-empty -m other
git merge -q --no-edit side
if git push -q origin HEAD:main 2>"$T/err"; then echo "ok   accepted a merge carrying a 40 MiB generated file"; else echo "FAIL refused a merge carrying a 40 MiB generated file"; sed 's/^/    /' "$T/err"; failed=1; fi
exit $failed
