#!/usr/bin/env bash
# Stop the devbox. All data (inner Docker, Postgres, deployed apps) is kept.
. "$(dirname "$0")/dev-common.sh"

require_docker
dc stop
echo "Devbox stopped. Data volumes are preserved; restart with scripts/dev-start.sh"
