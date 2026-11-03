# Tests

Existing framework: **Vitest 4** (`apps/dokploy/__test__`, config `__test__/vitest.config.ts`). The database is mocked (`__test__/setup.ts`), except in `*.real.test.ts` tests, which run Docker and Git for real.

```bash
./scripts/dev-test.sh                    # full suite in the devbox
./scripts/dev-test.sh __test__/deploy    # a folder or a file
```

Tests run **without a TTY** and with `GIT_TERMINAL_PROMPT=0`. Otherwise, a `git clone` to a nonexistent repository stays blocked on a credentials prompt (seen on `application.real.test.ts`).

## Baseline before changes (upstream `46a0762`, 2026-11-02, devbox arm64)

| Measure | Result |
|---|---|
| Test files | 166 passed, 2 failed, 1 skipped (169) |
| Tests | 1595 passed, 3 failed, 6 skipped (1604) |
| Duration | ~400 s |

Analysis of the 3 failures:

| Test | Cause | Status after analysis |
|---|---|---|
| `backups/backup-files.test.ts` › `getBackupServerId`, `resolveBackupAccess` | Vitest's 5 s timeout exceeded during import, under the load of the full suite | **Pass** when run alone (14/14). Load-related flakiness, unrelated to the fork |
| `deploy/application.real.test.ts` › *REAL git clone errors* | The first run used a TTY, and git was waiting for credentials | **Passes** without a TTY (5 passed, 1 skipped); `dev-test.sh` is fixed |

Any regression introduced by the fork is measured against this table.

## After Phase 3 (2026-11-02)

| Measure | Result |
|---|---|
| Tests | 1628 passed, 4 failed, 6 skipped (1638), including 34 new ones (`__test__/smart-deploy`) |
| Failures | all 4 are in `backups/backup-files.test.ts`: 5 s timeouts under load, as in the baseline. This file **passes** when run alone (14/14) |
| Typecheck | `packages/server` and `apps/dokploy`: 0 errors (the app needs `NODE_OPTIONS=--max-old-space-size=6144` in the devbox) |
| Regression | none observed |

Upstream's `*.real.test.ts` tests leave `real-*` services (0/1) in the devbox's **internal** Docker daemon. They have no effect on the host and go away with `dev-reset.sh`.

## After Phase 4 (2026-11-02)

| Measure | Result |
|---|---|
| Tests | 1635 passed, 5 failed, 6 skipped (1646), including 42 in `__test__/smart-deploy` |
| Failures | 4 in `backup-files.test.ts`: timeouts under load, as in the baseline; **passes alone** (14/14). 1 in `application.real.test.ts` (real nixpacks build, 180 s timeout under load); **passes alone** |
| Typecheck | server and app: 0 errors |
| Real scenario E | `version-scenario.mjs`: 22/22 |
| Real verification A, B, C, D, G | healthy, degraded, failed, failed, degraded |

Regressions found and fixed during the phase. The first run of the full suite revealed:
- `application.command.test.ts` (2 tests): `deployApplication` ran a `git ls-remote` before the build command. Reading the requested commit was moved into the deployment queue.
- `application.real.test.ts` (Dockerfile): the `<app>:dpl-…` tag duplicated the `docker images <app>` line. Retained images now live in a separate repository, `dokploy-versions/<app>`.

## After Phase 5 (2026-11-02)

| Measure | Result |
|---|---|
| Tests | 1648 passed, 6 failed, 6 skipped (1660), including 56 in `__test__/smart-deploy` |
| Failures | 4 in `backup-files.test.ts`, timeouts under load (passes alone, 14/14). 2 in `application.real.test.ts` (real nixpacks clone and submodules, failing under load; passes alone, 5 passed + 1 skipped) |
| Typecheck | server and app: 0 errors |
| Real preflight | A–G: temporary clone deleted, 90 to 250 ms. Expected findings: port 80 for B, `DATABASE_URL`/`SESSION_SECRET` for D, localhost for G |

UI flows tested in the built-in browser (local instance, test account):

| Flow | Result |
|---|---|
| Smart Deploy tab on B: version card, preflight, diagnostic | real data displayed, PORT_MISMATCH and REVERSE_PROXY_UNREACHABLE findings |
| B: "Apply fix" (port 80 → 3000) with confirmation | applied, diagnostic "running and reachable", `curl` through Traefik 200 (502 before). Port 80 restored afterwards to keep the scenario |
| A: Deploy latest from step 3, then timeline | 6 steps observed through to "reachable", history refreshed automatically |
| E: "Roll back" from the history | version `be8f6bb` running, status "Outdated", Deploy latest recommended |

Defects found during these tests and fixed:
- status frozen at the deployment result → *live* status added;
- history not refreshed after the timeline;
- Roll back offered to the image already running;
- "outdated" counted as "degraded";
- unreadable badge.

## After Phase 6 (2026-11-02)

| Measure | Result |
|---|---|
| Full suite | 1630 passed, 7 failed, 6 skipped (1643) |
| Regression found and fixed | 3 `__test__/traefik/*` files that mock `@dokploy/server` entirely no longer loaded the router (MCP constant read at module load). Import moved to the `@dokploy/server/mcp/config` subpath; these 3 files pass, as does `remote-stream.test.ts` (timeout under load) |
| Remaining failures | `backup-files.test.ts`, 5 s timeouts under load as in the baseline; **14/14 alone** (twice) |
| Typecheck | server and app: 0 errors |
| Smart-deploy + MCP tests | 67/67 |
| Real end-to-end OAuth + MCP | `dev/mcp/oauth-mcp-e2e.mjs`: **36/36** |

Coverage of the real end-to-end test, on the local instance:
- **discovery**: 401 with `resource_metadata`, then RFC 9728 and RFC 8414;
- **registration and authorization**: dynamic registration of a public client, PKCE authorization, consent, code exchange, code replay rejected;
- **token**: `/mcp` audience, 15 min lifetime, only the consented scopes;
- **tools**: `tools/list` in 2026-07-28 and via the 2025-06-18 fallback, then real calls (projects, diagnostic of B, application without variable values, logs, version);
- **rejected cases**:
  - missing scope → 403 `insufficient_scope`;
  - invalid input rejected;
  - unknown application → same response as an access denial;
  - forged token → 401, random token → 401;
  - unknown Host → 421, Origin from another site → 403;
  - malformed JSON → error without crashing;
- **load**: 20 concurrent requests;
- **lifecycle**: refresh token, step-up to `mcp:deploy` then a real restart, audit log, revocation (still-valid access token rejected immediately, refresh rejected), 429 on bursts of invalid tokens.

In the built-in browser:
- Settings › AI Integrations page and connection test (4/4);
- 302 redirect to consent;
- real consent with only `mcp:read` checked: grant `{mcp:read}`, consent `{mcp:read, offline_access}`, without `mcp:deploy`;
- redirect to the client with `code`, `state` and `iss`.

Resume after login verified: without a session, authorization redirects to the login with a signed request; signing in sends back to consent.

**Not tested**:
- real remote client (claude.ai): requires a public tunnel, not set up without approval;
- MCP Inspector: not downloaded;
- isolation between two real users or organizations (Phase 7);
- client interruption and Docker errors: covered by the code, not by a dedicated test.

## Phase 7 — final tests (2026-11-02)

| Measure | Result |
|---|---|
| Full suite | **1661 passed**, 4 failed, 6 skipped (1671) |
| Failures | the 4 `backup-files.test.ts` timeouts under load, already present in the upstream baseline; 14/14 when run alone |
| Real permissions and isolation | `dev/phase7/isolation-tests.mjs`: **27/27** |
| All scenarios | `dev/phase7/run-all.sh`: diagnostics A–G (A and E healthy; B, C, D and G failing with their cause), version E 22/22, isolation 27/27, OAuth + MCP 36/36 |
| Stability | after `docker restart` of the devbox, `run-all.sh` fully OK, then OAuth + MCP replayed 3 times in a row (36/36 each time) |

`isolation-tests.mjs` uses a real restricted member (invitation, sign-up, access limited to apps A, B and E), a second organization and an ungranted project. It checks that:
- the UI and MCP show exactly the same apps to this member;
- any ungranted object is refused (ungranted project, other organization, ungranted app in the same project), for diagnostics as well as actions;
- a token issued for organization A does not give access to organization B, even for the owner;
- it is impossible to grant a client for an organization where MCP is disabled, or of which one is not a member;
- removing a scope in the organization gives an immediate 403, and disabling the integration gives an immediate 401;
- a member only sees their own clients and their own audit entries, and cannot revoke others', whereas an admin can, with immediate effect.

## "Do everything" MCP (2026-11-03)

| Measure | Result |
|---|---|
| Smart-deploy unit tests | **80/80** (including `mcp-confirm.test.ts`: confirmation, forged state, other client, other arguments, client without elicitation, API allowlist, default scopes) |
| Full real scenario | `dev/mcp/platform-e2e.mjs`: **59/59** |
| Existing OAuth + MCP | `dev/mcp/oauth-mcp-e2e.mjs`: 36/36 (after factoring the helpers into `dev/mcp/mcp-client.mjs`) |
| All Phase 7 scenarios | `dev/phase7/run-all.sh`: diagnostics A–G OK, version E 22/22, isolation 27/27, OAuth + MCP 36/36 |
| Full suite | **1677 passed**, 1 failed, 6 skipped (1684); the failure is the known `backup-files.test.ts` timeout under load (14/14 when run alone) |

`platform-e2e.mjs` runs everything through MCP, in a throwaway project deleted at the end:
- `env`/`manage`/`exec` scopes not granted until the organization allows them (403);
- creating a project, an environment, an application (Docker image), a Postgres and a compose;
- variables: secret masked on read, masked placeholder rejected on write, deletion without touching the others;
- settings, a domain created then served by Traefik (HTTP 200), deployment, application and compose logs;
- command in the Postgres container:
  - clear refusal for a client without elicitation;
  - question containing the exact command;
  - user refusal without execution;
  - forged state rejected (`-32602`);
  - state reused for another command, or missing: new question;
  - confirmed execution, database password masked in the output;
  - exit code and stderr of a failing command;
- stop (confirmed) then start, confirmed domain deletion (the hostname appears in the question);
- restricted member: does not see the project, refused on variables, deletion and command, **before** any confirmation;
- limit of 10 mutations/min reached then respected; audit with `confirmation_requested`, `declined` and `ok`, without secrets;
- confirmed deletion of the services, the environment and the project.

Incidents during the runs, unrelated to the code:
- **Docker Desktop stopped** mid-run, probably from lack of memory: the app's full typecheck does not fit alongside the dev server in the devbox. Run `tsc` right after a devbox restart.
- **On restart, upstream's Traefik setup failed** (`could not add service state for endpoint dokploy-traefik-previous`): stale network endpoint in the internal Docker. Fix: `docker exec dokploy-devbox docker rm -f dokploy-traefik`, then `docker restart dokploy-devbox` (the setup recreates Traefik).
- **Mac went to sleep** during a run: the confirmation state (5 min) then the access token (15 min) expired, and were correctly rejected. Run long e2e tests under `caffeinate -dims`.

Not tested for real:
- `run_backup`, `list_backup_files` and `restore_backup`: no S3 destination in the local environment;
- `set_application_source` with Git and GitHub, `set_build_type`: only the Docker image source was exercised;
- `cancel_deployment`;
- a commercially available MCP client with elicitation (Claude Code, etc.): the flow was played by the test client, which follows protocol 2026-07-28.

## Domain + DNS record from the form (2026-11-03)

| Measure | Result |
|---|---|
| Unit tests (`domain-dns.test.ts`) | labels (accents, length), qualified names, suggestion that skips taken names, reuse of a name already pointing here, A/AAAA/CNAME conflicts, TXT/MX ignored, IP ranking; smart-deploy + traefik: **227/227** |
| Typecheck | server and app without errors |
| Browser, real zone `sacha-cohen.fr` (read-only) | suggestion `a-healthy.sacha-cohen.fr` available; `www` flagged as taken (existing CNAME); `bad_name` rejected; Host filled in automatically |
| API without writes | taken name → **409**; IP foreign to the server → **400**; 0 domains and 0 records created (46 records before and after) |
| Real creation and deletion | `dev/dns/domain-dns-e2e.mjs` (UI + MCP): **not run**, waiting for an authorized test zone |

`domain-dns-e2e.mjs` refuses to run without `DNS_E2E_ZONE` and `DNS_E2E_CONFIRM=yes`. It only uses `dokploy-e2e-*` names that are absent at the start, and checks at the end that none remain.

## MCP: deployments, Smart Deploy and logs (2026-11-03)

`dev/mcp/deployments-e2e.mjs`: **24/24** for real, via the tunnel:
- deployments, status and build logs of an application and a compose;
- Smart Deploy timeline (6 steps); explicit refusal for a compose;
- runtime logs;
- preflight;
- diagnostic of B, then applying the proposed port fix; a fix not proposed by the diagnostic is refused. B is put back in its broken demo state (502 verified through Traefik);
- restricted member: deployments and logs of an ungranted compose refused.

Non-regression, replayed via the tunnel:
- `platform-e2e.mjs`: 59/59;
- `oauth-mcp-e2e.mjs`: 35/36. The "unknown Host → 421" check receives 409, because Cloudflare rejects the spoofed Host before Dokploy. Directly on `127.0.0.1:3000`, Dokploy does return 421.

To run these scripts while `localhost:3000` is taken by another server or `/mcp` goes through a tunnel:

```bash
DOKPLOY_DEV_URL=http://127.0.0.1:3000 DOKPLOY_MCP_URL=https://<tunnel>/mcp node dev/mcp/deployments-e2e.mjs
```

## Smart Deploy for compose stacks and databases (2026-11-03)

| Measure | Result |
|---|---|
| Smart-deploy unit tests | **101/101**, including `service-diagnostics.test.ts` (database rules, compose, containers turned into tasks, Mongo false positive, stopped service with a domain) |
| Full suite | **1698 passed**, 1 failed (known `backup-files.test.ts` timeout), 6 skipped (1705), run with `--maxWorkers=2` |
| Typecheck | server and app clean |
| Real scenario `dev/demo-apps/diagnose-services.mjs` | **21/21**; later runs 20/21 and 20/22 after a devbox restart (see below) |
| Diagnostics A–G, version E | unchanged (A and E healthy, 22/22) after extracting the shared Swarm collector |
| Isolation | **27/27** |
| MCP deployments | **24/24** |
| Browser | broken compose: banner (service `web`, "Use port 8081"), Smart Deploy tab (findings, services table, network path); `h-pg-upgraded` database: banner, Degraded verdict, root cause. Tabs on database pages widened ("Smart Deploy" overflowed) |

Setup: `node dev/demo-apps/seed-services.mjs` (databases and compose broken on purpose, idempotent).

The real scenario found and got fixed:
- **a false positive**: MongoDB logs `featureCompatibilityVersion` on every startup, which triggered `DATA_DIRECTORY_INCOMPATIBLE`. The patterns were narrowed for every engine;
- **escaped quotes**: docker compose writes `\"API_KEY\"` in its warnings, which the pattern did not match;
- **a wrong fix**: after a Swarm rollback, `CONFIG_NOT_APPLIED` proposed a redeploy bound to fail. It is now linked to its cause, and the logs of the tasks that ran the configured image are read;
- **an image without `cat`**: the port was not measured, hence the short-lived helper container;
- **a database never created for lack of image**: no task carries the error, hence the registry check;
- **compose services stopped** after a Docker restart, previously not reported. They now show as `SERVICE_STOPPED`, with one-click "Start" (tested), and take the stack `down` when they serve a domain.

Environment failures, unrelated to the code:
- Docker Hub did not answer intermittently from the devbox (Redis redeploys failed, image check got no answer; the engine then concludes nothing, as designed);
- the devbox restarted during a full suite run alongside the scenarios (memory);
- `oauth-mcp-e2e.mjs` through the tunnel: IPv6 timeout to Cloudflare at the "spoofed Host" step. Directly, Dokploy does return 421.

`dev/phase7/isolation-tests.mjs` now honours `DOKPLOY_MCP_URL`, like the other scripts. Before, it failed as soon as `/mcp` went through a tunnel.

## Reference manual tests (demo applications)

See `docs/LOCAL_DEVELOPMENT.md` › *Test account and demo applications*: with the upstream engine, 7 deployments are `done`, 4 of them applications returning 502.

## Fork test plan

To be completed phase by phase. A test is only marked as passed once it has actually been run.

| Area | Type | Status |
|---|---|---|
| Diagnostic rules (port, crash loop, env, localhost, healthcheck…) | unit + demo scenarios B/C/D/G | ✅ 34 unit tests; scenarios A–G (except F, Compose) run for real via `diagnose.mjs` |
| Version tracking (remote / built / running SHA, digest) | unit + scenario E | ✅ 8 unit tests; scenario E 22/22 for real |
| Timeline / verification status | integration (devbox) + UI | ✅ A–G real; UI timeline tested in the browser |
| Preflight, applyFix, UI | unit + browser | ✅ 14 unit tests; real flows (see Phase 5) |
| OAuth (PKCE, audience, expiry, revocation) | API + browser | ✅ 36/36 for real (`dev/mcp/oauth-mcp-e2e.mjs`); consent tested in the browser |
| MCP (tools, scopes, project isolation, log injection) | API | ✅ tools, scopes, refusals and redaction for real; multi-user isolation 27/27 (Phase 7); MCP Inspector not used |
| Extended MCP (services, env, command, human confirmation) | unit + API | ✅ 80 unit tests; 59/59 for real (`dev/mcp/platform-e2e.mjs`); backups not tested (no local S3) |
| Non-regression | full upstream suite | baseline above |
