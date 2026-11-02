# Journal d'implémentation

Branche de travail : `feat/smart-deploy-mcp` (basée sur `upstream/canary` @ `46a0762`).
Remote `upstream` = `Dokploy/dokploy`. Aucun push effectué.

| Phase | Statut | Livrable |
|---|---|---|
| 1 — Audit | ✅ Terminé (02/11/2026) | `docs/ARCHITECTURE_AUDIT.md` |
| 2 — Environnement local | ✅ Validé (02/11/2026) | `docs/LOCAL_DEVELOPMENT.md`, `docs/TESTING.md`, devbox, apps de démo |
| 3 — Diagnostics | ✅ Validé (02/11/2026) | `docs/DEPLOYMENT_DIAGNOSTICS.md`, `smart-deploy/diagnostics`, API `smartDeploy.diagnoseApplication` |
| 4 — Version tracking | 🚧 En cours | — |
| 5 — UI déploiement | ⬜ | — |
| 6 — Serveur MCP + OAuth | ⬜ | — |
| 7 — Tests finaux | ⬜ | — |

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

## Décisions validées
- Environnement local : devbox Docker-in-Docker.
- Images taguées par déploiement (`<app>:<deploymentId>`), conservation des 5 dernières.
- OAuth : `@better-auth/oauth-provider` greffé sur l'auth better-auth existante (mêmes comptes, login, 2FA, SSO).
