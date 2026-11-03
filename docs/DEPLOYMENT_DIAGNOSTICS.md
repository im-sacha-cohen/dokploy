# Deployment diagnostics

A **deterministic** engine that explains why a deployed service isn't working: application, compose stack (docker compose or Swarm stack) or database (Postgres, MySQL, MariaDB, Mongo, Redis). It does not rely on any AI. It observes Docker and Traefik **read-only**, then applies rules written in code and covered by tests.

Code: `packages/server/src/smart-deploy/diagnostics/`
API:
- `smartDeploy.diagnoseService` for any service type (REST `GET /api/smartDeploy.diagnoseService?serviceType=…&serviceId=…`);
- `smartDeploy.diagnoseApplication`, unchanged, for applications;
- fixes: `smartDeploy.applyFix` (applications) and `smartDeploy.applyServiceFix` (compose and databases). The latter goes through upstream's procedures (`compose.redeploy`, `postgres.start`…) with their checks.

## Principles

1. **Facts first, rules second.** A collector gathers facts (`DiagnosticContext`), then the rules, which are pure functions, produce findings. Rules can be tested without Docker.
2. **Never conclude from missing data.** A fact that wasn't collected stays `undefined`, and the reason is recorded in `collectionErrors`. Example: if the listening sockets can't be read, `PORT_MISMATCH` falls back to `EXPOSE` with `medium` confidence and no automatic fix.
3. **Read-only.** The engine changes nothing. A proposed fix (`recommendedFix.action`) is just data. It can only be applied through `smartDeploy.applyFix`, after explicit confirmation and revalidation by a fresh diagnosis (see `SMART_DEPLOY_ENGINE.md`).
4. **No secrets.**
   - Environment variable values are never returned, only their names.
   - Logs go through a *redactor*: configured values are replaced with `[REDACTED:KEY]`.
   - Generic patterns (`password=`, URLs with credentials, Bearer, JWT, AWS keys, PEM keys) are masked.
   - ANSI sequences and control characters are stripped (protection against log injection).
   - Lines are truncated to 500 characters.
   - The `.env` file in the build folder is never read. Only `.env.example`, `.env.sample` or `.env.template` is, and only for names.

## Finding format

| Field | Content |
|---|---|
| `code` | stable identifier (table below) |
| `title`, `description` | human-readable text (English) |
| `severity` | `critical`, `error`, `warning` or `info` |
| `confidence` | `high`, `medium` or `low` |
| `evidence[]` | observed evidence: `source` (docker_task, listening_sockets, proxy_probe…), summary, already-sanitized log excerpt |
| `probableCause` | probable cause |
| `recommendedFix` | `summary`, and sometimes a structured `action` (`update_domain_port`, `set_environment_variables`) |
| `risk` | risk of the fix: `none`, `low`, `medium` or `high` |
| `autoFixable` | `true` only if the fix is safe **and** determined unambiguously |
| `causedBy` | codes this finding is a consequence of |

The report also contains:
- a verdict: `healthy`, `degraded`, `down` or `unknown`;
- the raw facts useful to the UI (listening ports, `EXPOSE`, probes, tasks);
- `collectionErrors`, the list of what couldn't be checked.

## Rules

| Code | Trigger | Confidence | Auto fix |
|---|---|---|---|
| `BUILD_FAILED` | latest deployment has status `error`; extract of the error lines from the build log | high | no |
| `CONTAINER_CRASH_LOOP` | ≥ 2 `failed` or `rejected` Swarm tasks within 10 min with no running task (critical), or ≥ 3 with a running task (warning, "restarts regularly"); the exit code is explained (1, 78, 127, 137 = OOM…) | high / medium | no |
| `MISSING_ENVIRONMENT_VARIABLE` | (a) the logs name a missing variable (Node, Python `KeyError`, shell `unbound variable`…) absent from the configuration and the image; (b) a `.env.example` key is not defined | high (a); medium or low (b) | no: the values must be provided by the user |
| `HEALTHCHECK_FAILED` | container `unhealthy`, or tasks killed by Swarm because of the healthcheck | high | no |
| `APPLICATION_NOT_LISTENING` | container started ≥ 20 s ago, no TCP socket listening | high | no |
| `APPLICATION_LISTENING_ON_LOCALHOST` | sockets listening only on 127.0.0.1 or ::1 | high | no |
| `PORT_MISMATCH` | domain port absent from the listening ports (excluding localhost); without sockets, absent from `EXPOSE` (medium); published port whose target isn't listening | high / medium | **yes**, if there is a single candidate port (high) |
| `REVERSE_PROXY_UNREACHABLE` | Traefik → domain probe returns 502, 503 or 504, or Traefik → service is refused or unreachable; or 404 on the domain while the service responds (missing router) | high | no |
| `IMAGE_VERSION_MISMATCH` | the latest `done` deployment recorded a different image from the one running (see `SMART_DEPLOY_ENGINE.md`) | high | yes (`redeploy_deployment`), if the image is still kept |
| `GIT_COMMIT_OUTDATED` | the running commit (proven by the image) differs from the **verified** remote head; does not affect the health verdict | high | yes (`deploy_latest`, medium risk) |
| `IMAGE_PULL_FAILED` | tasks rejected for lack of an image (`No such image`, `manifest unknown`, `pull access denied`…); for a database that was never created, image missing from the server **and** rejected by the registry | high | no |
| `OUT_OF_MEMORY` | container `OOMKilled` (high) or tasks terminated by SIGKILL, code 137 (medium) | high / medium | no |
| `DISK_FULL` | `No space left on device` in the logs or task errors | high | no |
| `DATA_DIRECTORY_INCOMPATIBLE` | databases: the logs say the volume comes from another major version (engine-specific patterns, excluding normal startup messages) | high | no: go back to the previous image, then migrate |
| `EXTERNAL_PORT_UNAVAILABLE` | databases: external port already taken (critical), or configured but not published (warning) | high | yes (`redeploy_service`) in the second case |
| `CONFIG_NOT_APPLIED` | databases: configured image ≠ service image (changed without redeploying, or automatic Swarm rollback) | high | yes (`redeploy_service`), unless the cause is a data incompatibility or a missing image |
| `SERVICE_STOPPED` | service stopped (0 replicas) or never created; `stopped` verdict if nothing else is wrong | high | yes (`redeploy_service`: start, or deploy) |

The applicable rules depend on the type:
- **applications**: `DEFAULT_RULES` (the first ten, plus image, memory and disk);
- **databases**: `DATABASE_RULES`;
- **compose**:
  - `COMPOSE_STACK_RULES` at the stack level: deployment failure, and variables used by the compose file but not defined (docker compose's `The "X" variable is not set` warning);
  - `COMPOSE_SERVICE_RULES` for each service. Network rules only run for services targeted by a domain: a worker with no port is never flagged as "not listening".
  - Each service finding carries `service`. The stack verdict is the worst of its services, downgraded to `degraded` if only a worker without a domain is down.

### Cause chaining

The engine links consequences to their causes:
- `REVERSE_PROXY_UNREACHABLE` can be caused by `PORT_MISMATCH`, `CONTAINER_CRASH_LOOP`, etc.;
- `CONTAINER_CRASH_LOOP` can be caused by `MISSING_ENVIRONMENT_VARIABLE`, `OUT_OF_MEMORY`, `DISK_FULL` or `DATA_DIRECTORY_INCOMPATIBLE`;
- `CONFIG_NOT_APPLIED` can be caused by `DATA_DIRECTORY_INCOMPATIBLE` or `IMAGE_PULL_FAILED`. This avoids suggesting a redeploy that would fail the same way. A consequence is downgraded from `critical` to `error`, and its fix points to the cause. Findings are sorted by severity, then by confidence.

### Adding a rule

A rule is a function `(ctx: DiagnosticContext) => Finding | Finding[] | null`:
1. write it in `rules/`;
2. add it to `DEFAULT_RULES` (`engine.ts`);
3. if it is a consequence of other findings, update `CAUSALITY`;
4. add tests in `apps/dokploy/__test__/smart-deploy/`.

A rule that throws does not abort the report: the error is recorded in `collectionErrors`.

## How facts are collected

Everything goes through the Docker API (`dockerode`, local or remote via `getRemoteDocker(serverId)`), so it works for remote servers too. No Docker socket is exposed.

| Fact | Source |
|---|---|
| Service, replicas, image | `service inspect` |
| Task history, errors, exit codes | `task ls` (last 20) |
| Health, `EXPOSE`, image env keys | `container inspect` of the running task |
| Listening sockets | `exec cat /proc/net/tcp /proc/net/tcp6` in the container (fixed command, argv without a shell); the Docker DNS resolver 127.0.0.11 is ignored. Image without `cat` (scratch, distroless): **ephemeral** helper container created from the Traefik image already present, which only shares the network of the target container (`NetworkMode: container:<id>`, no volume), reads `/proc/net/tcp`, then is removed (label `dokploy.smart-deploy=listening-probe`) |
| Compose (`docker compose`) | project containers (label `com.docker.compose.project`), the most recent one per service. No task history: a container that restarts or stopped with an error is converted into failed tasks, so the Swarm rules apply |
| Compose (stack) | Swarm services `<appName>_<service>` (label `com.docker.stack.namespace`), collected like an application |
| Compose probes | Traefik → container IP on `dokploy-network` (docker compose) or Swarm service name (stack), then the domain with `Host:` |
| Compose deployment log | `tail` of the latest deployment, **even a successful one** (variable warnings) |
| Databases | Swarm service `appName` like an application; expected internal port per engine (5432, 3306, 27017, 6379); published external port read from `Endpoint.Ports`; if the image isn't on the server, `GET /distribution/<image>/json` against the registry (8 s maximum, a timeout concludes nothing) |
| Application logs | `service logs --tail 60`, sanitized |
| Reachability | `exec wget` in the `dokploy-traefik` container, i.e. from the proxy's network point of view: (1) `http://<appName>:<port><path>` and (2) `http://127.0.0.1:80<path>` with `Host: <domain>`. Hosts and paths validated against an allowlist; 5 domains maximum |
| Build log | `tail` of the latest deployment's `logPath` (only if it failed) |
| `.env.example` | build folder `…/applications/<appName>/code/<buildPath>` |

## Results on the demo applications (devbox, 2026-11-02)

Command: `node dev/demo-apps/diagnose.mjs` (`--json` option for the full report).

| App | Dokploy status | Verdict | Findings |
|---|---|---|---|
| A healthy | done | **healthy** | none |
| B wrong port | done | **down** | `PORT_MISMATCH` (domain 80, listening on 3000, auto fix → 3000) → `REVERSE_PROXY_UNREACHABLE` |
| C crash loop | done | **down** | `CONTAINER_CRASH_LOOP` (exit 1) → `REVERSE_PROXY_UNREACHABLE` |
| D missing env | done | **down** | `MISSING_ENVIRONMENT_VARIABLE` (DATABASE_URL, SESSION_SECRET, taken from the logs) → `CONTAINER_CRASH_LOOP` (exit 78) → `REVERSE_PROXY_UNREACHABLE` |
| E outdated | done | **healthy** | none (the version scenario belongs to Phase 4) |
| G localhost | done | **down** | `APPLICATION_LISTENING_ON_LOCALHOST` → `REVERSE_PROXY_UNREACHABLE` |

The 4 "done but returning 502" applications from the baseline are now identified, each with its root cause.

## Results on the demo databases and compose (devbox, 2026-11-03)

Setup: `node dev/demo-apps/seed-services.mjs`. Test: `node dev/demo-apps/diagnose-services.mjs` (21/21).

| Service | Verdict | Findings |
|---|---|---|
| l-pg-healthy | **healthy** | none |
| f-compose | **healthy** | none |
| h-pg-upgraded (postgres 16 data, image switched to 17) | **degraded** | `DATA_DIRECTORY_INCOMPATIBLE` → `CONFIG_NOT_APPLIED` (Swarm rolled back to 16; no redeploy proposed) |
| i-mysql-bad-image | **down** | `IMAGE_PULL_FAILED` (registry: manifest unknown) → `SERVICE_STOPPED` |
| k-mongo-stopped | **stopped** | `SERVICE_STOPPED`, one-click "Start" → healthy |
| j-redis-pending | **degraded** | `CONFIG_NOT_APPLIED`, one-click "Redeploy" → healthy with the new image |
| m-compose-broken | **down** | `PORT_MISMATCH[web]` (read via the helper container, scratch image) → `REVERSE_PROXY_UNREACHABLE[web]`; `MISSING_ENVIRONMENT_VARIABLE[worker]` (QUEUE_URL) → `CONTAINER_CRASH_LOOP[worker]`; `MISSING_ENVIRONMENT_VARIABLE` (API_KEY empty in the compose file). One-click "Use port 8081": domain updated, stack redeployed, HTTP 200 |

A false positive found and fixed during these tests: MongoDB writes `featureCompatibilityVersion` on every normal startup, which triggered `DATA_DIRECTORY_INCOMPATIBLE`. The patterns were tightened, and a test guards against it.

## Known limitations

- **Compose**:
  - no per-commit version tracking, unlike applications. The report gives each service's image and the latest deployment;
  - services in a compose file that never created a container are only seen if they have a domain;
  - preflight and the timeline remain reserved for applications.
- **Databases**: no `.env.example` and no HTTP probe (not applicable). A `libsql` database is not covered.
- **Multi-node Swarm**: if the task runs on a different node than the manager Dokploy connects to, `container inspect` and socket reading fail. This is reported in `collectionErrors`, and socket-based rules don't conclude.
- **Images without `cat`** (distroless, scratch): read through the ephemeral helper container. If it can't be created (Traefik absent from the server), falls back to `EXPOSE`.
- **HTTPS domains**: the probe goes through the `web` entrypoint (80). A 3xx redirect is treated as "router present"; the TLS chain is not verified.
- **Missing-variable messages**: log-based detection covers the common phrasings (see `log-patterns.ts` and its tests). An unusual message won't be recognized, and no finding will be invented.
- Reports are **not persisted yet**: they are computed on demand. A `diagnostic_report` table is planned along with the timeline.
- The required permission is **read** access to the service (`checkServiceAccess(…, "read")`), same as `readLogs`.
