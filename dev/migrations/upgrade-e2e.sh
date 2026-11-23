#!/usr/bin/env bash
# Upgrade test of the database migrations after merging upstream releases.
# Three starting points, each in a throwaway Postgres, then the migrations of
# the working tree:
#   fork      the fork before the merge (old numbering 0199-0201), like a
#             server that already runs the fork
#   official  upstream Dokploy, like a server switching from the official image
#   empty     a fresh install
# All three must end with the same schema, and a second run must be a no-op.
# Usage, inside the devbox: bash dev/migrations/upgrade-e2e.sh [fork-ref] [official-ref]
set -euo pipefail
cd /workspace
FORK_REF="${1:-pre-merge-v0.31.4}"
OFFICIAL_REF="${2:-v0.31.4}"
PG_IMAGE=postgres:16 # as packages/server/src/setup/postgres-setup.ts
WORK=$(mktemp -d)
NODE_PATH_DIR=/workspace/apps/dokploy
fails=0
pass() { echo "PASS  $*"; }
fail() { echo "FAIL  $*"; fails=$((fails + 1)); }

folder_at() { # ref -> extracted migrations folder
	local dir="$WORK/$1"
	mkdir -p "$dir"
	git archive "$1" apps/dokploy/drizzle | tar -x -C "$dir"
	echo "$dir/apps/dokploy/drizzle"
}
migrate() { (cd "$NODE_PATH_DIR" && node /workspace/dev/migrations/migrate.mjs "$1" "$2" >/dev/null); }
psql_in() { docker exec "$1" psql -U dokploy -d dokploy -tAc "$2"; }

start_pg() {
	docker run -d --rm --name "$1" -e POSTGRES_USER=dokploy -e POSTGRES_PASSWORD=dokploy \
		-e POSTGRES_DB=dokploy -p "127.0.0.1:$2:5432" "$PG_IMAGE" >/dev/null
	for _ in $(seq 1 60); do
		docker exec "$1" pg_isready -U dokploy -d dokploy >/dev/null 2>&1 && sleep 1 && return 0
		sleep 1
	done
	return 1
}

echo "Postgres image: $PG_IMAGE"
FORK_DIR=$(folder_at "$FORK_REF")
OFFICIAL_DIR=$(folder_at "$OFFICIAL_REF")
CURRENT_DIR=/workspace/apps/dokploy/drizzle

port=55431
for state in fork official empty; do
	port=$((port + 1))
	name="mig-$state"
	docker rm -f "$name" >/dev/null 2>&1 || true
	start_pg "$name" "$port"
	url="postgres://dokploy:dokploy@127.0.0.1:$port/dokploy"
	case "$state" in
		fork) migrate "$url" "$FORK_DIR" ;;
		official) migrate "$url" "$OFFICIAL_DIR" ;;
	esac
	before=$(psql_in "$name" "select count(*) from drizzle.__drizzle_migrations" 2>/dev/null || echo 0)
	if migrate "$url" "$CURRENT_DIR"; then
		pass "$state: migrations of the working tree apply (had $before)"
	else
		fail "$state: migrations of the working tree fail"
		continue
	fi
	count=$(psql_in "$name" "select count(*) from drizzle.__drizzle_migrations")
	migrate "$url" "$CURRENT_DIR"
	again=$(psql_in "$name" "select count(*) from drizzle.__drizzle_migrations")
	[ "$count" = "$again" ] && pass "$state: second run is a no-op ($count rows)" || fail "$state: second run applied more ($count -> $again)"
	for check in \
		"select 1 from information_schema.tables where table_name='mcp_settings'" \
		"select 1 from information_schema.tables where table_name='oauth_client'" \
		"select 1 from information_schema.tables where table_name='domain_dns_record'" \
		"select 1 from information_schema.columns where table_name='deployment' and column_name='verification'" \
		"select 1 from information_schema.tables where table_name='sandbox'" \
		"select 1 from information_schema.columns where table_name='user' and column_name='onboardingStep'" \
		"select 1 from information_schema.columns where table_name='application' and column_name='previewForwardAuthEnabled'"; do
		[ "$(psql_in "$name" "$check")" = "1" ] || fail "$state: missing object ($check)"
	done
	docker exec "$name" pg_dump -U dokploy -d dokploy --schema-only --schema=public \
		| grep -v '^--' | grep -v '^$' | grep -v '^\\' | grep -v 'pg_dump\|SET \|SELECT pg_catalog' | sort >"$WORK/$state.schema"
	pass "$state: fork and upstream objects checked"
done

for state in fork official; do
	if diff -q "$WORK/empty.schema" "$WORK/$state.schema" >/dev/null; then
		pass "$state ends with exactly the schema of a fresh install"
	else
		fail "$state schema differs from a fresh install:"
		diff "$WORK/empty.schema" "$WORK/$state.schema" | head -20
	fi
done

for state in fork official empty; do docker rm -f "mig-$state" >/dev/null 2>&1 || true; done
rm -rf "$WORK"
echo
[ "$fails" = 0 ] && echo "ALL PASSED" || { echo "$fails FAILED"; exit 1; }
