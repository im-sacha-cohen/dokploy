#!/usr/bin/env bash
# Push a second commit (VERSION=v2) to the e-outdated demo repo, so the remote
# branch moves ahead of what is currently deployed.
set -euo pipefail

REPO="$(cd "$(dirname "$0")" && pwd)/.repos/e-outdated.git"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

git clone -q "$REPO" "$WORK/e"
next="v$(($(sed 's/^v//' "$WORK/e/VERSION") + 1))"
echo "$next" >"$WORK/e/VERSION"
git -C "$WORK/e" -c user.name="Dokploy Demo" -c user.email="demo@dokploy.test" commit -q -am "e-outdated: bump to $next"
git -C "$WORK/e" push -q origin main
echo "e-outdated now at $next ($(git -C "$REPO" rev-parse --short main))"
