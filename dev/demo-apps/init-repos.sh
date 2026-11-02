#!/usr/bin/env bash
# (Re)create the local demo Git repositories served by dev/git-server.mjs.
# Runs inside the devbox: docker exec dokploy-devbox /workspace/dev/demo-apps/init-repos.sh
set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)"
REPOS="$SRC/.repos"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

mkdir -p "$REPOS"
for app in a-healthy b-wrong-port c-crash-loop d-missing-env e-outdated f-compose g-localhost-bind; do
	rm -rf "${REPOS:?}/$app.git" "$WORK/$app"
	cp -R "$SRC/$app" "$WORK/$app"
	git -C "$WORK/$app" init -q -b main
	git -C "$WORK/$app" add -A
	git -C "$WORK/$app" -c user.name="Dokploy Demo" -c user.email="demo@dokploy.test" commit -q -m "$app: initial version"
	git clone -q --bare "$WORK/$app" "$REPOS/$app.git"
	echo "$app -> http://127.0.0.1:4040/$app.git ($(git -C "$REPOS/$app.git" rev-parse --short HEAD))"
done
