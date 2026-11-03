# Architecture audit — Dokploy (Smart Deploy + MCP fork)

- **Audited base**: `Dokploy/dokploy`, `canary` branch, commit `46a0762` (2026-10-31), version `v0.30.11`
- **Date**: 2026-11-02
- **Method**: code reading only (nothing was executed at this stage). Every claim points to a file; unverified points are flagged as such.

---

## 0. License, contribution, prerequisites

| Topic | Finding | Source |
|---|---|---|
| License | Apache 2.0 for all code **outside** the `/proprietary` folders. The `/proprietary` folders fall under the *Dokploy Source Available License*: modification is allowed for dev/test, **production use requires a commercial agreement**, redistribution is forbidden. | `LICENSE.MD`, `LICENSE_PROPRIETARY.md` |
| Proprietary folders | `packages/server/src/services/proprietary/` (audit-log, forward-auth, license-key, sso, whitelabeling), `apps/dokploy/server/api/routers/proprietary/`, `apps/dokploy/components/proprietary/` | — |
| Dev branch | `canary` (PRs target `canary`, `main` = stable) | `CONTRIBUTING.md` |
| Conventions | Conventional Commits, Biome (format + lint), "why" comments only | `CONTRIBUTING.md`, `CLAUDE.md` |
| Node / pnpm | Node `24.22.1` (`.nvmrc`, `engines`), pnpm `10.22.0` | `package.json` |
| Dev startup | `pnpm install` → `pnpm dokploy:setup` (swarm init, network, Traefik, Postgres) → `pnpm server:script` → `pnpm dokploy:dev` (port 3000) | `CONTRIBUTING.md` |
| Official MCP | Exists **outside the repo** (`github.com/Dokploy/mcp`), generated from `openapi.json`, authenticates with a static **admin API key** | `.github/workflows/dokploy.yml:218-238` |

**Rule adopted for the fork: never modify a file under `/proprietary`.** Every new feature lives in Apache 2.0 modules.

---

## 1. Current architecture

```
apps/dokploy          Next.js 16 (pages router) + custom HTTP server (server/server.ts)
 ├─ pages/api/trpc     tRPC (UI)                 ┐
 ├─ pages/api/[...trpc] REST/OpenAPI (x-api-key) ├─ same logic: tRPC routers
 ├─ pages/api/auth     better-auth               ┘
 ├─ pages/api/deploy   Git / registry webhooks
 ├─ server/wss         WebSockets (build logs, container logs, terminal…)
 ├─ server/queues      IN-MEMORY deployment queue (no Redis)
 └─ drizzle/           200 SQL migrations (drizzle-kit)
packages/server       Shared business logic (@dokploy/server)
 ├─ services/          CRUD + orchestration (application.ts, compose.ts, deployment.ts…)
 ├─ utils/builders     nixpacks, railpack, dockerfile, buildpacks, static
 ├─ utils/providers    GitHub/GitLab/Gitea/Bitbucket/git clone
 ├─ utils/traefik      per-application Traefik dynamic files
 ├─ utils/docker       Swarm spec, compose labels, inspect helpers
 ├─ lib/auth.ts        better-auth 1.6.23
 └─ db/schema          Drizzle (Postgres 16)
apps/api              Cloud service (Hono + Inngest) — unused when self-hosted
apps/schedules        BullMQ/Redis cron (backups) — the only place Redis is used
apps/monitoring       Metrics agent (Go)
```

**Runtime**: every application runs as a **Docker Swarm service** (not `docker run`). Traefik runs as a standalone `dokploy-traefik` container on the `dokploy-network` overlay network. Remote servers are driven over SSH (`execAsyncRemote`, Dockerode `protocol: "ssh"`) with the **same shell scripts**.

**Auth**: better-auth (plugins `apiKey`, `organization` with dynamic RBAC, `twoFactor`, `passkey`, `sso`, `scim`, `admin`). Session cookie `better-auth.session_token`, 3 days. No `jwt` / `oidcProvider` / `oauthProvider` plugin is enabled (`packages/server/src/lib/auth.ts:487-529`).

---

## 2. How a deployment runs (application)

1. **UI / API** → `application.deploy` (`apps/dokploy/server/api/routers/application.ts:807`) creates a `{type:"deploy"}` job; `redeploy` (L446) creates a `{type:"redeploy"}` job.
2. **Queue** → `InMemoryQueue` partitioned by server, serialized per application (`server/queues/in-memory-queue.ts`). Jobs are **lost on restart**; at boot, `running` deployments are set to `cancelled` (`utils/startup/cancel-deployments.ts`).
3. **Worker** → `deployApplication` / `rebuildApplication` (`packages/server/src/services/application.ts:178-336`).
4. `createDeployment` → `deployment` row (`status=running`) + log file `${BASE_PATH}/logs/<app>/<app>-<date>.log`.
5. **Clone** → `git clone --branch <b> --depth 1` (`utils/providers/github.ts:236`, same for gitlab/gitea/bitbucket/git). **No commit is pinned.**
6. **Patches** → `generateApplyPatchesCommand`.
7. **Build** → `getBuildCommand` produces an image with a **mutable** `<appName>:latest` tag; optional registry push (`utils/cluster/upload.ts`).
8. Everything runs as **a single shell command** `(cmd) >> log 2>&1` (L227-232).
9. **Runtime** → `mechanizeDockerContainer`: `service.update({ForceUpdate+1})`, otherwise `createService` (`utils/builders/index.ts:82-213`).
10. **Status** → `done` **as soon as Swarm has accepted the spec** (L234-236). There is no wait for convergence, health or reachability.
11. `finally` → `git log -1`: the SHA is written **as free text** in `deployment.description = "Commit: <sha>"` (L267-282).

### Actual semantics of each action

| UI action | What it actually does | Gap with expectations |
|---|---|---|
| Deploy | Re-clones the branch HEAD + build + service update | ≈ "Deploy Latest", but the commit that was built is only known afterwards |
| Redeploy ("Rebuild" on the router side) | **No Git fetch**, rebuilds the folder that was already cloned. Docker source: **no `docker pull`** | Explains "redeploying doesn't pick up the latest version" |
| Reload | Re-applies the Swarm spec (ForceUpdate), no build, no `deployment` row | Untracked restart |
| Start / Stop | `docker service scale =1 / =0` (ignores `replicas`) | — |
| Rollback | Requires a registry + `rollbackActive`. The `rollbacks` row is created **before** the build runs (even if the build fails). Restoration uses a Swarm spec **different** from `mechanizeDockerContainer` | Unreliable rollback without a registry; no `deployment` row |
| Kill build | `pkill -2 -f "docker build"` → **kills every build** on the server | — |

### Webhooks
The GitHub/GitLab/… webhooks extract the pushed SHA but **do not use it for the checkout** (`pages/api/deploy/github.ts`, `[refreshToken].ts:511-545`): a concurrent push can cause a different commit to be built than the one announced.

### Compose
`deployCompose`: clone + `docker compose -p <app> up -d --build` or `docker stack deploy` (`utils/builders/compose.ts:125-149`). Domains are injected via **Traefik labels**. No rollback, no Swarm spec (health is defined in the compose file).

---

## 3. Components involved

| Area | Key files |
|---|---|
| Deployment orchestration | `packages/server/src/services/application.ts`, `services/compose.ts`, `services/deployment.ts` |
| Queue | `apps/dokploy/server/queues/{queueSetup,in-memory-queue,deployments-queue,concurrency}.ts` |
| Build | `packages/server/src/utils/builders/*` |
| Git | `packages/server/src/utils/providers/*` (`getGitCommitInfo` in `git.ts:168-201`) |
| Swarm spec | `utils/builders/index.ts` (`mechanizeDockerContainer`), `utils/docker/utils.ts` (`generateConfigContainer`, `waitForSwarmServiceConvergence` L974 — only used for databases) |
| Docker inspection | `services/docker.ts` (`getServiceContainersByAppName`, `getApplicationInfo`, `getDockerEvents`, `getConfig`…) |
| Domains / proxy | `db/schema/domain.ts` (`port` defaults to 3000), `utils/traefik/domain.ts`, `utils/traefik/application.ts:349-359` → `http://<appName>:<port>` |
| Published ports | `db/schema/port.ts`, applied through `EndpointSpec` |
| Logs | build: file + WS `/listen-deployment` (`tail -f`); runtime: WS `/docker-container-logs` |
| Permissions | `packages/server/src/lib/access-control.ts`, `services/permission.ts` (`checkPermission`, `checkServiceAccess`, `checkProjectAccess`…), `apps/dokploy/server/api/trpc.ts` |
| Audit | `audit_log` table; `createAuditLog` writes are **proprietary and license-gated** |
| Existing AI | `routers/ai.ts`, `services/ai.ts` (Vercel AI SDK, `analyzeLogs` sends logs to a configured LLM) |
| Application UI | `pages/dashboard/project/[projectId]/environment/[environmentId]/services/application/[applicationId].tsx`, `components/dashboard/application/*` (shadcn/ui) |
| Settings / menu | `pages/dashboard/settings/*`, `components/layouts/side.tsx` (`MENU.settings` array) |

---

## 4. Pain points identified (verified in the code)

1. **Premature success**: `done` after `service.update()`, with no convergence or healthcheck (`services/application.ts:234-236`).
2. **Untraceable version**: no SHA column, SHA stored as free text, **no image digest** stored; mutable `:latest` tag.
3. **Ambiguous redeploy**: no Git fetch, no pull for Docker sources.
4. **Webhook SHA ignored**: HEAD is cloned, not the notified SHA.
5. **Ports**: the domain port is entered by hand (default 3000), **no detection** of `EXPOSE` or of the actual listening port (grep finds nothing outside Traefik).
6. **No default healthcheck**; the outcome of Swarm updates (automatic rollback with `FailureAction: rollback`) is never read back → a silent Swarm rollback can leave the old image running while the UI shows the new deployment.
7. **Diagnostics**: only `analyzeLogs` (LLM on raw text). No deterministic engine.
8. **Timeline**: a single log file, no structured steps.
9. **Global build kill** (`pkill`), **in-memory queue** (lost on restart).
10. **Preview deployments**: only GitHub sources build; the others are marked `done` without a build (`services/application.ts:412`).
11. **Security**: `canAccessToAPI` is checked **only on the UI side**; `rollbacks.fullContext` stores registry credentials; no application-level rate limiting.
12. **Audit**: the audit log only works with an enterprise license.

---

## 5. Files and modules to modify (minimal hook points)

| Existing file | Planned change |
|---|---|
| `services/application.ts` (`deployApplication`, `rebuildApplication`) | Emit timeline events; record requested/fetched/built SHA and image ID/digest; start post-deployment verification |
| `services/compose.ts` | Same (SHA + timeline + per-service verification) |
| `utils/providers/*.ts` | `commitSha` option: `git fetch --depth 1 origin <sha>` + checkout; output the fetched SHA |
| `utils/builders/index.ts` | Additional immutable tag `<app>:<deploymentId>` (if approved) |
| `pages/api/deploy/*.ts` | Pass the webhook SHA as the requested commit |
| `routers/application.ts`, `routers/compose.ts` | New procedures (`deployLatest`, `rebuildCommit`, `restart`, `preflight`, `diagnose`, `versionStatus`) — the old ones stay |
| `db/schema/deployment.ts` | Additional nullable columns (compatible with existing installs) |
| `lib/auth.ts` | Add the OAuth provider + JWT plugins (additive configuration) |
| `next.config.mjs` | Rewrites `/mcp` → `/api/mcp`, `/.well-known/oauth-*` |
| `components/layouts/side.tsx` | "AI Integrations" entry |
| Application UI | New "Current deployment" panel, assistant, timeline, diagnostics (existing tab kept) |

Everything else is **new code** in dedicated modules (§8).

---

## 6. Existing features to reuse

- `waitForSwarmServiceConvergence` (`utils/docker/utils.ts:974`) → "Container running" step.
- `getServiceContainersByAppName` / `getApplicationInfo` (`services/docker.ts`) → task state, errors, exit codes.
- `getDockerEvents` → Docker events (point-in-time window).
- `getGitCommitInfo` → built SHA.
- `healthCheckSwarm` + `advanced/cluster/swarm-forms/health-check` forms → no need for a new healthcheck model.
- `checkServiceAccess`, `checkProjectAccess`, `checkPermission`, `resolvePermissions` → **same authorization for UI and MCP**.
- better-auth `apiKey` / `organization` → single identity, no second user system.
- shadcn components (`components/ui/*`), existing log WebSockets, `@stepperize/react` (already a dependency) for the assistant.
- Vitest (170 test files, mocked DB), CI that already initializes swarm + `dokploy-network`.
- Existing `.devcontainer/` (Node 24 + docker-in-docker) → basis for the isolated local environment.

---

## 7. Technical risks

| Risk | Impact | Mitigation |
|---|---|---|
| Upstream divergence (very active canary, 200 migrations) | Rebase conflicts, especially `drizzle/meta/_journal.json` | Code in separate modules, minimal hooks, grouped and regenerable migrations |
| Proprietary license | Audit log / custom roles are proprietary | **Own** MCP audit log (Apache 2.0), no modification of `/proprietary` |
| MCP spec **2026-07-28**: *stateless* protocol (no more `initialize` handshake or session) while some clients still use 2025-11-25 / 2025-06-18 | Client incompatibility | Official SDK `@modelcontextprotocol/server` 2.x (already in the lockfile via shadcn); backward compatibility to be **verified in Phase 6** |
| OAuth: the MCP spec recommends *Client ID Metadata Documents* (SHOULD), DCR is deprecated but still used by clients | Clients can't connect | `@better-auth/oauth-provider@1.6.23` (peers compatible with the current `better-call 1.3.7` overrides). CIMD support **not verified** → to be tested; DCR as fallback |
| Token audience (RFC 8707) | Replay of tokens issued for another service | Validate `aud` = canonical `/mcp` URL on every request |
| Listening-port detection | Distroless images without a shell | Ephemeral inspection container sharing the network namespace (`--net container:<id>`) → reads `/proc/net/tcp*`; never run by an agent |
| macOS | Swarm, overlay, `host` ports, `/etc/dokploy`, port 80 taken (httpd) and 5432 taken (local Postgres), Docker Desktop limited to 8 GB | Dedicated **Docker-in-Docker** environment (see §10) |
| Third-party-controlled logs | Prompt injection into the agent | Logs returned as tagged data (`untrusted`), truncated, secrets masked; never in tool descriptions |
| Secrets | Leak through MCP / reports | Read env keys only (never values), masking in returned logs |
| In-memory queue | MCP deployment lost on restart | Documented; existing `cancelled` status at boot |

---

## 8. Target architecture

### Modules (all Apache 2.0, in `packages/server/src/`)

```
smart-deploy/
  preflight/        detectors (framework, language, package manager, Dockerfile/EXPOSE,
                    compose, scripts, start command, referenced env, healthcheck) → report with confidence
  runtime/          inspection: Swarm tasks, container, running image (digest), listening ports,
                    internal HTTP probe (http://<app>:<port>) and via Traefik (Host header)
  versioning/       requested/fetched/built SHA, `git ls-remote` for the latest remote commit,
                    produced vs running image digest, Up-to-date / Outdated / Unknown status
  timeline/         structured events per deployment (step, status, timestamp, evidence)
  diagnostics/      deterministic rule engine (Rule → Finding interface) + optional AI layer
                    PORT_MISMATCH, APPLICATION_NOT_LISTENING, LISTENING_ON_LOCALHOST,
                    CONTAINER_CRASH_LOOP, MISSING_ENVIRONMENT_VARIABLE, HEALTHCHECK_FAILED,
                    REVERSE_PROXY_UNREACHABLE, IMAGE_VERSION_MISMATCH, GIT_COMMIT_OUTDATED, BUILD_FAILED
  actions/          deployLatest / rebuildCommit / redeploy / restart / rollback — single facade
                    reused by tRPC AND MCP (no second engine)
mcp/
  server.ts         MCP server (official SDK), Streamable HTTP transport
  tools/            read / deploy / configuration tools → call smart-deploy/actions
  resources/        projects, history, status, diagnostic reports
  scopes.ts         OAuth scopes ↔ Dokploy permissions (intersection, never widening)
  guard.ts          token check, audience, scopes, project/service access, rate limit, confirmation
  audit.ts          MCP call log
oauth/              better-auth integration (oauth-provider + jwt), consent screen
```

### Data (versioned Drizzle migrations, nullable columns)

- `deployment` + : `kind` (deploy_latest/rebuild/redeploy/restart/rollback), `requestedCommitSha`, `fetchedCommitSha`, `builtCommitSha`, `imageId`, `imageDigest`, `runningImageDigest`, `taskId`, `containerId`, `verificationStatus` (build_ok/created/running/healthy/reachable/failed), `healthResult` (jsonb).
- `deployment_event`: timeline.
- `diagnostic_report`: engine results (no secrets).
- OAuth plugin tables (clients, tokens, consents), generated then migrated.
- `mcp_settings` (per-organization activation, allowed scopes), `mcp_audit_log`.

> `deployment.status` keeps its current semantics (compatible with the existing UI/API); the "healthy / reachable" truth is carried by `verificationStatus`.

### Target MCP flow

```
MCP client ──POST /mcp (no token)──► 401 + WWW-Authenticate: resource_metadata=…/.well-known/oauth-protected-resource/mcp
          ──GET PRM──► authorization_servers=[https://<instance>/api/auth]
          ──GET AS metadata──► /.well-known/oauth-authorization-server
          ──(CIMD or DCR)──► client_id
          ──/authorize (PKCE S256 + resource=https://<instance>/mcp)──► existing Dokploy login ──► consent screen (scopes checked)
          ──/token──► short-lived token (aud=…/mcp, scopes, user, org)
          ──POST /mcp + Bearer──► guard: token ✓ audience ✓ scope ✓ Dokploy permission ✓ project access ✓ → tool → audit
```

**Effective permission = granted scopes ∩ the user's Dokploy permissions ∩ the organization's MCP settings.**

---

## 9. Unverified assumptions (to be resolved during implementation)

- CIMD support in `@better-auth/oauth-provider@1.6.23`.
- Backward compatibility of `@modelcontextprotocol/server@2.x` with 2025-11-25 clients.
- Behavior of `docker swarm init` and the overlay network in Docker-in-Docker on Docker Desktop arm64 (upstream CI does it on Linux).
- Fetch by SHA (`git fetch origin <sha>`) on self-hosted GitLab/Gitea/Bitbucket (depends on `uploadpack.allowReachableSHA1InWant`) → fallback: full clone of the branch, then `checkout <sha>`.

---

## 10. Target local environment (macOS)

Observed machine: macOS 26.2, Apple Silicon (arm64), 16 GB RAM, Docker Desktop 27.4 (8 GB allocated, Swarm **inactive**), ~168 GB free, Node 20 on the host (Node 24 required), corepack/pnpm broken on the host. Ports in use: **80** (httpd), **5432** (Postgres), **8080** (existing container). Free: 443, 3000, 6379.

**Proposal: a Docker-in-Docker "devbox"**, derived from the official `.devcontainer`:

- A single privileged `dokploy-dev` container with **its own Docker daemon** (data in a dedicated volume), Node 24.22.1, pnpm 10.22, nixpacks, railpack.
- `docker swarm init`, `dokploy-network`, Traefik and Postgres are created **inside it** → the host's Docker Desktop is not switched to Swarm mode and existing containers are left alone.
- `node_modules` in a Linux volume (avoids mixed darwin/linux binaries).
- Ports exposed on `127.0.0.1` only: `3000` (UI), `8880` → Traefik 80, `8443` → Traefik 443.
- Test applications reachable at `http://<app>.docker.localhost:8880`.
- `scripts/dev-{start,stop,reset,test}.sh` scripts; `dev-reset` asks for confirmation before deleting any volume.

**Local OAuth/MCP**: MCP Inspector and Claude Code accept `http://localhost` → **no tunnel needed** for the planned tests. A public HTTPS tunnel would only be useful to connect claude.ai (web), and will only be set up with explicit approval.
