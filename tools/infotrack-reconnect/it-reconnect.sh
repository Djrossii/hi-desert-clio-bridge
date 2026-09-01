#!/bin/bash
# it-reconnect.sh - complete the InfoTrack<->Clio OAuth reconnect with physical clicks.
# Runs on the Mac mini only. See README.md in this folder.
#
# Usage:
#   ./it-reconnect.sh              run the reconnect flow
#   ./it-reconnect.sh --dry-run    report what it sees, click nothing
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ "$(uname)" != "Darwin" ]]; then
  echo "This tool posts macOS CGEvents and must run on the Mac mini, not a server." >&2
  exit 64
fi

exec osascript -l JavaScript "$DIR/it-reconnect.js" "$@"
