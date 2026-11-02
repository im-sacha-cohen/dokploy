# Serveur MCP natif — architecture

Dokploy expose un serveur MCP (Model Context Protocol) à l'adresse `https://<instance>/mcp`. Un client IA (Claude, agent d'IDE…) s'y connecte avec le compte Dokploy d'un utilisateur, après son consentement explicite. La sécurité est détaillée dans `MCP_SECURITY.md`.

## Vue d'ensemble

```
Client MCP ──(1) POST /mcp sans token──────────────► 401 + WWW-Authenticate: resource_metadata=…
           ──(2) GET /.well-known/oauth-protected-resource/mcp ─► { resource, authorization_servers }
           ──(3) GET /.well-known/oauth-authorization-server/api/auth ─► endpoints OAuth (RFC 8414)
           ──(4) POST /api/auth/oauth2/register (RFC 7591) ─► client public
           ──(5) navigateur : /api/auth/oauth2/authorize (PKCE S256, resource=…/mcp)
                     └─ pas de session → page de login Dokploy → reprise automatique
                     └─ /oauth/consent : organisation + permissions cochées
           ──(6) POST /api/auth/oauth2/token (code + verifier) ─► JWT (aud=…/mcp, 15 min) + refresh token
           ──(7) POST /mcp  Authorization: Bearer … ─► outils, ressources
```

## Composants

| Rôle | Emplacement | Réutilise |
|---|---|---|
| Serveur d'autorisation OAuth 2.1 | plugins `oauthProvider` (`@better-auth/oauth-provider` 1.6.23) et `jwt` dans `packages/server/src/lib/auth.ts` | **l'auth better-auth existante** : mêmes comptes, sessions, 2FA, passkeys et SSO. Pas de second système d'identité |
| Tables OAuth | `db/schema/oauth.ts` : `oauth_client`, `oauth_access_token`, `oauth_refresh_token`, `oauth_consent`, `jwks` | migration `0200_mcp_oauth` |
| État MCP de Dokploy | `mcp_settings` (par organisation), `mcp_grant` (organisation et scopes accordés à un client par un utilisateur), `mcp_audit_log` | — |
| Vérification des tokens | `mcp/token.ts` | `verifyJwsAccessToken` de better-auth, JWKS lu en mémoire (aucun appel HTTP) |
| Endpoint HTTP | `mcp/http.ts`, `pages/api/mcp.ts`, réécriture `/mcp` → `/api/mcp` | `createMcpHandler` du SDK `@modelcontextprotocol/server` 2.4.0 |
| Outils et ressources | `mcp/tools.ts` | services Dokploy (`findApplicationById`, `checkServiceAccess`…), moteurs `smart-deploy` (diagnostic, version, actions) |
| Déploiements | file de déploiement existante, via `server/utils/enqueue-application-job.ts` (partagé avec l'UI) | `myQueue` |
| Consentement | `pages/oauth/consent.tsx` | composants UI Dokploy |
| Réglages | Settings › AI Integrations (`pages/dashboard/settings/ai-integrations.tsx`), routeur tRPC `mcp` | — |

La logique métier est **partagée entre l'UI et MCP** : un outil MCP appelle les mêmes fonctions que les routes tRPC (diagnostic, statut de version, restart, redeploy, file de déploiement, mise à jour de domaine).

## Transport et protocole

- **Streamable HTTP**, sans état. Chaque requête crée une instance `McpServer` avec les outils de l'utilisateur authentifié ; aucune session côté serveur.
- **Protocole 2026-07-28** : enveloppe `_meta` `io.modelcontextprotocol/*` et en-têtes `MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name`.
- **Clients 2025-xx** (`initialize`, 2025-06-18, 2025-11-25) : servis par le repli sans état du SDK (`legacy: "stateless"`). GET et DELETE (sessions 2025) répondent 405.
- Corps limité à 1 Mio, réponse JSON ou SSE selon le besoin.

## Outils

| Scope | Outils |
|---|---|
| `mcp:read` | `dokploy_list_projects`, `dokploy_list_applications`, `dokploy_get_application`, `dokploy_get_deployments`, `dokploy_get_deployment_status`, `dokploy_get_deployment_logs`, `dokploy_get_runtime_version`, `dokploy_get_application_health`, `dokploy_get_port_configuration`, `dokploy_diagnose_deployment`, `dokploy_list_servers` |
| `mcp:deploy` | `dokploy_deploy_application`, `dokploy_deploy_latest`, `dokploy_rebuild_application`, `dokploy_restart_application`, `dokploy_rollback_deployment` |
| `mcp:config` | `dokploy_update_application_port`, `dokploy_update_domain`, `dokploy_update_healthcheck` |

**Ressources** : `dokploy://application/{applicationId}` et `dokploy://deployment/{deploymentId}/timeline`.

**Exclusions** :
- aucun outil de commande arbitraire, de shell, de `docker exec` ni d'accès au socket Docker ;
- aucune lecture de valeurs de variables d'environnement ;
- aucune création ni suppression de service ;
- aucune modification de serveur.

**Précisions sur certains outils** :
- `deploy_application` et `deploy_latest` font tous deux un fetch + build de la branche ; `deploy_latest` vérifie et renvoie d'abord la tête distante.
- `rebuild_application` reconstruit le dernier clone, sans fetch.
- `rollback_deployment` relance une image conservée (voir `SMART_DEPLOY_ENGINE.md`).
- `update_healthcheck` ne prend effet qu'au prochain déploiement.

Tous les outils sont listés quel que soit le token. Appeler un outil hors scope renvoie **403 `insufficient_scope`** avec `WWW-Authenticate`, ce qui permet au client de demander un consentement plus large (*step-up*).

## Configuration

| Variable | Rôle |
|---|---|
| `DOKPLOY_MCP_RESOURCE_URL` | URL publique de `/mcp` (par exemple `https://dokploy.example.com/mcp`), plusieurs séparées par des virgules. **Obligatoire en production.** Elle sert d'audience des tokens et de liste blanche des Host. Sans elle, `/mcp` répond 503. En développement, elle vaut par défaut `http://localhost:3000/mcp` |

Côté organisation, l'intégration est **désactivée par défaut**. Un owner ou un admin l'active dans Settings › AI Integrations et choisit les scopes autorisés.

**Connexion d'un client** : `claude mcp add --transport http dokploy https://<instance>/mcp`, ou l'ajout d'un serveur MCP distant dans un autre client. La découverte OAuth est automatique.

## Compatibilité upstream

Changements dans du code existant :
- 2 plugins ajoutés à better-auth, plus `"/token"` dans `disabledPaths`, et 2 méthodes exposées (`getJwks`, `getOAuthServerConfig`) ;
- page de login : après connexion, elle suit la redirection OAuth si une autorisation est en cours (`continueAfterLogin`), sinon comportement inchangé ;
- `oauthProviderClient()` ajouté au client d'auth : il n'agit que sur les pages portant une requête OAuth signée (`sig`) ;
- `next.config.mjs` : réécritures `/mcp` et `/.well-known/*` ;
- une entrée de menu Settings, un routeur tRPC `mcp`, une migration ;
- 2 dépendances : `@better-auth/oauth-provider` (même version que better-auth) et `@modelcontextprotocol/server` (déjà présent dans le lockfile en dépendance transitive).

## Limites

- **Client ID Metadata Documents** (recommandés par la spec 2026-07-28) : non pris en charge. better-auth le fait via `@better-auth/cimd`, non installé pour l'instant. L'enregistrement dynamique (RFC 7591), encore optionnel dans la spec, est utilisé.
- **Notifications** `subscriptions/listen` : non exploitées (aucun événement publié).
- **Un grant par couple utilisateur/client**, lié à une seule organisation. Ré-autoriser le client permet d'en changer.
- **Instance unique** : la limitation de débit est en mémoire.
- **Dokploy Cloud** : les outils de déploiement sont refusés (même limite que `redeployVersion`).
- **Pas de tunnel public** : un client distant comme claude.ai ne peut pas joindre l'instance locale. Seuls des clients locaux ont été testés (voir `TESTING.md`).
