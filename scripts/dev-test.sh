#!/usr/bin/env bash
# Run the test suite inside the devbox (Linux, Node 24, inner Docker).
# Usage: scripts/dev-test.sh [vitest args...]   e.g. scripts/dev-test.sh smart-deploy
. "$(dirname "$0")/dev-common.sh"

require_docker
if ! devbox_running; then
	echo "Devbox is not running. Start it with scripts/dev-start.sh" >&2
	exit 1
fi

docker exec -e FORCE_COLOR=1 -e GIT_TERMINAL_PROMPT=0 -w /workspace dokploy-devbox pnpm --filter=dokploy exec vitest run --config __test__/vitest.config.ts "$@"
