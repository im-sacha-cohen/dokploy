# Sécurité du serveur MCP

Principe : **un client MCP n'obtient jamais plus que ce que l'utilisateur qui l'a autorisé peut faire dans l'interface, et moins si l'utilisateur ou l'organisation le restreint.** Tout est revérifié côté serveur, à chaque requête.

## Permission effective

```
permission effective = scopes du token ∩ scopes du grant (cases cochées au consentement)
                     ∩ scopes autorisés par l'organisation ∩ permissions Dokploy de l'utilisateur
```

Les trois premiers termes sont recalculés à chaque requête (`mcp/token.ts`). Le quatrième est appliqué par chaque outil avec les fonctions de permission de Dokploy (`checkServiceAccess`, `checkServicePermissionAndAccess`, `checkPermission`, projets, environnements et services accessibles d'un membre), exactement comme pour les routes tRPC. Chaque objet est en plus vérifié comme appartenant à l'organisation du grant.

## OAuth 2.1

| Exigence | Mise en œuvre |
|---|---|
| Authorization Code + PKCE | PKCE obligatoire (S256) pour les clients publics ; grant `client_credentials` désactivé : tout token appartient à un utilisateur |
| Découverte | RFC 9728 (`/.well-known/oauth-protected-resource/mcp`), RFC 8414 (`/.well-known/oauth-authorization-server/api/auth` et à la racine), `WWW-Authenticate: Bearer resource_metadata=…` sur les 401 |
| Enregistrement des clients | RFC 7591 sans authentification (nécessaire aux clients MCP) ; scopes limités aux scopes MCP ; tout client doit ensuite passer par le consentement d'un utilisateur |
| Resource indicators / audience (RFC 8707) | `resource` obligatoire ; seules les URLs de `DOKPLOY_MCP_RESOURCE_URL` sont acceptées ; le JWT porte `aud = …/mcp`, vérifié par `/mcp` |
| Tokens courts | JWT d'accès de 15 min, refresh token de 7 jours, code d'autorisation à usage unique (rejeu refusé : testé) |
| Révocation | Settings › AI Integrations ou `mcp.revokeGrant` : suppression du grant, du consentement et des tokens. Le JWT encore valide est **refusé immédiatement**, car `/mcp` vérifie le grant à chaque requête (testé). Endpoint RFC 7009 de better-auth disponible |
| Validation des redirect URI | correspondance exacte avec les URIs enregistrées (better-auth) ; `iss` renvoyé avec le code (RFC 9207) |
| CSRF | requête OAuth signée (`sig`, expiration) entre authorize, login et consentement ; cookies de session `SameSite=Lax` ; `state` restitué au client |
| Validation serveur des tokens | signature (JWKS local), `iss`, `aud`, `exp`, puis client actif, grant existant, organisation MCP active et appartenance du membre |
| Pas de token passthrough | le token MCP n'est jamais transmis à un autre service ; les appels aux providers Git utilisent les identifiants déjà configurés côté serveur |
| Pas de jeton admin exposé | aucun token d'API Dokploy ni secret n'est émis ou renvoyé |

## Consentement

La page `/oauth/consent` affiche le nom du client, ses domaines de redirection, l'organisation et chaque permission avec sa description.
- **Moindre privilège par défaut** : seul `mcp:read` est pré-coché.
- Une case décochée n'est **ni dans le grant ni dans le consentement OAuth**. Testé : un client demandant `mcp:read mcp:deploy` n'a obtenu que `{mcp:read}`.
- Une permission non autorisée par l'organisation est grisée.
- Si l'intégration est désactivée dans toutes les organisations de l'utilisateur, aucune autorisation n'est possible.

## Protection de l'endpoint `/mcp`

| Menace | Contrôle |
|---|---|
| DNS rebinding, faux Host | Host comparé à la liste des URLs configurées → **421** ; l'audience et l'issuer ne sont jamais déduits du Host |
| Pages web malveillantes (navigateur) | `Origin` d'un autre site → **403** |
| Sondage de tokens | 30 requêtes non authentifiées/min par IP → **429** (testé) ; tokens invalides journalisés |
| Abus d'un client | 120 requêtes/min et 10 mutations/min par couple utilisateur/client → **429** |
| Entrées malformées | schémas zod stricts (identifiants `[A-Za-z0-9_-]{1,64}`, ports 1–65535, hostnames, chemins) ; JSON invalide et corps > 1 Mio refusés |
| Oracle d'existence | « application inconnue » et « accès refusé » donnent la même réponse |
| Fuite de secrets | valeurs d'environnement jamais renvoyées (seulement les noms, et seulement avec la permission `envVars.read`) ; logs passés au redactor (valeurs configurées, mots de passe, tokens, JWT, clés AWS et PEM) |
| Injection dans les logs | séquences ANSI et caractères de contrôle supprimés, lignes tronquées ; même nettoyage pour les arguments stockés dans l'audit |
| Exécution arbitraire | aucun outil de shell ou `docker exec` ; les seules commandes exécutées sont fixes et internes (lecture de log par `tail` sur un chemin validé sous `LOGS_PATH`) |
| Isolation | grant lié à une organisation ; objets d'autres organisations ou projets non accordés → « not found or access denied » |
| Interruption client | `AbortSignal` propagé à la requête ; écriture de réponse arrêtée à la fermeture de la connexion |

## Journal d'audit

`mcp_audit_log` enregistre :
- chaque appel d'outil ou lecture de ressource : utilisateur, client, organisation, cible, durée, résultat `ok`, `denied`, `error` ou `rate_limited` ;
- chaque token rejeté, consentement, révocation et changement de réglages.

Les arguments sont réduits aux scalaires, puis nettoyés. Le journal est visible dans Settings › AI Integrations : en entier pour les owners et admins, limité à ses propres entrées pour un membre.

Le journal d'audit natif de Dokploy (`audit_log`) n'est pas utilisé : il relève du code sous licence propriétaire et dépend d'une licence entreprise.

## Rôles

| Action | Qui |
|---|---|
| Activer ou désactiver l'intégration, choisir les scopes autorisés | owner ou admin de l'organisation |
| Autoriser un client | tout membre, dans les limites ci-dessus |
| Voir et révoquer ses propres clients | tout membre |
| Voir et révoquer tous les clients, voir tout l'audit | owner ou admin |

## Limites et points ouverts

- **Enregistrement dynamique non authentifié** : un tiers peut créer des entrées `oauth_client` sans pouvoir rien en faire sans consentement utilisateur. Il n'y a pas encore de purge des clients jamais autorisés, ni de limite de débit dédiée sur `/oauth2/register` : seule la limitation générique de better-auth, active par défaut en production, s'applique.
- **Refresh token** : il n'est pas lié à l'appareil (pas de DPoP).
- **Rate limiting en mémoire** : à remplacer par un stockage partagé si Dokploy tourne sur plusieurs instances.
- **Tests de sécurité** : ils ont été exécutés en local (`dev/mcp/oauth-mcp-e2e.mjs`, 36 vérifications ; tests unitaires `mcp.test.ts`). L'isolation entre deux utilisateurs ou deux organisations distincts n'a pas encore été testée en réel (Phase 7).
