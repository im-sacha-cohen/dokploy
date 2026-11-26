#!/usr/bin/env bash
# Switches the box's Dokploy to the fork published by publish.sh, with
# scripts/install-fork.sh like a real server. The panel is first told how to
# reach registry.test and to trust its certificate, for its update checks.
set -euo pipefail
. "$(dirname "$0")/common.sh"
cd "$(dirname "$0")/../.."

start_dockerd
add_registry_host
ip=$(in_box 'cat /etc/dokploy/test-box-ip')
log "Letting the panel reach registry.test ($ip) and trust its certificate"
in_box "docker service update --detach --host-add registry.test:$ip \
	--env-add NODE_EXTRA_CA_CERTS=/etc/dokploy/test-registry-ca.crt dokploy >/dev/null"

docker cp scripts/install-fork.sh "$BOX:/root/install-fork.sh"
log "Running install-fork.sh --image $REPO:$TAG (MCP on panel.box.test)"
in_box "bash /root/install-fork.sh --image $REPO:$TAG --domain ${DOKPLOY_TEST_DOMAIN:-panel.box.test}"
