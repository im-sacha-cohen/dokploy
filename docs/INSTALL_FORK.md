# Installing this fork on a server

This fork replaces the `dokploy` Swarm service image. Everything else of a
standard Dokploy installation (Postgres, Redis, Traefik, `/etc/dokploy`, your
projects) stays as is. Migrations `0199` to `0201` are additive: they only add
columns and tables.

> **Not tested yet on a real server.** The image is built by GitHub Actions; the
> install script was only checked on Ubuntu 24.04 arm64 for its arguments and
> guards. Everything else was tested on the local devbox (see `TESTING.md`).
> Try it on a non-critical server first.

## Quick install (Ubuntu 22.04/24.04, amd64 or arm64)

On the server, as root:

```bash
curl -sSL https://raw.githubusercontent.com/im-sacha-cohen/dokploy/feat/smart-deploy-mcp/scripts/install-fork.sh \
  | sudo bash -s -- --domain panel.example.com
```

What the script does:
- **No Dokploy yet**: runs the official installer, then switches to the fork.
- **Dokploy already there**: backs up the database and `/etc/dokploy` to
  `/root/dokploy-fork/`, records the current image, then switches.
- Pulls `ghcr.io/im-sacha-cohen/dokploy:smart-deploy`. This multi-arch image is
  built by `.github/workflows/fork-image.yml` on every push to
  `feat/smart-deploy-mcp`.
- Sets `DOKPLOY_MCP_RESOURCE_URL=https://<domain>/mcp`, then waits until
  Dokploy answers.

`--domain` is the panel's public HTTPS host. Leave it out on a fresh server,
set the domain in Settings › Web Server, then run the script again with it.

Roll back to the recorded official image:

```bash
curl -sSL https://raw.githubusercontent.com/im-sacha-cohen/dokploy/feat/smart-deploy-mcp/scripts/install-fork.sh \
  | sudo bash -s -- --rollback
```

The manual steps below do the same thing by hand.

## 1. Prerequisites

- A Linux server (x86_64 or arm64) where Dokploy is installed with the official
  script, or a fresh server where you will install it first (step 3).
- Root SSH access.
- **A domain for the Dokploy panel, with HTTPS** (Settings › Web Server ›
  Domain), for example `panel.example.com`. It is required for MCP clients such
  as claude.ai, which only reach `https://` URLs.
- To build on the server: about 4 GB of RAM (or swap) and 10 GB of free disk.

**Versions.** This fork is based on upstream `canary` at `46a0762` (v0.30.11).
Check the server's current image:

```bash
docker service inspect dokploy --format '{{.Spec.TaskTemplate.ContainerSpec.Image}}'
```

If the server runs an older release, switching also brings every upstream
change up to that `canary` commit. Write down the current tag: it is your
rollback target.

## 2. Back up

```bash
docker exec $(docker ps -qf name=dokploy-postgres) \
  pg_dump -U dokploy dokploy > /root/dokploy-backup-$(date +%F).sql
tar czf /root/etc-dokploy-$(date +%F).tgz /etc/dokploy
```

## 3. Fresh server only: install the official Dokploy

```bash
curl -sSL https://dokploy.com/install.sh | sh
```

Then:
1. Open `http://<server-ip>:3000` and create the admin account.
2. Set the panel domain with HTTPS in Settings › Web Server.

The script stores the database password and `BETTER_AUTH_SECRET` as Docker
secrets; the fork reuses them.

## 4. Build the fork's image

### Option A: on the server (simplest, single-node Swarm)

```bash
git clone -b feat/smart-deploy-mcp https://github.com/im-sacha-cohen/dokploy.git
cd dokploy
docker build -t dokploy-fork:smart-deploy .
```

The branch must have been pushed to that repository first.

### Option B: on another machine, through a registry (needed for multi-node Swarm)

```bash
docker buildx build --platform linux/amd64 \
  -t ghcr.io/<you>/dokploy:smart-deploy --push .
```

Then, on the server, `docker login ghcr.io` if the image is private.

## 5. Switch the Dokploy service to the fork

```bash
docker service update \
  --image dokploy-fork:smart-deploy \
  --env-add DOKPLOY_MCP_RESOURCE_URL=https://panel.example.com/mcp \
  dokploy
```

Use `ghcr.io/<you>/dokploy:smart-deploy` for option B.

- `DOKPLOY_MCP_RESOURCE_URL` must be the exact public URL of `/mcp`. Without
  it, `/mcp` answers 503: the MCP server is off, the rest works.
- Migrations run at startup. Follow them with:

```bash
docker service logs -f dokploy
```

## 6. Check

```bash
curl -s https://panel.example.com/.well-known/oauth-protected-resource/mcp
curl -s -o /dev/null -w "%{http_code}\n" -X POST https://panel.example.com/mcp
```

The first command returns the `resource` and `authorization_servers` JSON. The
second returns `401`.

In the panel:
- **Settings › AI Integrations**: enable the integration and choose the scopes.
  `mcp:env`, `mcp:manage` and `mcp:exec` are off by default.
- **Settings › DNS**: connect Cloudflare (or another provider) to create DNS
  records from the domain form and from MCP.

## 7. Connect an MCP client

- **claude.ai**: Settings › Connectors › Add custom connector, URL
  `https://panel.example.com/mcp`. Sign in to Dokploy, then tick the
  permissions on the consent screen.
- **Claude Code**:

```bash
claude mcp add --transport http dokploy https://panel.example.com/mcp
```

Destructive actions (delete, stop, restore) and every container command ask for
a confirmation in the client. A client that cannot show one (no MCP
elicitation support) is refused for these actions.

## 8. Updates: do not use the built-in "Update" button

Settings › Web Server › Update runs
`docker service update --image dokploy/dokploy:<version>`, which replaces the
fork with the official image.

To update the fork:
1. Rebuild the image from an updated branch (step 4).
2. Run the `docker service update --image …` command again (step 5).

## 9. Roll back

```bash
docker service update \
  --image dokploy/dokploy:<previous-tag> \
  --env-rm DOKPLOY_MCP_RESOURCE_URL \
  dokploy
```

The columns and tables added by the fork stay in the database and are ignored
by the official version. If anything goes wrong, restore the backup from step 2:

```bash
cat dump.sql | docker exec -i $(docker ps -qf name=dokploy-postgres) \
  psql -U dokploy dokploy
```

## Security notes

- Keep `mcp:manage` and `mcp:exec` off unless you need them. The human
  confirmation relies on the MCP client: a client holding these scopes could
  answer it itself (see `MCP_SECURITY.md`).
- Revoke clients you no longer use in Settings › AI Integrations. Revocation
  takes effect immediately.
- The panel must be served over HTTPS: OAuth tokens and the consent screen go
  through it.
