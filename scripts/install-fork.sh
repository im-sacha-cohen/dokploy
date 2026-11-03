#!/usr/bin/env bash
# Installs this Dokploy fork (Smart Deploy + MCP server) on a Linux server.
#
#   curl -sSL https://raw.githubusercontent.com/im-sacha-cohen/dokploy/feat/smart-deploy-mcp/scripts/install-fork.sh \
#     | sudo bash -s -- --domain panel.example.com
#
# - No Dokploy yet: runs the official installer first, then switches to the fork.
# - Dokploy already installed: backs up its database and /etc/dokploy, records
#   the current image for rollback, then switches the `dokploy` service.
# Options:
#   --domain <host>   public HTTPS host of the panel; enables /mcp at https://<host>/mcp
#   --image <ref>     image to run (default: ghcr.io/im-sacha-cohen/dokploy:smart-deploy)
#   --rollback        go back to the image recorded before the switch
set -euo pipefail

IMAGE="ghcr.io/im-sacha-cohen/dokploy:smart-deploy"
SCRIPT_URL="https://raw.githubusercontent.com/im-sacha-cohen/dokploy/feat/smart-deploy-mcp/scripts/install-fork.sh"
DOMAIN=""
ROLLBACK=0
STATE_DIR=/root/dokploy-fork
PREVIOUS_FILE="$STATE_DIR/previous-image"

log() { printf '\033[1;34m[dokploy-fork]\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m[dokploy-fork]\033[0m %s\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
	case "$1" in
		--domain) DOMAIN="${2:-}"; shift 2 ;;
		--image) IMAGE="${2:-}"; shift 2 ;;
		--rollback) ROLLBACK=1; shift ;;
		-h | --help)
			echo "Usage: install-fork.sh [--domain panel.example.com] [--image <ref>] [--rollback]"
			exit 0
			;;
		*) fail "Unknown option: $1" ;;
	esac
done

[ "$(id -u)" = "0" ] || fail "Run as root (sudo)."
if [ -n "$DOMAIN" ] && ! printf '%s' "$DOMAIN" | grep -Eq '^[A-Za-z0-9.-]+\.[A-Za-z]{2,}$'; then
	fail "--domain expects a host name such as panel.example.com (no https://, no path)."
fi

service_image() {
	docker service inspect dokploy --format '{{.Spec.TaskTemplate.ContainerSpec.Image}}' 2>/dev/null || true
}

wait_healthy() {
	log "Waiting for Dokploy to answer on port 3000 (migrations run at startup)…"
	for _ in $(seq 1 90); do
		if curl -fs http://127.0.0.1:3000/api/trpc/settings.health >/dev/null 2>&1; then
			log "Dokploy is up."
			return 0
		fi
		sleep 5
	done
	fail "Dokploy did not answer after 7 minutes. Check: docker service logs dokploy --tail 100"
}

mkdir -p "$STATE_DIR"

if [ "$ROLLBACK" = "1" ]; then
	[ -s "$PREVIOUS_FILE" ] || fail "No recorded previous image in $PREVIOUS_FILE."
	PREVIOUS="$(cat "$PREVIOUS_FILE")"
	log "Rolling back to $PREVIOUS"
	docker service update --image "$PREVIOUS" --env-rm DOKPLOY_MCP_RESOURCE_URL dokploy >/dev/null
	wait_healthy
	log "Rolled back. Database backups are in $STATE_DIR."
	exit 0
fi

ARCH="$(uname -m)"
case "$ARCH" in
	x86_64 | aarch64 | arm64) ;;
	*) fail "Unsupported architecture: $ARCH (amd64 or arm64 only)." ;;
esac

if ! command -v docker >/dev/null 2>&1 || [ -z "$(service_image)" ]; then
	log "Dokploy is not installed: running the official installer first."
	curl -sSL https://dokploy.com/install.sh | sh
	wait_healthy
fi

CURRENT="$(service_image)"
[ -n "$CURRENT" ] || fail "The dokploy service was not found after installation."

# Keep the first official image as the rollback target across re-runs.
case "$CURRENT" in
	"$IMAGE"* | ghcr.io/*) ;;
	*) printf '%s\n' "$CURRENT" >"$PREVIOUS_FILE" ;;
esac
log "Current image: $CURRENT"

STAMP="$(date +%Y%m%d-%H%M%S)"
PG="$(docker ps -qf name=dokploy-postgres | head -1)"
if [ -n "$PG" ]; then
	log "Backing up the Dokploy database to $STATE_DIR/dokploy-$STAMP.sql"
	docker exec "$PG" pg_dump -U dokploy dokploy >"$STATE_DIR/dokploy-$STAMP.sql"
fi
if [ -d /etc/dokploy ]; then
	tar czf "$STATE_DIR/etc-dokploy-$STAMP.tgz" -C / etc/dokploy 2>/dev/null || true
fi

log "Pulling $IMAGE"
docker pull "$IMAGE" >/dev/null || fail "Cannot pull $IMAGE. If the package is private, run 'docker login ghcr.io' first."

UPDATE_ARGS=(--image "$IMAGE")
if [ -n "$DOMAIN" ]; then
	UPDATE_ARGS+=(--env-add "DOKPLOY_MCP_RESOURCE_URL=https://$DOMAIN/mcp")
fi
log "Switching the dokploy service to the fork"
docker service update "${UPDATE_ARGS[@]}" dokploy >/dev/null
wait_healthy

log "Done. Dokploy runs $IMAGE."
if [ -n "$DOMAIN" ]; then
	log "MCP endpoint: https://$DOMAIN/mcp"
	log "  1. Make sure the panel is served on https://$DOMAIN (Settings › Web Server › Domain)."
	log "  2. Enable it in Settings › AI Integrations, then add the URL as a connector in claude.ai."
else
	log "MCP is off until you set the panel's HTTPS domain and re-run with --domain <host>."
fi
log "Do not use the built-in Update button: it would reinstall the official image."
log "Roll back with: curl -sSL $SCRIPT_URL | sudo bash -s -- --rollback"
