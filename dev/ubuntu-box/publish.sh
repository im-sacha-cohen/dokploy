#!/usr/bin/env bash
# Publishes a build of the fork to the box's registry, as $REPO:$TAG
# (registry.test:5000/dokploy:auto), the way GHCR serves the fork's moving tag.
#   publish.sh good     the image built from this branch (dokploy-fork:test),
#                       with a fresh label so every run is a new digest
#   publish.sh broken   the same image, but the panel exits at start
#   publish.sh load     only copies dokploy-fork:test into the box
# Build the image first: dev/ubuntu-box/build.sh
set -euo pipefail
. "$(dirname "$0")/common.sh"
KIND="${1:-good}"

docker image inspect dokploy-fork:test >/dev/null 2>&1 ||
	{ echo "Build the image first: dev/ubuntu-box/build.sh" >&2; exit 1; }

host_id=$(docker image inspect dokploy-fork:test --format '{{.Id}}')
box_id=$(in_box 'docker image inspect dokploy-fork:test --format "{{.Id}}" 2>/dev/null || true')
if [ "$host_id" != "$box_id" ]; then
	log "Copying dokploy-fork:test into the box (about 1 GB)"
	docker save dokploy-fork:test | docker exec -i "$BOX" docker load >/dev/null
fi
[ "$KIND" = load ] && exit 0

stamp=$(date +%Y%m%d%H%M%S)
case "$KIND" in
	good) extra="" ;;
	broken) extra='CMD ["sh", "-c", "echo broken build; exit 1"]' ;;
	*) echo "Usage: publish.sh good|broken|load" >&2; exit 64 ;;
esac
log "Publishing a $KIND build as $REPO:$TAG"
in_box "printf 'FROM dokploy-fork:test\nLABEL org.opencontainers.image.revision=$KIND-$stamp\n$extra\n' |
	docker build -q -t $REPO:$TAG - >/dev/null && docker push -q $REPO:$TAG"
