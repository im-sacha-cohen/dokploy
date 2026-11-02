#!/usr/bin/env bash
# Build and start the isolated devbox, then wait until the Dokploy UI answers.
. "$(dirname "$0")/dev-common.sh"

require_docker

if ! devbox_running; then
	for port in "$DOKPLOY_DEV_UI_PORT" "$DOKPLOY_DEV_HTTP_PORT" "$DOKPLOY_DEV_HTTPS_PORT"; do
		if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
			echo "Port $port is already in use on this machine. Override it in dev/.env (see dev/.env.example)." >&2
			exit 1
		fi
	done
fi

dc up -d --build

echo "Waiting for Dokploy on http://localhost:$DOKPLOY_DEV_UI_PORT (first start installs dependencies, ~5-10 min)..."
timeout_s="${DEV_START_TIMEOUT:-1200}"
start=$(date +%s)
until curl -fs "http://127.0.0.1:$DOKPLOY_DEV_UI_PORT/api/health" >/dev/null 2>&1; do
	if ! devbox_running; then
		echo "The devbox stopped. Last logs:" >&2
		dc logs --tail 80 devbox >&2
		exit 1
	fi
	if [ $(($(date +%s) - start)) -gt "$timeout_s" ]; then
		echo "Timed out after ${timeout_s}s. Follow progress with: docker compose -f docker-compose.dev.yml logs -f devbox" >&2
		exit 1
	fi
	sleep 5
done

cat <<EOF
Dokploy is up.
  UI:                 http://localhost:$DOKPLOY_DEV_UI_PORT
  Apps via Traefik:   http://<app>.docker.localhost:$DOKPLOY_DEV_HTTP_PORT
  Logs:               docker compose -f docker-compose.dev.yml logs -f devbox
  Shell:              docker exec -it dokploy-devbox bash
EOF
