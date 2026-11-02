#!/usr/bin/env bash
# Replays every end-to-end scenario against the LOCAL dev instance and prints
# one summary line per script. Requires the devbox (scripts/dev-start.sh).
# Usage: dev/phase7/run-all.sh
set -uo pipefail
cd "$(dirname "$0")/../.."

run() {
	local name="$1"
	shift
	local log
	log="$(mktemp)"
	if "$@" >"$log" 2>&1; then status="OK"; else status="FAILED"; fi
	printf '%-28s %-7s %s\n' "$name" "$status" "$(grep -E 'vérifications réussies' "$log" | tail -1)"
	[ "$status" = "FAILED" ] && grep -E '❌' "$log" | head -10
	rm -f "$log"
}

run "diagnostics A–G" node dev/demo-apps/diagnose.mjs
run "version E (22 points)" node dev/demo-apps/version-scenario.mjs
run "isolation setup" node dev/phase7/setup-isolation.mjs
run "permissions/isolation" node dev/phase7/isolation-tests.mjs
run "OAuth + MCP (36 points)" node dev/mcp/oauth-mcp-e2e.mjs
