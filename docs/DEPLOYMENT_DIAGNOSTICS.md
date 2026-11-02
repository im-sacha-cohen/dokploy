# Diagnostics de déploiement

Moteur **déterministe** qui explique pourquoi une application déployée ne fonctionne pas. Il ne s'appuie sur aucune IA. Il observe Docker et Traefik en **lecture seule**, puis applique des règles écrites en code et testées.

Code : `packages/server/src/smart-deploy/diagnostics/`
API : `smartDeploy.diagnoseApplication` (tRPC, et en REST `GET /api/smartDeploy.diagnoseApplication?applicationId=…`)

## Principes

1. **Faits d'abord, règles ensuite.** Un collecteur rassemble des faits (`DiagnosticContext`), puis les règles, des fonctions pures, produisent des constats. Les règles se testent sans Docker.
2. **Ne jamais conclure sur une donnée absente.** Un fait non collecté reste `undefined`, et la raison est consignée dans `collectionErrors`. Exemple : si les sockets en écoute ne peuvent pas être lus, `PORT_MISMATCH` retombe sur `EXPOSE` avec une confiance `medium` et sans correctif automatique.
3. **Lecture seule.** Le moteur ne modifie rien. Un correctif proposé (`recommendedFix.action`) est une donnée : son application, prévue en Phase 5, exigera une confirmation explicite.
4. **Aucun secret.**
   - Les valeurs des variables d'environnement ne sont jamais renvoyées, seuls les noms le sont.
   - Les logs passent par un *redactor* : les valeurs configurées sont remplacées par `[REDACTED:CLÉ]`.
   - Les motifs génériques (`password=`, URL avec identifiants, Bearer, JWT, clés AWS, clés PEM) sont masqués.
   - Les séquences ANSI et les caractères de contrôle sont retirés (protection contre l'injection dans les logs).
   - Les lignes sont tronquées à 500 caractères.
   - Le fichier `.env` du dossier de build n'est jamais lu. Seul `.env.example`, `.env.sample` ou `.env.template` l'est, et uniquement pour les noms.

## Format d'un constat

| Champ | Contenu |
|---|---|
| `code` | identifiant stable (tableau ci-dessous) |
| `title`, `description` | texte lisible (français) |
| `severity` | `critical`, `error`, `warning` ou `info` |
| `confidence` | `high`, `medium` ou `low` |
| `evidence[]` | preuves observées : `source` (docker_task, listening_sockets, proxy_probe…), résumé, extrait de log déjà nettoyé |
| `probableCause` | cause probable |
| `recommendedFix` | `summary`, et parfois `action` structurée (`update_domain_port`, `set_environment_variables`) |
| `risk` | risque du correctif : `none`, `low`, `medium` ou `high` |
| `autoFixable` | `true` uniquement si le correctif est sûr **et** déterminé sans ambiguïté |
| `causedBy` | codes dont ce constat est la conséquence |

Le rapport contient aussi :
- un verdict : `healthy`, `degraded`, `down` ou `unknown` ;
- les faits bruts utiles à l'interface (ports en écoute, `EXPOSE`, sondes, tâches) ;
- `collectionErrors`, la liste de ce qui n'a pas pu être vérifié.

## Règles

| Code | Déclencheur | Confiance | Correctif auto |
|---|---|---|---|
| `BUILD_FAILED` | dernier déploiement en statut `error` ; extrait des lignes d'erreur du log de build | high | non |
| `CONTAINER_CRASH_LOOP` | ≥ 2 tâches Swarm `failed` ou `rejected` en 10 min sans tâche en cours (critique), ou ≥ 3 avec une tâche en cours (avertissement « redémarre régulièrement ») ; le code de sortie est expliqué (1, 78, 127, 137 = OOM…) | high / medium | non |
| `MISSING_ENVIRONMENT_VARIABLE` | (a) les logs nomment une variable manquante (Node, Python `KeyError`, shell `unbound variable`…) absente de la configuration et de l'image ; (b) une clé de `.env.example` n'est pas définie | high (a) ; medium ou low (b) | non : les valeurs sont à fournir par l'utilisateur |
| `HEALTHCHECK_FAILED` | conteneur `unhealthy`, ou tâches tuées par Swarm pour cause de healthcheck | high | non |
| `APPLICATION_NOT_LISTENING` | conteneur démarré depuis ≥ 20 s, aucun socket TCP en écoute | high | non |
| `APPLICATION_LISTENING_ON_LOCALHOST` | sockets en écoute uniquement sur 127.0.0.1 ou ::1 | high | non |
| `PORT_MISMATCH` | port du domaine absent des ports en écoute (hors localhost) ; à défaut de sockets, absent des `EXPOSE` (medium) ; port publié dont la cible n'écoute pas | high / medium | **oui**, si un seul port candidat (high) |
| `REVERSE_PROXY_UNREACHABLE` | sonde Traefik → domaine en 502, 503 ou 504, ou Traefik → service refusé ou injoignable ; ou 404 sur le domaine alors que le service répond (routeur manquant) | high | non |
| `IMAGE_VERSION_MISMATCH`, `GIT_COMMIT_OUTDATED` | codes réservés : nécessitent le suivi de version (Phase 4) | — | — |

### Chaînage des causes

Le moteur relie les conséquences à leurs causes : `REVERSE_PROXY_UNREACHABLE` peut avoir pour cause `PORT_MISMATCH`, `CONTAINER_CRASH_LOOP`, etc., et `CONTAINER_CRASH_LOOP` peut avoir pour cause `MISSING_ENVIRONMENT_VARIABLE`. Une conséquence passe de `critical` à `error`, et son correctif renvoie vers la cause. Les constats sont triés par gravité, puis par confiance.

### Ajouter une règle

Une règle est une fonction `(ctx: DiagnosticContext) => Finding | Finding[] | null` :
1. l'écrire dans `rules/` ;
2. l'ajouter à `DEFAULT_RULES` (`engine.ts`) ;
3. si elle est la conséquence d'autres constats, compléter `CAUSALITY` ;
4. ajouter des tests dans `apps/dokploy/__test__/smart-deploy/`.

Une règle qui lève une exception n'interrompt pas le rapport : l'erreur est consignée dans `collectionErrors`.

## Comment les faits sont collectés

Tout passe par l'API Docker (`dockerode`, locale ou distante via `getRemoteDocker(serverId)`), donc cela fonctionne aussi pour les serveurs distants. Aucun socket Docker n'est exposé.

| Fait | Source |
|---|---|
| Service, réplicas, image | `service inspect` |
| Historique des tâches, erreurs, codes de sortie | `task ls` (20 dernières) |
| Health, `EXPOSE`, clés d'env de l'image | `container inspect` de la tâche en cours |
| Sockets en écoute | `exec cat /proc/net/tcp /proc/net/tcp6` dans le conteneur (commande fixe, argv sans shell) ; le résolveur DNS Docker 127.0.0.11 est ignoré |
| Logs applicatifs | `service logs --tail 60`, nettoyés |
| Joignabilité | `exec wget` dans le conteneur `dokploy-traefik`, c'est-à-dire depuis le point de vue réseau du proxy : (1) `http://<appName>:<port><path>` et (2) `http://127.0.0.1:80<path>` avec `Host: <domaine>`. Hôtes et chemins validés par liste blanche ; 5 domaines maximum |
| Log de build | `tail` du `logPath` du dernier déploiement (seulement s'il a échoué) |
| `.env.example` | dossier de build `…/applications/<appName>/code/<buildPath>` |

## Résultats sur les applications de démo (devbox, 02/11/2026)

Commande : `node dev/demo-apps/diagnose.mjs` (option `--json` pour le rapport complet).

| App | Statut Dokploy | Verdict | Constats |
|---|---|---|---|
| A healthy | done | **healthy** | aucun |
| B wrong port | done | **down** | `PORT_MISMATCH` (domaine 80, écoute 3000, correctif auto → 3000) → `REVERSE_PROXY_UNREACHABLE` |
| C crash loop | done | **down** | `CONTAINER_CRASH_LOOP` (exit 1) → `REVERSE_PROXY_UNREACHABLE` |
| D missing env | done | **down** | `MISSING_ENVIRONMENT_VARIABLE` (DATABASE_URL, SESSION_SECRET, tirées des logs) → `CONTAINER_CRASH_LOOP` (exit 78) → `REVERSE_PROXY_UNREACHABLE` |
| E outdated | done | **healthy** | aucun (le scénario de version relève de la Phase 4) |
| G localhost | done | **down** | `APPLICATION_LISTENING_ON_LOCALHOST` → `REVERSE_PROXY_UNREACHABLE` |

Les 4 applications « done mais en 502 » de la référence sont désormais identifiées, avec leur cause racine.

## Limites connues

- **Applications Swarm uniquement.** Les services Docker Compose (app F) ne sont pas encore couverts ; ce sera avec la timeline (Phase 4/5).
- **Swarm multi-nœuds** : si la tâche tourne sur un autre nœud que le manager joint par Dokploy, `container inspect` et la lecture des sockets échouent. C'est signalé dans `collectionErrors`, et les règles basées sur les sockets ne concluent pas.
- **Images sans `cat`** (distroless, scratch) : sockets non lus, donc retour sur `EXPOSE`. Un conteneur auxiliaire éphémère (`--network container:<id>`) est envisagé, mais pas implémenté.
- **Domaines HTTPS** : la sonde passe par l'entrypoint `web` (80). Une redirection 3xx est considérée comme « routeur présent » ; la chaîne TLS n'est pas vérifiée.
- **Messages de variables manquantes** : la détection par logs couvre les formulations courantes (voir `log-patterns.ts` et ses tests). Un message atypique ne sera pas reconnu, et aucun constat ne sera inventé.
- Les rapports ne sont **pas encore persistés** : ils sont calculés à la demande. Une table `diagnostic_report` est prévue avec la timeline.
- Le droit requis est la **lecture** du service (`checkServiceAccess(…, "read")`), comme pour `readLogs`.
