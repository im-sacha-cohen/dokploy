# Smart Deploy Engine

Code : `packages/server/src/smart-deploy/`. Ce document décrit :
- le **suivi de version** ;
- les **actions de déploiement** ;
- la **vérification post-déploiement** (Phase 4).

L'analyse préalable (*preflight*) sera ajoutée en Phase 5. Les diagnostics sont documentés dans `DEPLOYMENT_DIAGNOSTICS.md`.

## Problème corrigé

Dans Dokploy upstream :
- Un déploiement passe à `done` dès que `docker service update` est accepté. Une app en crash loop ou injoignable est donc affichée « réussie ».
- Le commit n'est conservé que comme texte (`description: "Commit: <sha>"`) et seulement *après* coup.
- Toutes les images s'appellent `<app>:latest` : impossible de savoir quelle version tourne réellement.
- « Rebuild » reconstruit le dossier de code existant, sans le dire.
- Le rollback n'existe qu'avec un registre.

## Données enregistrées par déploiement

Migration `0199_smart_deploy_version_tracking`. Elle ajoute 16 colonnes **nullables** à `deployment`, sans valeur par défaut : les lignes existantes et les chemins upstream non modifiés (Compose, previews) restent valides.

| Champ | Signification | Source |
|---|---|---|
| `kind` | `deploy_latest`, `rebuild`, `redeploy`, `rollback` ou `restart` | action réellement exécutée |
| `sourceRepository`, `sourceBranch` | dépôt (**identifiants retirés** de l'URL) et branche | configuration |
| `requestedCommitSha` | ce qui a été demandé : tête distante au moment de la demande (deploy latest, lue par la file de déploiement avant l'appel de `deployApplication`) ou commit de la version redéployée | API du provider ou `git ls-remote` |
| `fetchedCommitSha` | ce que le clone a réellement récupéré (`null` si rien n'a été récupéré) | `git rev-parse HEAD` après clone |
| `builtCommitSha` | commit du code qui a servi au build | `git rev-parse HEAD` du dossier de build |
| `imageId` | identifiant de contenu de l'image produite (`sha256:…`) | `docker image inspect` |
| `imageDigest` | digest de registre (`repo@sha256:…`), seulement si l'image a été poussée ou tirée | `RepoDigests` |
| `imageTag` | tag conservé `dokploy-versions/<app>:dpl-<deploymentId>` (redéployable) | `docker tag` |
| `runningImageId`, `containerId`, `taskId` | ce qui tourne réellement après déploiement | tâche Swarm + `container inspect` |
| `verificationStatus`, `verification` | résultat de la vérification par étapes (ci-dessous) | observation |
| `sourceDeploymentId` | pour redeploy, rollback et restart : la version d'origine | action |

Si l'arbre de travail est modifié (patchs Dokploy appliqués), `verification.sourceDirty` le signale : le build ne correspond alors pas exactement au commit.

Le suivi ne peut **jamais** faire échouer un déploiement : chaque étape de capture intercepte et journalise ses propres erreurs.

## Actions : chacune fait ce que son nom dit

| Action | Ce qui se passe | Git | Build | Endpoint |
|---|---|---|---|---|
| **Deploy Latest** | clone la tête de la branche, construit, met à jour le service | oui | oui | `application.deploy` (upstream, désormais suivi) |
| **Rebuild** | reconstruit le **dossier de code présent** (le dernier clone), sans récupérer | non | oui | `application.redeploy` (upstream, suivi : `builtCommitSha` dit explicitement ce qui a été reconstruit) |
| **Redeploy** | remet en service l'**image exacte** d'un déploiement antérieur ou courant | non | non | `smartDeploy.redeployVersion` |
| **Rollback** | même mécanisme, vers une version **plus ancienne** que celle en cours ; le type est déterminé automatiquement | non | non | `smartDeploy.redeployVersion` |
| **Restart** | redémarre les conteneurs avec la spec Swarm actuelle (incrément de `ForceUpdate`), sans rebuild ni réapplication de la configuration | non | non | `smartDeploy.restartApplication` |

Le « Reload » d'upstream (`application.reload`) est conservé tel quel. Il réapplique la configuration, ce qui en fait un « redéploiement de config » et non un simple redémarrage.

### Redeploy et rollback sans registre

- Chaque build réussi est tagué `dokploy-versions/<app>:dpl-<deploymentId>`. C'est un dépôt d'image séparé, pour que `docker images <app>` reste identique à upstream. Les **5 dernières** images taguées sont conservées ; les plus anciennes sont dé-taguées avec `docker image rm`, sans `-f`, donc jamais une image utilisée.
- Avant de redéployer, l'ID de l'image taguée est comparé à `imageId` : une image modifiée est refusée.
- La configuration utilisée est la configuration **actuelle** (variables d'environnement, ports, montages). Le rollback upstream par registre restaure, lui, l'ancienne configuration complète.
- Non disponible (refus explicite) quand l'application utilise un registre, un serveur de build distinct ou une source `docker`. Le rollback par registre d'upstream reste utilisable dans ces cas.

## Vérification post-déploiement

Lancée en arrière-plan à la fin de chaque action ; la file de déploiement n'attend pas. Chaque étape est enregistrée séparément :

| Étape | Réussie quand |
|---|---|
| `build` | la commande de build a réussi (`not_applicable` pour redeploy, rollback et restart) |
| `containerCreated` | une tâche de la **nouvelle** spec (même `ForceUpdate`, créée après le déploiement) a un conteneur |
| `containerRunning` | cette tâche est `running` depuis ≥ 10 s. **Échec** dès 2 tâches en échec sans tâche active, ou 3 au total |
| `healthy` | healthcheck Docker `healthy` ; `not_applicable` sans healthcheck, auquel cas l'app **n'est pas déclarée saine** |
| `reachable` | pas de `REVERSE_PROXY_UNREACHABLE` selon les sondes Traefik ; `not_applicable` sans domaine |

**Échéance** : 120 s, prolongée selon le healthcheck (`start_period + interval × (retries+1)`, 10 min max).

**Statut global** (`verificationStatus`) :

| Statut | Signification |
|---|---|
| `healthy` | toutes les étapes sont passées, healthcheck compris |
| `running` | l'app tourne et répond, mais aucun healthcheck n'a pu le prouver |
| `degraded` | l'app tourne, mais elle est malsaine ou injoignable |
| `failed` | le build ou le démarrage a échoué |
| `unknown` | la vérification a été interrompue (déploiement plus récent, erreur, redémarrage du serveur) |

À la fin, le moteur de diagnostic tourne et les codes trouvés sont enregistrés dans `verification.findings`.

`deployment.status` garde la sémantique upstream (`done` = build et mise à jour acceptés), pour rester compatible avec l'UI et les notifications existantes. **C'est `verificationStatus` qui dit si l'application fonctionne.**

## Statut de version

`smartDeploy.getVersionStatus({ applicationId, checkRemote })` renvoie :
- **Live** : tâches en cours, conteneur, `runningImageId`.
- **Current** : le déploiement dont `imageId` = image réellement exécutée (`currentMatch: "image_match"`). À défaut, le dernier déploiement réussi est renvoyé avec `currentMatch: "latest_successful"` : le commit exécuté est alors déclaré **inconnu**.
- **Latest remote** : tête de branche vérifiée via l'API du provider (GitHub, GitLab, Gitea, Bitbucket, avec les identifiants déjà configurés) ou `git ls-remote` (Git personnalisé, HTTP(S) ou SSH avec la clé configurée, écrite dans un fichier temporaire supprimé à la sortie). En cas d'échec, `status: "error"` avec la raison : **jamais de commit supposé**.
- `versionState` : `up_to_date`, `outdated`, `unknown` ou `not_applicable`, avec une explication.
- `recommendedAction` : `deploy_latest`, `diagnose` ou `none`.
- `history` : les 20 derniers déploiements avec leurs champs de version et `redeployable`.

Deux règles de diagnostic utilisent ces données :
- `GIT_COMMIT_OUTDATED` : le commit exécuté diffère de la tête distante **vérifiée**. Correctif proposé : `deploy_latest`.
- `IMAGE_VERSION_MISMATCH` : le dernier déploiement `done` a enregistré une image différente de celle qui tourne. Correctif proposé : `redeploy_deployment`.

## Résultats mesurés (devbox, 02/11/2026)

`node dev/demo-apps/version-scenario.mjs` joue le scénario E : deploy latest → push → outdated → deploy latest → rollback → restart → rebuild. **22/22 vérifications réussies**, notamment :
- commit demandé = récupéré = construit, image taguée, vérification `healthy` ;
- après un push : `outdated` avec le commit distant réellement vérifié, et diagnostic `GIT_COMMIT_OUTDATED` ;
- rollback : aucune récupération Git, image identique à celle du déploiement 1, **image réellement exécutée vérifiée**, ancienne version servie ;
- restart : même image, même version servie ;
- rebuild : `fetchedCommitSha = null`, `builtCommitSha` = commit du dernier clone (explicite).

Vérification des apps en échec, toutes `done` dans le statut upstream :

| App | verificationStatus | Étapes | Constats |
|---|---|---|---|
| A | healthy | tout passé | — |
| B | degraded | running ✓, healthy ✓, reachable ✗ | PORT_MISMATCH, REVERSE_PROXY_UNREACHABLE |
| C | failed | running ✗ | CONTAINER_CRASH_LOOP |
| D | failed | running ✗ | MISSING_ENVIRONMENT_VARIABLE, CONTAINER_CRASH_LOOP |
| G | degraded | running ✓, healthy n/a, reachable ✗ | APPLICATION_LISTENING_ON_LOCALHOST, REVERSE_PROXY_UNREACHABLE |

Le premier essai, pour G, ne remontait que la conséquence : le diagnostic final tournait avant le délai de grâce de 20 s des règles d'écoute. La vérification attend désormais ce délai ; le résultat ci-dessus vient du second essai.

## Limites

- **Compose** et **previews** ne sont pas suivis : ils gardent le comportement upstream.
- **Rebuild d'un commit précis** : non implémenté. Rebuild reconstruit le dernier clone, et le dit. Pour revenir à une version antérieure, utiliser Redeploy/Rollback (image conservée).
- **Restart** : la spec Swarm référence `<app>:latest`. Si `latest` a été déplacé sans mise à jour du service, le restart lance la nouvelle image ; `IMAGE_VERSION_MISMATCH` le signale.
- **Swarm multi-nœuds avec registre** : l'ID d'image est mesuré sur le serveur de build, et le digest de registre n'est disponible qu'après push.
- **`docker image prune --all`** (nettoyage Dokploy « Clean all images ») supprime les images conservées qui ne sont pas utilisées. Redeploy le détecte et refuse avec un message clair.
- **Interruption** : une vérification interrompue par un redémarrage de Dokploy reste `verifying`. Elle est présentée comme `unknown` au-delà de 15 min.
- **Webhooks** : le SHA poussé n'est pas encore utilisé. `requestedCommitSha` est la tête de branche lue au moment du déploiement.
- **Dokploy Cloud** : `redeployVersion` est refusé (le chemin d'exécution distant d'upstream ne connaît pas ce type de job).
