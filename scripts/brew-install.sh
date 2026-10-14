#!/bin/bash
# Installs Homebrew formulas and records in .zoltar-installed the ones that were not installed before
# (including dependencies), so the uninstaller removes exactly what Zoltar added and nothing else.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

record() { grep -qxF "$1" .zoltar-installed 2>/dev/null || echo "$1" >>.zoltar-installed; }

before=$(brew list --formula -1 | sort)
rc=0
brew install "$@" || rc=$?
# Recorded even when the install failed partway, so dependencies it already added can still be uninstalled.
comm -13 <(echo "$before") <(brew list --formula -1 | sort) | while read -r formula; do
  record "brew $formula"
done
exit "$rc"
