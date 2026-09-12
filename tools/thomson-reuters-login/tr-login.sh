#!/bin/bash
# tr-login.sh - Thomson Reuters (Westlaw / CoCounsel) OnePass sign-in via
# physical clicks. Runs on the Mac mini only. See README.md for setup.
#
# Usage:
#   ./tr-login.sh                 sign in to Westlaw (1.next.westlaw.com)
#   ./tr-login.sh --cocounsel     sign in to CoCounsel (same OnePass identity)
#   ./tr-login.sh --dry-run       probe the page, report the step, click nothing
#   ./tr-login.sh <url>           same procedure against another entry URL
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ "$(uname)" != "Darwin" ]]; then
  echo "This tool posts macOS CGEvents and must run on the Mac mini, not a server." >&2
  exit 64
fi

# Per westlaw-login-first / cocounsel-login-first: always the clean entry
# URL, never a saved signon URL (one-time trace tokens go stale).
ARGS=()
for a in "$@"; do
  case "$a" in
    --cocounsel) ARGS+=("https://cocounsel.thomsonreuters.com/") ;;
    --westlaw)   ARGS+=("https://1.next.westlaw.com/") ;;
    *)           ARGS+=("$a") ;;
  esac
done

exec osascript -l JavaScript "$DIR/tr-onepass-login.js" ${ARGS+"${ARGS[@]}"}
