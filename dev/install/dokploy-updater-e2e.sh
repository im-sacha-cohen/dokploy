#!/usr/bin/env bash
# Real test of scripts/dokploy-updater.sh in a throwaway Docker-in-Docker
# Swarm: a stand-in panel service, a real Postgres named dokploy-postgres, an
# /etc/dokploy with a Traefik stand-in bind-mounting part of it, and the
# updater started the way the panel starts it (a container of its own, with
# the Docker socket and /etc/dokploy).
# Panel builds come from a local registry. They answer the health URL unless
# stated: v1; v2 (adds a row and a table, like a migration); crash (exits at
# once); migrate-crash (changes the database and /etc/dokploy, then exits);
# flaky (answers for 20 s, then exits); mute (runs, never answers).
# Usage, on a machine with Docker: bash dev/install/dokploy-updater-e2e.sh
# The container is removed at the end.
set -euo pipefail
cd "$(dirname "$0")/../.."
NAME=dokploy-updater-e2e
docker rm -f "$NAME" >/dev/null 2>&1 || true
trap 'docker rm -f "$NAME" >/dev/null 2>&1 || true' EXIT

docker run -d --privileged --name "$NAME" \
	-v "$PWD/scripts/dokploy-updater.sh:/updater.sh:ro" docker:27-dind >/dev/null
in_box() { docker exec "$NAME" sh -c "$1"; }
for _ in $(seq 1 30); do in_box "docker info >/dev/null 2>&1" && break; sleep 2; done

echo "== setup"
in_box '
set -e
apk add --no-cache bash curl >/dev/null
docker swarm init >/dev/null
docker network create -d overlay --attachable dokploy-network >/dev/null
docker run -d --name registry -p 127.0.0.1:5000:5000 registry:2 >/dev/null
for i in python:3.12-alpine busybox:1.37 postgres:16-alpine docker:27-cli; do docker pull -q "$i" >/dev/null; done

mkdir -p /b
cat >/b/entry.sh <<"EOF"
#!/bin/sh
serve() {
	mkdir -p /w/api/trpc && echo ok >/w/api/trpc/settings.health
	python -m http.server 3000 -d /w
}
case "$ROLE" in
	v1) serve ;;
	v2)
		psql -qc "insert into marker select chr(118)||chr(50) where not exists (select 1 from marker where v = chr(118)||chr(50)); create table if not exists from_v2(x int)"
		serve
		;;
	crash) exit 1 ;;
	migrate-crash)
		psql -qc "insert into marker values (chr(98)||chr(97)||chr(100)); create table if not exists from_bad(x int)"
		echo broken >/etc/dokploy/traefik/traefik.yml
		echo added >/etc/dokploy/traefik/dynamic/added.yml
		echo new >/etc/dokploy/applications/app1/from-bad
		exit 1
		;;
	flaky)
		serve &
		sleep 20
		exit 1
		;;
	mute) exec sleep 3600 ;;
esac
EOF
cat >/b/Dockerfile <<"EOF"
FROM python:3.12-alpine
RUN apk add --no-cache postgresql-client >/dev/null
ENV PGHOST=dokploy-postgres PGUSER=dokploy PGPASSWORD=x PGDATABASE=dokploy
COPY entry.sh /entry.sh
ARG ROLE
ENV ROLE=$ROLE
CMD ["sh", "/entry.sh"]
EOF
for role in v1 v2 crash migrate-crash flaky mute; do
	docker build -q --build-arg ROLE=$role -t localhost:5000/panel:$role /b >/dev/null
	docker push -q localhost:5000/panel:$role >/dev/null
done
printf "FROM docker:27-cli\nRUN apk add --no-cache bash curl >/dev/null\n" | docker build -q -t updater-env - >/dev/null

docker run -d --name dokploy-postgres --network dokploy-network -e POSTGRES_USER=dokploy \
	-e POSTGRES_PASSWORD=x -e POSTGRES_DB=dokploy postgres:16-alpine >/dev/null
for _ in $(seq 1 30); do docker exec dokploy-postgres pg_isready -U dokploy -d dokploy >/dev/null 2>&1 && break; sleep 2; done
sleep 2
docker exec dokploy-postgres psql -q -U dokploy -d dokploy -c "create table marker(v text); insert into marker values (chr(107)||chr(101)||chr(112)||chr(116))"

mkdir -p /etc/dokploy/traefik/dynamic /etc/dokploy/applications/app1 /etc/dokploy/ssh
echo original >/etc/dokploy/traefik/traefik.yml
echo route >/etc/dokploy/traefik/dynamic/dokploy.yml
echo app >/etc/dokploy/applications/app1/code
echo key >/etc/dokploy/ssh/id
docker run -d --name traefik -v /etc/dokploy/traefik/traefik.yml:/t.yml \
	-v /etc/dokploy/traefik/dynamic:/dyn busybox:1.37 sleep 3600 >/dev/null

docker service create -d --name dokploy --network dokploy-network --env FOO=bar --label keep=yes \
	--mount type=bind,src=/etc/dokploy,dst=/etc/dokploy \
	--publish published=3000,target=3000,mode=host --update-order stop-first \
	localhost:5000/panel:v1 >/dev/null
for _ in $(seq 1 60); do curl -fs http://127.0.0.1:3000/api/trpc/settings.health >/dev/null && break; sleep 2; done
curl -fs http://127.0.0.1:3000/api/trpc/settings.health >/dev/null
'

fails=0
check() {
	if [ "$2" = "$3" ]; then echo "PASS  $1"; else echo "FAIL  $1: expected '$2', got '$3'"; fails=$((fails + 1)); fi
}
UPDATER_ENV="-e UPDATER_START_TIMEOUT=90 -e UPDATER_VERIFY_SECONDS=8 -e UPDATER_POLL=2 -e UPDATER_RESERVE_MB=10 -e UPDATER_KEEP_RUNS=3"
UPDATER_MOUNTS="-v /var/run/docker.sock:/var/run/docker.sock -v /etc/dokploy:/etc/dokploy -v /updater.sh:/app/dokploy-updater.sh:ro"
# run_updater <arguments> [extra docker run flags]: prints the exit code.
run_updater() {
	in_box "docker run --rm $UPDATER_MOUNTS $UPDATER_ENV ${2:-} updater-env bash /app/dokploy-updater.sh $1 >/tmp/out.txt 2>&1; echo \$?"
}
spec_sig() {
	in_box "docker service inspect dokploy --format '{{json .Spec.TaskTemplate.ContainerSpec}}|{{json .Spec.EndpointSpec}}|{{json .Spec.Mode}}|{{json .Spec.UpdateConfig}}|{{json .Spec.Labels}}|{{json .Spec.TaskTemplate.Networks}}'"
}
spec_digest() { in_box "docker service inspect dokploy --format '{{.Spec.TaskTemplate.ContainerSpec.Image}}'" | cut -d@ -f2; }
pushed_digest() { in_box "docker image inspect --format '{{index .RepoDigests 0}}' localhost:5000/panel:$1" | cut -d@ -f2; }
db_sig() {
	in_box "docker exec dokploy-postgres psql -U dokploy -d dokploy -tAc \"select (select string_agg(v, ',' order by v) from marker) || '|' || (select count(*) from pg_tables where tablename like 'from%')\""
}
state() { in_box "grep -o '\"$1\":\"[^\"]*\"' /etc/dokploy/updates/state.json | cut -d'\"' -f4"; }
last_run() { in_box 'ls -1 /etc/dokploy/updates/runs | sort | tail -1'; }
run_count() { in_box 'ls -1 /etc/dokploy/updates/runs | wc -l' | tr -d ' '; }
answers() { in_box 'curl -fs http://127.0.0.1:3000/api/trpc/settings.health >/dev/null; echo $?'; }
show_log() { in_box 'grep -E "state:|paused|stopped answering|No stable" /tmp/out.txt' | sed 's/^/      /' || true; }

echo "== 1. v1 -> v2"
SIG_V1="$(spec_sig)"
check "update succeeds" 0 "$(run_updater '--target localhost:5000/panel:v2')"
check "service runs v2, pinned to the digest pulled" "$(pushed_digest v2)" "$(spec_digest)"
check "variables kept" 1 "$(in_box "docker service inspect dokploy --format '{{range .Spec.TaskTemplate.ContainerSpec.Env}}{{println .}}{{end}}' | grep -c '^FOO=bar$'")"
check "state succeeded" succeeded "$(state status)"
check "v2 migrated the database" "kept,v2|1" "$(db_sig)"
RUN1="$(last_run)"
check "the backup holds the data from before" 1 "$(in_box "grep -c '^kept$' /etc/dokploy/updates/runs/$RUN1/dokploy.sql")"
check "the backup leaves out application files" 0 "$(in_box "tar tzf /etc/dokploy/updates/runs/$RUN1/etc.tgz | grep -c applications; true")"
check "same image again: nothing to do" 0 "$(run_updater '--target localhost:5000/panel:v2')"
check "same image again: no new run" 1 "$(run_count)"

echo "== 2. v2 -> migrate-crash (changes the database and /etc/dokploy, then exits)"
SIG_V2="$(spec_sig)"
DB_V2="$(db_sig)"
check "update refused and put back" 2 "$(run_updater '--target localhost:5000/panel:migrate-crash')"
show_log
check "exact v2 spec back" "$SIG_V2" "$(spec_sig)"
check "database back as before" "$DB_V2" "$(db_sig)"
check "state rolled_back" rolled_back "$(state status)"
check "Traefik sees the restored traefik.yml" original "$(in_box 'docker exec traefik cat /t.yml')"
check "file added in a bind-mounted directory removed" 1 "$(in_box 'docker exec traefik test -e /dyn/added.yml; echo $?')"
check "application files left alone" new "$(in_box 'cat /etc/dokploy/applications/app1/from-bad')"
check "panel answers" 0 "$(answers)"

echo "== 3. v2 -> crash"
check "update refused and put back" 2 "$(run_updater '--target localhost:5000/panel:crash')"
check "exact v2 spec back" "$SIG_V2" "$(spec_sig)"
check "panel answers" 0 "$(answers)"

echo "== 4. v2 -> flaky (answers 20 s, then exits)"
check "update refused and put back" 2 "$(run_updater '--target localhost:5000/panel:flaky' '-e UPDATER_VERIFY_SECONDS=35')"
show_log
check "exact v2 spec back" "$SIG_V2" "$(spec_sig)"
check "database back as before" "$DB_V2" "$(db_sig)"

echo "== 5. refused before any change"
in_box 'docker stop dokploy-postgres >/dev/null'
check "no database: refused" 1 "$(run_updater '--target localhost:5000/panel:v1')"
check "state aborted" aborted "$(state status)"
check "service untouched" "$SIG_V2" "$(spec_sig)"
in_box 'docker start dokploy-postgres >/dev/null; for _ in $(seq 1 30); do docker exec dokploy-postgres pg_isready -U dokploy -d dokploy >/dev/null 2>&1 && break; sleep 2; done; sleep 2'
check "not enough disk space: refused" 1 "$(run_updater '--target localhost:5000/panel:v1' '-e UPDATER_RESERVE_MB=100000000')"
check "service untouched" "$SIG_V2" "$(spec_sig)"

echo "== 6. second updater refused, updater killed mid-way, --resume"
in_box "docker run -d --rm --name stuck-updater $UPDATER_MOUNTS $UPDATER_ENV -e UPDATER_START_TIMEOUT=600 updater-env bash /app/dokploy-updater.sh --target localhost:5000/panel:mute >/dev/null"
for _ in $(seq 1 60); do [ "$(state status)" = verifying ] && break; sleep 2; done
check "first updater is verifying" verifying "$(state status)"
check "second updater refused while the first runs" 4 "$(run_updater '--target localhost:5000/panel:v1')"
in_box 'docker kill stuck-updater >/dev/null'
sleep 2
check "state left as it was" verifying "$(state status)"
check "--resume puts back" 2 "$(run_updater '--resume')"
check "exact v2 spec back" "$SIG_V2" "$(spec_sig)"
check "database back as before" "$DB_V2" "$(db_sig)"
check "state rolled_back" rolled_back "$(state status)"
check "--resume again: nothing to do" 0 "$(run_updater '--resume')"

echo "== 7. --rollback to the state before run 1"
in_box "docker exec dokploy-postgres psql -q -U dokploy -d dokploy -c \"insert into marker values ('after')\""
check "rollback succeeds" 0 "$(run_updater "--rollback $RUN1")"
show_log
check "exact v1 spec back" "$SIG_V1" "$(spec_sig)"
check "database as before run 1" "kept|0" "$(db_sig)"
check "state succeeded" succeeded "$(state status)"
check "run kind" rollback "$(state kind)"
check "panel answers" 0 "$(answers)"
check "only the last 3 runs kept" 3 "$(run_count)"

echo
[ "$fails" = 0 ] && echo "ALL PASSED" || { echo "$fails FAILED"; exit 1; }
