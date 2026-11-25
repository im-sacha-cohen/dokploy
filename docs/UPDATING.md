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

## Ways to update

| | Install command | Update button | Scheduled updates |
|---|---|---|---|
| Where | SSH on the server | Settings › Web Server › Update | Settings › Web Server › Scheduled Dokploy updates |
| When | when you run it | when you click | in a weekly window you choose |
| Database backup first | **yes** | **yes**, with the updater (see below) | **yes** |
| Goes back by itself if the new version does not stay healthy | image only | **yes**: image, database and `/etc/dokploy` | **yes**: image, database and `/etc/dokploy` |
| Available | always | the updater: once the server runs a fork build from 2026-11-25 or later | same |

**The first update to a build from 2026-11-25 or later goes through the
install command or the button without the updater**: the build that runs
before has no `/app/dokploy-updater.sh`. Every update after that one uses it.
Use the install command for the first update after 2026-11-23: it also sets
the variables the Update button needs (`DOKPLOY_IMAGE`, `RELEASE_TAG`).

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

1. Settings › Web Server › Update. The dialog shows the commits
   (`current → latest`) and a link to the changes. Confirm.
2. When the running build has the updater, the button starts it: backups
   first, then the new version, put back if it does not stay healthy. The
   run shows in the history of Scheduled Dokploy updates. On an older build,
   the button switches the image directly: take a database backup first
   (`pg_dump`, as in the install command section) and, if the panel does not
   come back, run `docker service rollback dokploy` on the server.
3. The page reloads when the new version answers. Check as above.

## Scheduled updates

Settings › Web Server › **Scheduled Dokploy updates**, and for an application
deployed from a Docker image, its **Advanced** tab › **Scheduled updates**.
Every rule starts off; nothing is checked or updated until it is turned on.

- **When an update is found**: *Notify me* sends one notification per new
  version (events *Dokploy Update* and *Application Update* in Settings ›
  Notifications); *Update automatically* installs it in the window.
- **Versions to follow**: *Same tag, new build* follows the tag in use
  (`latest`, the fork's `smart-deploy`); *Patch*, *Minor* and *All versions*
  move a version tag (`1.25.3 → 1.25.4`) and keep its form (`-alpine` stays).
- **Maintenance window**: days, start time, length and time zone. An
  application window must stay 60 minutes away from the Dokploy window, on
  both sides: if a Dokploy update failed, restoring its database backup would
  forget an application update made meanwhile. Saving a rule that breaks this
  is refused, with a free start time suggested.
- **Safety delay**: a release is installed once it is this old (72 hours by
  default).
- **Watch after updating**: how long the new version must stay healthy.
- **Backups to run first** (applications): database or compose backups of
  the same environment. If one fails, the update does not start.

In a window, an update waits while deployments, backups or other updates run,
retrying every 5 minutes until the window closes. A build that failed once is
not tried again; the next one is. Each attempt, skip and notice is listed in
the card's history.

**Applications** are deployed through the usual deployment queue. The update
counts as good when Smart Deploy finds the new version running (and healthy
and reachable when it has a health check and a domain), and the same
container still runs after the watch time. Otherwise the previous image,
pinned to its digest, is deployed again. Private images use the registry
credentials set on the application.

**Going back later.** Under *Go back to before an update*, the last successful
Dokploy updates whose backup is still kept can be undone: Dokploy runs the
previous image again, with the database and configuration saved before that
update. **Changes made in the panel since then are lost**; the current state
is saved first.

## The updater

Fork builds from 2026-11-25 or later ship `/app/dokploy-updater.sh`. The
Update button and the scheduled updates use it, and it can be run by hand. It runs in a
container of its own, started from the image that works now, so it is still
there while the panel restarts:

```bash
CURRENT=$(docker service inspect dokploy --format '{{.Spec.TaskTemplate.ContainerSpec.Image}}')
docker run -d --rm --name dokploy-updater \
  -v /var/run/docker.sock:/var/run/docker.sock -v /etc/dokploy:/etc/dokploy \
  "$CURRENT" bash /app/dokploy-updater.sh --target ghcr.io/im-sacha-cohen/dokploy:smart-deploy
docker logs -f dokploy-updater
```

The updater:

1. pins the tag to the digest it points to now, and stops if Dokploy already
   runs it;
2. checks the free space, then saves the service spec (image digest,
   variables, mounts, ports), the database and `/etc/dokploy`, except
   application and compose files and logs. If any of this fails, it stops
   before changing anything;
3. switches the service to the new image, and waits for the panel to answer
   without interruption for 5 minutes (10 minutes at most to start);
4. otherwise **puts everything back**:
   - stops the panel;
   - restores the database and `/etc/dokploy`, writing files in place so
     that Traefik sees them;
   - restores the saved spec as it was;
   - checks that the panel answers again.

Progress is in `/etc/dokploy/updates/state.json`. Each run has a folder in
`/etc/dokploy/updates/runs/<run>/` (backup, spec, `updater.log`); the last 5
are kept. Exit codes: 0 done, 1 refused before any change, 2 failed and put
back, 3 putting back failed, 4 another updater is running.

**The server restarted, or the updater was stopped, during an update.**
`state.json` still shows `updating`, `verifying` or `restoring`, the panel
marks the run *Interrupted* and no other update starts. If the panel answers,
use **Resume and put back** in Scheduled Dokploy updates. Otherwise, put back
what ran before that run (start the updater from the image of the previous build,
`fromImage` in `state.json`, if the current one does not start):

```bash
docker run --rm -v /var/run/docker.sock:/var/run/docker.sock -v /etc/dokploy:/etc/dokploy \
  "$(grep -o '"fromImage":"[^"]*"' /etc/dokploy/updates/state.json | cut -d'"' -f4)" \
  bash /app/dokploy-updater.sh --resume
```

**An update succeeded, but the new version turns out broken.** Go back to the
state saved just before it, using the run name from `/etc/dokploy/updates/runs/`.
**Changes made in the panel since that run are lost.** The state before the
rollback is saved first, in the rollback's own run folder:

```bash
docker run --rm -v /var/run/docker.sock:/var/run/docker.sock -v /etc/dokploy:/etc/dokploy \
  "$CURRENT" bash /app/dokploy-updater.sh --rollback <run>
```

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

`dev/install/dokploy-updater-e2e.sh` runs the updater the way the panel will
start it, in a throwaway Swarm with a real Postgres and a Traefik stand-in
bind-mounting `/etc/dokploy/traefik`. It covers:

- a good update, with the image pinned to its digest, the variables kept, and
  nothing to do on a second run;
- builds that crash, crash after changing the database and `/etc/dokploy`, or
  stop answering after 20 seconds. Each time the exact previous spec, the
  database and the configuration are back;
- refusals before any change: no database, not enough disk space;
- a second updater refused while one runs;
- an updater killed mid-way, then `--resume`;
- `--rollback` to the state before an earlier run;
- keeping only the last runs.

None of these tests replaces a first update on your own server: keep the backup until you
have checked the panel.
