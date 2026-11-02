# Bilan du fork — Smart Deploy + MCP natif

État au 02/11/2026, branche `feat/smart-deploy-mcp` : commits locaux uniquement, **rien n'a été poussé**.

## Critères de réussite du brief

| Critère | Statut | Preuve |
|---|---|---|
| Dokploy démarre en local sur le Mac | ✅ | devbox Docker-in-Docker (`scripts/dev-start.sh`), Docker Desktop non modifié ; redémarrage complet validé |
| Accès à l'interface web | ✅ | http://localhost:3000, compte de test (`dev/.env`) |
| Déployer une application de test | ✅ | apps de démo A–G ; Deploy Latest depuis l'assistant (navigateur) |
| Identifier le commit réellement exécuté | ✅ | carte « Current deployment » : commit prouvé par l'image exacte ; scénario E 22/22 |
| Diagnostiquer une erreur de port | ✅ | B : `PORT_MISMATCH` (domaine 80, écoute 3000), correctif appliqué en 1 clic après confirmation : 502 → 200 |
| Diagnostiquer un conteneur qui crash | ✅ | C : `CONTAINER_CRASH_LOOP` avec code de sortie et logs |
| Comprendre pourquoi un déploiement échoue | ✅ | D : variables manquantes nommées depuis les logs ; G : écoute sur localhost ; `BUILD_FAILED` avec les lignes d'erreur |
| Timeline de déploiement | ✅ | 6 étapes observées (build → reachable), en direct dans l'UI et via `dokploy_get_deployment_status` |
| Activer un serveur MCP | ✅ | Settings › AI Integrations (owner/admin), test de connexion 4/4 |
| Connecter un client MCP compatible | ⚠️ partiel | client scripté conforme à la spec (protocole 2026-07-28 et 2025-06-18), 36/36. **Aucun client tiers réel testé** : la commande pour Claude Code est fournie, mais modifier ta configuration Claude Code et te connecter dans le navigateur te reviennent |
| S'authentifier via OAuth | ✅ | Authorization Code + PKCE, découverte RFC 9728/8414, reprise après login |
| Consulter et accepter les permissions | ✅ | page de consentement testée dans le navigateur ; cases réellement appliquées |
| Un agent consulte mes projets autorisés | ✅ | `dokploy_list_projects` = exactement ce que l'UI montre au même utilisateur (27/27 isolation) |
| Un agent diagnostique un déploiement | ✅ | `dokploy_diagnose_deployment` |
| Un agent ne peut pas déployer sans permission | ✅ | 403 `insufficient_scope` sans `mcp:deploy` ; refus sur les apps non accordées, même avec le scope |
| Révoquer l'accès d'un agent | ✅ | révocation immédiate, token encore valide refusé (testé deux fois) |
| Tests de non-régression essentiels | ✅ avec réserve | 1661 tests passés ; les seuls échecs (4) sont les timeouts sous charge de `backup-files`, déjà présents avant le fork, qui passent seuls (voir `TESTING.md`) |

## Ce qui a été livré

| Phase | Commit | Contenu |
|---|---|---|
| 1–2 | `4402bf3` | audit, devbox, apps de démo |
| 3 | `4865da3` | moteur de diagnostic déterministe |
| 4 | `ad13de3` | suivi de version, vérification par étapes, redeploy/rollback/restart distincts |
| 5 | `b42b08b` | onglet Smart Deploy : preflight, timeline, corrections confirmées |
| 6 | `a5ba6c5` | serveur MCP, OAuth 2.1 sur better-auth, consentement, AI Integrations |
| 7 | Phase 7 | tests de permissions et d'isolation, stabilité, bilan |

Documentation : `ARCHITECTURE_AUDIT`, `LOCAL_DEVELOPMENT`, `DEPLOYMENT_DIAGNOSTICS`, `SMART_DEPLOY_ENGINE`, `MCP_ARCHITECTURE`, `MCP_SECURITY`, `TESTING`, `IMPLEMENTATION_PROGRESS`.

## Rejouer tous les tests

```bash
./scripts/dev-start.sh
./scripts/dev-test.sh            # suite Vitest complète (~7 min)
dev/phase7/run-all.sh            # diagnostics A–G, version E, isolation, OAuth+MCP
```

## Limitations connues (consolidées)

**Moteur de déploiement et diagnostics**
- **Compose** (app F) et **previews** : non diagnostiqués ni suivis ; ils gardent le comportement upstream.
- **Images sans `cat`** (distroless) : les sockets en écoute ne peuvent pas être lus ; le diagnostic se rabat sur `EXPOSE`, avec une confiance moyenne.
- **Swarm multi-nœuds** : faits partiels quand la tâche tourne sur un autre nœud, signalés dans le rapport.
- **Rebuild d'un commit précis** : non disponible. Rebuild reconstruit le dernier clone ; pour revenir à une version, utiliser Redeploy ou Rollback (5 images conservées, sans registre).
- **SHA poussé par webhook** : non exploité ; le commit demandé est la tête de branche lue au déclenchement.
- **Rapports de diagnostic** : non persistés, recalculés à la demande.

**MCP et OAuth**
- **Client ID Metadata Documents** : non pris en charge, l'enregistrement dynamique (RFC 7591) est utilisé.
- **Clients enregistrés jamais autorisés** : aucune purge automatique.
- **Rate limiting en mémoire** : à remplacer par un stockage partagé en multi-instance.
- **Tokens** : pas de DPoP, refresh token non lié à l'appareil.
- **Client distant** (claude.ai) : nécessite un tunnel HTTPS public, non mis en place sans ton accord.
- **Dokploy Cloud** : actions de déploiement MCP refusées.

**Langue**
- Interface en anglais (comme Dokploy), mais constats, raisons et recommandations générés côté serveur en français. **Décision à prendre** : passer ces messages en anglais, ou les rendre traduisibles.

**Constaté dans upstream, non corrigé**
- Au démarrage, le setup tente de recréer Traefik et échoue sur une entrée DNS Swarm existante (`dokploy-traefik-previous`). Traefik reste en service.
- Tests `backup-files` instables sous charge (timeout de 5 s).

## Décisions qui te reviennent

1. **Pousser** la branche vers ton fork `im-sacha-cohen/dokploy` (public) : rien n'a été poussé.
2. **Langue** des messages générés par le serveur.
3. **Tunnel HTTPS** temporaire pour tester claude.ai ou un client distant réel.
4. **Proposer upstream** ou garder le fork : la licence des dossiers `/proprietary` n'est pas touchée, mais le journal d'audit MCP est séparé de l'audit Dokploy pour cette raison.
