#!/usr/bin/env bash
# A throwaway "server" to test the fork for real: Ubuntu 24.04 in a
# privileged container with its own Docker daemon and Swarm, the official
# Dokploy installer, and an HTTPS registry (registry.test:5000) that both the
# box's Docker and the panel can reach. On this machine:
#   panel    http://localhost:3200
#   Traefik  http://localhost:8090, https://localhost:8453
# Next: dev/ubuntu-box/publish.sh, then dev/ubuntu-box/switch.sh.
# Remove everything with dev/ubuntu-box/down.sh.
set -euo pipefail
. "$(dirname "$0")/common.sh"

if docker inspect "$BOX" >/dev/null 2>&1; then
	echo "$BOX already exists. Remove it first with dev/ubuntu-box/down.sh." >&2
	exit 1
fi

log "Starting Ubuntu 24.04 ($BOX)"
# /var/lib/docker on a volume: the box's dockerd cannot use overlayfs on top
# of the container's own overlay root.
docker run -d --privileged --cgroupns=private --name "$BOX" --hostname "$BOX" \
	-p 127.0.0.1:3200:3000 -p 127.0.0.1:8090:80 -p 127.0.0.1:8453:443 \
	-v "$BOX-docker:/var/lib/docker" \
	ubuntu:24.04 sleep infinity >/dev/null

log "Installing Docker"
in_box 'apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq curl ca-certificates openssl iproute2 >/dev/null'
in_box 'curl -fsSL https://get.docker.com | sh >/tmp/get-docker.log 2>&1 || { tail -20 /tmp/get-docker.log; exit 1; }'
start_dockerd

log "Starting the test registry (registry.test:5000, self-signed HTTPS)"
in_box '
set -e
mkdir -p /opt/registry/certs /etc/docker/certs.d/registry.test:5000 /etc/dokploy
openssl req -x509 -newkey rsa:2048 -nodes -days 30 -subj "/CN=registry.test" \
	-addext "subjectAltName=DNS:registry.test" \
	-keyout /opt/registry/certs/key.pem -out /opt/registry/certs/cert.pem 2>/dev/null
cp /opt/registry/certs/cert.pem /etc/docker/certs.d/registry.test:5000/ca.crt
cp /opt/registry/certs/cert.pem /etc/dokploy/test-registry-ca.crt
docker run -d --restart always --name test-registry -p 5000:5000 \
	-v /opt/registry/certs:/certs \
	-e REGISTRY_HTTP_TLS_CERTIFICATE=/certs/cert.pem -e REGISTRY_HTTP_TLS_KEY=/certs/key.pem \
	registry:2 >/dev/null
'
add_registry_host

log "Running the official Dokploy installer"
# It refuses to run in a container only because of this file.
in_box 'rm -f /.dockerenv && curl -sSL https://dokploy.com/install.sh | sh'

log "Done. Create the admin account on http://localhost:3200, then run dev/ubuntu-box/publish.sh."
