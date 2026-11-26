#!/usr/bin/env bash
# Starts the box again after Docker Desktop restarted: its dockerd (Swarm
# services come back on their own), and registry.test pointed at the box's
# new address, for the box and for the panel.
set -euo pipefail
. "$(dirname "$0")/common.sh"

docker start "$BOX" >/dev/null
start_dockerd
add_registry_host
ip=$(in_box 'cat /etc/dokploy/test-box-ip')
current=$(in_box "docker service inspect dokploy --format '{{range .Spec.TaskTemplate.ContainerSpec.Hosts}}{{println .}}{{end}}' | grep -w registry.test || true")
if [ -n "$current" ] && ! printf '%s' "$current" | grep -qw "$ip"; then
	log "registry.test moved to $ip: updating the panel (it restarts)"
	in_box "docker service update --detach --host-rm registry.test --host-add registry.test:$ip dokploy >/dev/null"
fi
log "Box up. Panel: http://localhost:3200"
