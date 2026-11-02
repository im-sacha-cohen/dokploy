# Développement local (macOS / Linux)

L'environnement local tourne dans un **devbox Docker-in-Docker** : un seul conteneur privilégié (`dokploy-devbox`) qui embarque **son propre démon Docker**. Swarm, `dokploy-network`, Traefik, Postgres et toutes les applications déployées vivent dans ce démon interne.

- Le démon Docker de l'hôte (Docker Desktop) **n'est pas passé en mode Swarm**, et les autres conteneurs de la machine ne sont pas touchés.
- Tous les ports sont liés à `127.0.0.1`. Rien n'est exposé sur le réseau.
- Le dossier `.devcontainer/` d'upstream utilise la même approche (docker-in-docker).

## Prérequis

| Outil | Version testée | Remarque |
|---|---|---|
| macOS | 26.2, Apple Silicon | Intel non testé |
| Docker Desktop | 27.4 (Compose v2.31) | 8 Go de RAM alloués suffisent |
| Espace disque | ~10 Go | image devbox + images de build + `node_modules` |

Node.js, pnpm, nixpacks, railpack et pack sont **dans le devbox**. Rien n'est à installer sur l'hôte.

## Commandes

```bash
./scripts/dev-start.sh     # build + démarrage, attend que l'UI réponde
./scripts/dev-stop.sh      # arrêt, données conservées
./scripts/dev-test.sh      # tests Vitest dans le devbox (args passés à vitest)
./scripts/dev-reset.sh     # SUPPRIME le devbox et ses volumes (confirmation demandée)
```

Équivalent sans script : `docker compose -f docker-compose.dev.yml up -d --build`.

Le premier démarrage installe les dépendances (`pnpm install --frozen-lockfile`, compilation des modules natifs) et dure environ 5 à 10 minutes. Les démarrages suivants ne réinstallent que si `pnpm-lock.yaml` a changé.

### Ce que fait le démarrage (`dev/devbox/entrypoint.sh`)

1. Démarre `dockerd` dans le conteneur, avec ses données dans le volume `dokploy-dev_docker-data`.
2. Démarre le serveur Git de démo (`dev/git-server.mjs`, port 4040 interne) si les dépôts de démo existent.
3. Crée `apps/dokploy/.env` depuis `.env.example` s'il est absent.
4. Exécute `pnpm install`, puis `pnpm server:script`, puis `pnpm dokploy:setup` (swarm init, réseau, Traefik, Postgres, migrations ; idempotent).
5. Lance `pnpm dokploy:dev` (hot reload : le code est monté depuis l'hôte).

> `pnpm server:script` modifie `packages/server/package.json` (exports vers `src/`), comme dans le workflow upstream. **Ne pas committer ce changement.**

## Accès

| Service | URL |
|---|---|
| Interface Dokploy | http://localhost:3000 |
| Applications (via Traefik) | `http://<host>.docker.localhost:8880` |
| Traefik HTTPS | `https://…:8443` |
| Shell dans le devbox | `docker exec -it dokploy-devbox bash` |
| Docker interne | `docker exec dokploy-devbox docker ps` |
| Logs du serveur dev | `docker compose -f docker-compose.dev.yml logs -f devbox` |

Les ports sont configurables dans `dev/.env` (voir `dev/.env.example`). Les valeurs par défaut évitent 80, 5432 et 8080, souvent déjà utilisés sur macOS.

`*.docker.localhost` est résolu vers `127.0.0.1` par les navigateurs et par curl. Pour tester sans DNS : `curl -H "Host: a-healthy.docker.localhost" http://127.0.0.1:8880/`.

## Compte de test et applications de démonstration

`dev/.env` (gitignoré, `chmod 600`) contient l'URL locale et un compte propriétaire **de test uniquement**, avec un mot de passe aléatoire généré localement.

```bash
docker exec dokploy-devbox /workspace/dev/demo-apps/init-repos.sh   # dépôts Git de démo
node dev/demo-apps/seed.mjs --deploy                               # projet + apps + domaines + déploiement
```

`seed.mjs` refuse toute URL qui n'est pas `localhost` ou `127.0.0.1`. Il passe par l'API REST de Dokploy, donc par les mêmes chemins de code que l'interface.

| App | Scénario | Résultat constaté avec Dokploy upstream (02/11/2026) |
|---|---|---|
| A `a-healthy` | Déploiement normal, healthcheck Docker | `done`, service 1/1, HTTP 200 |
| B `b-wrong-port` | Écoute sur 3000, domaine routé vers 80 | **`done`**, service 1/1 sain, **HTTP 502** |
| C `c-crash-loop` | `exit 1` au démarrage | **`done`**, service 0/1, redémarrages en boucle, **502** |
| D `d-missing-env` | `DATABASE_URL` et `SESSION_SECRET` absentes (exit 78) | **`done`**, 0/1, **502** |
| E `e-outdated` | v1 déployée, puis `e-outdated-push-v2.sh` pousse une v2 | `done`, 200 (scénario de version à jouer) |
| F `f-compose` | web + redis avec healthchecks et `depends_on` | `done`, 2 conteneurs sains, 200 |
| G `g-localhost-bind` | Écoute sur `127.0.0.1:3000` uniquement | **`done`**, 1/1, **502** |

Ce tableau est la référence avant modification : **les 7 déploiements sont marqués `done` alors que 4 applications sont inaccessibles.**

Pour le scénario E : `docker exec dokploy-devbox /workspace/dev/demo-apps/e-outdated-push-v2.sh` fait avancer la branche distante sans redéployer.

## Incompatibilités macOS et contournements

| Contrainte Dokploy | Situation sur macOS | Solution |
|---|---|---|
| Docker Swarm + overlay | Possible sur Docker Desktop, mais modifierait le démon partagé | Swarm dans le démon interne du devbox |
| Traefik en ports `host` 80/443 | 80 souvent occupé | Ports publiés sur 8880/8443 de l'hôte |
| Postgres publié sur 5432 en dev | 5432 souvent occupé | Publié uniquement dans le devbox |
| `node_modules` natifs (bcrypt, node-pty, ssh2…) | Binaires darwin et linux incompatibles | `node_modules` dans des volumes Linux |
| `.docker/` (BASE_PATH dev : clones, logs, Traefik) | Lent et sensible à la casse sur un bind mount | Volume `dokploy-dev_dokploy-data` |
| Sources Git personnalisées : HTTP(S) obligatoire sans clé SSH, `--depth 1` | Le protocole HTTP « dumb » ne gère pas le shallow clone | Petit serveur Git *smart HTTP* (`dev/git-server.mjs`) |

## Non couvert par cet environnement

- Serveurs distants (SSH multi-nœuds), certificats Let's Encrypt réels, HTTP/3.
- Domaines publics : pas de tunnel. Un tunnel HTTPS (par exemple pour connecter claude.ai à `/mcp`) ne sera mis en place qu'avec accord explicite.
- Edition Cloud (`apps/api`, Inngest) et `apps/schedules` (Redis/BullMQ) : non démarrés.

## Dépannage

- **Le devbox s'arrête au démarrage** : consulter `docker compose -f docker-compose.dev.yml logs devbox`, puis `docker exec dokploy-devbox tail -50 /var/log/dockerd.log` pour le démon interne.
- **Port déjà utilisé** : `dev-start.sh` le signale. Le changer dans `dev/.env`.
- **Repartir de zéro** : `./scripts/dev-reset.sh`. Il liste les volumes concernés et exige de taper `delete`.
