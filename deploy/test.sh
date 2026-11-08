#!/bin/bash
# npm test runs Vitest directly; the caller's unit or host slot owns its CPU and memory budget.
set -euo pipefail
script=$(realpath "${BASH_SOURCE[0]}")
cd "$(dirname "$script")/.."
# Foreground behavior checks execute the same native runner as the server. Build
# that dependency here so a fresh source checkout needs no full app build first.
mkdir -p dist/server/tools
runner=$(mktemp dist/server/tools/.foreground-runner.XXXXXX)
trap 'rm -f "$runner"' EXIT
cc -O2 -Wall -Wextra -Werror server/tools/foreground-runner.c -ljson-c -lsystemd -o "$runner"
mv "$runner" dist/server/tools/foreground-runner
trap - EXIT
exec node node_modules/vitest/vitest.mjs run "$@"
