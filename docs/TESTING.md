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

## Tests manuels de référence (applications de démo)

Voir `docs/LOCAL_DEVELOPMENT.md` › *Compte de test et applications de démonstration* : avec le moteur upstream, 7 déploiements sont `done`, dont 4 applications en 502.

## Plan de tests du fork

À compléter phase par phase. Un test n'est marqué réussi qu'après avoir été réellement exécuté.

| Domaine | Type | Statut |
|---|---|---|
| Règles de diagnostic (port, crash loop, env, localhost, healthcheck…) | unitaires + scénarios démo B/C/D/G | ✅ 34 tests unitaires ; scénarios A–G (sauf F, Compose) exécutés en réel via `diagnose.mjs` |
| Version tracking (SHA distant / construit / exécuté, digest) | unitaires + scénario E | à faire (Phase 4) |
| Timeline / statut de vérification | intégration (devbox) | à faire (Phase 4-5) |
| OAuth (PKCE, audience, expiration, révocation) | API | à faire (Phase 6) |
| MCP (outils, scopes, isolation projet, injection de logs) | API + MCP Inspector | à faire (Phase 6) |
| Non-régression | suite upstream complète | référence ci-dessus |
