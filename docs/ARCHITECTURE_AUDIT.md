# Audit d'architecture — Dokploy (fork Smart Deploy + MCP)

- **Base auditée** : `Dokploy/dokploy`, branche `canary`, commit `46a0762` (31/10/2026), version `v0.30.11`
- **Date** : 02/11/2026
- **Méthode** : lecture du code uniquement (aucune exécution à ce stade). Chaque affirmation renvoie à un fichier ; les points non vérifiés sont signalés comme tels.

---

## 0. Licence, contribution, prérequis

| Sujet | Constat | Source |
|---|---|---|
| Licence | Apache 2.0 pour tout le code **hors** dossiers `/proprietary`. Les dossiers `/proprietary` sont sous *Dokploy Source Available License* : modification autorisée pour dev/test, **usage en production soumis à un accord commercial**, redistribution interdite. | `LICENSE.MD`, `LICENSE_PROPRIETARY.md` |
| Dossiers propriétaires | `packages/server/src/services/proprietary/` (audit-log, forward-auth, license-key, sso, whitelabeling), `apps/dokploy/server/api/routers/proprietary/`, `apps/dokploy/components/proprietary/` | — |
| Branche de dev | `canary` (PR ciblent `canary`, `main` = stable) | `CONTRIBUTING.md` |
| Conventions | Conventional Commits, Biome (format + lint), commentaires « why » uniquement | `CONTRIBUTING.md`, `CLAUDE.md` |
| Node / pnpm | Node `24.22.1` (`.nvmrc`, `engines`), pnpm `10.22.0` | `package.json` |
| Démarrage dev | `pnpm install` → `pnpm dokploy:setup` (swarm init, réseau, Traefik, Postgres) → `pnpm server:script` → `pnpm dokploy:dev` (port 3000) | `CONTRIBUTING.md` |
| MCP officiel | Existe **hors repo** (`github.com/Dokploy/mcp`), généré depuis `openapi.json`, authentification par **clé API admin** statique | `.github/workflows/dokploy.yml:218-238` |

**Règle adoptée pour le fork : ne jamais modifier un fichier sous `/proprietary`.** Toute nouvelle fonctionnalité vit dans des modules Apache 2.0.

---

## 1. Architecture actuelle

```
apps/dokploy          Next.js 16 (pages router) + serveur HTTP custom (server/server.ts)
 ├─ pages/api/trpc     tRPC (UI)                 ┐
 ├─ pages/api/[...trpc] REST/OpenAPI (x-api-key) ├─ même logique : routers tRPC
 ├─ pages/api/auth     better-auth               ┘
 ├─ pages/api/deploy   webhooks Git / registry
 ├─ server/wss         WebSockets (logs build, logs conteneur, terminal…)
 ├─ server/queues      file de déploiement EN MÉMOIRE (pas de Redis)
 └─ drizzle/           200 migrations SQL (drizzle-kit)
packages/server       Logique métier partagée (@dokploy/server)
 ├─ services/          CRUD + orchestration (application.ts, compose.ts, deployment.ts…)
 ├─ utils/builders     nixpacks, railpack, dockerfile, buildpacks, static
 ├─ utils/providers    clone GitHub/GitLab/Gitea/Bitbucket/git
 ├─ utils/traefik      fichiers dynamiques Traefik par application
 ├─ utils/docker       spec Swarm, labels compose, utilitaires inspect
 ├─ lib/auth.ts        better-auth 1.6.23
 └─ db/schema          Drizzle (Postgres 16)
apps/api              Service cloud (Hono + Inngest) — non utilisé en self-hosted
apps/schedules        Cron BullMQ/Redis (backups) — Redis uniquement ici
apps/monitoring       Agent métriques (Go)
```

**Runtime** : toutes les applications tournent en **services Docker Swarm** (pas `docker run`). Traefik tourne en conteneur standalone `dokploy-traefik` sur le réseau overlay `dokploy-network`. Les serveurs distants sont pilotés en SSH (`execAsyncRemote`, Dockerode `protocol: "ssh"`) avec les **mêmes scripts shell**.

**Auth** : better-auth (plugins `apiKey`, `organization` avec RBAC dynamique, `twoFactor`, `passkey`, `sso`, `scim`, `admin`). Session cookie `better-auth.session_token`, 3 jours. Pas de plugin `jwt` / `oidcProvider` / `oauthProvider` activé (`packages/server/src/lib/auth.ts:487-529`).

---

## 2. Parcours d'un déploiement (application)

1. **UI / API** → `application.deploy` (`apps/dokploy/server/api/routers/application.ts:807`) crée un job `{type:"deploy"}` ; `redeploy` (L446) crée `{type:"redeploy"}`.
2. **File** → `InMemoryQueue` partitionnée par serveur, sérialisée par application (`server/queues/in-memory-queue.ts`). Jobs **perdus au redémarrage** ; au boot, les déploiements `running` passent `cancelled` (`utils/startup/cancel-deployments.ts`).
3. **Worker** → `deployApplication` / `rebuildApplication` (`packages/server/src/services/application.ts:178-336`).
4. `createDeployment` → ligne `deployment` (`status=running`) + fichier log `${BASE_PATH}/logs/<app>/<app>-<date>.log`.
5. **Clone** → `git clone --branch <b> --depth 1` (`utils/providers/github.ts:236`, idem gitlab/gitea/bitbucket/git). **Aucun commit n'est épinglé.**
6. **Patches** → `generateApplyPatchesCommand`.
7. **Build** → `getBuildCommand` produit une image au tag **mutable** `<appName>:latest` ; push registry optionnel (`utils/cluster/upload.ts`).
8. Tout est exécuté en **une seule commande shell** `(cmd) >> log 2>&1` (L227-232).
9. **Runtime** → `mechanizeDockerContainer` : `service.update({ForceUpdate+1})`, sinon `createService` (`utils/builders/index.ts:82-213`).
10. **Statut** → `done` **dès que Swarm a accepté la spec** (L234-236). Aucune attente de convergence, de santé ni de joignabilité.
11. `finally` → `git log -1` : le SHA est écrit **en texte libre** dans `deployment.description = "Commit: <sha>"` (L267-282).

### Sémantique réelle des actions

| Action UI | Ce qu'elle fait réellement | Écart avec l'attente |
|---|---|---|
| Deploy | Re-clone HEAD de la branche + build + update service | ≈ « Deploy Latest », mais le commit construit n'est connu qu'après coup |
| Redeploy (« Rebuild » côté router) | **Pas de fetch Git**, rebuild du dossier déjà cloné. Source Docker : **pas de `docker pull`** | Explique « le redéploiement ne récupère pas la dernière version » |
| Reload | Re-applique la spec Swarm (ForceUpdate), sans build, sans ligne `deployment` | Redémarrage non tracé |
| Start / Stop | `docker service scale =1 / =0` (ignore `replicas`) | — |
| Rollback | Nécessite un registry + `rollbackActive`. Ligne `rollbacks` créée **avant** l'exécution du build (même si le build échoue). Restauration via une spec Swarm **différente** de `mechanizeDockerContainer` | Rollback non fiable sans registry ; pas de ligne `deployment` |
| Kill build | `pkill -2 -f "docker build"` → **tue tous les builds** du serveur | — |

### Webhooks
Les webhooks GitHub/GitLab/… extraient le SHA poussé mais **ne l'utilisent pas pour le checkout** (`pages/api/deploy/github.ts`, `[refreshToken].ts:511-545`) : un push concurrent peut faire construire un autre commit que celui annoncé.

### Compose
`deployCompose` : clone + `docker compose -p <app> up -d --build` ou `docker stack deploy` (`utils/builders/compose.ts:125-149`). Domaines injectés par **labels Traefik**. Pas de rollback, pas de spec Swarm (santé définie dans le fichier compose).

---

## 3. Composants impliqués

| Domaine | Fichiers clés |
|---|---|
| Orchestration déploiement | `packages/server/src/services/application.ts`, `services/compose.ts`, `services/deployment.ts` |
| File | `apps/dokploy/server/queues/{queueSetup,in-memory-queue,deployments-queue,concurrency}.ts` |
| Build | `packages/server/src/utils/builders/*` |
| Git | `packages/server/src/utils/providers/*` (`getGitCommitInfo` dans `git.ts:168-201`) |
| Spec Swarm | `utils/builders/index.ts` (`mechanizeDockerContainer`), `utils/docker/utils.ts` (`generateConfigContainer`, `waitForSwarmServiceConvergence` L974 — utilisé seulement pour les BDD) |
| Inspection Docker | `services/docker.ts` (`getServiceContainersByAppName`, `getApplicationInfo`, `getDockerEvents`, `getConfig`…) |
| Domaines / proxy | `db/schema/domain.ts` (`port` défaut 3000), `utils/traefik/domain.ts`, `utils/traefik/application.ts:349-359` → `http://<appName>:<port>` |
| Ports publiés | `db/schema/port.ts`, appliqués via `EndpointSpec` |
| Logs | build : fichier + WS `/listen-deployment` (`tail -f`) ; runtime : WS `/docker-container-logs` |
| Permissions | `packages/server/src/lib/access-control.ts`, `services/permission.ts` (`checkPermission`, `checkServiceAccess`, `checkProjectAccess`…), `apps/dokploy/server/api/trpc.ts` |
| Audit | table `audit_log` ; écriture `createAuditLog` **propriétaire et conditionnée à une licence** |
| IA existante | `routers/ai.ts`, `services/ai.ts` (Vercel AI SDK, `analyzeLogs` envoie des logs à un LLM configuré) |
| UI application | `pages/dashboard/project/[projectId]/environment/[environmentId]/services/application/[applicationId].tsx`, `components/dashboard/application/*` (shadcn/ui) |
| Réglages / menu | `pages/dashboard/settings/*`, `components/layouts/side.tsx` (tableau `MENU.settings`) |

---

## 4. Points de friction identifiés (vérifiés dans le code)

1. **Succès prématuré** : `done` après `service.update()`, sans convergence ni healthcheck (`services/application.ts:234-236`).
2. **Version non traçable** : pas de colonne SHA, SHA en texte libre, **aucun digest d'image** stocké ; tag `:latest` mutable.
3. **Redeploy ambigu** : pas de fetch Git, pas de pull pour les sources Docker.
4. **Webhook SHA ignoré** : clone de HEAD, pas du SHA notifié.
5. **Ports** : port de domaine saisi à la main (défaut 3000), **aucune détection** d'`EXPOSE` ni de port d'écoute réel (grep vide hors Traefik).
6. **Pas de healthcheck par défaut** ; résultat des mises à jour Swarm (rollback automatique `FailureAction: rollback`) jamais relu → un rollback Swarm silencieux peut laisser l'ancienne image tourner alors que l'UI affiche le nouveau déploiement.
7. **Diagnostic** : seulement `analyzeLogs` (LLM sur texte brut). Aucun moteur déterministe.
8. **Timeline** : un seul fichier log, aucune étape structurée.
9. **Kill build global** (`pkill`), **file en mémoire** (perte au restart).
10. **Preview deployments** : seules les sources GitHub construisent, les autres sont marquées `done` sans build (`services/application.ts:412`).
11. **Sécurité** : `canAccessToAPI` vérifié **uniquement côté UI** ; `rollbacks.fullContext` stocke les identifiants registry ; aucun rate limiting applicatif.
12. **Audit** : le journal d'audit ne fonctionne qu'avec une licence entreprise.

---

## 5. Fichiers et modules à modifier (points d'accroche minimaux)

| Fichier existant | Modification envisagée |
|---|---|
| `services/application.ts` (`deployApplication`, `rebuildApplication`) | Émettre des événements de timeline ; enregistrer SHA demandé/récupéré/construit, ID/digest image ; lancer la vérification post-déploiement |
| `services/compose.ts` | Idem (SHA + timeline + vérification par service) |
| `utils/providers/*.ts` | Option `commitSha` : `git fetch --depth 1 origin <sha>` + checkout ; sortie du SHA récupéré |
| `utils/builders/index.ts` | Tag immuable supplémentaire `<app>:<deploymentId>` (si validé) |
| `pages/api/deploy/*.ts` | Transmettre le SHA du webhook comme commit demandé |
| `routers/application.ts`, `routers/compose.ts` | Nouvelles procédures (`deployLatest`, `rebuildCommit`, `restart`, `preflight`, `diagnose`, `versionStatus`) — les anciennes restent |
| `db/schema/deployment.ts` | Colonnes additionnelles nullable (compatibles installations existantes) |
| `lib/auth.ts` | Ajout du plugin OAuth provider + JWT (configuration additive) |
| `next.config.mjs` | Rewrites `/mcp` → `/api/mcp`, `/.well-known/oauth-*` |
| `components/layouts/side.tsx` | Entrée « AI Integrations » |
| UI application | Nouveau panneau « Current deployment », assistant, timeline, diagnostics (onglet existant conservé) |

Tout le reste est **nouveau code** dans des modules dédiés (§8).

---

## 6. Fonctionnalités existantes à réutiliser

- `waitForSwarmServiceConvergence` (`utils/docker/utils.ts:974`) → étape « Container running ».
- `getServiceContainersByAppName` / `getApplicationInfo` (`services/docker.ts`) → état des tâches, erreurs, exit codes.
- `getDockerEvents` → événements Docker (fenêtre ponctuelle).
- `getGitCommitInfo` → SHA construit.
- `healthCheckSwarm` + formulaires `advanced/cluster/swarm-forms/health-check` → pas besoin d'un nouveau modèle de healthcheck.
- `checkServiceAccess`, `checkProjectAccess`, `checkPermission`, `resolvePermissions` → **même autorisation pour UI et MCP**.
- `apiKey` / `organization` better-auth → identité unique, pas de second système d'utilisateurs.
- Composants shadcn (`components/ui/*`), WS de logs existants, `@stepperize/react` (déjà en dépendance) pour l'assistant.
- Vitest (170 fichiers de test, BDD mockée), CI qui initialise déjà swarm + `dokploy-network`.
- `.devcontainer/` existant (Node 24 + docker-in-docker) → base de l'environnement local isolé.

---

## 7. Risques techniques

| Risque | Impact | Mitigation |
|---|---|---|
| Divergence upstream (canary très actif, 200 migrations) | Conflits de rebase, surtout `drizzle/meta/_journal.json` | Code dans des modules séparés, accroches minimales, migrations regroupées et régénérables |
| Licence propriétaire | Audit log / rôles custom propriétaires | Journal d'audit MCP **propre** (Apache 2.0), aucune modification de `/proprietary` |
| Spécification MCP **2026-07-28** : protocole *stateless* (plus de handshake `initialize` ni de session) alors que des clients utilisent encore 2025-11-25 / 2025-06-18 | Incompatibilité client | SDK officiel `@modelcontextprotocol/server` 2.x (déjà dans le lockfile via shadcn) ; rétrocompatibilité à **vérifier en Phase 6** |
| OAuth : spec MCP recommande *Client ID Metadata Documents* (SHOULD), DCR dépréciée mais encore utilisée par les clients | Clients non connectables | `@better-auth/oauth-provider@1.6.23` (pairs compatibles avec les overrides actuels `better-call 1.3.7`). Support CIMD **non vérifié** → à tester ; fallback DCR |
| Audience des jetons (RFC 8707) | Rejeu de jetons d'un autre service | Validation `aud` = URL canonique `/mcp` à chaque requête |
| Détection du port d'écoute | Images distroless sans shell | Conteneur d'inspection éphémère partageant le namespace réseau (`--net container:<id>`) → lecture `/proc/net/tcp*` ; jamais exécuté par un agent |
| macOS | Swarm, overlay, ports `host`, `/etc/dokploy`, port 80 occupé (httpd) et 5432 occupé (Postgres local), Docker Desktop limité à 8 Go | Environnement **Docker-in-Docker** dédié (cf. §10) |
| Logs contrôlés par des tiers | Injection de prompt vers l'agent | Logs renvoyés comme données balisées (`untrusted`), tronqués, secrets masqués ; jamais dans des descriptions d'outils |
| Secrets | Fuite via MCP / rapports | Lecture des clés d'env uniquement (jamais les valeurs), masquage dans les logs retournés |
| File en mémoire | Déploiement MCP perdu au restart | Documenté ; statut `cancelled` existant au boot |

---

## 8. Architecture cible

### Modules (tous Apache 2.0, dans `packages/server/src/`)

```
smart-deploy/
  preflight/        détecteurs (framework, langage, gestionnaire de paquets, Dockerfile/EXPOSE,
                    compose, scripts, start command, env référencées, healthcheck) → rapport avec confiance
  runtime/          inspection : tâches Swarm, conteneur, image exécutée (digest), ports écoutés,
                    probe HTTP interne (http://<app>:<port>) et via Traefik (Host header)
  versioning/       SHA demandé/récupéré/construit, `git ls-remote` pour le dernier commit distant,
                    digest image produite vs exécutée, statut Up-to-date / Outdated / Unknown
  timeline/         événements structurés par déploiement (étape, statut, horodatage, preuve)
  diagnostics/      moteur de règles déterministe (interface Rule → Finding) + couche IA optionnelle
                    PORT_MISMATCH, APPLICATION_NOT_LISTENING, LISTENING_ON_LOCALHOST,
                    CONTAINER_CRASH_LOOP, MISSING_ENVIRONMENT_VARIABLE, HEALTHCHECK_FAILED,
                    REVERSE_PROXY_UNREACHABLE, IMAGE_VERSION_MISMATCH, GIT_COMMIT_OUTDATED, BUILD_FAILED
  actions/          deployLatest / rebuildCommit / redeploy / restart / rollback — façade unique
                    réutilisée par tRPC ET MCP (pas de second moteur)
mcp/
  server.ts         serveur MCP (SDK officiel), transport Streamable HTTP
  tools/            outils lecture / déploiement / configuration → appellent smart-deploy/actions
  resources/        projets, historique, statut, rapports de diagnostic
  scopes.ts         scopes OAuth ↔ permissions Dokploy (intersection, jamais élargissement)
  guard.ts          vérif. jeton, audience, scopes, accès projet/service, rate limit, confirmation
  audit.ts          journal des appels MCP
oauth/              intégration better-auth (oauth-provider + jwt), écran de consentement
```

### Données (migrations Drizzle versionnées, colonnes nullable)

- `deployment` + : `kind` (deploy_latest/rebuild/redeploy/restart/rollback), `requestedCommitSha`, `fetchedCommitSha`, `builtCommitSha`, `imageId`, `imageDigest`, `runningImageDigest`, `taskId`, `containerId`, `verificationStatus` (build_ok/created/running/healthy/reachable/failed), `healthResult` (jsonb).
- `deployment_event` : timeline.
- `diagnostic_report` : résultats du moteur (pas de secrets).
- Tables du plugin OAuth (clients, jetons, consentements) générées puis migrées.
- `mcp_settings` (activation par organisation, scopes autorisés), `mcp_audit_log`.

> `deployment.status` garde sa sémantique actuelle (compatibilité UI/API existantes) ; la vérité « healthy / reachable » est portée par `verificationStatus`.

### Flux MCP cible

```
Client MCP ──POST /mcp (sans jeton)──► 401 + WWW-Authenticate: resource_metadata=…/.well-known/oauth-protected-resource/mcp
          ──GET PRM──► authorization_servers=[https://<instance>/api/auth]
          ──GET AS metadata──► /.well-known/oauth-authorization-server
          ──(CIMD ou DCR)──► client_id
          ──/authorize (PKCE S256 + resource=https://<instance>/mcp)──► login Dokploy existant ──► écran de consentement (scopes cochés)
          ──/token──► jeton court (aud=…/mcp, scopes, user, org)
          ──POST /mcp + Bearer──► guard : jeton ✓ audience ✓ scope ✓ permission Dokploy ✓ accès projet ✓ → outil → audit
```

**Effective permission = scopes accordés ∩ permissions Dokploy de l'utilisateur ∩ réglages MCP de l'organisation.**

---

## 9. Hypothèses non vérifiées (à lever pendant l'implémentation)

- Support CIMD par `@better-auth/oauth-provider@1.6.23`.
- Rétrocompatibilité de `@modelcontextprotocol/server@2.x` avec les clients 2025-11-25.
- Comportement de `docker swarm init` et de l'overlay dans Docker-in-Docker sur Docker Desktop arm64 (la CI upstream le fait sur Linux).
- Fetch par SHA (`git fetch origin <sha>`) sur GitLab/Gitea/Bitbucket auto-hébergés (dépend de `uploadpack.allowReachableSHA1InWant`) → fallback : clone complet de la branche puis `checkout <sha>`.

---

## 10. Environnement local cible (macOS)

Machine constatée : macOS 26.2, Apple Silicon (arm64), 16 Go RAM, Docker Desktop 27.4 (8 Go alloués, Swarm **inactif**), ~168 Go libres, Node 20 sur l'hôte (Node 24 requis), corepack/pnpm cassé sur l'hôte. Ports occupés : **80** (httpd), **5432** (Postgres), **8080** (conteneur existant). Libres : 443, 3000, 6379.

**Proposition : « devbox » Docker-in-Docker**, dérivée du `.devcontainer` officiel :

- Un seul conteneur privilégié `dokploy-dev` avec **son propre démon Docker** (données dans un volume dédié), Node 24.22.1, pnpm 10.22, nixpacks, railpack.
- `docker swarm init`, `dokploy-network`, Traefik et Postgres créés **à l'intérieur** → le Docker Desktop de l'hôte n'est pas passé en mode Swarm et les conteneurs existants ne sont pas touchés.
- `node_modules` dans un volume Linux (évite les binaires darwin/linux mélangés).
- Ports exposés sur `127.0.0.1` uniquement : `3000` (UI), `8880` → Traefik 80, `8443` → Traefik 443.
- Applications de test accessibles via `http://<app>.docker.localhost:8880`.
- Scripts `scripts/dev-{start,stop,reset,test}.sh` ; `dev-reset` demande confirmation avant toute suppression de volume.

**OAuth/MCP local** : MCP Inspector et Claude Code acceptent `http://localhost` → **aucun tunnel nécessaire** pour les tests prévus. Un tunnel HTTPS public ne serait utile que pour connecter claude.ai (web), et ne sera mis en place qu'avec accord explicite.
