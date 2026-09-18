#!/usr/bin/env bash
#
# Build the web app and serve it. This is the everyday command.
#
# Environment worth knowing about, all optional:
#
#   PORT=4711            what to listen on
#   HOST=127.0.0.1       what to bind to. Loopback, and anything else needs
#                        KIROFACTORY_ALLOW_REMOTE=1 as well - the API has no
#                        authentication and the loops hold shell, so putting it
#                        on a network has to be said twice to count as meant.
#   BASE_DIR=<dir>       default directory for a new factory
#   REGISTRY=<file>      where the list of open factories is kept
#   LOOP_DRIVER=echo     run the machinery without calling a model
#   KIRO_CLI=<path>      a kiro-cli somewhere other than the PATH
#
# A factory's own directory is set in the app, per factory. BASE_DIR only decides
# where a new one starts out.
set -euo pipefail

cd "$(dirname "$0")/app"

if [ ! -d node_modules ]; then
  echo "dependencies are missing. Run ./setup.sh first." >&2
  exit 1
fi

# Rebuilt every time rather than only when missing: the build is seconds, and
# serving a stale bundle after an edit is a confusing way to lose an afternoon.
echo "==> building"
npm run build

echo "==> starting"
exec npm start
