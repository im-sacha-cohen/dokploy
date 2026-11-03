# Smart Deploy Engine

Code: `packages/server/src/smart-deploy/` (server) and `apps/dokploy/components/dashboard/application/smart-deploy/` (UI). This document covers:
- the **preflight analysis**;
- the **deployment flow** in the interface;
- **fixes** and how they are validated;
- **version tracking**;
- **deployment actions**;
- **post-deployment verification**.

Diagnostics are documented in `DEPLOYMENT_DIAGNOSTICS.md`.

## Interface: highlighted errors and ports

Added after Phase 7, at your request. The display logic is pure, and tested (`diagnostics/presentation.ts`).

| Where | What |
|---|---|
| **Status banner** above the application tabs, visible on **all** tabs | It appears if the app is *down* or *degraded*. It shows a single cause: the root cause (`pickRootCause`), not its consequences (you see "wrong port", not "502 Traefik"). It offers one primary action: the confirmed fix if it can be automated, otherwise "Set DATABASE_URL…", which opens the Environment tab. It also links to the full diagnostic and has a button to re-check |
| **"Network path" card** in the Smart Deploy and Domains tabs | For each domain: Domain → Traefik (actual response) → targeted port → ports actually listening (`0.0.0.0` or `127.0.0.1`, `EXPOSE`). Each link is green, red or "unknown" (never green without a measurement), with the port fix button on the faulty row and the ports published on the host |
| **Domains tab** | Badge per domain: "Reachable", "Unreachable · wrong port", "app not listening" or "Not verified". In the form, under "Container Port": the port actually listening, an alert if it differs, and a "Use 3000" button |
| **Deployments tab** | Next to upstream's "done": "Build OK · App did not start", "Running but unhealthy or unreachable", "Verified healthy"… |

The banner, card, badges and port helper share **a single diagnostic query** (30 s cache): displaying the page does not launch several diagnostics. Additions to upstream code: 35 lines, without modifying any existing line.

## Interface: "Smart Deploy" tab

New tab on the Application page, visible with the `deployment.read` permission. The existing tabs (General, Environment, Domains, Deployments, Advanced…) are unchanged: advanced settings stay where they were.

**"Current deployment" card**:
- Status (live): live diagnostic verdict.
- Last deployment check: result of the verification done at deployment time.
- Branch; running commit (only if proven by the exact image); latest remote commit ("Not verified", with the reason, if the Git check failed).
- Running image, replicas, version state, matching method.
- Deploy latest action (marked *recommended* if the version is outdated) and Restart.
- Version history, with Redeploy / Roll back per row. Hidden for the image already running.

**5-step wizard**:

| Step | Content |
|---|---|
| 1. Source | type, repository (without credentials), branch; link to General |
| 2. Configuration | build type, Dockerfile, domains and ports, variable **names** (never values), healthcheck; links to Environment, Domains, Advanced |
| 3. Preflight | repository analysis (below), then the Deploy latest button. The confirmation flags blocking problems, or a preflight that was not run |
| 4. Deployment | real timeline (started, build, container created, running, healthy, reachable) refreshed every 2 s, with the build logs (existing viewer) |
| 5. Result | full diagnostic: verdict, findings with evidence, cause, confidence, risk; "Apply fix" button for automatic fixes; otherwise a link to the relevant tab; list of what could not be verified |

Every action (deploy, restart, redeploy/rollback, fix) goes through a confirmation dialog that describes the exact change and its risk.

## Preflight

`smartDeploy.preflight({ applicationId })` (read permission):
1. Shallow clone of the configured branch into `…/smart-deploy/preflight/<app>-<random>`, using the provider's existing clone function, so with the same credentials. The folder is deleted on exit (`trap … EXIT`), on success or failure. For a `drop` source, the existing code folder is read; for `docker`, nothing is analyzed.
2. Reads manifests (size ≤ 64 KB): `package.json`, `requirements.txt`, `pyproject.toml`, `go.mod`, `Gemfile`, `composer.json`, `Procfile`, Compose files, the configured Dockerfile, `.env.example`. **`.env` is never read.**
3. `git grep` for environment variable references (Node, Python, Go, Ruby, Rust, PHP) and listen lines (`listen(`, `app.run(`, `--host`, health routes).
4. Pure analysis (`preflight/analyze.ts`): nothing from the repository is built or executed.

Each detection carries a **confidence** and its **source**:
- **Detections**: language, framework, package manager, Dockerfile (EXPOSE, HEALTHCHECK, CMD), Compose (services), build and start commands, expected ports (EXPOSE, default value in code, `--port`/`--bind` option, framework default port), referenced, documented, configured and missing variables, healthcheck.
- **Checks**:
  - `BUILD_CONFIGURATION_MISMATCH`: build type ≠ repository contents;
  - `PORT_MISMATCH`: domain port not among the expected ports;
  - `MISSING_ENVIRONMENT_VARIABLE`;
  - `APPLICATION_LISTENING_ON_LOCALHOST`: bind to 127.0.0.1, or Flask `app.run()` without host;
  - `NO_HEALTHCHECK`;
  - `COMPOSE_PROJECT`;
  - `NO_DOMAIN`;
  - `SOURCE_UNAVAILABLE`.

`ENV` values from the Dockerfile, `.env.example` and commands go through the *redactor*; only names come out. Measured on the demo apps: 90 to 250 ms per analysis.

## Fixes: never arbitrary

`smartDeploy.applyFix({ applicationId, action })`:
1. Checks the matching permission: `domain.create` for a port, `deployment.create` for a deployment.
2. **Re-runs a diagnostic** and only accepts the action if a *current* finding proposes it with `autoFixable: true`, identically (`findProposedFix`). A UI, or later an MCP client, therefore cannot submit an arbitrary change.
3. Applies the fix:
   - `update_domain_port`: changes **only** the domain's port (which must belong to the application), then regenerates its Traefik route;
   - `deploy_latest` / `redeploy_deployment`: goes through the deployment queue.
4. Writes an audit entry.

Missing environment variables are **never** fixed automatically: the values are secrets only the user knows. The UI opens the Environment tab.

## Problem fixed

In upstream Dokploy:
- A deployment becomes `done` as soon as `docker service update` is accepted. An app in a crash loop or unreachable is therefore shown as "successful".
- The commit is only kept as text (`description: "Commit: <sha>"`) and only *after the fact*.
- All images are named `<app>:latest`: there is no way to know which version is actually running.
- "Rebuild" rebuilds the existing code folder, without saying so.
- Rollback only exists with a registry.

## Data recorded per deployment

Migration `0199_smart_deploy_version_tracking`. It adds 16 **nullable** columns to `deployment`, with no default value: existing rows and unmodified upstream paths (Compose, previews) remain valid.

| Field | Meaning | Source |
|---|---|---|
| `kind` | `deploy_latest`, `rebuild`, `redeploy`, `rollback` or `restart` | action actually executed |
| `sourceRepository`, `sourceBranch` | repository (**credentials removed** from the URL) and branch | configuration |
| `requestedCommitSha` | what was requested: remote head at request time (deploy latest, read by the deployment queue before calling `deployApplication`) or the commit of the redeployed version | provider API or `git ls-remote` |
| `fetchedCommitSha` | what the clone actually fetched (`null` if nothing was fetched) | `git rev-parse HEAD` after clone |
| `builtCommitSha` | commit of the code used for the build | `git rev-parse HEAD` of the build folder |
| `imageId` | content identifier of the produced image (`sha256:…`) | `docker image inspect` |
| `imageDigest` | registry digest (`repo@sha256:…`), only if the image was pushed or pulled | `RepoDigests` |
| `imageTag` | retained tag `dokploy-versions/<app>:dpl-<deploymentId>` (redeployable) | `docker tag` |
| `runningImageId`, `containerId`, `taskId` | what is actually running after deployment | Swarm task + `container inspect` |
| `verificationStatus`, `verification` | result of the step-by-step verification (below) | observation |
| `sourceDeploymentId` | for redeploy, rollback and restart: the original version | action |

If the working tree is modified (Dokploy patches applied), `verification.sourceDirty` flags it: the build then does not exactly match the commit.

Tracking can **never** make a deployment fail: each capture step catches and logs its own errors.

## Actions: each does what its name says

| Action | What happens | Git | Build | Endpoint |
|---|---|---|---|---|
| **Deploy Latest** | clones the branch head, builds, updates the service | yes | yes | `application.deploy` (upstream, now tracked) |
| **Rebuild** | rebuilds the **existing code folder** (the last clone), without fetching | no | yes | `application.redeploy` (upstream, tracked: `builtCommitSha` states exactly what was rebuilt) |
| **Redeploy** | puts the **exact image** of a previous or current deployment back into service | no | no | `smartDeploy.redeployVersion` |
| **Rollback** | same mechanism, to a version **older** than the running one; the type is determined automatically | no | no | `smartDeploy.redeployVersion` |
| **Restart** | restarts the containers with the current Swarm spec (`ForceUpdate` increment), without rebuilding or reapplying the configuration | no | no | `smartDeploy.restartApplication` |

Upstream's "Reload" (`application.reload`) is kept as is. It reapplies the configuration, which makes it a "config redeploy" rather than a simple restart.

### Redeploy and rollback without a registry

- Each successful build is tagged `dokploy-versions/<app>:dpl-<deploymentId>`. This is a separate image repository, so that `docker images <app>` stays identical to upstream. The **last 5** tagged images are kept; older ones are untagged with `docker image rm`, without `-f`, so an image in use is never removed.
- Before redeploying, the tagged image's ID is compared with `imageId`: a modified image is refused.
- The configuration used is the **current** one (environment variables, ports, mounts). Upstream's registry-based rollback, by contrast, restores the full previous configuration.
- Not available (explicit refusal) when the application uses a registry, a separate build server or a `docker` source. Upstream's registry rollback remains usable in those cases.

## Post-deployment verification

Started in the background at the end of each action; the deployment queue does not wait. Each step is recorded separately:

| Step | Succeeds when |
|---|---|
| `build` | the build command succeeded (`not_applicable` for redeploy, rollback and restart) |
| `containerCreated` | a task of the **new** spec (same `ForceUpdate`, created after the deployment) has a container |
| `containerRunning` | that task has been `running` for ≥ 10 s. **Fails** as soon as 2 tasks have failed with no active task, or 3 in total |
| `healthy` | Docker healthcheck `healthy`; `not_applicable` without a healthcheck, in which case the app is **not declared healthy** |
| `reachable` | no `REVERSE_PROXY_UNREACHABLE` according to the Traefik probes; `not_applicable` without a domain |

**Deadline**: 120 s, extended according to the healthcheck (`start_period + interval × (retries+1)`, 10 min max).

**Overall status** (`verificationStatus`):

| Status | Meaning |
|---|---|
| `healthy` | all steps passed, healthcheck included |
| `running` | the app is running and responding, but no healthcheck could prove it |
| `degraded` | the app is running, but it is unhealthy or unreachable |
| `failed` | the build or startup failed |
| `unknown` | the verification was interrupted (newer deployment, error, server restart) |

At the end, the diagnostic engine runs and the codes found are recorded in `verification.findings`.

`deployment.status` keeps upstream semantics (`done` = build and update accepted), to stay compatible with the existing UI and notifications. **`verificationStatus` is what says whether the application works.**

## Version status

`smartDeploy.getVersionStatus({ applicationId, checkRemote })` returns:
- **Live**: running tasks, container, `runningImageId`.
- **Current**: the deployment whose `imageId` = the image actually running (`currentMatch: "image_match"`). Failing that, the last successful deployment is returned with `currentMatch: "latest_successful"`: the running commit is then declared **unknown**.
- **Latest remote**: branch head checked via the provider API (GitHub, GitLab, Gitea, Bitbucket, with the credentials already configured) or `git ls-remote` (custom Git, HTTP(S) or SSH with the configured key, written to a temporary file deleted on exit). On failure, `status: "error"` with the reason: **a commit is never assumed**.
- `versionState`: `up_to_date`, `outdated`, `unknown` or `not_applicable`, with an explanation.
- `recommendedAction`: `deploy_latest`, `diagnose` or `none`.
- `history`: the last 20 deployments with their version fields and `redeployable`.

Two diagnostic rules use this data:
- `GIT_COMMIT_OUTDATED`: the running commit differs from the **verified** remote head. Proposed fix: `deploy_latest`.
- `IMAGE_VERSION_MISMATCH`: the last `done` deployment recorded a different image from the one running. Proposed fix: `redeploy_deployment`.

## Measured results (devbox, 2026-11-02)

`node dev/demo-apps/version-scenario.mjs` plays scenario E: deploy latest → push → outdated → deploy latest → rollback → restart → rebuild. **22/22 checks passed**, notably:
- requested commit = fetched = built, tagged image, `healthy` verification;
- after a push: `outdated` with the actually verified remote commit, and `GIT_COMMIT_OUTDATED` diagnostic;
- rollback: no Git fetch, image identical to deployment 1, **running image actually verified**, old version served;
- restart: same image, same version served;
- rebuild: `fetchedCommitSha = null`, `builtCommitSha` = commit of the last clone (explicit).

Verification of the failing apps, all `done` in upstream status:

| App | verificationStatus | Steps | Findings |
|---|---|---|---|
| A | healthy | all passed | — |
| B | degraded | running ✓, healthy ✓, reachable ✗ | PORT_MISMATCH, REVERSE_PROXY_UNREACHABLE |
| C | failed | running ✗ | CONTAINER_CRASH_LOOP |
| D | failed | running ✗ | MISSING_ENVIRONMENT_VARIABLE, CONTAINER_CRASH_LOOP |
| G | degraded | running ✓, healthy n/a, reachable ✗ | APPLICATION_LISTENING_ON_LOCALHOST, REVERSE_PROXY_UNREACHABLE |

The first attempt, for G, only reported the consequence: the final diagnostic ran before the 20 s grace period of the listening rules. The verification now waits for that delay; the result above comes from the second attempt.

## Limitations

- **Compose** and **previews** are not tracked: they keep upstream behavior.
- **Rebuilding a specific commit**: not implemented. Rebuild rebuilds the last clone, and says so. To go back to an earlier version, use Redeploy/Rollback (retained image).
- **Restart**: the Swarm spec references `<app>:latest`. If `latest` was moved without updating the service, the restart launches the new image; `IMAGE_VERSION_MISMATCH` flags it.
- **Multi-node Swarm with a registry**: the image ID is measured on the build server, and the registry digest is only available after a push.
- **`docker image prune --all`** (Dokploy's "Clean all images" cleanup) removes retained images that are not in use. Redeploy detects this and refuses with a clear message.
- **Interruption**: a verification interrupted by a Dokploy restart stays `verifying`. It is shown as `unknown` after 15 min.
- **Webhooks**: the pushed SHA is not used yet. `requestedCommitSha` is the branch head read at deployment time.
- **Dokploy Cloud**: `redeployVersion` is refused (upstream's remote execution path does not know this job type).

## Compose stacks and databases (2026-11-03)

Smart Deploy is available on every service type:
- a **status banner** above the tabs;
- a **Smart Deploy tab**:
  - findings, each with its service for compose stacks;
  - confirmed fixes;
  - the services table of a stack;
  - the network path domain → service → port;
  - database facts: configured and running image, internal port listening, external port published.

Applications additionally keep the wizard, the preflight, the timeline and commit-level version tracking. Rules and collection details: `DEPLOYMENT_DIAGNOSTICS.md`.
