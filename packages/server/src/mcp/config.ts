export const MCP_SCOPES = [
	"mcp:read",
	"mcp:deploy",
	"mcp:config",
	"mcp:env",
	"mcp:manage",
	"mcp:exec",
] as const;
export type McpScope = (typeof MCP_SCOPES)[number];

/**
 * Scopes an organization allows until an admin changes it. The broader ones
 * (environment variables, create/delete, commands) must be opted into.
 */
export const DEFAULT_ALLOWED_SCOPES: readonly McpScope[] = [
	"mcp:read",
	"mcp:deploy",
	"mcp:config",
];

export const MCP_SCOPE_DESCRIPTIONS: Record<McpScope, string> = {
	"mcp:read":
		"Read projects, services, deployments, logs (redacted), health and diagnostics",
	"mcp:deploy":
		"Deploy, rebuild, restart, start and roll back services you are allowed to deploy",
	"mcp:config":
		"Change service settings, source, build type, domains and healthcheck",
	"mcp:env":
		"Read environment variables (secret values masked) and set or remove variables",
	"mcp:manage":
		"Create and delete projects, environments and services, stop services, run and restore backups (destructive actions ask for confirmation)",
	"mcp:exec":
		"Run a command inside a service's container, after a human confirms each command",
};

export const OAUTH_SCOPES = [...MCP_SCOPES, "offline_access"] as const;

export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
export const REFRESH_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60;

const DEV_RESOURCE = "http://localhost:3000/mcp";

/**
 * Public URL of the MCP endpoint, used as the OAuth audience (RFC 8707).
 * Must be configured explicitly in production: guessing it from request
 * headers would let a spoofed Host header choose the audience.
 */
export const getMcpResourceUrls = (): string[] => {
	const configured = (process.env.DOKPLOY_MCP_RESOURCE_URL ?? "")
		.split(",")
		.map((u) => u.trim().replace(/\/+$/, ""))
		.filter(Boolean);
	if (configured.length > 0) return configured;
	return process.env.NODE_ENV === "production" ? [] : [DEV_RESOURCE];
};

/** Issuer of OAuth tokens: better-auth served under /api/auth on the same origin. */
export const getMcpIssuer = (resourceUrl: string) =>
	`${new URL(resourceUrl).origin}/api/auth`;
