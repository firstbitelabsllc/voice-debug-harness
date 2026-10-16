#!/bin/bash
# Claude Code cloud sessions only: install npm dependencies so lint, typecheck and tests run.
# Cloud network policy blocks browser downloads, so use the preinstalled Chromium.
# Docker is absent: database and e2e lanes stay local.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-.}"

export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  {
    echo 'export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1'
    echo 'export PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers'
  } >> "$CLAUDE_ENV_FILE"
fi

# Pre-push gates need a Takeoff install. Clone it once and point TAKEOFF_HOME
# at it; a failed clone only warns so the install still runs.
TAKEOFF_DIR="${TAKEOFF_HOME:-$HOME/Development/takeoff}"
if [ ! -x "$TAKEOFF_DIR/bin/gate" ]; then
  if [ -e "$TAKEOFF_DIR" ] && [ -n "$(ls -A "$TAKEOFF_DIR" 2>/dev/null)" ]; then
    echo "warning: $TAKEOFF_DIR exists but has no executable bin/gate; remove it or set TAKEOFF_HOME to a good checkout. Pre-push gates will refuse." >&2
  else
    git clone --depth 1 https://github.com/firstbitelabsllc/takeoff "$TAKEOFF_DIR" \
      || echo "warning: could not clone takeoff; pre-push gates will refuse" >&2
  fi
fi
if [ -x "$TAKEOFF_DIR/bin/gate" ] && [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  echo "export TAKEOFF_HOME=\"$TAKEOFF_DIR\"" >> "$CLAUDE_ENV_FILE"
fi

# SessionStart also fires on resume, clear and compact. Skip the install when
# node_modules is newer than both manifests, so `npm ci` (which deletes
# node_modules) never wipes a working tree mid-session.
if [ -f node_modules/.package-lock.json ] \
  && [ node_modules/.package-lock.json -nt package-lock.json ] \
  && [ node_modules/.package-lock.json -nt package.json ]; then
  exit 0
fi

# npm ci keeps package-lock.json untouched (npm install rewrites it).
npm ci --no-audit --no-fund
