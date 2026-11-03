# Implementation log

Working branch: `feat/smart-deploy-mcp` (based on `upstream/canary` @ `46a0762`).
`upstream` remote = `Dokploy/dokploy`. Nothing has been pushed.

| Phase | Status | Deliverable |
|---|---|---|
| 1 — Audit | ✅ Done (2026-11-02) | `docs/ARCHITECTURE_AUDIT.md` |
| 2 — Local environment | ✅ Validated (2026-11-02) | `docs/LOCAL_DEVELOPMENT.md`, `docs/TESTING.md`, devbox, demo apps |
| 3 — Diagnostics | ✅ Validated (2026-11-02) | `docs/DEPLOYMENT_DIAGNOSTICS.md`, `smart-deploy/diagnostics`, `smartDeploy.diagnoseApplication` API |
| 4 — Version tracking | ✅ Validated (2026-11-02) | `docs/SMART_DEPLOY_ENGINE.md`, `smart-deploy/versioning`, migration 0199 |
| 5 — Deployment UI | ✅ Validated (2026-11-02) | Smart Deploy tab, `smart-deploy/preflight`, `smart-deploy/actions`, `docs/SMART_DEPLOY_ENGINE.md` |
| 6 — MCP server + OAuth | ✅ Validated (2026-11-02) | `/mcp`, OAuth 2.1 via better-auth, consent, Settings › AI Integrations, `docs/MCP_ARCHITECTURE.md`, `docs/MCP_SECURITY.md` |
| 7 — Final tests | ✅ Validated (2026-11-02) | `docs/FINAL_REPORT.md`, `dev/phase7/` |

## Log

### 2026-11-02 — Phase 1
- Cloned `canary`, renamed the remote to `upstream`, created the `feat/smart-deploy-mcp` branch.
- Read-only audit; no code executed, no dependency installed.
- Nothing is tested yet.
- Fork created: `im-sacha-cohen/dokploy` (public, remote `origin`). No push.

### 2026-11-02 — Phase 2
- Docker-in-Docker devbox (`docker-compose.dev.yml`, `dev/devbox/`, `scripts/dev-*.sh`): internal daemon 28.5.2, Swarm active inside, host Swarm still inactive.
- Upstream setup run unmodified: Traefik, Postgres and migrations OK; UI reachable at http://localhost:3000.
- 7 demo applications (A–G) served by a local Git server and created through the API (`seed.mjs`).
- Baseline finding: 7 `done` deployments, 4 of which return 502 (B, C, D, G).
- Upstream test suite: 1595/1604 on the first run; the 3 failures are explained and pass when run alone (`docs/TESTING.md`).
- Test owner account created on the local instance (credentials in `dev/.env`, gitignored).

### 2026-11-02 — Phase 3
- Phase 1-2 committed locally (`4402bf3`), no push.
- Deterministic rule engine `packages/server/src/smart-deploy/diagnostics`: read-only collection (Docker API, `/proc/net/tcp`, probes from the Traefik container), then 8 pure rules with cause chaining and secret redaction.
- `smartDeploy.diagnoseApplication` endpoint (tRPC + REST, service read permission, organization check).
- 34 unit tests (rules, parsers, redaction, probe input validation); server and app typecheck OK.
- Run against the demo apps: A and E `healthy`; B, C, D and G `down`, each with its root cause (see `docs/DEPLOYMENT_DIAGNOSTICS.md`).
- `dev/demo-apps/api-client.mjs` factored out of `seed.mjs`; new `diagnose.mjs`.
- Not covered: Compose services (F), images without `cat`, report persistence, version codes (Phase 4).

### 2026-11-02 — Phase 4
- Phase 3 committed locally (`4865da3`), no push.
- Migration `0199_smart_deploy_version_tracking`: 16 nullable columns on `deployment`. The upstream drift line that `drizzle-kit` had added (default of `webServerSettings.whitelabelingConfig`) was removed from the SQL.
- Per-deployment capture: action type, repository without credentials, branch, requested, fetched and built commits, image (ID, digest, `dpl-<id>` tag, 5 kept), container and task actually running.
- Step-by-step post-deployment verification: build, container created, running, healthy, reachable.
- Remote commit verified through the provider API or `git ls-remote`, never assumed.
- Distinct actions: Redeploy and Rollback of a kept image, without fetch or build (`smartDeploy.redeployVersion`, via the deployment queue); Restart without rebuild or config change (`smartDeploy.restartApplication`). Upstream Deploy Latest and Rebuild are now tracked.
- `GIT_COMMIT_OUTDATED` and `IMAGE_VERSION_MISMATCH` rules.
- Minimal upstream changes: 6 calls in `services/application.ts`, one job type and one branch in the queue, the `deployment` schema.
- Tests: 8 more unit tests (42 total). Scenario E: 22/22 for real. A–G: `healthy`, `degraded` or `failed` verification, each with its cause.
- Devbox fixed:
  - stale `containerd` PIDs after `docker restart`;
  - demo Git server killed by startup (now launched with `setsid` and supervised);
  - the old image embedded a frozen copy of the entrypoint.
- Found, not fixed (upstream): on restart, the Dokploy setup tries to recreate Traefik and fails on an already existing Swarm DNS entry (`dokploy-traefik-previous`). Traefik stays in service and startup continues.

### 2026-11-02 — Phase 5
- Phase 4 committed locally (`ad13de3`), no push.
- Preflight: temporary clone using the existing clone functions, manifest reading, `git grep` for variables and listen lines, then pure analysis. Detections with confidence and source, 8 checks. Secrets masked, `.env` never read.
- API:
  - `smartDeploy.preflight`, `getDeploymentTimeline`, `deployLatest`;
  - `applyFix`, revalidated by a fresh diagnosis: only proposed, `autoFixable` fixes are accepted.
- UI: "Smart Deploy" tab with the current version card, the history with redeploy and rollback, and the Source → Configuration → Preflight → Deployment (real timeline) → Result (confirmed fixes) assistant. Existing tabs unchanged.
- The health verdict is no longer influenced by `GIT_COMMIT_OUTDATED`.
- Tests: 56 smart-deploy unit tests and real flows in the browser (see `TESTING.md`).
- Language: the interface is in English like Dokploy; the server-generated texts (findings, reasons) were in French, since translated to English (2026-11-03).

### 2026-11-02 — Phase 6
- Phase 5 committed locally (`b42b08b`), no push.
- Dependencies: `@better-auth/oauth-provider@1.6.23` (server and app) and `@modelcontextprotocol/server@2.4.0` (already in the lockfile as a transitive dependency). `package.json` diff limited to these lines.
- OAuth 2.1 on top of the existing better-auth setup (`oauthProvider` + `jwt` plugins):
  - Authorization Code + PKCE, dynamic registration, RFC 8707 audience;
  - 15-minute JWT and 7-day refresh, `client_credentials` disabled;
  - the `jwt` plugin's `/token` endpoint and the session JWT header disabled.
- Migration `0200_mcp_oauth`: 5 OAuth tables and 3 MCP tables (settings, grants, audit).
- `/mcp`:
  - stateless Streamable HTTP transport (2026-07-28 with 2025 fallback);
  - Host/Origin checks, Bearer, audience, grant rechecked on every request, rate limiting;
  - 19 tools, 2 resources, audit.
- Consent page: organization choice, checkboxes actually enforced, least privilege by default. The login page resumes the OAuth flow after sign-in.
- Settings › AI Integrations: activation, URL, allowed scopes, connection test, connected clients, revocation, audit.
- Tests:
  - `dev/mcp/oauth-mcp-e2e.mjs`: 36/36 for real;
  - real consent in the browser, and resume after login;
  - 12 MCP unit tests (67 total in smart-deploy).
- Bugs found and fixed: log paths containing `:` were rejected (also affected `BUILD_FAILED`); relative RFC 8414 endpoints; test script that overwrote cookies.
- Not done: CIMD, public tunnel for a remote client, multi-user isolation tested for real (Phase 7).

### 2026-11-02 — Phase 7
- Phase 6 committed locally (`a5ba6c5`), no push.
- `dev/phase7/setup-isolation.mjs` (idempotent) prepares:
  - a 2nd organization;
  - a restricted project;
  - an invited test member with limited access (random password in `dev/.env`, gitignored).
- `dev/phase7/isolation-tests.mjs`: 27/27. `dev/phase7/run-all.sh` replays all the scenarios.
- Stability: full restart then repeated runs, everything green.
- Full suite: 1661 tests passed, only the 4 known `backup-files` timeouts fail.
- `dev/demo-apps/api-client.mjs` now handles multiple sessions and extra headers.
- Summary and consolidated limitations: `docs/FINAL_REPORT.md`.

### 2026-11-02 — Errors and ports made visible (after Phase 7)
- Status banner on every application tab: root cause and one primary action.
- "Network path" card (Smart Deploy and Domains tabs), per-domain reachability badges, detected port in the domain form, real result in the Deployments tab.
- `diagnostics/presentation.ts` (pure) and 6 unit tests (73 total in smart-deploy).
- Verified in the browser on A (healthy), B (port), C (crash) and G (localhost).

### 2026-11-03 — MCP "do everything"
- Previous commit: `35f1217` (error and port UX).
- 25 new tools (44 total): services of all types, logs, variables, settings, source, build, compose, domains, creation and deletion, backups, command in a container.
- Bridge `apps/dokploy/server/mcp/api-bridge.ts`: tools call the UI's tRPC procedures (allowlist `mcp/api-paths.ts`), so the same permissions apply.
- New scopes `mcp:env`, `mcp:manage`, `mcp:exec`, disabled by default; warnings in Settings › AI Integrations.
- Human confirmation through elicitation, with an HMAC state bound to the call (`mcp/confirm.ts`), for deletions, stop, restore and every command.
- Bugs found by the e2e and fixed: application deploy missing from the allowlist, project ID not returned, container choice when an app has several tasks.
- Tests: 80 unit tests, `platform-e2e.mjs` 59/59, `run-all.sh` fully OK (including isolation 27/27), full suite 1677 passed (only the known `backup-files` timeout fails, 14/14 when run alone).

### 2026-11-03 — DNS record creation from the domain form
- Reuses upstream's DNS providers (Settings › DNS: Cloudflare, Route 53, OVH, Infomaniak, Porkbun).
- "Add domain" form: "Create the DNS record" block with zone, suggested subdomain (`service` or `service-environment`, suffixed if taken), live status, server IP, Cloudflare proxy (disabled by default). One click creates the A record, then the domain; if the domain fails, the record is removed.
- Never overwrites: a name already used by an A/AAAA/CNAME is refused, also on the server side; a name already pointing here is reused without being created.
- `domain_dns_record` table (migration 0201, additive): only records created by Dokploy are tracked. Deleting the domain offers to delete the record, checkbox ticked by default, only if it still points to this server.
- `domainDns` tRPC router (upstream's `domain` router is called as is); MCP: `dokploy_suggest_subdomain`, `dns` option of `dokploy_create_domain`, record deletion in `dokploy_delete_domain`.
- Upstream's `domain` schema is not modified: a first version with extra columns broke upstream's test fixtures.

### 2026-11-03 — MCP: deployments, Smart Deploy and full logs
- `dokploy_get_deployments`, `dokploy_get_deployment_status` and `dokploy_get_deployment_logs` also cover compose (access check on the compose and the organization).
- New tools: `dokploy_preflight`, `dokploy_get_deployment_timeline` (previously resource only), `dokploy_apply_fix` (fix revalidated against the current diagnosis).
- `dev/mcp/deployments-e2e.mjs`: 24/24. The test clients accept `DOKPLOY_DEV_URL` and `DOKPLOY_MCP_URL` as environment variables.

### 2026-11-03 — Smart Deploy for every service
- Previous commits: `3f9a0b9a7` (DNS from the domain form), `806187a8f` (MCP: DNS, compose, Smart Deploy).
- **Engine**:
  - shared Swarm collection (`collect/swarm.ts`), plus `database.ts` and `compose.ts` collectors;
  - 7 new codes (`IMAGE_PULL_FAILED`, `OUT_OF_MEMORY`, `DISK_FULL`, `DATA_DIRECTORY_INCOMPATIBLE`, `EXTERNAL_PORT_UNAVAILABLE`, `CONFIG_NOT_APPLIED`, `SERVICE_STOPPED`) and a `stopped` verdict;
  - rule sets per service type;
  - per-service aggregation for compose stacks.
- **API**: `smartDeploy.diagnoseService` and `smartDeploy.applyServiceFix`. The latter goes through the upstream procedures `compose.redeploy`/`start`, `<db>.deploy`/`start` and `domain.update`.
- **UI**: status banner and Smart Deploy tab on the compose page and the 5 database pages (findings per service, services table, network path, database facts).
- **MCP**: `dokploy_diagnose_service`; `dokploy_apply_fix` covers every service type.
- **Tests**: 101 smart-deploy unit tests, full suite 1698 passed, real scenario 21/21, isolation 27/27, MCP deployments 24/24.
- **Bugs found for real and fixed**:
  - MongoDB false positive;
  - escaped quotes in compose warnings;
  - a redeploy bound to fail after a Swarm rollback;
  - images without `cat`;
  - missing image with no task to carry the error;
  - compose services stopped after a Docker restart.

## Validated decisions
- Local environment: Docker-in-Docker devbox.
- Images tagged per deployment (`<app>:<deploymentId>`), last 5 kept.
- OAuth: `@better-auth/oauth-provider` grafted onto the existing better-auth setup (same accounts, login, 2FA, SSO).
- DNS from the form (user choice of 2026-11-03): offer to delete the record along with the domain; real tests on a dedicated zone; exposure to MCP.
- MCP "do everything" (user choice of 2026-11-02): writing secrets allowed, reading without the secrets; destructive actions with confirmation; free-form command with confirmation (the brief's initial prohibition is lifted for `mcp:exec` only).
