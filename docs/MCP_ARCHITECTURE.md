# Native MCP server — architecture

Dokploy exposes an MCP (Model Context Protocol) server at `https://<instance>/mcp`. An AI client (Claude, an IDE agent, etc.) connects to it with a user's Dokploy account, after the user gives explicit consent. Security is detailed in `MCP_SECURITY.md`.

## Overview

```
MCP client ──(1) POST /mcp without token──────────────► 401 + WWW-Authenticate: resource_metadata=…
           ──(2) GET /.well-known/oauth-protected-resource/mcp ─► { resource, authorization_servers }
           ──(3) GET /.well-known/oauth-authorization-server/api/auth ─► OAuth endpoints (RFC 8414)
           ──(4) POST /api/auth/oauth2/register (RFC 7591) ─► public client
           ──(5) browser: /api/auth/oauth2/authorize (PKCE S256, resource=…/mcp)
                     └─ no session → Dokploy login page → automatic resume
                     └─ /oauth/consent: organization + checked permissions
           ──(6) POST /api/auth/oauth2/token (code + verifier) ─► JWT (aud=…/mcp, 15 min) + refresh token
           ──(7) POST /mcp  Authorization: Bearer … ─► tools, resources
```

## Components

| Role | Location | Reuses |
|---|---|---|
| OAuth 2.1 authorization server | `oauthProvider` (`@better-auth/oauth-provider` 1.6.23) and `jwt` plugins in `packages/server/src/lib/auth.ts` | **the existing better-auth setup**: same accounts, sessions, 2FA, passkeys and SSO. No second identity system |
| OAuth tables | `db/schema/oauth.ts`: `oauth_client`, `oauth_access_token`, `oauth_refresh_token`, `oauth_consent`, `jwks` | migration `0200_mcp_oauth` |
| Dokploy MCP state | `mcp_settings` (per organization), `mcp_grant` (organization and scopes a user granted to a client), `mcp_audit_log` | — |
| Token verification | `mcp/token.ts` | better-auth's `verifyJwsAccessToken`, JWKS read from memory (no HTTP call) |
| HTTP endpoint | `mcp/http.ts`, `pages/api/mcp.ts`, rewrite `/mcp` → `/api/mcp` | `createMcpHandler` from the `@modelcontextprotocol/server` 2.4.0 SDK |
| Tools and resources | `mcp/tools.ts` (applications, deployments, diagnostics) and `mcp/platform-tools.ts` (rest of the API); shared helpers in `mcp/tool-kit.ts` | Dokploy services (`findApplicationById`, `checkServiceAccess`…), `smart-deploy` engines (diagnostics, version, actions) |
| Bridge to the Dokploy API | `apps/dokploy/server/mcp/api-bridge.ts` (`callApi`); procedure allowlist in `mcp/api-paths.ts` | **the UI's tRPC procedures**, called with `appRouter.createCaller` and a context built like the one for API keys (`validateRequest`): same permission checks, same Dokploy audit log |
| Command in a container | `execInService` in `api-bridge.ts` | the UI container terminal's checks (`canAccessDockerOverWss`, `containerBelongsToService`, `isValidContainerId`) |
| Human confirmation | `mcp/confirm.ts` | MCP elicitation (`inputRequired.elicit`) and the SDK's HMAC state (`createRequestStateCodec`) |
| Deployments | existing deployment queue, via `server/utils/enqueue-application-job.ts` (shared with the UI) | `myQueue` |
| Consent | `pages/oauth/consent.tsx` | Dokploy UI components |
| Settings | Settings › AI Integrations (`pages/dashboard/settings/ai-integrations.tsx`), `mcp` tRPC router | — |

The business logic is **shared between the UI and MCP**: an MCP tool calls the same functions as the tRPC routes (diagnostics, version status, restart, redeploy, deployment queue, domain update).

## Transport and protocol

- **Streamable HTTP**, stateless. Each request creates an `McpServer` instance with the authenticated user's tools; there is no server-side session.
- **Protocol 2026-07-28**: `io.modelcontextprotocol/*` `_meta` envelope and the `MCP-Protocol-Version`, `Mcp-Method` and `Mcp-Name` headers.
- **2025-xx clients** (`initialize`, 2025-06-18, 2025-11-25): served by the SDK's stateless fallback (`legacy: "stateless"`). GET and DELETE (2025 sessions) return 405.
- Body limited to 1 MiB; the response is JSON or SSE as needed.

## Tools

| Scope | Tools |
|---|---|
| `mcp:read` | `dokploy_list_projects`, `dokploy_list_applications`, `dokploy_get_application`, `dokploy_get_deployments` (application or compose), `dokploy_get_deployment_status` and `dokploy_get_deployment_logs` (build logs, application or compose), `dokploy_get_deployment_timeline` (Smart Deploy), `dokploy_preflight` (Smart Deploy, changes nothing), `dokploy_get_runtime_version`, `dokploy_get_application_health`, `dokploy_get_port_configuration`, `dokploy_diagnose_deployment`, `dokploy_diagnose_service` (Smart Deploy for any service: application, compose, database), `dokploy_list_servers` |
| `mcp:deploy` | `dokploy_deploy_application`, `dokploy_deploy_latest`, `dokploy_rebuild_application`, `dokploy_restart_application`, `dokploy_rollback_deployment` |
| `mcp:read` (continued) | `dokploy_list_services` (all service types), `dokploy_get_service`, `dokploy_get_service_logs` (runtime logs), `dokploy_list_backup_files`, `dokploy_suggest_subdomain` (DNS providers, zones, free subdomain; creates nothing) |
| `mcp:deploy` (continued) | `dokploy_deploy_service` (application, compose, database), `dokploy_start_service`, `dokploy_cancel_deployment`, `dokploy_apply_fix` (applies a fix proposed by the diagnostics, for any service type: `deploy_latest`, `redeploy_deployment`, `redeploy_service`, `update_domain_port`, which also requires `mcp:config`) |
| `mcp:config` | `dokploy_update_application_port`, `dokploy_update_domain`, `dokploy_update_healthcheck`, `dokploy_update_service_settings`, `dokploy_set_application_source` (Git, Docker image, GitHub), `dokploy_set_build_type`, `dokploy_update_compose_file`, `dokploy_create_domain`, `dokploy_delete_domain` ✋ |
| `mcp:env` | `dokploy_get_env_vars` (secrets masked), `dokploy_set_env_vars` (add/remove without touching the others) |
| `mcp:manage` | `dokploy_create_project`, `dokploy_create_environment`, `dokploy_create_service`, `dokploy_stop_service` ✋, `dokploy_delete_service` ✋, `dokploy_delete_environment` ✋, `dokploy_delete_project` ✋, `dokploy_run_backup`, `dokploy_restore_backup` ✋ |
| `mcp:exec` | `dokploy_exec_command` ✋ |

✋: the tool asks the client for **human confirmation** (elicitation) before acting, on every call.

`mcp:env`, `mcp:manage` and `mcp:exec` are **disabled by default** in each organization: an owner or admin must allow them in Settings › AI Integrations.

Service types: `application`, `compose`, `postgres`, `mysql`, `mariadb`, `mongo`, `redis`. The generic tools take `serviceType` + `serviceId`.

**Resources**: `dokploy://application/{applicationId}` and `dokploy://deployment/{deploymentId}/timeline`.

**Exclusions**:
- no access to the Docker socket or the host shell; `dokploy_exec_command` only runs inside a container of the targeted service;
- no secret value is returned: database passwords, SSH keys, registry credentials and variables whose name suggests a secret are masked;
- no changes to servers, users, roles, backup destinations, Git providers or instance settings;
- restoring a compose backup and backing up the Dokploy web server: from the UI only.

**Notes on specific tools**:
- `deploy_application` and `deploy_latest` both fetch and build the branch; `deploy_latest` first checks and returns the remote head.
- `rebuild_application` rebuilds the last clone, without fetching.
- `rollback_deployment` relaunches a retained image (see `SMART_DEPLOY_ENGINE.md`).
- `update_healthcheck` only takes effect at the next deployment.
- `set_env_vars`, `update_service_settings`, `set_application_source`, `set_build_type` and `update_compose_file` take effect at the next deployment (the response says so).
- `create_domain` accepts `dns` (provider and zone from Settings › DNS, optional name): it also creates the A record, never overwriting an existing one, and then the domain. `delete_domain` also deletes the record Dokploy created (unless `deleteDnsRecord: false`), and the confirmation says so.
- `create_service` generates database passwords server-side; they stay visible in the UI, never in MCP.
- `exec_command` runs `sh -c <command>` via `docker exec`, with a timeout of 1 to 120 s and output truncated to 32,000 characters and passed through the redactor.

### Human confirmation (elicitation)

1. First call: the server returns `resultType: "input_required"` with an `elicitation/create` request (the message names the target, for example the exact command or the service name) and a `requestState`.
2. The client shows the question to the user, then calls the tool again with the **same arguments**, the answer (`inputResponses.confirm`) and the `requestState`.
3. The action runs only if the answer is `accept` with `confirm: true` and the state matches this call (see `MCP_SECURITY.md`).

A client that does not declare the `elicitation` capability (protocol 2026-07-28) gets an explicit refusal, with nothing executed. The same applies to 2025-xx clients served statelessly.

All tools are listed regardless of the token. Calling a tool outside the token's scope returns **403 `insufficient_scope`** with `WWW-Authenticate`, which lets the client ask for broader consent (*step-up*).

## Configuration

| Variable | Role |
|---|---|
| `DOKPLOY_MCP_RESOURCE_URL` | Public URL of `/mcp` (for example `https://dokploy.example.com/mcp`); several can be given, comma-separated. **Required in production.** It serves as the token audience and as the Host allowlist. Without it, `/mcp` returns 503. In development it defaults to `http://localhost:3000/mcp` |

At the organization level, the integration is **disabled by default**. An owner or admin enables it in Settings › AI Integrations and chooses the allowed scopes.

**Connecting a client**: `claude mcp add --transport http dokploy https://<instance>/mcp`, or add a remote MCP server in another client. OAuth discovery is automatic.

## Upstream compatibility

Changes to existing code:
- 2 plugins added to better-auth, plus `"/token"` in `disabledPaths`, and 2 exposed methods (`getJwks`, `getOAuthServerConfig`);
- login page: after sign-in, it follows the OAuth redirect if an authorization is in progress (`continueAfterLogin`), otherwise behavior is unchanged;
- `oauthProviderClient()` added to the auth client: it only acts on pages carrying a signed OAuth request (`sig`);
- `next.config.mjs`: `/mcp` and `/.well-known/*` rewrites;
- one Settings menu entry, one `mcp` tRPC router, one migration;
- the "do everything" extension only adds files: no existing tRPC procedure is modified, they are called as-is;
- 2 dependencies: `@better-auth/oauth-provider` (same version as better-auth) and `@modelcontextprotocol/server` (already in the lockfile as a transitive dependency).

## Limitations

- **Client ID Metadata Documents** (recommended by the 2026-07-28 spec): not supported. better-auth handles them via `@better-auth/cimd`, which is not installed for now. Dynamic registration (RFC 7591), still optional in the spec, is used.
- **`subscriptions/listen` notifications**: not used (no events are published).
- **One grant per user/client pair**, tied to a single organization. Re-authorizing the client lets you change it.
- **Single instance**: rate limiting is in memory.
- **Dokploy Cloud**: deployment tools are refused (same limitation as `redeployVersion`).
- **No public tunnel**: a remote client such as claude.ai cannot reach the local instance. Only local clients have been tested (see `TESTING.md`).
