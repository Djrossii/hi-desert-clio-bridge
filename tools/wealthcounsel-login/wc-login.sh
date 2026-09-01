#!/bin/bash
# wc-login.sh - WealthCounsel login via physical clicks (Chrome autofill workaround).
# Runs on the Mac mini only. See README.md in this folder for one-time setup.
#
# Usage:
#   ./wc-login.sh              log in to member.wealthcounsel.com
#   ./wc-login.sh --dry-run    probe the page, report what it found, click nothing
#   ./wc-login.sh <url>        same procedure against another login-first site
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ "$(uname)" != "Darwin" ]]; then
  echo "This tool posts macOS CGEvents and must run on the Mac mini, not a server." >&2
  exit 64
fi

exec osascript -l JavaScript "$DIR/wc-autofill-login.js" "$@"
