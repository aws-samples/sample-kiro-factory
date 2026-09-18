#!/usr/bin/env bash
#
# Install dependencies and build the app. Run once, then use ./run.sh.
#
# Idempotent: safe to re-run after pulling changes, and re-running is the fix for
# most "it will not start" states.
set -euo pipefail

cd "$(dirname "$0")/app"

# Node 20.19 or 22.12 is the floor, the same as package.json's "engines": the
# server runs TypeScript directly with --experimental-strip-types, which arrived
# in 22.6 and was backported to 20.19 but is in no 21.x. Checking the major alone
# admitted 20.0-20.18 and every 21.x, which sailed through this guard and then
# failed at run.sh with a flag error instead of the message below.
if ! command -v node >/dev/null 2>&1; then
  echo "node is not on your PATH. Install Node 20.19 or newer, or 22.12 or newer." >&2
  exit 1
fi

ok="$(node -p '
  const [major, minor] = process.versions.node.split(".").map(Number);
  (major === 20 && minor >= 19) || (major >= 22 && (major > 22 || minor >= 12)) ? "yes" : "no"
')"
if [ "$ok" != "yes" ]; then
  echo "node $(node -v) is not supported. This needs Node 20.19 or newer, or 22.12 or newer." >&2
  exit 1
fi

echo "==> installing dependencies"
npm install

echo "==> building"
npm run build

# Not fatal: the echo driver runs the whole machinery without it, which is the
# right way to watch how work moves without spending anything.
if ! command -v kiro-cli >/dev/null 2>&1; then
  echo
  echo "note: kiro-cli is not on your PATH, so real loops cannot run."
  echo "      Install Kiro (https://kiro.dev), or run with LOOP_DRIVER=echo."
fi

echo
echo "done. start it with ./run.sh"
