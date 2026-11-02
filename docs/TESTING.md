# Tests

Framework existant : **Vitest 4** (`apps/dokploy/__test__`, config `__test__/vitest.config.ts`). La base de données est mockée (`__test__/setup.ts`), sauf dans les tests `*.real.test.ts`, qui exécutent Docker et Git pour de vrai.

```bash
./scripts/dev-test.sh                    # suite complète dans le devbox
./scripts/dev-test.sh __test__/deploy    # un dossier ou un fichier
```

Les tests tournent **sans TTY** et avec `GIT_TERMINAL_PROMPT=0`. Sinon, un `git clone` vers un dépôt inexistant reste bloqué sur une demande d'identifiants (constaté sur `application.real.test.ts`).

## Référence avant modification (upstream `46a0762`, 02/11/2026, devbox arm64)

| Mesure | Résultat |
|---|---|
| Fichiers de test | 166 passés, 2 en échec, 1 ignoré (169) |
| Tests | 1595 passés, 3 en échec, 6 ignorés (1604) |
| Durée | ~400 s |

Analyse des 3 échecs :

| Test | Cause | Statut après analyse |
|---|---|---|
| `backups/backup-files.test.ts` › `getBackupServerId`, `resolveBackupAccess` | Timeout Vitest de 5 s dépassé pendant l'import, sous la charge de la suite complète | **Passent** lancés seuls (14/14). Instabilité de charge, aucun lien avec le fork |
| `deploy/application.real.test.ts` › *REAL git clone errors* | Le premier lancement utilisait un TTY, et git attendait un identifiant | **Passe** sans TTY (5 passés, 1 ignoré) ; `dev-test.sh` est corrigé |

Toute régression introduite par le fork se mesure contre ce tableau.

## Après la Phase 3 (02/11/2026)

| Mesure | Résultat |
|---|---|
| Tests | 1628 passés, 4 en échec, 6 ignorés (1638), dont 34 nouveaux (`__test__/smart-deploy`) |
| Échecs | les 4 sont dans `backups/backup-files.test.ts` : timeouts de 5 s sous charge, comme dans la référence. Ce fichier **passe** lancé seul (14/14) |
| Typecheck | `packages/server` et `apps/dokploy` : 0 erreur (l'app nécessite `NODE_OPTIONS=--max-old-space-size=6144` dans le devbox) |
| Régression | aucune constatée |

Les tests `*.real.test.ts` d'upstream laissent des services `real-*` (0/1) dans le démon Docker **interne** du devbox. Ils sont sans effet sur l'hôte et disparaissent avec `dev-reset.sh`.

## Après la Phase 4 (02/11/2026)

| Mesure | Résultat |
|---|---|
| Tests | 1635 passés, 5 en échec, 6 ignorés (1646), dont 42 dans `__test__/smart-deploy` |
| Échecs | 4 dans `backup-files.test.ts` : timeouts sous charge, comme dans la référence ; **passe seul** (14/14). 1 dans `application.real.test.ts` (build nixpacks réel, timeout de 180 s sous charge) ; **passe seul** |
| Typecheck | serveur et app : 0 erreur |
| Scénario E réel | `version-scenario.mjs` : 22/22 |
| Vérification réelle A, B, C, D, G | healthy, degraded, failed, failed, degraded |

Régressions trouvées puis corrigées pendant la phase. Le premier passage de la suite complète a révélé :
- `application.command.test.ts` (2 tests) : `deployApplication` exécutait un `git ls-remote` avant la commande de build. La lecture du commit demandé a été déplacée dans la file de déploiement.
- `application.real.test.ts` (Dockerfile) : le tag `<app>:dpl-…` dupliquait la ligne de `docker images <app>`. Les images conservées vivent désormais dans un dépôt séparé, `dokploy-versions/<app>`.

## Après la Phase 5 (02/11/2026)

| Mesure | Résultat |
|---|---|
| Tests | 1648 passés, 6 en échec, 6 ignorés (1660), dont 56 dans `__test__/smart-deploy` |
| Échecs | 4 dans `backup-files.test.ts`, timeouts sous charge (passe seul, 14/14). 2 dans `application.real.test.ts` (clone réel nixpacks et submodules, en échec sous charge ; passe seul, 5 passés + 1 ignoré) |
| Typecheck | serveur et app : 0 erreur |
| Preflight réel | A–G : clone temporaire supprimé, 90 à 250 ms. Constats attendus : port 80 pour B, `DATABASE_URL`/`SESSION_SECRET` pour D, localhost pour G |

Parcours UI testé dans le navigateur intégré (instance locale, compte de test) :

| Parcours | Résultat |
|---|---|
| Onglet Smart Deploy sur B : carte de version, preflight, diagnostic | données réelles affichées, constats PORT_MISMATCH et REVERSE_PROXY_UNREACHABLE |
| B : « Apply fix » (port 80 → 3000) avec confirmation | appliqué, diagnostic « running and reachable », `curl` via Traefik 200 (502 avant). Port 80 remis ensuite pour garder le scénario |
| A : Deploy latest depuis l'étape 3, puis timeline | 6 étapes observées jusqu'à « reachable », historique rafraîchi automatiquement |
| E : « Roll back » depuis l'historique | version `be8f6bb` exécutée, statut « Outdated », Deploy latest recommandé |

Défauts trouvés pendant ces tests et corrigés :
- statut figé au résultat du déploiement → statut *live* ajouté ;
- historique non rafraîchi après la timeline ;
- Roll back proposé vers l'image déjà en cours ;
- « outdated » comptait comme « degraded » ;
- badge illisible.

## Tests manuels de référence (applications de démo)

Voir `docs/LOCAL_DEVELOPMENT.md` › *Compte de test et applications de démonstration* : avec le moteur upstream, 7 déploiements sont `done`, dont 4 applications en 502.

## Plan de tests du fork

À compléter phase par phase. Un test n'est marqué réussi qu'après avoir été réellement exécuté.

| Domaine | Type | Statut |
|---|---|---|
| Règles de diagnostic (port, crash loop, env, localhost, healthcheck…) | unitaires + scénarios démo B/C/D/G | ✅ 34 tests unitaires ; scénarios A–G (sauf F, Compose) exécutés en réel via `diagnose.mjs` |
| Version tracking (SHA distant / construit / exécuté, digest) | unitaires + scénario E | ✅ 8 tests unitaires ; scénario E 22/22 en réel |
| Timeline / statut de vérification | intégration (devbox) + UI | ✅ A–G réels ; timeline UI testée dans le navigateur |
| Preflight, applyFix, UI | unitaires + navigateur | ✅ 14 tests unitaires ; parcours réels (voir Phase 5) |
| OAuth (PKCE, audience, expiration, révocation) | API | à faire (Phase 6) |
| MCP (outils, scopes, isolation projet, injection de logs) | API + MCP Inspector | à faire (Phase 6) |
| Non-régression | suite upstream complète | référence ci-dessus |
