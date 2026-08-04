#!/usr/bin/env bash
set -euo pipefail

echo "Checking for orphaned Surface test processes..."
if ps -eo ppid,pid,args | awk '$1 == 1 && /server\/index\.ts|surface wait|surface stream/ { print; found=1 } END { exit found ? 1 : 0 }'; then
  echo "No orphaned Surface processes found."
else
  echo "Found orphaned Surface processes." >&2
  exit 1
fi

# Match every scratch dir the suites actually create, not just the few that
# happen to be named `<something>-data-<random>`. Measured before widening:
# the old `surface-*-data-*` pattern saw 7 of 28 prefixes (25%) — the suites
# using `surface-auth-`, `surface-updates-`, `surface-guard-` and the rest
# were invisible to it, so the orphaned-process check below was doing nearly
# all the work. `sfcx-*` covers test/codexBridge.ts, which calls mkdtempSync
# directly and does not use the `surface-` prefix at all.
stale_tmp=$(find "${TMPDIR:-/tmp}" -maxdepth 1 -type d \( -name 'surface-*' -o -name 'sfcx-*' \) -mmin +60 2>/dev/null | head -20 || true)
if [[ -n "$stale_tmp" ]]; then
  echo "Stale Surface tmp dirs:" >&2
  echo "$stale_tmp" >&2
  exit 1
fi
