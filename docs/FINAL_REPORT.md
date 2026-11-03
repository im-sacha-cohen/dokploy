# Fork summary — Smart Deploy + native MCP

State as of 2026-11-02, branch `feat/smart-deploy-mcp`: local commits only, **nothing has been pushed**.

## Success criteria from the brief

| Criterion | Status | Evidence |
|---|---|---|
| Dokploy starts locally on the Mac | ✅ | Docker-in-Docker devbox (`scripts/dev-start.sh`), Docker Desktop untouched; full restart validated |
| Access to the web interface | ✅ | http://localhost:3000, test account (`dev/.env`) |
| Deploy a test application | ✅ | demo apps A–G; Deploy Latest from the assistant (browser) |
| Identify the commit actually running | ✅ | "Current deployment" card: commit proven by the exact image; scenario E 22/22 |
| Diagnose a port error | ✅ | B: `PORT_MISMATCH` (domain 80, listening on 3000), fix applied in 1 click after confirmation: 502 → 200 |
| Diagnose a crashing container | ✅ | C: `CONTAINER_CRASH_LOOP` with exit code and logs |
| Understand why a deployment fails | ✅ | D: missing variables named from the logs; G: listening on localhost; `BUILD_FAILED` with the error lines |
| Deployment timeline | ✅ | 6 observed steps (build → reachable), live in the UI and via `dokploy_get_deployment_status` |
| Enable an MCP server | ✅ | Settings › AI Integrations (owner/admin), connection test 4/4 |
| Connect a compatible MCP client | ⚠️ partial | scripted spec-compliant client (protocol 2026-07-28 and 2025-06-18), 36/36. **No real third-party client tested**: the command for Claude Code is provided, but changing your Claude Code configuration and logging in through the browser is up to you |
| Authenticate via OAuth | ✅ | Authorization Code + PKCE, RFC 9728/8414 discovery, resume after login |
| Review and accept permissions | ✅ | consent page tested in the browser; checkboxes actually enforced |
| An agent lists my authorized projects | ✅ | `dokploy_list_projects` = exactly what the UI shows the same user (27/27 isolation) |
| An agent diagnoses a deployment | ✅ | `dokploy_diagnose_deployment` |
| An agent cannot deploy without permission | ✅ | 403 `insufficient_scope` without `mcp:deploy`; refused on non-granted apps, even with the scope |
| Revoke an agent's access | ✅ | immediate revocation, a still-valid token is refused (tested twice) |
| Essential non-regression tests | ✅ with a caveat | 1661 tests passed; the only failures (4) are `backup-files` timeouts under load, already present before the fork, which pass when run alone (see `TESTING.md`) |

## What was delivered

| Phase | Commit | Content |
|---|---|---|
| 1–2 | `4402bf3` | audit, devbox, demo apps |
| 3 | `4865da3` | deterministic diagnostics engine |
| 4 | `ad13de3` | version tracking, step-by-step verification, distinct redeploy/rollback/restart |
| 5 | `b42b08b` | Smart Deploy tab: preflight, timeline, confirmed fixes |
| 6 | `a5ba6c5` | MCP server, OAuth 2.1 on better-auth, consent, AI Integrations |
| 7 | Phase 7 | permission and isolation tests, stability, summary |

Documentation: `ARCHITECTURE_AUDIT`, `LOCAL_DEVELOPMENT`, `DEPLOYMENT_DIAGNOSTICS`, `SMART_DEPLOY_ENGINE`, `MCP_ARCHITECTURE`, `MCP_SECURITY`, `TESTING`, `IMPLEMENTATION_PROGRESS`.

## Re-running all the tests

```bash
./scripts/dev-start.sh
./scripts/dev-test.sh            # full Vitest suite (~7 min)
dev/phase7/run-all.sh            # diagnostics A–G, version E, isolation, OAuth+MCP
```

## Known limitations (consolidated)

**Deployment engine and diagnostics**
- **Compose** (app F) and **previews**: not diagnosed or tracked; they keep upstream behavior.
- **Images without `cat`** (distroless): listening sockets can't be read; the diagnosis falls back to `EXPOSE`, with medium confidence.
- **Multi-node Swarm**: partial facts when the task runs on another node, flagged in the report.
- **Rebuilding a specific commit**: not available. Rebuild rebuilds the latest clone; to go back to a version, use Redeploy or Rollback (5 images kept, no registry).
- **SHA pushed by webhook**: not used; the requested commit is the branch head read at trigger time.
- **Diagnostic reports**: not persisted, recomputed on demand.

**MCP and OAuth**
- **Client ID Metadata Documents**: not supported, dynamic registration (RFC 7591) is used.
- **Registered clients that were never authorized**: no automatic purge.
- **In-memory rate limiting**: to be replaced by shared storage when running multiple instances.
- **Tokens**: no DPoP, refresh token not bound to the device.
- **Remote client** (claude.ai): needs a public HTTPS tunnel, not set up without your approval.
- **Dokploy Cloud**: MCP deployment actions are refused.

**Language**
- Everything is in English, like Dokploy (which removed its i18n): interface, server-generated findings, docs and dev tooling.

**Found in upstream, not fixed**
- At startup, the setup tries to recreate Traefik and fails on an existing Swarm DNS entry (`dokploy-traefik-previous`). Traefik stays in service.
- Flaky `backup-files` tests under load (5 s timeout).

## Decisions that are yours to make

1. **Push** the branch to your fork `im-sacha-cohen/dokploy` (public): nothing has been pushed.
2. **Temporary HTTPS tunnel** to test claude.ai or a real remote client.
3. **Propose upstream** or keep the fork: the license of the `/proprietary` folders is untouched, but the MCP audit log is kept separate from Dokploy's audit for that reason.
