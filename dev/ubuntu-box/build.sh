#!/usr/bin/env bash
# Builds the fork's image from the working tree as dokploy-fork:test, with
# the .env.production files that CI copies from the example
# (.github/workflows/fork-image.yml). They are removed afterwards.
set -euo pipefail
cd "$(dirname "$0")/../.."
created=()
for target in .env.production apps/dokploy/.env.production; do
	if [ ! -e "$target" ]; then
		cp apps/dokploy/.env.production.example "$target"
		created+=("$target")
	fi
done
cleanup() { [ ${#created[@]} -eq 0 ] || rm -f "${created[@]}"; }
trap cleanup EXIT
docker build -t dokploy-fork:test .
