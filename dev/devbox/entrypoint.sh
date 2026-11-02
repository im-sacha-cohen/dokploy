#!/usr/bin/env bash
set -euo pipefail

log() { echo "[devbox] $*"; }

start_dockerd() {
	# The container filesystem survives `docker restart`: stale PID files make
	# dockerd believe containerd is still running ("timeout waiting for containerd").
	rm -f /var/run/docker.pid /var/run/docker/containerd/containerd.pid
	# cgroup v2 nesting: move our processes out of the root cgroup so dockerd
	# can enable controllers for its children (same trick as moby's hack/dind).
	if [ -f /sys/fs/cgroup/cgroup.controllers ]; then
		mkdir -p /sys/fs/cgroup/init
		xargs -rn1 </sys/fs/cgroup/cgroup.procs >/sys/fs/cgroup/init/cgroup.procs 2>/dev/null || :
		sed -e 's/ / +/g' -e 's/^/+/' </sys/fs/cgroup/cgroup.controllers \
			>/sys/fs/cgroup/cgroup.subtree_control 2>/dev/null || :
	fi
	if ! mountpoint -q /sys/kernel/security 2>/dev/null; then
		mount -t securityfs none /sys/kernel/security 2>/dev/null || :
	fi

	rm -f /var/run/docker.pid
	log "starting inner Docker daemon"
	dockerd --host=unix:///var/run/docker.sock >/var/log/dockerd.log 2>&1 &

	for _ in $(seq 1 60); do
		if docker info >/dev/null 2>&1; then
			log "inner Docker daemon ready ($(docker version --format '{{.Server.Version}}'))"
			return 0
		fi
		sleep 1
	done
	log "inner Docker daemon failed to start, last log lines:"
	tail -n 50 /var/log/dockerd.log
	exit 1
}

install_dependencies() {
	local stamp=/workspace/node_modules/.devbox-lock-hash
	local current
	current=$(sha256sum /workspace/pnpm-lock.yaml | cut -d' ' -f1)
	if [ -f "$stamp" ] && [ "$(cat "$stamp")" = "$current" ]; then
		log "dependencies up to date"
		return 0
	fi
	log "installing dependencies (pnpm install --frozen-lockfile)"
	pnpm install --frozen-lockfile
	echo "$current" >"$stamp"
}

bootstrap_dokploy() {
	cd /workspace
	if [ ! -f apps/dokploy/.env ]; then
		cp apps/dokploy/.env.example apps/dokploy/.env
		log "created apps/dokploy/.env from .env.example"
	fi
	install_dependencies
	pnpm run server:script
	# Idempotent: swarm init, dokploy-network, Traefik, Postgres, migrations.
	pnpm run dokploy:setup
}

start_demo_git_server() {
	if [ -d /workspace/dev/demo-apps/.repos ]; then
		# Own session (setsid): a later step of the startup signals the
		# entrypoint's process group, which silently killed a plain `&` job.
		setsid sh -c 'while true; do
			node /workspace/dev/git-server.mjs
			echo "[devbox] demo git server exited with code $?, restarting in 2s"
			sleep 2
		done' >>/var/log/demo-git-server.log 2>&1 </dev/null &
		log "demo Git server on http://127.0.0.1:4040"
	fi
}

start_dockerd
start_demo_git_server

if [ "${DEVBOX_AUTOSTART:-1}" != "1" ]; then
	log "DEVBOX_AUTOSTART=0: Dokploy not started, container kept alive"
	exec sleep infinity
fi

bootstrap_dokploy
log "starting Dokploy dev server on :3000"
exec pnpm run dokploy:dev
