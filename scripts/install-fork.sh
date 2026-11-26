#!/usr/bin/env bash
# Installs this Dokploy fork (Smart Deploy + MCP server) on a Linux server.
#
#   curl -sSL https://raw.githubusercontent.com/im-sacha-cohen/dokploy/feat/smart-deploy-mcp/scripts/install-fork.sh \
#     | sudo bash -s -- --domain panel.example.com
#
# - No Dokploy yet: runs the official installer first, then switches to the fork.
# - Dokploy already installed (official or this fork): backs up its database
#   and /etc/dokploy, then switches the `dokploy` service to the image. If the
#   new image does not start, the service goes back to what ran before.
# Options:
#   --domain <host>   public HTTPS host of the panel, for /mcp at https://<host>/mcp
#                     (default: the panel domain set in Settings › Web Server)
#   --image <ref>     image to run (default: ghcr.io/im-sacha-cohen/dokploy:smart-deploy)
#   --rollback        go back to the official image recorded before the first switch
# Environment: DOKPLOY_FORK_WAIT_TRIES (default 90) health checks, 5 s apart.
set -euo pipefail

IMAGE="ghcr.io/im-sacha-cohen/dokploy:smart-deploy"
SCRIPT_URL="https://raw.githubusercontent.com/im-sacha-cohen/dokploy/feat/smart-deploy-mcp/scripts/install-fork.sh"
DOMAIN=""
ROLLBACK=0
STATE_DIR=/root/dokploy-fork
WAIT_TRIES="${DOKPLOY_FORK_WAIT_TRIES:-90}"
PREVIOUS_FILE="$STATE_DIR/previous-image"
PREVIOUS_TAG_FILE="$STATE_DIR/previous-release-tag"

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

service_env() {
	docker service inspect dokploy --format '{{range .Spec.TaskTemplate.ContainerSpec.Env}}{{println .}}{{end}}' 2>/dev/null |
		sed -n "s/^$1=//p" | head -1
}

# Restores the official image and what it had in RELEASE_TAG (canary installs
# set it), and drops the variables this script added.
switch_back() {
	local args=(--image "$1" --env-rm DOKPLOY_MCP_RESOURCE_URL --env-rm DOKPLOY_IMAGE)
	local tag
	tag="$(cat "$PREVIOUS_TAG_FILE" 2>/dev/null || true)"
	if [ -n "$tag" ]; then
		args+=(--env-add "RELEASE_TAG=$tag")
	else
		args+=(--env-rm RELEASE_TAG)
	fi
	docker service update "${args[@]}" dokploy >/dev/null
}

is_healthy() {
	log "Waiting for Dokploy to answer on port 3000 (migrations run at startup)…"
	for _ in $(seq 1 "$WAIT_TRIES"); do
		if curl -fs http://127.0.0.1:3000/api/trpc/settings.health >/dev/null 2>&1; then
			log "Dokploy is up."
			return 0
		fi
		sleep 5
	done
	return 1
}

wait_healthy() {
	is_healthy || fail "Dokploy did not answer after $((WAIT_TRIES * 5 / 60)) minutes. Check: docker service logs dokploy --tail 100"
}

# Swarm keeps the spec that ran before the last update (image and variables):
# going back to it restores exactly the Dokploy that was working, fork or not.
undo_update() {
	if [ "$(service_image)" = "$CURRENT" ]; then
		return 0
	fi
	docker service rollback dokploy >/dev/null
}

mkdir -p "$STATE_DIR"

if [ "$ROLLBACK" = "1" ]; then
	[ -s "$PREVIOUS_FILE" ] || fail "No recorded previous image in $PREVIOUS_FILE."
	PREVIOUS="$(cat "$PREVIOUS_FILE")"
	log "Rolling back to $PREVIOUS"
	switch_back "$PREVIOUS"
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

# Keep the first official image as the --rollback target across re-runs. A
# fork is recognised by DOKPLOY_IMAGE (set by this script) or, for servers
# switched before that variable existed, by its GHCR name.
if [ -z "$(service_env DOKPLOY_IMAGE)" ]; then
	case "$CURRENT" in
		"$IMAGE"* | ghcr.io/*) ;;
		*)
			printf '%s\n' "$CURRENT" >"$PREVIOUS_FILE"
			service_env RELEASE_TAG >"$PREVIOUS_TAG_FILE"
			;;
	esac
fi
log "Current image: $CURRENT"

STAMP="$(date +%Y%m%d-%H%M%S)"
PG="$(docker ps -qf name=dokploy-postgres | head -1)"
if [ -n "$PG" ]; then
	log "Backing up the Dokploy database to $STATE_DIR/dokploy-$STAMP.sql"
	docker exec "$PG" pg_dump -U dokploy dokploy >"$STATE_DIR/dokploy-$STAMP.sql" ||
		fail "The database backup failed: nothing was changed."
	[ -s "$STATE_DIR/dokploy-$STAMP.sql" ] || fail "The database backup is empty: nothing was changed."
fi
if [ -d /etc/dokploy ]; then
	tar czf "$STATE_DIR/etc-dokploy-$STAMP.tgz" -C / etc/dokploy 2>/dev/null || true
fi

log "Pulling $IMAGE"
docker pull "$IMAGE" >/dev/null || fail "Cannot pull $IMAGE. If the package is private, run 'docker login ghcr.io' first."

# The panel's Update button follows DOKPLOY_IMAGE:RELEASE_TAG, so it updates
# to the latest build of this fork instead of the official image.
IMAGE_NAME="${IMAGE%%@*}"
case "${IMAGE_NAME##*/}" in
	*:*) IMAGE_REPO="${IMAGE_NAME%:*}"; IMAGE_TAG="${IMAGE_NAME##*:}" ;;
	*) IMAGE_REPO="$IMAGE_NAME"; IMAGE_TAG="latest" ;;
esac
UPDATE_ARGS=(--image "$IMAGE" --env-add "DOKPLOY_IMAGE=$IMAGE_REPO" --env-add "RELEASE_TAG=$IMAGE_TAG")
if [ -n "$DOMAIN" ]; then
	UPDATE_ARGS+=(--env-add "DOKPLOY_MCP_RESOURCE_URL=https://$DOMAIN/mcp")
fi
log "Switching the dokploy service to $IMAGE"
if ! docker service update "${UPDATE_ARGS[@]}" dokploy >/dev/null || ! is_healthy; then
	log "The new image did not start. Last logs:"
	docker service logs dokploy --tail 40 2>&1 | tail -40 || true
	log "Going back to the image that ran before: $CURRENT"
	undo_update || log "Automatic rollback failed: docker service rollback dokploy"
	if is_healthy; then
		fail "Update aborted: Dokploy runs $CURRENT again. Database backup: $STATE_DIR"
	fi
	fail "Update aborted and Dokploy does not answer. Database backup: $STATE_DIR. See docs/UPDATING.md."
fi

log "Done. Dokploy runs $IMAGE."
if [ -n "$DOMAIN" ]; then
	log "MCP endpoint: https://$DOMAIN/mcp"
	log "  1. Make sure the panel is served on https://$DOMAIN (Settings › Web Server › Domain)."
	log "  2. Enable it in Settings › AI Integrations, then add the URL as a connector in claude.ai."
else
	log "MCP: https://<panel domain>/mcp once the panel has a domain with HTTPS (Settings › Web Server)."
fi
log "From now on, Settings › Web Server › Update installs the latest build of $IMAGE_REPO:$IMAGE_TAG."
log "Roll back with: curl -sSL $SCRIPT_URL | sudo bash -s -- --rollback"
