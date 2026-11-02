#!/usr/bin/env bash
# Remove the devbox AND its volumes (inner Docker data, Postgres, node_modules...).
# Only volumes of the "dokploy-dev" compose project are touched.
. "$(dirname "$0")/dev-common.sh"

require_docker

echo "This will permanently delete these volumes:"
docker volume ls -q --filter label=com.docker.compose.project=dokploy-dev | sed 's/^/  - /'
echo

if [ "${1:-}" != "--yes" ]; then
	read -r -p "Type 'delete' to confirm: " answer
	if [ "$answer" != "delete" ]; then
		echo "Aborted, nothing deleted."
		exit 1
	fi
fi

dc down --volumes --remove-orphans
echo "Devbox and its volumes removed."
