#!/usr/bin/env bash
# Real test of scripts/install-fork.sh in a throwaway Docker-in-Docker Swarm.
# A fake "official" Dokploy (a small HTTP server answering the health URL on
# port 3000) and a real Postgres named dokploy-postgres stand in for a server.
# Fork builds come from a local registry: "good" serves the health URL,
# "broken" crashes at start.
#   1. official -> good fork: switched, variables set, database backed up
#   2. good fork -> broken build: refused, back on the good fork (not on the
#      official image), its variables intact
#   3. --rollback: back on the official image, the script's variables removed
# Usage, on a machine with Docker: bash dev/install/install-fork-e2e.sh
# The container is removed at the end.
set -euo pipefail
cd "$(dirname "$0")/../.."
NAME=install-fork-e2e
docker rm -f "$NAME" >/dev/null 2>&1 || true
trap 'docker rm -f "$NAME" >/dev/null 2>&1 || true' EXIT

docker run -d --privileged --name "$NAME" \
	-v "$PWD/scripts/install-fork.sh:/install-fork.sh:ro" docker:27-dind >/dev/null
in_box() { docker exec "$NAME" sh -c "$1"; }
for _ in $(seq 1 30); do in_box "docker info >/dev/null 2>&1" && break; sleep 2; done

in_box '
set -e
apk add --no-cache bash curl >/dev/null
docker swarm init >/dev/null
docker run -d --name registry -p 127.0.0.1:5000:5000 registry:2 >/dev/null
for i in python:3.12-alpine python:3.13-alpine busybox:1.37 postgres:16-alpine; do docker pull -q "$i" >/dev/null; done
docker tag python:3.13-alpine localhost:5000/fork:good && docker push -q localhost:5000/fork:good >/dev/null
docker tag busybox:1.37 localhost:5000/fork:broken && docker push -q localhost:5000/fork:broken >/dev/null
docker run -d --name dokploy-postgres -e POSTGRES_USER=dokploy -e POSTGRES_PASSWORD=x \
	-e POSTGRES_DB=dokploy postgres:16-alpine >/dev/null
docker service create -d --name dokploy --publish published=3000,target=3000,mode=host \
	--update-monitor 5s python:3.12-alpine \
	sh -c "mkdir -p /w/api/trpc && echo ok >/w/api/trpc/settings.health && cd /w && exec python -m http.server 3000" >/dev/null
for _ in $(seq 1 60); do curl -fs http://127.0.0.1:3000/api/trpc/settings.health >/dev/null && break; sleep 2; done
docker exec $(docker ps -qf name=dokploy-postgres) psql -U dokploy -d dokploy -c "create table marker(v text); insert into marker values (chr(107)||chr(101)||chr(112)||chr(116));" >/dev/null
'

fails=0
check() {
	if [ "$2" = "$3" ]; then echo "PASS  $1 ($3)"; else echo "FAIL  $1: expected '$2', got '$3'"; fails=$((fails + 1)); fi
}
image() { in_box "docker service inspect dokploy --format '{{.Spec.TaskTemplate.ContainerSpec.Image}}'" | cut -d@ -f1; }
env_of() { in_box "docker service inspect dokploy --format '{{range .Spec.TaskTemplate.ContainerSpec.Env}}{{println .}}{{end}}'" | sed -n "s/^$1=//p"; }
run_script() { in_box "cd /root && DOKPLOY_FORK_WAIT_TRIES=8 bash /install-fork.sh $1 >/tmp/out.txt 2>&1; echo \$?"; }

echo "== 1. official -> good fork"
check "script succeeds" 0 "$(run_script '--image localhost:5000/fork:good --domain panel.example.com')"
check "service runs the fork" "localhost:5000/fork:good" "$(image)"
check "DOKPLOY_IMAGE" "localhost:5000/fork" "$(env_of DOKPLOY_IMAGE)"
check "RELEASE_TAG" "good" "$(env_of RELEASE_TAG)"
check "MCP resource URL" "https://panel.example.com/mcp" "$(env_of DOKPLOY_MCP_RESOURCE_URL)"
check "official image recorded for --rollback" "python:3.12-alpine" "$(in_box 'cut -d@ -f1 /root/dokploy-fork/previous-image')"
check "database backup contains the data" 1 "$(in_box 'grep -c "^kept$" /root/dokploy-fork/dokploy-*.sql | head -1')"

echo "== 2. good fork -> broken build"
check "script refuses the broken build" 1 "$(run_script '--image localhost:5000/fork:broken')"
check "back on the good fork, not the official image" "localhost:5000/fork:good" "$(image)"
check "RELEASE_TAG kept" "good" "$(env_of RELEASE_TAG)"
check "MCP resource URL kept" "https://panel.example.com/mcp" "$(env_of DOKPLOY_MCP_RESOURCE_URL)"
check "panel answers again" 0 "$(in_box 'curl -fs http://127.0.0.1:3000/api/trpc/settings.health >/dev/null; echo $?')"
check "official image still recorded" "python:3.12-alpine" "$(in_box 'cut -d@ -f1 /root/dokploy-fork/previous-image')"
check "database untouched" "kept" "$(in_box 'docker exec $(docker ps -qf name=dokploy-postgres) psql -U dokploy -d dokploy -tAc "select v from marker"')"
in_box 'grep -E "Going back|Update aborted" /tmp/out.txt' | sed 's/\x1b\[[0-9;]*m//g' | sed 's/^/      /'

echo "== 3. --rollback to the official image"
check "rollback succeeds" 0 "$(run_script '--rollback')"
check "service runs the official image" "python:3.12-alpine" "$(image)"
check "DOKPLOY_IMAGE removed" "" "$(env_of DOKPLOY_IMAGE)"
check "RELEASE_TAG removed" "" "$(env_of RELEASE_TAG)"
check "MCP resource URL removed" "" "$(env_of DOKPLOY_MCP_RESOURCE_URL)"

echo "== 4. restoring the database backup (docs/UPDATING.md)"
in_box '
PG=$(docker ps -qf name=dokploy-postgres)
docker exec "$PG" psql -U dokploy -d dokploy -c "drop table marker" >/dev/null
BACKUP=$(ls -t /root/dokploy-fork/dokploy-*.sql | head -1)
docker service scale -d dokploy=0 >/dev/null
docker exec "$PG" psql -U dokploy -d postgres -c "DROP DATABASE dokploy WITH (FORCE)" >/dev/null
docker exec "$PG" psql -U dokploy -d postgres -c "CREATE DATABASE dokploy OWNER dokploy" >/dev/null
docker exec -i "$PG" psql -U dokploy -d dokploy -v ON_ERROR_STOP=1 <"$BACKUP" >/dev/null
docker service scale -d dokploy=1 >/dev/null
'
check "data back from the backup" "kept" "$(in_box 'docker exec $(docker ps -qf name=dokploy-postgres) psql -U dokploy -d dokploy -tAc "select v from marker"')"

echo
[ "$fails" = 0 ] && echo "ALL PASSED" || { echo "$fails FAILED"; exit 1; }
