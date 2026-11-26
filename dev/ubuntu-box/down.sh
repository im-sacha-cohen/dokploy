#!/usr/bin/env bash
# Removes the test box and its Docker data.
set -euo pipefail
. "$(dirname "$0")/common.sh"
docker rm -f "$BOX" >/dev/null 2>&1 || true
docker volume rm "$BOX-docker" >/dev/null 2>&1 || true
log "Removed $BOX"
