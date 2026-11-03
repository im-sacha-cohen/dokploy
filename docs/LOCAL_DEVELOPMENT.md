# Local development (macOS / Linux)

The local environment runs in a **Docker-in-Docker devbox**: a single privileged container (`dokploy-devbox`) that embeds **its own Docker daemon**. Swarm, `dokploy-network`, Traefik, Postgres and all the deployed applications live inside that internal daemon.

- The host's Docker daemon (Docker Desktop) is **not switched to Swarm mode**, and the machine's other containers are left alone.
- All ports are bound to `127.0.0.1`. Nothing is exposed on the network.
- Upstream's `.devcontainer/` folder uses the same approach (docker-in-docker).

## Prerequisites

| Tool | Tested version | Note |
|---|---|---|
| macOS | 26.2, Apple Silicon | Intel not tested |
| Docker Desktop | 27.4 (Compose v2.31) | 8 GB of RAM allocated is enough |
| Disk space | ~10 GB | devbox image + build images + `node_modules` |

Node.js, pnpm, nixpacks, railpack and pack are **inside the devbox**. Nothing needs to be installed on the host.

## Commands

```bash
./scripts/dev-start.sh     # build + start, waits for the UI to respond
./scripts/dev-stop.sh      # stop, data kept
./scripts/dev-test.sh      # Vitest tests in the devbox (args passed to vitest)
./scripts/dev-reset.sh     # DELETES the devbox and its volumes (asks for confirmation)
```

Equivalent without the scripts: `docker compose -f docker-compose.dev.yml up -d --build`.

The first start installs dependencies (`pnpm install --frozen-lockfile`, native module compilation) and takes about 5 to 10 minutes. Later starts only reinstall if `pnpm-lock.yaml` has changed.

### What startup does (`dev/devbox/entrypoint.sh`)

1. Starts `dockerd` in the container, with its data in the `dokploy-dev_docker-data` volume.
2. Starts the demo Git server (`dev/git-server.mjs`, internal port 4040) if the demo repositories exist.
3. Creates `apps/dokploy/.env` from `.env.example` if it is missing.
4. Runs `pnpm install`, then `pnpm server:script`, then `pnpm dokploy:setup` (swarm init, network, Traefik, Postgres, migrations; idempotent).
5. Starts `pnpm dokploy:dev` (hot reload: the code is mounted from the host).

> `pnpm server:script` modifies `packages/server/package.json` (exports pointing to `src/`), as in the upstream workflow. **Do not commit this change.**

## Access

| Service | URL |
|---|---|
| Dokploy interface | http://localhost:3000 |
| Applications (via Traefik) | `http://<host>.docker.localhost:8880` |
| Traefik HTTPS | `https://…:8443` |
| Shell in the devbox | `docker exec -it dokploy-devbox bash` |
| Internal Docker | `docker exec dokploy-devbox docker ps` |
| Dev server logs | `docker compose -f docker-compose.dev.yml logs -f devbox` |

Ports are configurable in `dev/.env` (see `dev/.env.example`). The defaults avoid 80, 5432 and 8080, which are often already in use on macOS.

`*.docker.localhost` resolves to `127.0.0.1` in browsers and in curl. To test without DNS: `curl -H "Host: a-healthy.docker.localhost" http://127.0.0.1:8880/`.

## Test account and demo applications

`dev/.env` (gitignored, `chmod 600`) contains the local URL and an owner account **for testing only**, with a random password generated locally.

```bash
docker exec dokploy-devbox /workspace/dev/demo-apps/init-repos.sh   # demo Git repositories
node dev/demo-apps/seed.mjs --deploy                               # project + apps + domains + deployment
```

`seed.mjs` refuses any URL that isn't `localhost` or `127.0.0.1`. It goes through Dokploy's REST API, so through the same code paths as the interface.

| App | Scenario | Result observed with upstream Dokploy (2026-11-02) |
|---|---|---|
| A `a-healthy` | Normal deployment, Docker healthcheck | `done`, service 1/1, HTTP 200 |
| B `b-wrong-port` | Listens on 3000, domain routed to 80 | **`done`**, service 1/1 healthy, **HTTP 502** |
| C `c-crash-loop` | `exit 1` at startup | **`done`**, service 0/1, restart loop, **502** |
| D `d-missing-env` | `DATABASE_URL` and `SESSION_SECRET` missing (exit 78) | **`done`**, 0/1, **502** |
| E `e-outdated` | v1 deployed, then `e-outdated-push-v2.sh` pushes a v2 | `done`, 200 (version scenario to be played) |
| F `f-compose` | web + redis with healthchecks and `depends_on` | `done`, 2 healthy containers, 200 |
| G `g-localhost-bind` | Listens on `127.0.0.1:3000` only | **`done`**, 1/1, **502** |

This table is the baseline before any change: **all 7 deployments are marked `done` while 4 applications are unreachable.**

Application diagnostics: `node dev/demo-apps/diagnose.mjs [filter] [--json]` calls `smartDeploy.diagnoseApplication` on every app of the demo project (see `docs/DEPLOYMENT_DIAGNOSTICS.md`).

Version tracking: `node dev/demo-apps/version-scenario.mjs` plays the full scenario E (deploy latest, push, rollback, restart, rebuild) and checks 22 points (see `docs/SMART_DEPLOY_ENGINE.md`).

For scenario E: `docker exec dokploy-devbox /workspace/dev/demo-apps/e-outdated-push-v2.sh` advances the remote branch without redeploying.

## MCP server locally

- **URL**: `http://localhost:3000/mcp`, the development default for `DOKPLOY_MCP_RESOURCE_URL`.
- **Activation**: Settings › AI Integrations, with the test account.
- **End-to-end test**: `node dev/mcp/oauth-mcp-e2e.mjs` plays discovery, registration, PKCE, consent, tool calls, error cases and revocation.
- **Local client**: `claude mcp add --transport http dokploy http://localhost:3000/mcp`.
- **Remote client** (claude.ai for example): it needs a public HTTPS URL, so a tunnel. It is **not** set up without your approval.

## macOS incompatibilities and workarounds

| Dokploy constraint | Situation on macOS | Solution |
|---|---|---|
| Docker Swarm + overlay | Possible on Docker Desktop, but would modify the shared daemon | Swarm in the devbox's internal daemon |
| Traefik on `host` ports 80/443 | 80 often in use | Ports published on host 8880/8443 |
| Postgres published on 5432 in dev | 5432 often in use | Published only inside the devbox |
| Native `node_modules` (bcrypt, node-pty, ssh2…) | darwin and linux binaries are incompatible | `node_modules` in Linux volumes |
| `.docker/` (dev BASE_PATH: clones, logs, Traefik) | Slow and case-sensitive on a bind mount | `dokploy-dev_dokploy-data` volume |
| Custom Git sources: HTTP(S) required without an SSH key, `--depth 1` | The "dumb" HTTP protocol doesn't handle shallow clones | Small *smart HTTP* Git server (`dev/git-server.mjs`) |

## Not covered by this environment

- Remote servers (multi-node SSH), real Let's Encrypt certificates, HTTP/3.
- Public domains: no tunnel. An HTTPS tunnel (for example to connect claude.ai to `/mcp`) will only be set up with explicit approval.
- Cloud edition (`apps/api`, Inngest) and `apps/schedules` (Redis/BullMQ): not started.

## Troubleshooting

- **The instance no longer starts after a restart, with `could not add service state for endpoint dokploy-traefik-previous`**: upstream's setup renames the Traefik container, and the internal Docker keeps a stale network endpoint. Delete the container so the setup recreates it: `docker exec dokploy-devbox docker rm -f dokploy-traefik`, then `docker restart dokploy-devbox`.
- **App `tsc` killed (`Killed`)**: the full typecheck and the dev server don't fit together in the devbox's memory. Run `tsc` right after restarting the devbox.
- **Changes in `packages/server` not picked up**: the dev server (`tsx server/server.ts`) doesn't hot-reload the deployment queue. Run `docker restart dokploy-devbox`.
- **After modifying `dev/devbox/Dockerfile`**: `./scripts/dev-start.sh` rebuilds the image. The entrypoint is read from the mounted repository; an image older than 2026-11-02 embedded a frozen copy of it and must be rebuilt.

- **The devbox stops at startup**: check `docker compose -f docker-compose.dev.yml logs devbox`, then `docker exec dokploy-devbox tail -50 /var/log/dockerd.log` for the internal daemon.
- **Port already in use**: `dev-start.sh` reports it. Change it in `dev/.env`.
- **Start from scratch**: `./scripts/dev-reset.sh`. It lists the affected volumes and requires typing `delete`.
