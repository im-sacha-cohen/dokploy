# MCP server security

Principle: **an MCP client never gets more than the user who authorized it can do in the interface, and less if the user or organization restricts it.** Everything is re-checked server-side, on every request.

## Effective permission

```
effective permission = token scopes ∩ grant scopes (boxes checked at consent)
                     ∩ scopes allowed by the organization ∩ the user's Dokploy permissions
```

The first three terms are recomputed on every request (`mcp/token.ts`). The fourth is enforced in two ways:
- the `platform-tools.ts` tools call **the UI's own tRPC procedures** (`api-bridge.ts`), with the context Dokploy already builds for an API key of that user in that organization (member role re-read from the database on every call). Only the procedures in `mcp/api-paths.ts` can be called;
- the other tools call Dokploy's permission functions (`checkServiceAccess`, `checkServicePermissionAndAccess`, `checkPermission`, a member's accessible projects, environments and services), exactly as the tRPC routes do. Each object is also checked to belong to the grant's organization.

## OAuth 2.1

| Requirement | Implementation |
|---|---|
| Authorization Code + PKCE | PKCE required (S256) for public clients; `client_credentials` grant disabled: every token belongs to a user |
| Discovery | RFC 9728 (`/.well-known/oauth-protected-resource/mcp`), RFC 8414 (`/.well-known/oauth-authorization-server/api/auth` and at the root), `WWW-Authenticate: Bearer resource_metadata=…` on 401s |
| Client registration | RFC 7591 without authentication (needed by MCP clients); scopes limited to MCP scopes; every client must still go through a user's consent |
| Resource indicators / audience (RFC 8707) | `resource` required; only the URLs in `DOKPLOY_MCP_RESOURCE_URL` are accepted; the JWT carries `aud = …/mcp`, checked by `/mcp` |
| Short-lived tokens | 15-minute access JWT, 7-day refresh token, single-use authorization code (replay rejected: tested) |
| Revocation | Settings › AI Integrations or `mcp.revokeGrant`: deletes the grant, the consent and the tokens. A still-valid JWT is **rejected immediately**, because `/mcp` checks the grant on every request (tested). better-auth's RFC 7009 endpoint is available |
| Redirect URI validation | exact match against registered URIs (better-auth); `iss` returned with the code (RFC 9207) |
| CSRF | signed OAuth request (`sig`, with expiry) across authorize, login and consent; `SameSite=Lax` session cookies; `state` returned to the client |
| Server-side token validation | signature (local JWKS), `iss`, `aud`, `exp`, then active client, existing grant, active MCP organization and member membership |
| No token passthrough | the MCP token is never forwarded to another service; calls to Git providers use credentials already configured server-side |
| No exposed admin token | no Dokploy API token or secret is issued or returned |

## Consent

The `/oauth/consent` page shows the client name, its redirect domains, the organization and each permission with its description.
- **Least privilege by default**: only `mcp:read` is pre-checked.
- An unchecked box is **neither in the grant nor in the OAuth consent**. Tested: a client requesting `mcp:read mcp:deploy` only got `{mcp:read}`.
- A permission not allowed by the organization is greyed out.
- If the integration is disabled in all of the user's organizations, no authorization is possible.

## Extended scopes and human confirmation

| Scope | Default | Risk covered |
|---|---|---|
| `mcp:env` | disabled | reading variables (secrets masked), writing |
| `mcp:manage` | disabled | creating and deleting projects, environments and services; stopping; backups and restore |
| `mcp:exec` | disabled | arbitrary command in a service's container |

An owner or admin allows them per organization. Consent only offers the allowed scopes, and the grant is re-checked on every request: removing a scope cuts access immediately.

**Confirmed actions**: deletion (service, environment, project, domain), service stop, backup restore and every command. Guarantees:
- the confirmation state is **signed (HMAC-SHA256)** with a key derived from `BETTER_AUTH_SECRET`. It expires after 5 min and binds the confirmation to the tool, the SHA-256 hash of the arguments, the user, the client and the grant. A modified state is rejected (`-32602`). A state reused for another command, or an unsigned one, triggers a new confirmation (tested);
- permission and existence checks happen **before** the question: a member without access is refused without seeing a confirmation (tested);
- a refusal (`decline`/`cancel`) executes nothing and is logged (`declined`); a request is logged (`confirmation_requested`).

**Command in a container** (`mcp:exec`):
- same checks as the UI's container terminal: access to the service, container belonging to the service (Docker labels), validated identifier, the organization's server;
- arguments passed to `docker exec` as an escaped list (`shell-quote`): the command only runs in the container, never in the host shell;
- maximum timeout of 120 s (`timeout -k 5`), output limited and sanitized (the service's environment values, database passwords, secret patterns), command recorded in the audit log after sanitization.

**Writing secrets**: allowed (`set_env_vars`, registry credentials). Writing a masked placeholder back (`[secret: …]`, `[REDACTED…]`) is refused, so that a real value is not overwritten. Written values are never stored in the audit log (only names are).

## `/mcp` endpoint protection

| Threat | Control |
|---|---|
| DNS rebinding, spoofed Host | Host compared against the list of configured URLs → **421**; the audience and issuer are never derived from the Host |
| Malicious web pages (browser) | `Origin` from another site → **403** |
| Token probing | 30 unauthenticated requests/min per IP → **429** (tested); invalid tokens are logged |
| Client abuse | 120 requests/min and 10 mutations/min per user/client pair → **429** |
| Malformed input | strict zod schemas (identifiers `[A-Za-z0-9_-]{1,64}`, ports 1–65535, hostnames, paths); invalid JSON and bodies > 1 MiB rejected |
| Existence oracle | "unknown application" and "access denied" give the same response |
| Secret leakage | variables whose name suggests a secret are masked (`[secret: set]`), other values sanitized (credentials in URLs, known secrets); database passwords, SSH keys and registry credentials are never returned; logs and command output go through the redactor (configured values, passwords, tokens, JWTs, AWS keys and PEM) |
| Log injection | ANSI sequences and control characters removed, lines truncated; same sanitization for arguments stored in the audit log |
| Arbitrary execution | only via `dokploy_exec_command`: `mcp:exec` scope disabled by default, human confirmation on every command, service container only. The other commands executed are fixed and internal (log reading via `tail` on a validated path under `LOGS_PATH`) |
| Isolation | grant tied to one organization; objects from other organizations or ungranted projects → "not found or access denied" |
| Client interruption | `AbortSignal` propagated to the request; response writing stops when the connection closes |

## Audit log

`mcp_audit_log` records:
- every tool call or resource read: user, client, organization, target, duration, and a result of `ok`, `denied`, `error`, `rate_limited`, `confirmation_requested` or `declined`;
- every rejected token, consent, revocation and settings change.

Arguments are reduced to scalars, then sanitized. The log is visible in Settings › AI Integrations: in full for owners and admins, limited to their own entries for a member.

Dokploy's native audit log (`audit_log`) is not fed directly by MCP: it belongs to the proprietary-licensed code and depends on an enterprise license. The tRPC procedures called by the bridge do write to it as they do for the UI, on the user's behalf, when that log is active.

## Roles

| Action | Who |
|---|---|
| Enable or disable the integration, choose the allowed scopes | organization owner or admin |
| Authorize a client | any member, within the limits above |
| View and revoke their own clients | any member |
| View and revoke all clients, view the whole audit log | owner or admin |

## Limitations and open points

- **Confirmation relies on the client**: the server cannot prove that a human answered. It only guarantees that a question was asked for this exact call and that the answer came back with the signed state. A malicious client holding an `mcp:exec` token can answer on its own. This is why `mcp:exec` and `mcp:manage` are disabled by default.
- **Readable confirmation state**: it is signed, not encrypted. The client can read the internal identifiers of the user, client and grant in it, which it already knows.
- **Command timeout**: `timeout` stops the `docker exec` client. A process started in the container that ignores the signal may survive.
- **Backups**: `run_backup`, `list_backup_files` and `restore_backup` have not been tested for real, for lack of an S3 destination in the local environment.

- **Unauthenticated dynamic registration**: a third party can create `oauth_client` entries but can do nothing with them without user consent. There is no purge yet of clients that were never authorized, and no dedicated rate limit on `/oauth2/register`: only better-auth's generic rate limiting, active by default in production, applies.
- **Refresh token**: it is not bound to the device (no DPoP).
- **In-memory rate limiting**: to be replaced by shared storage if Dokploy runs on several instances.
- **Security tests**: they were run locally (`dev/mcp/oauth-mcp-e2e.mjs`, 36 checks; `mcp.test.ts` unit tests). Isolation between two distinct users or organizations has not yet been tested for real (Phase 7).
