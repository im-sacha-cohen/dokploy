# Journal d'implémentation

Branche de travail : `feat/smart-deploy-mcp` (basée sur `upstream/canary` @ `46a0762`).
Remote `upstream` = `Dokploy/dokploy`. Aucun push effectué.

| Phase | Statut | Livrable |
|---|---|---|
| 1 — Audit | ✅ Terminé (02/11/2026) | `docs/ARCHITECTURE_AUDIT.md` |
| 2 — Environnement local | ✅ Validé (02/11/2026) | `docs/LOCAL_DEVELOPMENT.md`, `docs/TESTING.md`, devbox, apps de démo |
| 3 — Diagnostics | ✅ Validé (02/11/2026) | `docs/DEPLOYMENT_DIAGNOSTICS.md`, `smart-deploy/diagnostics`, API `smartDeploy.diagnoseApplication` |
| 4 — Version tracking | ✅ Validé (02/11/2026) | `docs/SMART_DEPLOY_ENGINE.md`, `smart-deploy/versioning`, migration 0199 |
| 5 — UI déploiement | ✅ Validé (02/11/2026) | onglet Smart Deploy, `smart-deploy/preflight`, `smart-deploy/actions`, `docs/SMART_DEPLOY_ENGINE.md` |
| 6 — Serveur MCP + OAuth | ✅ Validé (02/11/2026) | `/mcp`, OAuth 2.1 via better-auth, consentement, Settings › AI Integrations, `docs/MCP_ARCHITECTURE.md`, `docs/MCP_SECURITY.md` |
| 7 — Tests finaux | ✅ Validé (02/11/2026) | `docs/FINAL_REPORT.md`, `dev/phase7/` |

## Journal

### 02/11/2026 — Phase 1
- Clone de `canary`, remote renommé `upstream`, branche `feat/smart-deploy-mcp`.
- Audit en lecture seule ; aucun code exécuté, aucune dépendance installée.
- Rien n'est encore testé.
- Fork créé : `im-sacha-cohen/dokploy` (public, remote `origin`). Aucun push.

### 02/11/2026 — Phase 2
- Devbox Docker-in-Docker (`docker-compose.dev.yml`, `dev/devbox/`, `scripts/dev-*.sh`) : démon interne 28.5.2, Swarm actif à l'intérieur, Swarm de l'hôte toujours inactif.
- Setup upstream exécuté sans modification : Traefik, Postgres et migrations OK ; UI joignable sur http://localhost:3000.
- 7 applications de démo (A–G) servies par un serveur Git local et créées via l'API (`seed.mjs`).
- Constat de référence : 7 déploiements `done`, dont 4 en 502 (B, C, D, G).
- Suite de tests upstream : 1595/1604 au premier lancement ; les 3 échecs sont expliqués et passent seuls (`docs/TESTING.md`).
- Compte propriétaire de test créé sur l'instance locale (identifiants dans `dev/.env`, gitignoré).

### 02/11/2026 — Phase 3
- Phase 1-2 committée en local (`4402bf3`), sans push.
- Moteur de règles déterministe `packages/server/src/smart-deploy/diagnostics` : collecte en lecture seule (Docker API, `/proc/net/tcp`, sondes depuis le conteneur Traefik), puis 8 règles pures avec chaînage des causes et redaction des secrets.
- Endpoint `smartDeploy.diagnoseApplication` (tRPC + REST, droit lecture du service, contrôle d'organisation).
- 34 tests unitaires (règles, parseurs, redaction, validation des entrées des sondes) ; typecheck serveur et app OK.
- Exécuté sur les apps de démo : A et E `healthy` ; B, C, D et G `down`, chacune avec sa cause racine (voir `docs/DEPLOYMENT_DIAGNOSTICS.md`).
- `dev/demo-apps/api-client.mjs` factorisé depuis `seed.mjs` ; nouveau `diagnose.mjs`.
- Non couvert : services Compose (F), images sans `cat`, persistance des rapports, codes de version (Phase 4).

### 02/11/2026 — Phase 4
- Phase 3 committée en local (`4865da3`), sans push.
- Migration `0199_smart_deploy_version_tracking` : 16 colonnes nullables sur `deployment`. La ligne de dérive upstream que `drizzle-kit` avait ajoutée (défaut de `webServerSettings.whitelabelingConfig`) a été retirée du SQL.
- Capture par déploiement : type d'action, dépôt sans identifiants, branche, commits demandé, récupéré et construit, image (ID, digest, tag `dpl-<id>`, 5 conservées), conteneur et tâche réellement exécutés.
- Vérification post-déploiement par étapes : build, conteneur créé, running, healthy, reachable.
- Commit distant vérifié via l'API des providers ou `git ls-remote`, jamais supposé.
- Actions distinctes : Redeploy et Rollback d'une image conservée, sans fetch ni build (`smartDeploy.redeployVersion`, via la file de déploiement) ; Restart sans rebuild ni changement de config (`smartDeploy.restartApplication`). Deploy Latest et Rebuild upstream sont désormais tracés.
- Règles `GIT_COMMIT_OUTDATED` et `IMAGE_VERSION_MISMATCH`.
- Modifications upstream minimales : 6 appels dans `services/application.ts`, un type de job et une branche dans la file, le schéma `deployment`.
- Tests : 8 tests unitaires de plus (42 au total). Scénario E : 22/22 en réel. A–G : vérification `healthy`, `degraded` ou `failed`, chacune avec sa cause.
- Devbox corrigé :
  - PID `containerd` périmés après `docker restart` ;
  - serveur Git de démo tué par le démarrage (désormais lancé en `setsid` et supervisé) ;
  - l'ancienne image embarquait une copie figée de l'entrypoint.
- Constaté, non corrigé (upstream) : au redémarrage, le setup Dokploy tente de recréer Traefik et échoue sur une entrée DNS Swarm déjà existante (`dokploy-traefik-previous`). Traefik reste en service et le démarrage continue.

### 02/11/2026 — Phase 5
- Phase 4 committée en local (`ad13de3`), sans push.
- Preflight : clone temporaire avec les fonctions de clone existantes, lecture des manifestes, `git grep` des variables et des lignes d'écoute, puis analyse pure. Détections avec confiance et source, 8 contrôles. Secrets masqués, `.env` jamais lu.
- API :
  - `smartDeploy.preflight`, `getDeploymentTimeline`, `deployLatest` ;
  - `applyFix`, revalidé par un diagnostic frais : seuls les correctifs proposés et `autoFixable` sont acceptés.
- UI : onglet « Smart Deploy » avec la carte de version courante, l'historique avec redeploy et rollback, et l'assistant Source → Configuration → Preflight → Deployment (timeline réelle) → Result (correctifs confirmés). Onglets existants inchangés.
- Le verdict de santé n'est plus influencé par `GIT_COMMIT_OUTDATED`.
- Tests : 56 tests unitaires smart-deploy et parcours réels dans le navigateur (voir `TESTING.md`).
- Langue : l'interface est en anglais comme Dokploy ; les textes générés par le serveur (constats, raisons) sont en français. **À trancher.**

### 02/11/2026 — Phase 6
- Phase 5 committée en local (`b42b08b`), sans push.
- Dépendances : `@better-auth/oauth-provider@1.6.23` (serveur et app) et `@modelcontextprotocol/server@2.4.0` (déjà dans le lockfile en transitive). Diff des `package.json` limité à ces lignes.
- OAuth 2.1 sur l'auth better-auth existante (plugins `oauthProvider` + `jwt`) :
  - Authorization Code + PKCE, enregistrement dynamique, audience RFC 8707 ;
  - JWT de 15 min et refresh de 7 jours, `client_credentials` désactivé ;
  - endpoint `/token` du plugin `jwt` et en-tête JWT de session désactivés.
- Migration `0200_mcp_oauth` : 5 tables OAuth et 3 tables MCP (réglages, grants, audit).
- `/mcp` :
  - transport Streamable HTTP sans état (2026-07-28 et repli 2025) ;
  - contrôles Host/Origin, Bearer, audience, grant revérifié à chaque requête, rate limiting ;
  - 19 outils, 2 ressources, audit.
- Page de consentement : choix de l'organisation, cases réellement appliquées, moindre privilège par défaut. La page de login reprend le flux OAuth après connexion.
- Settings › AI Integrations : activation, URL, scopes autorisés, test de connexion, clients connectés, révocation, audit.
- Tests :
  - `dev/mcp/oauth-mcp-e2e.mjs` : 36/36 en réel ;
  - consentement réel dans le navigateur, et reprise après login ;
  - 12 tests unitaires MCP (67 au total dans smart-deploy).
- Bugs trouvés et corrigés : chemins de logs contenant `:` refusés (affectait aussi `BUILD_FAILED`) ; endpoints RFC 8414 relatifs ; script de test qui écrasait les cookies.
- Non fait : CIMD, tunnel public pour un client distant, isolation multi-utilisateurs testée en réel (Phase 7).

### 02/11/2026 — Phase 7
- Phase 6 committée en local (`a5ba6c5`), sans push.
- `dev/phase7/setup-isolation.mjs` (idempotent) prépare :
  - une 2e organisation ;
  - un projet restreint ;
  - un membre de test invité avec un accès limité (mot de passe aléatoire dans `dev/.env`, gitignoré).
- `dev/phase7/isolation-tests.mjs` : 27/27. `dev/phase7/run-all.sh` rejoue tous les scénarios.
- Stabilité : redémarrage complet puis répétitions, tout est vert.
- Suite complète : 1661 tests passés, seuls les 4 timeouts connus de `backup-files` échouent.
- `dev/demo-apps/api-client.mjs` gère désormais plusieurs sessions et des en-têtes supplémentaires.
- Bilan et limitations consolidées : `docs/FINAL_REPORT.md`.

### 02/11/2026 — Erreurs et ports mis en évidence (après Phase 7)
- Bandeau d'état sur tous les onglets de l'application : cause racine et une action principale.
- Carte « Network path » (onglets Smart Deploy et Domains), badges de joignabilité par domaine, port détecté dans le formulaire de domaine, vrai résultat dans l'onglet Deployments.
- `diagnostics/presentation.ts` (pur) et 6 tests unitaires (73 au total dans smart-deploy).
- Vérifié dans le navigateur sur A (sain), B (port), C (crash) et G (localhost).

### 03/11/2026 — MCP « tout faire »
- Commit précédent : `35f1217` (UX erreurs et ports).
- 25 nouveaux outils (44 au total) : services de tous types, logs, variables, réglages, source, build, compose, domaines, création et suppression, backups, commande dans un conteneur.
- Pont `apps/dokploy/server/mcp/api-bridge.ts` : les outils appellent les procédures tRPC de l'UI (liste blanche `mcp/api-paths.ts`), donc mêmes permissions.
- Nouveaux scopes `mcp:env`, `mcp:manage`, `mcp:exec`, désactivés par défaut ; avertissements dans Settings › AI Integrations.
- Confirmation humaine par elicitation, avec état HMAC lié à l'appel (`mcp/confirm.ts`), pour les suppressions, l'arrêt, la restauration et chaque commande.
- Bugs trouvés par le e2e et corrigés : déploiement d'application absent de la liste blanche, identifiant de projet non renvoyé, choix du conteneur quand une app a plusieurs tâches.
- Tests : 80 unitaires, `platform-e2e.mjs` 59/59, `run-all.sh` entièrement OK (dont isolation 27/27), suite complète 1677 passés (seul le timeout connu de `backup-files` échoue, 14/14 seul).

### 03/11/2026 — Enregistrement DNS depuis le formulaire de domaine
- Réutilise les fournisseurs DNS d'upstream (Settings › DNS : Cloudflare, Route 53, OVH, Infomaniak, Porkbun).
- Formulaire « Add domain » : bloc « Create the DNS record » avec zone, sous-domaine suggéré (`service` ou `service-environnement`, suffixe si pris), statut en direct, IP du serveur, proxy Cloudflare (désactivé par défaut). Un clic crée l'enregistrement A puis le domaine ; si le domaine échoue, l'enregistrement est retiré.
- Jamais d'écrasement : un nom déjà utilisé par un A/AAAA/CNAME est refusé, même côté serveur ; un nom pointant déjà ici est réutilisé sans être créé.
- Table `domain_dns_record` (migration 0201, additive) : seuls les enregistrements créés par Dokploy sont suivis. La suppression du domaine propose de supprimer l'enregistrement, case cochée par défaut, seulement s'il pointe encore sur ce serveur.
- Routeur tRPC `domainDns` (le routeur `domain` d'upstream est appelé tel quel) ; MCP : `dokploy_suggest_subdomain`, option `dns` de `dokploy_create_domain`, suppression d'enregistrement dans `dokploy_delete_domain`.
- Le schéma `domain` d'upstream n'est pas modifié : une première version avec des colonnes cassait les fixtures de test d'upstream.

### 03/11/2026 — MCP : déploiements, Smart Deploy et logs complets
- `dokploy_get_deployments`, `dokploy_get_deployment_status` et `dokploy_get_deployment_logs` couvrent aussi les compose (contrôle d'accès au compose et à l'organisation).
- Nouveaux outils : `dokploy_preflight`, `dokploy_get_deployment_timeline` (avant, ressource seulement), `dokploy_apply_fix` (correctif revalidé contre le diagnostic courant).
- `dev/mcp/deployments-e2e.mjs` : 24/24. Les clients de test acceptent `DOKPLOY_DEV_URL` et `DOKPLOY_MCP_URL` en variables d'environnement.

## Décisions validées
- Environnement local : devbox Docker-in-Docker.
- Images taguées par déploiement (`<app>:<deploymentId>`), conservation des 5 dernières.
- OAuth : `@better-auth/oauth-provider` greffé sur l'auth better-auth existante (mêmes comptes, login, 2FA, SSO).
- DNS depuis le formulaire (choix utilisateur du 03/11/2026) : proposer de supprimer l'enregistrement avec le domaine ; tests réels sur une zone dédiée ; exposition au MCP.
- MCP « tout faire » (choix utilisateur du 02/11/2026) : écriture des secrets autorisée, lecture sans les secrets ; actions destructrices avec confirmation ; commande libre avec confirmation (l'interdiction initiale du brief est levée pour `mcp:exec` uniquement).
