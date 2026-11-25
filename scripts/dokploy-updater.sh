#!/usr/bin/env bash
# Updates the `dokploy` Swarm service to another image. If the new version
# does not stay healthy, puts back exactly what ran before: the service spec
# (image digest, variables, mounts, ports), the panel database and the
# configuration in /etc/dokploy.
#
# It runs in a one-shot container started from the image that works now, so
# it outlives the panel it replaces:
#   docker run -d --rm --name dokploy-updater \
#     -v /var/run/docker.sock:/var/run/docker.sock -v /etc/dokploy:/etc/dokploy \
#     <current image> bash /app/dokploy-updater.sh --target <image>
#
# Modes:
#   --target <image>  update; a tag is pinned to the digest it points to now
#   --resume          after a run cut short (server restart, killed updater):
#                     put back what ran before that run
#   --rollback <run>  go back to the state saved before a past successful run;
#                     changes made in the panel since then are lost
# Option: --run-id <id> (default: a UTC timestamp and a random number)
#
# Exit codes: 0 done or nothing to do, 1 refused before any change, 2 failed
# and everything was put back, 3 putting back failed (see the run log),
# 4 another updater is running, 64 usage.
#
# Progress goes to /etc/dokploy/updates/state.json (one JSON line, rewritten
# atomically at each step) and to runs/<run>/updater.log.
set -euo pipefail

ETC="${DOKPLOY_ETC:-/etc/dokploy}"
UPDATES="$ETC/updates"
DOCKER_SOCK="${DOCKER_SOCK:-/var/run/docker.sock}"
START_TIMEOUT="${UPDATER_START_TIMEOUT:-600}"
VERIFY_SECONDS="${UPDATER_VERIFY_SECONDS:-300}"
POLL="${UPDATER_POLL:-5}"
RESERVE_MB="${UPDATER_RESERVE_MB:-500}"
KEEP_RUNS="${UPDATER_KEEP_RUNS:-5}"
SERVICE=dokploy
HEALTH_PATH=:3000/api/trpc/settings.health
# Content, not configuration: large, and never changed by a panel update.
ETC_EXCLUDED='applications|compose|logs|schedules|volume-backups|patch-repos|updates'

MODE=""
TARGET=""
SOURCE_RUN=""
RUN_ID=""
KIND=""
STATUS=""
CHANGED=false
FROM_IMAGE=""
TO_IMAGE=""
RUN_DIR=""
STARTED_AT=""

log() { printf '[updater %s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }
usage() {
	echo "Usage: dokploy-updater.sh --target <image> | --resume | --rollback <run> [--run-id <id>]" >&2
	exit 64
}
now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

while [ $# -gt 0 ]; do
	case "$1" in
		--target) MODE=update; TARGET="${2:-}"; shift 2 ;;
		--resume) MODE=resume; shift ;;
		--rollback) MODE=rollback; SOURCE_RUN="${2:-}"; shift 2 ;;
		--run-id) RUN_ID="${2:-}"; shift 2 ;;
		*) usage ;;
	esac
done
[ -n "$MODE" ] || usage
if [ "$MODE" = update ] && [ -z "$TARGET" ]; then usage; fi
if [ "$MODE" = rollback ] && [ -z "$SOURCE_RUN" ]; then usage; fi
case "$RUN_ID$SOURCE_RUN" in */* | *..*) usage ;; esac

json_escape() {
	local s="${1//\\/\\\\}"
	s="${s//\"/\\\"}"
	printf '%s' "${s//$'\n'/ }"
}

write_state() {
	STATUS="$1"
	local message
	message="$(json_escape "${2:-}")"
	printf '{"runId":"%s","kind":"%s","status":"%s","changed":%s,"fromImage":"%s","toImage":"%s","runDir":"%s","sourceRun":"%s","startedAt":"%s","updatedAt":"%s","message":"%s"}\n' \
		"$RUN_ID" "$KIND" "$STATUS" "$CHANGED" "$FROM_IMAGE" "$TO_IMAGE" "$RUN_DIR" "$SOURCE_RUN" "$STARTED_AT" "$(now)" "$message" \
		>"$UPDATES/state.json.tmp"
	mv -f "$UPDATES/state.json.tmp" "$UPDATES/state.json"
	cp "$UPDATES/state.json" "$RUN_DIR/state.json"
	log "state: $STATUS${2:+ — $2}"
}

state_field() { sed -n "s/.*\"$2\":\"\([^\"]*\)\".*/\1/p" "$1" | head -1; }

svc() { docker service inspect "$SERVICE" --format "$1" 2>/dev/null; }
spec_image() { svc '{{.Spec.TaskTemplate.ContainerSpec.Image}}'; }
digest_of() { case "$1" in *@sha256:*) printf '%s' "${1##*@}" ;; *) printf '%s' "$1" ;; esac; }
postgres_container() { docker ps -qf name=dokploy-postgres | head -1; }
service_containers() { docker ps -q --filter "label=com.docker.swarm.service.name=$SERVICE" 2>/dev/null || true; }

# Both hosts: `localhost` can resolve to ::1 only, and a server bound to
# IPv4 alone refuses it (busybox wget does not fall back to 127.0.0.1).
panel_answers() {
	local probe="" host
	for host in 127.0.0.1 localhost; do
		probe="$probe curl -fs http://$host$HEALTH_PATH >/dev/null 2>&1 || wget -q -O /dev/null http://$host$HEALTH_PATH >/dev/null 2>&1 ||"
	done
	docker exec "$1" sh -c "$probe false" >/dev/null 2>&1
}

# Succeeds once a container of the service runs $1 and answers the health
# URL for VERIFY_SECONDS without interruption (same container, every poll).
wait_stable() {
	local expected
	expected="$(digest_of "$1")"
	local check_paused="${2:-yes}"
	local deadline=$(($(date +%s) + START_TIMEOUT))
	local stable_cid="" since=0 cid image
	while [ "$(date +%s)" -lt "$deadline" ]; do
		if [ "$check_paused" = yes ] && [ "$(svc '{{if .UpdateStatus}}{{.UpdateStatus.State}}{{end}}')" = paused ]; then
			log "Swarm paused the update: a task of the new version failed."
			return 1
		fi
		cid="$(docker ps -q --filter "label=com.docker.swarm.service.name=$SERVICE" --filter status=running 2>/dev/null | head -1 || true)"
		image="$([ -n "$cid" ] && docker inspect -f '{{.Config.Image}}' "$cid" 2>/dev/null || true)"
		if [ -n "$cid" ] && [ "$(digest_of "$image")" = "$expected" ] && panel_answers "$cid"; then
			if [ "$cid" != "$stable_cid" ]; then
				stable_cid="$cid"
				since="$(date +%s)"
				log "The panel answers (container ${cid:0:12}); watching it for ${VERIFY_SECONDS}s."
			fi
			if [ $(($(date +%s) - since)) -ge "$VERIFY_SECONDS" ]; then
				return 0
			fi
		elif [ -n "$stable_cid" ]; then
			log "The panel stopped answering (container ${stable_cid:0:12})."
			stable_cid=""
		fi
		sleep "$POLL"
	done
	log "No stable answer within ${START_TIMEOUT}s."
	return 1
}

# Pins a tag to the digest the registry serves now, so the image checked is
# the image installed.
resolve_target() {
	local name="$1" repo last digest
	docker pull -q "$name" >/dev/null || return 1
	case "$name" in *@sha256:*) printf '%s' "$name"; return 0 ;; esac
	last="${name##*/}"
	case "$last" in
		*:*) repo="${name%:*}" ;;
		*) repo="$name"; name="$name:latest" ;;
	esac
	digest="$(docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$name" | sed -n "s#^$repo@##p" | head -1)"
	if [ -z "$digest" ]; then
		digest="$(docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$name" | head -1)"
		digest="${digest##*@}"
	fi
	[ -n "$digest" ] || return 1
	printf '%s@%s' "$name" "$digest"
}

etc_entries() {
	local path name
	for path in "$ETC"/* "$ETC"/.[!.]*; do
		[ -e "$path" ] || [ -L "$path" ] || continue
		name="${path##*/}"
		printf '%s\n' "$name" | grep -qxE "$ETC_EXCLUDED" || printf '%s\n' "$name"
	done
}

check_free_space() {
	local pg="$1" db_kb etc_kb=0 free_kb need_kb entry
	db_kb="$(docker exec "$pg" psql -U dokploy -d dokploy -tAc "select pg_database_size('dokploy') / 1024")" || return 1
	while read -r entry; do
		[ -n "$entry" ] || continue
		etc_kb=$((etc_kb + $(du -sk "$ETC/$entry" | cut -f1)))
	done < <(etc_entries)
	free_kb="$(df -Pk "$UPDATES" | awk 'NR == 2 { print $4 }')"
	need_kb=$((db_kb * 2 + etc_kb + RESERVE_MB * 1024))
	if [ "$free_kb" -lt "$need_kb" ]; then
		log "Not enough disk space: $((free_kb / 1024)) MB free, $((need_kb / 1024)) MB needed."
		return 1
	fi
}

# Saves everything a restore puts back into $1.
save_state_to() {
	local dir="$1" pg
	pg="$(postgres_container)"
	[ -n "$pg" ] || { log "dokploy-postgres is not running."; return 1; }
	svc '{{json .Spec}}' >"$dir/spec.json" && [ -s "$dir/spec.json" ] || { log "Cannot read the service spec."; return 1; }
	spec_image >"$dir/image"
	log "Backing up the database"
	docker exec "$pg" pg_dump -U dokploy dokploy >"$dir/dokploy.sql" || { log "pg_dump failed."; return 1; }
	tail -n 5 "$dir/dokploy.sql" | grep -q 'PostgreSQL database dump complete' || { log "The database backup is incomplete."; return 1; }
	etc_entries >"$dir/etc-entries"
	if [ -s "$dir/etc-entries" ]; then
		log "Backing up $ETC"
		local entries=()
		mapfile -t entries <"$dir/etc-entries"
		tar czf "$dir/etc.tgz" -C "$ETC" "${entries[@]}" || { log "The $ETC backup failed."; return 1; }
	fi
}

stop_service() {
	log "Stopping the panel"
	docker service scale -d "$SERVICE=0" >/dev/null || return 1
	local deadline=$(($(date +%s) + 120))
	while [ -n "$(service_containers)" ]; do
		[ "$(date +%s)" -lt "$deadline" ] || { log "The panel did not stop."; return 1; }
		sleep 2
	done
}

restore_db() {
	local dump="$1" pg
	pg="$(postgres_container)"
	[ -n "$pg" ] || { log "dokploy-postgres is not running."; return 1; }
	log "Restoring the database"
	docker exec "$pg" psql -q -U dokploy -d postgres -c "DROP DATABASE IF EXISTS dokploy WITH (FORCE)" >/dev/null &&
		docker exec "$pg" psql -q -U dokploy -d postgres -c "CREATE DATABASE dokploy OWNER dokploy" >/dev/null &&
		docker exec -i "$pg" psql -q -U dokploy -d dokploy -v ON_ERROR_STOP=1 <"$dump" >/dev/null
}

# Writes the saved files back in place instead of replacing them: Traefik
# bind-mounts traefik.yml and dynamic/, and a new inode would hide the
# restored content from it.
restore_etc() {
	local dir="$1" tmp="$1/etc-restore" entry file rel
	[ -s "$dir/etc-entries" ] || return 0
	log "Restoring $ETC"
	rm -rf "$tmp"
	mkdir -p "$tmp"
	tar xzf "$dir/etc.tgz" -C "$tmp" || return 1
	while read -r entry; do
		[ -n "$entry" ] && [ -e "$ETC/$entry" ] || continue
		while read -r file; do
			rel="${file#"$ETC"/}"
			if [ ! -e "$tmp/$rel" ] && [ ! -L "$tmp/$rel" ]; then rm -f "$file"; fi
		done < <(find "$ETC/$entry" \( -type f -o -type l \))
	done <"$dir/etc-entries"
	while read -r rel; do
		rel="${rel#./}"
		if [ -L "$tmp/$rel" ]; then
			mkdir -p "$(dirname "$ETC/$rel")"
			rm -f "$ETC/$rel"
			cp -P "$tmp/$rel" "$ETC/$rel"
		elif [ -f "$ETC/$rel" ] && [ ! -L "$ETC/$rel" ]; then
			cmp -s "$tmp/$rel" "$ETC/$rel" || cat "$tmp/$rel" >"$ETC/$rel"
		else
			mkdir -p "$(dirname "$ETC/$rel")"
			rm -f "$ETC/$rel"
			cp -p "$tmp/$rel" "$ETC/$rel"
		fi
	done < <(cd "$tmp" && find . \( -type f -o -type l \))
	rm -rf "$tmp"
}

# Through the API rather than `docker service rollback`, which only knows
# the spec before the last change and flips back and forth between the two.
restore_spec() {
	local spec="$1" id version
	id="$(svc '{{.ID}}')" && version="$(svc '{{.Version.Index}}')" || return 1
	log "Restoring the service spec"
	curl -fsS --unix-socket "$DOCKER_SOCK" -H 'Content-Type: application/json' \
		-X POST --data-binary @"$spec" "http://localhost/services/$id/update?version=$version" >/dev/null
}

# Puts the state saved in $1 back. Keeps going after a failed step, so the
# panel at least runs the saved image, and reports the failure.
restore_from() {
	local dir="$1" ok=0
	stop_service || ok=1
	restore_db "$dir/dokploy.sql" || { log "Database restore failed, retrying once."; sleep 5; restore_db "$dir/dokploy.sql" || ok=1; }
	restore_etc "$dir" || { log "Restoring $ETC failed."; ok=1; }
	restore_spec "$dir/spec.json" || { log "Restoring the service spec failed."; ok=1; }
	wait_stable "$(cat "$dir/image")" no || ok=1
	return "$ok"
}

put_back() {
	local reason="$1"
	write_state restoring "$reason"
	if restore_from "$RUN_DIR"; then
		write_state rolled_back "$reason Everything was put back as before."
		exit 2
	fi
	write_state failed "$reason Putting back failed: see $RUN_DIR/updater.log and docs/UPDATING.md."
	exit 3
}

abort() {
	write_state aborted "$1 Nothing was changed."
	exit 1
}

prune_runs() {
	local old
	ls -1 "$UPDATES/runs" | sort -r | tail -n +"$((KEEP_RUNS + 1))" | while read -r old; do
		[ -n "$old" ] && [ "$old" != "$RUN_ID" ] && rm -rf "${UPDATES:?}/runs/$old"
	done
}

start_run() {
	KIND="$1"
	RUN_ID="${RUN_ID:-$(date -u +%Y%m%dT%H%M%SZ)-$RANDOM}"
	RUN_DIR="$UPDATES/runs/$RUN_ID"
	[ ! -e "$RUN_DIR" ] || { log "Run $RUN_ID already exists."; exit 64; }
	mkdir -p "$RUN_DIR"
	exec > >(tee -a "$RUN_DIR/updater.log") 2>&1
	STARTED_AT="$(now)"
	FROM_IMAGE="$(spec_image)"
}

mkdir -p "$UPDATES/runs"
exec 9>"$UPDATES/lock"
flock -n 9 || { log "Another updater is running."; exit 4; }

svc '{{.ID}}' >/dev/null || { log "The $SERVICE service was not found."; exit 1; }

case "$MODE" in
	update)
		current="$(spec_image)"
		log "Pulling $TARGET"
		resolved="$(resolve_target "$TARGET")" || { log "Cannot pull $TARGET."; exit 1; }
		if [ "$(digest_of "$resolved")" = "$(digest_of "$current")" ]; then
			log "Dokploy already runs $resolved: nothing to do."
			exit 0
		fi
		start_run update
		TO_IMAGE="$resolved"
		log "Updating $FROM_IMAGE -> $TO_IMAGE (run $RUN_ID)"
		write_state backing_up
		pg="$(postgres_container)"
		[ -n "$pg" ] || abort "dokploy-postgres is not running."
		check_free_space "$pg" || abort "Not enough disk space for the backups."
		save_state_to "$RUN_DIR" || abort "The backup failed."

		CHANGED=true
		write_state updating
		# The updater decides when to go back; Swarm must not roll back on its own.
		if ! docker service update -d --no-resolve-image --update-failure-action pause \
			--image "$TO_IMAGE" "$SERVICE" >/dev/null; then
			put_back "docker service update failed."
		fi
		write_state verifying
		wait_stable "$TO_IMAGE" || put_back "The new version did not stay healthy."
		write_state succeeded
		prune_runs
		;;

	rollback)
		source_dir="$UPDATES/runs/$SOURCE_RUN"
		[ -f "$source_dir/state.json" ] || { log "Run $SOURCE_RUN not found."; exit 1; }
		[ "$(state_field "$source_dir/state.json" status)" = succeeded ] || { log "Run $SOURCE_RUN did not succeed: nothing to go back to."; exit 1; }
		for file in spec.json image dokploy.sql etc-entries; do
			[ -f "$source_dir/$file" ] || { log "Run $SOURCE_RUN has no $file."; exit 1; }
		done
		start_run rollback
		TO_IMAGE="$(cat "$source_dir/image")"
		log "Going back to the state before run $SOURCE_RUN: $TO_IMAGE (run $RUN_ID)"
		write_state backing_up
		pg="$(postgres_container)"
		[ -n "$pg" ] || abort "dokploy-postgres is not running."
		check_free_space "$pg" || abort "Not enough disk space for the backups."
		save_state_to "$RUN_DIR" || abort "The backup failed."

		CHANGED=true
		write_state updating
		restore_from "$source_dir" || put_back "The state before run $SOURCE_RUN did not come back healthy."
		write_state succeeded
		prune_runs
		;;

	resume)
		[ -f "$UPDATES/state.json" ] || { log "No run to resume."; exit 0; }
		RUN_ID="$(state_field "$UPDATES/state.json" runId)"
		KIND="$(state_field "$UPDATES/state.json" kind)"
		STATUS="$(state_field "$UPDATES/state.json" status)"
		FROM_IMAGE="$(state_field "$UPDATES/state.json" fromImage)"
		TO_IMAGE="$(state_field "$UPDATES/state.json" toImage)"
		SOURCE_RUN="$(state_field "$UPDATES/state.json" sourceRun)"
		STARTED_AT="$(state_field "$UPDATES/state.json" startedAt)"
		RUN_DIR="$UPDATES/runs/$RUN_ID"
		[ -d "$RUN_DIR" ] || { log "The directory of run $RUN_ID is missing."; exit 3; }
		exec > >(tee -a "$RUN_DIR/updater.log") 2>&1
		case "$STATUS" in
			backing_up) abort "The run stopped during the backup." ;;
			updating | verifying | restoring)
				CHANGED=true
				put_back "The run stopped while $STATUS."
				;;
			*) log "Run $RUN_ID is already finished ($STATUS)." ;;
		esac
		;;
esac
