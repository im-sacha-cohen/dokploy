# Updating a server that runs the fork

This guide is for a server where Dokploy (official or this fork) is already
installed. It covers what is kept, how to update, how to check, and what to do
if something goes wrong.

## What is kept

Nothing is deleted by an update:

- **Your applications, databases and their volumes keep running.** Only the
  `dokploy` service (the panel) is replaced. Traefik is not restarted, so
  domains keep answering.
- **Dokploy's own database** (the `dokploy-postgres` service and its volume)
  is kept. At startup, the new version runs its migrations, which only add
  columns and tables. The fork's migration (`0203`) can run again safely on a
  server that already has its tables.
- **`/etc/dokploy`** (Traefik configuration, certificates, SSH keys) is kept.

The panel is unavailable for one to three minutes while the new image starts.

## Two ways to update

| | Install command | Update button |
|---|---|---|
| Where | SSH on the server | Settings › Web Server › Update |
| Database backup first | **yes**, automatic | no: take one yourself (below) |
| Goes back by itself if the new version does not start | **yes** | no: Swarm pauses the update |
| Available | always | once the server runs a fork build from 2026-11-23 or later |

**Use the install command for the first update after 2026-11-23**: it also
sets the variables the Update button needs (`DOKPLOY_IMAGE`, `RELEASE_TAG`).
Afterwards, either works.

## Update with the install command

### 1. Before

```bash
df -h /    # keep at least 5 GB free: the image is a 0.8 GB download, larger once unpacked
docker service inspect dokploy --format '{{.Spec.TaskTemplate.ContainerSpec.Image}}'
```

Note the image shown: it is what the server goes back to if the update fails.

### 2. Run

```bash
curl -sSL https://raw.githubusercontent.com/im-sacha-cohen/dokploy/feat/smart-deploy-mcp/scripts/install-fork.sh \
  | sudo bash -s -- --domain panel.example.com
```

Use your panel's domain. The script:

1. backs up Dokploy's database to `/root/dokploy-fork/dokploy-<date>.sql` and
   `/etc/dokploy` to `/root/dokploy-fork/etc-dokploy-<date>.tgz`, and stops
   if the backup fails;
2. pulls the new image;
3. switches the `dokploy` service to it;
4. waits up to 7 minutes for the panel to answer (migrations run here);
5. if the panel does not answer, **goes back to the image that ran before**
   (the exact previous build, with its variables) and says so.

### 3. Check

- Sign in to the panel. Settings › Web Server shows the version.
- Open a service: the status banner and the Smart Deploy tab are there.
- MCP: `curl -s https://panel.example.com/.well-known/oauth-protected-resource/mcp`
  returns JSON.
- **Traefik**: Settings › Web Server › Traefik › **Check Version**, then update.
  Dokploy updates do not update Traefik; v3.7.19 fixes six security
  advisories.

## Update with the button

1. Take a backup first:

   ```bash
   sudo mkdir -p /root/dokploy-fork && \
   docker exec $(docker ps -qf name=dokploy-postgres) pg_dump -U dokploy dokploy \
     | sudo tee /root/dokploy-fork/dokploy-$(date +%Y%m%d-%H%M%S).sql >/dev/null
   ```

2. Settings › Web Server › Update. The dialog shows the commits
   (`current → latest`) and a link to the changes. Confirm.
3. The page reloads when the new version answers. Check as above.

If the panel does not come back after a few minutes, run
`docker service rollback dokploy` on the server: it restores the previous image
and its variables.

## If something goes wrong

**The update failed and the script went back by itself.** Dokploy runs the
previous build; nothing else to do. The script printed the last logs; send
them in an issue, or see them again with
`docker service logs dokploy --tail 100`.

**The panel does not answer at all.**

```bash
docker service ps dokploy --no-trunc | head      # why tasks stop
docker service logs dokploy --tail 100
docker service rollback dokploy                  # previous image and variables
```

**Data looks wrong after an update** (rare: migrations only add). Restore the
backup taken just before, then go back to the image that matches it:

```bash
PG=$(docker ps -qf name=dokploy-postgres)
BACKUP=$(ls -t /root/dokploy-fork/dokploy-*.sql | head -1)   # or pick one
docker service scale dokploy=0
docker exec "$PG" psql -U dokploy -d postgres -c "DROP DATABASE dokploy WITH (FORCE)"
docker exec "$PG" psql -U dokploy -d postgres -c "CREATE DATABASE dokploy OWNER dokploy"
docker exec -i "$PG" psql -U dokploy -d dokploy -v ON_ERROR_STOP=1 < "$BACKUP"
docker service rollback dokploy      # the image that ran when the backup was taken
docker service scale dokploy=1
```

`/etc/dokploy` can be restored the same way from its archive
(`tar xzf /root/dokploy-fork/etc-dokploy-<date>.tgz -C /`), with the panel
scaled to 0.

**Back to the official Dokploy.** The fork's extra tables stay in the database
and are ignored by the official version:

```bash
curl -sSL https://raw.githubusercontent.com/im-sacha-cohen/dokploy/feat/smart-deploy-mcp/scripts/install-fork.sh \
  | sudo bash -s -- --rollback
```

This goes back to the official image recorded before the first switch to the
fork. If that image is older than the database (official migrations ran
since), install the current official version instead:
`docker service update --image dokploy/dokploy:latest --env-rm DOKPLOY_IMAGE --env-rm RELEASE_TAG dokploy`.

## What was tested

`dev/install/install-fork-e2e.sh` runs the install script in a throwaway
Docker Swarm with a real Postgres: switch from an official image to a fork
build (backup taken, variables set), a broken build refused with a return to
the previous fork build (not the official image), `--rollback`, and the
database restore above. `dev/migrations/upgrade-e2e.sh` checks the migrations
from a server on the fork, a server on official Dokploy and an empty database.
Neither replaces a first update on your own server: keep the backup until you
have checked the panel.
