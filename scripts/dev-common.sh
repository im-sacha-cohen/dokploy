#!/usr/bin/env bash
# Shared helpers for scripts/dev-*.sh (sourced, not executed).
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="$ROOT_DIR/docker-compose.dev.yml"
ENV_FILE="$ROOT_DIR/dev/.env"

if [ -f "$ENV_FILE" ]; then
	set -a
	# shellcheck disable=SC1090
	. "$ENV_FILE"
	set +a
fi

DOKPLOY_DEV_UI_PORT="${DOKPLOY_DEV_UI_PORT:-3000}"
DOKPLOY_DEV_HTTP_PORT="${DOKPLOY_DEV_HTTP_PORT:-8880}"
DOKPLOY_DEV_HTTPS_PORT="${DOKPLOY_DEV_HTTPS_PORT:-8443}"

dc() {
	docker compose -f "$COMPOSE_FILE" "$@"
}

require_docker() {
	if ! docker info >/dev/null 2>&1; then
		echo "Docker is not reachable. Start Docker Desktop (or your Docker engine) first." >&2
		exit 1
	fi
}

devbox_running() {
	[ "$(docker inspect -f '{{.State.Running}}' dokploy-devbox 2>/dev/null || echo false)" = "true" ]
}
