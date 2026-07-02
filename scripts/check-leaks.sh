#!/usr/bin/env bash
set -euo pipefail

echo "Checking for orphaned Surface test processes..."
if ps -eo ppid,pid,args | awk '$1 == 1 && /server\/index\.ts|surface wait|surface stream/ { print; found=1 } END { exit found ? 1 : 0 }'; then
  echo "No orphaned Surface processes found."
else
  echo "Found orphaned Surface processes." >&2
  exit 1
fi

stale_tmp=$(find "${TMPDIR:-/tmp}" -maxdepth 1 -type d -name 'surface-*-data-*' -mmin +60 2>/dev/null | head -20 || true)
if [[ -n "$stale_tmp" ]]; then
  echo "Stale Surface tmp dirs:" >&2
  echo "$stale_tmp" >&2
  exit 1
fi
